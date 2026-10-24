"""Spec-Kit Hermes — backend half of the desktop plugin.

Hermes Desktop mounts this router at ``/api/plugins/spec-kit-hermes`` when the
plugin is installed at ``<hermes home>/plugins/spec-kit-hermes/dashboard/`` with
``manifest.json`` declaring ``"api": "plugin_api.py"`` and the plugin is listed
in the active profile's ``plugins.enabled`` (verified against
``hermes_cli/web_server_dashboard.py::_mount_one_plugin_api``).

The desktop pane reaches these routes through ``ctx.rest('/files')`` — the only
sanctioned file-I/O door for a plugin: the renderer has no filesystem, and the
gateway JSON-RPC contract has no read/write method (verified — see
docs/VERIFICATION.md).

Endpoints
---------
GET  /status          liveness + the path allowlist
GET  /files?cwd=      the three .specify files with content + mtime (one poll tick)
PUT  /file            optimistic-concurrency write; 409 carries the winning copy
POST /kanban/sync     materialise spec-kit tasks as Kanban cards (idempotent)
GET  /kanban/links    per-requirement card status, for the acceptance-criteria flow

Security: every path is resolved inside ``<cwd>/.specify`` and must be one of
``ALLOWED_PATHS``; traversal, absolute paths and unknown files are refused.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter()

#: The only files this plugin reads or writes, relative to ``<cwd>/.specify``.
ALLOWED_PATHS: tuple[str, ...] = ("spec.md", "memory/constitution.md", "tasks.md")

#: Prefix for the Kanban idempotency keys that mark a card as spec-kit generated.
KANBAN_KEY_PREFIX = "speckit"


# ---------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------


def _project_root(cwd: str) -> Path:
    """Validate a project directory handed over by the pane."""
    if not isinstance(cwd, str) or not cwd.strip():
        raise HTTPException(status_code=400, detail="cwd is required")
    root = Path(cwd).expanduser()
    if not root.is_absolute():
        raise HTTPException(status_code=400, detail=f"cwd must be absolute: {cwd!r}")
    root = root.resolve()
    if not root.is_dir():
        raise HTTPException(status_code=400, detail=f"cwd is not a directory: {root}")
    return root


def _target(root: Path, rel: str) -> Path:
    """Resolve an allowlisted relative path inside ``root/.specify``."""
    if rel not in ALLOWED_PATHS:
        raise HTTPException(status_code=400, detail=f"path not allowed: {rel!r}")
    specify = root / ".specify"
    target = (specify / rel).resolve()
    try:
        target.relative_to(specify.resolve())
    except (OSError, RuntimeError, ValueError):
        raise HTTPException(status_code=400, detail=f"path escapes .specify: {rel!r}") from None
    return target


def _mtime_ms(path: Path) -> Optional[int]:
    """Modification stamp in milliseconds — a plain int the renderer can compare."""
    try:
        return int(path.stat().st_mtime_ns // 1_000_000)
    except FileNotFoundError:
        return None


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""


def _write_text_atomic(path: Path, content: str) -> int:
    """Write via a sibling temp file + ``os.replace`` so a crash cannot truncate."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".speckit-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return _mtime_ms(path) or 0


# ---------------------------------------------------------------------------
# models
# ---------------------------------------------------------------------------


class FileWrite(BaseModel):
    cwd: str
    path: str
    content: str
    #: mtime the client last read/wrote; ``None`` means "I believe it is absent".
    base_mtime: Optional[int] = None


class SyncTask(BaseModel):
    title: str
    body: Optional[str] = None
    #: requirement id this card implements (``FR-1``); becomes the link key.
    story: Optional[str] = None


class KanbanSync(BaseModel):
    cwd: str
    tasks: list[SyncTask]


# ---------------------------------------------------------------------------
# files
# ---------------------------------------------------------------------------


@router.get("/status")
def status() -> dict[str, Any]:
    return {"ok": True, "plugin": "spec-kit-hermes", "allowed_paths": list(ALLOWED_PATHS)}


@router.get("/files")
def read_files(cwd: str = Query(..., description="Absolute project directory")) -> dict[str, Any]:
    """All three files in one round trip — the pane polls this on a timer."""
    root = _project_root(cwd)
    files: dict[str, Any] = {}
    for rel in ALLOWED_PATHS:
        target = _target(root, rel)
        mtime = _mtime_ms(target)
        files[rel] = {
            "exists": mtime is not None,
            "content": _read_text(target) if mtime is not None else "",
            "mtime": mtime,
        }
    specify = root / ".specify"
    return {"cwd": str(root), "specify": str(specify), "exists": specify.is_dir(), "files": files}


@router.put("/file")
def write_file(payload: FileWrite) -> dict[str, Any]:
    """Write one file. A stale ``base_mtime`` returns 409 with the winning copy."""
    root = _project_root(payload.cwd)
    target = _target(root, payload.path)
    current = _mtime_ms(target)

    if payload.base_mtime is None:
        if current is not None:
            raise HTTPException(
                status_code=409,
                detail={
                    "conflict": True,
                    "reason": "file appeared after the pane loaded",
                    "path": payload.path,
                    "content": _read_text(target),
                    "mtime": current,
                },
            )
    elif current != payload.base_mtime:
        raise HTTPException(
            status_code=409,
            detail={
                "conflict": True,
                "reason": "file changed on disk since the pane loaded it",
                "path": payload.path,
                "content": _read_text(target) if current is not None else "",
                "mtime": current,
            },
        )

    mtime = _write_text_atomic(target, payload.content)
    return {"path": payload.path, "mtime": mtime, "bytes": len(payload.content.encode("utf-8"))}


# ---------------------------------------------------------------------------
# kanban
# ---------------------------------------------------------------------------


def _link_key(cwd: str, story: Optional[str]) -> str:
    """Stable per (project, requirement) key — the card's identity across syncs."""
    digest = hashlib.sha1(cwd.encode("utf-8")).hexdigest()[:10]
    return f"{KANBAN_KEY_PREFIX}:{digest}:{story or 'misc'}"


def _kanban_conn():
    """A board connection, or 503 when this process has no Kanban DB."""
    try:
        from hermes_cli import kanban_db_connect as kbc
    except Exception as exc:  # pragma: no cover - environment dependent
        raise HTTPException(status_code=503, detail=f"kanban unavailable: {exc}") from exc
    try:
        return kbc.connect(board=None)
    except Exception as exc:  # pragma: no cover - environment dependent
        raise HTTPException(status_code=503, detail=f"kanban unavailable: {exc}") from exc


@router.post("/kanban/sync")
def kanban_sync(payload: KanbanSync) -> dict[str, Any]:
    """Create one card per task, idempotently; re-syncing returns the same ids."""
    root = _project_root(payload.cwd)
    if not payload.tasks:
        return {"created": [], "skipped": []}

    from hermes_cli import kanban_db

    created: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    conn = _kanban_conn()
    try:
        existing = {
            task.idempotency_key: task
            for task in kanban_db.list_tasks(conn)
            if task.idempotency_key and task.idempotency_key.startswith(f"{KANBAN_KEY_PREFIX}:")
        }
        for task in payload.tasks:
            key = _link_key(str(root), task.story)
            prior = existing.get(key)
            if prior is not None:
                skipped.append({"story": task.story, "task_id": prior.id, "status": prior.status})
                continue
            task_id = kanban_db.create_task(
                conn,
                title=task.title,
                body=task.body or "",
                created_by="spec-kit-hermes",
                idempotency_key=key,
                workspace_kind="scratch",
            )
            created.append({"story": task.story, "task_id": task_id})
    finally:
        conn.close()
    return {"created": created, "skipped": skipped}


@router.get("/kanban/links")
def kanban_links(cwd: str = Query(...)) -> dict[str, Any]:
    """Status of every card this plugin created for a project."""
    root = _project_root(cwd)
    prefix = f"{KANBAN_KEY_PREFIX}:{hashlib.sha1(str(root).encode('utf-8')).hexdigest()[:10]}:"

    from hermes_cli import kanban_db

    conn = _kanban_conn()
    try:
        rows = [
            {
                "story": task.idempotency_key[len(prefix):],
                "task_id": task.id,
                "title": task.title,
                "status": task.status,
                "done": task.status in ("done", "archived"),
            }
            for task in kanban_db.list_tasks(conn)
            if task.idempotency_key and task.idempotency_key.startswith(prefix)
        ]
    finally:
        conn.close()
    return {"cwd": str(root), "links": rows}

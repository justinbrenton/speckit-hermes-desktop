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
import re
import shutil
import subprocess
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
# processes
# ---------------------------------------------------------------------------


def _hermes_skills_dirs() -> list[Path]:
    """Every place this machine's Hermes may read skills from, most specific first.

    ``get_hermes_home()`` is a context override, then ``HERMES_HOME``, then the
    platform default — so a named profile reads ``profiles/<name>/skills`` while
    the default profile reads ``%LOCALAPPDATA%/hermes/skills`` on Windows. A skill
    installed in either counts as installed.
    """
    candidates: list[Path] = []
    home = os.environ.get("HERMES_HOME")
    if home:
        candidates.append(Path(home).expanduser() / "skills")
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.append(Path(local) / "hermes" / "skills")
    candidates.append(Path.home() / ".hermes" / "skills")

    unique: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        key = str(path).lower()
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


def _installed_skills() -> tuple[set[str], list[Path]]:
    dirs = _hermes_skills_dirs()
    found: set[str] = set()
    for path in dirs:
        if path.is_dir():
            found.update(entry.name for entry in path.iterdir() if entry.is_dir())
    return found, dirs


def _load_yaml(path: Path) -> Any:
    text = path.read_text(encoding="utf-8")
    try:
        from ruamel.yaml import YAML

        return YAML(typ="safe").load(text)
    except ImportError:
        import yaml

        return yaml.safe_load(text)


def _skill_for(command: str) -> str:
    """spec-kit command name -> the Hermes skill the integration installs.

    ``speckit.bug.assess`` becomes ``speckit-bug-assess`` (the integration names
    skills from the command file stem with dots replaced by dashes).
    """
    name = command[len("speckit.") :] if command.startswith("speckit.") else command
    return "speckit-" + name.replace(".", "-")


@router.get("/processes")
def list_processes(cwd: str = Query(..., description="Absolute project directory")) -> dict[str, Any]:
    """Installed processes, shaped the way the pane renders them.

    Nothing here is hard-coded. Every workflow under ``<cwd>/.specify/workflows``
    becomes a process, its ``inputs`` become a form and its ``steps`` become the
    runner: command steps dispatch a skill, gate steps pause for a human. Install
    a bundle or an extension and a new process appears with no pane change.
    """
    root = _project_root(cwd)
    workflows_dir = root / ".specify" / "workflows"
    installed, skill_dirs = _installed_skills()

    processes: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    for wf_file in sorted(workflows_dir.glob("*/workflow.yml")):
        try:
            data = _load_yaml(wf_file) or {}
        except Exception as exc:  # a broken workflow must not take the pane down
            errors.append({"file": str(wf_file), "error": str(exc)})
            continue
        if not isinstance(data, dict):
            errors.append({"file": str(wf_file), "error": "not a mapping"})
            continue

        wf = data.get("workflow") or {}
        inputs = []
        for name, spec in (data.get("inputs") or {}).items():
            spec = spec or {}
            inputs.append(
                {
                    "name": name,
                    "type": spec.get("type", "string"),
                    "required": bool(spec.get("required", False)),
                    "default": spec.get("default"),
                    "prompt": spec.get("prompt", name),
                }
            )

        steps = []
        for raw in data.get("steps") or []:
            raw = raw or {}
            kind = raw.get("type", "command")
            step: dict[str, Any] = {
                "id": raw.get("id", ""),
                "type": kind,
                "depends_on": raw.get("needs") or raw.get("depends_on") or [],
            }
            if kind == "command":
                command = raw.get("command", "")
                skill = _skill_for(command)
                step.update(
                    {
                        "command": command,
                        "args": (raw.get("input") or {}).get("args", ""),
                        "skill": skill,
                        "skill_installed": skill in installed,
                    }
                )
            else:
                step.update(
                    {
                        "message": raw.get("message", ""),
                        "options": raw.get("options", []),
                        "on_reject": raw.get("on_reject"),
                    }
                )
            steps.append(step)

        command_steps = [step for step in steps if step["type"] == "command"]
        processes.append(
            {
                "id": wf.get("id") or wf_file.parent.name,
                "name": wf.get("name", ""),
                "version": wf.get("version", ""),
                "description": wf.get("description", ""),
                "source": str(wf_file),
                "inputs": inputs,
                "steps": steps,
                "ready": bool(command_steps) and all(s["skill_installed"] for s in command_steps),
            }
        )

    return {
        "cwd": str(root),
        "workflows_dir": str(workflows_dir),
        "skills_dirs": [str(path) for path in skill_dirs],
        "processes": processes,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# running a step
# ---------------------------------------------------------------------------

INPUT_RE = re.compile(r"\{\{\s*inputs\.([A-Za-z0-9_.-]+)\s*\}\}")


def _render_args(template: str, values: dict[str, Any]) -> str:
    """Fill ``{{ inputs.x }}`` from the workflow's inputs. Unknown keys render empty."""

    def replace(match: re.Match[str]) -> str:
        value = values.get(match.group(1).strip())
        return "" if value is None else str(value)

    return INPUT_RE.sub(replace, template or "")


def _hermes_cli() -> str:
    explicit = os.environ.get("HERMES_CLI")
    if explicit and Path(explicit).exists():
        return explicit
    found = shutil.which("hermes")
    if found:
        return found
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidate = Path(local) / "hermes" / "bin" / "hermes.exe"
        if candidate.exists():
            return str(candidate)
    raise HTTPException(status_code=503, detail="hermes CLI not found; set HERMES_CLI")


def _spawn_hermes(
    prompt: str, skill: str, cwd: Path, model: Optional[str], timeout: int
) -> dict[str, Any]:
    """Dispatch one workflow step the way the Hermes integration documents it.

    ``hermes chat -Q`` answers once and exits; the skill is selected with ``-s``
    and the step's rendered arguments are the query. The query travels through a
    temp file (``--query-file``) because it carries arbitrary user text and the
    Windows shells re-quote it.
    """
    exe = _hermes_cli()
    handle, query_path = tempfile.mkstemp(prefix="speckit-step-", suffix=".txt")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as fh:
            fh.write(prompt)
        argv = [exe, "chat", "-Q", "--query-file", query_path, "-s", skill, "--in", str(cwd)]
        if model:
            argv += ["-m", model]
        completed = subprocess.run(
            argv, cwd=str(cwd), capture_output=True, text=True, timeout=timeout
        )
        return {
            "ok": completed.returncode == 0,
            "exit_code": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
            "argv": [*argv[:3], "<query-file>", *argv[4:]],
        }
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "exit_code": None,
            "stdout": "",
            "stderr": f"timed out after {timeout}s",
            "argv": [],
        }
    finally:
        os.unlink(query_path)


class RunStepRequest(BaseModel):
    cwd: str
    process: str
    step: str
    inputs: dict[str, Any] = {}
    model: Optional[str] = None
    timeout: int = 600


@router.post("/run")
def run_step(payload: RunStepRequest) -> dict[str, Any]:
    """Dispatch one command step of one process.

    A gate step is refused here on purpose: gates are answered by a human, and
    the pane posts nothing for them.
    """
    root = _project_root(payload.cwd)
    wf_file = root / ".specify" / "workflows" / payload.process / "workflow.yml"
    if not wf_file.is_file():
        raise HTTPException(status_code=404, detail=f"no such process: {payload.process}")

    data = _load_yaml(wf_file) or {}
    raw_steps = data.get("steps") or []
    raw = next((item for item in raw_steps if (item or {}).get("id") == payload.step), None)
    if raw is None:
        raise HTTPException(
            status_code=404, detail=f"no such step in {payload.process}: {payload.step}"
        )
    if raw.get("type", "command") != "command":
        raise HTTPException(
            status_code=400,
            detail=f"step {payload.step} is a {raw.get('type')} step, not a command",
        )

    declared = data.get("inputs") or {}
    missing = [
        name
        for name, spec in declared.items()
        if (spec or {}).get("required") and not str(payload.inputs.get(name) or "").strip()
    ]
    if missing:
        raise HTTPException(status_code=400, detail={"missing_inputs": missing})

    values = {name: (spec or {}).get("default") for name, spec in declared.items()}
    values.update({key: value for key, value in payload.inputs.items() if value is not None})

    command = raw.get("command", "")
    skill = _skill_for(command)
    prompt = _render_args((raw.get("input") or {}).get("args", ""), values)
    result = _spawn_hermes(
        prompt, skill, root, payload.model, max(1, min(payload.timeout, 3600))
    )
    return {
        "process": payload.process,
        "step": payload.step,
        "command": command,
        "skill": skill,
        "prompt": prompt,
        **result,
    }


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

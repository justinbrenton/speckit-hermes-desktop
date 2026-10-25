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
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timezone
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


def _sync_legacy_skills() -> list[str]:
    """Copy skills the released CLI wrote to ``~/.hermes/skills`` where Hermes reads.

    Upstream's HermesIntegration resolves ``~/.hermes/skills`` unconditionally, so
    on Windows ``specify init --integration hermes`` can install where nothing
    looks. The fork fixes the resolution; the released CLI on this machine does
    not, so after init we move copies into the directory Hermes actually reads.
    """
    legacy = Path.home() / ".hermes" / "skills"
    if not legacy.is_dir():
        return []
    dirs = _hermes_skills_dirs()
    target = dirs[0] if dirs else legacy
    try:
        if target.resolve() == legacy.resolve():
            return []
    except OSError:
        return []
    copied: list[str] = []
    for entry in legacy.iterdir():
        if not entry.is_dir() or not entry.name.startswith("speckit-"):
            continue
        destination = target / entry.name
        if destination.exists():
            continue
        try:
            shutil.copytree(entry, destination)
        except OSError:
            continue
        copied.append(entry.name)
    return copied


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
                        # The input a GUI must fill to answer this gate. Without it
                        # the engine can only prompt, which a pane cannot do.
                        "verdict_input": raw.get("verdict_input"),
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
        "has_specify": (root / ".specify").is_dir(),
        "has_workflows": workflows_dir.is_dir(),
        "skills_dirs": [str(path) for path in skill_dirs],
        "processes": processes,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# workflows — the spec-kit engine does the work, this bridge just drives it
# ---------------------------------------------------------------------------

SPECIFY_TIMEOUT_MAX = 1800
ARTIFACT_MAX_BYTES = 262_144

#: Background dispatches, keyed by job id. The CLI's own run state lives under
#: .specify/workflows/runs; this only tracks the process we spawned.
JOBS: dict[str, dict[str, Any]] = {}


# ---------------------------------------------------------------------------
# step output verification + run control
# ---------------------------------------------------------------------------

#: Every artifact root spec-kit writes to, per process family.
ARTIFACT_ROOTS = ("specs", ".specify/specs", ".specify/bugs", ".specify/assessments", ".specify/memory")


def _artifact_index(root: Path) -> dict[str, int]:
    """path -> mtime for every artifact the pane can show."""
    index: dict[str, int] = {}
    for rel in ARTIFACT_ROOTS:
        base = root / rel
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            try:
                if path.is_file():
                    index[path.relative_to(root).as_posix()] = int(path.stat().st_mtime * 1000)
            except OSError:
                continue
    return index


def _snapshot_file(root: Path, run_id: str) -> Path:
    return root / ".specify" / "workflows" / "runs" / run_id / "hermes-artifact-snapshot.json"


def _write_snapshot(root: Path, run_id: str) -> None:
    try:
        target = _snapshot_file(root, run_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(_artifact_index(root)), encoding="utf-8")
    except OSError:
        pass


def _read_snapshot(root: Path, run_id: str) -> dict[str, int]:
    try:
        return json.loads(_snapshot_file(root, run_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _output_check(root: Path, run_id: str) -> dict[str, Any]:
    """Compare the artifact tree with the snapshot taken before the last step.

    A command step that dispatches an agent can finish with exit_code 0 and an
    empty stdout while writing nothing. The engine still reports success, so the
    only honest signal is whether any artifact appeared or changed.
    """
    before = _read_snapshot(root, run_id)
    if not before:
        return {"checked": False}
    after = _artifact_index(root)
    changed = [path for path, mtime in after.items() if before.get(path) != mtime]
    removed = [path for path in before if path not in after]
    return {
        "checked": True,
        "changed": sorted(changed),
        "removed": sorted(removed),
        "unchanged": not changed and not removed,
    }


#: (cwd, process) currently holding a run, so two Starts cannot race.
ACTIVE_RUNS: dict[tuple[str, str], dict[str, Any]] = {}


def _active_key(root: Path, process: str) -> tuple[str, str]:
    return (str(root).lower(), process)


def _release_finished_jobs() -> None:
    for key, entry in list(ACTIVE_RUNS.items()):
        proc = entry.get("proc")
        if proc is None or proc.poll() is not None:
            ACTIVE_RUNS.pop(key, None)


def _run_ids(root: Path) -> set[str]:
    runs = root / ".specify" / "workflows" / "runs"
    if not runs.is_dir():
        return set()
    return {d.name for d in runs.iterdir() if d.is_dir()}


def _await_new_run(root: Path, before: set[str], timeout: float = 25.0) -> Optional[str]:
    """Return the run id spec-kit just created, or None if it did not start.

    ``specify workflow run`` picks its own run id; the pane needs that id to
    resume a gate, so the spawned job's id is not enough.
    """
    import time as _time

    deadline = _time.monotonic() + timeout
    while _time.monotonic() < deadline:
        fresh = _run_ids(root) - before
        if fresh:
            return sorted(fresh)[0] if len(fresh) == 1 else max(
                fresh, key=lambda name: (root / ".specify" / "workflows" / "runs" / name / "state.json").stat().st_mtime
                if (root / ".specify" / "workflows" / "runs" / name / "state.json").is_file() else 0
            )
        _time.sleep(0.4)
    return None


CONSTITUTION_STEPS = """  - id: constitution
    command: speckit.constitution
    integration: "{{ inputs.integration }}"
    input:
      args: "{{ inputs.principles }}"
  - id: review-constitution
    type: gate
    message: "Review the constitution before specifying."
    options: [approve, reject]
    verdict_input: gate_review_constitution
    on_reject: abort
"""


def _constitution_ready(root: Path) -> bool:
    """True when the project already has a ratified constitution.

    spec-kit's template ships placeholders; until they are replaced the file is
    scaffolding, not a constitution, and the step should still run.
    """
    target = root / ".specify" / "memory" / "constitution.md"
    try:
        text = target.read_text(encoding="utf-8")
    except OSError:
        return False
    if not text.strip():
        return False
    placeholders = ("[PROJECT_NAME]", "[PRINCIPLE_1_NAME]", "[PRINCIPLE_1_DESCRIPTION]")
    return not any(marker in text for marker in placeholders)


def _ensure_gate_verdicts(root: Path) -> list[str]:
    """Give every gate a ``verdict_input`` so it can be answered from the pane.

    A gate without one can only be answered at an interactive prompt: ``specify
    workflow resume -i x=y`` is ignored and the run pauses forever. The engine
    also rejects a gate whose ``verdict_input`` is not declared in ``inputs:``, so
    both edits happen together and inputs are declared only for gates that were
    actually patched.
    """
    patched: list[str] = []
    workflows = root / ".specify" / "workflows"
    if not workflows.is_dir():
        return patched

    for file in sorted(workflows.glob("*/workflow.yml")):
        try:
            text = file.read_text(encoding="utf-8")
        except OSError:
            continue
        if "verdict_input:" in text:
            continue

        lines = text.splitlines()
        out: list[str] = []
        keys: list[str] = []
        index = 0
        while index < len(lines):
            line = lines[index]
            stripped = line.strip()
            if stripped.startswith("- id:"):
                step_id = stripped.split(":", 1)[1].strip().strip('"').strip("'")
                block: list[str] = []
                probe = index + 1
                while probe < len(lines) and not lines[probe].strip().startswith("- id:"):
                    block.append(lines[probe])
                    probe += 1
                is_gate = any(item.strip() == "type: gate" for item in block)
                has_verdict = any(item.strip().startswith("verdict_input:") for item in block)
                if is_gate and not has_verdict:
                    key = "gate_" + step_id.replace("-", "_")
                    emitted: list[str] = [line]
                    done = False
                    for item in block:
                        emitted.append(item)
                        # after on_reject when present, else after options (inline or not)
                        if not done and (item.strip().startswith("on_reject:") or item.strip().startswith("options:")):
                            emitted.append("    verdict_input: " + key)
                            done = True
                    if not done:
                        emitted.append("    verdict_input: " + key)
                    out.extend(emitted)
                    keys.append(key)
                    index = probe
                    continue
            out.append(line)
            index += 1

        if not keys:
            continue
        merged = "\n".join(out) + "\n"
        addition = "".join("  " + key + ":\n    type: string\n    required: false\n" for key in keys)
        if "\ninputs:\n" in merged:
            merged = merged.replace("\ninputs:\n", "\ninputs:\n" + addition, 1)
        elif merged.startswith("inputs:\n"):
            merged = merged.replace("inputs:\n", "inputs:\n" + addition, 1)
        else:
            merged = merged.replace("\nsteps:", "\ninputs:\n" + addition + "\nsteps:", 1)
        _write_text_atomic(file, merged)
        patched.append(str(file.relative_to(root).as_posix()))
    return patched


def _start_job(args: list[str], cwd: Path, timeout: int | None = None) -> dict[str, Any]:
    """Spawn the CLI detached and return immediately.

    A workflow step dispatches a model call, which takes minutes. Holding an HTTP
    request open for that fails in the desktop's 30 s RPC bridge, so the caller
    polls ``GET /jobs/<id>`` instead.

    stdin is a pipe that is closed at once: a gate then pauses (a closed pipe is
    not a TTY) instead of prompting and treating EOF as a rejection.
    """
    job_id = os.urandom(6).hex()
    log_path = Path(tempfile.mkstemp(prefix="speckit-job-", suffix=".log")[1])
    handle = open(log_path, "wb")
    try:
        proc = subprocess.Popen(
            [_specify_cli(), *args],
            cwd=str(cwd),
            stdin=subprocess.PIPE,
            stdout=handle,
            stderr=subprocess.STDOUT,
        )
        if proc.stdin is not None:
            proc.stdin.close()
    finally:
        handle.close()
    JOBS[job_id] = {
        "id": job_id,
        "argv": args,
        "cwd": str(cwd),
        "pid": proc.pid,
        "proc": proc,
        "log": str(log_path),
        "started_at": time.time(),
    }
    return {"job_id": job_id, "pid": proc.pid, "running": True, "stdout_file": str(log_path), "log_path": str(log_path)}


def _job_state(job: dict[str, Any]) -> dict[str, Any]:
    running = job["proc"].poll() is None
    try:
        text = Path(job["log"]).read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    return {
        "job_id": job["id"],
        "running": running,
        "exit_code": None if running else job["proc"].returncode,
        "payload": None if running else _json_tail(text),
        "output": text[-20000:],
    }


def _specify_cli() -> str:
    explicit = os.environ.get("SPECIFY_CLI")
    if explicit and Path(explicit).exists():
        return explicit
    found = shutil.which("specify")
    if found:
        return found
    local = Path.home() / ".local" / "bin" / ("specify.exe" if os.name == "nt" else "specify")
    if local.exists():
        return str(local)
    raise HTTPException(status_code=503, detail="specify CLI not found; set SPECIFY_CLI")


def _json_tail(text: str) -> Optional[Any]:
    """The CLI prints step prose, then one JSON object at the end.

    Parse from the last line that opens an object, so a brace inside the model's
    own output cannot truncate the payload.
    """
    if not text:
        return None
    for marker in ("\n{", "{"):
        index = text.rfind(marker) if marker == "\n{" else text.find(marker)
        if index < 0:
            continue
        start = index + (1 if marker == "\n{" else 0)
        try:
            return json.loads(text[start:])
        except json.JSONDecodeError:
            continue
    return None


def _run_specify(args: list[str], cwd: Path, timeout: int) -> dict[str, Any]:
    """Spawn the CLI with a closed pipe on stdin.

    That is what makes a gate pause instead of blocking a request forever, and it
    is why the pipe and not DEVNULL is used (see below).
    """
    argv = [_specify_cli(), *args]
    try:
        # input="" hands the child a pipe that closes at once. Not DEVNULL: on
        # Windows NUL is a character device, isatty() answers True, and the gate
        # prompts and then reads EOF as a rejection instead of pausing.
        completed = subprocess.run(
            argv,
            cwd=str(cwd),
            input="",
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "exit_code": None,
            "payload": None,
            "output": "",
            "stderr": f"specify timed out after {timeout}s",
            "argv": argv,
        }
    stdout = completed.stdout or ""
    return {
        "ok": completed.returncode == 0,
        "exit_code": completed.returncode,
        "payload": _json_tail(stdout),
        "output": stdout,
        "stderr": completed.stderr or "",
        "argv": argv,
    }


def _process_data(root: Path, process_id: str) -> dict[str, Any]:
    """The installed workflow's YAML, or 404. Presence here is the install check."""
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", process_id or ""):
        raise HTTPException(status_code=400, detail=f"invalid process id: {process_id!r}")
    wf_file = root / ".specify" / "workflows" / process_id / "workflow.yml"
    if not wf_file.is_file():
        raise HTTPException(status_code=404, detail=f"no such process: {process_id}")
    return _load_yaml(wf_file) or {}


def _workflow_result(process: str, result: dict[str, Any]) -> dict[str, Any]:
    payload = result.get("payload") or {}
    gate = payload.get("gate") if isinstance(payload, dict) else None
    return {
        "process": process,
        "run_id": payload.get("run_id") if isinstance(payload, dict) else None,
        "status": payload.get("status") if isinstance(payload, dict) else None,
        "current_step_id": payload.get("current_step_id") if isinstance(payload, dict) else None,
        "current_step_index": payload.get("current_step_index") if isinstance(payload, dict) else None,
        "gate": gate,
        "error": payload.get("error") if isinstance(payload, dict) else None,
        "ok": result.get("ok"),
        "exit_code": result.get("exit_code"),
        "output": result.get("output", ""),
        "stderr": result.get("stderr", ""),
    }


class WorkflowRunRequest(BaseModel):
    cwd: str
    inputs: dict[str, Any] = {}
    timeout: int = 1800


class WorkflowResumeRequest(BaseModel):
    cwd: str
    answers: dict[str, Any] = {}
    timeout: int = 1800


@router.post("/workflows/{process}/run")
def workflow_run(process: str, payload: WorkflowRunRequest) -> dict[str, Any]:
    """Start a workflow. Gates park; nothing executes synchronously."""
    root = _project_root(payload.cwd)
    _process_data(root, process)
    args = ["workflow", "run", process]
    for key, value in payload.inputs.items():
        if value is not None and str(value) != "":
            args += ["-i", f"{key}={value}"]
    args.append("--json")
    _release_finished_jobs()
    key = _active_key(root, process)
    if key in ACTIVE_RUNS:
        raise HTTPException(
            status_code=409,
            detail=f"a {process} run is already in progress in this project",
        )
    before = _run_ids(root)
    before_artifacts = _artifact_index(root)
    job = _start_job(args, root, max(30, min(payload.timeout, SPECIFY_TIMEOUT_MAX)))
    run_id = _await_new_run(root, before)
    if run_id:
        try:
            _snapshot_file(root, run_id).parent.mkdir(parents=True, exist_ok=True)
            _snapshot_file(root, run_id).write_text(json.dumps(before_artifacts), encoding="utf-8")
        except OSError:
            pass
    ACTIVE_RUNS[key] = {"proc": JOBS.get(job["job_id"], {}).get("proc"), "run_id": run_id, "kind": "run"}
    return {
        "process": process,
        "run_id": run_id,
        "job_id": job["job_id"],
        "pid": job["pid"],
        "running": True,
        "stdout_file": job["stdout_file"],
    }



@router.get("/workflows")
def workflow_list(cwd: str = Query(..., description="Absolute project directory")) -> dict[str, Any]:
    """Installed workflows (from the spec-kit engine, not our store)."""
    root = _project_root(cwd)
    data = _process_data(root)
    return {"installed": list(data.get("workflows", {}).keys()), "count": len(data.get("workflows", {}))}

@router.post("/workflows/{process}/runs/{run_id}/resume")
def workflow_resume(process: str, run_id: str, payload: WorkflowResumeRequest) -> dict[str, Any]:
    """Answer a parked gate by feeding the gate's declared inputs."""
    root = _project_root(payload.cwd)
    _process_data(root, process)
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", run_id or ""):
        raise HTTPException(status_code=400, detail=f"invalid run id: {run_id!r}")
    args = ["workflow", "resume", run_id]
    for key, value in payload.answers.items():
        if value is not None and str(value) != "":
            args += ["-i", f"{key}={value}"]
    args.append("--json")
    _release_finished_jobs()
    key = _active_key(root, process)
    if key in ACTIVE_RUNS:
        raise HTTPException(
            status_code=409,
            detail=f"a {process} run is already in progress in this project",
        )
    _write_snapshot(root, run_id)
    job = _start_job(args, root, max(30, min(payload.timeout, SPECIFY_TIMEOUT_MAX)))
    ACTIVE_RUNS[key] = {"proc": JOBS.get(job["job_id"], {}).get("proc"), "run_id": run_id, "kind": "resume"}
    return {"process": process, "run_id": run_id, "job_id": job["job_id"], "running": True}


@router.post("/workflows/{process}/runs/{run_id}/stop")
def stop_run(process: str, run_id: str, payload: WorkflowResumeRequest) -> dict[str, Any]:
    """Kill the dispatched step. The engine's own state is left as it stands."""
    root = _project_root(payload.cwd)
    _process_data(root, process)
    if not RUN_ID_RE.fullmatch(run_id or ""):
        raise HTTPException(status_code=400, detail=f"invalid run id: {run_id!r}")
    killed: list[int] = []
    for job in list(JOBS.values()):
        proc = job.get("proc")
        if proc is None or proc.poll() is not None:
            continue
        argv = job.get("argv") or []
        if str(job.get("cwd", "")).lower() != str(root).lower():
            continue
        if argv[:1] != ["workflow"] and run_id not in " ".join(argv):
            continue
        pid = proc.pid
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, timeout=30)
            else:
                proc.kill()
            killed.append(pid)
        except (OSError, subprocess.SubprocessError):
            continue
    _release_finished_jobs()
    ACTIVE_RUNS.pop(_active_key(root, process), None)
    return {"run_id": run_id, "stopped": bool(killed), "pids": killed}


# ---------------------------------------------------------------------------
# wizard support: init, artifacts, live run state
# ---------------------------------------------------------------------------

RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class InitRequest(BaseModel):
    cwd: str
    integration: str = "hermes"


@router.post("/init")
def init_project(payload: InitRequest) -> dict[str, Any]:
    """Bootstrap .specify/ in an empty folder with the Hermes integration."""
    root = _project_root(payload.cwd)
    if (root / ".specify").is_dir():
        return {"ok": True, "already": True, "cwd": str(root), "output": ""}
    integration = re.sub(r"[^a-z0-9_-]", "", (payload.integration or "hermes").lower()) or "hermes"
    result = _run_specify(
        ["init", "--here", "--force", "--non-interactive", "--integration", integration], root, 600
    )
    synced = _sync_legacy_skills()
    patched = _ensure_gate_verdicts(root)
    return {
        "ok": result["ok"],
        "already": False,
        "cwd": str(root),
        "output": result.get("output", "") + result.get("stderr", ""),
        "skills_synced": synced,
        "workflows_patched": patched,
    }


@router.post("/repair-workflows")
def repair_workflows(payload: InitRequest) -> dict[str, Any]:
    """Add missing gate verdict inputs to an existing project's workflows."""
    root = _project_root(payload.cwd)
    return {"cwd": str(root), "patched": _ensure_gate_verdicts(root)}


class ArtifactWrite(BaseModel):
    cwd: str
    path: str
    content: str
    base_mtime: Optional[int] = None


@router.put("/artifact")
def write_artifact(payload: ArtifactWrite) -> dict[str, Any]:
    """Save an edited artifact. A stale base_mtime returns 409 with the winner."""
    root = _project_root(payload.cwd)
    target = (root / payload.path).resolve()
    allowed = [(root / ".specify").resolve(), (root / "specs").resolve()]
    if not any(base == target or base in target.parents for base in allowed):
        raise HTTPException(status_code=400, detail="path must stay inside .specify/ or specs/")

    current = _mtime_ms(target)
    if payload.base_mtime is None:
        if current is not None:
            raise HTTPException(status_code=409, detail={
                "conflict": True,
                "reason": "file appeared after the pane loaded it",
                "path": payload.path,
                "content": _read_text(target),
                "mtime": current,
            })
    elif current != payload.base_mtime:
        raise HTTPException(status_code=409, detail={
            "conflict": True,
            "reason": "file changed on disk since the pane loaded it",
            "path": payload.path,
            "content": _read_text(target) if current is not None else "",
            "mtime": current,
        })

    mtime = _write_text_atomic(target, payload.content)
    return {"path": payload.path, "mtime": mtime, "bytes": len(payload.content.encode("utf-8"))}


class ExtensionRequest(BaseModel):
    cwd: str
    id: str


@router.get("/extensions")
def list_extensions(cwd: str = Query(..., description="Absolute project directory")) -> dict[str, Any]:
    """Installed spec-kit extensions, read from the project's own manifest."""
    root = _project_root(cwd)
    installed: list[str] = []
    marker = root / ".specify" / "integrations" / "speckit.manifest.json"
    for candidate in (root / ".specify" / "extensions", root / ".specify" / "integrations"):
        if not candidate.is_dir():
            continue
        for entry in candidate.iterdir():
            if entry.is_dir():
                installed.append(entry.name)
    if marker.is_file():
        try:
            manifest = json.loads(marker.read_text(encoding="utf-8"))
            for key in ("extensions", "installed_extensions"):
                for item in manifest.get(key) or []:
                    name = item.get("id") if isinstance(item, dict) else item
                    if name:
                        installed.append(str(name))
        except (OSError, ValueError):
            pass
    return {"cwd": str(root), "installed": sorted(set(installed))}


@router.post("/extensions/install")
def install_extension(payload: ExtensionRequest) -> dict[str, Any]:
    """Install a bundled extension (bug, assess) and refresh workflow discovery."""
    root = _project_root(payload.cwd)
    ext_id = re.sub(r"[^a-z0-9_-]", "", (payload.id or "").lower())
    if ext_id not in {"bug", "assess"}:
        raise HTTPException(status_code=400, detail=f"unknown extension: {payload.id!r}")
    result = _run_specify(["extension", "add", ext_id], root, 300)
    # Only this extension's own workflows are touched; the SDD shape is its own.
    _ensure_gate_verdicts(root)
    return {
        "ok": result["ok"],
        "extension": ext_id,
        "output": (result.get("output", "") + result.get("stderr", ""))[-4000:],
    }


#: step id -> gate key, because the step is `specify` and its gate is `review-spec`
GATE_FOR = {"constitution": "constitution", "specify": "spec", "clarify": "clarify", "plan": "plan", "tasks": "tasks"}

GATES = {
    "constitution": "Review the constitution before specifying.",
    "spec": "Review the spec before planning.",
    "clarify": "Review the clarifications folded into the spec.",
    "plan": "Review the plan before generating tasks.",
    "tasks": "Review the task breakdown before implementing.",
}

SHORT_PATH = ["specify", "plan", "tasks", "implement", "converge"]
FULL_PATH = ["specify", "clarify", "plan", "checklist", "tasks", "analyze", "implement", "converge"]


def _workflow_yaml(mode: str, with_constitution: bool = True) -> str:
    """Render the documented SDD workflow for the chosen path.

    Inputs are declared only for steps this path actually runs: the short path
    has no clarify step, so it must not ask for a clarify focus. The
    constitution is once per project, so it is omitted once a ratified
    constitution exists.
    """
    steps = list(FULL_PATH if mode == "full" else SHORT_PATH)
    if with_constitution:
        steps = ["constitution"] + steps
    if mode == "full" and "clarify" not in steps:
        steps.insert(1, "clarify")

    inputs: list[tuple[str, bool, str]] = []
    if with_constitution:
        inputs.append(("principles", False, "Constitution: principles and constraints"))
    inputs.append(("spec", True, "Describe what you want to build"))
    if "clarify" in steps:
        inputs.append(("focus", False, "Clarify: focus area"))
    if "plan" in steps:
        inputs.append(("stack", False, "Plan: tech stack and architecture"))

    # Every gate's verdict_input has to exist in inputs:, or the schema rejects
    # the gate. Declare them from the same list that generates the gates.
    verdicts = [f"gate_review_{GATE_FOR[name]}" for name in steps if GATE_FOR.get(name) in GATES]

    lines = [
        "# generated by spec-kit-hermes: choosing a path rewrites this file",
        "# a copy is kept as workflow.yml.bak-<timestamp> when it differs",
        'schema_version: "1.0"',
        "workflow:",
        '  id: "speckit"',
        '  name: "Spec-Driven Development"',
        '  version: "1.2.0"',
        '  author: "Hermes Desktop integration"',
        '  description: "Documented ' + mode + ' path: ' + " -> ".join(steps) + '"',
        "",
        "requires:",
        '  speckit_version: ">=0.8.5"',
        "",
        "inputs:",
    ]
    for name, required, prompt in inputs:
        lines += [
            f"  {name}:",
            "    type: string",
            f"    required: {'true' if required else 'false'}",
            f'    prompt: "{prompt}"',
        ]
    for verdict in verdicts:
        lines += [f"  {verdict}:", "    type: string", "    required: false"]
    lines += [
        "  integration:",
        "    type: string",
        '    default: "auto"',
        "",
        "steps:",
    ]

    for name in steps:
        if name == "constitution":
            lines += [
                "  - id: constitution",
                "    command: speckit.constitution",
                '    integration: "{{ inputs.integration }}"',
                "    input:",
                '      args: "{{ inputs.principles }}"',
            ]
        elif name == "specify":
            lines += [
                "  - id: specify",
                "    command: speckit.specify",
                '    integration: "{{ inputs.integration }}"',
                "    input:",
                '      args: "{{ inputs.spec }}"',
            ]
        elif name == "clarify":
            lines += [
                "  - id: clarify",
                "    command: speckit.clarify",
                '    integration: "{{ inputs.integration }}"',
                "    input:",
                '      args: "{{ inputs.focus }}"',
            ]
        elif name == "plan":
            lines += [
                "  - id: plan",
                "    command: speckit.plan",
                '    integration: "{{ inputs.integration }}"',
                "    input:",
                '      args: "{{ inputs.stack }}"',
            ]
        else:
            lines += [
                f"  - id: {name}",
                f"    command: speckit.{name}",
                '    integration: "{{ inputs.integration }}"',
            ]
        gate_key = GATE_FOR.get(name)
        gate_name = GATES.get(gate_key) if gate_key else None
        if gate_name:
            lines += [
                f"  - id: review-{gate_key}",
                "    type: gate",
                f'    message: "{gate_name}"',
                "    options: [approve, reject]",
                f"    verdict_input: gate_review_{gate_key}",
                "    on_reject: abort",
            ]
    return "\n".join(lines) + "\n"


class ShapeRequest(BaseModel):
    cwd: str
    mode: str = "full"
    # None means "decide from the project": a ratified constitution is not re-run.
    constitution: Optional[bool] = None


@router.post("/workflow/shape")
def shape_workflow(payload: ShapeRequest) -> dict[str, Any]:
    """Write the short or full documented SDD workflow into the project."""
    root = _project_root(payload.cwd)
    mode = "full" if str(payload.mode).lower() == "full" else "short"
    target = root / ".specify" / "workflows" / "speckit" / "workflow.yml"
    if not target.parent.is_dir():
        raise HTTPException(status_code=404, detail="no speckit workflow installed here")

    with_constitution = payload.constitution
    if with_constitution is None:
        with_constitution = not _constitution_ready(root)
    generated = _workflow_yaml(mode, with_constitution)
    backup = None
    changed = True
    current = ""
    try:
        current = target.read_text(encoding="utf-8")
    except OSError:
        current = ""
    if current == generated:
        changed = False
    elif current.strip():
        # Keep the previous file: shaping is a convenience, and a hand-edited
        # workflow is the user's work, not something to overwrite silently.
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        backup = target.with_name(f"workflow.yml.bak-{stamp}")
        try:
            backup.write_text(current, encoding="utf-8")
        except OSError:
            backup = None
        _write_text_atomic(target, generated)
    else:
        _write_text_atomic(target, generated)

    data = _process_data(root, "speckit")
    return {
        "mode": mode,
        "path": str(target),
        "constitution": with_constitution,
        "changed": changed,
        "backup": str(backup) if backup else None,
        "steps": [step["id"] for step in data.get("steps", [])],
    }


# ---------------------------------------------------------------------------
# dispatched-skill working directory: detect and repair
# ---------------------------------------------------------------------------

#: Marks the local fix in spec-kit's Hermes integration.
INTEGRATION_MARKER = "Run the agent inside the project"

#: The line the fix is anchored to, verbatim from the integration.
INTEGRATION_ANCHOR = '        args = [self._resolve_executable(), "chat", "-Q"]\n'

INTEGRATION_ADDITION = INTEGRATION_ANCHOR + '''
        # Run the agent inside the project. Without this the skill executes in
        # whatever workspace the gateway sits in, so specs/ and code land
        # somewhere other than the project being worked on.
        if project_root is not None:
            args.extend(["--in", str(Path(project_root).resolve())])
'''


def _integration_files() -> list[Path]:
    """Every installed copy of spec-kit's Hermes integration on this machine."""
    found: list[Path] = []
    local = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    cache = local / "uv" / "cache" / "archive-v0"
    if cache.is_dir():
        found.extend(cache.glob("*/specify_cli/integrations/hermes/__init__.py"))
    checkout = local / "spec-kit" / "src" / "specify_cli" / "integrations" / "hermes" / "__init__.py"
    if checkout.is_file():
        found.append(checkout)
    try:
        import importlib.util as _ilu

        spec = _ilu.find_spec("specify_cli")
        if spec and spec.origin:
            candidate = Path(spec.origin).parent / "integrations" / "hermes" / "__init__.py"
            if candidate.is_file():
                found.append(candidate)
    except (ImportError, ValueError):
        pass
    return sorted(set(found))


def _integration_copies() -> list[dict[str, Any]]:
    copies: list[dict[str, Any]] = []
    for file in _integration_files():
        try:
            text = file.read_text(encoding="utf-8")
        except OSError:
            continue
        copies.append({"path": str(file), "patched": INTEGRATION_MARKER in text})
    return copies


def _integration_health() -> dict[str, Any]:
    copies = _integration_copies()
    return {
        "checked": len(copies),
        "patched": bool(copies) and all(copy["patched"] for copy in copies),
        "copies": copies,
    }


def _patch_integration_file(file: Path) -> bool:
    try:
        text = file.read_text(encoding="utf-8")
    except OSError:
        return False
    if INTEGRATION_MARKER in text or INTEGRATION_ANCHOR not in text:
        return False
    file.write_text(text.replace(INTEGRATION_ANCHOR, INTEGRATION_ADDITION, 1), encoding="utf-8")
    return True


@router.get("/integration/health")
def integration_health() -> dict[str, Any]:
    """Is a dispatched skill told which project it is working in?

    Upstream's ``build_exec_args`` accepts ``project_root`` and ignores it, so
    without this patch every skill runs in the gateway's workspace and writes
    files outside the project. The fix is a file edit, and ``uv tool upgrade``
    replaces that file.
    """
    return _integration_health()


@router.post("/integration/repair")
def integration_repair() -> dict[str, Any]:
    repaired: list[str] = []
    failed: list[str] = []
    for copy in _integration_copies():
        if copy["patched"]:
            continue
        file = Path(copy["path"])
        if _patch_integration_file(file):
            repaired.append(str(file))
        else:
            failed.append(str(file))
    return {"repaired": repaired, "failed": failed, **_integration_health()}


@router.get("/log")
def tail_log(
    cwd: str = Query(..., description="Absolute project directory"),
    tail: int = Query(8000, ge=200, le=60000),
) -> dict[str, Any]:
    """Tail of the newest dispatcher log for this project.

    A step dispatches an agent call that can run for minutes. Without this the
    pane can only say "running"; with it the user can see progress or a stack
    trace as it happens.
    """
    root = _project_root(cwd)
    candidates = [
        job for job in JOBS.values()
        if str(job.get("cwd", "")).lower() == str(root).lower()
    ]
    if not candidates:
        return {"running": False, "output": "", "path": None}
    job = max(candidates, key=lambda item: item.get("started_at", 0))
    path = Path(str(job.get("log", "")))
    text = ""
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - tail))
            text = handle.read().decode("utf-8", errors="replace")
    except OSError:
        text = ""
    proc = job.get("proc")
    return {
        "running": bool(proc is not None and proc.poll() is None),
        "output": text,
        "path": str(path),
        "started_at": job.get("started_at"),
    }


@router.get("/workflows/{process}/runs")
def list_runs(process: str, cwd: str = Query(..., description="Absolute project directory")) -> dict[str, Any]:
    """Every run on disk for this project, newest first."""
    root = _project_root(cwd)
    _process_data(root, process)
    runs_dir = root / ".specify" / "workflows" / "runs"
    out: list[dict[str, Any]] = []
    if runs_dir.is_dir():
        for entry in runs_dir.iterdir():
            state_file = entry / "state.json"
            if not state_file.is_file():
                continue
            try:
                state = json.loads(state_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            out.append({
                "run_id": entry.name,
                "status": state.get("status"),
                "current_step_id": state.get("current_step_id"),
                "current_step_index": state.get("current_step_index"),
                "updated_at": state.get("updated_at"),
                "created_at": state.get("created_at"),
                "summary": (state.get("inputs") or {}).get("spec")
                    or (state.get("inputs") or {}).get("report")
                    or (state.get("inputs") or {}).get("idea")
                    or "",
                "mtime": _mtime_ms(state_file),
            })
    out.sort(key=lambda item: item.get("mtime") or 0, reverse=True)
    return {"runs": out, "count": len(out)}


@router.get("/browse")
def browse(path: str = Query("", description="Directory to list; empty lists filesystem roots")) -> dict[str, Any]:
    """Directory listing for the pane's folder browser.

    The plugin SDK exposes no folder dialog (checked: no showOpenDialog, no
    showDirectoryPicker), so the pane walks the filesystem through this route.
    """
    if not path.strip():
        roots: list[dict[str, Any]] = []
        if os.name == "nt":
            for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
                candidate = Path(f"{letter}:/")
                try:
                    if candidate.exists():
                        roots.append({
                            "name": f"{letter}:\\",
                            "path": str(candidate),
                            "has_specify": (candidate / ".specify").is_dir(),
                        })
                except OSError:
                    continue
        home = Path.home()
        roots.insert(0, {
            "name": f"Home ({home.name})",
            "path": str(home),
            "has_specify": (home / ".specify").is_dir(),
        })
        return {"path": "", "parent": None, "entries": roots}

    base = Path(path).expanduser()
    if not base.is_dir():
        raise HTTPException(status_code=400, detail=f"not a directory: {path}")
    try:
        children = sorted(base.iterdir(), key=lambda item: item.name.lower())
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"cannot read {path}: {exc}")
    entries: list[dict[str, Any]] = []
    for child in children:
        try:
            if not child.is_dir():
                continue
            entries.append({
                "name": child.name,
                "path": str(child),
                "has_specify": (child / ".specify").is_dir(),
            })
        except OSError:
            continue
    parent = str(base.parent) if base.parent != base else None
    return {"path": str(base), "parent": parent, "entries": entries[:500]}


# ---------------------------------------------------------------------------
# clarification interview
# ---------------------------------------------------------------------------

CLARIFICATION = re.compile(r"\[NEEDS CLARIFICATION:\s*([^\]]*)\]")


def _read_confined(root: Path, path: str) -> Path:
    target = (root / path).resolve()
    allowed = [
        (root / ".specify").resolve(),
        (root / "specs").resolve(),
    ]
    if not any(base == target or base in target.parents for base in allowed):
        raise HTTPException(status_code=400, detail="path must stay inside .specify/ or specs/")
    return target


@router.get("/questions")
def list_questions(
    cwd: str = Query(..., description="Absolute project directory"),
    path: str = Query(..., description="Artifact to inspect"),
) -> dict[str, Any]:
    """Open `[NEEDS CLARIFICATION: ...]` markers in one artifact.

    spec-kit uses these markers as its quality gate, and its own guidance for
    resolving them is to edit the artifact or tell the agent. This surfaces them
    as questions so the answers can be written back in one pass.
    """
    root = _project_root(cwd)
    target = _read_confined(root, path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"not found: {path}")
    text = _read_text(target)
    questions = [
        {"index": index, "text": match.group(1).strip()}
        for index, match in enumerate(CLARIFICATION.finditer(text))
    ]
    return {"path": path, "questions": questions, "count": len(questions)}


class AnswerRequest(BaseModel):
    cwd: str
    path: str
    answers: dict[str, str] = {}


@router.post("/clarify")
def answer_questions(payload: AnswerRequest) -> dict[str, Any]:
    """Replace answered markers in place; unanswered ones stay as markers."""
    root = _project_root(payload.cwd)
    target = _read_confined(root, payload.path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"not found: {payload.path}")

    text = _read_text(target)
    matches = list(CLARIFICATION.finditer(text))
    answered = 0
    out: list[str] = []
    cursor = 0
    for index, match in enumerate(matches):
        answer = (payload.answers.get(str(index)) or "").strip()
        out.append(text[cursor:match.start()])
        if answer:
            out.append(answer)
            answered += 1
        else:
            out.append(match.group(0))
        cursor = match.end()
    out.append(text[cursor:])
    updated = "".join(out)

    remaining = len(CLARIFICATION.findall(updated))
    if answered:
        _write_text_atomic(target, updated)
    return {
        "path": payload.path,
        "answered": answered,
        "remaining": remaining,
        "content": updated,
        "mtime": _mtime_ms(target),
    }


@router.get("/artifacts")
def list_artifacts(cwd: str = Query(..., description="Absolute project directory")) -> dict[str, Any]:
    """Every spec-kit artifact under .specify, newest feature first."""
    root = _project_root(cwd)
    out: list[dict[str, Any]] = []
    # spec-kit writes feature folders to <project>/specs/NNN-name/. Older trees
    # kept them under .specify/specs, so both are scanned.
    # SDD writes specs/, bugs/ and assessments/ live under .specify/.
    for specs in (
        root / "specs",
        root / ".specify" / "specs",
        root / ".specify" / "bugs",
        root / ".specify" / "assessments",
    ):
        if not specs.is_dir():
            continue
        features = [d for d in specs.iterdir() if d.is_dir()]
        features.sort(key=lambda d: d.stat().st_mtime, reverse=True)
        for feature in features:
            for path in sorted(feature.rglob("*")):
                if path.is_file():
                    rel = path.relative_to(root).as_posix()
                    out.append({
                        "feature": feature.name,
                        "path": rel,
                        "name": path.name,
                        "size": path.stat().st_size,
                        "mtime": _mtime_ms(path),
                    })
    memory = root / ".specify" / "memory" / "constitution.md"
    if memory.is_file():
        out.append({
            "feature": "memory",
            "path": ".specify/memory/constitution.md",
            "name": "constitution.md",
            "size": memory.stat().st_size,
            "mtime": _mtime_ms(memory),
        })
    return {"cwd": str(root), "artifacts": out, "count": len(out)}


@router.get("/artifact")
def read_artifact(
    cwd: str = Query(..., description="Absolute project directory"),
    path: str = Query(..., description="Repo-relative path under .specify/"),
) -> dict[str, Any]:
    """Read one artifact. Paths are confined to .specify/."""
    root = _project_root(cwd)
    target = (root / path).resolve()
    allowed = [(root / ".specify").resolve(), (root / "specs").resolve()]
    if not any(base == target or base in target.parents for base in allowed):
        raise HTTPException(status_code=400, detail="path must stay inside .specify/ or specs/")
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"not found: {path}")
    return {"path": path, "content": _read_text(target), "mtime": _mtime_ms(target), "exists": True}


def _latest_run(root: Path) -> Optional[dict[str, Any]]:
    runs = root / ".specify" / "workflows" / "runs"
    if not runs.is_dir():
        return None
    candidates = [d for d in runs.iterdir() if d.is_dir() and (d / "state.json").is_file()]
    if not candidates:
        return None
    newest = max(candidates, key=lambda d: (d / "state.json").stat().st_mtime)
    try:
        state = json.loads((newest / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return {"run_id": newest.name, "state": state}


def _run_view(process: str, run: dict[str, Any], root: Path) -> dict[str, Any]:
    state = run["state"]
    nodes = ((state.get("execution") or {}).get("nodes") or [])
    step_id = state.get("current_step_id") or ""
    gate = None
    results = state.get("step_results") or {}
    current = results.get(step_id) or {}
    if current.get("type") == "gate" and current.get("status") == "paused":
        output = current.get("output") or {}
        gate = {
            "step_id": step_id,
            "message": output.get("message") or "Review before continuing.",
            "options": output.get("options") or ["approve", "reject"],
            "verdict_input": current.get("verdict_input") or f"gate_{step_id.replace('-', '_')}",
            "show_file": output.get("show_file"),
        }
    return {
        "process": process,
        "run_id": run["run_id"],
        "status": state.get("status"),
        "current_step_id": step_id,
        "current_step_index": state.get("current_step_index"),
        "gate": gate,
        "error": state.get("error"),
        "inputs": state.get("inputs") or {},
        "step_results": {
            k: {
                "type": v.get("type"),
                "status": v.get("status"),
                "error": v.get("error"),
                "stdout": ((v.get("output") or {}).get("stdout") or "")[-4000:],
            }
            for k, v in results.items()
        },
        "nodes": [{"phase": n.get("phase"), "outcome": n.get("outcome")} for n in nodes],
        "output_check": _output_check(root, run["run_id"]),
        "updated_at": state.get("updated_at"),
    }


@router.get("/workflows/{process}/runs/latest")
def workflow_latest(process: str, cwd: str = Query(..., description="Absolute project directory")) -> dict[str, Any]:
    """Newest run's live state. The pane polls this instead of holding a request open."""
    root = _project_root(cwd)
    _process_data(root, process)
    run = _latest_run(root)
    if run is None:
        return {"process": process, "status": "none", "run_id": None, "gate": None, "nodes": []}
    return _run_view(process, run, root)


@router.get("/workflows/{process}/runs/{run_id}")
def workflow_run_state(process: str, run_id: str, cwd: str = Query(...)) -> dict[str, Any]:
    root = _project_root(cwd)
    _process_data(root, process)
    if not RUN_ID_RE.fullmatch(run_id or ""):
        raise HTTPException(status_code=400, detail=f"invalid run id: {run_id!r}")
    state_file = root / ".specify" / "workflows" / "runs" / run_id / "state.json"
    if not state_file.is_file():
        raise HTTPException(status_code=404, detail=f"no such run: {run_id}")
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise HTTPException(status_code=500, detail="run state is not readable JSON")
    return _run_view(process, {"run_id": run_id, "state": state}, root)


# ---------------------------------------------------------------------------
# kanban
# ---------------------------------------------------------------------------

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

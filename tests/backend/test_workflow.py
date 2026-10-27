"""Tests for the workflow bridge.

The plugin does not run workflows itself: spec-kit's engine does, and this bridge
spawns `specify workflow run|resume|status --json` with stdin closed. Everything
here stubs the spawn and pins the argv the CLI will actually receive, plus the
payload shaping the pane renders.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path

import pytest
import yaml
from fastapi import FastAPI
from starlette.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[2] / "dashboard"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

spec = importlib.util.spec_from_file_location("speckit_plugin_api_wf", BACKEND_DIR / "plugin_api.py")
plugin_api = importlib.util.module_from_spec(spec)
sys.modules["speckit_plugin_api_wf"] = plugin_api
spec.loader.exec_module(plugin_api)

PREFIX = "/api/plugins/spec-kit-hermes"

WORKFLOW = """\
schema_version: "1.0"
workflow:
  id: "speckit"
  name: "Full SDD Cycle"
  version: "1.0.1"
inputs:
  spec:
    type: string
    required: true
  gate_review_spec:
    type: string
    required: false
steps:
  - id: specify
    command: speckit.specify
    input:
      args: "{{ inputs.spec }}"
  - id: review-spec
    type: gate
    message: "Review the generated spec before planning."
    options: [approve, reject]
    on_reject: abort
    verdict_input: gate_review_spec
"""


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(plugin_api.router, prefix=PREFIX)
    return TestClient(app)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    wf = root / ".specify" / "workflows" / "speckit"
    wf.mkdir(parents=True)
    (wf / "workflow.yml").write_text(WORKFLOW, encoding="utf-8")
    (root / ".specify" / "specs" / "001-demo").mkdir(parents=True)
    (root / ".specify" / "specs" / "001-demo" / "spec.md").write_text("# Spec\n", encoding="utf-8")
    run_dir = root / ".specify" / "workflows" / "runs" / "abc123"
    run_dir.mkdir(parents=True)
    (run_dir / "state.json").write_text("{}", encoding="utf-8")
    return root


@pytest.fixture
def cli(monkeypatch):
    calls = []
    state = {"stdout": "", "payload": None, "ok": True, "exit_code": 0}

    def fake(args, cwd, timeout):
        calls.append({"args": args, "cwd": str(cwd), "timeout": timeout})
        # Return exactly what the endpoint expects from _start_job so the
        # response can build its fields without guessing.
        return {
            "job_id": f"stub-{os.urandom(3).hex()}",
            "pid": 99999,
            "running": False,
            "stdout_file": "/fake/stdout",
            "ok": state["ok"],
            "payload": state["payload"],
            "output": state["stdout"],
            "exit_code": state["exit_code"],
        }

    monkeypatch.setattr(plugin_api, "_start_job", fake)
    monkeypatch.setattr(plugin_api, "_await_new_run", lambda root, before, timeout=25.0: "run-abc")
    return calls, state


@pytest.fixture
def specify_run(monkeypatch):
    """Stub the synchronous CLI call init makes (it is not a background job)."""
    calls = []

    def fake(args, cwd, timeout):
        calls.append({"args": args, "cwd": str(cwd), "timeout": timeout})
        return {"ok": True, "exit_code": 0, "payload": None, "output": "project ready", "stderr": ""}

    monkeypatch.setattr(plugin_api, "_run_specify", fake)
    return calls


def test_json_tail_ignores_prose_and_braces_in_it(monkeypatch):
    text = 'Here is a spec { "not": "the payload" } and more prose\n{"run_id": "abc", "status": "paused"}'
    assert plugin_api._json_tail(text) == {"run_id": "abc", "status": "paused"}
    assert plugin_api._json_tail("") is None
    assert plugin_api._json_tail("no json here") is None


def test_run_builds_the_documented_argv(client, project, cli):
    calls, _ = cli

    body = client.post(
        f"{PREFIX}/workflows/speckit/run",
        json={"cwd": str(project), "inputs": {"spec": "a greeting CLI", "gate_review_spec": ""}},
    ).json()

    assert calls[0]["args"] == [
        "workflow", "run", "speckit",
        "-i", "spec=a greeting CLI",
        "--json",
    ], "empty inputs are skipped, not sent as -i key="
    # The pane polls /runs/latest, so the request must return at once with a job.
    assert body["running"] is True
    assert body["run_id"] == "run-abc"
    assert body["job_id"]


def test_run_404s_when_the_workflow_is_not_installed(client, project, cli):
    response = client.post(
        f"{PREFIX}/workflows/nope/run", json={"cwd": str(project), "inputs": {}}
    )
    assert response.status_code == 404
    assert cli[0] == [], "nothing should be spawned for an unknown workflow"


def test_resume_feeds_the_gate_verdict(client, project, cli):
    calls, state = cli
    state["payload"] = {"run_id": "r1", "status": "completed", "current_step_id": "plan"}

    body = client.post(
        f"{PREFIX}/workflows/speckit/runs/r1/resume",
        json={"cwd": str(project), "answers": {"gate_review_spec": "approve"}},
    ).json()

    assert calls[0]["args"] == [
        "workflow", "resume", "r1",
        "-i", "gate_review_spec=approve",
        "--json",
    ]
    assert body["running"] is True
    assert body["run_id"] == "r1"


def test_status_reads_the_engine_state(client, project, cli):
    calls, _ = cli
    run_dir = project / ".specify" / "workflows" / "runs" / "abc123"
    (run_dir / "state.json").write_text(
        json.dumps({
            "run_id": "abc123",
            "status": "paused",
            "current_step_id": "review-spec",
            "current_step_index": 1,
            "step_results": {
                "review-spec": {
                    "type": "gate",
                    "status": "paused",
                    "output": {"message": "Review the spec.", "options": ["approve", "reject"]},
                }
            },
            "execution": {"nodes": [{"phase": "done"}, {"phase": "blocked"}]},
        }),
        encoding="utf-8",
    )

    body = client.get(f"{PREFIX}/workflows/speckit/runs/abc123", params={"cwd": str(project)}).json()

    assert calls == [], "state is read from disk, not by shelling out"
    assert body["status"] == "paused"
    assert body["gate"]["verdict_input"] == "gate_review_spec"

    missing = client.get(f"{PREFIX}/workflows/speckit/runs/nope", params={"cwd": str(project)})
    assert missing.status_code == 404


def test_resume_rejects_a_traversal_run_id(client, project, cli):
    response = client.post(
        f"{PREFIX}/workflows/speckit/runs/..%2Fescape/resume",
        json={"cwd": str(project), "answers": {}},
    )
    assert response.status_code in (400, 404)
    assert cli[0] == []


def test_a_spawn_failure_is_reported_not_swallowed(client, project, monkeypatch):
    def boom(args, cwd, timeout=None):
        raise OSError("specify is not installed")

    monkeypatch.setattr(plugin_api, "_start_job", boom)
    strict = TestClient(client.app, raise_server_exceptions=False)
    response = strict.post(
        f"{PREFIX}/workflows/speckit/run", json={"cwd": str(project), "inputs": {"spec": "x"}}
    )
    assert response.status_code >= 400


def test_artifacts_skip_run_machinery_and_sort_newest_first(client, project):
    body = client.get(f"{PREFIX}/artifacts", params={"cwd": str(project)}).json()
    paths = [row["path"] for row in body["artifacts"]]
    assert ".specify/specs/001-demo/spec.md" in paths
    assert not any("/workflows/runs/" in path for path in paths)


def test_artifact_reads_a_file_and_refuses_escapes(client, project):
    ok = client.get(
        f"{PREFIX}/artifact",
        params={"cwd": str(project), "path": ".specify/specs/001-demo/spec.md"},
    ).json()
    assert ok["content"] == "# Spec\n"

    outside = client.get(
        f"{PREFIX}/artifact", params={"cwd": str(project), "path": "scripts/build.mjs"}
    )
    assert outside.status_code == 400
    assert "inside .specify" in outside.json()["detail"]


def test_init_bootstraps_a_folder_that_has_no_specify(client, tmp_path, specify_run):
    calls = specify_run
    bare = tmp_path / "bare"
    bare.mkdir()

    body = client.post(f"{PREFIX}/init", json={"cwd": str(bare)}).json()

    assert body["already"] is False
    assert body["ok"] is True
    assert calls[0]["args"] == [
        "init", "--here", "--force", "--non-interactive", "--integration", "hermes",
    ], "a closed stdin would abort on the not-empty-directory prompt"


def test_init_is_a_no_op_when_specify_exists(client, project, cli):
    calls, _ = cli
    body = client.post(f"{PREFIX}/init", json={"cwd": str(project)}).json()
    assert body["already"] is True
    assert calls == [], "an initialised project must not be re-initialised"


def test_legacy_skills_are_copied_where_hermes_reads(tmp_path, monkeypatch):
    home = tmp_path / "home"
    source = home / ".hermes" / "skills" / "speckit-plan"
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text("---\nname: speckit-plan\n---\n", encoding="utf-8")

    profile_skills = tmp_path / "hh" / "skills"
    profile_skills.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hh"))

    assert plugin_api._sync_legacy_skills() == ["speckit-plan"]
    assert (profile_skills / "speckit-plan" / "SKILL.md").is_file()
    assert plugin_api._sync_legacy_skills() == [], "a second run must not recopy"


def test_output_check_flags_a_step_that_wrote_nothing(project):
    """A dispatch can exit 0 and write nothing; only mtimes can tell them apart."""
    run_id = "abc123"
    plugin_api._write_snapshot(project, run_id)
    assert plugin_api._output_check(project, run_id)["unchanged"] is True

    spec = project / ".specify" / "specs" / "001-demo" / "spec.md"
    spec.write_text("# Spec, rewritten\n", encoding="utf-8")
    # mtime has millisecond resolution and the write can land in the same one
    os.utime(spec, (time.time() + 2, time.time() + 2))
    after = plugin_api._output_check(project, run_id)
    assert after["unchanged"] is False
    assert ".specify/specs/001-demo/spec.md" in after["changed"]


def test_output_check_reports_removed_artifacts(project):
    run_id = "abc123"
    spec = project / ".specify" / "specs" / "001-demo" / "spec.md"
    plugin_api._write_snapshot(project, run_id)
    spec.unlink()
    result = plugin_api._output_check(project, run_id)
    assert ".specify/specs/001-demo/spec.md" in result["removed"]
    assert result["unchanged"] is False


def test_a_second_run_is_refused_while_one_is_active(client, project, cli, monkeypatch):
    class FakeProc:
        pid = 4242

        def poll(self):
            return None

    monkeypatch.setattr(plugin_api, "JOBS", {"j1": {"proc": FakeProc(), "argv": ["workflow", "run"], "cwd": str(project)}})
    plugin_api.ACTIVE_RUNS.clear()
    key = plugin_api._active_key(project, "speckit")
    plugin_api.ACTIVE_RUNS[key] = {"proc": FakeProc(), "run_id": "abc123", "kind": "run"}

    response = client.post(
        f"{PREFIX}/workflows/speckit/run", json={"cwd": str(project), "inputs": {"spec": "x"}}
    )
    assert response.status_code == 409
    assert "already in progress" in response.json()["detail"]
    plugin_api.ACTIVE_RUNS.clear()


def test_stop_kills_the_matching_job(client, project, monkeypatch):
    """Stop must signal the process for this project and this run."""
    ran = []
    signalled = []

    class FakeProc:
        pid = 5150

        def __init__(self):
            self.alive = True

        def poll(self):
            return None if self.alive else 0

        def kill(self):
            # The POSIX path signals the Popen directly; Windows shells out to taskkill.
            signalled.append(self.pid)
            self.alive = False

    monkeypatch.setattr(plugin_api, "JOBS", {
        "j1": {"proc": FakeProc(), "argv": ["workflow", "resume", "abc123"], "cwd": str(project)}
    })
    monkeypatch.setattr(
        plugin_api.subprocess, "run",
        lambda argv, **kwargs: ran.append(argv) or type("R", (), {"returncode": 0})(),
    )
    plugin_api.ACTIVE_RUNS.clear()

    response = client.post(
        f"{PREFIX}/workflows/speckit/runs/abc123/stop", json={"cwd": str(project), "answers": {}}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["stopped"] is True
    if os.name == "nt":
        assert ran and str(FakeProc.pid) in ran[0], "the pid must reach the kill command"
    else:
        assert signalled == [FakeProc.pid], "the process must be signalled directly"


def test_stop_ignores_another_projects_job(client, project, tmp_path, monkeypatch):
    other = tmp_path / "other"
    other.mkdir()

    class FakeProc:
        pid = 6001

        def poll(self):
            return None

    killed = []
    monkeypatch.setattr(plugin_api, "JOBS", {
        "j1": {"proc": FakeProc(), "argv": ["workflow", "resume", "abc123"], "cwd": str(other)}
    })
    monkeypatch.setattr(
        plugin_api.subprocess, "run",
        lambda argv, **kwargs: killed.append(argv) or type("R", (), {"returncode": 0})(),
    )
    plugin_api.ACTIVE_RUNS.clear()

    body = client.post(
        f"{PREFIX}/workflows/speckit/runs/abc123/stop", json={"cwd": str(project), "answers": {}}
    ).json()
    assert body["stopped"] is False, "a run in another project must not be killed"
    assert killed == []


def test_questions_come_from_clarification_markers(client, project):
    spec = project / ".specify" / "specs" / "001-demo" / "spec.md"
    spec.write_text(
        "# Spec\n- [NEEDS CLARIFICATION: which auth?]\n- [NEEDS CLARIFICATION: how many users?]\n",
        encoding="utf-8",
    )
    body = client.get(
        f"{PREFIX}/questions", params={"cwd": str(project), "path": ".specify/specs/001-demo/spec.md"}
    ).json()
    assert body["count"] == 2
    assert body["questions"][0]["text"] == "which auth?"
    assert body["questions"][1]["index"] == 1


def test_answer_writes_back_and_leaves_unanswered_markers(client, project):
    spec = project / ".specify" / "specs" / "001-demo" / "spec.md"
    spec.write_text(
        "# Spec\n- [NEEDS CLARIFICATION: which auth?]\n- [NEEDS CLARIFICATION: how many users?]\n",
        encoding="utf-8",
    )
    body = client.post(
        f"{PREFIX}/clarify",
        json={
            "cwd": str(project),
            "path": ".specify/specs/001-demo/spec.md",
            "answers": {"0": "Email and password"},
        },
    ).json()
    assert body["answered"] == 1
    assert body["remaining"] == 1
    assert "Email and password" in body["content"]
    assert "which auth?" not in body["content"]
    assert "how many users?" in body["content"], "an unanswered marker must survive"


def test_questions_refuse_paths_outside_the_project(client, project):
    response = client.get(
        f"{PREFIX}/questions", params={"cwd": str(project), "path": "../../secrets.txt"}
    )
    assert response.status_code == 400


def test_log_tails_the_newest_job_for_this_project(client, project, tmp_path, monkeypatch):
    log = tmp_path / "job.log"
    log.write_text("line one\nline two\n", encoding="utf-8")

    class FakeProc:
        def poll(self):
            return None

    monkeypatch.setattr(plugin_api, "JOBS", {
        "j1": {"proc": FakeProc(), "argv": ["workflow", "run"], "cwd": str(project), "log": str(log), "started_at": 1.0}
    })
    body = client.get(f"{PREFIX}/log", params={"cwd": str(project)}).json()
    assert body["running"] is True
    assert "line two" in body["output"]


def test_log_ignores_other_projects(client, project, tmp_path, monkeypatch):
    other = tmp_path / "other"
    other.mkdir()
    log = tmp_path / "other.log"
    log.write_text("secret other output", encoding="utf-8")

    class FakeProc:
        def poll(self):
            return None

    monkeypatch.setattr(plugin_api, "JOBS", {
        "j1": {"proc": FakeProc(), "argv": ["workflow", "run"], "cwd": str(other), "log": str(log), "started_at": 1.0}
    })
    body = client.get(f"{PREFIX}/log", params={"cwd": str(project)}).json()
    assert body["running"] is False
    assert body["output"] == ""


def test_runs_are_listed_newest_first(client, project):
    runs = project / ".specify" / "workflows" / "runs"
    for name, spec, status in (("aaa", "first feature", "completed"), ("bbb", "second feature", "paused")):
        folder = runs / name
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "state.json").write_text(
            json.dumps({"workflow_id": "speckit", "status": status, "current_step_id": "plan",
                        "inputs": {"spec": spec}}),
            encoding="utf-8",
        )
    body = client.get(f"{PREFIX}/workflows/speckit/runs", params={"cwd": str(project)}).json()
    assert body["count"] >= 2
    assert body["runs"][0]["summary"] in {"first feature", "second feature"}
    assert {run["status"] for run in body["runs"]} >= {"completed", "paused"}


INTEGRATION_SRC = (
    "    def build_exec_args(self, prompt, *, model=None, output_json=True,\n"
    "                        integration_args=None, integration_options=None, project_root=None):\n"
    '        args = [self._resolve_executable(), "chat", "-Q"]\n'
    '        if prompt.startswith("/"):\n'
    '            command, _, remainder = prompt[1:].partition(" ")\n'
    "            if command:\n"
    '                args.extend(["-s", command])\n'
    "        return args\n"
)


def test_integration_health_reports_an_unpatched_copy(tmp_path, monkeypatch):
    copy = tmp_path / "hermes" / "__init__.py"
    copy.parent.mkdir(parents=True)
    copy.write_text(INTEGRATION_SRC, encoding="utf-8")
    monkeypatch.setattr(plugin_api, "_integration_files", lambda: [copy])

    health = plugin_api._integration_health()
    assert health["checked"] == 1
    assert health["patched"] is False


def test_integration_repair_adds_the_working_directory(client, tmp_path, monkeypatch):
    copy = tmp_path / "hermes" / "__init__.py"
    copy.parent.mkdir(parents=True)
    copy.write_text(INTEGRATION_SRC, encoding="utf-8")
    monkeypatch.setattr(plugin_api, "_integration_files", lambda: [copy])

    body = client.post(f"{PREFIX}/integration/repair").json()
    assert body["patched"] is True
    assert str(copy) in body["repaired"]
    text = copy.read_text(encoding="utf-8")
    assert 'args.extend(["--in", str(Path(project_root).resolve())])' in text
    assert 'args = [self._resolve_executable(), "chat", "-Q"]' in text, "the anchor must survive"
    assert 'command = command.replace(".", "-")' in text, "dotted command names must become skill names"
    assert 'command, _, remainder = prompt[1:].partition(" ")' in text


def test_integration_health_names_which_fix_is_missing(tmp_path, monkeypatch):
    copy = tmp_path / "hermes" / "__init__.py"
    copy.parent.mkdir(parents=True)
    # The project fix only.
    copy.write_text(INTEGRATION_SRC.replace(
        '        args = [self._resolve_executable(), "chat", "-Q"]\n',
        '        args = [self._resolve_executable(), "chat", "-Q"]\n'
        '        # Run the agent inside the project.\n'
        '        if project_root is not None:\n'
        '            args.extend(["--in", str(Path(project_root).resolve())])\n',
    ), encoding="utf-8")
    monkeypatch.setattr(plugin_api, "_integration_files", lambda: [copy])

    health = plugin_api._integration_health()
    assert health["patched"] is False
    assert health["copies"][0]["project_patch"] is True
    assert health["copies"][0]["skill_patch"] is False

    applied = plugin_api._patch_integration_file(copy)
    assert applied == ["skill"], "only the missing fix is applied"
    assert plugin_api._integration_health()["patched"] is True


def test_integration_repair_is_idempotent(client, tmp_path, monkeypatch):
    copy = tmp_path / "hermes" / "__init__.py"
    copy.parent.mkdir(parents=True)
    copy.write_text(INTEGRATION_SRC, encoding="utf-8")
    monkeypatch.setattr(plugin_api, "_integration_files", lambda: [copy])

    client.post(f"{PREFIX}/integration/repair")
    second = client.post(f"{PREFIX}/integration/repair").json()
    assert second["repaired"] == []
    assert second["patched"] is True
    assert copy.read_text(encoding="utf-8").count("--in") == 1


def test_shaping_twice_writes_once_and_keeps_no_backup(client, project):
    first = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "full"}).json()
    assert first["changed"] is True
    assert first["backup"] is not None, "the generated file it replaced is kept"
    assert "constitution" in first["steps"]

    second = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "full"}).json()
    assert second["changed"] is False
    assert second["backup"] is None, "nothing written, so nothing to back up"


def test_shaping_keeps_a_hand_edited_workflow_as_a_backup(client, project):
    workflow = project / ".specify" / "workflows" / "speckit" / "workflow.yml"
    workflow.write_text("# my own workflow\nsteps:\n  - id: mine\n", encoding="utf-8")

    body = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "short"}).json()
    assert body["changed"] is True
    backup = Path(body["backup"])
    assert backup.is_file()
    assert "# my own workflow" in backup.read_text(encoding="utf-8"), "the user's version survives"


def test_artifact_write_conflict_returns_the_winning_copy(client, project):
    spec = project / ".specify" / "specs" / "001-demo" / "spec.md"
    spec.write_text("# theirs\n", encoding="utf-8")

    # no base_mtime for a file that exists: the pane never loaded it
    first = client.put(
        f"{PREFIX}/artifact",
        json={"cwd": str(project), "path": ".specify/specs/001-demo/spec.md", "content": "# mine\n"},
    )
    assert first.status_code == 409
    detail = first.json()["detail"]
    assert detail["conflict"] is True
    assert detail["content"] == "# theirs\n", "the pane needs the current text to offer a choice"
    assert isinstance(detail["mtime"], int)

    stale = client.put(
        f"{PREFIX}/artifact",
        json={
            "cwd": str(project),
            "path": ".specify/specs/001-demo/spec.md",
            "content": "# mine\n",
            "base_mtime": 1,
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["conflict"] is True


def test_artifact_write_succeeds_with_the_current_mtime(client, project):
    spec = project / ".specify" / "specs" / "001-demo" / "spec.md"
    spec.write_text("# theirs\n", encoding="utf-8")
    current = int(spec.stat().st_mtime * 1000)

    body = client.put(
        f"{PREFIX}/artifact",
        json={
            "cwd": str(project),
            "path": ".specify/specs/001-demo/spec.md",
            "content": "# mine\n",
            "base_mtime": current,
        },
    ).json()
    assert body["bytes"] == len("# mine\n")
    assert spec.read_text(encoding="utf-8") == "# mine\n"


def test_short_path_does_not_ask_for_clarify(client, project):
    body = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "short"}).json()
    assert "clarify" not in body["steps"]
    workflow = (project / ".specify" / "workflows" / "speckit" / "workflow.yml").read_text(encoding="utf-8")
    assert "  focus:" not in workflow, "a step that will not run must not ask a question"
    assert "id: clarify" not in workflow


def test_full_path_asks_for_clarify(client, project):
    client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "full"})
    workflow = (project / ".specify" / "workflows" / "speckit" / "workflow.yml").read_text(encoding="utf-8")
    assert "  focus:" in workflow
    assert "id: clarify" in workflow


def test_every_gate_has_a_declared_verdict_input(client, project):
    client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "full"})
    workflow = (project / ".specify" / "workflows" / "speckit" / "workflow.yml").read_text(encoding="utf-8")
    declared = {
        line.split(":")[0].strip()
        for line in workflow.splitlines()
        if line.startswith("  ") and not line.startswith("    ") and line.rstrip().endswith(":")
    }
    gates = [
        line.split("gate_review_")[1].strip()
        for line in workflow.splitlines()
        if "verdict_input: gate_review_" in line
    ]
    assert gates, "the shaped workflow should contain gates"
    for key in gates:
        assert f"gate_review_{key}" in declared, f"{key} is used by a gate but not declared as an input"


def test_a_ratified_constitution_is_not_run_again(client, project):
    memory = project / ".specify" / "memory"
    memory.mkdir(parents=True, exist_ok=True)
    (memory / "constitution.md").write_text(
        "# Demo Constitution\n\n## Core Principles\n\n### I. Security First\nValidate input.\n",
        encoding="utf-8",
    )
    body = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "full"}).json()
    assert body["constitution"] is False
    assert "constitution" not in body["steps"], "once per project, not once per feature"
    workflow = (project / ".specify" / "workflows" / "speckit" / "workflow.yml").read_text(encoding="utf-8")
    assert "  principles:" not in workflow, "no constitution step, so no principles question"


def test_an_unratified_constitution_still_runs(client, project):
    memory = project / ".specify" / "memory"
    memory.mkdir(parents=True, exist_ok=True)
    (memory / "constitution.md").write_text(
        "# [PROJECT_NAME] Constitution\n\n### [PRINCIPLE_1_NAME]\n[PRINCIPLE_1_DESCRIPTION]\n",
        encoding="utf-8",
    )
    body = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "short"}).json()
    assert body["constitution"] is True
    assert body["steps"][0] == "constitution"


def test_repair_leaves_other_processes_alone(client, project):
    """Adding the bug extension must not graft the SDD constitution onto bugfix."""
    bugfix = project / ".specify" / "workflows" / "bugfix"
    bugfix.mkdir(parents=True)
    original = (
        'schema_version: "1.0"\n'
        "workflow:\n  id: bugfix\n"
        "inputs:\n  report:\n    type: string\n"
        "steps:\n"
        "  - id: assess\n    command: speckit.bug.assess\n"
        "  - id: review-assessment\n    type: gate\n    message: Review\n    options: [approve, reject]\n"
    )
    (bugfix / "workflow.yml").write_text(original, encoding="utf-8")

    client.post(f"{PREFIX}/repair-workflows", json={"cwd": str(project)})

    after = (bugfix / "workflow.yml").read_text(encoding="utf-8")
    assert "id: constitution" not in after
    assert "principles" not in after
    assert "verdict_input: gate_review_assessment" in after, "the gate is still made answerable"


class ParkedProc:
    """A dispatched process that has not exited yet."""

    def __init__(self):
        self.pid = 4242
        self.killed = False
        self.alive = True

    def poll(self):
        return None if self.alive else 0

    def kill(self):
        self.killed = True
        self.alive = False


def test_resume_takes_over_a_run_that_is_still_parked(client, project, cli):
    """The parked CLI can outlive the pause by a moment; answering must not 409."""
    run_dir = project / ".specify" / "workflows" / "runs" / "parked1"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "state.json").write_text(json.dumps({"status": "paused"}), encoding="utf-8")

    proc = ParkedProc()
    plugin_api.ACTIVE_RUNS[plugin_api._active_key(project, "speckit")] = {"proc": proc, "run_id": "parked1", "kind": "run"}
    try:
        response = client.post(
            f"{PREFIX}/workflows/speckit/runs/parked1/resume",
            json={"cwd": str(project), "answers": {"gate_review_spec": "approve"}},
        )
        assert response.status_code == 200, response.text
        assert proc.killed is True, "the parked process is stopped before the resume runs"
    finally:
        plugin_api.ACTIVE_RUNS.clear()


def test_resume_still_refuses_a_run_that_is_executing(client, project, cli):
    run_dir = project / ".specify" / "workflows" / "runs" / "busy1"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "state.json").write_text(json.dumps({"status": "running"}), encoding="utf-8")

    plugin_api.ACTIVE_RUNS[plugin_api._active_key(project, "speckit")] = {"proc": ParkedProc(), "run_id": "busy1", "kind": "run"}
    try:
        response = client.post(
            f"{PREFIX}/workflows/speckit/runs/busy1/resume",
            json={"cwd": str(project), "answers": {"gate_review_spec": "approve"}},
        )
        assert response.status_code == 409
    finally:
        plugin_api.ACTIVE_RUNS.clear()


def test_dotted_commands_get_a_skill_of_that_exact_name(tmp_path, monkeypatch):
    """`-s speckit.bug.fix` needs a skill named that, or Hermes aborts the step."""
    ext = tmp_path / "proj" / ".specify" / "extensions" / "bug"
    (ext / "commands").mkdir(parents=True)
    (ext / "commands" / "speckit.bug.fix.md").write_text("# Apply the fix\nDo the thing.\n", encoding="utf-8")
    (ext / "extension.yml").write_text(
        "schema_version: \"1.0\"\n"
        "extension:\n  id: bug\n  name: Bug\n"
        "provides:\n  commands:\n"
        "    - name: speckit.bug.fix\n      file: commands/speckit.bug.fix.md\n"
        "      description: Apply the remediation\n"
        "    - name: plain\n      file: commands/plain.md\n",
        encoding="utf-8",
    )
    skills = tmp_path / "skills"
    skills.mkdir()
    monkeypatch.setattr(plugin_api, "_profile_skills_dir", lambda: skills)

    written = plugin_api._sync_command_aliases(tmp_path / "proj")
    assert len(written) == 1, "only dotted command names need an alias"
    alias = skills / "speckit.bug.fix" / "SKILL.md"
    assert alias.is_file()
    text = alias.read_text(encoding="utf-8")
    assert "name: speckit.bug.fix" in text
    assert "Do the thing." in text, "the alias must carry the command's own instructions"
    assert not (skills / "plain").exists()

    again = plugin_api._sync_command_aliases(tmp_path / "proj")
    assert again == written, "re-syncing is stable"


def test_every_generated_command_step_passes_text():
    """Empty args make the integration drop -q, and the CLI then opens a TUI."""
    docs = [("speckit", plugin_api._workflow_yaml("short")), ("speckit", plugin_api._workflow_yaml("full"))]
    docs += [(pid, plugin_api._process_yaml(pid)) for pid in plugin_api.PROCESS_SPECS]

    for name, text in docs:
        doc = yaml.safe_load(text)
        for step in doc["steps"]:
            if step.get("type", "command") != "command":
                continue
            args = (step.get("input") or {}).get("args")
            assert isinstance(args, str) and args.strip(), f"{name}:{step['id']} would dispatch with no prompt"


def test_optional_inputs_carry_a_default_so_they_are_never_empty():
    doc = yaml.safe_load(plugin_api._workflow_yaml("full", True))
    for name, spec in doc["inputs"].items():
        if spec.get("required") is True:
            continue
        if name.startswith("gate_") or name == "integration":
            continue
        assert spec.get("default"), f"{name} is optional but has no default"


def _write_run(project, run_id, workflow_id, status="completed", mtime_offset=0.0):
    import os
    import time

    directory = project / ".specify" / "workflows" / "runs" / run_id
    directory.mkdir(parents=True, exist_ok=True)
    state = {"run_id": run_id, "workflow_id": workflow_id, "status": status,
             "current_step_id": "review-test", "step_results": {}}
    path = directory / "state.json"
    path.write_text(json.dumps(state), encoding="utf-8")
    stamp = time.time() + mtime_offset
    os.utime(path, (stamp, stamp))
    return path


def test_history_is_scoped_to_the_process(client, project, cli):
    _write_run(project, "speckitrun1", "speckit", mtime_offset=-30)
    _write_run(project, "bugrun1", "bug", mtime_offset=-5)

    body = client.get(f"{PREFIX}/workflows/speckit/runs", params={"cwd": str(project)}).json()
    assert "speckitrun1" in [item["run_id"] for item in body["runs"]]
    assert "bugrun1" not in [item["run_id"] for item in body["runs"]], "another process's run is not ours"

    latest = client.get(f"{PREFIX}/workflows/speckit/runs/latest", params={"cwd": str(project)}).json()
    # The fixture's own run has no workflow id, so it is allowed through; the bug
    # run is not, even though it is the newest on disk.
    assert latest["run_id"] != "bugrun1", "the newest run of a different workflow must be ignored"


def test_a_state_without_a_workflow_id_is_not_attributed_to_a_process(client, project, cli):
    _write_run(project, "orphan1", None)
    body = client.get(f"{PREFIX}/workflows/speckit/runs", params={"cwd": str(project)}).json()
    assert "orphan1" not in [item["run_id"] for item in body["runs"]]


def test_asking_about_a_known_process_before_it_is_used_does_not_404(client, project, cli):
    """Picking a process reads its latest run before Start ever shapes it."""
    latest = client.get(f"{PREFIX}/workflows/assess/runs/latest", params={"cwd": str(project)})
    assert latest.status_code == 200, latest.text
    assert latest.json()["status"] == "none"

    history = client.get(f"{PREFIX}/workflows/assess/runs", params={"cwd": str(project)})
    assert history.status_code == 200
    assert history.json()["runs"] == []

    assert (project / ".specify" / "workflows" / "assess" / "workflow.yml").is_file()


def test_an_unknown_process_is_still_a_404(client, project, cli):
    response = client.get(f"{PREFIX}/workflows/nope/runs/latest", params={"cwd": str(project)})
    assert response.status_code == 404
    assert "no such process" in response.json()["detail"]


def test_the_full_path_reviews_the_checklist_and_the_analysis(client, project):
    """Both steps produce findings nobody reads unless a gate stops the run."""
    body = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "full"}).json()
    assert "review-checklist" in body["steps"]
    assert "review-analyze" in body["steps"]

    workflow = (project / ".specify" / "workflows" / "speckit" / "workflow.yml").read_text(encoding="utf-8")
    assert "verdict_input: gate_review_checklist" in workflow
    assert "verdict_input: gate_review_analyze" in workflow
    assert "  gate_review_checklist:" in workflow
    assert "  gate_review_analyze:" in workflow


def test_the_short_path_has_no_checklist_or_analyze_gate(client, project):
    body = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "short"}).json()
    assert "review-checklist" not in body["steps"]
    assert "review-analyze" not in body["steps"]


def test_resume_does_not_kill_the_step_it_just_started(client, project, cli):
    """A gate answered seconds ago still reads "paused" on disk for a moment."""
    run_dir = project / ".specify" / "workflows" / "runs" / "fresh1"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "state.json").write_text(json.dumps({"workflow_id": "speckit", "status": "paused"}), encoding="utf-8")

    proc = ParkedProc()
    plugin_api.ACTIVE_RUNS[plugin_api._active_key(project, "speckit")] = {
        "proc": proc, "run_id": "fresh1", "kind": "resume", "started_at": time.time()
    }
    try:
        response = client.post(
            f"{PREFIX}/workflows/speckit/runs/fresh1/resume",
            json={"cwd": str(project), "answers": {"gate_review_spec": "approve"}},
        )
        assert response.status_code == 409, response.text
        assert proc.killed is False, "a step that just started must not be killed"
    finally:
        plugin_api.ACTIVE_RUNS.clear()


def test_a_fresh_run_can_be_answered_as_soon_as_it_parks(client, project, cli):
    """The grace window protects a resume, not a run that just parked."""
    run_dir = project / ".specify" / "workflows" / "runs" / "parked2"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "state.json").write_text(json.dumps({"workflow_id": "speckit", "status": "paused"}), encoding="utf-8")

    proc = ParkedProc()
    plugin_api.ACTIVE_RUNS[plugin_api._active_key(project, "speckit")] = {
        "proc": proc, "run_id": "parked2", "kind": "run", "started_at": time.time()
    }
    try:
        response = client.post(
            f"{PREFIX}/workflows/speckit/runs/parked2/resume",
            json={"cwd": str(project), "answers": {"gate_review_spec": "approve"}},
        )
        assert response.status_code == 200, response.text
    finally:
        plugin_api.ACTIVE_RUNS.clear()


def test_a_gate_carries_the_output_of_the_step_it_reviews(client, project, cli):
    """`analyze` writes no artifact; its findings are the command output."""
    # The gate is matched against the workflow's own step order, so shape the
    # full path first (it is the one that contains analyze).
    client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "full"})
    run_dir = project / ".specify" / "workflows" / "runs" / "gate1"
    run_dir.mkdir(parents=True, exist_ok=True)
    state = {
        "workflow_id": "speckit",
        "status": "paused",
        "current_step_id": "review-analyze",
        "step_results": {
            "analyze": {"type": "command", "status": "completed",
                        "output": {"stdout": "Two findings: plan and tasks disagree on scope."}},
            "review-analyze": {"type": "gate", "status": "paused",
                               "output": {"message": "Review the findings", "options": ["approve", "reject"]}},
        },
    }
    (run_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")

    view = client.get(f"{PREFIX}/workflows/speckit/runs/gate1", params={"cwd": str(project)}).json()
    gate = view["gate"]
    assert gate["reviewed_step"] == "analyze"
    assert "Two findings" in gate["reviewed_stdout"]


def test_clarification_markers_do_not_backtrack_on_long_space_runs(client, project, cli):
    """Two overlapping quantifiers made matching quadratic; the regex no longer has them."""
    artifact = project / ".specify" / "specs" / "001-demo" / "spec.md"
    artifact.write_text("[NEEDS CLARIFICATION:" + " " * 20000 + "x]\n", encoding="utf-8")

    started = time.time()
    body = client.get(f"{PREFIX}/questions", params={"cwd": str(project), "path": ".specify/specs/001-demo/spec.md"}).json()
    elapsed = time.time() - started
    assert body["count"] == 1
    assert body["questions"][0]["text"] == "x"
    assert elapsed < 1.0, f"matching took {elapsed:.2f}s on 20k spaces"


def test_workflow_parse_errors_do_not_leak_internals(client, tmp_path):
    root = tmp_path / "proj"
    wf = root / ".specify" / "workflows" / "broken"
    wf.mkdir(parents=True)
    (wf / "workflow.yml").write_text("workflow: [unclosed\n", encoding="utf-8")

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    assert body["errors"], "a broken workflow is still reported"
    message = body["errors"][0]["error"]
    assert message == "workflow could not be parsed"
    assert "line" not in message.lower() and "yaml" not in message.lower()


def test_marker_parsing_is_literal_and_survives_bad_input():
    text = "A [NEEDS CLARIFICATION: which store?] B [NEEDS CLARIFICATION: which host?]"
    bodies = [body.strip() for _, _, body in plugin_api.clarification_markers(text)]
    assert bodies == ["which store?", "which host?"]

    # No closing bracket anywhere: nothing is returned, and it returns immediately.
    unterminated = "[NEEDS CLARIFICATION:" + " " * 50000
    started = time.time()
    assert plugin_api.clarification_markers(unterminated) == []
    assert time.time() - started < 0.5


def test_answering_questions_replaces_only_the_answered_marker(client, project, cli):
    artifact = project / ".specify" / "specs" / "001-demo" / "spec.md"
    artifact.write_text(
        "# Spec\n[NEEDS CLARIFICATION: which store?]\nKeep this.\n[NEEDS CLARIFICATION: which host?]\n",
        encoding="utf-8",
    )
    body = client.post(
        f"{PREFIX}/clarify",
        json={"cwd": str(project), "path": ".specify/specs/001-demo/spec.md", "answers": {"0": "SQLite"}},
    ).json()
    assert body["answered"] == 1
    assert body["remaining"] == 1
    assert "SQLite" in body["content"]
    assert "Keep this." in body["content"]
    assert "[NEEDS CLARIFICATION: which host?]" in body["content"]


def test_answering_an_old_gate_does_not_kill_a_newer_run(client, project, cli):
    old = project / ".specify" / "workflows" / "runs" / "older1"
    old.mkdir(parents=True, exist_ok=True)
    (old / "state.json").write_text(json.dumps({"workflow_id": "speckit", "status": "paused"}), encoding="utf-8")

    proc = ParkedProc()
    plugin_api.ACTIVE_RUNS[plugin_api._active_key(project, "speckit")] = {
        "proc": proc, "run_id": "newer2", "kind": "run", "started_at": time.time() - 600
    }
    try:
        response = client.post(
            f"{PREFIX}/workflows/speckit/runs/older1/resume",
            json={"cwd": str(project), "answers": {"gate_review_spec": "approve"}},
        )
        assert response.status_code == 409, response.text
        assert proc.killed is False, "a different run must not be killed"
    finally:
        plugin_api.ACTIVE_RUNS.clear()


def test_an_allowlist_that_names_nothing_denies_everything(client, project, cli, monkeypatch):
    # Only separators: configured, with no usable entry.
    monkeypatch.setenv("SPECKIT_ALLOWED_ROOTS", os.pathsep.join(["", "", ""]))
    response = client.get(f"{PREFIX}/processes", params={"cwd": str(project)})
    assert response.status_code == 403
    assert "names no directory" in response.json()["detail"]


def test_an_unset_allowlist_restricts_nothing(client, project, cli, monkeypatch):
    monkeypatch.delenv("SPECKIT_ALLOWED_ROOTS", raising=False)
    assert client.get(f"{PREFIX}/processes", params={"cwd": str(project)}).status_code == 200


def test_the_reviewed_step_is_the_one_before_the_gate(client, project, cli):
    """A gate after a non-command step must not borrow an earlier command's output."""
    wf = project / ".specify" / "workflows" / "custom"
    wf.mkdir(parents=True, exist_ok=True)
    (wf / "workflow.yml").write_text(
        'schema_version: "1.0"\n'
        "workflow:\n  id: custom\n  name: Custom\n"
        "steps:\n"
        "  - id: analyze\n    command: speckit.analyze\n"
        "  - id: wait\n    type: gate\n    message: intermediate\n    options: [approve, reject]\n"
        "  - id: other\n    command: speckit.tasks\n"
        "  - id: review-other\n    type: gate\n    message: Review tasks\n    options: [approve, reject]\n",
        encoding="utf-8",
    )
    run_dir = project / ".specify" / "workflows" / "runs" / "order1"
    run_dir.mkdir(parents=True, exist_ok=True)
    state = {
        "workflow_id": "custom",
        "status": "paused",
        "current_step_id": "review-other",
        "step_results": {
            "analyze": {"type": "command", "status": "completed", "output": {"stdout": "analysis findings"}},
            "wait": {"type": "gate", "status": "completed", "output": {"choice": "approve"}},
            "other": {"type": "command", "status": "completed", "output": {"stdout": "task list"}},
            "review-other": {"type": "gate", "status": "paused", "output": {"message": "Review tasks"}},
        },
    }
    (run_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")

    view = client.get(f"{PREFIX}/workflows/custom/runs/order1", params={"cwd": str(project)}).json()
    gate = view["gate"]
    assert gate["reviewed_step"] == "other"
    assert gate["reviewed_stdout"] == "task list"


def _long_run(project, run_id, stdout_len=12000):
    run_dir = project / ".specify" / "workflows" / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    body = "FINDING-ONE: " + ("x" * (stdout_len - 20)) + "TAIL-END"
    state = {
        "workflow_id": "speckit",
        "status": "paused",
        "current_step_id": "review-analyze",
        "step_results": {
            "analyze": {"type": "command", "status": "completed", "output": {"stdout": body, "stderr": "err: tail"}},
            "review-analyze": {"type": "gate", "status": "paused", "output": {"message": "Review findings"}},
        },
    }
    (run_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
    return body


def test_a_gate_says_when_its_preview_is_a_tail(client, project, cli):
    client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "full"})
    body = _long_run(project, "long1")

    gate = client.get(f"{PREFIX}/workflows/speckit/runs/long1", params={"cwd": str(project)}).json()["gate"]
    assert gate["reviewed_truncated"] is True
    assert gate["reviewed_stdout_bytes"] == len(body)
    assert "FINDING-ONE" not in gate["reviewed_stdout"], "the preview is the tail, by design"
    assert gate["reviewed_stdout"].endswith("TAIL-END")


def test_the_complete_stream_is_available_for_a_truncated_gate(client, project, cli):
    client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "full"})
    body = _long_run(project, "long2")

    response = client.get(
        f"{PREFIX}/workflows/speckit/runs/long2/output",
        params={"cwd": str(project), "step": "analyze"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["stdout"] == body, "the beginning is what the preview was missing"
    assert payload["truncated"] is False
    assert payload["stderr"] == "err: tail"


def test_output_for_an_unknown_step_is_a_404(client, project, cli):
    _long_run(project, "long3")
    response = client.get(
        f"{PREFIX}/workflows/speckit/runs/long3/output",
        params={"cwd": str(project), "step": "nope"},
    )
    assert response.status_code == 404


def test_browse_honours_an_allowlist(client, tmp_path, monkeypatch):
    inside = tmp_path / "work" / "project-a"
    inside.mkdir(parents=True)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    monkeypatch.setenv("SPECKIT_ALLOWED_ROOTS", str(tmp_path / "work"))

    top = client.get(f"{PREFIX}/browse").json()
    assert [entry["path"] for entry in top["entries"]] == [str((tmp_path / "work").resolve())], \
        "a configured ceiling replaces the drive and home listings"

    listed = client.get(f"{PREFIX}/browse", params={"path": str(inside)})
    assert listed.status_code == 200, listed.text
    assert listed.json()["parent"] == str((tmp_path / "work").resolve()), "the ceiling itself is reachable"

    # ...but the ceiling's own parent is not offered.
    at_root = client.get(f"{PREFIX}/browse", params={"path": str(tmp_path / "work")}).json()
    assert at_root["parent"] is None, "do not offer a step outside the ceiling"

    refused = client.get(f"{PREFIX}/browse", params={"path": str(outside)})
    assert refused.status_code == 403, refused.text


def test_browse_is_unrestricted_when_no_allowlist_is_set(client, monkeypatch, tmp_path):
    monkeypatch.delenv("SPECKIT_ALLOWED_ROOTS", raising=False)
    top = client.get(f"{PREFIX}/browse").json()
    assert top["entries"], "no ceiling means the usual roots"


SHIPPED = """\
schema_version: "1.0"
workflow:
  id: "speckit"
  name: "Shipped"
  version: "1.0.2"
inputs:
  spec:
    type: string
    required: true
  gate_review_spec:
    type: string
    required: false
steps:
  - id: specify
    command: speckit.specify
    input:
      args: "{{ inputs.spec }}"
  - id: review-spec
    type: gate
    message: "Review"
    options: [approve, reject]
    verdict_input: gate_review_spec
"""


def _write_state(project, run_id, results, workflow_id="speckit", current_step_id=None):
    run_dir = project / ".specify" / "workflows" / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "state.json").write_text(
        json.dumps({
            "workflow_id": workflow_id,
            "status": "paused",
            "current_step_id": current_step_id,
            "step_results": results,
        }),
        encoding="utf-8",
    )


def test_output_for_another_process_run_is_refused(client, project, cli):
    client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "full"})
    _write_state(
        project,
        "bugrun",
        {"assess": {"type": "command", "status": "completed", "output": {"stdout": "bug output"}}},
        workflow_id="bug",
    )

    response = client.get(
        f"{PREFIX}/workflows/speckit/runs/bugrun/output",
        params={"cwd": str(project), "step": "assess"},
    )
    assert response.status_code == 404, "the runs directory is shared; the process must match"
    assert "does not belong" in response.text


def test_the_cap_applies_to_both_streams_together(client, project, cli, monkeypatch):
    monkeypatch.setattr(plugin_api, "STEP_OUTPUT_MAX_BYTES", 1000)
    _write_state(
        project,
        "bigrun",
        {"analyze": {"type": "command", "status": "completed", "output": {"stdout": "o" * 4000, "stderr": "e" * 4000}}},
    )

    payload = client.get(
        f"{PREFIX}/workflows/speckit/runs/bigrun/output",
        params={"cwd": str(project), "step": "analyze"},
    ).json()

    served = len(payload["stdout"].encode()) + len(payload["stderr"].encode())
    assert served <= 1000, f"served {served} bytes against a 1000 byte cap"
    assert payload["truncated"] is True
    assert payload["stdout_bytes"] == 4000


def test_byte_counts_are_bytes_not_characters(client, project, cli, monkeypatch):
    monkeypatch.setattr(plugin_api, "REVIEWED_STDOUT_PREVIEW", 1000)
    client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(project), "mode": "full"})
    text = "é" * 2000  # two bytes each
    _write_state(
        project,
        "unicoderun",
        {
            "analyze": {"type": "command", "status": "completed", "output": {"stdout": text}},
            "review-analyze": {"type": "gate", "status": "paused"},
        },
        current_step_id="review-analyze",
    )

    gate = client.get(
        f"{PREFIX}/workflows/speckit/runs/unicoderun", params={"cwd": str(project)}
    ).json()["gate"]
    assert gate["reviewed_stdout_bytes"] == 4000
    assert len(gate["reviewed_stdout"].encode()) <= 1000
    assert gate["reviewed_truncated"] is True


def test_browsing_beneath_a_filesystem_root_is_allowed(client, tmp_path, monkeypatch):
    # The bug: "/" plus a separator is "//", so every descendant of a root was refused.
    root = tmp_path.anchor
    monkeypatch.setenv("SPECKIT_ALLOWED_ROOTS", root)

    response = client.get(f"{PREFIX}/browse", params={"path": str(tmp_path)})
    assert response.status_code == 200, response.text
    assert response.json()["path"] == str(tmp_path.resolve())


def test_init_installs_our_workflows_with_answerable_gates(client, tmp_path, monkeypatch):
    """A fresh project must not start with gates it cannot answer."""
    bare = tmp_path / "fresh"
    bare.mkdir()

    def fake_init(args, cwd, timeout):
        # the real CLI creates .specify; the stub has to stand in for that
        (Path(cwd) / ".specify").mkdir(parents=True, exist_ok=True)
        return {"ok": True, "exit_code": 0, "payload": None, "output": "", "stderr": ""}

    monkeypatch.setattr(plugin_api, "_run_specify", fake_init)

    body = client.post(f"{PREFIX}/init", json={"cwd": str(bare)}).json()

    assert set(body["workflows_installed"]) == {"speckit", "bugfix", "assess"}, \
        "every bundled workflow must be copied in, not merely some"
    assert body["workflows_patched"] == [], "a bundled gate must already be answerable"

    workflow = bare / ".specify" / "workflows" / "speckit" / "workflow.yml"
    doc = yaml.safe_load(workflow.read_text(encoding="utf-8"))
    gates = [step for step in doc["steps"] if step.get("type") == "gate"]
    assert [g["id"] for g in gates] == ["review-spec", "review-plan"], "a gate went missing"
    for gate in gates:
        assert gate.get("verdict_input") in doc["inputs"], f"{gate['id']} cannot be answered"


def test_the_bundle_is_read_from_the_installed_layout(client, tmp_path, monkeypatch):
    """`_bundle_dir` must point beside dashboard/, which is where the installer puts it."""
    plugin_root = tmp_path / "hermes" / "plugins" / "spec-kit-hermes"
    (plugin_root / "dashboard").mkdir(parents=True)
    (plugin_root / "workflows" / "speckit").mkdir(parents=True)
    (plugin_root / "workflows" / "speckit" / "workflow.yml").write_text(SHIPPED, encoding="utf-8")

    project = tmp_path / "proj"
    (project / ".specify").mkdir(parents=True)

    monkeypatch.setattr(plugin_api, "_bundle_dir", lambda: plugin_root / "workflows")
    installed, failed = plugin_api._install_bundled_workflows(project)

    assert installed == ["speckit"]
    assert failed == []
    assert (project / ".specify" / "workflows" / "speckit" / "workflow.yml").read_text(encoding="utf-8") == SHIPPED


def test_a_failed_write_leaves_no_file_and_is_reported(client, tmp_path, monkeypatch):
    """A half-written workflow would be skipped forever by the exists() guard."""
    bundle = tmp_path / "bundle" / "speckit"
    bundle.mkdir(parents=True)
    (bundle / "workflow.yml").write_text(SHIPPED, encoding="utf-8")
    project = tmp_path / "p"
    (project / ".specify").mkdir(parents=True)

    def refuse(target, text):
        raise OSError("disk full")

    monkeypatch.setattr(plugin_api, "_bundle_dir", lambda: tmp_path / "bundle")
    monkeypatch.setattr(plugin_api, "_write_text_atomic", refuse)

    installed, failed = plugin_api._install_bundled_workflows(project)

    assert installed == []
    assert failed == ["speckit"], "a failed install must be reported, not swallowed"
    assert not (project / ".specify" / "workflows" / "speckit" / "workflow.yml").exists()


def test_a_missing_bundle_installs_nothing_rather_than_crashing(client, tmp_path, monkeypatch):
    project = tmp_path / "p2"
    (project / ".specify").mkdir(parents=True)
    monkeypatch.setattr(plugin_api, "_bundle_dir", lambda: tmp_path / "nowhere")
    assert plugin_api._install_bundled_workflows(project) == ([], [])


def test_init_leaves_an_existing_workflow_alone(client, project, monkeypatch):
    (project / ".specify").mkdir(exist_ok=True)
    sentinel = project / ".specify" / "workflows" / "speckit" / "workflow.yml"
    original = sentinel.read_text(encoding="utf-8")

    installed, failed = plugin_api._install_bundled_workflows(project)

    assert "speckit" not in installed
    assert failed == [], "the project's own copy is the user's"
    assert sentinel.read_text(encoding="utf-8") == original


def test_shaping_creates_a_workflow_that_was_never_installed(client, tmp_path):
    root = tmp_path / "empty-despite-specify"
    (root / ".specify").mkdir(parents=True)

    response = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(root), "mode": "short"})

    assert response.status_code == 200, response.text
    doc = yaml.safe_load((root / ".specify" / "workflows" / "speckit" / "workflow.yml").read_text(encoding="utf-8"))
    for gate in [s for s in doc["steps"] if s.get("type") == "gate"]:
        assert gate.get("verdict_input") in doc["inputs"]


def test_the_extension_endpoint_accepts_the_process_id(client, project, monkeypatch):
    """The pane knows the process as `bugfix`; the extension it installs is `bug`."""
    calls = []
    monkeypatch.setattr(
        plugin_api,
        "_run_specify",
        lambda args, cwd, timeout: calls.append(args) or {"ok": True, "exit_code": 0, "payload": None, "output": "", "stderr": ""},
    )

    for sent in ("bugfix", "bug"):
        response = client.post(f"{PREFIX}/extensions/install", json={"cwd": str(project), "id": sent})
        assert response.status_code == 200, f"{sent} was refused: {response.text}"
        assert response.json()["extension"] == "bug"

    assert calls == [["extension", "add", "bug"], ["extension", "add", "bug"]]


def test_a_core_process_is_not_reported_as_an_extension(client, project, cli):
    body = client.get(f"{PREFIX}/processes", params={"cwd": str(project)}).json()
    by_id = {item["id"]: item for item in body["processes"]}
    assert by_id["speckit"]["extension"] is None, "speckit ships in core; there is no extension to install"


def test_a_run_recorded_under_the_legacy_id_stays_visible(client, project, cli):
    """History written before the rename must not vanish from the pane."""
    _write_state(
        project,
        "legacyrun",
        {"assess": {"type": "command", "status": "completed", "output": {"stdout": "old"}}},
        workflow_id="bug",
    )

    body = client.get(f"{PREFIX}/workflows/bugfix/runs", params={"cwd": str(project)}).json()
    assert "legacyrun" in [run.get("run_id") for run in body["runs"]], f"legacy run hidden: {body}"


def test_the_legacy_spelling_cannot_start_a_second_run(client, project, monkeypatch):
    """`bug` and `bugfix` name one workflow, so the run lock must be shared."""
    class LiveProc:
        def poll(self):
            return None

        def kill(self):
            pass

    def fake_job(args, cwd, timeout=None):
        # the lock reads proc out of JOBS, so the stub has to put it there
        plugin_api.JOBS["j"] = {"proc": LiveProc(), "id": "j"}
        return {"job_id": "j", "id": "j", "pid": 0, "stdout_file": ""}

    monkeypatch.setattr(plugin_api, "_start_job", fake_job)
    monkeypatch.setattr(plugin_api, "_await_new_run", lambda root_, before, timeout=25.0: "run-x")
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()

    first = client.post(f"{PREFIX}/workflows/bugfix/run", json={"cwd": str(project), "inputs": {"report": "x"}})
    assert first.status_code == 200, first.text

    second = client.post(f"{PREFIX}/workflows/bug/run", json={"cwd": str(project), "inputs": {"report": "x"}})
    assert second.status_code == 409, f"the alias opened a second run: {second.status_code}"
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()


def test_a_second_process_cannot_start_in_one_project(client, project, monkeypatch):
    """One live run per project, which is what the README promises."""
    class LiveProc:
        def poll(self):
            return None

        def kill(self):
            pass

    def fake_job(args, cwd, timeout=None):
        plugin_api.JOBS["j"] = {"proc": LiveProc(), "id": "j"}
        return {"job_id": "j", "id": "j", "pid": 0, "stdout_file": ""}

    monkeypatch.setattr(plugin_api, "_start_job", fake_job)
    monkeypatch.setattr(plugin_api, "_await_new_run", lambda root_, before, timeout=25.0: "run-y")
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()

    first = client.post(f"{PREFIX}/workflows/bugfix/run", json={"cwd": str(project), "inputs": {"report": "x"}})
    assert first.status_code == 200, first.text

    second = client.post(f"{PREFIX}/workflows/assess/run", json={"cwd": str(project), "inputs": {"idea": "y"}})
    assert second.status_code == 409, f"a second process started alongside: {second.status_code}"
    assert "bugfix" in second.text, "the refusal should say what is already running"

    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()


def test_two_simultaneous_starts_cannot_both_dispatch(client, project, monkeypatch):
    """The check and the reservation must be one step, or a live run is stranded."""
    import threading

    entered = threading.Event()
    release = threading.Event()

    def slow_job(args, cwd, timeout=None):
        entered.set()
        assert release.wait(5), "the first start never finished"
        plugin_api.JOBS["slow"] = {"proc": None, "id": "slow"}
        return {"job_id": "slow", "id": "slow", "pid": 0, "stdout_file": ""}

    monkeypatch.setattr(plugin_api, "_start_job", slow_job)
    monkeypatch.setattr(plugin_api, "_await_new_run", lambda root_, before, timeout=25.0: "run-z")
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()

    first = {}

    def start_first():
        first["response"] = client.post(
            f"{PREFIX}/workflows/bugfix/run", json={"cwd": str(project), "inputs": {"report": "x"}}
        )

    worker = threading.Thread(target=start_first)
    worker.start()
    try:
        assert entered.wait(5), "the first start never reached the dispatcher"
        second = client.post(f"{PREFIX}/workflows/assess/run", json={"cwd": str(project), "inputs": {"idea": "y"}})
        assert second.status_code == 409, f"both starts dispatched: {second.status_code}"
    finally:
        release.set()
        worker.join(10)
        plugin_api.ACTIVE_RUNS.clear()
        plugin_api.JOBS.clear()

    assert first["response"].status_code == 200, first["response"].text


def test_a_failed_dispatch_releases_the_reservation(client, project, monkeypatch):
    def broken_job(args, cwd, timeout=None):
        raise RuntimeError("cannot spawn")

    monkeypatch.setattr(plugin_api, "_start_job", broken_job)
    plugin_api.ACTIVE_RUNS.clear()

    with pytest.raises(RuntimeError):
        client.post(f"{PREFIX}/workflows/bugfix/run", json={"cwd": str(project), "inputs": {"report": "x"}})

    assert plugin_api.ACTIVE_RUNS == {}, f"a dead dispatch left a reservation: {plugin_api.ACTIVE_RUNS}"


def test_two_simultaneous_resumes_cannot_both_dispatch(client, project, monkeypatch):
    """A pending resume is a reservation: a second answer must not dispatch."""
    import threading

    run_dir = project / ".specify" / "workflows" / "runs" / "gate1"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "state.json").write_text(json.dumps({"status": "paused"}), encoding="utf-8")

    entered = threading.Event()
    release = threading.Event()

    def slow_job(args, cwd, timeout=None):
        entered.set()
        assert release.wait(5), "the first resume never finished"
        plugin_api.JOBS["r"] = {"proc": None, "id": "r"}
        return {"job_id": "r", "id": "r", "pid": 0, "stdout_file": ""}

    monkeypatch.setattr(plugin_api, "_start_job", slow_job)
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()

    first = {}

    def answer():
        first["response"] = client.post(
            f"{PREFIX}/workflows/speckit/runs/gate1/resume",
            json={"cwd": str(project), "answers": {"gate_review_spec": "approve"}},
        )

    worker = threading.Thread(target=answer)
    worker.start()
    try:
        assert entered.wait(5), "the first resume never reached the dispatcher"
        second = client.post(
            f"{PREFIX}/workflows/speckit/runs/gate1/resume",
            json={"cwd": str(project), "answers": {"gate_review_spec": "approve"}},
        )
        assert second.status_code == 409, f"both resumes dispatched: {second.status_code}"
    finally:
        release.set()
        worker.join(10)
        plugin_api.ACTIVE_RUNS.clear()
        plugin_api.JOBS.clear()

    assert first["response"].status_code == 200, first["response"].text


def test_a_stopped_startup_does_not_overwrite_a_newer_claim(client, project, monkeypatch):
    """If the reservation is removed mid-dispatch, the late registration must not win."""
    import threading

    entered = threading.Event()
    release = threading.Event()

    def slow_job(args, cwd, timeout=None):
        entered.set()
        assert release.wait(5), "the start never finished"
        plugin_api.JOBS["s"] = {"proc": None, "id": "s"}
        return {"job_id": "s", "id": "s", "pid": 0, "stdout_file": ""}

    monkeypatch.setattr(plugin_api, "_start_job", slow_job)
    monkeypatch.setattr(plugin_api, "_await_new_run", lambda root_, before, timeout=25.0: "run-s")
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()

    outcome = {}

    def start():
        try:
            outcome["response"] = client.post(
                f"{PREFIX}/workflows/bugfix/run", json={"cwd": str(project), "inputs": {"report": "x"}}
            )
        except Exception as exc:  # the endpoint may raise before the client sees a status
            outcome["error"] = exc

    worker = threading.Thread(target=start)
    worker.start()
    try:
        assert entered.wait(5), "the start never reached the dispatcher"
        # someone else takes the slot while the first dispatch is still running
        with plugin_api.ACTIVE_LOCK:
            plugin_api.ACTIVE_RUNS.clear()
            plugin_api.ACTIVE_RUNS[plugin_api._active_key(project, "assess")] = {
                "proc": None, "run_id": "newer", "process": "assess", "kind": "run", "token": 999, "started_at": 0
            }
    finally:
        release.set()
        worker.join(10)

    entry = plugin_api.ACTIVE_RUNS.get(plugin_api._active_key(project, "assess"), {})
    assert entry.get("run_id") == "newer", f"the late registration overwrote a newer run: {entry}"
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()


def test_a_failed_answer_does_not_untrack_a_newer_run(client, project, monkeypatch):
    """The failure path may only free the slot it still owns."""
    def failing_job(args, cwd, timeout=None):
        # someone stopped this reservation and re-claimed the project meanwhile
        key = plugin_api._active_key(project, "bugfix")
        with plugin_api.ACTIVE_LOCK:
            plugin_api.ACTIVE_RUNS[key] = {
                "proc": None, "run_id": "newer", "process": "assess",
                "kind": "run", "token": 424242, "started_at": 0,
            }
        raise RuntimeError("dispatch failed")

    run_dir = project / ".specify" / "workflows" / "runs" / "gate2"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "state.json").write_text(json.dumps({"status": "paused"}), encoding="utf-8")

    monkeypatch.setattr(plugin_api, "_start_job", failing_job)
    plugin_api.ACTIVE_RUNS.clear()

    with pytest.raises(RuntimeError):
        client.post(
            f"{PREFIX}/workflows/speckit/runs/gate2/resume",
            json={"cwd": str(project), "answers": {"gate_review_spec": "approve"}},
        )

    entry = plugin_api.ACTIVE_RUNS.get(plugin_api._active_key(project, "speckit"), {})
    assert entry.get("run_id") == "newer", f"the failed answer untracked a newer run: {entry}"
    plugin_api.ACTIVE_RUNS.clear()


def test_stop_only_reaches_the_run_it_names(client, project, monkeypatch):
    """The argv fallback must match the run id, not every workflow job in the project."""
    class Proc:
        def __init__(self, pid):
            self.pid = pid
            self.killed = False

        def poll(self):
            return None

        def kill(self):
            self.killed = True

    mine, theirs = Proc(111), Proc(222)
    taskkilled = []

    class FakeRun:
        @staticmethod
        def run(argv, **kwargs):
            taskkilled.append(argv[-1])

    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()
    # no tracked entry: this is the restart case the argv fallback exists for
    plugin_api.JOBS["mine"] = {"proc": mine, "cwd": str(project), "argv": ["workflow", "resume", "run-abc"]}
    plugin_api.JOBS["theirs"] = {"proc": theirs, "cwd": str(project), "argv": ["workflow", "run", "other"]}
    monkeypatch.setattr(plugin_api.subprocess, "run", FakeRun.run)

    client.post(f"{PREFIX}/workflows/speckit/runs/run-abc/stop", json={"cwd": str(project)})

    def stopped(proc):
        return proc.killed or str(proc.pid) in taskkilled

    assert stopped(mine), "the named run was not stopped"
    assert not stopped(theirs), f"stop reached another run's process: {taskkilled}"
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()


def test_a_new_run_can_be_stopped_during_startup(client, project, monkeypatch):
    """Before the dispatcher knows the run id, a stop must still reach the job."""
    import threading

    class Proc:
        pid = 4242

        def __init__(self):
            self.killed = False
            self.alive = True

        def poll(self):
            return None if self.alive else 0

        def kill(self):
            self.killed = True
            self.alive = False

    proc = Proc()
    dispatch_returned = threading.Event()
    release = threading.Event()

    def job(args, cwd, timeout=None):
        plugin_api.JOBS["s1"] = {"proc": proc, "id": "s1", "cwd": str(cwd), "argv": args}
        dispatch_returned.set()
        return {"job_id": "s1", "id": "s1", "pid": 4242, "stdout_file": ""}

    def slow_await(root_, before, timeout=25.0):
        # the run becomes visible while the dispatcher is still waiting for it
        run_dir = project / ".specify" / "workflows" / "runs" / "fresh"
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "state.json").write_text(json.dumps({"status": "running"}), encoding="utf-8")
        assert release.wait(5), "the dispatcher never resumed"
        return "fresh"

    monkeypatch.setattr(plugin_api, "_start_job", job)
    monkeypatch.setattr(plugin_api, "_await_new_run", slow_await)
    taskkilled: list[str] = []
    monkeypatch.setattr(plugin_api.subprocess, "run", lambda argv, **kw: taskkilled.append(argv[-1]))
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()

    outcome = {}

    def start():
        try:
            outcome["response"] = client.post(
                f"{PREFIX}/workflows/bugfix/run", json={"cwd": str(project), "inputs": {"report": "x"}}
            )
        except Exception as exc:
            outcome["error"] = exc

    worker = threading.Thread(target=start)
    worker.start()
    try:
        assert dispatch_returned.wait(5), "the dispatcher never ran"
        body = client.post(f"{PREFIX}/workflows/bugfix/runs/fresh/stop", json={"cwd": str(project)}).json()
        assert body["stopped"] is True, f"the startup was not stopped: {body}"
        assert proc.killed or "4242" in taskkilled, "the dispatched process was left running"
    finally:
        release.set()
        worker.join(10)
        plugin_api.ACTIVE_RUNS.clear()
        plugin_api.JOBS.clear()

    # the dispatch that was cancelled must not report success
    assert outcome.get("response") is not None
    assert outcome["response"].status_code == 409, outcome["response"].text


def test_the_slot_stays_taken_until_the_kill_finishes(client, project, monkeypatch):
    """A start arriving mid-kill must not run alongside the process being stopped."""
    import threading

    entered = threading.Event()
    release = threading.Event()

    class Proc:
        pid = 777

        def poll(self):
            return None

        def kill(self):
            # the POSIX branch: block here so the window can be inspected
            entered.set()
            assert release.wait(5), "the kill never finished"

    proc = Proc()
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()
    with plugin_api.ACTIVE_LOCK:
        plugin_api.ACTIVE_RUNS[plugin_api._active_key(project, "bugfix")] = {
            "proc": proc, "run_id": "live", "process": "bugfix", "kind": "run", "token": 7, "started_at": 0
        }
    plugin_api.JOBS["j1"] = {"proc": proc, "id": "j1", "cwd": str(project), "argv": ["workflow", "run", "live"]}

    def slow_kill(argv, **kwargs):
        # the Windows branch: taskkill is the kill, so block there instead
        entered.set()
        assert release.wait(5), "the kill never finished"

    monkeypatch.setattr(plugin_api.subprocess, "run", slow_kill)

    def stop():
        client.post(f"{PREFIX}/workflows/bugfix/runs/live/stop", json={"cwd": str(project)})

    worker = threading.Thread(target=stop)
    worker.start()
    try:
        assert entered.wait(5), "the kill never started"
        with plugin_api.ACTIVE_LOCK:
            still_there = plugin_api._active_key(project, "bugfix") in plugin_api.ACTIVE_RUNS
        assert still_there, "the slot was freed before the process was dead"
    finally:
        release.set()
        worker.join(10)
        plugin_api.ACTIVE_RUNS.clear()
        plugin_api.JOBS.clear()


def test_stopping_an_old_run_does_not_cancel_a_startup(client, project, monkeypatch):
    """A state file on disk is not proof that a reservation owns that run."""
    import threading

    class Proc:
        pid = 9090

        def __init__(self):
            self.killed = False

        def poll(self):
            return None

        def kill(self):
            self.killed = True

    proc = Proc()
    old = project / ".specify" / "workflows" / "runs" / "old"
    old.mkdir(parents=True, exist_ok=True)
    (old / "state.json").write_text(json.dumps({"status": "completed"}), encoding="utf-8")

    entered = threading.Event()
    release = threading.Event()

    def job(args, cwd, timeout=None):
        plugin_api.JOBS["s2"] = {"proc": proc, "id": "s2", "cwd": str(cwd), "argv": args}
        return {"job_id": "s2", "id": "s2", "pid": 9090, "stdout_file": ""}

    def blocked_await(root_, before, timeout=25.0):
        entered.set()
        assert release.wait(5), "the dispatcher never resumed"
        return None

    monkeypatch.setattr(plugin_api, "_start_job", job)
    monkeypatch.setattr(plugin_api, "_await_new_run", blocked_await)
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()

    worker = threading.Thread(target=lambda: client.post(
        f"{PREFIX}/workflows/bugfix/run", json={"cwd": str(project), "inputs": {"report": "x"}}))
    worker.start()
    try:
        assert entered.wait(5), "the dispatcher never ran"
        body = client.post(f"{PREFIX}/workflows/bugfix/runs/old/stop", json={"cwd": str(project)}).json()
        assert body["stopped"] is False, f"stopping a historical run touched the startup: {body}"
        assert proc.killed is False, "the starting process was killed by an unrelated stop"
        with plugin_api.ACTIVE_LOCK:
            assert plugin_api._active_key(project, "bugfix") in plugin_api.ACTIVE_RUNS, "the reservation was released"
    finally:
        release.set()
        worker.join(10)
        plugin_api.ACTIVE_RUNS.clear()
        plugin_api.JOBS.clear()


def test_a_dispatch_without_a_run_id_is_refused(client, project, monkeypatch):
    """No run id means no way to address the run, so do not register one."""
    class Proc:
        pid = 616

        def __init__(self):
            self.alive = True
            self.killed = False

        def poll(self):
            return None if self.alive else 0

        def kill(self):
            self.killed = True
            self.alive = False

    proc = Proc()
    taskkilled: list[str] = []

    monkeypatch.setattr(plugin_api, "_start_job",
                        lambda args, cwd, timeout=None: (
                            plugin_api.JOBS.__setitem__("j", {"proc": proc, "id": "j"}) or
                            {"job_id": "j", "id": "j", "pid": proc.pid, "stdout_file": ""}))
    monkeypatch.setattr(plugin_api, "_await_new_run", lambda root_, before, timeout=25.0: None)
    monkeypatch.setattr(plugin_api.subprocess, "run", lambda argv, **kw: taskkilled.append(argv[-1]))
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()

    response = client.post(f"{PREFIX}/workflows/bugfix/run", json={"cwd": str(project), "inputs": {"report": "x"}})

    assert response.status_code == 504, response.text
    assert plugin_api.ACTIVE_RUNS == {}, "the project must not stay occupied"
    assert proc.killed or "616" in taskkilled, "the dispatched process must not be left running"
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()


def test_an_error_while_awaiting_the_run_kills_the_dispatch(client, project, monkeypatch):
    """A raise after _start_job must not leave a live process and a free slot."""
    class Proc:
        pid = 717

        def __init__(self):
            self.alive = True
            self.killed = False

        def poll(self):
            return None if self.alive else 0

        def kill(self):
            self.killed = True
            self.alive = False

    proc = Proc()

    def job(args, cwd, timeout=None):
        plugin_api.JOBS["j2"] = {"proc": proc, "id": "j2"}
        return {"job_id": "j2", "id": "j2", "pid": proc.pid, "stdout_file": ""}

    def boom(root_, before, timeout=25.0):
        raise RuntimeError("await failed")

    monkeypatch.setattr(plugin_api, "_start_job", job)
    monkeypatch.setattr(plugin_api, "_await_new_run", boom)
    monkeypatch.setattr(plugin_api.subprocess, "run", lambda argv, **kw: None)
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()

    with pytest.raises(RuntimeError):
        client.post(f"{PREFIX}/workflows/bugfix/run", json={"cwd": str(project), "inputs": {"report": "x"}})

    assert plugin_api.ACTIVE_RUNS == {}, "the reservation survived a failed dispatch"
    assert proc.killed is True, "a dispatched process was orphaned"
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()


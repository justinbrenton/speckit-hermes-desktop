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
from pathlib import Path

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
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
        f"{PREFIX}/artifact", params={"cwd": str(project), "path": "backend/plugin_api.py"}
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

    class FakeProc:
        pid = 5150

        def poll(self):
            return None

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
    assert ran and str(FakeProc.pid) in ran[0], "the pid must reach the kill command"


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


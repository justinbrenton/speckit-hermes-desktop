"""Tests for the workflow bridge.

The plugin does not run workflows itself: spec-kit's engine does, and this bridge
spawns `specify workflow run|resume|status --json` with stdin closed. Everything
here stubs the spawn and pins the argv the CLI will actually receive, plus the
payload shaping the pane renders.
"""

from __future__ import annotations

import importlib.util
import json
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
        return {
            "ok": state["ok"],
            "exit_code": state["exit_code"],
            "payload": state["payload"],
            "output": state["stdout"],
            "stderr": "",
            "argv": ["specify", *args],
        }

    monkeypatch.setattr(plugin_api, "_run_specify", fake)
    return calls, state


def test_json_tail_ignores_prose_and_braces_in_it(monkeypatch):
    text = 'Here is a spec { "not": "the payload" } and more prose\n{"run_id": "abc", "status": "paused"}'
    assert plugin_api._json_tail(text) == {"run_id": "abc", "status": "paused"}
    assert plugin_api._json_tail("") is None
    assert plugin_api._json_tail("no json here") is None


def test_run_builds_the_documented_argv(client, project, cli):
    calls, state = cli
    state["payload"] = {"run_id": "r1", "status": "paused", "current_step_id": "review-spec"}

    body = client.post(
        f"{PREFIX}/workflows/speckit/run",
        json={"cwd": str(project), "inputs": {"spec": "a greeting CLI", "gate_review_spec": ""}},
    ).json()

    assert calls[0]["args"] == [
        "workflow", "run", "speckit",
        "-i", "spec=a greeting CLI",
        "--json",
    ], "empty inputs are skipped, not sent as -i key="
    assert body["run_id"] == "r1"
    assert body["status"] == "paused"
    assert body["current_step_id"] == "review-spec"


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
    assert body["status"] == "completed"


def test_status_reads_the_engine_state(client, project, cli):
    calls, state = cli
    state["payload"] = {"run_id": "r1", "status": "paused"}

    body = client.get(f"{PREFIX}/workflows/speckit/runs/r1", params={"cwd": str(project)}).json()

    assert calls[0]["args"] == ["workflow", "status", "r1", "--json"]
    assert body["status"] == "paused"


def test_resume_rejects_a_traversal_run_id(client, project, cli):
    response = client.post(
        f"{PREFIX}/workflows/speckit/runs/..%2Fescape/resume",
        json={"cwd": str(project), "answers": {}},
    )
    assert response.status_code in (400, 404)
    assert cli[0] == []


def test_a_failed_cli_call_is_reported_not_raised(client, project, cli):
    calls, state = cli
    state.update({"ok": False, "exit_code": 2, "payload": {"error": "gate rejected"}})
    body = client.post(
        f"{PREFIX}/workflows/speckit/run", json={"cwd": str(project), "inputs": {"spec": "x"}}
    ).json()
    assert body["ok"] is False
    assert body["exit_code"] == 2
    assert body["error"] == "gate rejected"


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

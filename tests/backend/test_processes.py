"""Tests for GET /processes — the discovery behind the pane's process runner.

The pane must not hard-code SDD. Every installed workflow becomes a process, so a
bug-fix extension, an assessment extension or someone's own process shows up by
being installed. These tests pin that contract against the real workflow schema
(``schema_version``/``workflow``/``inputs``/``steps``).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[2] / "dashboard"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

spec = importlib.util.spec_from_file_location("speckit_plugin_api_proc", BACKEND_DIR / "plugin_api.py")
plugin_api = importlib.util.module_from_spec(spec)
sys.modules["speckit_plugin_api_proc"] = plugin_api
spec.loader.exec_module(plugin_api)

PREFIX = "/api/plugins/spec-kit-hermes"

BUGFIX = """\
schema_version: "1.0"
workflow:
  id: "bugfix"
  name: "Guided Bug Fix"
  version: "1.0.0"
  description: "assess -> gate -> fix -> test"

requires:
  speckit_version: ">=0.9.0"

inputs:
  report:
    type: string
    required: true
    prompt: "Bug report (pasted text or URL)"
  slug:
    type: string
    required: true
    prompt: "Bug slug"
  integration:
    type: string
    default: "auto"
    prompt: "Integration to use"

steps:
  - id: assess
    command: speckit.bug.assess
    input:
      args: "{{ inputs.report }} slug={{ inputs.slug }}"

  - id: review-assessment
    type: gate
    message: "Review the assessment before any code change."
    options: [approve, reject]
    on_reject: abort

  - id: fix
    command: speckit.bug.fix
    input:
      args: "slug={{ inputs.slug }}"
"""


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(plugin_api.router, prefix=PREFIX)
    return TestClient(app)


def _project(tmp_path: Path, workflows: dict[str, str] | None = None) -> Path:
    root = tmp_path / "proj"
    wf_dir = root / ".specify" / "workflows"
    wf_dir.mkdir(parents=True)
    for name, body in (workflows or {}).items():
        (wf_dir / name).mkdir()
        (wf_dir / name / "workflow.yml").write_text(body, encoding="utf-8")
    return root


def test_requires_an_absolute_cwd(client):
    assert client.get(f"{PREFIX}/processes", params={"cwd": "relative/path"}).status_code == 400


def test_empty_project_installs_nothing(client, tmp_path):
    body = client.get(f"{PREFIX}/processes", params={"cwd": str(_project(tmp_path))}).json()
    assert [item for item in body["processes"] if item["installed"]] == []
    assert body["errors"] == []


def test_a_directory_that_is_not_a_project_offers_nothing(client, tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    body = client.get(f"{PREFIX}/processes", params={"cwd": str(plain)}).json()
    assert body["processes"] == []


def test_workflow_becomes_a_process_with_inputs_and_steps(client, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    root = _project(tmp_path, {"bugfix": BUGFIX})

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    process = next(item for item in body["processes"] if item["id"] == "bugfix")
    assert process["installed"] is True

    assert process["id"] == "bugfix"
    assert process["name"] == "Guided Bug Fix"
    assert [item["name"] for item in process["inputs"]] == ["report", "slug", "integration"]
    assert process["inputs"][2]["default"] == "auto"
    assert process["inputs"][0]["required"] is True

    assert [step["id"] for step in process["steps"]] == ["assess", "review-assessment", "fix"]
    assert process["steps"][0]["type"] == "command"
    assert process["steps"][0]["skill"] == "speckit-bug-assess"
    assert process["steps"][0]["args"] == "{{ inputs.report }} slug={{ inputs.slug }}"

    gate = process["steps"][1]
    assert gate["type"] == "gate"
    assert gate["options"] == ["approve", "reject"]
    assert gate["on_reject"] == "abort"
    assert gate["verdict_input"] is None, "undeclared gates cannot be answered from a GUI"
    assert "Review the assessment" in gate["message"]


def test_ready_false_until_the_skills_exist(client, tmp_path, monkeypatch):
    home = tmp_path / "hermes-home"
    (home / "skills").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    # This machine has the skills installed; the test must not read them.
    monkeypatch.setattr(plugin_api, "_hermes_skills_dirs", lambda: [home / "skills"])
    root = _project(tmp_path, {"bugfix": BUGFIX})

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    assert next(item for item in body["processes"] if item["id"] == "bugfix")["ready"] is False
    assert str(home / "skills") in body["skills_dirs"]

    for name in ("speckit-bug-assess", "speckit-bug-fix"):
        (home / "skills" / name).mkdir()

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    assert next(item for item in body["processes"] if item["id"] == "bugfix")["ready"] is True


def test_a_broken_workflow_is_reported_not_fatal(client, tmp_path):
    root = _project(tmp_path, {"bugfix": BUGFIX, "broken": "workflow: [unclosed\n"})

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    assert "bugfix" in [item["id"] for item in body["processes"]]
    assert len(body["errors"]) == 1
    assert "broken" in body["errors"][0]["file"]


def test_processes_without_a_workflow_are_offered_with_their_shape(client, tmp_path):
    """The bug and assess extensions ship commands only, so their workflow is ours."""
    root = _project(tmp_path, {"speckit": "schema_version: \"1.0\"\nworkflow:\n  id: speckit\n"})

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    by_id = {item["id"]: item for item in body["processes"]}

    assert by_id["bug"]["installed"] is False
    assert [step["id"] for step in by_id["bug"]["steps"]] == [
        "assess", "review-assess", "fix", "test", "review-test"
    ]
    gates = [step for step in by_id["bug"]["steps"] if step["type"] == "gate"]
    assert all(gate["verdict_input"] for gate in gates), "a pane cannot answer a gate without one"
    assert by_id["bug"]["inputs"][0]["name"] == "report"
    assert by_id["bug"]["inputs"][0]["required"] is True

    assert [step["id"] for step in by_id["assess"]["steps"]][0] == "intake"
    assert "implementation" not in [step["id"] for step in by_id["assess"]["steps"]]


def test_shaping_writes_the_workflow_a_bare_extension_does_not_ship(client, tmp_path):
    root = _project(tmp_path, {"speckit": "schema_version: \"1.0\"\nworkflow:\n  id: speckit\n"})

    body = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(root), "process": "bug"}).json()
    assert body["changed"] is True
    workflow = (root / ".specify" / "workflows" / "bug" / "workflow.yml").read_text(encoding="utf-8")
    assert "id: \"bug\"" in workflow
    assert "verdict_input: gate_review_assess" in workflow
    assert "gate_review_assess:" in workflow

    # Shaping again changes nothing and writes no second backup.
    again = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(root), "process": "bug"}).json()
    assert again["changed"] is False


def test_an_unknown_process_is_rejected(client, tmp_path):
    root = _project(tmp_path, {"speckit": "schema_version: \"1.0\"\nworkflow:\n  id: speckit\n"})
    response = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(root), "process": "nope"})
    assert response.status_code == 400


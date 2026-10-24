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

BACKEND_DIR = Path(__file__).resolve().parents[1]
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


def test_empty_project_reports_no_processes(client, tmp_path):
    body = client.get(f"{PREFIX}/processes", params={"cwd": str(_project(tmp_path))}).json()
    assert body["processes"] == []
    assert body["errors"] == []


def test_workflow_becomes_a_process_with_inputs_and_steps(client, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    root = _project(tmp_path, {"bugfix": BUGFIX})

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    assert len(body["processes"]) == 1
    process = body["processes"][0]

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
    assert "Review the assessment" in gate["message"]


def test_ready_false_until_the_skills_exist(client, tmp_path, monkeypatch):
    home = tmp_path / "hermes-home"
    (home / "skills").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    root = _project(tmp_path, {"bugfix": BUGFIX})

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    assert body["processes"][0]["ready"] is False
    assert str(home / "skills") in body["skills_dirs"]

    for name in ("speckit-bug-assess", "speckit-bug-fix"):
        (home / "skills" / name).mkdir()

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    assert body["processes"][0]["ready"] is True


def test_a_broken_workflow_is_reported_not_fatal(client, tmp_path):
    root = _project(tmp_path, {"bugfix": BUGFIX, "broken": "workflow: [unclosed\n"})

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    assert [item["id"] for item in body["processes"]] == ["bugfix"]
    assert len(body["errors"]) == 1
    assert "broken" in body["errors"][0]["file"]

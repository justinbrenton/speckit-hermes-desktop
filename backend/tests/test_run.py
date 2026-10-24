"""Tests for POST /run — dispatching one workflow step through the Hermes CLI.

The documented contract (spec-kit docs, Hermes integration) is:

    hermes chat -Q ... -s <skill> -q <remaining text>

so a step's rendered arguments become the query and the skill is selected with
``-s``. These tests stub the process spawn and pin everything up to it.
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

spec = importlib.util.spec_from_file_location("speckit_plugin_api_run", BACKEND_DIR / "plugin_api.py")
plugin_api = importlib.util.module_from_spec(spec)
sys.modules["speckit_plugin_api_run"] = plugin_api
spec.loader.exec_module(plugin_api)

PREFIX = "/api/plugins/spec-kit-hermes"

BUGFIX = """\
schema_version: "1.0"
workflow:
  id: "bugfix"
  name: "Guided Bug Fix"
  version: "1.0.0"
inputs:
  report:
    type: string
    required: true
  slug:
    type: string
    required: true
  integration:
    type: string
    default: "auto"
steps:
  - id: assess
    command: speckit.bug.assess
    input:
      args: "{{ inputs.report }} slug={{ inputs.slug }}"
  - id: review-assessment
    type: gate
    message: "Review before any code change."
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


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    wf_dir = root / ".specify" / "workflows" / "bugfix"
    wf_dir.mkdir(parents=True)
    (wf_dir / "workflow.yml").write_text(BUGFIX, encoding="utf-8")
    return root


@pytest.fixture
def spawned(monkeypatch):
    """Capture what would be handed to `hermes chat` instead of running it."""
    calls = []

    def fake(prompt, skill, cwd, model, timeout):
        calls.append({"prompt": prompt, "skill": skill, "cwd": str(cwd), "model": model})
        return {"ok": True, "exit_code": 0, "stdout": "done", "stderr": "", "argv": []}

    monkeypatch.setattr(plugin_api, "_spawn_hermes", fake)
    return calls


def test_render_args_fills_inputs_and_tolerates_spacing():
    rendered = plugin_api._render_args(
        "{{ inputs.report }} slug={{inputs.slug}} missing={{ inputs.nope }}",
        {"report": "crashes on save", "slug": "save-crash"},
    )
    assert rendered == "crashes on save slug=save-crash missing="


def test_run_dispatches_the_rendered_args_with_the_skill(client, project, spawned):
    body = client.post(
        f"{PREFIX}/run",
        json={
            "cwd": str(project),
            "process": "bugfix",
            "step": "assess",
            "inputs": {"report": "Submitting an empty password crashes login", "slug": "login-crash"},
        },
    ).json()

    assert body["ok"] is True
    assert body["skill"] == "speckit-bug-assess"
    assert body["prompt"] == "Submitting an empty password crashes login slug=login-crash"
    assert spawned == [
        {
            "prompt": "Submitting an empty password crashes login slug=login-crash",
            "skill": "speckit-bug-assess",
            "cwd": str(project.resolve()),
            "model": None,
        }
    ]


def test_run_passes_the_model_through(client, project, spawned):
    body = client.post(
        f"{PREFIX}/run",
        json={
            "cwd": str(project),
            "process": "bugfix",
            "step": "fix",
            "inputs": {"report": "x", "slug": "login-crash"},
            "model": "anthropic/claude-sonnet-4",
        },
    ).json()
    assert body["skill"] == "speckit-bug-fix"
    assert body["prompt"] == "slug=login-crash"
    assert spawned[0]["model"] == "anthropic/claude-sonnet-4"


def test_run_refuses_a_gate_step(client, project, spawned):
    response = client.post(
        f"{PREFIX}/run",
        json={
            "cwd": str(project),
            "process": "bugfix",
            "step": "review-assessment",
            "inputs": {"report": "x", "slug": "y"},
        },
    )
    assert response.status_code == 400
    assert "not a command" in response.json()["detail"]
    assert spawned == []


def test_run_reports_missing_required_inputs(client, project, spawned):
    response = client.post(
        f"{PREFIX}/run",
        json={"cwd": str(project), "process": "bugfix", "step": "assess", "inputs": {"slug": "only"}},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == {"missing_inputs": ["report"]}
    assert spawned == []


def test_run_404s_for_unknown_process_and_step(client, project, spawned):
    assert (
        client.post(
            f"{PREFIX}/run", json={"cwd": str(project), "process": "nope", "step": "assess"}
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"{PREFIX}/run",
            json={
                "cwd": str(project),
                "process": "bugfix",
                "step": "nope",
                "inputs": {"report": "x", "slug": "y"},
            },
        ).status_code
        == 404
    )
    assert spawned == []


def test_a_failed_subprocess_is_reported_not_raised(client, project, monkeypatch):
    monkeypatch.setattr(
        plugin_api,
        "_spawn_hermes",
        lambda *a, **k: {"ok": False, "exit_code": 2, "stdout": "", "stderr": "boom", "argv": []},
    )
    body = client.post(
        f"{PREFIX}/run",
        json={
            "cwd": str(project),
            "process": "bugfix",
            "step": "fix",
            "inputs": {"report": "x", "slug": "s"},
        },
    ).json()
    assert body["ok"] is False
    assert body["exit_code"] == 2
    assert body["stderr"] == "boom"


def test_the_spawn_matches_the_documented_cli_contract(project, monkeypatch):
    """`hermes chat -Q --query-file <p> -s <skill> --in <cwd> [-m model]`."""
    seen = {}
    epoch = type("Done", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    def fake_run(argv, **kwargs):
        seen["argv"] = argv
        seen["kwargs"] = kwargs
        seen["query"] = Path(argv[argv.index("--query-file") + 1]).read_text(encoding="utf-8")
        return epoch

    monkeypatch.setattr(plugin_api, "_hermes_cli", lambda: "hermes")
    monkeypatch.setattr(plugin_api.subprocess, "run", fake_run)

    result = plugin_api._spawn_hermes("crashes on save slug=x", "speckit-bug-assess", project, "m-1", 30)

    assert result["ok"] is True
    argv = seen["argv"]
    assert argv[0] == "hermes"
    assert argv[1] == "chat"
    assert "-Q" in argv
    assert argv[argv.index("-s") + 1] == "speckit-bug-assess"
    assert argv[argv.index("--in") + 1] == str(project)
    assert argv[argv.index("-m") + 1] == "m-1"
    assert seen["query"] == "crashes on save slug=x"
    assert not Path(argv[argv.index("--query-file") + 1]).exists(), "query file must be cleaned up"

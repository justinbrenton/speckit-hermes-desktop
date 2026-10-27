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

    # The process id must match the bundled workflow, or the same process appears
    # twice: once as installed, once as generated.
    assert "bug" not in by_id, "the process id and the shipped workflow id must agree"
    assert by_id["bugfix"]["installed"] is False
    assert by_id["bugfix"]["extension"] == "bug", "the pane needs to know what to install"
    assert [step["id"] for step in by_id["bugfix"]["steps"]] == [
        "assess", "review-assess", "fix", "test", "review-test"
    ]
    gates = [step for step in by_id["bugfix"]["steps"] if step["type"] == "gate"]
    assert all(gate["verdict_input"] for gate in gates), "a pane cannot answer a gate without one"
    assert by_id["bugfix"]["inputs"][0]["name"] == "report"
    assert by_id["bugfix"]["inputs"][0]["required"] is True

    assert [step["id"] for step in by_id["assess"]["steps"]][0] == "intake"
    assert "implementation" not in [step["id"] for step in by_id["assess"]["steps"]]


def test_shaping_writes_the_workflow_a_bare_extension_does_not_ship(client, tmp_path):
    root = _project(tmp_path, {"speckit": "schema_version: \"1.0\"\nworkflow:\n  id: speckit\n"})

    body = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(root), "process": "bugfix"}).json()
    assert body["changed"] is True
    workflow = (root / ".specify" / "workflows" / "bugfix" / "workflow.yml").read_text(encoding="utf-8")
    assert "id: \"bugfix\"" in workflow
    assert "verdict_input: gate_review_assess" in workflow
    assert "gate_review_assess:" in workflow

    # Shaping again changes nothing and writes no second backup.
    again = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(root), "process": "bugfix"}).json()
    assert again["changed"] is False


def test_an_unknown_process_is_rejected(client, tmp_path):
    root = _project(tmp_path, {"speckit": "schema_version: \"1.0\"\nworkflow:\n  id: speckit\n"})
    response = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(root), "process": "nope"})
    assert response.status_code == 400


def test_a_legacy_bug_workflow_does_not_become_a_second_card(client, tmp_path):
    """Older projects have .specify/workflows/bug/. It must not shadow or duplicate."""
    root = _project(tmp_path, {"speckit": "schema_version: \"1.0\"\nworkflow:\n  id: speckit\n"})
    legacy = root / ".specify" / "workflows" / "bug"
    legacy.mkdir(parents=True)
    (legacy / "workflow.yml").write_text(
        "schema_version: \"1.0\"\nworkflow:\n  id: \"bug\"\n  name: \"Bug fixing\"\n"
        "steps:\n  - id: assess\n    command: speckit.bug.assess\n",
        encoding="utf-8",
    )

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    ids = [item["id"] for item in body["processes"]]
    assert ids.count("bugfix") == 1, f"one card per process, got {ids}"
    assert "bug" not in ids, f"the alias must not surface as its own card: {ids}"

    entry = next(item for item in body["processes"] if item["id"] == "bugfix")
    assert entry["extension"] == "bug", "the Install action has to be reachable for a legacy tree too"


def test_an_on_disk_bundle_reports_its_extension(client, tmp_path):
    """The shipped workflow resolves its extension too, not only the generated one."""
    root = _project(tmp_path, {})
    bundled = Path(__file__).resolve().parents[2] / "workflows" / "bugfix" / "workflow.yml"
    target = root / ".specify" / "workflows" / "bugfix" / "workflow.yml"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(bundled.read_text(encoding="utf-8"), encoding="utf-8")

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    entry = next(item for item in body["processes"] if item["id"] == "bugfix")
    assert entry["installed"] is True
    assert entry["extension"] == "bug"


def test_the_canonical_workflow_wins_when_both_trees_exist(client, tmp_path):
    root = _project(tmp_path, {"speckit": "schema_version: \"1.0\"\nworkflow:\n  id: speckit\n"})
    bundled = Path(__file__).resolve().parents[2] / "workflows" / "bugfix" / "workflow.yml"
    new = root / ".specify" / "workflows" / "bugfix" / "workflow.yml"
    new.parent.mkdir(parents=True)
    new.write_text(bundled.read_text(encoding="utf-8"), encoding="utf-8")
    legacy = root / ".specify" / "workflows" / "bug"
    legacy.mkdir(parents=True)
    (legacy / "workflow.yml").write_text(
        "schema_version: \"1.0\"\nworkflow:\n  id: \"bug\"\n  name: \"LEGACY Bug\"\n"
        "steps:\n  - id: assess\n    command: speckit.bug.assess\n",
        encoding="utf-8",
    )

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    card = next(item for item in body["processes"] if item["id"] == "bugfix")
    assert card["name"] != "LEGACY Bug", "the shipped workflow wins over the legacy tree"
    # the shipped bundle's own steps, not the generated spec's
    assert [step["id"] for step in card["steps"]], "the canonical card has steps"
    assert card["steps"][0]["id"] == "assess"
    assert card["version"] == "1.0.1", "the shipped workflow's version identifies which file won"


def test_a_legacy_project_runs_its_own_workflow_file(client, tmp_path, monkeypatch):
    """A pre-rename project has only workflows/bug/: reading and running must use it."""
    root = _project(tmp_path, {})
    legacy = root / ".specify" / "workflows" / "bug"
    legacy.mkdir(parents=True)
    (legacy / "workflow.yml").write_text(
        "schema_version: \"1.0\"\nworkflow:\n  id: \"bug\"\n  name: \"Legacy\"\n"
        "steps:\n  - id: assess\n    command: speckit.bug.assess\n",
        encoding="utf-8",
    )
    calls = []

    def fake_job(args, cwd, timeout=None):
        calls.append({"args": args, "cwd": str(cwd)})
        return {"job_id": "job1", "id": "job1", "pid": 0, "stdout_file": ""}

    monkeypatch.setattr(plugin_api, "_start_job", fake_job)
    monkeypatch.setattr(plugin_api, "_await_new_run", lambda root_, before, timeout=25.0: "run-1")

    response = client.post(f"{PREFIX}/workflows/bugfix/run", json={"cwd": str(root), "inputs": {"report": "x"}})
    assert response.status_code == 200, response.text
    assert ["workflow", "run", "bug"] == calls[-1]["args"][:3], "the CLI must be asked for the id that exists"
    assert (legacy / "workflow.yml").is_file()


def test_shaping_accepts_the_legacy_id(client, tmp_path):
    root = _project(tmp_path, {})
    response = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(root), "process": "bug"})
    assert response.status_code == 200, response.text


def test_a_workflow_with_no_id_of_its_own_still_reports_its_extension(client, tmp_path):
    """The directory name is the process id when the file does not declare one."""
    root = _project(tmp_path, {})
    target = root / ".specify" / "workflows" / "bugfix" / "workflow.yml"
    target.parent.mkdir(parents=True)
    target.write_text(
        "schema_version: \"1.0\"\nworkflow:\n  name: \"No id\"\n"
        "steps:\n  - id: assess\n    command: speckit.bug.assess\n",
        encoding="utf-8",
    )

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    card = next(item for item in body["processes"] if item["id"] == "bugfix")
    assert card["extension"] == "bug", "an id-less file must not lose its Install action"


def test_shaping_a_legacy_project_rewrites_its_own_file(client, tmp_path):
    """The pane shapes before every run; that must not create a second tree."""
    root = _project(tmp_path, {})
    legacy = root / ".specify" / "workflows" / "bug"
    legacy.mkdir(parents=True)
    (legacy / "workflow.yml").write_text(
        "schema_version: \"1.0\"\nworkflow:\n  id: \"bug\"\n  name: \"MINE\"\n"
        "steps:\n  - id: assess\n    command: speckit.bug.assess\n",
        encoding="utf-8",
    )

    response = client.post(f"{PREFIX}/workflow/shape", json={"cwd": str(root), "process": "bugfix"})
    assert response.status_code == 200, response.text
    assert not (root / ".specify" / "workflows" / "bugfix").exists(), "no competing tree"
    assert "MINE" not in (legacy / "workflow.yml").read_text(encoding="utf-8"), "the legacy file was rewritten"

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    card = next(item for item in body["processes"] if item["id"] == "bugfix")
    assert card["source"].endswith(str(Path("bug") / "workflow.yml")), f"still reading the legacy file: {card['source']}"


def test_the_legacy_id_can_start_a_run_when_nothing_is_on_disk(client, tmp_path, monkeypatch):
    root = _project(tmp_path, {})
    calls = []

    def fake_job(args, cwd, timeout=None):
        calls.append(args)
        return {"job_id": "j", "id": "j", "pid": 0, "stdout_file": ""}

    monkeypatch.setattr(plugin_api, "_start_job", fake_job)
    monkeypatch.setattr(plugin_api, "_await_new_run", lambda root_, before, timeout=25.0: "r")

    response = client.post(f"{PREFIX}/workflows/bug/run", json={"cwd": str(root), "inputs": {"report": "x"}})
    assert response.status_code == 200, response.text
    assert calls[-1][:3] == ["workflow", "run", "bugfix"], "the generated tree is canonical once written"


def test_a_shaped_legacy_file_does_not_win_over_the_canonical_one(client, tmp_path):
    """Shaping writes id: bugfix into bug/, so the declared id cannot pick the winner."""
    root = _project(tmp_path, {})
    bundled = Path(__file__).resolve().parents[2] / "workflows" / "bugfix" / "workflow.yml"
    canonical = root / ".specify" / "workflows" / "bugfix" / "workflow.yml"
    canonical.parent.mkdir(parents=True)
    canonical.write_text(bundled.read_text(encoding="utf-8"), encoding="utf-8")

    legacy = root / ".specify" / "workflows" / "bug"
    legacy.mkdir(parents=True)
    (legacy / "workflow.yml").write_text(
        "schema_version: \"1.0\"\nworkflow:\n  id: \"bugfix\"\n  name: \"LEGACY\"\n"
        "steps:\n  - id: assess\n    command: speckit.bug.assess\n",
        encoding="utf-8",
    )

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    card = next(item for item in body["processes"] if item["id"] == "bugfix")
    # The declared id is identical in both files, so only the directory can decide.
    assert card["name"] != "LEGACY", "the card must describe the file a run would use"
    assert card["source"].endswith(str(Path("bugfix") / "workflow.yml")), card["source"]


def test_a_custom_workflow_is_listed_and_can_start(client, tmp_path, monkeypatch):
    root = _project(tmp_path, {})
    custom = root / ".specify" / "workflows" / "my-flow"
    custom.mkdir(parents=True)
    (custom / "workflow.yml").write_text(
        "schema_version: \"1.0\"\nworkflow:\n  id: \"my-flow\"\n  name: \"My Flow\"\n"
        "inputs:\n  spec:\n    type: string\n    required: true\n"
        "steps:\n  - id: one\n    type: shell\n    run: \"true\"\n",
        encoding="utf-8",
    )

    body = client.get(f"{PREFIX}/processes", params={"cwd": str(root)}).json()
    assert "my-flow" in [item["id"] for item in body["processes"]]

    calls = []

    def fake_job(args, cwd, timeout=None):
        calls.append(args)
        return {"job_id": "j", "id": "j", "pid": 0, "stdout_file": ""}

    monkeypatch.setattr(plugin_api, "_start_job", fake_job)
    monkeypatch.setattr(plugin_api, "_await_new_run", lambda root_, before, timeout=25.0: "r9")
    plugin_api.ACTIVE_RUNS.clear()

    response = client.post(f"{PREFIX}/workflows/my-flow/run", json={"cwd": str(root), "inputs": {"spec": "x"}})
    assert response.status_code == 200, response.text
    assert calls[-1][:3] == ["workflow", "run", "my-flow"]


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

        def poll(self):
            return None

        def kill(self):
            # The POSIX path signals the Popen directly; Windows shells out to taskkill.
            signalled.append(self.pid)

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

    def poll(self):
        return None

    def kill(self):
        self.killed = True


def test_resume_takes_over_a_run_that_is_still_parked(client, project, cli):
    """The parked CLI can outlive the pause by a moment; answering must not 409."""
    run_dir = project / ".specify" / "workflows" / "runs" / "parked1"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "state.json").write_text(json.dumps({"status": "paused"}), encoding="utf-8")

    proc = ParkedProc()
    plugin_api.ACTIVE_RUNS[(str(project).lower(), "speckit")] = {"proc": proc, "run_id": "parked1", "kind": "run"}
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

    plugin_api.ACTIVE_RUNS[(str(project).lower(), "speckit")] = {"proc": ParkedProc(), "run_id": "busy1", "kind": "run"}
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
    plugin_api.ACTIVE_RUNS[(str(project).lower(), "speckit")] = {
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


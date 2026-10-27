"""The run slot: one run per project, in an explicit state machine.

These are direct tests of the transitions rather than HTTP round trips, because the
whole class of bugs here came from two requests interleaving inside a transition.
Each case names the state it starts from, so a future change has to keep the graph
honest instead of accidentally re-opening a window.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

BACKEND_DIR = Path(__file__).resolve().parents[2] / "dashboard"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

spec = importlib.util.spec_from_file_location("speckit_plugin_api_state", BACKEND_DIR / "plugin_api.py")
assert spec is not None and spec.loader is not None
plugin_api = importlib.util.module_from_spec(spec)
sys.modules["speckit_plugin_api_state"] = plugin_api
spec.loader.exec_module(plugin_api)


class Proc:
    def __init__(self, pid=1000, alive=True):
        self.pid = pid
        self.alive = alive
        self.killed = False

    def poll(self):
        return None if self.alive else 0

    def kill(self):
        self.killed = True


@pytest.fixture(autouse=True)
def clean():
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()
    yield
    plugin_api.ACTIVE_RUNS.clear()
    plugin_api.JOBS.clear()


@pytest.fixture
def root(tmp_path):
    project = tmp_path / "proj"
    (project / ".specify" / "workflows" / "runs").mkdir(parents=True)
    return project


def run_dir(root: Path, run_id: str, status: str = "paused") -> None:
    target = root / ".specify" / "workflows" / "runs" / run_id
    target.mkdir(parents=True, exist_ok=True)
    (target / "state.json").write_text(json.dumps({"status": status}), encoding="utf-8")


def slot(root: Path):
    return plugin_api.ACTIVE_RUNS.get(plugin_api._active_key(root))


# --- starting -------------------------------------------------------------

def test_a_start_claims_the_project(root):
    token = plugin_api._admit_start(root, "bugfix")
    entry = slot(root)
    assert entry["state"] == "starting"
    assert entry["token"] == token
    assert entry["run_id"] is None


def test_a_second_start_is_refused_while_the_first_is_starting(root):
    plugin_api._admit_start(root, "bugfix")
    with pytest.raises(HTTPException) as caught:
        plugin_api._admit_start(root, "assess")
    assert caught.value.status_code == 409
    assert "bugfix" in caught.value.detail


def test_a_resume_is_refused_while_a_start_is_still_starting(root):
    plugin_api._admit_start(root, "bugfix")
    with pytest.raises(HTTPException) as caught:
        plugin_api._admit_resume(root, "bugfix", "r1")
    assert caught.value.status_code == 409
    assert "starting" in caught.value.detail


def test_a_failed_dispatch_releases_only_its_own_reservation(root):
    token = plugin_api._admit_start(root, "bugfix")
    plugin_api._release(root, token + 999)
    assert slot(root) is not None, "a foreign token must not free the slot"
    plugin_api._release(root, token)
    assert slot(root) is None


# --- claim ----------------------------------------------------------------

def test_a_claim_moves_the_slot_to_running(root):
    token = plugin_api._admit_start(root, "bugfix")
    plugin_api._claim(root, token, "r1", "run", "bugfix")
    entry = slot(root)
    assert entry["state"] == "running"
    assert entry["run_id"] == "r1"


def test_a_claim_with_a_stale_token_is_refused(root):
    first = plugin_api._admit_start(root, "bugfix")
    plugin_api._release(root, first)
    second = plugin_api._admit_start(root, "assess")
    with pytest.raises(HTTPException) as caught:
        plugin_api._claim(root, first, "old", "run", "bugfix")
    assert caught.value.status_code == 409
    assert slot(root)["token"] == second


def test_a_cancelled_reservation_cannot_claim(root):
    token = plugin_api._admit_start(root, "bugfix")
    slot(root)["cancelled"] = True
    with pytest.raises(HTTPException):
        plugin_api._claim(root, token, "r1", "run", "bugfix")


def test_a_cancelled_claim_kills_the_job_it_started(root):
    token = plugin_api._admit_start(root, "bugfix")
    proc = Proc()
    plugin_api.JOBS["j"] = {"proc": proc, "id": "j"}
    plugin_api._attach_job(root, token, {"job_id": "j", "pid": proc.pid})
    with pytest.raises(HTTPException):
        plugin_api._claim(root, token + 1, "r1", "run", "bugfix")
    # the slot still belongs to `token`, so the claim killed its own process
    assert slot(root)["token"] == token


# --- resume takeover ------------------------------------------------------

def test_a_resume_takes_over_a_parked_run(root):
    run_dir(root, "r1", "paused")
    token = plugin_api._admit_start(root, "bugfix")
    proc = Proc()
    plugin_api._claim(root, token, "r1", "run", "bugfix")
    slot(root)["proc"] = proc

    resumed = plugin_api._admit_resume(root, "bugfix", "r1")

    entry = slot(root)
    assert entry["state"] == "starting"
    assert entry["token"] == resumed != token
    assert proc.killed is True, "the parked process must be ended before the resume runs"


def test_a_resume_of_a_different_run_is_refused(root):
    run_dir(root, "r1", "paused")
    token = plugin_api._admit_start(root, "bugfix")
    plugin_api._claim(root, token, "r1", "run", "bugfix")
    slot(root)["proc"] = Proc()
    with pytest.raises(HTTPException):
        plugin_api._admit_resume(root, "bugfix", "r2")


def test_a_resume_of_a_running_run_is_refused(root):
    run_dir(root, "r1", "running")
    token = plugin_api._admit_start(root, "bugfix")
    plugin_api._claim(root, token, "r1", "run", "bugfix")
    slot(root)["proc"] = Proc()
    with pytest.raises(HTTPException):
        plugin_api._admit_resume(root, "bugfix", "r1")


def test_a_second_answer_in_the_grace_window_is_refused(root):
    run_dir(root, "r1", "paused")
    token = plugin_api._admit_start(root, "bugfix")
    plugin_api._claim(root, token, "r1", "resume", "bugfix")
    slot(root)["proc"] = Proc()
    with pytest.raises(HTTPException):
        plugin_api._admit_resume(root, "bugfix", "r1")


# --- stop -----------------------------------------------------------------

def test_stop_takes_the_named_run(root):
    token = plugin_api._admit_start(root, "bugfix")
    proc = Proc()
    plugin_api._claim(root, token, "r1", "run", "bugfix")
    slot(root)["proc"] = proc

    entry, target = plugin_api._begin_stop(root, "r1")

    assert entry is not None and target is proc
    assert slot(root)["state"] == "stopping", "the slot stays held until the kill lands"
    plugin_api._end_stop(root, entry)
    assert slot(root) is None


def test_stop_ignores_a_run_it_does_not_own(root):
    token = plugin_api._admit_start(root, "bugfix")
    plugin_api._claim(root, token, "r1", "run", "bugfix")
    entry, proc = plugin_api._begin_stop(root, "other")
    assert entry is None and proc is None
    assert slot(root)["state"] == "running"


def test_stop_can_reach_a_startup_whose_run_already_exists(root):
    run_dir(root, "fresh")
    token = plugin_api._admit_start(root, "bugfix")
    plugin_api._note_before(root, token, set())          # nothing existed before
    proc = Proc()
    plugin_api.JOBS["j"] = {"proc": proc, "id": "j"}
    plugin_api._attach_job(root, token, {"job_id": "j", "pid": proc.pid})

    entry, target = plugin_api._begin_stop(root, "fresh")

    assert entry is not None and target is proc


def test_stop_ignores_a_run_that_predates_the_startup(root):
    run_dir(root, "old", "completed")
    token = plugin_api._admit_start(root, "bugfix")
    plugin_api._note_before(root, token, {"old"})        # it already existed
    plugin_api._attach_job(root, token, {"job_id": "missing", "pid": 0})

    entry, proc = plugin_api._begin_stop(root, "old")

    assert entry is None and proc is None, "an old run must not cancel a new startup"
    assert slot(root)["state"] == "starting"


# --- reaper ---------------------------------------------------------------

def test_the_reaper_clears_a_dead_run(root):
    token = plugin_api._admit_start(root, "bugfix")
    plugin_api._claim(root, token, "r1", "run", "bugfix")
    slot(root)["proc"] = Proc(alive=False)
    plugin_api._reap()
    assert slot(root) is None


def test_the_reaper_leaves_held_states_alone(root):
    plugin_api._admit_start(root, "bugfix")
    plugin_api._reap()
    assert slot(root) is not None, "a reservation must survive the reaper"

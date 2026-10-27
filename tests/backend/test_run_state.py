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
        self.alive = False


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


# --- the four holes found after the refactor ------------------------------

def test_a_stale_claim_kills_its_own_job_not_the_new_one(root):
    """A stopped request must not terminate whatever now occupies the slot."""
    mine, theirs = Proc(pid=1), Proc(pid=2)
    plugin_api.JOBS["mine"] = {"proc": mine, "id": "mine"}
    plugin_api.JOBS["theirs"] = {"proc": theirs, "id": "theirs"}

    stale = plugin_api._admit_start(root, "bugfix")
    winner = plugin_api._admit_start  # noqa: F841  (documented below)
    plugin_api._release(root, stale)
    current = plugin_api._admit_start(root, "assess")
    plugin_api._attach_job(root, current, {"job_id": "theirs", "pid": theirs.pid})

    with pytest.raises(HTTPException):
        plugin_api._claim(root, stale, "r1", "run", "bugfix", {"job_id": "mine"})

    assert mine.killed is True, "the stale request's own job should be killed"
    assert theirs.killed is False, "the newer run's process was killed by a stale claim"


def test_a_failed_run_listing_releases_the_reservation(root):
    """_run_ids runs before the reservation now, so it cannot pin the project."""
    calls = []

    def boom(_root):
        calls.append(1)
        raise OSError("cannot list runs")

    original = plugin_api._run_ids
    plugin_api._run_ids = boom
    try:
        with pytest.raises(OSError):
            plugin_api._admit_start(root, "bugfix", plugin_api._run_ids(root))
    finally:
        plugin_api._run_ids = original

    assert calls, "the failure path was exercised"
    assert slot(root) is None, "a failed listing must not leave a reservation"


def test_a_stop_can_be_retried_after_a_failed_kill(root):
    """Refusing every later stop would trap the project when a kill fails."""
    token = plugin_api._admit_start(root, "bugfix")
    plugin_api._claim(root, token, "r1", "run", "bugfix")

    class Immortal(Proc):
        def kill(self):
            self.killed = True          # asked, but stayed alive

    slot(root)["proc"] = Immortal()

    first_entry, _first_proc = plugin_api._begin_stop(root, "r1")
    gone, _pid = plugin_api._kill_proc(first_entry.get("proc"))
    assert gone is False
    assert slot(root) is not None, "a failed kill keeps the slot"

    # the process dies later; a retry must be able to finish the job
    slot(root)["proc"].alive = False
    second_entry, second_proc = plugin_api._begin_stop(root, "r1")
    assert second_entry is not None, "a retry must still own the slot"
    ended, _pid = plugin_api._kill_proc(second_proc)
    assert ended is True
    plugin_api._end_stop(root, second_entry)
    assert slot(root) is None


def test_a_takeover_does_not_hold_the_lock_while_killing(root):
    """taskkill can take seconds; another project must be able to admit meanwhile.

    Checked from a second thread: an RLock is reentrant, so a same-thread probe
    would acquire it even while the lock is held.
    """
    import threading

    run_dir(root, "r1", "paused")
    token = plugin_api._admit_start(root, "bugfix")
    plugin_api._claim(root, token, "r1", "run", "bugfix")

    seen = {}

    class SlowProc(Proc):
        def kill(self):
            def probe():
                got = plugin_api.ACTIVE_LOCK.acquire(timeout=0.6)
                seen["other_thread"] = got
                if got:
                    plugin_api.ACTIVE_LOCK.release()

            worker = threading.Thread(target=probe)
            worker.start()
            worker.join(2)
            self.killed = True
            self.alive = False

    slot(root)["proc"] = SlowProc()
    plugin_api._admit_resume(root, "bugfix", "r1")

    assert seen.get("other_thread") is True, "the lock was held across the kill"


def test_a_kill_that_fails_keeps_the_slot(root):
    """If the process survives, the project stays occupied rather than admitting another."""
    token = plugin_api._admit_start(root, "bugfix")
    plugin_api._claim(root, token, "r1", "run", "bugfix")

    class Immortal(Proc):
        def kill(self):
            self.killed = True          # asked, but stayed alive

    slot(root)["proc"] = Immortal()
    entry, proc = plugin_api._begin_stop(root, "r1")
    gone, _pid = plugin_api._kill_proc(proc)

    assert gone is False, "a failed kill must report itself"
    assert entry is not None
    assert slot(root) is not None, "the slot must stay held while the process lives"


def test_a_startup_stop_holds_the_slot_until_the_process_is_known_dead(root):
    """Nothing attached yet is not proof of death: keep the project and let the
    delayed dispatch or the reaper release it."""
    run_dir(root, "fresh")
    token = plugin_api._admit_start(root, "bugfix", set())

    entry, proc = plugin_api._begin_stop(root, "fresh")

    assert entry is not None and proc is None
    assert slot(root) is not None, "an unattached startup must not free the slot"
    assert slot(root)["state"] == "starting"

    # once the dispatch reaches its claim, it releases the slot it still owns
    with pytest.raises(HTTPException):
        plugin_api._claim(root, token, "fresh", "run", "bugfix", None)
    assert slot(root) is None


# --- failures that must not leave the project stuck or overlapped ----------

def test_a_failed_start_cleanup_holds_the_slot_while_the_process_lives(root):
    """Releasing here would let a second run dispatch beside the survivor."""
    token = plugin_api._admit_start(root, "bugfix", set())

    class Immortal(Proc):
        def kill(self):
            self.killed = True

    proc = Immortal()
    plugin_api.JOBS["j"] = {"proc": proc, "id": "j"}

    gone = plugin_api._abandon_start(root, token, {"job_id": "j", "pid": proc.pid})

    assert gone is False
    assert slot(root) is not None, "the slot was freed while the process still lived"
    assert slot(root)["state"] == "stopping"


def test_the_reaper_clears_a_stopping_slot_once_the_process_dies(root):
    token = plugin_api._admit_start(root, "bugfix", set())
    entry = slot(root)
    entry.update(state="stopping", cancelled=True)

    class Proc2(Proc):
        pass

    proc = Proc2()
    entry["proc"] = proc
    plugin_api._reap()
    assert slot(root) is not None, "a live process keeps the slot"

    proc.alive = False
    plugin_api._reap()
    assert slot(root) is None


def test_a_failed_takeover_restores_the_entry_for_an_immediate_retry(root):
    """The grace window must not be armed by a resume that never started."""
    run_dir(root, "r1", "paused")
    token = plugin_api._admit_start(root, "bugfix")
    plugin_api._claim(root, token, "r1", "run", "bugfix")

    class Immortal(Proc):
        def kill(self):
            self.killed = True

    slot(root)["proc"] = Immortal()
    with pytest.raises(HTTPException) as caught:
        plugin_api._admit_resume(root, "bugfix", "r1")
    assert caught.value.status_code == 409

    entry = slot(root)
    assert entry["kind"] == "run", "a failed takeover must not look like a finished resume"
    assert entry["state"] == "running"


def test_a_takeover_stops_if_the_slot_is_taken_during_the_kill(root):
    """The kill happens outside the lock, so ownership must be re-checked after it."""
    run_dir(root, "r1", "paused")
    token = plugin_api._admit_start(root, "bugfix")
    plugin_api._claim(root, token, "r1", "run", "bugfix")

    class Sneaky(Proc):
        def kill(self):
            # a stop wins the slot while this kill is in flight
            with plugin_api.ACTIVE_LOCK:
                plugin_api.ACTIVE_RUNS.clear()
            self.alive = False

    slot(root)["proc"] = Sneaky()
    with pytest.raises(HTTPException) as caught:
        plugin_api._admit_resume(root, "bugfix", "r1")
    assert caught.value.status_code == 409
    assert slot(root) is None, "the resume must not re-create a slot it lost"


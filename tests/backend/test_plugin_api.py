"""Tests for the Spec-Kit Hermes backend router.

Two layers:
  * HTTP behaviour through the real prefix the gateway mounts
    (``/api/plugins/spec-kit-hermes``) via Starlette's TestClient;
  * a real Kanban round trip against a throwaway ``hermes_cli.kanban_db``
    (skipped when the Hermes package is not importable).
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

BACKEND_DIR = Path(__file__).resolve().parents[2] / "dashboard"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

spec = importlib.util.spec_from_file_location("speckit_plugin_api", BACKEND_DIR / "plugin_api.py")
plugin_api = importlib.util.module_from_spec(spec)
# Register before exec so pydantic resolves the module's string annotations by name —
# the same reason hermes_cli/web_server_dashboard.py registers the plugin module first.
sys.modules["speckit_plugin_api"] = plugin_api
spec.loader.exec_module(plugin_api)

PREFIX = "/api/plugins/spec-kit-hermes"


@pytest.fixture
def app() -> FastAPI:
    app = FastAPI()
    app.include_router(plugin_api.router, prefix=PREFIX)
    return app


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    (root / ".specify").mkdir(parents=True)
    return root


def _put(client, **body):
    return client.put(f"{PREFIX}/file", json=body)


def _files(client, cwd: Path):
    return client.get(f"{PREFIX}/files", params={"cwd": str(cwd)})


# ---------------------------------------------------------------------------
# status / read
# ---------------------------------------------------------------------------


def test_status_reports_allowlist(client):
    response = client.get(f"{PREFIX}/status")
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["allowed_paths"] == ["spec.md", "memory/constitution.md", "tasks.md"]


def test_reads_empty_project(client, project):
    response = _files(client, project)
    assert response.status_code == 200
    payload = response.json()
    assert payload["exists"] is True
    assert set(payload["files"]) == {"spec.md", "memory/constitution.md", "tasks.md"}
    for entry in payload["files"].values():
        assert entry == {"exists": False, "content": "", "mtime": None}


def test_reads_existing_file(client, project):
    (project / ".specify" / "tasks.md").write_text("# Task List: x\n", encoding="utf-8")
    payload = _files(client, project).json()
    entry = payload["files"]["tasks.md"]
    assert entry["exists"] is True
    assert entry["content"] == "# Task List: x\n"
    assert isinstance(entry["mtime"], int)


# ---------------------------------------------------------------------------
# write / conflict
# ---------------------------------------------------------------------------


def test_creates_file_with_nested_directory(client, project):
    response = _put(
        client,
        cwd=str(project),
        path="memory/constitution.md",
        content="# Project Constitution\n",
        base_mtime=None,
    )
    assert response.status_code == 200, response.text
    written = project / ".specify" / "memory" / "constitution.md"
    assert written.read_text(encoding="utf-8") == "# Project Constitution\n"
    assert response.json()["mtime"] == int(written.stat().st_mtime_ns // 1_000_000)


def test_write_returns_conflict_when_file_appeared(client, project):
    (project / ".specify" / "spec.md").write_text("theirs\n", encoding="utf-8")
    response = _put(client, cwd=str(project), path="spec.md", content="mine\n", base_mtime=None)
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["conflict"] is True
    assert detail["content"] == "theirs\n"
    assert (project / ".specify" / "spec.md").read_text(encoding="utf-8") == "theirs\n"


def test_write_returns_conflict_on_stale_mtime(client, project):
    target = project / ".specify" / "spec.md"
    target.write_text("v1\n", encoding="utf-8")
    first = _files(client, project).json()["files"]["spec.md"]["mtime"]

    ok = _put(client, cwd=str(project), path="spec.md", content="v2\n", base_mtime=first)
    assert ok.status_code == 200
    stale = _put(client, cwd=str(project), path="spec.md", content="v3\n", base_mtime=first)
    assert stale.status_code == 409
    assert stale.json()["detail"]["content"] == "v2\n"
    assert target.read_text(encoding="utf-8") == "v2\n"


def test_write_with_fresh_mtime_succeeds(client, project):
    target = project / ".specify" / "spec.md"
    target.write_text("v1\n", encoding="utf-8")
    mtime = _files(client, project).json()["files"]["spec.md"]["mtime"]
    response = _put(client, cwd=str(project), path="spec.md", content="v2\n", base_mtime=mtime)
    assert response.status_code == 200
    assert target.read_text(encoding="utf-8") == "v2\n"


def test_write_preserves_content_byte_for_byte(client, project):
    body = "# Spec\n\n## Unknown Section\n\n<div>keep me</div>\n\n- [x] done item\n"
    _put(client, cwd=str(project), path="spec.md", content=body, base_mtime=None)
    assert (project / ".specify" / "spec.md").read_text(encoding="utf-8") == body


# ---------------------------------------------------------------------------
# refusals
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    ["../escape.md", "memory/../../escape.md", "/etc/passwd", "notes.md", "memory/other.md", ""],
)
def test_refuses_paths_outside_the_allowlist(client, project, path):
    response = _put(client, cwd=str(project), path=path, content="x", base_mtime=None)
    assert response.status_code in (400, 422), response.text
    assert not (project.parent / "escape.md").exists()


def test_refuses_relative_cwd(client):
    response = _files(client, Path("relative/dir"))
    assert response.status_code == 400
    assert "absolute" in response.json()["detail"]


def test_refuses_missing_cwd(client, tmp_path):
    response = client.get(f"{PREFIX}/files", params={"cwd": str(tmp_path / "nope")})
    assert response.status_code == 400
    assert "not a directory" in response.json()["detail"]


# ---------------------------------------------------------------------------
# kanban
# ---------------------------------------------------------------------------


def _hermes_importable() -> bool:
    try:
        import hermes_cli.kanban_db  # noqa: F401
    except Exception:
        return False
    return True


@pytest.fixture
def kanban_home(tmp_path: Path, monkeypatch):
    """A throwaway HERMES_HOME so the Kanban DB is not the user's board."""
    if not _hermes_importable():
        pytest.skip("hermes_cli not importable")
    home = tmp_path / "hermes-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    for key in ("HERMES_KANBAN_DB", "HERMES_KANBAN_BOARD", "HERMES_DELEGATED_CHILD_CONTEXT"):
        monkeypatch.delenv(key, raising=False)
    return home


def test_kanban_sync_creates_and_dedupes(client, project, kanban_home):
    body = {
        "cwd": str(project),
        "tasks": [
            {"title": "Implement FR-1: login", "body": "desc", "story": "FR-1"},
            {"title": "Implement FR-2: logout", "body": "desc", "story": "FR-2"},
        ],
    }
    first = client.post(f"{PREFIX}/kanban/sync", json=body)
    assert first.status_code == 200, first.text
    created = first.json()["created"]
    assert [c["story"] for c in created] == ["FR-1", "FR-2"]

    second = client.post(f"{PREFIX}/kanban/sync", json=body)
    assert second.status_code == 200
    assert second.json()["created"] == []
    assert [s["task_id"] for s in second.json()["skipped"]] == [c["task_id"] for c in created]

    links = client.get(f"{PREFIX}/kanban/links", params={"cwd": str(project)})
    assert links.status_code == 200
    rows = {row["story"]: row for row in links.json()["links"]}
    assert set(rows) == {"FR-1", "FR-2"}
    assert rows["FR-1"]["status"] == "ready"
    assert rows["FR-1"]["done"] is False


def test_kanban_links_are_scoped_to_the_project(client, project, tmp_path, kanban_home):
    client.post(
        f"{PREFIX}/kanban/sync",
        json={"cwd": str(project), "tasks": [{"title": "a", "story": "FR-1"}]},
    )
    other = tmp_path / "other"
    (other / ".specify").mkdir(parents=True)
    links = client.get(f"{PREFIX}/kanban/links", params={"cwd": str(other)}).json()["links"]
    assert links == []


def test_kanban_sync_rejects_bad_cwd(client, tmp_path):
    response = client.post(
        f"{PREFIX}/kanban/sync", json={"cwd": str(tmp_path / "missing"), "tasks": [{"title": "a"}]}
    )
    assert response.status_code == 400

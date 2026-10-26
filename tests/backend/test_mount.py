"""Mount the plugin through Hermes' OWN dashboard-plugin pipeline.

This is the integration proof that matters: it runs the real
``_discover_dashboard_plugins`` + ``_mount_one_plugin_api`` from
``hermes_cli.web_server_dashboard`` against this repo's ``backend/`` files
copied into a temp ``<hermes home>/plugins/`` tree, then calls the route over
HTTP.

If Hermes' dashboard code is not importable in this interpreter the test skips;
the pane then fails loudly, which is better than a false green.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "dashboard"

# Every test here drives Hermes' own plugin pipeline, so the whole module is
# `hermes`-marked: CI runs it in the integration job that installs Hermes, and the
# router suite deselects it rather than skipping it.
pytestmark = pytest.mark.hermes


@pytest.fixture(scope="module")
def dashboard():
    """Hermes' dashboard module, or a skip.

    Imported in a fixture, not at module scope: a module-level importorskip raises
    during collection, which reports as a skipped module even when the marker
    would have deselected every test in it.
    """
    return pytest.importorskip(
        "hermes_cli.web_server_dashboard",
        reason="hermes_cli dashboard code not importable in this interpreter",
    )


@pytest.fixture
def installed(tmp_path: Path) -> Path:
    """A ``<root>/plugins/spec-kit-hermes`` tree laid out exactly as install.mjs does."""
    plugins_root = tmp_path / "home" / "plugins"
    target = plugins_root / "spec-kit-hermes" / "dashboard"
    target.mkdir(parents=True)
    for name in ("plugin_api.py", "index.js"):
        shutil.copy2(BACKEND_DIR / name, target / name)
    shutil.copy2(BACKEND_DIR / "manifest.json", target / "manifest.json")
    return plugins_root


def test_discovery_finds_the_manifest(dashboard, installed: Path):
    found = dashboard._discover_dashboard_plugins([(installed, "user")])
    entry = next((p for p in found if p["name"] == "spec-kit-hermes"), None)
    assert entry is not None, [p["name"] for p in found]
    assert entry["has_api"] is True
    assert entry["_api_file"] == "plugin_api.py"
    assert entry["source"] == "user"


def test_mount_serves_the_router_on_the_gateway_prefix(dashboard, installed: Path):
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    entry = next(p for p in dashboard._discover_dashboard_plugins([(installed, "user")]) if p["name"] == "spec-kit-hermes")

    app = FastAPI()
    mounted = dashboard._mount_one_plugin_api(app, entry, {"spec-kit-hermes"}, set())
    assert mounted is True, "the trust gate refused the plugin"

    client = TestClient(app)
    response = client.get("/api/plugins/spec-kit-hermes/status")
    assert response.status_code == 200, response.text
    assert response.json()["plugin"] == "spec-kit-hermes"
    assert response.json()["allowed_paths"] == ["spec.md", "memory/constitution.md", "tasks.md"]


def test_mount_is_refused_without_consent(dashboard, installed: Path):
    """A user plugin that is not in plugins.enabled must not run Python."""
    from fastapi import FastAPI

    entry = next(p for p in dashboard._discover_dashboard_plugins([(installed, "user")]) if p["name"] == "spec-kit-hermes")
    app = FastAPI()
    assert dashboard._mount_one_plugin_api(app, entry, set(), set()) is False

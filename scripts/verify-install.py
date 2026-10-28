"""Prove the INSTALLED plugin is discoverable, consented, and serving.

Run after `node scripts/install.mjs`:

    # Windows (PowerShell)
    $env:PYTHONPATH="$env:LOCALAPPDATA/hermes/hermes-agent"; python scripts/verify-install.py [--profile <your-profile>]

    # Linux/macOS (bash/zsh)
    PYTHONPATH="$HOME/.hermes/hermes-agent" python scripts/verify-install.py [--profile <your-profile>]

The --home argument takes the **Hermes root home** (directory containing plugins/,
desktop-plugins/, and profiles/), not a profile subdirectory. It defaults to:
- Windows: %LOCALAPPDATA%\\hermes
- Linux/macOS: ~/.hermes

The --profile argument targets a specific profile for the consent check
(plugins.enabled in that profile's config.yaml). If omitted, it auto-detects
from the home path or falls back to 'default'.

It uses Hermes' own discovery + mount functions against the real Hermes root
home (not a temp copy), then drives the mounted router over HTTP: read the
three files from a temp project, write one, and confirm the 409 conflict path.
Exits non-zero on the first failed assertion, so it can be used as a
post-install gate.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path

HERMES_HOME = Path(
    os.environ.get("HERMES_HOME")
    or Path(os.environ.get("LOCALAPPDATA") or os.environ.get("HOME") or "") / ".hermes"
)
PLUGIN = "spec-kit-hermes"


def _auto_detect_profile(home: Path) -> str:
    """Extract profile from home path if it contains /profiles/<name>/."""
    parts = home.parts
    for i, part in enumerate(parts):
        if part == "profiles" and i + 1 < len(parts):
            return parts[i + 1]
    # If home is the root hermes dir, check for exactly one profile in profiles/
    profiles_dir = home / "profiles"
    if profiles_dir.is_dir():
        profiles = [p.name for p in profiles_dir.iterdir() if p.is_dir()]
        if len(profiles) == 1:
            return profiles[0]
    return "default"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default=None)
    parser.add_argument("--home", default=str(HERMES_HOME))
    args = parser.parse_args()

    home = Path(args.home)
    root = home
    # Auto-detect profile if not explicitly provided
    profile = args.profile or os.environ.get("HERMES_PROFILE") or _auto_detect_profile(home)
    if root.name == profile and root.parent.name == "profiles":
        root = root.parent.parent

    # Discovery resolves user plugins from the process home and the default root.
    os.environ["HERMES_HOME"] = str(root / "profiles" / profile)

    from hermes_cli.web_server_dashboard import (
        _discover_dashboard_plugins,
        _mount_one_plugin_api,
    )

    entries = [p for p in _discover_dashboard_plugins() if p["name"] == PLUGIN]
    assert entries, f"discovery did not find {PLUGIN} under {root}/plugins"
    entry = entries[0]
    print(f"discovered   : {entry['name']} ({entry['source']}) api={entry['_api_file']}")
    print(f"dashboard dir: {entry['_dir']}")
    assert entry["has_api"], "manifest declares no usable api file"

    # The backend installs these into a new project on /init. If they did not come
    # with the install, /init silently writes nothing and every gate is unanswerable.
    bundle_dir = Path(entry["_dir"]).parent / "workflows"
    bundled = sorted(p.parent.name for p in bundle_dir.glob("*/workflow.yml"))
    print(f"workflows    : {bundled or 'MISSING'}")
    assert bundled == ["assess", "bugfix", "speckit"], (
        f"expected the three bundled workflows beside dashboard/, found {bundled} in {bundle_dir}"
    )

    # Consent: the active profile's config must list the plugin. ruamel is what Hermes
    # itself parses config with, so prefer it and fail loudly on a duplicate key instead
    # of silently reading whichever copy wins.
    config_path = root / "profiles" / profile / "config.yaml"
    text = config_path.read_text(encoding="utf-8")
    try:
        from ruamel.yaml import YAML

        config = YAML(typ="safe").load(text) or {}
    except ImportError:  # PyYAML is the fallback when ruamel is not installed
        import yaml

        config = yaml.safe_load(text) or {}
    enabled = set((config.get("plugins") or {}).get("enabled") or [])
    disabled = set((config.get("plugins") or {}).get("disabled") or [])
    assert PLUGIN in enabled, f"{PLUGIN} missing from plugins.enabled in {config_path}"
    assert PLUGIN not in disabled, f"{PLUGIN} is explicitly disabled in {config_path}"
    print(f"consent      : enabled in {config_path}")

    from fastapi import FastAPI
    from starlette.testclient import TestClient

    app = FastAPI()
    assert _mount_one_plugin_api(app, entry, enabled, disabled) is True, "the mount gate refused the plugin"
    client = TestClient(app)
    prefix = f"/api/plugins/{PLUGIN}"

    status = client.get(f"{prefix}/status")
    assert status.status_code == 200, status.text
    print(f"GET  {prefix}/status -> {status.status_code} {status.json()}")

    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp) / "proj"
        (project / ".specify").mkdir(parents=True)

        empty = client.get(f"{prefix}/files", params={"cwd": str(project)})
        assert empty.status_code == 200, empty.text
        assert all(not f["exists"] for f in empty.json()["files"].values())
        print(f"GET  {prefix}/files (empty project) -> 200, 3 files absent")

        written = client.put(
            f"{prefix}/file",
            json={"cwd": str(project), "path": "spec.md", "content": "# Feature Specification: verify\n", "base_mtime": None},
        )
        assert written.status_code == 200, written.text
        mtime = written.json()["mtime"]
        on_disk = (project / ".specify" / "spec.md").read_text(encoding="utf-8")
        assert on_disk == "# Feature Specification: verify\n", on_disk
        print(f"PUT  {prefix}/file -> 200, wrote {len(on_disk)} bytes to {project}/.specify/spec.md")

        conflict = client.put(
            f"{prefix}/file",
            json={"cwd": str(project), "path": "spec.md", "content": "stale\n", "base_mtime": mtime - 1},
        )
        assert conflict.status_code == 409, conflict.text
        assert conflict.json()["detail"]["conflict"] is True
        print(f"PUT  {prefix}/file (stale mtime) -> 409 with the winning copy")

        refused = client.put(
            f"{prefix}/file",
            json={"cwd": str(project), "path": "../escape.md", "content": "x", "base_mtime": None},
        )
        assert refused.status_code == 400, refused.text
        print(f"PUT  {prefix}/file (../escape.md) -> 400 refused")

        links = client.get(f"{prefix}/kanban/links", params={"cwd": str(project)})
        assert links.status_code == 200, links.text
        print(f"GET  {prefix}/kanban/links -> 200 ({len(links.json()['links'])} linked cards)")

    print("\nOK — installed plugin is discovered, consented, mounted and serving.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Check that the manifests parse and agree with each other.

CI runs this because the backend suite needs a Hermes install, which the runner
does not have. It catches the class of mistake that shipped twice here: a
manifest edited in one place and not the other.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("pyyaml is required: pip install pyyaml", file=sys.stderr)
    raise SystemExit(2)

ROOT = Path(__file__).resolve().parents[1]
MANIFESTS = ("plugin.yaml",)
PACKAGES = ("package.json", "dashboard/manifest.json")


def main() -> int:
    parsed = {}
    for name in MANIFESTS:
        path = ROOT / name
        if not path.is_file():
            print(f"missing: {name}", file=sys.stderr)
            return 1
        parsed[name] = yaml.safe_load(path.read_text(encoding="utf-8"))

    for name in PACKAGES:
        path = ROOT / name
        if not path.is_file():
            print(f"missing: {name}", file=sys.stderr)
            return 1
        json.loads(path.read_text(encoding="utf-8"))

    root = parsed["plugin.yaml"]
    npm = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))

    problems = []
    if root.get("name") != npm.get("name"):
        problems.append(f"plugin.yaml name={root.get('name')!r} but package.json name={npm.get('name')!r}")
    if not root.get("requires_hermes"):
        problems.append("plugin.yaml has no requires_hermes floor")

    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1

    print(f"manifests parse and agree (version {root.get('version')})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

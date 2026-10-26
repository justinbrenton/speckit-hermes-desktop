#!/usr/bin/env python3
"""Fail when the backend suite skips tests it is not expected to skip.

Some tests need Hermes internals (`hermes_cli.web_server_dashboard`), which a CI
runner does not have, so they skip. That is honest, but a skip and a pass look
identical in a green build, and a new silent skip is how coverage quietly
disappears. This reads the JUnit report and refuses anything outside the known
set.

Usage:
    python -m pytest tests/backend -q --junitxml=junit.xml
    python scripts/check-skips.py junit.xml
"""

from __future__ import annotations

import sys
from pathlib import Path

# The report is this project's own pytest output, but parse it defensively anyway:
# defusedxml refuses entity expansion, and a report from a fork or a cache is not
# worth trusting with a parser that expands entities.
try:
    import defusedxml.ElementTree as ET  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - fallback for a bare interpreter
    import xml.etree.ElementTree as ET  # type: ignore[no-redef]

#: Nothing should skip in CI. The Hermes-backed tests are deselected by marker and
#: run in their own job, so a skip here means something broke, or someone added a
#: skip to make a red build green. Entries are (module fragment, test name or None,
#: why); keep this list empty unless a skip is genuinely unavoidable.
ALLOWED: list[tuple[str, str | None, str]] = []


def _allowed(module: str, test_name: str) -> tuple[bool, str]:
    for fragment, wanted, why in ALLOWED:
        if fragment not in module:
            continue
        # A collection skip reports the module itself as the test name.
        if wanted is None or test_name == wanted or test_name == module:
            return True, why
    return False, ""


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    report = Path(argv[1])
    if not report.is_file():
        # The suite step already failed and reported why; adding a second red step
        # here would only hide that.
        print(f"no JUnit report at {report}, nothing to check")
        return 0

    root = ET.parse(report).getroot()
    suites = root.findall(".//testsuite") or [root]

    total = skipped = 0
    unexpected: list[str] = []
    for suite in suites:
        for case in suite.findall("testcase"):
            total += 1
            skip = case.find("skipped")
            if skip is None:
                continue
            skipped += 1
            name = case.get("file") or case.get("classname") or case.get("name") or "?"
            path = name.replace("\\", "/")
            test_name = case.get("name") or ""
            allowed, why = _allowed(path, test_name)
            reason = (skip.get("message") or "").strip().splitlines()[:1]
            label = f"{path}::{test_name}"
            if allowed:
                print(f"skipped (known, {why}): {label} - {reason[0] if reason else 'no reason given'}")
            else:
                print(f"skipped (UNEXPECTED): {label} - {reason[0] if reason else 'no reason given'}")
                unexpected.append(label)

    print(f"\n{total} tests, {skipped} skipped, {len(unexpected)} unexpected")
    if unexpected:
        print("\nA test that skips in CI is coverage nobody has. Mark it `hermes` and let", file=sys.stderr)
        print("the integration job run it, or make it runnable here.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

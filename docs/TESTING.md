# Tests

Two suites, and they answer different questions.

| Suite | Command | What it proves |
|---|---|---|
| Node | `npm test` | The pane's decisions (`src/core.mjs`), the build, the installer's path handling |
| Backend, router | `python -m pytest tests/backend -q -m "not hermes"` | Routes, discovery, workflow bridge, artifacts, gates, settings, browse |
| Backend, Hermes | `python -m pytest tests/backend -q -m hermes` | Dashboard mounting and the Kanban bridge, through Hermes' own code |

The split is not cosmetic. The `hermes` tests import `hermes_cli.web_server_dashboard` and
`hermes_cli.kanban_db_connect`, so they mean nothing on an interpreter without Hermes.
Marking them lets each suite say what it actually ran: the router suite deselects them
rather than skipping them, so its pass count is every test it executed.

## Running without Hermes

```
npm install
npm test

python -m pip install -r requirements-dev.txt
python -m pytest tests/backend -q -m "not hermes"
```

`requirements-dev.txt` is fastapi, pydantic, PyYAML, pytest, httpx and defusedxml.
CI installs it before pytest for the same reason: the suite does not run without
them, and a fresh checkout does not have them.

111 backend tests that need only FastAPI, and 5 that need Hermes, 116 in total. With the 50
node tests that is 166, and nothing skips: `pytest.ini` sets `--strict-markers`, so a mistyped
marker is an error rather than a silently ignored test.

## Running with Hermes

Point `PYTHONPATH` at a Hermes install and run the `hermes` suite, or drop the marker to
run all 99:

```
PYTHONPATH=/path/to/hermes-agent python -m pytest tests/backend -q
```

The tests create their own throwaway `HERMES_HOME`, so they never touch a real board.

## Before a push

```
npm run preflight
```

That is the build, both suites, every test count stated anywhere in the docs, and the
rendered `docs/design.html`. It exits non-zero if any of them disagree, which is how a
stale number in a document gets caught before it is published rather than after.

`npm run hooks` installs a pre-commit hook that runs it, so a commit cannot land on a red
gate by accident. `--no-verify` still works, on purpose, for the case where that is the
right call.

## What CI runs

- `node` on Ubuntu, macOS and Windows (the installer's path logic is JavaScript, and the
  one POSIX bug found so far came from porting, not from reading).
- `backend (router)` on Ubuntu, macOS and Windows, plus Python 3.13 on Ubuntu.
- `backend (hermes integration)` on Ubuntu, against a pinned Hermes commit.
- `manifests`, which parses every manifest and fails if they disagree.

CI also fails on any skip. `scripts/check-skips.py` reads the JUnit report and rejects
anything not expected, because a skip and a pass look identical in a green build.

## What no suite covers

- **A real `specify` dispatch.** That needs the CLI and a model, so it is verified by hand:
  see `docs/VERIFICATION.md`.
- **The rendered pane.** The suites check that components are wired and that the built
  bundle exports a plugin; they do not draw anything. Screenshots are the only check.
- **Anything on a platform without a runner here**, which currently means arm64.

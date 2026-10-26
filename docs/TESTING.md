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
python -m pytest tests/backend -q -m "not hermes"
```

72 backend tests and 40 node tests, 77 backend tests in total once the Hermes ones are included. Nothing skips; `pytest.ini` sets `--strict-markers`,
so a mistyped marker is an error rather than a silently ignored test.

## Running with Hermes

Point `PYTHONPATH` at a Hermes install and run the `hermes` suite, or drop the marker to
run all 77:

```
PYTHONPATH=/path/to/hermes-agent python -m pytest tests/backend -q
```

The tests create their own throwaway `HERMES_HOME`, so they never touch a real board.

## What CI runs

- `node` on Ubuntu and Windows (the installer's path logic is JavaScript, and the one
  POSIX bug found so far came from porting, not from reading).
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

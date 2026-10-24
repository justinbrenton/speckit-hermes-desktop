# Spec-Kit for Hermes Desktop (v2)

One pane in the right sidebar, three steps, real files:

```
Spec  ──▶  Constitution  ──▶  Tasks
 │            │                 │
 ▼            ▼                 ▼
.specify/spec.md   .specify/memory/constitution.md   .specify/tasks.md
                                                 │
                                                 ▼
                                        Kanban cards (hermes_cli.kanban_db)
```

v1 registered three separate panes that rendered hard-coded placeholder content and
never touched the disk. v2 replaces them with a single wizard that reads and writes
the project's `.specify/` directory and syncs tasks to the Kanban board.

## What actually runs

Two halves, because that is the only supported way for a desktop plugin to touch files:

| Half | Path in the Hermes home | What it does |
|------|------------------------|--------------|
| Desktop | `desktop-plugins/spec-kit-hermes/plugin.js` | One pane, stepper, editors, debounced saves, poll-based file watcher |
| Backend | `plugins/spec-kit-hermes/dashboard/plugin_api.py` | FastAPI router mounted at `/api/plugins/spec-kit-hermes`: allowlisted file I/O with optimistic concurrency, Kanban sync |

The pane reaches the backend through `ctx.rest('/files')`, which is scoped to
`/api/plugins/<plugin id>` by construction. There is no filesystem in the renderer
and no read/write method on the gateway JSON-RPC surface — see
[docs/VERIFICATION.md](docs/VERIFICATION.md) for the checks behind that claim.

## Repo layout

```
src/core.mjs              pure model layer, unit-tested (parsers, gate, stepper, sync state)
src/pane.js               pane UI + registration; imports only @hermes/plugin-sdk + react
scripts/build.mjs         inlines core into desktop/plugin.js (single ESM file)
scripts/install.mjs       copies both halves into a Hermes home and enables the plugin
scripts/config-enable.mjs surgical `plugins.enabled` edit for config.yaml
backend/plugin_api.py     FastAPI router (paths are allowlisted to three files)
backend/tests/            HTTP behaviour tests + a REAL mount through Hermes' dashboard pipeline
test/                     node --test suites for the core, the build artifact, config edit
docs/VERIFICATION.md      every claim with the command and the observed result
```

## Install

```bash
npm run build            # src -> desktop/plugin.js
node scripts/install.mjs --profile codie
```

Then fully quit Hermes Desktop (every `Hermes.exe`) and start it again — the runtime
plugin loader reads `plugin.js` at app start. The pane shows up as **Spec Kit** in the
right sidebar, and a `Spec Kit` chip in the status bar focuses it.

`--dry-run` prints what would change. The installer backs up an existing
`plugin.js` to `plugin.js.backup` and the profile's `config.yaml` to
`config.yaml.speckit-backup`.

## Use

1. **Spec** — add requirements, descriptions, priorities and acceptance criteria.
   Live constitution gate: a spec is "planning ready" only when the constitution is
   ratified, requirements exist, and at most three clarifications are open.
2. **Constitution** — five steps (purpose → principles → architecture → governance →
   ratify). Answers are written to `.specify/memory/constitution.md` on ratify and are
   re-hydrated from that file when the pane reopens.
3. **Tasks** — `From spec` derives one task per requirement that has no task yet,
   `To Kanban` creates the cards (idempotent per requirement), `From Kanban` pulls card
   status back and ticks the matching acceptance criteria in `spec.md`.

Edits save 700 ms after you stop typing. Every 3 s the pane re-reads the three files:
an external edit reloads the editor, and if you have unsaved local edits at the same
time it shows a conflict banner — *Keep mine* overwrites with a fresh mtime,
*Take theirs* discards the local edit.

## Tests

```bash
npm test                                        # 36 node tests
python -m pytest backend/tests -q               # 22 python tests (needs fastapi/httpx/pytest)
```

The Python suite that matters is `backend/tests/test_mount.py`: it copies the backend
into a temp `<home>/plugins/` tree, runs Hermes' own
`_discover_dashboard_plugins` + `_mount_one_plugin_api`, and asserts
`GET /api/plugins/spec-kit-hermes/status` returns 200 — i.e. the gateway will serve
these routes, without hand-waving.

`PYTHONPATH` must include the Hermes install for that test:

```bash
PYTHONPATH="$LOCALAPPDATA/hermes/hermes-agent" python -m pytest backend/tests -q
```

## Known limits

- **File watching is polling, not inotify/chokidar.** A desktop plugin has no Node
  filesystem access (verified), and the backend router has no push channel wired here.
  3 s polling is the honest implementation; add a WebSocket route if that latency hurts.
- **No SDK `Stepper` component exists.** The stepper is built from `Button` + `Badge`.
- **Constitution writes are whole-file.** The wizard owns that file; hand-edited prose
  outside the sections it generates is not preserved. `spec.md` and `tasks.md` are
  surgically rewritten — every other section survives byte-for-byte.
- **Kanban sync creates cards only.** Cards are tagged with an idempotency key
  (`speckit:<project hash>:<FR-n>`) so re-syncing never duplicates; the pane reads their
  status back but does not delete or rename cards.

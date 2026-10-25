# Spec-Kit for Hermes Desktop

A guided pane in Hermes Desktop that runs [spec-kit](https://github.com/github/spec-kit)
processes — Spec-Driven Development, bug fixing, idea assessment — without leaving the app.

The pane holds no workflow logic. spec-kit's own engine runs the steps
(`specify workflow run|resume`); the pane renders the run, the artifact each step
produced, and the review gate that follows it.

```
choose process  ──▶  describe the work  ──▶  step runs  ──▶  artifact opens, editable
      │                                                              │
      └── SDD / bug fixing / idea assessment                        approve
                                                                     ▼
                                                              next step runs
```

## What it does

| | |
|---|---|
| **Processes** | The three spec-kit entry points, read from whatever is installed. Bug fixing and idea assessment are opt-in extensions, and the pane offers to install them. |
| **Paths** | SDD asks up front: the shorter path (`constitution → specify → plan → tasks → implement → converge`) or the full one (adds `clarify`, `checklist`, `analyze`). |
| **Gates** | Each review gate stops the run and opens the file it reviews — `spec.md`, `plan.md`, `assessment.md` — in an editor with **Approve / Reject** underneath. Edits are mtime-guarded, so a file changed on disk offers *Load the disk version* or *Keep mine* instead of clobbering. |
| **Questions** | `[NEEDS CLARIFICATION: …]` markers become a form; answers are written back in place and unanswered markers survive. |
| **Honesty** | Artifact mtimes are snapshotted before each step. A gate tells you when the step before it produced nothing — the engine reports success either way. |
| **Control** | Live step log, Stop, one run per project at a time, and history of previous runs. |

## How it is built

Two halves, because a desktop plugin's renderer has no filesystem:

| Half | Installed at | Stack |
|---|---|---|
| Desktop | `~/.hermes/desktop-plugins/spec-kit-hermes/plugin.js` | one ESM file, `@hermes/plugin-sdk` + React |
| Backend | `~/.hermes/plugins/spec-kit-hermes/dashboard/plugin_api.py` | FastAPI router at `/api/plugins/spec-kit-hermes` |

The pane reaches the backend through `ctx.rest`. Everything the pane shows comes
from those routes; nothing about a workflow is hard-coded in the UI.

```
src/core.mjs              pure model: parsers, and the wizard's decisions
                          (visibleInputs, flowSteps, progressFor, artifactForGate)
src/pane.js               the pane and its registration
scripts/build.mjs         inlines core into desktop/plugin.js, and fails the build
                          if a referenced component is undefined
scripts/install.mjs       copies both halves into a Hermes home
scripts/config-enable.mjs surgical `plugins.enabled` edit for config.yaml
backend/plugin_api.py     FastAPI router
backend/tests/            route behaviour, plus a real mount through Hermes' loader
test/                     node --test suites
docs/design.md            what exists, how it runs, what is missing
docs/VERIFICATION.md      the checks behind the claims
```

## Install

```bash
npm run build
node scripts/install.mjs --profile codie
```

The desktop loader discovers `desktop-plugins/*/plugin.js` at startup. Editing the
file does not hot-reload reliably — quit every `Hermes.exe` (and the gateway
`python.exe`) and reopen. The pane appears as **Spec Kit** in the right sidebar.

The backend half needs the plugin enabled in the Hermes home it runs under; the
installer adds the entry and backs the config up first.

## Requirements

- Hermes Desktop, with the Hermes CLI on `PATH` (the workflow engine dispatches
  `/speckit-*` skills through `hermes chat`).
- spec-kit's CLI: `uv tool install specify-cli`.
- The `speckit-*` skills in the profile's skill directory — `specify init
  --integration hermes` installs them.

**One local fix matters.** Upstream's `build_exec_args` accepts `project_root` and
ignores it, so a dispatched skill runs in the gateway's workspace and writes files
outside the project. The pane's `GET /integration/health` detects that and offers a
one-click re-apply, because a `uv tool upgrade` replaces the patched file.

## Tests

```bash
npm test                                            # 62 node tests
PYTHONPATH="$LOCALAPPDATA/hermes/hermes-agent" \
  python -m pytest backend/tests -q                 # 57 python tests
```

## Known limits

- **Windows specifics.** Gates pause only when stdin is a closed pipe; `NUL` reports
  itself as a TTY, so a gate then prompts, reads EOF, and records a rejection.
- **The API is spec-kit's, not ours.** Processes, steps, inputs and gates come from
  `workflow.yml`. Rules the engine does not express (like a declared `verdict_input`
  on a gate, without which no headless approval is possible) are patched into the
  installed file at init and repair time.
- **No folder dialog.** The plugin SDK exposes none, so the pane browses directories
  through the backend instead.
- **Dead code.** `src/core.mjs` still carries parsers and models from the abandoned
  three-editor design (`parseSpec`, `serializeTasks`, `constitutionGate`, …). The
  wizard does not call them.

MIT.

# Spec-Kit for Hermes Desktop

Status: working implementation, pre-release. This document describes what exists,
what it does, and what is deliberately not built yet. Every claim in the
"Verification" section came from a command that ran on this machine.

Last updated: 2026-10-24.

---

## 1. What this is

Spec-Kit is a specification-driven development toolkit: write a spec, derive a plan,
break the plan into tasks, implement. Upstream (`github/spec-kit`) does that with
markdown templates and CLI commands. Everything lands in a `.specify/` directory, and
you carry it between your editor, your terminal, and your agent by hand.

This project puts the same workflow inside Hermes Desktop as one guided pane. You
describe the feature in a sentence, the workflow's own steps run one at a time, and
every review gate stops and asks you before the next step. The files on disk stay the
source of truth, so anything else that reads `.specify/` or `specs/` still works.

The scope is narrow on purpose: one pane, one project at a time, and no workflow
logic in the pane itself.

---

## 2. Why not just install spec-kit and use the CLI

Because the loop breaks at the handoff. Stock spec-kit gives you files, and then you
are on your own: read `spec.md`, work out what changed, retype it into a prompt, run a
command, come back, read `tasks.md`, find which checkbox is yours. The documents are
correct and the workflow is still manual.

| Stock spec-kit | This |
|---|---|
| You remember which command comes next | The workflow's steps are the UI; the next action is the only button on screen |
| Gates are an interactive terminal prompt | A gate card with the declared options; approving resumes the run |
| You read the terminal to know what happened | A step tracker, plus the run's own state read off disk |
| Artifacts are files you go and find | The artifacts the run wrote are listed in the pane, read-only |
| A gate cannot be answered headless | `verdict_input` is added to generated gates, so resume works without a TTY |

What it does not do: replace spec-kit. Templates, preset, extension hooks and the
workflow all still come from the fork. The pane is the surface on top.

---

## 3. What exists today

Two halves, because that split is the only supported way for a desktop plugin to
touch files. The renderer has no filesystem access, and the gateway JSON-RPC surface
has no read or write method.

| Half | Installed path | Stack | Job |
|---|---|---|---|
| Desktop | `~/.hermes/desktop-plugins/spec-kit-hermes/plugin.js` | single ESM file, `@hermes/plugin-sdk` + React | One pane, stepper, editors, debounced saves, polling watcher, conflict banner |
| Backend | `~/.hermes/plugins/spec-kit-hermes/dashboard/plugin_api.py` | FastAPI router | Allowlisted file I/O with optimistic concurrency, Kanban sync |

The pane reaches the backend through `ctx.rest`, which Hermes scopes to
`/api/plugins/spec-kit-hermes`. The routes the pane uses:

| Route | Purpose |
|---|---|
| `GET /processes` | installed workflows with their inputs, steps and gate data |
| `POST /workflows/{process}/run` | spawn a run, return a job id at once |
| `GET /workflows/{process}/runs/latest` | newest run's status, step, gate |
| `POST /workflows/{process}/runs/{id}/resume` | answer a gate and continue |
| `GET /artifacts` | every artifact the run has written |
| `GET /artifact` | read one artifact, confined to `.specify/` and `specs/` |
| `POST /init` | `specify init --here --integration hermes`, then patch gates |
| `POST /repair-workflows` | add missing `verdict_input` to existing projects |

Reads and writes of whole files (`/files`, `/file`) and the Kanban routes
(`/kanban/sync`, `/kanban/links`) still exist from the editor era; the wizard does
not call them.

Three plugin kinds exist, and mixing them up caused most of the confusion in earlier
drafts:

| Kind | Manifest | Loaded by | Config |
|---|---|---|---|
| Desktop disk plugin | `plugin.js` (ESM) | auto-loaded from `desktop-plugins/<id>/` | `ctx.storage`, or its own backend |
| Agent plugin | `plugin.yaml` + Python | `hermes plugins install` | `config_schema` in `plugin.yaml` |
| Unified package | `plugin.yaml` + `desktop/plugin.js` | agent install copies the desktop half | `config_schema` |

This project is a desktop plugin with a dashboard backend. `desktop/plugin.yaml` ships
for packaging and version metadata; the disk loader does not read it, so there is no
`config_schema` here and settings belong in `ctx.storage`. The backend half does need
its plugin id in `plugins.enabled`, which is why the installer edits `config.yaml`.

---

## 4. How a session actually runs

```
open the pane on a project
   │  GET /processes  ──▶ installed workflows, their inputs, their steps
   ▼
describe               one textarea: what are you building?
   │  POST /workflows/<process>/run   ──▶ specify workflow run … --json
   ▼
steps                  the engine executes; the pane polls /runs/latest
   │                   command step → runs the agent, writes the artifact
   │                   gate step    → status: paused, the pane asks you
   │  POST …/runs/<id>/resume  -i gate_review_spec=approve
   ▼
artifacts              read-only, from <project>/specs/ and .specify/memory/
```

One screen, one decision at a time. The step tracker at the top shows where the
run is; the card below it is the only thing you can act on: Start, wait, approve
or reject. There is no separate "pick a process" screen in v1 — the pane drives
the `speckit` workflow and lists whatever else is installed once process choice
matters.

Requests return immediately. A step dispatches a model call that can run for
minutes, and the desktop's RPC bridge gives up at 30 seconds, so `run` and
`resume` spawn the CLI and return a job id; the pane polls
`GET /workflows/<process>/runs/latest` every two seconds while the engine works.

The pane authoring three files by hand is gone. `spec.md`,
`memory/constitution.md` and `tasks.md` are written by `/speckit-specify`,
`/speckit-constitution` and `/speckit-tasks` inside the workflow, so there is one
way to produce them and one place they come from. The pane still reads files, but
only as artifacts.

What the pane does not do, on purpose: run steps itself, decide what a process
means, or invent a gate. It reads the workflow, posts to three routes, and renders
what comes back.

### Where artifacts actually land

`specify init` scaffolds `.specify/`, but the skills write feature folders to
`<project>/specs/<NNN>-<name>/` — not `.specify/specs/`. The artifact listing
scans both locations plus `.specify/memory/constitution.md`, and the reader
refuses any path outside them.

### Gates need `verdict_input`

A gate can only be answered from outside a terminal when its workflow declares
which input carries the verdict:

```yaml
  - id: review-spec
    type: gate
    message: "Review the generated spec before planning."
    options: [approve, reject]
    verdict_input: gate_review_spec   # resume -i gate_review_spec=approve
    on_reject: abort
```

The engine checks `"verdict_input" in config` (see `workflows/step/gate/`), so a
stock gate without it ignores every `-i` you pass and pauses forever. `init` now
patches every installed workflow after scaffolding, and `POST
/repair-workflows` does the same for projects created earlier.

### What was removed

`src/core.mjs` used to carry the parsers and models of the abandoned three-editor
design: `parseSpec`/`serializeSpec`, `parseTasks`/`serializeTasks`, the constitution
builder and validator, the Kanban derivation helpers, the stepper state machine and
`dispatchMessage`. The wizard calls none of them — the skills write those files now.
They were deleted with their tests; `core.mjs` is 105 lines of wizard model, and
`plugin.js` lost roughly a third of its size in that pass (the sizes are in the commit).

### The wizard's decisions are testable

The pane's judgement calls — which inputs to ask for, where the run is, which file
a gate reviews — live in `src/core.mjs` as pure functions (`visibleInputs`,
`flowSteps`, `progressFor`, `artifactForGate`) and are covered by `npm test`. That
is where both reported defects came from: a gate whose id (`review-spec`) does not
follow its step's name (`specify`), and verdict carriers rendering as questions.
Matching gates by position, not by name, is the fix the test forced.

### The clarification interview

spec-kit marks ambiguity inline as `[NEEDS CLARIFICATION: ...]`, and its own
guidance is to resolve those by editing the artifact or telling the agent. The
pane turns them into a form instead: `GET /questions` lists the markers in the
open artifact, `POST /clarify` writes the answers back in place and reports how
many are still open. Unanswered markers survive, so the file never claims more
certainty than it has.

Answers replace the marker where it sits, so text around it stays. A marker at
the end of a sentence reads naturally; one embedded mid-clause can read awkwardly
("Shared team account accounts"). Editing the file directly is still the escape
hatch, and the editor is right there.

### A step that writes nothing is a failure, not a success

The engine reports a command step `completed` when its dispatch exits 0, even if
the agent wrote no artifact. `specify workflow run` gave exactly that during
testing: `exit_code 0, stdout ""`, and the only reason the constitution stage was
known to work was that the file changed.

So the backend snapshots artifact mtimes (`specs/`, `.specify/specs`,
`.specify/bugs`, `.specify/assessments`, `.specify/memory`) before each run and
resume, and `GET /runs/...` compares. When a gate is reached and nothing changed,
the pane says so before you approve. It is a warning, not a hard failure: some
steps legitimately edit nothing (analysis is read-only).

### You can watch a step work

A dispatch runs for minutes with nothing on screen. `GET /log` tails the newest
job log for the project (the same file the backend already writes for every
spawn), and the pane polls it every two seconds while a step runs, behind a
"Show log" toggle. Failures usually announce themselves there first — a missing
skill, an auth error — long before the artifact is checked.

### Run history

`GET /workflows/{process}/runs` lists every run on disk with its status, step and
the input that started it. The pane shows the last few under the artifacts, so a
previous attempt is identifiable by what it was asked to build rather than by a
hex id.

### One run at a time, and a way out

`POST /workflows/{process}/runs/{id}/stop` kills the dispatched process tree for
that project only, and a second Start while a run is active returns 409. Without
the lock, two clicks produce two concurrent runs writing the same files.

## 4.1 Processes: what the pane renders

Spec-kit is not one flow, and the pane must not pretend otherwise. It ships three
independent entry points and makes adding a fourth a configuration exercise:

| Process | Steps | Ships as | Artifacts |
|---|---|---|---|
| Spec-driven development | constitution, specify, plan, tasks, implement, converge (+ clarify, checklist, analyze as gates) | core | `.specify/specs/<feature>/` |
| Bug fixing | assess, gate, fix, test | extension `bug` + workflow `bugfix` | `.specify/bugs/<slug>/` |
| Idea assessment | intake, research, define, shape, decide, gate | extension `assess` + workflow `assess` | `.specify/assessments/<slug>/` |
| Your own | whatever you define | extension commands + a workflow | wherever it writes |

A workflow file is already the data model a GUI needs. Verified against
`workflows/bugfix/workflow.yml`:

```yaml
inputs:
  report:
    type: string
    required: true
    prompt: "Bug report (pasted text or URL)"
steps:
  - id: assess
    command: speckit.bug.assess
    input:
      args: "{{ inputs.report }} slug={{ inputs.slug }}"
  - id: review-assessment
    type: gate
    message: "Review the assessment before any code change."
    options: [approve, reject]
    on_reject: abort
```

Inputs carry their own prompts, so they are a form. Command steps carry their own
argument template, so they are a dispatch. Gates carry their own message, options
and reject behaviour, so they are a review panel. None of that needs per-process
code in the pane.

`GET /processes` returns exactly this, discovered from
`<project>/.specify/workflows/*/workflow.yml`. Each command step resolves to the
skill the Hermes integration installs (`speckit.bug.assess` → `speckit-bug-assess`)
and reports whether that skill is present, so a step can be disabled with a reason
instead of failing when you click it. A malformed workflow is reported per file and
does not take the pane down.

What the pane does with it:

1. Pick a process. The list is whatever is installed: SDD today, bug fixing and
   assessment when their bundles are installed, plus anything you write.
2. Fill the inputs the workflow declares.
3. Run the steps in order. A command step dispatches its skill with the rendered
   arguments; a gate stops and waits for approve or reject.
4. Show the artifacts the process wrote.

Rules that keep it expandable, in order of importance:

- No process names in the pane. It renders installed workflows.
- Gates are data. Options and `on_reject` come from the workflow, not from an `if`.
- Artifacts are paths the process declares, not file names hard-coded in the UI.
- Discovery goes through one route, so the CLI stays the source of truth for what
  a workflow means.

### Driving the engine, not reimplementing it

The plugin runs no workflow logic of its own. `specify workflow run|resume|status
--json` is the engine, and the backend is a bridge to it:

| Route | Spawns |
|---|---|
| `POST /workflows/{process}/run` | `specify workflow run <process> -i k=v --json` |
| `POST /workflows/{process}/runs/{id}/resume` | `specify workflow resume <id> -i gate_x=approve --json` |
| `GET /workflows/{process}/runs/{id}` | `specify workflow status <id> --json` |

Step types the engine supports beyond `command` and `gate` (shell, prompt, if,
switch, while, fan-out, fan-in, github, init, slot, nested workflow) come for free,
because the engine executes them. Run state, resume and history are already
`.specify/workflows/runs/<id>/` (`state.json`, `inputs.json`, `log.jsonl`), so the
pane reads it rather than keeping its own.

Two Windows findings that shaped this, both measured:

- **`stdin=DEVNULL` does not pause a gate.** NUL is a character device, so
  `sys.stdin.isatty()` answers True, the gate prompts, reads EOF, and the run
  aborts with `choice: reject`. Passing `input=""` (a pipe that closes
  immediately) makes it pause. The bridge uses the pipe.
- **A gate can only be answered through a declared input.** The schema rejects a
  gate whose `verdict_input` is not in `inputs:`, and without one there is no
  non-interactive way to say approve. Our bundle's workflow declares one input per
  gate.

The loop, end to end on this machine:

```
run      -> status=paused   current_step=review-spec
resume -i gate_review_spec=approve
         -> progressed to review-plan (the plan step ran) and paused there
```

The first run also wrote a real spec through `/speckit-specify`: the engine
dispatched `hermes chat -Q -s speckit-specify` and the pane-side output showed the
model noticing it had resolved `spec-template` from the `hermes-desktop` preset.

### Where the skills go

The docs say `~/.hermes/skills/`. On Windows the home is `%LOCALAPPDATA%\hermes`,
and a profile session reads `<home>/profiles/<name>/skills`; `get_hermes_home()`
resolves context override, then `HERMES_HOME`, then the platform default.

Measured here, because this is where the integration silently failed: the ten
skills were first installed to `C:\Users\<user>\.hermes\skills` and
`hermes skills list` showed none of them. After copying them into
`profiles/codie/skills` the listing showed ten and `-s speckit-specify` dispatched.
So `/processes` checks every candidate directory and counts a skill as installed
if any one of them has it.

The CLI already exposes the same inventory for the terminal: `specify workflow
list`, `specify extension list`, and `specify artifact` for commands, templates,
scripts and hooks. The pane reads the workflow files directly today because it
needs inputs and step bodies, which those listings do not include.

---

## 5. Planned versus built

The previous design described a different system. This is what survived contact.

| Planned | Built | Why it changed |
|---|---|---|
| Three panes: SpecBuilder, TaskBoard, ConstitutionWizard | One guided pane with a step tracker | Three sidebar tabs read as three unrelated apps, and the steps are sequential |
| The pane authors `spec.md`, `constitution.md`, `tasks.md` | The workflow's skills author them; the pane only reads | One producer means one format, and it matches what the CLI does |
| `SpecParser.ts` / `TasksParser.ts` on remark + mdast | Not needed | The pane no longer edits those files |
| `chokidar` file watching | 2 s polling of run state while a step is in flight; none when parked | No filesystem in the renderer, no push channel in the backend |
| `SpecifyCLIBridge` for init only | Built as `POST /init` + `POST /repair-workflows` | The CLI is the only thing that knows the template layout |
| `HermesDispatch` invoking `speckit-*` skills | Not built in the pane | The engine dispatches the skills itself; the pane never calls an agent |
| Kanban as the task surface | Not built | The workflow owns task state; a second board would need a sync rule |
| Implement button, convergence column | The workflow's last steps | They are steps, not pane features |

---

## 6. Repository layout

One home: `C:\Users\Fortress\speckit-hermes`.

```
src/core.mjs              pure model layer, no SDK imports, unit tested
                          (parsers, constitution gate, stepper, sync decisions)
src/pane.js               pane UI and registration
scripts/build.mjs         inlines core into desktop/plugin.js as one ESM file
scripts/install.mjs       copies both halves into a Hermes home, edits config, backs up
scripts/config-enable.mjs surgical plugins.enabled edit
scripts/verify-install.py re-runs Hermes' own discovery and mount, then drives the routes
scripts/render-docs.mjs   docs/design.md → docs/design.html
dashboard/plugin_api.py   FastAPI router, mounted by Hermes at /api/plugins/spec-kit-hermes
tests/backend/            route tests plus a real mount through Hermes' dashboard loader
test/                     node --test suites
docs/design.md            this file
docs/design.html          generated from this file, do not hand edit
docs/VERIFICATION.md      the evidence behind each claim
docs/archive/             superseded v0 design, v1 sources, spike notes
```

`desktop/plugin.js` is a build artifact. Edit `src/`, run `npm run build`.

---

## 7. What ships in the fork

`justinbrenton/spec-kit` is a fork of `github/spec-kit`. It carries the distribution
layer, not the app. Every Hermes addition is a new directory plus a catalog entry.

```
presets/hermes-desktop/       preset.yml (priority 1, strategy: append) + 5 templates + 10 commands
extensions/hermes-desktop/    4 optional hooks, each implemented as a command
workflows/hermes-desktop/     8-step SDD workflow (command, parallel, loop steps; no gates)
bundles/hermes-desktop/       pins preset + extension + workflow, speckit_version ^0.16.0
presets/catalog.json          + hermes-desktop
extensions/catalog.json       + hermes-desktop
workflows/catalog.json        + hermes-desktop
bundles/catalog.json          + hermes-desktop
docs/hermes-integration/      pointer to this document's home, not a copy of it
```

Catalogs live at `presets/catalog.json` and friends, not in a `catalogs/` directory.
The four `SPECKIT_PRESET_CATALOG_URL`, `SPECKIT_EXTENSION_CATALOG_URL`,
`SPECKIT_WORKFLOW_CATALOG_URL` and `SPECKIT_BUNDLE_CATALOG_URL` environment variables
override them per machine or per CI job, which is how the fork gets tested without
publishing.

The hooks:

| Hook | Command | What it does |
|---|---|---|
| `before_specify` | `speckit.git.create-branch` | branch for the feature |
| `before_plan` | `speckit.constitution.check` | refuse to plan against an unratified constitution |
| `after_implement` | `speckit.converge.auto` | convergence pass after implementation |
| `after_converge` | `speckit.pr.prepare` | assemble PR context |

All four are `optional: true`. A missing hook degrades; it does not break the workflow.

Adding something to the fork without publishing first:

```bash
specify preset add    --dev ./presets/hermes-desktop
specify extension add --dev ./extensions/hermes-desktop
specify workflow run      ./workflows/hermes-desktop/workflow.yml
specify bundle add    --dev ./bundles/hermes-desktop
```

Rules that keep the next merge boring: follow the upstream schema exactly, use
`strategy: append` so presets compose instead of replacing, and keep every hook
`optional: true` by default.

Bundle variants (backend, fullstack, ml, api-only) are planned, not built. Each would
compose the base preset with role presets that do not exist yet, so shipping the
manifests now would advertise something uninstallable.

---

## 8. Scope

Shipped:

- One guided pane: folder, process, description, step tracker, gate cards, artifact reader.
- Every workflow action goes through `specify workflow run|resume|status`; the pane holds
  no workflow logic.
- Non-blocking dispatch: run and resume return a job id, the pane polls run state.
- Three processes from one pane: SDD (`speckit`), bug fixing (`bug`) and idea assessment
  (`assess`). The last two are generated on first use, because the bundled extensions
  ship commands but no workflow.
- Gate answers carried by a declared `verdict_input`, patched into installed workflows by
  `/init` and `/repair-workflows`.
- A gate shows the output of the step it reviews, says when that preview is only the end
  of a longer stream, and can load the rest.
- Stop, a per-project run lock, and run history scoped to its own workflow.
- Artifact listing across `<project>/specs/` and `.specify/`, editable with conflict checks.
- Folder browser that honours `SPECKIT_ALLOWED_ROOTS` when an operator sets one.
- Installer that backs up before it writes, and `/integration/health` to re-apply the
  Hermes integration when an upgrade overwrites it.
- Ships the three workflows it runs (`workflows/`), with every gate naming the input it
  binds, and installs them into a new project on `/init`. Spec-kit's own bundled SDD
  workflow omits that declaration, so its gates accept a resume and discard it.
- A claim gate: every test count stated in the docs is compared with the suites that just
  ran, and a pre-commit hook runs it.
- 52 node tests, and 125 backend tests: 120 that need only FastAPI and 5 that need Hermes.

Next, in the order I would do them:

1. Confirm the wizard in the live app. Nothing in the repo can do this: the suites check
   that components are wired, not that the pane draws.
2. Bundle variants (backend, fullstack, ml, api-only) as one-click installs.
3. A runner for arm64, which is the one platform no CI job covers.

Deliberately out, and why:

| Not doing | Reason |
|---|---|
| Drag-and-drop Kanban | The pane has no drag primitive; buttons do the same job without a custom layer |
| Deleting or renaming cards | Read-back assumes create-only; deletion needs an ownership story first |
| Convergence as a watched column | Needs implement first; a column that never fills is decoration |
| Extension marketplace, bundle installer UI | Both are fork-side problems today; a UI before the catalogs are proven is backwards |
| Internal skill API | Not exposed; `host.composer` covers the dispatch case |
| `chokidar` or inotify | The renderer has no Node filesystem; polling is the honest implementation |
| Preserving hand-edited prose in `constitution.md` | The wizard owns that file. `spec.md` and `tasks.md` are rewritten surgically |
| Multi-project workspace | One project per pane keeps the state model small; more is a redesign |
| Bundling the `specify` CLI | Templates come from the fork's preset; no Python toolchain in the app |

Known gaps, not designed yet. These came out of the earlier review and none has an
owner or a shape:

| Gap | Why it matters |
|---|---|
| Plugin security model | No sandboxing, capability permissions, resource limits or signing. A plugin can do whatever the gateway can |
| Dependency and version resolution | Nothing records which preset or extension version a project was generated with |
| Spec versioning and migration | A template change can invalidate every existing `.specify/` tree with no migration path |
| Validation beyond clarifications | `[NEEDS CLARIFICATION]` is the only rule; no schema check on a malformed spec |

MCP workflow steps (a shell step calling `hermes mcp call ...`) were sketched earlier
and never verified. There is no registry for the workflow engine to read, so it stays
an idea, not a plan.

---

## 9. SDK surface

What the pane actually uses, checked by loading the built artifact with the SDK
stubbed:

| Used | For |
|---|---|
| `PANES_AREA`, `STATUSBAR_AREAS` | the pane and the status chip that focuses it |
| `Button`, `Input`, `Textarea`, `Select`, `Badge`, `ScrollArea`, `EmptyState`, `Codicon` | the UI, with no custom component layer |
| `ctx.rest` | the workflow, artifact and init routes |
| `ctx.storage` | pane-local state (last project path) |
| `host.composer` | unused today; reserved for sending a finished spec to a session |
| `host.navigate` | unused today |

Available and unused: `host.request` (sessions, config, skills, cron, kanban),
`host.skills`, `host.settings`, `host.onEvent`, `ctx.socket`, routes, sidebar nav,
palette commands, keybinds, themes, settings pages.

Not available, despite appearing in earlier drafts: `host.rest` (the API explorer
reports `no host.rest`), any gateway JSON-RPC file read or write, and `Fragment` as an
SDK export. `Fragment` comes from React.

---

## 10. Verification

| Claim | Command | Observed |
|---|---|---|
| Node tests pass | `npm test` | 52 tests, 52 pass, 0 fail |
| The built plugin loads like the runtime loads it | `node --test test/plugin-smoke.test.mjs` | default export present, `id: spec-kit-hermes`, one pane and one status item registered |
| The deployed plugin matches the build | `cmp desktop/plugin.js ~/.hermes/desktop-plugins/spec-kit-hermes/plugin.js` | identical |
| The config edit adds one line, not a duplicate key | feed the live `config.yaml` through `config-enable.mjs` | 1 line added, `plugins.enabled` contains `spec-kit-hermes` once, file parses |
| Backend half is installed | `ls ~/.hermes/plugins/spec-kit-hermes/dashboard/` | `plugin_api.py`, `manifest.json`, `index.js` |
| Backend tests pass | `python -m pytest tests/backend -q -m "not hermes"` | 120 passed, 5 deselected; the 5 need Hermes and run in their own CI job |
| Process discovery is data-driven | `tests/backend/test_processes.py` | a bugfix workflow becomes inputs + command steps + a gate; skills resolved and flagged |
| A gate pauses and resumes | `POST /run` then `POST /runs/<id>/resume` with `gate_review_spec=approve` | paused at review-spec; `choice= approve`; engine ran `plan` and paused at review-plan |
| Artifacts are listed and readable | `GET /artifacts`, `GET /artifact` | 7 artifacts in the demo project, `spec.md` read back at 1,829 chars |
| The doc pair cannot drift | `npm run docs` | HTML regenerated from this file |

Not verified here: the wizard rendering in a live app. The routes and the run state
behind it are, but the drawing is not.

---

## 11. The config corruption, and what changed because of it

On 2026-10-24 Hermes refused to start with `DuplicateKeyError: found duplicate key
"enabled"`. The cause was `scripts/config-enable.mjs`. It edits `plugins.enabled` by
text surgery, and its block scan treated any unindented line as the end of the
`plugins:` mapping. Real configs put a column-0 section banner between `plugins:` and
its keys, so the scan stopped early, failed to find the existing list, and spliced a
second `enabled:` in directly under `plugins:`.

Fixed in `accca5d`:

- Column-0 comments no longer end the mapping. That is the bug.
- The editor refuses to touch a file that already carries two `enabled:` keys,
  instead of appending to the first and writing back something still broken.
- The self-check applies the same rule, so it cannot report success on a bad edit.
- Two regression tests use the real banner shape; one of them fails against the old
  code with the same signature the corruption had.

Standing rule: any script that edits `config.yaml` must back the file up first, prove
the result parses, and prove the key it wrote appears exactly once.

---

## 12. Upstream maintenance

- Isolation: Hermes additions are new directories and catalog entries. No upstream
  file is edited. Core template bugs go upstream as PRs.
- Sync: merge `upstream/main` into `fork/main`. Merge, not rebase, so history stays
  intact for anyone tracking the fork.
- Conflicts: catalogs are the only expected conflict, resolved in favour of our
  entries. Anything else fails and gets read by a human.
- Version pin: `speckit_version: "^0.16.0"` in the bundle. A major bump gets tested,
  not absorbed.
- Not built: the scheduled sync job, and the CI check that fails on a non-catalog
  conflict. Until those exist the merge is manual.

---

## 13. Other harnesses

The spec-kit primitives are markdown and YAML, so the distribution layer is portable
by construction. A second harness needs three things: a way to invoke a skill, a way
to read and write `.specify/`, and somewhere to put the three steps.

That is a thin adapter, not a rewrite:

```
invokeSkill(skill, prompt)                    -> result
readFile(path) / writeFile(path, text, mtime)
registerSteps(spec, constitution, tasks)
```

Candidate harnesses worth naming: OpenClaw, Orca, Codex, Claude Desktop, OpenCode.
Their plugin models differ enough that each needs its own adapter. None has been
checked against its own documentation, so treat this as a research queue, not a
compatibility claim. Hermes is the only one verified here.

What carries over unchanged: templates, preset composition, extension hooks, workflow
YAML, and the `.specify/` layout. Those are files, not APIs.

Per-harness work, when someone picks one up:

| Harness | Needs beyond the adapter |
|---|---|
| OpenClaw | dashboard widget instead of a pane; ACP session templates |
| Orca | panel HTML in an isolated view; capability declarations for the sandboxed worker |
| Codex | pane layout; MCP UI for any hosted surface |
| Claude Desktop | `.claude-plugin` manifest; pane layout |
| OpenCode | terminal rendering plus a web UI path |

Checklist for a new harness: implement the adapter, declare capabilities, map
`speckit-*` to its invocation, build the three step surfaces, prove round-trip against
a real file, run a workflow, run a hook, install a bundle, and write down the quirks
that bit you.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| Installer damages `config.yaml` | Backup first, parse after, assert the key appears once, throw on anything unexpected. A rule now, not a hope |
| Backend silently not mounted | `scripts/verify-install.py` runs Hermes' own discovery and mount, then calls `/status` |
| Polling feels laggy or misses an edit | 3 s poll with mtime comparison; a WebSocket route on the backend is the upgrade path |
| Wizard clobbers hand-written constitution prose | Documented limitation; the wizard owns that file |
| Plugin API churn in Hermes Desktop | The pane imports only documented SDK exports; the smoke test evaluates the built artifact, so a broken import fails in tests rather than in the app |
| Fork drift from upstream | Merge not rebase, catalog-only conflicts, `hermes-desktop/` directories isolated |
| Growing past one pane | Scope table above; new surfaces are decisions, not drift |

---

## 15. Decisions and open questions

Decisions from the design phase, with where they landed:

| Decision | Status |
|---|---|
| Constitution wizard ships in the first release | Built, as step two of the pane |
| Template overrides delivered as a preset | Built: `presets/hermes-desktop`, priority 1, `strategy: append` |
| Parsers built on an AST for round-trip safety | Superseded: line-oriented parsing with round-trip tests |
| Kanban as a first-class surface | Partly built: cards created and read back, no board UI of our own |
| Skill invocation through the CLI as a stopgap | Deferred with skill dispatch |
| Project state in the repo, profile state in the profile | Built |

Open:

1. Where the app's code is versioned. It has no remote today, so the only copy is on
   this disk. A separate repo is cleaner than a branch of the fork, since the fork
   should stay a spec-kit distribution.
2. Whether the installer should enable the plugin in the root `config.yaml` as well as
   the profile's. Today it would touch both; the profile one is sufficient.
3. `workflows/hermes-desktop/workflow.yml` has 8 steps and no gates. For a
   human-in-the-loop workflow that is probably wrong, but the gate count is a product
   call, not a technical one.
4. Whether the next round of work splits between two agents as `researcher-architect`
   and `reviewer-tester`, or stays with one. The split was agreed, then never used.

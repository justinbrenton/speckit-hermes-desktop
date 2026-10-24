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

This project puts the same workflow inside Hermes Desktop as one interactive pane.
You write the spec in a form, answer a constitution wizard, and the tasks become
Kanban cards. The files on disk stay the source of truth, so anything else that reads
`.specify/` still works.

The scope is narrow on purpose: three files, one pane, one project at a time.

---

## 2. Why not just install spec-kit and use the CLI

Because the loop breaks at the handoff. Stock spec-kit gives you files, and then you
are on your own: read `spec.md`, work out what changed, retype it into a prompt, run a
command, come back, read `tasks.md`, find which checkbox is yours. The documents are
correct and the workflow is still manual.

| Stock spec-kit | This |
|---|---|
| `[NEEDS CLARIFICATION]` as a convention you police yourself | A counter in the spec step; the step reports ready only when three or fewer are open and the constitution is ratified |
| Constitution written once from a template, then forgotten | A five-step wizard that writes it and rehydrates from the file next time |
| Tasks as a checklist in a markdown file | Kanban cards carrying the requirement id, with status readable back into `spec.md` |
| Editing files under the agent's feet | Watches the three files and raises a conflict banner instead of clobbering |

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
`/api/plugins/spec-kit-hermes`. Five routes:

| Route | Purpose |
|---|---|
| `GET /status` | liveness, plus the path allowlist the backend will honour |
| `GET /files` | read all three files with their mtimes |
| `PUT /file` | write one file, rejected on a stale mtime |
| `POST /kanban/sync` | materialise tasks as Kanban cards, idempotent |
| `GET /kanban/links` | per-requirement card status, for the acceptance-criteria flow |

Three files, all under the project's `.specify/`, and nothing else is reachable:

```
.specify/spec.md                      requirements, acceptance criteria, clarifications
.specify/memory/constitution.md       principles, architecture choices, governance
.specify/tasks.md                     tasks with checkboxes, [P:tag] and [US#n] markers
```

`ALLOWED_PATHS` is a tuple of exactly those three names. Traversal, absolute paths and
unknown files are refused with 400. A write carrying a stale mtime is refused with
409, which is what produces the conflict banner instead of a lost edit.

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
open pane
   │  GET /files  ──▶ backend reads the three files
   ▼
step 1  Spec          requirements, acceptance criteria, clarifications
   │                  700 ms after typing stops ──▶ PUT /file {path, text, mtime}
   ▼
step 2  Constitution  purpose → principles → architecture → governance → ratify
   │                  ratify writes .specify/memory/constitution.md
   ▼
step 3  Tasks         "From spec"   one task per requirement with no task yet
                      "To Kanban"   POST /kanban/sync, idempotent per requirement
                      "From Kanban" GET /kanban/links, tick acceptance criteria
   │
   ▼
every 3 s: GET /files again. An external edit reloads the editor; a local unsaved
edit at the same moment raises the conflict banner (Keep mine / Take theirs).
```

The spec step gates on the constitution. It reports itself ready only when the
constitution is ratified, at least one requirement exists, and no more than three
clarifications are open. That gate is a UI state, not a lock; nothing stops you
writing the files by hand.

`tasks.md` markers are parsed and rendered: a `[US#n]` tag becomes a story label and a
`[P:tag]` heading becomes a parallel-group badge. Serialising writes them back.

Kanban work happens inside the Python half, not from the renderer. `kanban/sync` opens
the board through `hermes_cli.kanban_db` and calls `create_task`, reusing existing
cards by idempotency key `speckit:<project hash>:<FR-n>`, so pressing the button twice
does not duplicate anything. `kanban/links` reads `list_tasks` and reports each
requirement's card status. The 16-method JSON-RPC surface described in the previous
draft is not what this uses.

Reload behaviour, learned the hard way: editing `plugin.js` for a plugin the app has
already loaded is picked up. A brand new plugin directory is not. That needs a full
quit of every `Hermes.exe` and a restart, because the loader caches the discovered
plugin list at startup.

---

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

The CLI already exposes the same inventory for the terminal: `specify workflow
list`, `specify extension list`, and `specify artifact` for commands, templates,
scripts and hooks. The pane reads the workflow files directly today because it
needs inputs and step bodies, which those listings do not include.

---

## 5. Planned versus built

The previous design described a different system. This is what survived contact.

| Planned | Built | Why it changed |
|---|---|---|
| Three panes: SpecBuilder, TaskBoard, ConstitutionWizard | One pane with a three-step stepper | Three right-sidebar tabs read as three unrelated apps, and the steps are sequential anyway |
| `SpecParser.ts` / `TasksParser.ts` on remark + mdast | Line-oriented parsers in `src/core.mjs` | The sections are small and regular; an AST bought indirection, not safety |
| `chokidar` file watching | 3 s polling with mtime comparison | The renderer has no Node filesystem; the backend has no push channel yet |
| `SpecifyCLIBridge` spawning `specify` | Not built | Templates come from the fork's preset; no Python toolchain in the app |
| `HermesDispatch` invoking `speckit-*` skills | Not built | The pane writes files; agent dispatch is the next feature |
| Kanban via `host.request('kanban.*')` | Backend calls `hermes_cli.kanban_db` | The backend already runs in the gateway process and owns the DB handle |
| Implement button, convergence column | Not built | Both need skill dispatch, which is the next feature |

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
backend/plugin_api.py     FastAPI router
backend/tests/            route tests plus a real mount through Hermes' dashboard loader
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

- Single pane with a three-step stepper, resuming at the furthest step with content.
- Real reads and writes to the three `.specify/` files, with optimistic concurrency.
- Constitution wizard that writes and rehydrates.
- Task derivation from the spec, Kanban card creation, status pull-back.
- `[P:tag]` and `[US#n]` parsing, rendering and round-trip.
- Installer that backs up before it writes.
- 50 node tests.

Next, in the order I would do them:

1. Confirm the pane renders in a live app with the current build.
2. Install the ten `speckit-*` skills into the home Hermes reads, so a dispatch has
   a target. Until that is done every command step reports `skill_installed: false`.
3. Rebuild the pane around `GET /processes`: process picker, input form built from
   the workflow's `inputs`, step runner that dispatches command steps and stops at
   gates.
4. Artifact viewer for the run in progress, driven by the paths the process writes.
5. Keep the three authoring editors as an alternative path for SDD, since writing a
   spec by hand in a form beats a chat round trip for the first step.

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
| `ctx.rest` | the five backend routes |
| `ctx.storage` | pane-local state (last project path) |
| `host.composer` | inserted text and submit, for the dispatch feature |
| `host.navigate` | switching to a session after dispatch |

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
| Node tests pass | `npm test` | 50 tests, 50 pass, 0 fail |
| The built plugin loads like the runtime loads it | `node --test test/plugin-smoke.test.mjs` | default export present, `id: spec-kit-hermes`, one pane and one status item registered |
| The deployed plugin matches the build | `cmp desktop/plugin.js ~/.hermes/desktop-plugins/spec-kit-hermes/plugin.js` | identical, 65,162 bytes |
| The config edit adds one line, not a duplicate key | feed the live `config.yaml` through `config-enable.mjs` | 1 line added, `plugins.enabled` contains `spec-kit-hermes` once, file parses |
| Backend half is installed | `ls ~/.hermes/plugins/spec-kit-hermes/dashboard/` | `plugin_api.py` (10,031 bytes), `manifest.json`, `index.js` |
| Backend tests pass | `python -m pytest backend/tests -q` | 27 passed (route, mount, file I/O, process discovery) |
| Process discovery is data-driven | `backend/tests/test_processes.py` | a bugfix workflow becomes inputs + command steps + a gate; skills resolved and flagged |
| The doc pair cannot drift | `npm run docs` | HTML regenerated from this file, 13 sections |

Not verified: the pane rendering in a live app. That needs the desktop app open,
which is the next step, not a claim.

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

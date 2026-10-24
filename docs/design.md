# Spec-Kit for Hermes Desktop

Status: working implementation, pre-release. This document describes what exists,
what it does, and what is deliberately not built yet. Every claim in the
"Verification" section was produced by a command that ran on this machine.

Last updated: 2026-10-24.

---

## 1. What this is

Spec-Kit is a specification-driven development toolkit: you write a spec, derive a
plan, break the plan into tasks, then implement. Upstream (`github/spec-kit`) does
that with markdown templates and CLI commands. Everything ends up in a `.specify/`
directory, and you move between your editor, your terminal, and your agent by hand.

This project puts the same workflow inside Hermes Desktop as one interactive pane.
You write the spec in a form, answer a constitution wizard, and the tasks become
Kanban cards. The files on disk stay the source of truth, so anything else that
reads `.specify/` still works.

The scope is deliberately narrow: three files, one pane, one project at a time.

---

## 2. Why not just install spec-kit and use the CLI

Because the loop breaks at the handoff. Stock spec-kit gives you files, and then you
are on your own: read `spec.md`, decide what changed, retype it into a prompt, run a
command, come back, read `tasks.md`, work out which checkbox is yours. The documents
are correct and the workflow is still manual.

Concretely, what the pane adds:

| Stock spec-kit | This |
|---|---|
| `[NEEDS CLARIFICATION]` markers as a convention you police yourself | A counter in the spec step; the step reports itself ready only when three or fewer are open and the constitution is ratified |
| Constitution written once from a template, then forgotten | A five-step wizard that writes it, and rehydrates from the file next time you open it |
| Tasks as a checklist in a markdown file | Kanban cards with the requirement id attached, status readable back into `spec.md` |
| Editing files while the agent has them open | Watches the three files and shows a conflict banner instead of silently clobbering |

What it does not do: replace spec-kit. The templates, the preset, the extension
hooks, and the workflow all still come from the fork. The pane is the surface.

---

## 3. What exists today

Two halves, because that split is the only supported way for a desktop plugin to
touch files. The renderer has no filesystem access, and the gateway JSON-RPC surface
has no read or write method.

| Half | Installed path | Stack | Job |
|---|---|---|---|
| Desktop | `~/.hermes/desktop-plugins/spec-kit-hermes/plugin.js` | single ESM file, `@hermes/plugin-sdk` + React | One pane, stepper, editors, debounced saves, polling watcher, conflict banner |
| Backend | `~/.hermes/plugins/spec-kit-hermes/dashboard/plugin_api.py` | FastAPI router | Allowlisted file I/O with optimistic concurrency, Kanban sync |

The pane reaches the backend through `ctx.rest('/files')`, which Hermes scopes to
`/api/plugins/spec-kit-hermes`.

Three files, all under the project's `.specify/`:

```
.specify/spec.md                      requirements, acceptance criteria, clarifications
.specify/memory/constitution.md       principles, architecture choices, governance
.specify/tasks.md                     tasks with checkboxes, [P] and [US#] markers
```

Paths are allowlisted to exactly those three names. A path that escapes the project
root is rejected with 400. A write carrying a stale mtime is rejected with 409, which
is what produces the conflict banner rather than a lost edit.

---

## 4. How a session actually runs

```
open pane
   │  GET /files  ──▶ backend reads the three files
   ▼
step 1  Spec          edit requirements, acceptance criteria, clarifications
   │                  700 ms after typing stops ──▶ PUT /files {path, text, mtime}
   ▼
step 2  Constitution  purpose → principles → architecture → governance → ratify
   │                  ratify writes .specify/memory/constitution.md
   ▼
step 3  Tasks         "From spec"   one task per requirement that has no task yet
                      "To Kanban"   create cards, idempotent per requirement
                      "From Kanban" read card status back, tick acceptance criteria
   │
   ▼
every 3 s: GET /files again. External edit reloads the editor; a local unsaved edit
at the same moment raises the conflict banner (Keep mine / Take theirs).
```

The spec step gates on the constitution: it reports itself ready only when the
constitution is ratified, at least one requirement exists, and no more than three
clarifications are open. That gate is a UI state, not a lock. Nothing stops you from
writing files by hand.

Kanban cards carry an idempotency key, `speckit:<project hash>:<FR-n>`, so pressing
"To Kanban" twice does not duplicate anything.

---

## 5. Repository layout

One home for the app: `C:\Users\Fortress\speckit-hermes`.

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

The Kubernetes-style "everything in one directory per concern" habit does not apply
here: this is a two-half plugin, and the halves have to sit where Hermes looks for
them. The repo mirrors the two install targets, nothing else.

---

## 6. What ships in the fork

`justinbrenton/spec-kit` is a fork of `github/spec-kit`. It carries the distribution
layer, not the app. All Hermes additions are new directories plus catalog entries.

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

The hooks:

| Hook | Command | What it does |
|---|---|---|
| `before_specify` | `speckit.git.create-branch` | branch for the feature |
| `before_plan` | `speckit.constitution.check` | refuse to plan against an unratified constitution |
| `after_implement` | `speckit.converge.auto` | convergence pass after implementation |
| `after_converge` | `speckit.pr.prepare` | assemble PR context |

All four are `optional: true`. A missing hook must degrade, not break the workflow.

---

## 7. Scope

Shipped:

- Single pane with a three-step stepper, resumable at the furthest step with content.
- Real reads and writes to the three `.specify/` files, with optimistic concurrency.
- Constitution wizard that writes and rehydrates.
- Task derivation from the spec, Kanban card creation, status pull-back.
- Installer that backs up before it writes.
- 50 node tests.

Next, in the order I would do them:

1. Run the Python suite here. `pytest` is not installed in the Hermes venv, so the
   backend tests, including the real mount test, have not run on this machine.
2. Confirm the pane renders in a live app with the current build.
3. Wizard completion → send to an agent session or bot group chat. The SDK surface
   is verified (`host.composer.submit`, `host.navigate`); the wiring is not written.
4. Plan canvas: a `plan.md` surface with the tech choices made in the wizard.
5. Workflow runner: drive `workflows/hermes-desktop/workflow.yml` from the pane.

Deliberately out, and why:

| Not doing | Reason |
|---|---|
| Drag-and-drop Kanban | The pane has no DnD primitive; buttons do the same job without a custom drag layer |
| Deleting or renaming Kanban cards | The read-back model assumes create-only; deletion needs an ownership story first |
| `chokidar` or inotify | The renderer has no Node filesystem access; polling every 3 s is the honest implementation |
| Preserving hand-edited prose in `constitution.md` | The wizard owns that file. `spec.md` and `tasks.md` are rewritten surgically, section by section |
| Multi-project workspace | One project per pane keeps the state model small; more is a redesign, not a flag |
| Bundling the `specify` CLI | Templates come from the fork's preset; no Python toolchain in the app |

---

## 8. Verification

Everything below ran on this machine. Re-run any line to check it.

| Claim | Command | Observed |
|---|---|---|
| Node tests pass | `npm test` | 50 tests, 50 pass, 0 fail |
| The built plugin loads like the runtime loads it | `node --test test/plugin-smoke.test.mjs` | default export present, `id: spec-kit-hermes`, one pane and one status item registered |
| The deployed plugin matches the build | `cmp desktop/plugin.js ~/.hermes/desktop-plugins/spec-kit-hermes/plugin.js` | identical, 65,162 bytes |
| The config edit adds one line, not a duplicate key | feed the live `config.yaml` through `config-enable.mjs` | 1 line added, `plugins.enabled` contains `spec-kit-hermes` once, file parses |
| Backend half is installed | `ls ~/.hermes/plugins/spec-kit-hermes/dashboard/` | `plugin_api.py` (10,031 bytes), `manifest.json`, `index.js` |

Not verified: the Python backend suite (no `pytest` in the venv), and the pane
rendering in a live app. Both are listed as next steps, not claimed as done.

---

## 9. The config corruption, and what changed because of it

On 2026-10-24 Hermes refused to start with `DuplicateKeyError: found duplicate key
"enabled"`. The cause was `scripts/config-enable.mjs`. It edits `plugins.enabled` by
text surgery, and its block scan treated any unindented line as the end of the
`plugins:` mapping. Real configs put a column-0 section banner between `plugins:` and
its keys, so the scan stopped early, failed to find the existing list, and spliced a
second `enabled:` in directly under `plugins:`.

Fixes (commit `accca5d`):

- Column-0 comments no longer end the mapping. This is the actual bug.
- The editor refuses to touch a file that already carries two `enabled:` keys,
  instead of appending to the first one and writing back something still broken.
- The self-check applies the same rule, so it cannot report success on a bad edit.
- Two regression tests use the real banner shape, one of which fails against the old
  code with the same signature the corruption had.

Standing rule: any script that edits `config.yaml` must (a) back the file up first,
(b) prove the result parses, and (c) prove the key it wrote appears exactly once.

---

## 10. Upstream maintenance

- Isolation: Hermes additions are new directories and catalog entries. No upstream
  file is edited. Core template bugs go upstream as PRs.
- Sync: merge `upstream/main` into `fork/main`. Merge, not rebase, so history stays
  intact for anyone tracking the fork.
- Conflicts: catalogs are the only expected conflict, resolved in favour of our
  entries. Anything else fails and gets read by a human.
- Version pin: `speckit_version: "^0.16.0"` in the bundle. A major bump gets tested,
  not absorbed.

---

## 11. Other harnesses

The spec-kit primitives are markdown and YAML, so the distribution layer is portable
by construction. A second harness needs three things: a way to invoke a skill, a way
to read and write `.specify/`, and some UI to put the three steps in.

That is a thin adapter, not a rewrite. The adapter contract is small:

```
invokeSkill(skill, prompt)     -> result
readFile(path) / writeFile(path, text, mtime)
registerSteps(spec, constitution, tasks)
```

The candidate harnesses worth naming: OpenClaw, Orca, Codex, Claude Desktop,
OpenCode. Their plugin models differ enough that each needs its own adapter, and I
have not verified any of them against their own docs. Treat that list as a research
queue, not a compatibility claim. Hermes is the only one verified here.

The part that does carry over unchanged: templates, preset composition, extension
hooks, workflow YAML, and the `.specify/` layout. Those are files, not APIs.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Installer damages `config.yaml` | Backup first, parse after, assert the key appears once, throw on anything unexpected. This is a rule now, not a hope |
| Backend silently not mounted | `scripts/verify-install.py` runs Hermes' own discovery and mount, then calls `/status` |
| Polling feels laggy or misses an edit | 3 s poll with mtime comparison; a WebSocket route on the backend is the upgrade path |
| Wizard clobbers hand-written constitution prose | Documented limitation; the wizard owns that file |
| Plugin API churn in Hermes Desktop | The pane imports only documented SDK exports; the smoke test evaluates the built artifact, so a broken import fails in CI rather than in the app |
| Growing past one pane | Scope table above; new surfaces are new decisions, not drift |

---

## 13. Open decisions

1. Where the app's code is versioned. It has no remote today, so the only copy is on
   this disk. A separate repo is cleaner than a branch of the fork, since the fork
   should stay a spec-kit distribution.
2. Whether the installer should enable the plugin in the root `config.yaml` as well
   as the profile's. Today it would touch both; the profile one is sufficient.
3. Who owns `workflows/hermes-desktop/workflow.yml`. It has no gates, which is
   probably wrong for a human-in-the-loop workflow, but the gate count is a product
   call, not a technical one.

<p align="center">
  <img src="docs/assets/speckit-mark.webp" alt="Spec Kit for Hermes Desktop" width="150">
</p>

<h1 align="center">Spec Kit for Hermes Desktop</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/justinbrenton/speckit-hermes-desktop" alt="MIT license"></a>
  <img src="https://img.shields.io/github/last-commit/justinbrenton/speckit-hermes-desktop" alt="Last commit">
  <img src="https://img.shields.io/badge/hermes-%3E%3D0.22.2-blue" alt="Requires Hermes 0.22.2 or newer">
  <img src="https://img.shields.io/github/issues/justinbrenton/speckit-hermes-desktop" alt="Open issues">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black" alt="Linux">
  <img src="https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black" alt="JavaScript">
  <img src="https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white" alt="Python">
</p>

<p align="center">
  <strong>Run spec-kit workflows from a pane in Hermes Desktop, with every review gate visible.</strong>
</p>

> [!NOTE]
> **Alpha.** Expect rough edges. Behaviour and file layout may change between releases.

## What This Does

Spec Kit is GitHub's toolkit for specification-driven development. It provides skills (constitution, specify, clarify, plan, tasks, analyze, implement, converge) that you normally invoke one at a time in a terminal. This plugin surfaces that process in the Hermes sidebar while keeping all artifacts on disk as Markdown.

**Key differences from the CLI:**

| Capability | CLI | This Plugin |
|------------|-----|-------------|
| Review gates | Manual file open/read | Opens the artifact automatically; blocks until you Approve/Reject |
| Empty steps | Silent success | Flagged at the gate — nothing changed, nothing approved |
| Run state | Terminal only | Live log, Stop button, run history in the pane |
| Task tracking | `.specify/tasks.md` | Synced to Hermes Kanban (idempotent, two-way) |

## Screenshots

### Main Pane

<p align="center">
  <img src="docs/assets/speckit-ss1.png?v=3" alt="Spec Kit main pane showing three processes" width="800">
</p>

### Process Views

| Spec-Driven Development | Short Path |
|:---:|:---:|
| <img src="docs/assets/speckit-ss2.png" alt="Full SDD workflow" width="400"> | <img src="docs/assets/speckit-ss3.png?v=3" alt="Short SDD workflow" width="400"> |

| Bug Fixing | Idea Assessment |
|:---:|:---:|
| <img src="docs/assets/speckit-ss5.png" alt="Bug fixing workflow" width="400"> | <img src="docs/assets/speckit-ss6.png" alt="Idea assessment workflow" width="400"> |

## Features

- **Three processes** — Spec-driven development (10 steps), Bug fixing (4 steps), Idea assessment (7 steps). Each ships a complete workflow with review gates.
- **Two SDD paths** — Shorter (6 steps) or Full (10 steps with clarify, checklist, and analyze gates).
- **Editable gates** — Each gate opens the artifact in an editor with **Approve** / **Reject**. If the file changed on disk since it opened, you choose which version to keep.
- **Open questions** — `[NEEDS CLARIFICATION]` markers become a form. Answers write back in place; blanks stay as markers.
- **Step output flagging** — A step that changed no artifact is flagged at the gate.
- **Run control** — Live log, Stop button, one run per project, run history.
- **Kanban sync** — Sync `.specify/tasks.md` to Hermes Kanban as cards with idempotent links.
- **Integration health** — Verify the Hermes adapter points at the correct project; re-apply the patch after CLI upgrades.

## Requirements

- **Hermes Desktop 0.22.2+** — Pane is a desktop plugin; gates dispatch skills via `hermes chat` (CLI must be on PATH).
- **specify CLI** — `uv tool install specify-cli`
- **speckit-* skills** — Installed to your profile by `specify init --integration hermes`.

## Install

The plugin has two halves, both installed to the **Hermes root home** (not a profile directory):

| Component | Destination |
|-----------|-------------|
| **Frontend** (desktop pane) | `$HERMES_HOME/desktop-plugins/spec-kit-hermes/plugin.js` |
| **Backend** (Python router) | `$HERMES_HOME/plugins/spec-kit-hermes/` |

**$HERMES_HOME defaults:**

| Platform | Path |
|----------|------|
| Windows | `%LOCALAPPDATA%\hermes` |
| Linux/macOS | `~/.hermes` |

The **default profile** uses `$HERMES_HOME/config.yaml` (at root). **Additional profiles** live at `$HERMES_HOME/profiles/<name>/config.yaml`.

### From the Registry (Recommended)

```bash
hermes plugins install justinbrenton/speckit-hermes-desktop --enable
hermes gateway restart
```

Clones the repo into your Hermes home under `plugins/spec-kit-hermes`, enables it for the active profile, and loads the pane on next start. **Quit every Hermes process and reopen.** The pane appears as **Spec Kit** in the right sidebar with a matching status-bar chip.

### From a Local Clone

```bash
git clone https://github.com/justinbrenton/speckit-hermes-desktop
cd speckit-hermes-desktop
npm run build
node scripts/install.mjs
```

The installer copies both halves into the Hermes root home it finds and adds the plugin to `plugins.enabled` for the target profile (defaults to active). Options: `--profile <name>` targets a profile, `--home <path>` a Hermes root home, `--dry-run` prints what would change.

### Manual Install

```text
plugin.yaml, desktop/, dashboard/  ->  <hermes root home>/plugins/spec-kit-hermes/
```

Add `spec-kit-hermes` to `plugins.enabled` in `<hermes root home>/profiles/<profile>/config.yaml`, then restart. The app discovers desktop plugins once per start; the Python half is imported once per gateway process.

### Updating

Run the installer again. It detects the existing installation, backs up `plugin.js` once (to `plugin.js.backup`), copies new files, and reinstalls Python dependencies into the Hermes venv if needed.

```bash
# From a clone
cd speckit-hermes-desktop
git pull
npm run build
node scripts/install.mjs

# Or from the registry
hermes plugins install justinbrenton/speckit-hermes-desktop --enable
hermes gateway restart
```

The install script is idempotent — running it on an existing installation upgrades in place without touching your projects or config.

### Uninstalling

```bash
hermes plugins remove spec-kit-hermes
hermes gateway restart
```

Removes the plugin from `plugins.enabled`. Copied files remain in the Hermes home; delete them manually for a clean slate.

## Usage

Open the **Spec Kit** pane from the right sidebar. Pick a folder by typing the path or using **Browse** (the pane walks directories itself; the plugin SDK has no native folder dialog).

### Choose a Process

| Process | Input Required |
|---------|----------------|
| **Spec-driven development** → Shorter / Full path | Description (1–2 sentences) |
| **Bug fixing** | Bug report + slug (kebab-case, e.g. `login-timeout`) |
| **Idea assessment** | Raw idea + slug (e.g. `offline-mode`) |

Press **Start**. Each step dispatches a real agent call (give it a minute). When the run parks at a gate, the file under review opens below the progress bar. Read it, fix it, save it, then **Approve**. Approving runs the next step.

The constitution step runs first on the first pass and writes `.specify/memory/constitution.md` from the principles you type. After that, artifacts land in:

- SDD: `specs/<number>-<name>/`
- Bug fixing: `.specify/bugs/<slug>/`
- Idea assessment: `.specify/assessments/<slug>/`

## Troubleshooting

### Backend Not Mounted (404 / "Plugin backend unavailable")

After a Hermes update, the gateway venv is recreated without the plugin's Python dependencies.

**Fix:** Re-run the installer, then restart Hermes completely.

```bash
node scripts/install.mjs --profile <your-profile>
```

### Browse Button Does Nothing

The folder picker falls back to the allowed listing. If your project is outside the configured browse roots, the backend refuses the path with a 403.

**Fix:** The `SPECKIT_ALLOWED_ROOTS` environment variable (or `allowed_roots` in plugin config) controls which directories may be browsed. Ensure your project lives within one of those roots, or adjust the configured roots. The artifact-file allowlist (`.specify/spec.md`, `.specify/memory/constitution.md`, `.specify/tasks.md`) is separate and controls which files the backend can read/write inside the project.

### Skills Not Found at Runtime

The `speckit-*` skills must be installed in the active Hermes profile.

**Fix:** Run `specify init --integration hermes` in a terminal, then restart Hermes.

### Linux-Specific Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| **PyYAML / "yaml not found"** | Hermes gateway clears `PYTHONPATH` when spawning; plugin can't import `yaml` | Plugin auto-detects site-packages at import time. If it still fails: `~/.hermes/installs/<id>/environments/<env>/venv/bin/python -m pip install PyYAML`, then restart Hermes. |
| **Missing `python-multipart` / `psutil`** | Gateway requires these for multipart forms and process management | `~/.hermes/installs/<id>/environments/<env>/venv/bin/python -m pip install python-multipart psutil`, then restart Hermes. |
| **Plugin not loading / "duplicate id"** | Source repo cloned into `~/.hermes/hermes-agent/speckit-hermes-desktop/` alongside installed plugin | `rm -rf ~/.hermes/hermes-agent/speckit-hermes-desktop/` |
| **Config YAML indentation** | `plugins.enabled`/`disabled` at root level instead of under `plugins:` | Edit `~/.hermes/config.yaml` to nest under `plugins:` with `isolation: in_process`. |
| **Missing `plugins.isolation`** | Defaults to `host` which requires a plugin host process | Add `isolation: in_process` under `plugins:` in `~/.hermes/config.yaml`. |
| **"Dispatched steps not told which project"** | `specify` CLI's Hermes integration missing working-directory fix | Click **"Re-apply fix"** in the Spec Kit pane to patch the integration files at runtime. |

## Limitations

- Gates require manual approval — no auto-approve.
- One workflow per project at a time; a second Start is refused while a run is live.
- Run state belongs to spec-kit; the pane reads it rather than keeping its own. If the gateway dies, the run cannot be recovered from the pane.
- The pane does not diff code written by `implement` and `converge` — those steps change files directly in your project.
- No native folder dialog — Browse lists directories through the backend and starts where you left off.
- Constitution preservation on hand-edited prose is not supported — the wizard regenerates the whole file.
- Kanban sync against a real board is not verified in the test suite (exercised against a throwaway `HERMES_HOME` only).

## Development

```bash
npm run build     # src -> desktop/plugin.js, fails if a referenced component is undefined
npm test          # pane decisions, build, installer
python -m pytest tests/backend -q -m "not hermes"   # routes, workflow bridge
```

Five backend tests need Hermes installed and cover dashboard mounting and the Kanban bridge:

```bash
python -m pytest tests/backend -q -m hermes
```

See [docs/TESTING.md](docs/TESTING.md) for the full picture.

Before pushing, one command runs every gate:

```bash
npm run preflight
```

It builds, runs both suites, verifies every test count stated in the docs matches what just ran, and fails if `docs/design.html` is not what `docs/design.md` renders to.

**Architecture:**

- `src/core.mjs` — decisions the pane makes about workflows it did not author (which inputs to ask for, where a run is, which file a gate reviews)
- `src/pane.js` — the UI
- `dashboard/plugin_api.py` — the router: process discovery, run control, artifacts, clarification answers, integration health check

## Credits

Built on [spec-kit](https://github.com/github/spec-kit) by GitHub. The processes, templates, workflow format, and skills are theirs; this repo is the pane and the backend around them.

## Contributing

Issues and PRs are welcome. A useful bug report includes:

- Hermes version (`hermes --version`)
- Platform and shell
- Steps to reproduce
- Expected vs actual behaviour
- Relevant logs (desktop.log, gateway.log)

## License

MIT. See [LICENSE](LICENSE).
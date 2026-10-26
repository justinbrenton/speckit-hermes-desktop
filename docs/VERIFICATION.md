# Verification log

Every claim in the README traces to something here: the source line that settles it,
or the command and its observed output. Hermes code paths are relative to
`%LOCALAPPDATA%/hermes/hermes-agent` (v0.22.4 on this machine).

## 1. There is no `host.rest`, and `ctx.rest` only reaches the plugin's own namespace

- `apps/desktop/src/contrib/plugin.ts:150` — `rest: <T>(path: string, opts?: PluginRestOptions) => Promise<T>`
  documented as *"REST to this plugin's own backend namespace (`/api/plugins/<id>`)"*.
- `apps/desktop/src/contrib/plugin.ts:366` — implementation: `ctx.rest('/x')` →
  `pluginRest(pluginId, '/x')`.
- `apps/desktop/src/api/plugins.ts:72-87` — the URL is built as
  `` `/api/plugins/${pluginId}${suffix}` ``; `..` in the path throws.
- No `host.rest` member exists on the `host` object (`apps/desktop/src/sdk/index.ts:578+`).

**Consequence:** the pane cannot read or write files by itself. It needs a backend half.

## 2. The backend half must be a dashboard plugin with `plugin_api.py`

- `hermes_cli/web_server_dashboard.py:1189` — `app.include_router(router, prefix=f"/api/plugins/{plugin['name']}")`.
- `hermes_cli/web_server_dashboard.py:495-510` — user plugins are discovered from
  `<hermes home>/plugins/*/dashboard/manifest.json`; the manifest's `api` field names the
  Python file (validated to stay inside `dashboard/`).
- `hermes_cli/web_server_dashboard.py:798-812` — `_plugin_api_mount_skip_reason`: a
  **user** plugin's `api` is imported only when its name is in `plugins.enabled` and not
  in `plugins.disabled`. That is the consent gate the installer performs.

## 3. There is no filesystem method on the gateway JSON-RPC surface either

`apps/shared/src/gateway-contract.generated.ts` — 668 methods; the only file-related one
is `file.attach` (attachments). Filtered for `file|workspace|fs|project|kanban|skill`:

```
file.attach
kanban.run
project.facts
projects.*        (project management, not file I/O)
skills.changed
skills.manage
skills.reload
```

So `ctx.rest` + `plugin_api.py` is not a workaround, it is the only door.

## 4. `host.request('kanban.create')` does not exist

The same contract file has a single `kanban.*` method (`kanban.run`). The 16
`kanban.*` JSON-RPC methods listed in the v1 spike doc were inferred from CLI flags and
are not on the wire. The backend therefore calls `hermes_cli.kanban_db` directly —
exactly what the built-in Kanban dashboard plugin does
(`plugins/kanban/dashboard/plugin_api.py:31` imports `kanban_db`, `:437` calls
`kanban_db.create_task`).

## 5. Live gateway probing was inconclusive by design

The running gateway listens on `127.0.0.1:64393` (gateway PID 6448, ports from
`netstat -ano`). Unauthenticated probes:

```
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:64393/api/plugins/kanban/board
401
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:64393/api/plugins/spec-kit-hermes/status
401
```

Auth middleware runs before routing, so a 401 cannot distinguish "route mounted" from
"route absent", and the local gateway mints one-use native grants inside Electron — there
is no token to borrow. Hence the mount is proven in-process instead (section 6).

## 6. The mount works through Hermes' own pipeline

`tests/backend/test_mount.py` lays the backend out as the installer does
(`<tmp home>/plugins/spec-kit-hermes/dashboard/`), then calls the real
`_discover_dashboard_plugins` and `_mount_one_plugin_api`, then makes an HTTP request:

```
$ PYTHONPATH="$LOCALAPPDATA/hermes/hermes-agent" python -m pytest tests/backend -q -m hermes
5 passed, 94 deselected
```

These run in CI too, in a job that stages a pinned Hermes commit, so mounting is not a
claim that only holds on the machine it was written on.

- discovery finds the manifest, `has_api: true`, `_api_file: 'plugin_api.py'`
- `_mount_one_plugin_api(app, entry, {'spec-kit-hermes'}, set())` returns `True`
- `GET /api/plugins/spec-kit-hermes/status` → `200 {"ok":true,"plugin":"spec-kit-hermes",...}`
- with an empty `plugins.enabled` the same call returns `False` (consent gate holds)

## 7. Test suites

```
$ npm test
ℹ tests 46   ℹ pass 46   ℹ fail 0

$ python -m pytest tests/backend -q -m "not hermes"
94 passed, 5 deselected
```

What the suites cover:

| Suite | Covers |
|-------|--------|
| `test/core.test.mjs` | spec/tasks/constitution parse → serialize round trip, unknown sections preserved, clarification budget, gate, `deriveTasksFromSpec`, `applyAcceptanceFromTasks`, `decideSync` matrix, debouncer, stepper, `parseRestError` |
| `test/build.test.mjs` | built `plugin.js` imports only permitted specifiers, inlines the core, registers exactly one pane, keeps `ctx.rest` paths namespace-relative, is valid ESM (`node --check`), stays under the 512 KiB shell limit |
| `test/config-enable.test.mjs` | `plugins.enabled` edit: block list, inline list, missing key, missing block, CRLF, comments, idempotency, bad names |
| `tests/backend/test_plugin_api.py` | read/write, atomic write, mtime conflict (409 + winning copy), path allowlist refusals, relative/missing `cwd`, real Kanban create/dedupe/links in a throwaway `HERMES_HOME` |
| `tests/backend/test_mount.py` | the mount itself, through Hermes' dashboard code |

## 8. Live install

```
$ node scripts/install.mjs --profile codie
Spec Kit -> C:/Users/Fortress/AppData/Local/hermes
  wrote   …/desktop-plugins/spec-kit-hermes/plugin.js      (64888 bytes)
  wrote   …/desktop-plugins/spec-kit-hermes/plugin.yaml
  wrote   …/plugins/spec-kit-hermes/dashboard/plugin_api.py
  wrote   …/plugins/spec-kit-hermes/dashboard/manifest.json
  wrote   …/plugins/spec-kit-hermes/dashboard/index.js
  config enabled: …/profiles/codie/config.yaml
  config enabled: …/config.yaml
```

`…/profiles/codie/config.yaml` now lists `spec-kit-hermes` under `plugins.enabled`
(a `.speckit-backup` copy sits beside it; the previous v1 `plugin.js` is preserved as
`plugin.js.backup`).

```
$ PYTHONPATH="$LOCALAPPDATA/hermes/hermes-agent" python scripts/verify-install.py --profile codie
discovered   : spec-kit-hermes (user) api=plugin_api.py
dashboard dir: …\hermes\plugins\spec-kit-hermes\dashboard
consent      : enabled in …\profiles\codie\config.yaml
GET  /api/plugins/spec-kit-hermes/status -> 200 {'ok': True, 'plugin': 'spec-kit-hermes', …}
GET  /api/plugins/spec-kit-hermes/files (empty project) -> 200, 3 files absent
PUT  /api/plugins/spec-kit-hermes/file -> 200, wrote 32 bytes to …\.specify\spec.md
PUT  /api/plugins/spec-kit-hermes/file (stale mtime) -> 409 with the winning copy
PUT  /api/plugins/spec-kit-hermes/file (../escape.md) -> 400 refused
GET  /api/plugins/spec-kit-hermes/kanban/links -> 200 (0 linked cards)

OK — installed plugin is discovered, consented, mounted and serving.
```

## 9. The running app loads the plugin

`Hermes.exe` was already running (packaged build, so no CDP port — the skill's rule is to
never relaunch the user's app). The desktop plugin loader fs-watches
`<home>/desktop-plugins/*/plugin.js` and hot-reloads, and it logs failures to
`logs/desktop.log`. That gave a real signal in both directions:

1. A deliberate fault appended to the live `plugin.js`
   (`throw new Error('speckit-reload-probe')`) was reported **within 200 ms**, proving the
   watcher is live and evaluates the file I installed:

   ```
   2026-10-24 01:02:24,600 [plugins] runtime load failed (spec-kit-hermes) Error: speckit-reload-probe
   ```

2. Restoring the built file produced **no** log line at all — not `runtime load failed`,
   not `failed to register` — while the same log recorded every earlier failure
   (`has no valid default HermesPlugin export`, from intermediate builds). The loader logs
   both failure modes, so silence here means the module evaluated, the default export
   validated, and `register(ctx)` completed.

`test/plugin-smoke.test.mjs` covers the same contract offline: it rewrites the built
file's import specifiers to recorders, imports it, asserts `default.id`,
`default.register`, and that `register()` wires exactly one pane (`id: 'spec-kit'`,
`placement: 'right'`) plus one status item.

## 10. What is NOT verified

- **Visual confirmation of the pane.** No screenshot and no DOM read (packaged build has
  no CDP port, and relaunching the user's app is off-limits). Everything up to
  "registered + serving" is verified; the pane's layout and feel are not.
- **A Kanban sync against the user's real board.** The sync path is exercised against a
  throwaway `HERMES_HOME` in `tests/backend/test_plugin_api.py`; creating cards on the
  live board without being asked would leave debris in the user's backlog.
- **`pickOpenPath` / `revealPath` OS doors** — not used by this plugin.
- **Constitution section preservation on hand-edited prose** — the wizard regenerates the
  whole file; documented as a limit in the README rather than claimed as round-trip.

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

`backend/tests/test_mount.py` lays the backend out as the installer does
(`<tmp home>/plugins/spec-kit-hermes/dashboard/`), then calls the real
`_discover_dashboard_plugins` and `_mount_one_plugin_api`, then makes an HTTP request:

```
$ PYTHONPATH="$LOCALAPPDATA/hermes/hermes-agent" python -m pytest backend/tests -q
3 passed in 1.37s
```

- discovery finds the manifest, `has_api: true`, `_api_file: 'plugin_api.py'`
- `_mount_one_plugin_api(app, entry, {'spec-kit-hermes'}, set())` returns `True`
- `GET /api/plugins/spec-kit-hermes/status` → `200 {"ok":true,"plugin":"spec-kit-hermes",...}`
- with an empty `plugins.enabled` the same call returns `False` (consent gate holds)

## 7. Test suites

```
$ node --test test/*.test.mjs
ℹ tests 36   ℹ pass 36   ℹ fail 0

$ python -m pytest backend/tests -q
22 passed
```

What the suites cover:

| Suite | Covers |
|-------|--------|
| `test/core.test.mjs` | spec/tasks/constitution parse → serialize round trip, unknown sections preserved, clarification budget, gate, `deriveTasksFromSpec`, `applyAcceptanceFromTasks`, `decideSync` matrix, debouncer, stepper, `parseRestError` |
| `test/build.test.mjs` | built `plugin.js` imports only permitted specifiers, inlines the core, registers exactly one pane, keeps `ctx.rest` paths namespace-relative, is valid ESM (`node --check`), stays under the 512 KiB shell limit |
| `test/config-enable.test.mjs` | `plugins.enabled` edit: block list, inline list, missing key, missing block, CRLF, comments, idempotency, bad names |
| `backend/tests/test_plugin_api.py` | read/write, atomic write, mtime conflict (409 + winning copy), path allowlist refusals, relative/missing `cwd`, real Kanban create/dedupe/links in a throwaway `HERMES_HOME` |
| `backend/tests/test_mount.py` | the mount itself, through Hermes' dashboard code |

## 8. What is NOT verified

- **The pane rendering inside the running app.** `Hermes.exe` was running during the
  build; the runtime loader reads `plugin.js` at app start (and via its fs watcher), so
  the new pane appears after the app picks up the file. No screenshot of the live pane is
  claimed here.
- **`pickOpenPath` / `revealPath` OS doors** — not used by this plugin.
- **Constitution section preservation on hand-edited prose** — the wizard regenerates the
  whole file; documented as a limit in the README rather than claimed as round-trip.

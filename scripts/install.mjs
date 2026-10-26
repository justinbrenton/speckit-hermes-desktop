/**
 * Install the Spec Kit plugin into a Hermes home.
 *
 *   node scripts/install.mjs [--profile codie] [--home <hermes home>] [--dry-run]
 *
 * Two halves, because that is what Hermes Desktop needs:
 *   1. desktop half  -> <home>/desktop-plugins/spec-kit-hermes/plugin.js
 *      (one pane; loaded by the app's runtime plugin loader)
 *   2. backend half  -> <home>/plugins/spec-kit-hermes/dashboard/{manifest.json,plugin_api.py}
 *      (FastAPI router mounted at /api/plugins/spec-kit-hermes, the namespace
 *      `ctx.rest` is scoped to)
 *
 * …plus the consent edit: the name goes into `plugins.enabled` of the profile's
 * config.yaml (a user plugin's Python is not imported without it).
 */
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from './build.mjs'
import { enablePlugin, isPluginEnabled } from './config-enable.mjs'

export const PLUGIN_ID = 'spec-kit-hermes'
const CH_BACKSLASH = String.fromCharCode(92)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const options = { profile: process.env.HERMES_PROFILE || '', home: process.env.HERMES_HOME || '', dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--profile') {
      options.profile = argv[++i]
    } else if (arg === '--home') {
      options.home = argv[++i]
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

/**
 * The Hermes ROOT (the directory that holds `plugins/`, `desktop-plugins/` and
 * `profiles/`), not a profile home.
 *
 * A `HERMES_HOME` of `<root>/profiles/<name>` — what a profile-scoped process
 * exports — is unwrapped to `<root>`, and `<name>` becomes the default profile.
 * This mirrors `hermes_constants.get_default_hermes_root`, and it matters:
 * dashboard-plugin discovery scans the process home AND the default root, while
 * the consent gate reads the ACTIVE profile's config. Installing into
 * `<root>/plugins` with the edit in `<root>/profiles/<name>/config.yaml` is the
 * combination that both discovers and mounts.
 */
export function resolveHome(explicit, env = process.env) {
  const candidate = explicit || env.HERMES_HOME || ''
  if (candidate) {
    // Segment split instead of a separator regex: a HERMES_HOME exported by another
    // process can carry doubled backslashes, and '/' form is fine for node's fs.
    // The leading separator is remembered before empty segments are dropped: on
    // POSIX a dropped one turns "/tmp/x" into the relative path "tmp/x".
    const normalised = String(candidate)
      .split(CH_BACKSLASH)
      .join('/')
      .replace(/\/{2,}/g, '/')
    const root = normalised.startsWith('//') ? '//' : normalised.startsWith('/') ? '/' : ''
    const segments = normalised.split('/').filter(Boolean)
    const marker = segments.lastIndexOf('profiles')
    if (marker > 0 && marker === segments.length - 2) {
      return { home: root + segments.slice(0, marker).join('/'), profile: segments[marker + 1] }
    }
    return { home: root + segments.join('/'), profile: '' }
  }
  if (env.LOCALAPPDATA) {
    return { home: join(env.LOCALAPPDATA, 'hermes'), profile: '' }
  }
  return { home: join(env.HOME || env.USERPROFILE || '', '.hermes'), profile: '' }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function writeIfChanged(path, content, { dryRun }) {
  const previous = (await exists(path)) ? await readFile(path, 'utf8') : null
  const changed = previous !== content
  if (changed && !dryRun) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
  return { path, changed }
}

async function enableInConfig(path, name, { dryRun, required }) {
  if (!(await exists(path))) {
    if (required) {
      throw new Error(`config not found: ${path}`)
    }
    return { path, skipped: 'no config' }
  }
  const before = await readFile(path, 'utf8')
  const { text, changed, alreadyEnabled } = enablePlugin(before, name)
  if (changed && !dryRun) {
    await copyFile(path, `${path}.speckit-backup`)
    await writeFile(path, text, 'utf8')
  }
  const after = changed && !dryRun ? await readFile(path, 'utf8') : text
  if (!isPluginEnabled(after, name)) {
    throw new Error(`${path}: the edit did not land — run \`hermes plugins enable ${name}\` manually`)
  }
  return { path, changed, alreadyEnabled }
}

export async function install({ profile, home, dryRun = false } = {}) {
  const resolved = resolveHome(home)
  home = resolved.home
  profile = profile || resolved.profile
  const buildResult = await build({ root: ROOT })
  const pluginSource = await readFile(buildResult.target, 'utf8')

  const desktopDir = join(home, 'desktop-plugins', PLUGIN_ID)
  const dashboardDir = join(home, 'plugins', PLUGIN_ID, 'dashboard')

  const report = { home, dryRun, files: [], configs: [], notes: [] }

  // 1. desktop half
  const existingPlugin = join(desktopDir, 'plugin.js')
  const backupPlugin = join(desktopDir, 'plugin.js.backup')
  if ((await exists(existingPlugin)) && !(await exists(backupPlugin))) {
    const previous = await readFile(existingPlugin, 'utf8')
    if (previous !== pluginSource && !dryRun) {
      // Written ONCE: `plugin.js.backup` is the file that was there before this
      // installer ever ran. Re-writing it on every reinstall quietly destroys the
      // only copy of the previous plugin.
      await copyFile(existingPlugin, backupPlugin)
      report.notes.push(`backed up the previous plugin.js to ${backupPlugin}`)
    }
  }
  report.files.push(await writeIfChanged(existingPlugin, pluginSource, { dryRun }))
  report.files.push(
    // One manifest in the repo; the loader's copy beside plugin.js is derived.
    await writeIfChanged(join(desktopDir, 'plugin.yaml'), await readFile(join(ROOT, 'plugin.yaml'), 'utf8'), { dryRun })
  )

  // 2. backend half
  for (const name of ['plugin_api.py', 'manifest.json', 'index.js']) {
    report.files.push(
      await writeIfChanged(join(dashboardDir, name), await readFile(join(ROOT, 'dashboard', name), 'utf8'), { dryRun })
    )
  }

  // 2b. the workflows the backend installs into a new project. Without these the
  // dashboard reads an empty bundle and /init silently writes nothing, which puts
  // the unanswerable gates back.
  const bundleDir = join(ROOT, 'workflows')
  const workflowsDir = join(home, 'plugins', PLUGIN_ID, 'workflows')
  const bundleEntries = (await exists(bundleDir)) ? await readdir(bundleDir, { withFileTypes: true }) : []
  if (bundleEntries.length === 0) {
    // A checkout or package without workflows/ would otherwise abort the install
    // after plugin.js and dashboard/ are already written.
    report.notes.push(`no workflows/ directory at ${bundleDir}: /init will have nothing to install`)
  }
  for (const entry of bundleEntries) {
    if (!entry.isDirectory()) continue
    const source = join(bundleDir, entry.name, 'workflow.yml')
    if (!(await exists(source))) continue
    report.files.push(
      await writeIfChanged(join(workflowsDir, entry.name, 'workflow.yml'), await readFile(source, 'utf8'), { dryRun })
    )
  }

  // 3. consent
  const profileName = profile || process.env.HERMES_PROFILE || 'default'
  const profileConfig = join(home, 'profiles', profileName, 'config.yaml')
  report.configs.push(await enableInConfig(profileConfig, PLUGIN_ID, { dryRun, required: false }))
  report.configs.push(await enableInConfig(join(home, 'config.yaml'), PLUGIN_ID, { dryRun, required: false }))

  return { ...report, buildResult, profileName, desktopDir, dashboardDir }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const options = parseArgs(process.argv.slice(2))
  const report = await install(options)
  console.log(`Spec Kit ${options.dryRun ? '(dry run) ' : ''}-> ${report.home}`)
  for (const file of report.files) {
    console.log(`  ${file.changed ? 'wrote  ' : 'same   '} ${file.path}`)
  }
  for (const config of report.configs) {
    const state = config.skipped ? `skipped (${config.skipped})` : config.alreadyEnabled ? 'already enabled' : config.changed ? 'enabled' : 'unchanged'
    console.log(`  config ${state}: ${config.path}`)
  }
  for (const note of report.notes) {
    console.log(`  note: ${note}`)
  }
  console.log('')
  console.log('Next: restart Hermes Desktop (fully quit every Hermes.exe) so the runtime plugin')
  console.log('loader picks up plugin.js, then open the "Spec Kit" pane in the right sidebar.')
}

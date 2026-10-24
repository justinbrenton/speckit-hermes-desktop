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
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from './build.mjs'
import { enablePlugin, isPluginEnabled } from './config-enable.mjs'

export const PLUGIN_ID = 'spec-kit-hermes'
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

export function defaultHermesHome() {
  if (process.env.HERMES_HOME) {
    return process.env.HERMES_HOME
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'hermes')
  }
  return join(process.env.HOME || process.env.USERPROFILE || '', '.hermes')
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

export async function install({ profile, home = defaultHermesHome(), dryRun = false } = {}) {
  const buildResult = await build({ root: ROOT })
  const pluginSource = await readFile(buildResult.target, 'utf8')

  const desktopDir = join(home, 'desktop-plugins', PLUGIN_ID)
  const dashboardDir = join(home, 'plugins', PLUGIN_ID, 'dashboard')

  const report = { home, dryRun, files: [], configs: [], notes: [] }

  // 1. desktop half
  const existingPlugin = join(desktopDir, 'plugin.js')
  if (await exists(existingPlugin)) {
    const previous = await readFile(existingPlugin, 'utf8')
    if (previous !== pluginSource && !dryRun) {
      await copyFile(existingPlugin, join(desktopDir, 'plugin.js.backup'))
      report.notes.push(`backed up the previous plugin.js to ${join(desktopDir, 'plugin.js.backup')}`)
    }
  }
  report.files.push(await writeIfChanged(existingPlugin, pluginSource, { dryRun }))
  report.files.push(
    await writeIfChanged(join(desktopDir, 'plugin.yaml'), await readFile(join(ROOT, 'desktop/plugin.yaml'), 'utf8'), { dryRun })
  )

  // 2. backend half
  for (const name of ['plugin_api.py', 'manifest.json', 'index.js']) {
    report.files.push(
      await writeIfChanged(join(dashboardDir, name), await readFile(join(ROOT, 'backend', name), 'utf8'), { dryRun })
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

/**
 * Install the Spec Kit plugin into a Hermes root home.
 *
 *   node scripts/install.mjs [--profile <your-profile>] [--home <hermes root home>] [--dry-run]
 *
 * Two halves, because that is what Hermes Desktop needs:
 *   1. desktop half  -> <root home>/desktop-plugins/spec-kit-hermes/plugin.js
 *      (one pane; loaded by the app's runtime plugin loader)
 *   2. backend half  -> <root home>/plugins/spec-kit-hermes/dashboard/{manifest.json,plugin_api.py}
 *      (FastAPI router mounted at /api/plugins/spec-kit-hermes, the namespace
 *      `ctx.rest` is scoped to)
 *
 * …plus the consent edit: the name goes into `plugins.enabled` of the target
 * profile's config.yaml (a user plugin's Python is not imported without it).
 *
 * The <root home> is the directory containing `plugins/`, `desktop-plugins/`,
 * and `profiles/` — not a profile subdirectory. The installer auto-detects it
 * from `HERMES_HOME` (unwrapping profile paths), `LOCALAPPDATA` (Windows), or
 * `HOME` (Linux/macOS). Profiles live at `<root home>/profiles/<name>/`.
 */
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

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
      .replace(/\/+/g, '/')
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

/**
 * Find the Hermes venv site-packages directory and install Python dependencies
 * required by the plugin's backend (plugin_api.py).
 */
async function ensurePythonDeps(home, { dryRun }) {
  // The Hermes venv lives under <hermes home>/installs/<id>/environments/<id>/venv/
  // but the exact paths vary. We find it by looking for the venv that has
  // hermes_cli importable (the one the running gateway uses).
  const installsDir = join(home, 'installs')
  if (!(await exists(installsDir))) {
    return { installed: [], skipped: 'no installs dir' }
  }

  // Read plugin_api.py to find imports we need to satisfy
  const apiPath = join(ROOT, 'dashboard', 'plugin_api.py')
  const apiSource = await readFile(apiPath, 'utf8')
  const imports = new Set()
  for (const line of apiSource.split('\n')) {
    const m = line.match(/^\s*(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_]*)/)
    if (m && !m[1].startsWith('_') && !['os', 'sys', 'json', 're', 'time', 'datetime', 'pathlib', 'typing', 'itertools', 'hashlib', 'shutil', 'tempfile', 'threading', 'logging', 'subprocess'].includes(m[1])) {
      imports.add(m[1])
    }
  }
  // Known third-party deps used by plugin_api.py
  const knownDeps = new Map([
    ['yaml', 'PyYAML>=6.0'],
    ['fastapi', 'fastapi>=0.110'],
    ['pydantic', 'pydantic>=2.6'],
  ])
  const needed = []
  for (const imp of imports) {
    if (knownDeps.has(imp)) needed.push(knownDeps.get(imp))
  }

  if (needed.length === 0) return { installed: [], skipped: 'no third-party deps' }

  // Platform-specific venv structure
  const isWindows = process.platform === 'win32'
  const venvBinDir = isWindows ? 'Scripts' : 'bin'
  const venvPythonExe = isWindows ? 'python.exe' : 'python'
  const venvLibDir = isWindows ? 'Lib' : 'lib'

  // Find a venv with hermes_cli available (the one Hermes runs with)
  let venvPython = null
  const installDirs = await readdir(installsDir, { withFileTypes: true })
  for (const installDir of installDirs) {
    if (!installDir.isDirectory()) continue
    const envDir = join(installsDir, installDir.name, 'environments')
    if (!(await exists(envDir))) continue
    const envs = await readdir(envDir, { withFileTypes: true })
    for (const env of envs) {
      if (!env.isDirectory()) continue
      const python = join(envDir, env.name, 'venv', venvBinDir, venvPythonExe)
      if (!(await exists(python))) continue
      // Probe: can this python import hermes_cli?
      try {
        execFileSync(python, ['-c', 'import hermes_cli.web_server_dashboard'], { stdio: 'ignore', timeout: 5000 })
        venvPython = python
        break
      } catch { /* not this one */ }
    }
    if (venvPython) break
  }

  if (!venvPython) {
    return { installed: [], skipped: 'no usable Hermes venv found' }
  }

  // Find pip that can target this venv (some Hermes venvs lack pip)
  let pipPython = null
  let pipArgs = ['-m', 'pip', 'install']
  let targetArgs = []
  // Check if venv has its own pip
  try {
    execFileSync(venvPython, ['-m', 'pip', '--version'], { stdio: 'ignore', timeout: 3000 })
    pipPython = venvPython
  } catch {
    // Fallback: find a system python with pip, then use --target pointing to venv site-packages
    // Get the actual site-packages path from the venv Python interpreter (avoids Node version mismatch)
    let sitePackages
    try {
      const purelib = execFileSync(venvPython, ['-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        timeout: 3000
      }).trim()
      sitePackages = purelib
    } catch {
      // Fallback: best-effort path construction if sysconfig fails
      const venvRoot = venvPython.replace(join(venvBinDir, venvPythonExe), '')
      sitePackages = join(venvRoot, venvLibDir, isWindows ? 'site-packages' : `python${process.version.match(/\d+\.\d+/)?.[0] || '3.12'}/site-packages`)
    }
    targetArgs = ['--target', sitePackages]

    // Probe candidate system pythons for one with pip
    const localAppData = process.env.LOCALAPPDATA || ''
    const candidates = isWindows
      ? [
          // Allow override via SYSTEM_PYTHON env var
          process.env.SYSTEM_PYTHON || '',
          // Common Windows Python locations (expand globs)
          'C:/Python*/python.exe',
          'C:/Program Files/Python*/python.exe',
          'C:/Program Files (x86)/Python*/python.exe',
          // Microsoft Store Python
          localAppData ? join(localAppData, 'Microsoft', 'WindowsApps', 'python.exe') : '',
          // Fall back to PATH
          'python'
        ].filter(Boolean).flatMap(p => {
          // Expand glob patterns on Windows
          if (p.includes('*')) {
            try {
              const matches = execFileSync('cmd', ['/c', `dir /b ${p} 2>nul`], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 3000 })
              return matches.trim().split('\n').filter(Boolean).map(m => join(m, 'python.exe'))
            } catch { return [] }
          }
          return p
        })
      : ['python3', 'python', '/usr/bin/python3', '/usr/bin/python']

    for (const cand of candidates) {
      try {
        execFileSync(cand, ['-m', 'pip', '--version'], { stdio: 'ignore', timeout: 3000 })
        pipPython = cand
        break
      } catch { /* try next */ }
    }
    if (!pipPython) {
      return { installed: [], skipped: 'no system python with pip found for fallback' }
    }
  }

  const installed = []
  for (const dep of needed) {
    const modName = dep.split('>=')[0].replace('-', '_')
    try {
      execFileSync(venvPython, ['-c', `import ${modName}`], { stdio: 'ignore', timeout: 5000 })
    } catch {
      if (!dryRun) {
        execFileSync(pipPython, pipArgs.concat(targetArgs, dep), { stdio: 'pipe', timeout: 30000 })
        installed.push(dep)
      } else {
        installed.push(`${dep} (would install)`)
      }
    }
  }
  return { installed, venv: venvPython }
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

  // 2c. ensure Python runtime dependencies are installed in the Hermes venv
  const depResult = await ensurePythonDeps(home, { dryRun })
  if (depResult.installed.length) {
    report.notes.push(`installed Python deps: ${depResult.installed.join(', ')}`)
  } else if (depResult.skipped) {
    report.notes.push(`Python deps: ${depResult.skipped}`)
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
  console.log('Next: restart Hermes Desktop (fully quit every Hermes process) so the runtime plugin')
  console.log('loader picks up plugin.js, then open the "Spec Kit" pane in the right sidebar.')
}
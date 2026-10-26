#!/usr/bin/env node
/**
 * One command to run before pushing. Every gate here exists because a specific
 * mistake shipped without it.
 *
 *   build      - a bundle that references an undefined name still builds, so this
 *                is necessary and nowhere near sufficient.
 *   node tests - the pane's own decisions and the installer's path handling.
 *   backend    - router suite, then the Hermes-marked suite when Hermes is here.
 *   claims     - any count stated in the docs must match what just ran.
 *   docs       - design.html must be what design.md renders to.
 *
 * Failure is reported, never swallowed: a command that cannot start prints why,
 * and a broken Hermes install is an error rather than an optional absence.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLAIMS_FILE = join(ROOT, '.claims.json')
const DESIGN_HTML = join(ROOT, 'docs', 'design.html')

// CI stages Hermes in a venv; point the python steps at it with PREFLIGHT_PYTHON.
const PY = process.env.PREFLIGHT_PYTHON || 'python'
// Windows: npm is npm.cmd and node refuses to spawn a .cmd without a shell, so the
// scripts are invoked through the running interpreter instead.

const steps = []
let failed = false

function run(name, command, args) {
  process.stdout.write(`\n== ${name}\n`)
  try {
    const output = execFileSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    process.stdout.write(output.trim().split('\n').slice(-3).join('\n') + '\n')
    steps.push({ name, ok: true })
    return output
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`.trim()
    if (output) {
      process.stdout.write(output.split('\n').slice(-12).join('\n') + '\n')
    }
    // A spawn failure (ENOENT) has no stdout at all, and saying "FAIL" with no
    // reason sends people looking at the wrong thing.
    if (error.code && !output) {
      process.stdout.write(`could not run ${command}: ${error.message}\n`)
      if (command === PY) process.stdout.write('set PREFLIGHT_PYTHON, or install python3 and use it\n')
    }
    steps.push({ name, ok: false })
    failed = true
    return error.stdout || ''
  }
}

function numbers(output, patterns) {
  for (const pattern of patterns) {
    const match = output.match(pattern)
    if (match) return match.slice(1).map(Number)
  }
  return null
}

run('build', process.execPath, [join(ROOT, 'scripts', 'build.mjs')])

const nodeOut = run('node tests', process.execPath, ['--test', join(ROOT, 'test') + '/'])
const node = (nodeOut.match(/^# pass (\d+)/m) || nodeOut.match(/ℹ pass (\d+)/) || [])[1]
const nodeTotal = node == null ? null : Number(node)
const nodeFails = (nodeOut.match(/^# fail (\d+)/m) || nodeOut.match(/ℹ fail (\d+)/) || [])[1]
if (nodeFails != null && Number(nodeFails) > 0) {
  process.stdout.write(`node reported ${nodeFails} failures\n`)
  failed = true
  steps.push({ name: 'node tests clean', ok: false })
}

const routerOut = run('backend: router suite', PY, [
  '-m', 'pytest', 'tests/backend', '-q', '-m', 'not hermes'
])
const routerPair = numbers(routerOut, [/(\d+) passed(?:, (\d+) deselected)?/])
const router = routerPair ? routerPair[0] : null
const routerDeselected = routerPair && routerPair[1] != null ? routerPair[1] : 0

// Hermes is optional on a dev machine; CI runs this same script with it staged.
// Absent Hermes is a skip. A Hermes that is installed but broken is an error, and
// saying "skipped" then would hide something the user has to fix.
let hermes = null
let hermesDeselected = null
process.stdout.write('\n== backend: hermes suite\n')
let probe
try {
  execFileSync(PY, ['-c', 'import hermes_cli.web_server_dashboard'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8'
  })
  probe = 'present'
} catch (error) {
  const stderr = `${error.stderr || ''}`
  probe = /ModuleNotFoundError|No module named 'hermes_cli'/.test(stderr) ? 'absent' : 'broken'
  if (probe === 'broken') {
    process.stdout.write(`${stderr.trim().split('\n').slice(-6).join('\n')}\n`)
    process.stdout.write('Hermes is installed but does not import; fix that rather than skipping the suite\n')
    steps.push({ name: 'hermes import probe', ok: false })
    failed = true
  }
}

if (probe === 'present') {
  const hermesOut = run('backend: hermes suite (running)', PY, [
    '-m', 'pytest', 'tests/backend', '-q', '-m', 'hermes'
  ])
  const hermesPair = numbers(hermesOut, [/(\d+) passed(?:, (\d+) deselected)?/])
  hermes = hermesPair ? hermesPair[0] : null
  hermesDeselected = hermesPair && hermesPair[1] != null ? hermesPair[1] : 0
} else if (probe === 'absent') {
  process.stdout.write('skipped (hermes_cli not importable on this interpreter)\n')
}

const measured = nodeTotal != null && router != null
if (!measured) {
  process.stdout.write('\ncounts could not be read, so the docs claims cannot be checked\n')
  steps.push({ name: 'counts readable', ok: false })
  failed = true
} else {
  writeFileSync(
    CLAIMS_FILE,
    JSON.stringify(
      {
        node: nodeTotal,
        router,
        routerDeselected,
        hermes,
        hermesDeselected
      },
      null,
      2
    ) + '\n'
  )
  run('numeric claims in docs', process.execPath, [join(ROOT, 'scripts', 'check-claims.mjs')])
}

// Read the HTML before rendering: a correct pair that is staged but not yet
// committed must not read as stale. Fail only if rendering changes the file.
const before = existsSync(DESIGN_HTML) ? readFileSync(DESIGN_HTML, 'utf8') : null
run('regenerate docs', process.execPath, [join(ROOT, 'scripts', 'render-docs.mjs')])
process.stdout.write('\n== docs/design.html is current\n')
const after = existsSync(DESIGN_HTML) ? readFileSync(DESIGN_HTML, 'utf8') : null
if (before !== after) {
  process.stdout.write('rendering changed design.html: commit the regenerated file\n')
  steps.push({ name: 'docs current', ok: false })
  failed = true
} else {
  process.stdout.write('unchanged\n')
  steps.push({ name: 'docs current', ok: true })
}

console.log('\n== summary')
for (const step of steps) console.log(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.name}`)
const shown = (value) => (value == null ? 'not measured' : value)
console.log(
  `  counts: node ${shown(nodeTotal)}, router ${shown(router)}, hermes ${shown(hermes)}` +
    (router != null ? ` (deselected ${routerDeselected}/${shown(hermesDeselected)})` : '')
)
process.exit(failed ? 1 : 0)

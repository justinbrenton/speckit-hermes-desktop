#!/usr/bin/env node
/**
 * One command to run before pushing. Every gate here exists because a specific
 * mistake shipped without it.
 *
 *   build      - a bundle that references an undefined name still builds, so this
 *                is necessary but nowhere near sufficient.
 *   node tests - the pane's own decisions and the installer's path handling.
 *   backend    - router suite, then the Hermes-marked suite when Hermes is
 *                importable. Both counts are recorded so prose can be checked.
 *   claims     - any "N tests" stated in the docs must match what just ran.
 *   docs       - design.html must be what design.md renders to, not an older copy.
 *
 * It does not read the diff for you. `git diff` before `git commit` is still the
 * step that catches a half-applied edit.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const steps = []
let failed = false

// CI stages Hermes in a venv; point the python steps at it with PREFLIGHT_PYTHON.
const PY = process.env.PREFLIGHT_PYTHON || 'python'

// Call the scripts directly rather than through npm: npm is npm.cmd on Windows,
// and Node refuses to spawn a .cmd without a shell.

function run(name, command, args, options = {}) {
  process.stdout.write(`\n== ${name}\n`)
  try {
    const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
    process.stdout.write(output.trim().split('\n').slice(-3).join('\n') + '\n')
    steps.push({ name, ok: true })
    return output
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`
    process.stdout.write(output.trim().split('\n').slice(-12).join('\n') + '\n')
    steps.push({ name, ok: false })
    failed = true
    return output
  }
}

function count(output, patterns) {
  for (const pattern of patterns) {
    const match = output.match(pattern)
    if (match) return Number(match[1])
  }
  return null
}

run('build', process.execPath, ['scripts/build.mjs'])

const nodeOut = run('node tests', 'node', ['--test', 'test/'])
const node = count(nodeOut, [/^# pass (\d+)/m, /ℹ pass (\d+)/]) ?? 0

const routerOut = run('backend: router suite', PY, ['-m', 'pytest', 'tests/backend', '-q', '-m', 'not hermes'])
const router = count(routerOut, [/(\d+) passed/]) ?? 0

// Hermes is optional on a dev machine; CI runs this same script with it staged.
// null, not 0: a suite that did not run cannot be compared against.
let hermes = null
try {
  execFileSync(PY, ['-c', 'import hermes_cli.web_server_dashboard'], { stdio: 'ignore' })
  const hermesOut = run('backend: hermes suite', PY, ['-m', 'pytest', 'tests/backend', '-q', '-m', 'hermes'])
  hermes = count(hermesOut, [/(\d+) passed/]) ?? 0
} catch {
  console.log('\n== backend: hermes suite\nskipped (hermes_cli not importable here)')
}

writeFileSync('.claims.json', JSON.stringify({ node, router, hermes }, null, 2) + '\n')

run('numeric claims in docs', 'node', ['scripts/check-claims.mjs'])

run('regenerate docs', process.execPath, ['scripts/render-docs.mjs'])
process.stdout.write('\n== docs/design.html is current\n')
try {
  // Against HEAD, not the index: an untracked or ignored file would otherwise
  // make this pass by comparing nothing.
  execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'docs/design.html'], { stdio: 'ignore' })
  process.stdout.write('unchanged\n')
  steps.push({ name: 'docs current', ok: true })
} catch {
  process.stdout.write('design.html changed: commit the regenerated file\n')
  steps.push({ name: 'docs current', ok: false })
  failed = true
}

console.log('\n== summary')
for (const step of steps) console.log(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.name}`)
const shown = (value) => (value == null ? 'not measured' : value)
console.log(`  counts: node ${shown(node)}, router ${shown(router)}, hermes ${shown(hermes)}`)
process.exit(failed ? 1 : 0)

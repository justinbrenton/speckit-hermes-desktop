#!/usr/bin/env node
/**
 * Install the local git hook that runs preflight before every commit.
 *
 * Twice now a commit has gone in while preflight was red, and the fix landed in
 * the following commit. The gate was right both times; the human step of running
 * it was the weak link. Hooks are not cloned, so this is one command per checkout:
 *
 *   npm run hooks
 *
 * `--no-verify` still exists for a genuine emergency, which is the point: it has
 * to be typed on purpose.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const hooks = join(root, '.git', 'hooks')

if (!existsSync(join(root, '.git'))) {
  console.error('not a git checkout: .git is missing')
  process.exit(1)
}

mkdirSync(hooks, { recursive: true })

const hook = `#!/bin/sh
# Installed by scripts/install-hooks.mjs. Remove it or pass --no-verify to skip.
echo "preflight: build, both suites, documented counts, rendered docs"
if ! node scripts/preflight.mjs; then
  echo
  echo "preflight failed, so the commit was stopped."
  echo "Fix what it reported. To commit anyway: git commit --no-verify"
  exit 1
fi
`

const path = join(hooks, 'pre-commit')
writeFileSync(path, hook, { mode: 0o755 })
try {
  chmodSync(path, 0o755)
} catch {
  // Windows has no executable bit; git for windows runs it with sh regardless.
}

console.log(`installed ${path}`)
console.log('every commit now runs: node scripts/preflight.mjs')

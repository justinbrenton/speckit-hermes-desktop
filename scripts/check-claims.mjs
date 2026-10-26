#!/usr/bin/env node
/**
 * Verify the numbers this repo states about its own tests.
 *
 * Failure modes this exists to stop, all of which shipped here:
 *  - a count quoted from a run made before the suites were re-partitioned;
 *  - a count fixed in one place and left stale in another;
 *  - a count that survived because this checker's own pattern was too narrow.
 *
 * Rules: every recognised form is checked, an unreadable input fails closed, and a
 * run that checked too few claims fails rather than passes. A suite that could not
 * be measured here is unknown, not zero; claims that depend on it are skipped and
 * counted, not silently satisfied.
 *
 * Paths resolve from this file, not the working directory, so running from a
 * subdirectory cannot check nothing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLAIMS_FILE = join(ROOT, '.claims.json')

//: Below this the checker is not looking at what it thinks it is. Catches a
//: narrowed file list, a renamed document, or a run from the wrong tree.
const MIN_CLAIMS = 8

if (!existsSync(CLAIMS_FILE)) {
  console.error(`no .claims.json at ${CLAIMS_FILE}; run \`node scripts/preflight.mjs\` first`)
  process.exit(2)
}

const counts = JSON.parse(readFileSync(CLAIMS_FILE, 'utf8'))
// null means "not measured here" (no Hermes on this machine), never zero.
const known = {
  node: counts.node ?? null,
  router: counts.router ?? null,
  hermes: counts.hermes ?? null,
  total: counts.router != null && counts.hermes != null ? counts.router + counts.hermes : null
}

const files = ['README.md', 'docs/TESTING.md', 'docs/design.md', 'docs/VERIFICATION.md']

/**
 * [regex, value group, resolver]. The resolver returns every number the claim
 * could legitimately mean, with null where it cannot be measured here. Adding a
 * new way of writing a count in the docs means adding a rule, which is the point:
 * a pattern that misses a form turns a check into decoration.
 */
const RULES = [
  // "72 backend tests", "40 node tests"
  [
    /(\d[\d,]*)\s+(node|backend|router|hermes)\s+tests?/gi,
    1,
    (kind) => {
      if (kind === 'node') return [known.node]
      if (kind === 'router') return [known.router]
      if (kind === 'hermes') return [known.hermes]
      return [known.router, known.total]
    }
  ],
  // A table row: "40 tests, 40 pass, 0 fail"
  [/(\d[\d,]*)\s+tests?,\s*(\d[\d,]*)\s+pass/gi, 1, () => [known.node]],
  // "72 passed, 5 deselected" for either backend suite
  [/(\d[\d,]*)\s+passed,\s*\d[\d,]*\s+deselected/gi, 1, () => [known.router, known.hermes]],
  // node's own reporter pasted into a doc: "ℹ tests 40", "# tests 40", "ℹ pass 40"
  [/[ℹ#]\s*(?:tests|pass)\s+(\d[\d,]*)/g, 1, () => [known.node]]
]

const problems = []
let checked = 0
let skipped = 0

for (const name of files) {
  const path = join(ROOT, name)
  if (!existsSync(path)) {
    problems.push(`${name} is missing, so its claims cannot be checked`)
    continue
  }
  const text = readFileSync(path, 'utf8')
  for (const [regex, group, resolveClaim] of RULES) {
    for (const match of text.matchAll(regex)) {
      const claimed = Number(match[group].replace(/,/g, ''))
      const options = resolveClaim((match[2] || '').toLowerCase())
      const usable = options.filter((value) => value != null)
      // A suite this machine could not measure makes the claim unverifiable, not
      // wrong: skip it rather than demand a number we do not have.
      const unmeasurable = options.some((value) => value == null)
      if (usable.length === 0 || (unmeasurable && !usable.includes(claimed))) {
        skipped += 1
        continue
      }
      checked += 1
      if (!usable.includes(claimed)) {
        problems.push(
          `${name}: "${match[0].trim().replace(/\s+/g, ' ')}" but the suites report ${[...new Set(usable)].join(' or ')}`
        )
      }
    }
  }
}

const measured = Object.entries(known)
  .map(([kind, value]) => `${kind} ${value == null ? 'not measured' : value}`)
  .join(', ')
console.log(`checked ${checked} claims (${measured}); skipped ${skipped} this machine cannot measure`)

if (checked < MIN_CLAIMS) {
  problems.push(
    `only ${checked} claims were checked, fewer than the ${MIN_CLAIMS} expected; the checker is not looking at what it thinks it is`
  )
}

if (problems.length) {
  console.error('\nStale, wrong or unchecked numbers:')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error('\nNumbers in prose must come from a run made after the last change.')
  process.exit(1)
}

#!/usr/bin/env node
/**
 * Verify the numbers this repo states about its own tests.
 *
 * Failure modes this exists to stop, all of which shipped here:
 *  - a count quoted from a run made before the suites were re-partitioned;
 *  - a count fixed in one place and left stale in another;
 *  - a count that survived because this checker's pattern was too narrow, or
 *    because only the first number in a row was compared.
 *
 * Rules: every documented form is checked, every number in that form is compared,
 * an unreadable input fails closed, and a run that checked too few claims fails
 * rather than passes. A suite that could not be measured here is unknown, not zero:
 * claims that depend on it are skipped and counted.
 *
 * Paths resolve from this file, not the working directory, so running from a
 * subdirectory cannot check nothing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLAIMS_FILE = join(ROOT, '.claims.json')

//: Below this the checker is not looking at what it thinks it is.
const MIN_CLAIMS = 8

if (!existsSync(CLAIMS_FILE)) {
  console.error(`no .claims.json at ${CLAIMS_FILE}; run \`node scripts/preflight.mjs\` first`)
  process.exit(2)
}

const counts = JSON.parse(readFileSync(CLAIMS_FILE, 'utf8'))
const n = (value) => (value == null ? null : Number(value))
const node = n(counts.node)
const router = n(counts.router)
const hermes = n(counts.hermes)
const routerDeselected = n(counts.routerDeselected)
const hermesDeselected = n(counts.hermesDeselected)
const total = router != null && hermes != null ? router + hermes : null
const totalDeselected =
  routerDeselected != null && hermesDeselected != null ? routerDeselected + hermesDeselected : null

const files = ['README.md', 'docs/TESTING.md', 'docs/design.md', 'docs/VERIFICATION.md']

/**
 * A rule matches a documented form and returns the tuples that form could
 * legitimately state. Every captured number is compared, so "40 tests, 39 pass"
 * fails even though its first number is right. A null inside any candidate makes
 * that candidate unverifiable here, which is skipped, not failed.
 */
const RULES = [
  {
    // "72 backend tests", "40 node tests"
    regex: /(\d[\d,]*)\s+(node|backend|router|hermes)\s+tests?/gi,
    candidates: (match) => {
      const kind = (match[2] || '').toLowerCase()
      if (kind === 'node') return [[node]]
      if (kind === 'router') return [[router]]
      if (kind === 'hermes') return [[hermes]]
      return [[router], [total]]
    }
  },
  {
    // A table row: "40 tests, 40 pass, 0 fail"
    regex: /(\d[\d,]*)\s+tests?,\s*(\d[\d,]*)\s+pass(?:,\s*(\d[\d,]*)\s+fail)?/gi,
    candidates: () => [[node, node, 0]]
  },
  {
    // "72 passed, 5 deselected" for either backend suite, paired with its own total
    regex: /(\d[\d,]*)\s+passed,\s*(\d[\d,]*)\s+deselected/gi,
    candidates: () => [
      [router, routerDeselected],
      [hermes, hermesDeselected],
      [total, totalDeselected]
    ]
  },
  {
    // node's own reporter pasted into a doc: "ℹ tests 40", "# pass 40"
    regex: /[ℹ#]\s*(?:tests|pass)\s+(\d[\d,]*)/g,
    candidates: () => [[node]]
  }
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
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.regex)) {
      // Only the numeric groups: some rules capture a word (the suite name) as well.
      const claimed = match
        .slice(1)
        .filter((value) => value !== undefined && /^\d[\d,]*$/.test(String(value)))
        .map((value) => Number(String(value).replace(/,/g, '')))
      const candidates = rule.candidates(match)
      const verifiable = candidates.filter((tuple) => tuple.every((value) => value != null))
      const unverifiable = candidates.some((tuple) => tuple.some((value) => value == null))
      const matches = verifiable.some((tuple) => tuple.length === claimed.length && tuple.every((value, index) => value === claimed[index]))
      if (matches) {
        checked += 1
        continue
      }
      if (unverifiable && verifiable.length === 0) {
        skipped += 1
        continue
      }
      // Unverifiable and nothing matched: we cannot tell, so say so rather than pass it.
      if (unverifiable) {
        skipped += 1
        continue
      }
      checked += 1
      const expected = verifiable.map((tuple) => tuple.join(' / ')).join(' or ')
      problems.push(
        `${name}: "${match[0].trim().replace(/\s+/g, ' ')}" but the suites report ${expected}`
      )
    }
  }
}

const measured = [
  `node ${node ?? 'not measured'}`,
  `router ${router ?? 'not measured'}`,
  `hermes ${hermes ?? 'not measured'}`,
  `deselected ${routerDeselected ?? '?'}/${hermesDeselected ?? '?'}`
].join(', ')
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

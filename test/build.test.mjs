/**
 * Assertions on the built artifact. The desktop shell evaluates plugin.js as one
 * ES module with only `@hermes/plugin-sdk` and `react*` resolvable, so the build
 * must be self-contained and syntactically valid ESM.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { build } from '../scripts/build.mjs'

const run = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'desktop/plugin.js')

const ALLOWED_SPECIFIERS = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime', 'react-dom'])

async function source() {
  await build({ root: ROOT })
  return readFile(OUT, 'utf8')
}

test('build inlines the core and leaves a single import surface', async () => {
  const code = await source()

  assert.equal(code.includes('/* CORE_INJECT */'), false)
  assert.equal(code.includes('from \'./core.mjs\''), false)
  assert.equal(code.includes("from './core.mjs'"), false)

  const specifiers = [...code.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1])
  assert.ok(specifiers.length >= 3, specifiers.join(', '))
  for (const specifier of specifiers) {
    assert.ok(ALLOWED_SPECIFIERS.has(specifier), `unexpected import: ${specifier}`)
  }

  // core symbols really are present in the bundle
  for (const symbol of ['parseSpec', 'serializeSpec', 'parseTasks', 'serializeConstitution', 'decideSync', 'STEPS']) {
    assert.ok(code.includes(symbol), `missing ${symbol}`)
  }
})

test('the built plugin registers exactly one pane', async () => {
  const code = await source()
  const paneRegistrations = [...code.matchAll(/area:\s*PANES_AREA/g)]
  assert.equal(paneRegistrations.length, 1, 'v2 must register one master pane, not three')
  assert.match(code, /id: 'spec-kit'/)
  assert.equal(/id: 'spec-builder'|id: 'task-board'|id: 'constitution-wizard'/.test(code), false)
})

test('the built plugin only talks to its own REST namespace', async () => {
  const code = await source()
  // every backend call goes through ctx.rest with a relative path
  // Template literals carry query strings, so accept all three quote styles.
  const calls = [...code.matchAll(/rest\((['"`])([^'"`]+)/g)].map(match => match[2])
  assert.ok(calls.length > 0)
  for (const call of calls) {
    assert.ok(call.startsWith('/'), `rest path must be namespace-relative: ${call}`)
    assert.equal(call.startsWith('/api/'), false, `rest path must not repeat the namespace: ${call}`)
  }
})

test('the built plugin is valid ESM and stays under the shell size limit', async () => {
  const code = await source()
  const bytes = Buffer.byteLength(code, 'utf8')
  assert.ok(bytes < 512 * 1024, `plugin.js is ${bytes} bytes`)

  const probe = join(ROOT, '.build-probe.mjs')
  await writeFile(probe, code, 'utf8')
  await run(process.execPath, ['--check', probe])
  const leftovers = await readdir(ROOT)
  assert.ok(leftovers.includes('.build-probe.mjs'))
})

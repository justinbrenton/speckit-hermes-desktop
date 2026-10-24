/**
 * Load the BUILT plugin the way the desktop runtime does — rewritten specifiers,
 * module evaluation, `default` export, `register(ctx)` — with the SDK and React
 * replaced by recorders.
 *
 * This is the test that catches "the app says: no valid default HermesPlugin
 * export", because it evaluates the real artifact instead of grepping it.
 */
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from '../scripts/build.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STUBS = join(ROOT, 'test/stubs')
const PROBE = join(ROOT, '.smoke-probe.mjs')

function rewrite(code) {
  const stub = name => pathToFileURL(join(STUBS, name)).href
  return code
    .replace(/(['"])@hermes\/plugin-sdk\1/g, JSON.stringify(stub('sdk.mjs')))
    .replace(/(['"])react\/jsx-runtime\1/g, JSON.stringify(stub('jsx-runtime.mjs')))
    .replace(/(['"])react\1/g, JSON.stringify(stub('react.mjs')))
}

async function loadPlugin() {
  const { target } = await build({ root: ROOT })
  const code = rewrite(await readFile(target, 'utf8'))
  await writeFile(PROBE, code, 'utf8')
  const mod = await import(`${pathToFileURL(PROBE).href}?v=${Date.now()}`)
  return mod
}

test.after(async () => {
  await rm(PROBE, { force: true })
})

test('the built plugin evaluates and exports a HermesPlugin', async () => {
  const mod = await loadPlugin()
  const plugin = mod.default
  assert.ok(plugin, 'module has no default export')
  assert.equal(plugin.id, 'spec-kit-hermes')
  assert.equal(typeof plugin.register, 'function')
  assert.equal(plugin.defaultEnabled, true)
})

test('register() wires one pane and one status item', async () => {
  const mod = await loadPlugin()
  const registrations = []
  const disposers = []
  const ctx = {
    rest: async () => ({ files: {} }),
    storage: { get: (_key, fallback) => fallback, set: () => {}, remove: () => {} },
    register: contribution => {
      registrations.push(contribution)
      return () => {}
    },
    registerMany: list => {
      list.forEach(item => registrations.push(item))
      return () => {}
    },
    onDispose: fn => disposers.push(fn),
    setInterval: () => () => {},
    setTimeout: () => () => {},
    addEventListener: () => () => {},
    os: {},
    pet: { say: () => () => {}, clear: () => {} },
    i18n: { t: key => key }
  }

  mod.default.register(ctx)

  const panes = registrations.filter(item => item.area === 'panes')
  assert.equal(panes.length, 1, 'v2 registers exactly one pane')
  assert.equal(panes[0].id, 'spec-kit')
  assert.equal(panes[0].title, 'Spec Kit')
  assert.deepEqual(panes[0].data, { placement: 'right', width: '460px', collapsible: true })
  assert.equal(typeof panes[0].render, 'function')

  const status = registrations.filter(item => item.area === 'statusBar.right')
  assert.equal(status.length, 1)

  const element = panes[0].render()
  assert.ok(element && element.type, 'render() must return an element')
})

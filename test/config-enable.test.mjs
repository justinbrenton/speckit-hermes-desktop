import assert from 'node:assert/strict'
import { test } from 'node:test'

import { enablePlugin, isPluginEnabled } from '../scripts/config-enable.mjs'

const CODie = `_config_version: 51
database:
  journal_mode: wal
plugins:
  clone_timeout_seconds: 300
  enabled:
    - bot-forge
    - prompt-enhance
  disabled: []
model:
  default: deepseek/deepseek-v4.1-flash-1017
`

test('appends to an existing block list and leaves the rest alone', () => {
  const { text, changed, alreadyEnabled } = enablePlugin(CODie, 'spec-kit-hermes')
  assert.equal(changed, true)
  assert.equal(alreadyEnabled, false)
  assert.equal(
    text,
    `_config_version: 51
database:
  journal_mode: wal
plugins:
  clone_timeout_seconds: 300
  enabled:
    - bot-forge
    - prompt-enhance
    - spec-kit-hermes
  disabled: []
model:
  default: deepseek/deepseek-v4.1-flash-1017
`
  )
  assert.equal(isPluginEnabled(text, 'spec-kit-hermes'), true)
  assert.equal(isPluginEnabled(text, 'other'), false)
})

test('is idempotent', () => {
  const first = enablePlugin(CODie, 'spec-kit-hermes').text
  const second = enablePlugin(first, 'spec-kit-hermes')
  assert.equal(second.changed, false)
  assert.equal(second.alreadyEnabled, true)
  assert.equal(second.text, first)
})

test('expands an inline empty list', () => {
  const config = 'plugins:\n  enabled: []\n  disabled: []\n'
  const { text, changed } = enablePlugin(config, 'spec-kit-hermes')
  assert.equal(changed, true)
  assert.equal(text, 'plugins:\n  enabled:\n    - spec-kit-hermes\n  disabled: []\n')
  assert.equal(isPluginEnabled(text, 'spec-kit-hermes'), true)
})

test('expands an inline populated list', () => {
  const config = 'plugins:\n  enabled: [bot-forge, "prompt-enhance"]\n'
  const { text } = enablePlugin(config, 'spec-kit-hermes')
  assert.equal(text, 'plugins:\n  enabled:\n    - bot-forge\n    - prompt-enhance\n    - spec-kit-hermes\n')
  assert.equal(isPluginEnabled(text, 'spec-kit-hermes'), true)
})

test('adds an enabled key when the plugins block lacks one', () => {
  const config = 'plugins:\n  clone_timeout_seconds: 300\nmodel:\n  default: x\n'
  const { text } = enablePlugin(config, 'spec-kit-hermes')
  assert.equal(text, 'plugins:\n  enabled:\n    - spec-kit-hermes\n  clone_timeout_seconds: 300\nmodel:\n  default: x\n')
  assert.equal(isPluginEnabled(text, 'spec-kit-hermes'), true)
})

test('creates the plugins block when it is missing', () => {
  const config = 'model:\n  default: x\n'
  const { text } = enablePlugin(config, 'spec-kit-hermes')
  assert.equal(text, 'model:\n  default: x\n\nplugins:\n  enabled:\n    - spec-kit-hermes\n')
  assert.equal(isPluginEnabled(text, 'spec-kit-hermes'), true)
})

test('preserves CRLF line endings', () => {
  const config = 'plugins:\r\n  enabled:\r\n    - bot-forge\r\n'
  const { text } = enablePlugin(config, 'spec-kit-hermes')
  assert.equal(text, 'plugins:\r\n  enabled:\r\n    - bot-forge\r\n    - spec-kit-hermes\r\n')
})

test('ignores comments and trailing comments in the list', () => {
  const config = 'plugins:\n  # the list\n  enabled:\n    - bot-forge  # default bot\n'
  const { text } = enablePlugin(config, 'spec-kit-hermes')
  assert.match(text, /    - bot-forge {2}# default bot\n    - spec-kit-hermes\n/)
  assert.equal(isPluginEnabled(text, 'spec-kit-hermes'), true)
})

test('stops at the next top-level key', () => {
  const config = 'plugins:\n  enabled:\n    - a\nmodel:\n  enabled:\n    - not-ours\n'
  const { text } = enablePlugin(config, 'spec-kit-hermes')
  assert.equal(text, 'plugins:\n  enabled:\n    - a\n    - spec-kit-hermes\nmodel:\n  enabled:\n    - not-ours\n')
})

test('refuses a name that is not a plain identifier', () => {
  assert.throws(() => enablePlugin(CODie, 'bad name'), /invalid plugin name/)
  assert.throws(() => enablePlugin(CODie, ''), /invalid plugin name/)
})

// Regression: a real Hermes config carries column-0 section banners between
// `plugins:` and its keys. Those comments do not end the mapping, but treating
// them as the end hid the existing `enabled:` list and inserted a second one,
// which is the duplicate key that broke config.yaml on 2026-10-24.
const BANNERED = `_config_version: 52
plugins:
  # Deadline for each Git clone, fetch or checkout during plugin install. Default: 300
  # seconds. Subdirectory installs download only that folder.
  clone_timeout_seconds: 300

# =============================================================================
# Model Configuration
# =============================================================================
  enabled:
    - bot-forge
    - prompt-enhance
  disabled: []
model:
  default: x
`

test('a column-0 comment banner does not hide the existing enabled list', () => {
  const { text, changed, alreadyEnabled } = enablePlugin(BANNERED, 'spec-kit-hermes')
  assert.equal(changed, true)
  assert.equal(alreadyEnabled, false)
  assert.equal((text.match(/^\s+enabled:/gm) || []).length, 1, 'must not create a second enabled key')
  assert.match(text, /    - prompt-enhance\n    - spec-kit-hermes\n  disabled: \[\]/)
  assert.equal(isPluginEnabled(text, 'spec-kit-hermes'), true)
})

test('the bannered config is already enabled after one edit', () => {
  const once = enablePlugin(BANNERED, 'spec-kit-hermes').text
  const twice = enablePlugin(once, 'spec-kit-hermes')
  assert.equal(twice.changed, false)
  assert.equal(twice.alreadyEnabled, true)
  assert.equal(twice.text, once)
})

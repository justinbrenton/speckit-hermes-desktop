/**
 * The installer replaces a live plugin.js. `plugin.js.backup` must keep the file
 * that was there BEFORE this installer ever ran — a second install overwriting it
 * destroys the only copy of the previous plugin.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { install } from '../scripts/install.mjs'

const LEGACY = '// legacy plugin.js from before the v2 install\nexport default { id: "legacy", register() {} }\n'

test('the backup holds the pre-existing plugin.js and survives a reinstall', async () => {
  const home = await mkdtemp(join(tmpdir(), 'speckit-install-'))
  try {
    const desktopDir = join(home, 'desktop-plugins', 'spec-kit-hermes')
    await mkdir(desktopDir, { recursive: true })
    await writeFile(join(desktopDir, 'plugin.js'), LEGACY, 'utf8')

    const first = await install({ profile: 'demo', home })
    assert.equal(first.home, home.replace(/\\/g, '/'), 'install must honour an explicit home')

    const backup = await readFile(join(desktopDir, 'plugin.js.backup'), 'utf8')
    assert.equal(backup, LEGACY)

    const installed = await readFile(join(desktopDir, 'plugin.js'), 'utf8')
    assert.notEqual(installed, LEGACY)
    assert.match(installed, /export default \{/)

    // Backend half landed under <home>/plugins/<id>/dashboard/
    for (const name of ['plugin_api.py', 'manifest.json', 'index.js']) {
      const file = await readFile(join(home, 'plugins', 'spec-kit-hermes', 'dashboard', name), 'utf8')
      assert.ok(file.length > 0, `${name} is empty`)
    }

    // A second install with a changed plugin.js must not touch the backup.
    await writeFile(join(desktopDir, 'plugin.js'), '// someone else, later\n', 'utf8')
    await install({ profile: 'demo', home })
    assert.equal(await readFile(join(desktopDir, 'plugin.js.backup'), 'utf8'), LEGACY)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('dry run writes nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'speckit-install-dry-'))
  try {
    const report = await install({ profile: 'demo', home, dryRun: true })
    assert.ok(report.files.length > 0)
    await assert.rejects(readFile(join(home, 'desktop-plugins', 'spec-kit-hermes', 'plugin.js')), /ENOENT/)
    await assert.rejects(readFile(join(home, 'plugins', 'spec-kit-hermes', 'dashboard', 'plugin_api.py')), /ENOENT/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

/**
 * The dashboard installs the workflows it ships into a new project, so the
 * installer has to copy them beside `dashboard/`. When it did not, `/init` read an
 * empty bundle and silently wrote nothing, which puts the unanswerable gates back
 * on every real install while a git checkout looks fine.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { install } from '../scripts/install.mjs'

const BUNDLED = ['assess', 'bugfix', 'speckit']

test('the installer ships every bundled workflow beside the dashboard', async () => {
  const home = await mkdtemp(join(tmpdir(), 'speckit-bundle-'))
  try {
    await install({ home, profile: 'test', dryRun: false })

    for (const name of BUNDLED) {
      const installed = join(home, 'plugins', 'spec-kit-hermes', 'workflows', name, 'workflow.yml')
      const source = await readFile(join(process.cwd(), 'workflows', name, 'workflow.yml'), 'utf8')
      assert.equal(await readFile(installed, 'utf8'), source, `${name} was not installed byte-for-byte`)
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

/**
 * `resolveHome` decides where both halves land, and a wrong answer installs the
 * plugin into a directory nothing scans. The cases below are the shapes that
 * actually occur: a profile-scoped HERMES_HOME (forward and back slashes, and
 * with the doubled backslashes another process can export).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveHome } from '../scripts/install.mjs'

const BS = String.fromCharCode(92)
const win = (...parts) => parts.join(BS)
const PROFILE_WIN = win('C:', 'Users', 'Fortress', 'AppData', 'Local', 'hermes', 'profiles', 'codie')
const ROOT_WIN = win('C:', 'Users', 'Fortress', 'AppData', 'Local', 'hermes')

test('unwraps a Windows profile home to the hermes root', () => {
  assert.deepEqual(resolveHome(PROFILE_WIN, {}), { home: ROOT_WIN.replace(/\\/g, '/'), profile: 'codie' })
})

test('unwraps a forward-slash profile home', () => {
  assert.deepEqual(resolveHome('C:/Users/Fortress/AppData/Local/hermes/profiles/codie', {}), {
    home: 'C:/Users/Fortress/AppData/Local/hermes',
    profile: 'codie'
  })
})

test('tolerates doubled backslashes from an exported env value', () => {
  const doubled = PROFILE_WIN.split(BS).join(BS + BS)
  assert.deepEqual(resolveHome(doubled, {}), { home: ROOT_WIN.replace(/\\/g, '/'), profile: 'codie' })
})

test('a trailing separator does not change the answer', () => {
  assert.deepEqual(resolveHome(`${PROFILE_WIN}${BS}`, {}), { home: ROOT_WIN.replace(/\\/g, '/'), profile: 'codie' })
})

test('a root path stays a root', () => {
  assert.deepEqual(resolveHome(ROOT_WIN, {}), { home: ROOT_WIN.replace(/\\/g, '/'), profile: '' })
})

test('explicit wins over the env', () => {
  assert.deepEqual(resolveHome('D:/custom/hermes', { HERMES_HOME: PROFILE_WIN }), { home: 'D:/custom/hermes', profile: '' })
})

test('falls back to LOCALAPPDATA when nothing is given', () => {
  const resolved = resolveHome('', { LOCALAPPDATA: 'C:/Users/x/AppData/Local' })
  assert.equal(resolved.profile, '')
  assert.match(resolved.home, /Local[\\/]hermes$/)
})

test('a directory that merely mentions profiles is not unwrapped', () => {
  assert.deepEqual(resolveHome('C:/work/profiles-archive', {}), { home: 'C:/work/profiles-archive', profile: '' })
  assert.deepEqual(resolveHome('C:/work/profiles/codie/extra', {}), { home: 'C:/work/profiles/codie/extra', profile: '' })
})

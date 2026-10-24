/**
 * Build desktop/plugin.js from src/pane.js + src/core.mjs.
 *
 * The plugin runtime evaluates ONE ES-module file (blob import, no bare-specifier
 * resolution except @hermes/plugin-sdk and react*), so the tested core is inlined
 * at the CORE_INJECT marker instead of imported from a relative path.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MARKER = '/* CORE_INJECT */'
const LIMIT_BYTES = 512 * 1024 // the desktop shell refuses plugin.js above this

export async function build({ root = ROOT } = {}) {
  const core = await readFile(resolve(root, 'src/core.mjs'), 'utf8')
  const pane = await readFile(resolve(root, 'src/pane.js'), 'utf8')

  if (!pane.includes(MARKER)) {
    throw new Error(`src/pane.js is missing the ${MARKER} marker`)
  }

  const inlined = core
    .replace(/^export default\s+/gm, '')
    .replace(/^export\s+(?=(const|let|function|class|async function))/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*$/gm, '')

  const banner = [
    '// ---- inlined from src/core.mjs — build artifact, edit the source instead ----',
    inlined.trim(),
    '// ---- end inlined core ----'
  ].join('\n')

  const out = pane.replace(MARKER, banner)
  const bytes = Buffer.byteLength(out, 'utf8')

  if (bytes > LIMIT_BYTES) {
    throw new Error(`plugin.js is ${bytes} bytes, above the ${LIMIT_BYTES}-byte shell limit`)
  }
  if (out.includes(MARKER)) {
    throw new Error('CORE_INJECT marker survived the build')
  }

  const target = resolve(root, 'desktop/plugin.js')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, out, 'utf8')
  return { target, bytes }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { target, bytes } = await build()
  console.log(`built ${target} (${bytes} bytes)`)
}

/**
 * The pane is a single file of plain functions. There is no type checker and no
 * renderer in this suite, so the cheapest real guard is to read the component's
 * own source and check that what it uses is declared first. A `useState` that
 * never landed is exactly how a gate card shipped referencing an undefined name.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const SOURCE = await readFile(new URL('../src/pane.js', import.meta.url), 'utf8')

function componentBody(name) {
  const start = SOURCE.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} not found in src/pane.js`)

  // Skip the destructured props: the body opens after the parameter list closes.
  let parens = 0
  let cursor = SOURCE.indexOf('(', start)
  for (; cursor < SOURCE.length; cursor += 1) {
    if (SOURCE[cursor] === '(') parens += 1
    else if (SOURCE[cursor] === ')') {
      parens -= 1
      if (parens === 0) break
    }
  }

  let depth = 0
  let index = SOURCE.indexOf('{', cursor)
  const bodyStart = index
  for (; index < SOURCE.length; index += 1) {
    if (SOURCE[index] === '{') depth += 1
    else if (SOURCE[index] === '}') {
      depth -= 1
      if (depth === 0) return SOURCE.slice(bodyStart, index)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

test('the gate card declares the state it renders', () => {
  const body = componentBody('GateCard')
  const declared = body.indexOf('const [showOutput, setShowOutput] = useState(false)')
  const used = body.indexOf('setShowOutput')
  assert.ok(declared >= 0, 'GateCard must declare showOutput before the button that toggles it')
  assert.ok(used > declared, 'the declaration must come before its use')
})

test('the gate card reads stderr as well as stdout', () => {
  const body = componentBody('GateCard')
  assert.match(body, /reviewed_stdout/, 'stdout is not read')
  assert.match(body, /reviewed_stderr/, 'a command can report only on stderr')
})

test('the gate card keeps saying when loaded output is still incomplete', () => {
  const body = componentBody('GateCard')
  assert.match(body, /full\.truncated/, 'the endpoint truncated flag must survive the load')
  assert.match(body, /still capped/, 'the card must say the loaded text is still a cap')
  assert.match(body, /const \[loadError, setLoadError\] = useState\(''/, 'a failed load needs state to render')
  assert.match(body, /setLoadError\(errorText\(err\)\)/, 'a rejected load must be caught, not swallowed')
})

test('the output loader hands the endpoint truncation back to the card', () => {
  const index = SOURCE.indexOf('onLoadFull: async () => {')
  assert.ok(index >= 0, 'the pane must supply the loader')
  const slice = SOURCE.slice(index, index + 900)
  assert.match(slice, /truncated: Boolean\(payload\.truncated\)/, 'the endpoint flag is dropped')
})

test('the folder picker falls back to the allowed listing', () => {
  const index = SOURCE.indexOf('const openBrowser = useCallback')
  assert.ok(index >= 0, 'openBrowser is missing')
  const slice = SOURCE.slice(index, index + 1200)
  assert.match(slice, /rest\('\/browse\?path='\)/, 'a refused folder must still open the allowed listing')
  assert.match(slice, /setBrowseNotice\('\)?/, 'and must say why')
})

function skCss() {
  const match = SOURCE.replace(/\r\n/g, '\n').match(/const SK_CSS = `([\s\S]*?)`\n/)
  assert.ok(match, 'SK_CSS template literal not found')
  return match[1]
}

test('every sk- class the pane uses is defined in SK_CSS', () => {
  // The truncate rule was once written as `.***`, which a browser drops without a
  // word: eight call sites did nothing and nothing failed. Classes that no rule
  // defines are invisible, so check the two lists against each other.
  const css = skCss()
  const defined = new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)\s*[:{,]/g)].map(m => m[1]))

  // Every sk- token in a string literal or template: a class can reach className
  // through a map (STATUS[...] returns one) and a literal-only scan misses it.
  const used = new Set()
  for (const match of SOURCE.matchAll(/'([^'\n]*)'|`([^`]*)`/g)) {
    const text = match[1] ?? match[2] ?? ''
    for (const token of text.split(/[\s${}]+/)) {
      if (/^sk-[a-z0-9-]+$/.test(token)) used.add(token)
    }
  }

  const missing = [...used].filter(name => !defined.has(name))
  assert.deepEqual(missing, [], `styling classes with no rule: ${missing.join(', ')}`)
})

test('SK_CSS contains no selector a browser would drop', () => {
  const css = skCss()
  // Every rule here is a class selector. Anything that is not one, or that carries
  // a template artefact, cannot match an element and is silently dead CSS.
  const selectors = [...css.matchAll(/^\s*([^\s{@][^{]*)\{/gm)].map(m => m[1].trim())
  const invalid = selectors.filter(sel => !sel.startsWith('.') || /[`$]/.test(sel))
  assert.deepEqual(invalid, [], `these selectors cannot match anything: ${invalid.join(', ')}`)
})

test('every component that calls useState imports it', () => {
  const calls = SOURCE.match(/= useState\(/g) || []
  if (calls.length === 0) return
  assert.match(SOURCE, /import \{[^}]*useState[^}]*\} from 'react'/, 'useState is used but not imported')
})

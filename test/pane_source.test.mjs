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

// One valid class selector, optionally with a pseudo-class or pseudo-element.
const SELECTOR = /^\.[a-z][a-z0-9-]*(:{1,2}[a-z-]+(\([^)]*\))?)*$/

function deadSelectors(css) {
  // Comments sit before rules and would otherwise be read as part of a selector.
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const dead = []
  for (const match of css.matchAll(/^\s*([^\s{@][^{]*)\{/gm)) {
    // A rule's selector list is comma separated: one bad entry drops the whole rule,
    // so each part is checked, not the joined string.
    for (const part of match[1].split(',')) {
      const selector = part.trim()
      // Reject leading/trailing/consecutive combinators before splitting:
      // `.sk-a +` (trailing), `+ .sk-a` (leading), `.sk-a ++ .sk-b` (consecutive)
      if (/^[\s>+~]/.test(selector) || /[\s>+~]$/.test(selector) || /[>+~]{2,}/.test(selector)) {
        dead.push(selector)
        continue
      }
      // A compound may be joined to another by a descendant space or a combinator,
      // and each compound has to stand on its own: `.a + .b` is fine, `.a + ***` is not.
      const compounds = selector.split(/[\s>+~]+/).filter(Boolean)
      const bad = compounds.length === 0 || compounds.some(compound => !SELECTOR.test(compound))
      if (bad) dead.push(selector)
    }
  }
  return dead
}

test('every selector in SK_CSS can match an element', () => {
  const dead = deadSelectors(skCss())
  assert.deepEqual(dead, [], `these selectors cannot match anything: ${dead.join(', ')}`)
})

test('a malformed selector in a list is caught, not waved through', () => {
  // The shape that shipped once: a valid class followed by a broken selector. The
  // browser drops the entire rule, which is why checking only the first token misses it.
  assert.deepEqual(deadSelectors('.sk-truncate, .*** { overflow: hidden; }'), ['.***'])
  assert.deepEqual(deadSelectors('.sk-a, .sk-b:hover { color: red; }'), [])
  assert.deepEqual(deadSelectors('.sk-a + .sk-b { color: red; }'), [])
  assert.deepEqual(deadSelectors('.sk-a > .*** { color: red; }'), ['.sk-a > .***'])
  assert.deepEqual(deadSelectors('.sk-a::before { content: ""; }'), [])
})

test('the chooser renders the workflows discovery returned', () => {
  const body = componentBody('ProcessChoice')
  // Hard-coding three names hid every workflow a project installed for itself.
  assert.ok(!/children:\s*PROCESS_COPY\.map/.test(body), 'the chooser must not render from a fixed list')
  assert.match(body, /cards\.map\(entry =>/, 'it must map the discovered processes')
  assert.match(body, /entry\.name \|\| entry\.id/, 'an unknown workflow needs a fallback title')
  assert.match(body, /No workflows found in this folder/, 'and an empty folder needs a state')
})

test('starting a workflow shapes only the workflows this plugin generates', () => {
  const index = SOURCE.indexOf('const start = useCallback')
  assert.ok(index >= 0, 'start is missing')
  const slice = SOURCE.slice(index, index + 1600)
  // A custom workflow already has its file; asking the backend to shape it is a 400.
  assert.match(slice, /const generated = !__str\(process\.source\)/, 'the shape call needs a guard')
  assert.match(slice, /if \(generated\) \{/, 'and must be behind it')
})

test('every component that calls useState imports it', () => {
  const calls = SOURCE.match(/= useState\(/g) || []
  if (calls.length === 0) return
  assert.match(SOURCE, /import \{[^}]*useState[^}]*\} from 'react'/, 'useState is used but not imported')
})

// Every token below is defined by the desktop app's own stylesheets (read from
// hermes-agent/apps/desktop/src on 2026-10-27, app 0.22.2). A var() naming a token
// that is not defined resolves to nothing and the declaration is dropped silently:
// that is exactly how --ui-border made every border in this pane fall back to
// currentColor, which in turn made the card hover invisible.
const APP_TOKENS = new Set([
  '--ui-text-primary',
  '--ui-text-secondary',
  '--ui-text-tertiary',
  '--ui-bg-tertiary',
  '--ui-bg-card',
  '--ui-accent',
  '--ui-green',
  '--ui-orange',
  '--ui-row-hover-background',
  '--color-border',
  '--color-destructive'
])

test('SK_CSS only reads tokens the desktop app defines', () => {
  const used = [...skCss().matchAll(/var\((--[a-z0-9-]+)/g)].map(match => match[1])
  const unknown = [...new Set(used)].filter(token => !APP_TOKENS.has(token))
  assert.deepEqual(unknown, [], `the app does not define: ${unknown.join(', ')}`)
})

test('every var() in SK_CSS names a fallback', () => {
  // A chain of undefined tokens is not a near miss, it is a dropped property.
  // CSS allows whitespace before the closing paren: var(--token ) is valid.
  const bare = [...skCss().matchAll(/var\((--[a-z0-9-]+)\s*\)/g)].map(match => match[1])
  assert.deepEqual([...new Set(bare)], [], `no fallback: ${[...new Set(bare)].join(', ')}`)
})

test('the version the pane shows is the version the package ships', async () => {
  // A pane displaying a stale plugin.js is the only way to tell the renderer
  // loaded an old build, so the number has to be the real one.
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const shown = SOURCE.match(/const VERSION = '([^']+)'/)[1]
  assert.equal(shown, pkg.version)
})


test('deadSelectors rejects trailing combinator', () => {
  assert.deepEqual(deadSelectors('.sk-a + { color: red; }'), ['.sk-a +'])
})

test('deadSelectors rejects leading combinator', () => {
  assert.deepEqual(deadSelectors('+ .sk-a { color: red; }'), ['+ .sk-a'])
})

test('deadSelectors rejects consecutive combinators', () => {
  // Only same-character consecutive combinators (++) are caught by the simple regex.
  // Mixed combinators like '+ >' are valid CSS grammar (A + B > C) but with
  // missing left operand they'd be caught by the compound test if we tracked positions.
  assert.deepEqual(deadSelectors('.sk-a ++ .sk-b { color: red; }'), ['.sk-a ++ .sk-b'])
})

test('var() fallback guard catches whitespace before )', () => {
  const css = '.sk-test { color: var(--ui-accent ); }'
  const bare = [...css.matchAll(/var\((--[a-z0-9-]+)\s*\)/g)].map(match => match[1])
  // The guard is that a var() with whitespace before ) AND no fallback should be flagged
  // This test verifies the regex pattern can match var(--token ) syntax
  assert.ok(bare.includes('--ui-accent'), 'regex should match var(--token ) with whitespace')
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const SOURCE = await readFile(new URL('../src/pane.js', import.meta.url), 'utf8')

/**
 * Extract the markdown helper block from src/pane.js and evaluate it.
 * Safe: this evaluates the project's own trusted source, not user input.
 */
function extractMarkdownHelpers() {
  const start = SOURCE.indexOf('function escapeHtml(text)')
  const end = SOURCE.indexOf('function IntegrationBanner(')
  assert.ok(start >= 0, 'escapeHtml not found in src/pane.js')
  assert.ok(end >= 0, 'IntegrationBanner not found in src/pane.js')

  // Slice out the helper block and wrap it so the functions become locals
  const block = SOURCE.slice(start, end).trim()
  const fn = new Function(`${block}; return { escapeHtml, sanitizeUrl, renderInlineMd, renderMarkdown }`)
  return fn()
}

const { escapeHtml, sanitizeUrl, renderInlineMd, renderMarkdown } = extractMarkdownHelpers()

test('sanitizeUrl allows http and https links', () => {
  assert.equal(sanitizeUrl('https://example.com'), 'https://example.com')
  assert.equal(sanitizeUrl('http://example.com'), 'http://example.com')
})

test('sanitizeUrl allows mailto links', () => {
  assert.equal(sanitizeUrl('mailto:user@example.com'), 'mailto:user@example.com')
})

test('sanitizeUrl blocks javascript and data URLs', () => {
  assert.equal(sanitizeUrl('javascript:alert(1)'), '#')
  assert.equal(sanitizeUrl('data:text/html,<script>alert(1)</script>'), '#')
})

test('sanitizeUrl handles empty and relative URLs', () => {
  assert.equal(sanitizeUrl(''), '')
  assert.equal(sanitizeUrl('/relative/path'), '/relative/path')
  assert.equal(sanitizeUrl('relative/path'), 'relative/path')
})

test('renderInlineMd escapes HTML', () => {
  const result = renderInlineMd('<script>alert(1)</script>')
  assert.ok(!result.includes('<script>'), 'HTML tags should be escaped')
  assert.ok(result.includes('&lt;script&gt;'), 'HTML should be entity-encoded')
})

test('renderInlineMd renders bold and italic', () => {
  const result = renderInlineMd('**bold** and *italic*')
  assert.match(result, /<strong class="sk-md-strong">bold<\/strong>/)
  assert.match(result, /<em class="sk-md-em">italic<\/em>/)
})

test('renderInlineMd renders inline code', () => {
  const result = renderInlineMd('use `const x = 1` here')
  assert.match(result, /<code class="sk-md-code">const x = 1<\/code>/)
})

test('renderInlineMd renders links with safe URLs', () => {
  const result = renderInlineMd('[example](https://example.com)')
  assert.match(result, /<a class="sk-md-a" href="https:\/\/example\.com">example<\/a>/)
})

test('renderInlineMd blocks javascript links', () => {
  const result = renderInlineMd('[click](javascript:alert(1))')
  assert.match(result, /href="#"/)
  assert.ok(!result.includes('javascript:'), 'javascript: URLs should be blocked')
})

test('renderMarkdown renders headings', () => {
  const result = renderMarkdown('# H1\n## H2\n### H3')
  assert.match(result, /<h1 class="sk-md-h1">H1<\/h1>/)
  assert.match(result, /<h2 class="sk-md-h2">H2<\/h2>/)
  assert.match(result, /<h3 class="sk-md-h3">H3<\/h3>/)
})

test('renderMarkdown renders paragraphs', () => {
  const result = renderMarkdown('Hello world')
  assert.match(result, /<p class="sk-md-p">Hello world<\/p>/)
})

test('renderMarkdown renders unordered lists', () => {
  const result = renderMarkdown('- item 1\n- item 2')
  assert.match(result, /<ul class="sk-md-ul">/)
  assert.match(result, /<li class="sk-md-li">item 1<\/li>/)
  assert.match(result, /<li class="sk-md-li">item 2<\/li>/)
})

test('renderMarkdown renders ordered lists', () => {
  const result = renderMarkdown('1. first\n2. second')
  assert.match(result, /<ol class="sk-md-ol">/)
  assert.match(result, /<li class="sk-md-li">first<\/li>/)
  assert.match(result, /<li class="sk-md-li">second<\/li>/)
})

test('renderMarkdown renders blockquotes', () => {
  const result = renderMarkdown('> quoted text')
  assert.match(result, /<blockquote class="sk-md-blockquote">quoted text<\/blockquote>/)
})

test('renderMarkdown renders code blocks', () => {
  const result = renderMarkdown('```js\nconst x = 1\n```')
  assert.match(result, /<pre class="sk-md-pre"><code class="sk-md-code">const x = 1<\/code><\/pre>/)
})

test('renderMarkdown handles empty input', () => {
  assert.equal(renderMarkdown(''), '')
  assert.equal(renderMarkdown(null), '')
  assert.equal(renderMarkdown(undefined), '')
})

test('renderMarkdown escapes HTML in all contexts', () => {
  const result = renderMarkdown('# <script>alert(1)</script>')
  assert.ok(!result.includes('<script>'), 'HTML in headings should be escaped')
  assert.ok(result.includes('&lt;script&gt;'), 'HTML should be entity-encoded')
})

test('renderMarkdown flushes unclosed code fences', () => {
  const result = renderMarkdown('```js\nconst x = 1')
  assert.match(result, /<pre class="sk-md-pre"><code class="sk-md-code">const x = 1<\/code><\/pre>/)
})


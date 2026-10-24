/**
 * docs/design.md -> docs/design.html
 *
 * Hand-rolled on purpose: the repo has no dependencies, and the document only uses
 * a small slice of markdown. HTML in the source is escaped rather than passed
 * through, so the page cannot drift into presentation markup.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(text) {
  const codes = []
  let out = escapeHtml(text)
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`)
  return out
}

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-')

export function render(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const html = []
  const toc = []
  let i = 0
  let listStack = [] // { indent, tag }

  const closeLists = (indent = -1) => {
    while (listStack.length && listStack[listStack.length - 1].indent > indent) {
      html.push(`</${listStack.pop().tag}>`)
    }
  }

  const isSpecial = (line) =>
    /^#{1,6}\s/.test(line) ||
    /^```/.test(line) ||
    /^\s*\|/.test(line) ||
    /^\s*([-*]|\d+\.)\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^---+\s*$/.test(line) ||
    line.trim() === ''

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      closeLists()
      i += 1
      continue
    }

    if (/^```/.test(line)) {
      closeLists()
      const lang = line.slice(3).trim()
      const body = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      i += 1
      html.push(
        `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`,
      )
      continue
    }

    if (/^---+\s*$/.test(line)) {
      closeLists()
      html.push('<hr>')
      i += 1
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      closeLists()
      const level = heading[1].length
      const text = heading[2].trim()
      const id = slug(text)
      if (level === 2) {
        // The headings carry their own section numbers; the TOC supplies numbering,
        // so strip the prefix there to avoid "1. 1. What this is".
        toc.push({ id, text: text.replace(/^\d+(\.\d+)?\.\s*/, '') })
      }
      html.push(`<h${level} id="${id}">${inline(text)}</h${level}>`)
      i += 1
      continue
    }

    const next = lines[i + 1] || ''
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|?\s*$/.test(next)) {
      closeLists()
      const cells = (row) =>
        row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
      const head = cells(line)
      i += 2
      const body = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        body.push(cells(lines[i]))
        i += 1
      }
      html.push('<div class="table-wrap"><table>')
      html.push(`<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`)
      html.push('<tbody>')
      for (const row of body) {
        html.push(`<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
      }
      html.push('</tbody></table></div>')
      continue
    }

    const item = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line)
    if (item) {
      const indent = item[1].length
      const tag = /\d/.test(item[2]) ? 'ol' : 'ul'
      closeLists(indent)
      const top = listStack[listStack.length - 1]
      if (!top || top.indent < indent) {
        listStack.push({ indent, tag })
        html.push(`<${tag}>`)
      }
      html.push(`<li>${inline(item[3])}</li>`)
      i += 1
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      closeLists()
      const body = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      html.push(`<blockquote><p>${inline(body.join(' '))}</p></blockquote>`)
      continue
    }

    closeLists()
    const para = []
    while (i < lines.length && !isSpecial(lines[i])) {
      para.push(lines[i].trim())
      i += 1
    }
    if (para.length) html.push(`<p>${inline(para.join(' '))}</p>`)
    else i += 1
  }
  closeLists()

  const nav = toc.length
    ? `<nav class="toc"><p class="toc-title">Contents</p><ol>${toc
        .map((t) => `<li><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`)
        .join('')}</ol></nav>`
    : ''

  return { body: html.join('\n'), toc, nav }
}

const PAGE = (title, nav, body) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; max-width: 62rem; padding: 3rem 1.5rem 6rem;
    font: 16px/1.65 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1c2024; background: #ffffff;
  }
  h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 1.5rem; letter-spacing: -0.01em; }
  h2 { font-size: 1.35rem; margin: 3rem 0 0.75rem; padding-top: 1.5rem; border-top: 1px solid #e6e8eb; letter-spacing: -0.01em; }
  h3 { font-size: 1.08rem; margin: 2rem 0 0.5rem; }
  h4 { font-size: 1rem; margin: 1.5rem 0 0.5rem; }
  p { margin: 0.85rem 0; }
  a { color: #0b62c4; }
  code { font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace; font-size: 0.88em; background: #f3f4f6; padding: 0.1em 0.35em; border-radius: 4px; }
  pre { background: #f7f8fa; border: 1px solid #e6e8eb; border-radius: 8px; padding: 1rem 1.1rem; overflow-x: auto; line-height: 1.5; }
  pre code { background: none; padding: 0; font-size: 0.85em; }
  .table-wrap { overflow-x: auto; margin: 1.25rem 0; }
  table { border-collapse: collapse; width: 100%; font-size: 0.94rem; }
  th, td { text-align: left; vertical-align: top; padding: 0.55rem 0.75rem; border-bottom: 1px solid #e6e8eb; }
  th { background: #f7f8fa; font-weight: 600; }
  tbody tr:last-child td { border-bottom: none; }
  blockquote { margin: 1.25rem 0; padding: 0.25rem 1rem; border-left: 3px solid #d3d7dc; color: #454c54; }
  hr { border: none; border-top: 1px solid #e6e8eb; margin: 2.5rem 0; }
  ul, ol { margin: 0.75rem 0; padding-left: 1.5rem; }
  li { margin: 0.3rem 0; }
  .toc { background: #f7f8fa; border: 1px solid #e6e8eb; border-radius: 8px; padding: 1rem 1.25rem; margin: 0 0 2.5rem; }
  .toc-title { margin: 0 0 0.5rem; font-weight: 600; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.06em; color: #5a626b; }
  .toc ol { margin: 0; padding-left: 1.25rem; }
  .toc li { margin: 0.2rem 0; }
  .toc a { text-decoration: none; }
  .toc a:hover { text-decoration: underline; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e8eb; background: #16181b; }
    h2 { border-top-color: #2a2e33; }
    a { color: #74b3ff; }
    code { background: #24282d; }
    pre { background: #1c1f23; border-color: #2a2e33; }
    th { background: #1c1f23; }
    th, td { border-bottom-color: #2a2e33; }
    blockquote { border-left-color: #3a4046; color: #b3b9c0; }
    hr { border-top-color: #2a2e33; }
    .toc { background: #1c1f23; border-color: #2a2e33; }
    .toc-title { color: #9aa1a9; }
  }
  @media print { body { max-width: none; padding: 0; } .toc { break-inside: avoid; } }
</style>
</head>
<body>
${nav}
${body}
</body>
</html>
`

export async function renderFile({ root = ROOT, source = 'docs/design.md', target = 'docs/design.html' } = {}) {
  const markdown = await readFile(join(root, source), 'utf8')
  const { body, nav, toc } = render(markdown)
  const title = (/^#\s+(.*)$/m.exec(markdown) || [, 'Design document'])[1]
  const html = PAGE(title, nav, body)
  await writeFile(join(root, target), html, 'utf8')
  return { target: join(root, target), bytes: Buffer.byteLength(html), sections: toc.length }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  const out = await renderFile()
  console.log(`rendered ${out.target} (${out.bytes} bytes, ${out.sections} sections)`)
}

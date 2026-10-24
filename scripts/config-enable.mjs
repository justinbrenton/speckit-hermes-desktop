/**
 * Add a plugin name to `plugins.enabled` in a Hermes `config.yaml`, touching
 * nothing else.
 *
 * A user dashboard plugin's Python is only imported when its name is in the
 * active profile's `plugins.enabled` (hermes_cli/web_server_dashboard.py:
 * `_plugin_api_mount_skip_reason`), so the installer must make that edit. It is
 * done textually — the file is hand-written YAML with comments and unknown keys
 * that a round-trip would destroy — and the caller verifies the result by
 * re-reading the file. Anything unexpected throws instead of guessing.
 */

const NAME_RE = /^[A-Za-z0-9._-]+$/

function unquote(value) {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

/**
 * @returns {{ text: string, changed: boolean, alreadyEnabled: boolean }}
 */
export function enablePlugin(text, name) {
  if (!NAME_RE.test(name || '')) {
    throw new Error(`invalid plugin name: ${JSON.stringify(name)}`)
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const join = () => lines.join(eol)

  const pluginsIndex = lines.findIndex(line => /^plugins:\s*(#.*)?$/.test(line))

  if (pluginsIndex === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') {
      lines.pop()
    }
    lines.push('', 'plugins:', '  enabled:', `    - ${name}`, '')
    return { text: join(), changed: true, alreadyEnabled: false }
  }

  let blockEnd = lines.length
  for (let i = pluginsIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() !== '' && !/^\s/.test(line)) {
      blockEnd = i
      break
    }
  }

  let enabledIndex = -1
  for (let i = pluginsIndex + 1; i < blockEnd; i += 1) {
    if (/^\s+enabled:\s*(#.*)?$/.test(lines[i]) || /^\s+enabled:\s*\[.*\]\s*$/.test(lines[i])) {
      enabledIndex = i
      break
    }
  }

  if (enabledIndex === -1) {
    lines.splice(pluginsIndex + 1, 0, '  enabled:', `    - ${name}`)
    return { text: join(), changed: true, alreadyEnabled: false }
  }

  const enabledLine = lines[enabledIndex]
  const keyIndent = /^(\s*)/.exec(enabledLine)[1]
  const itemIndent = `${keyIndent}  `
  const inline = /^\s*enabled:\s*\[(.*)\]\s*$/.exec(enabledLine)

  if (inline) {
    const items = inline[1]
      .split(',')
      .map(unquote)
      .filter(Boolean)
    if (items.includes(name)) {
      return { text, changed: false, alreadyEnabled: true }
    }
    const next = [...items, name]
    lines.splice(enabledIndex, 1, `${keyIndent}enabled:`, ...next.map(item => `${itemIndent}- ${item}`))
    return { text: join(), changed: true, alreadyEnabled: false }
  }

  // Block list: walk the items, remembering the last one.
  let lastItem = enabledIndex
  for (let i = enabledIndex + 1; i < blockEnd; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue
    }
    const item = /^(\s*)-\s*(.+?)\s*$/.exec(line)
    if (!item) {
      if (/^\s/.test(line)) {
        continue // a nested key of an item; leave it alone
      }
      break
    }
    if (unquote(item[2].replace(/\s+#.*$/, '')) === name) {
      return { text, changed: false, alreadyEnabled: true }
    }
    lastItem = i
  }

  lines.splice(lastItem + 1, 0, `${itemIndent}- ${name}`)
  return { text: join(), changed: true, alreadyEnabled: false }
}

/** Independent check of the edit — never trust the string surgery alone. */
export function isPluginEnabled(text, name) {
  const lines = text.split(/\r?\n/)
  const pluginsIndex = lines.findIndex(line => /^plugins:\s*(#.*)?$/.test(line))
  if (pluginsIndex === -1) {
    return false
  }
  let blockEnd = lines.length
  for (let i = pluginsIndex + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && !/^\s/.test(lines[i])) {
      blockEnd = i
      break
    }
  }
  for (let i = pluginsIndex + 1; i < blockEnd; i += 1) {
    const inline = /^\s*enabled:\s*\[(.*)\]\s*$/.exec(lines[i])
    if (inline) {
      return inline[1].split(',').map(unquote).includes(name)
    }
    if (!/^\s+enabled:\s*$/.test(lines[i]) && !/^\s+enabled:\s*#/.test(lines[i])) {
      continue
    }
    for (let j = i + 1; j < blockEnd; j += 1) {
      const item = /^\s*-\s*(.+?)\s*$/.exec(lines[j])
      if (item) {
        if (unquote(item[1].replace(/\s+#.*$/, '')) === name) {
          return true
        }
        continue
      }
      if (lines[j].trim() !== '' && !lines[j].trim().startsWith('#')) {
        break
      }
    }
    return false
  }
  return false
}

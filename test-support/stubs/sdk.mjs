/**
 * Minimal stand-ins for the `@hermes/plugin-sdk` surface the plugin touches, so
 * the built plugin.js can be imported and its registration inspected by a node
 * test. Rendering is not simulated beyond recording the element tree.
 */

const atom = value => ({ get: () => value, set: () => {}, subscribe: () => () => {} })

export const host = {
  state: {
    cwd: atom('C:/projects/demo'),
    activeSessionId: atom(null),
    focusedSessionId: atom(null)
  },
  notify: () => {},
  notifyError: () => {},
  revealPane: id => ({ revealed: id }),
  request: async () => ({}),
  logs: async () => ''
}

export const PANES_AREA = 'panes'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }

export const useValue = store => store.get()

export const cn = (...values) => values.filter(Boolean).join(' ')

const component = name => {
  const Stub = props => ({ type: name, props })
  Stub.displayName = name
  return Stub
}

export const Button = component('Button')
export const Badge = component('Badge')
export const Checkbox = component('Checkbox')
export const Input = component('Input')
export const Textarea = component('Textarea')
export const Separator = component('Separator')
export const ScrollArea = component('ScrollArea')
export const GlyphSpinner = component('GlyphSpinner')
export const ErrorState = component('ErrorState')
export const EmptyState = component('EmptyState')
export const Select = component('Select')
export const SelectTrigger = component('SelectTrigger')
export const SelectValue = component('SelectValue')
export const SelectContent = component('SelectContent')
export const SelectItem = component('SelectItem')
export const Codicon = component('Codicon')

export const icons = {
  Book: component('IconBook'),
  FileText: component('IconFileText'),
  FolderOpen: component('IconFolderOpen'),
  Trash2: component('IconTrash2'),
  checklist: component('IconChecklist'),
  folder: component('IconFolder'),
  book: component('IconBookLower'),
  trash: component('IconTrash')
}

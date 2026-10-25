/**
 * Spec-Kit Hermes — desktop half.
 *
 * A guided pane over spec-kit's own workflow engine. The pane holds no workflow
 * logic: `specify workflow run|resume` executes steps, and the pane renders the
 * run state, the artifact each step produced, and the gate that follows it.
 *
 * Flow: choose a process -> describe the work -> the engine runs a step -> the
 * artifact opens in an editor -> save or edit it -> approve -> next step.
 *
 * Build: `npm run build` inlines src/core.mjs at the CORE_INJECT marker and writes
 * desktop/plugin.js. The runtime evaluates a single ESM file, so this module may
 * only import @hermes/plugin-sdk, react and react/jsx-runtime.
 */
import {
  Badge,
  Button,
  GlyphSpinner,
  Input,
  ScrollArea,
  Textarea,
  host,
  icons,
  PANES_AREA,
  STATUSBAR_AREAS,
  useValue
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

/* CORE_INJECT */

const ID = 'spec-kit-hermes'
const PANE_ID = `${ID}:spec-kit`

let ctxRef = null

function __str(x) {
  if (x === null || x === undefined) return ''
  if (typeof x === 'object') return String(x.current || x.path || x.value || '').trim()
  return String(x).trim()
}

function rest(path, opts) {
  const call = ctxRef && ctxRef.rest
  if (!call) return Promise.reject(new Error('plugin backend unavailable'))
  return call(path, opts)
}

function errorText(err) {
  const raw = err && err.message ? err.message : String(err || 'request failed')
  if (/cwd must be absolute/.test(raw)) return 'That project path was not readable. Pick the folder again.'
  if (/Timed out/i.test(raw)) return 'Hermes did not answer in time. Check that the gateway is running.'
  if (/Failed to fetch|not answering/i.test(raw)) return 'The plugin backend is not answering. Restart Hermes Desktop.'
  return raw
}

function titleCase(id) {
  return __str(id).replace(/[-_]+/g, ' ').trim().replace(/^./, c => c.toUpperCase())
}

const GATE_LABELS = { approve: 'Approve', reject: 'Reject' }

/** The three entry points spec-kit documents, in its own words. */
const PROCESS_COPY = [
  {
    id: 'speckit',
    title: 'Spec-Driven Development',
    need: 'Build a feature or application',
    get: 'A specification carried through planning, implementation and convergence',
    banner: 'Ships in core'
  },
  {
    id: 'bugfix',
    title: 'Bug fixing',
    need: 'Diagnose and repair broken behavior',
    get: 'An assessed cause, a scoped fix, and recorded verification',
    banner: 'Extension'
  },
  {
    id: 'assess',
    title: 'Idea assessment',
    need: 'Decide whether an idea deserves investment',
    get: 'An evidence-backed go, clarify or stop decision',
    banner: 'Extension'
  }
]

function StepList({ steps, run }) {
  const nodes = (run && run.nodes) || []
  const currentIndex = run && run.status !== 'none' ? run.current_step_index : -1
  if (!steps || !steps.length) return null
  return jsx('ol', {
    className: 'flex flex-col gap-1',
    children: steps.map((step, index) => {
      const node = nodes[index] || {}
      const active = index === currentIndex
      const done = node.phase === 'done'
      const failed = node.phase === 'failed'
      const mark = failed ? '!' : done ? '✓' : active ? '•' : String(index + 1)
      const tone = failed ? 'text-red-400' : done ? 'text-emerald-400' : active ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary)'
      return jsxs('li', {
        className: 'flex items-center gap-2 text-[0.6875rem]',
        children: [
          jsx('span', { className: `w-4 text-center font-mono ${tone}`, children: mark }),
          jsx('span', {
            className: active ? 'text-(--ui-text-primary)' : 'text-(--ui-text-secondary)',
            children: titleCase(step.id)
          }),
          step.type === 'gate' ? jsx(Badge, { variant: 'secondary', children: 'review' }) : null
        ]
      }, step.id)
    })
  })
}

function ProcessChoice({ processes, onPick, onInstall, error, busy }) {
  const byId = {}
  for (const item of processes || []) byId[item.id] = item
  return jsxs('div', { className: 'flex h-full flex-col gap-3 p-3', children: [
    jsx('h2', { className: 'text-sm font-medium', children: 'Choose your process' }),
    jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: 'Each one is an installed spec-kit workflow. They are independent entry points, not phases.' }),
    error ? jsx('p', { className: 'text-[0.6875rem] text-red-400', children: error }) : null,
    jsx(ScrollArea, { className: 'min-h-0 flex-1', children:
      jsx('div', { className: 'flex flex-col gap-2', children: PROCESS_COPY.map(copy => {
        const installed = Boolean(byId[copy.id])
        return jsxs('div', {
          role: 'button',
          tabIndex: installed ? 0 : -1,
          onClick: () => { if (installed && !busy) onPick(byId[copy.id]) },
          className: installed
            ? 'flex flex-col gap-1 rounded border border-(--ui-border) p-2 text-left hover:border-(--ui-accent)'
            : 'flex flex-col gap-1 rounded border border-(--ui-border) p-2 text-left opacity-50',
          children: [
            jsxs('span', { className: 'flex items-center gap-2', children: [
              jsx('span', { className: 'text-[0.8125rem] font-medium', children: copy.title }),
              jsx(Badge, { variant: 'secondary', children: copy.banner })
            ] }),
            jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: copy.need }),
            jsx('span', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: copy.get }),
            installed
              ? null
              : jsxs('span', { className: 'flex items-center gap-2 text-[0.625rem] text-(--ui-text-tertiary)', children: [
                  'Not installed.',
                  jsx(Button, {
                    size: 'xs',
                    variant: 'outline',
                    onClick: event => { event.stopPropagation(); onInstall(copy.id) },
                    disabled: busy,
                    children: `Install ${copy.id} extension`
                  })
                ] })
          ]
        }, copy.id)
      }) })
    })
  ] })
}

function FolderRow({ draft, onDraft, onUse, onInit, hasSpecify, busy }) {
  return jsxs('div', { className: 'flex flex-col gap-2 rounded border border-(--ui-border) p-2', children: [
    jsx('span', { className: 'text-[0.625rem] font-medium text-(--ui-text-secondary)', children: 'Project folder' }),
    jsxs('div', { className: 'flex gap-2', children: [
      jsx(Input, { value: draft, onChange: event => onDraft(event.target.value), onKeyDown: event => { if (event.key === 'Enter') onUse() } }),
      jsx(Button, { size: 'sm', onClick: onUse, disabled: busy || !__str(draft), children: 'Use' })
    ] }),
    hasSpecify === false
      ? jsx(Button, { size: 'sm', variant: 'outline', onClick: onInit, disabled: busy, children: 'Initialise Spec Kit here' })
      : null
  ] })
}

function ArtifactEditor({ artifact, draft, onDraft, onSave, onClose, busy, dirty, error }) {
  if (!artifact) return null
  return jsxs('div', { className: 'flex min-h-0 flex-1 flex-col gap-1 rounded border border-(--ui-border)', children: [
    jsxs('div', { className: 'flex items-center justify-between gap-2 border-b border-(--ui-border) px-2 py-1', children: [
      jsx('span', { className: 'truncate font-mono text-[0.625rem]', children: artifact.path }),
      jsxs('div', { className: 'flex items-center gap-1', children: [
        dirty ? jsx(Badge, { variant: 'secondary', children: 'edited' }) : null,
        jsx(Button, { size: 'xs', onClick: onSave, disabled: busy || !dirty, children: 'Save' }),
        jsx(Button, { size: 'xs', variant: 'ghost', onClick: onClose, children: 'Close' })
      ] })
    ] }),
    error ? jsx('p', { className: 'px-2 text-[0.625rem] text-red-400', children: error }) : null,
    jsx(Textarea, {
      value: draft,
      onChange: event => onDraft(event.target.value),
      className: 'min-h-0 flex-1 resize-none font-mono text-[0.625rem]',
      rows: 14
    })
  ] })
}

function StartCard({ process, values, onChange, onStart, busy, error }) {
  const inputs = (process && process.inputs) || []
  const fields = inputs.length ? inputs : [{ name: 'spec', prompt: 'Describe what you want to build', required: true }]
  const ready = fields.filter(field => field.required).every(field => __str(values[field.name]))
  return jsxs('div', { className: 'flex flex-col gap-2', children: [
    ...fields.map(field => {
      const long = /slug/i.test(field.name) ? false : true
      const label = field.prompt || field.name
      return jsxs('div', { className: 'flex flex-col gap-1', children: [
        jsx('p', { className: 'text-[0.6875rem] font-medium', children: `${label}${field.required ? '' : ' (optional)'}` }),
        long
          ? jsx(Textarea, {
              value: values[field.name] || '',
              rows: 4,
              placeholder: field.name === 'report' ? 'What breaks, how to reproduce it, and what should happen instead' : 'Plain language. The first step turns this into the artifact.',
              onChange: event => onChange(field.name, event.target.value)
            })
          : jsx(Input, {
              value: values[field.name] || '',
              placeholder: 'short-name',
              onChange: event => onChange(field.name, event.target.value)
            })
      ] })
    }),
    error ? jsx('p', { className: 'text-[0.6875rem] text-red-400', children: error }) : null,
    jsx(Button, { size: 'sm', onClick: onStart, disabled: busy || !ready, children: busy ? 'Starting…' : 'Start' })
  ] })
}

function GateCard({ run, busy, onDecide, error }) {
  const gate = run.gate || {}
  const options = gate.options && gate.options.length ? gate.options : ['approve', 'reject']
  return jsxs('div', { className: 'flex flex-col gap-2 rounded border border-(--ui-accent) p-2', children: [
    jsx('p', { className: 'text-[0.6875rem] font-medium', children: gate.message || 'Review before continuing' }),
    jsx('p', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: 'Edit the file below if it needs work, then approve.' }),
    error ? jsx('p', { className: 'text-[0.6875rem] text-red-400', children: error }) : null,
    jsxs('div', { className: 'flex flex-wrap gap-2', children: options.map(option =>
      jsx(Button, {
        size: 'sm',
        variant: option === 'reject' ? 'outline' : 'default',
        disabled: busy,
        onClick: () => onDecide(option),
        children: GATE_LABELS[option] || titleCase(option)
      }, option)
    ) })
  ] })
}

function DoneCard({ run, onRestart }) {
  const failed = run.status === 'aborted' || run.status === 'failed' || Boolean(run.error)
  return jsxs('div', { className: 'flex flex-col gap-2 rounded border border-(--ui-border) p-2', children: [
    jsx('p', { className: 'text-[0.6875rem] font-medium', children: failed ? 'Workflow stopped' : 'Workflow complete' }),
    run.error ? jsx('p', { className: 'text-[0.625rem] text-red-400', children: __str(run.error) }) : null,
    jsx(Button, { size: 'sm', variant: 'outline', onClick: onRestart, children: 'Start another' })
  ] })
}

function SpecKitPane() {
  const workspaceCwd = useValue(host.state.cwd)
  const [folder, setFolder] = useState('')
  const [draftFolder, setDraftFolder] = useState('')
  const [hasSpecify, setHasSpecify] = useState(null)
  const [processes, setProcesses] = useState([])
  const [process, setProcess] = useState(null)
  const [run, setRun] = useState(null)
  const [values, setValues] = useState({})
  const [artifacts, setArtifacts] = useState([])
  const [open, setOpen] = useState(null)
  const [draft, setDraft] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editError, setEditError] = useState('')
  const pollRef = useRef(null)

  const loadFolder = useCallback(async target => {
    const path = __str(target)
    if (!path) return
    setBusy(true)
    setError('')
    try {
      const info = await rest(`/processes?cwd=${encodeURIComponent(path)}`)
      const list = (info && info.processes) || []
      setProcesses(list)
      setHasSpecify(Boolean(info && info.has_specify))
      setFolder(path)
      setDraftFolder(path)
      setProcess(null)
      setRun(null)
      setOpen(null)
      if (ctxRef && ctxRef.storage) ctxRef.storage.set('specKitProject', path)
    } catch (err) {
      setError(errorText(err))
      setHasSpecify(null)
    } finally {
      setBusy(false)
    }
  }, [])

  const refreshRun = useCallback(async (path, processId) => {
    if (!path || !processId) return
    try {
      const latest = await rest(`/workflows/${encodeURIComponent(processId)}/runs/latest?cwd=${encodeURIComponent(path)}`)
      setRun(latest)
      const listed = await rest(`/artifacts?cwd=${encodeURIComponent(path)}`)
      setArtifacts((listed && listed.artifacts) || [])
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    const stored = ctxRef && ctxRef.storage ? ctxRef.storage.get('specKitProject', '') : ''
    const initial = __str(stored) || __str(workspaceCwd)
    if (initial) {
      setDraftFolder(initial)
      loadFolder(initial)
    }
  }, [loadFolder])

  useEffect(() => {
    if (!folder || !process || !run || run.status !== 'running') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return undefined
    }
    pollRef.current = setInterval(() => refreshRun(folder, process.id), 2000)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [folder, process, run, refreshRun])

  const openArtifact = useCallback(async path => {
    setOpen(path)
    setEditError('')
    try {
      const file = await rest(`/artifact?cwd=${encodeURIComponent(folder)}&path=${encodeURIComponent(path)}`)
      setDraft(__str(file && file.content))
      setSavedContent(__str(file && file.content))
      setOpen({ path, mtime: file && file.mtime })
    } catch (err) {
      setEditError(errorText(err))
    }
  }, [folder])

  // A gate opens the artifact it is reviewing, so you edit before approving.
  useEffect(() => {
    if (!run || run.status !== 'paused' || !run.gate || open) return
    const stepId = __str(run.gate.step_id)
    const kind = stepId.replace(/^review-/, '').replace(/_/g, '-')
    const match =
      artifacts.find(item => item.name === `${kind}.md`) ||
      artifacts.find(item => item.name === kind) ||
      artifacts.find(item => item.path.toLowerCase().includes(kind.toLowerCase()))
    if (match) openArtifact(match.path)
  }, [run, artifacts, open, openArtifact])

  const saveArtifact = useCallback(async () => {
    if (!open) return
    setBusy(true)
    setEditError('')
    try {
      const result = await rest('/artifact', {
        method: 'PUT',
        body: { cwd: folder, path: open.path, content: draft, base_mtime: open.mtime }
      })
      setOpen({ path: open.path, mtime: result && result.mtime })
      setSavedContent(draft)
    } catch (err) {
      const raw = err && err.message ? err.message : String(err)
      if (/409/.test(raw)) {
        setEditError('The file changed on disk since you opened it. Reopen it to see the current text.')
      } else {
        setEditError(errorText(err))
      }
    } finally {
      setBusy(false)
    }
  }, [open, draft, folder])

  const installExtension = useCallback(async id => {
    setBusy(true)
    setError('')
    try {
      const result = await rest('/extensions/install', { method: 'POST', body: { cwd: folder, id } })
      if (result && result.ok === false) throw new Error(__str(result.output) || 'install failed')
      await loadFolder(folder)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [folder, loadFolder])

  const pickProcess = useCallback(async item => {
    setProcess(item)
    setError('')
    await refreshRun(folder, item.id)
  }, [folder, refreshRun])

  const start = useCallback(async () => {
    const spec = __str(values.spec || values.report || values.idea)
    if (!spec || !process || !folder) return
    setBusy(true)
    setError('')
    try {
      await rest(`/workflows/${encodeURIComponent(process.id)}/run`, {
        method: 'POST',
        body: { cwd: folder, inputs: values }
      })
      setRun({ status: 'running', run_id: null, gate: null, current_step_id: '' })
      setTimeout(() => refreshRun(folder, process.id), 900)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [values, process, folder, refreshRun])

  const decide = useCallback(async choice => {
    if (!run || !run.run_id || !run.gate || !process) return
    setBusy(true)
    setError('')
    try {
      await rest(`/workflows/${encodeURIComponent(process.id)}/runs/${encodeURIComponent(run.run_id)}/resume`, {
        method: 'POST',
        body: { cwd: folder, answers: { [run.gate.verdict_input]: choice } }
      })
      setOpen(null)
      setRun({ ...run, status: 'running', gate: null })
      setTimeout(() => refreshRun(folder, process.id), 900)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [run, process, folder, refreshRun])

  const initFolder = useCallback(async () => {
    const path = __str(draftFolder)
    if (!path) return
    setBusy(true)
    setError('')
    try {
      const result = await rest('/init', { method: 'POST', body: { cwd: path, integration: 'hermes' } })
      if (result && result.ok === false) throw new Error(__str(result.output) || 'specify init failed')
      await loadFolder(path)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [draftFolder, loadFolder])

  const restart = useCallback(() => {
    setRun(null)
    setValues({})
    setOpen(null)
    setError('')
  }, [])

  if (!folder || hasSpecify === false) {
    return jsxs('div', { className: 'flex h-full flex-col gap-3 p-3', children: [
      jsx('h2', { className: 'text-sm font-medium', children: 'Spec Kit' }),
      jsx(FolderRow, { draft: draftFolder, onDraft: setDraftFolder, onUse: () => loadFolder(draftFolder), onInit: initFolder, hasSpecify, busy }),
      error ? jsx('p', { className: 'text-[0.6875rem] text-red-400', children: error }) : null,
      hasSpecify === false
        ? jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: 'That folder has no .specify directory yet. Initialise it above.' })
        : null
    ] })
  }

  if (!process) {
    return jsxs('div', { className: 'flex h-full min-h-0 flex-col gap-2 p-3', children: [
      jsx(ProcessChoice, { processes, onPick: pickProcess, onInstall: installExtension, error, busy }),
      jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
        jsx('span', { className: 'truncate text-[0.625rem] text-(--ui-text-tertiary)', children: folder }),
        jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => setFolder(''), children: 'Change folder' })
      ] })
    ] })
  }

  const status = (run && run.status) || 'none'
  const dirty = draft !== savedContent

  return jsxs('div', { className: 'flex h-full min-h-0 flex-col gap-2 p-3', children: [
    jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
      jsx('div', { className: 'min-w-0', children: [
        jsx('p', { className: 'text-sm font-medium', children: process.name || titleCase(process.id) }),
        jsx('p', { className: 'truncate text-[0.625rem] text-(--ui-text-tertiary)', children: folder })
      ] }),
      jsxs('div', { className: 'flex shrink-0 items-center gap-1', children: [
        jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => { setFolder(''); setProcess(null); setRun(null) }, children: 'Change folder' }),
        jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => { setProcess(null); setRun(null) }, children: 'Change process' })
      ] })
    ] }),
    jsx(StepList, { steps: process.steps || [], run }),
    jsx('div', { className: 'h-px bg-(--ui-border)' }),
    status === 'none' || !run
      ? jsx(StartCard, { process, values, onChange: (name, value) => setValues(prev => ({ ...prev, [name]: value })), onStart: start, busy, error })
      : null,
    status === 'running'
      ? jsxs('div', { className: 'flex items-center gap-2', children: [
          jsx(GlyphSpinner, { size: 'sm' }),
          jsx('span', { className: 'text-[0.6875rem]', children: `Running: ${titleCase(run.current_step_id) || 'workflow'}` })
        ] })
      : null,
    status === 'paused' && run.gate ? jsx(GateCard, { run, busy, onDecide: decide, error }) : null,
    status === 'completed' || status === 'aborted' || status === 'failed'
      ? jsx(DoneCard, { run, onRestart: restart })
      : null,
    open
      ? jsx(ArtifactEditor, {
          artifact: open,
          draft,
          onDraft: setDraft,
          onSave: saveArtifact,
          onClose: () => { setOpen(null); setEditError('') },
          busy,
          dirty,
          error: editError
        })
      : jsx(ScrollArea, { className: 'min-h-0 flex-1', children:
          jsxs('div', { className: 'flex flex-col gap-1', children: [
            jsx('p', { className: 'text-[0.625rem] font-medium text-(--ui-text-secondary)', children: 'Artifacts' }),
            artifacts.length
              ? artifacts.map(item => jsxs('button', {
                  type: 'button',
                  onClick: () => openArtifact(item.path),
                  className: 'flex items-center justify-between gap-2 rounded border border-(--ui-border) px-2 py-1 text-left text-[0.6875rem] hover:bg-(--ui-bg-tertiary)',
                  children: [
                    jsx('span', { className: 'truncate', children: item.path.replace(/^specs\//, '') }),
                    jsx('span', { className: 'shrink-0 font-mono text-[0.625rem] text-(--ui-text-tertiary)', children: item.feature })
                  ]
                }, item.path))
              : jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: 'Nothing written yet.' })
          ] })
        })
  ] })
}

function renderPane() {
  return jsx(SpecKitPane, {})
}

function renderStatus() {
  return jsx(Button, {
    variant: 'ghost',
    size: 'xs',
    onClick: () => host.revealPane(PANE_ID),
    children: jsxs('span', { className: 'inline-flex items-center gap-1', children: [
      jsx(icons.Book, { className: 'size-3' }),
      'Spec Kit'
    ] })
  })
}

export default {
  id: ID,
  name: 'Spec Kit',
  description: 'Guided spec-kit processes: choose SDD, bug fixing or idea assessment',
  defaultEnabled: true,
  register(ctx) {
    ctxRef = ctx
    ctx.register({
      id: 'spec-kit',
      area: PANES_AREA,
      title: 'Spec Kit',
      data: { placement: 'right', width: '460px', collapsible: true },
      render: renderPane
    })
    ctx.register({ id: 'status', area: STATUSBAR_AREAS.right, order: 100, render: renderStatus })
  }
}

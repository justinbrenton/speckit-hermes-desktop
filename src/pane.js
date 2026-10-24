/**
 * Spec-Kit Hermes — desktop half.
 *
 * One pane, one guided flow. The pane runs no workflow logic: spec-kit's own
 * engine does (`specify workflow run|resume|status`), reached through the plugin
 * backend at /api/plugins/spec-kit-hermes.
 *
 * Flow: pick a folder -> describe the feature -> the engine runs each step and
 * parks at every gate -> you approve or reject -> artifacts stay readable.
 *
 * Build: `npm run build` inlines src/core.mjs at the CORE_INJECT marker and
 * writes desktop/plugin.js. The runtime evaluates a single ESM file, so this
 * module may only import @hermes/plugin-sdk, react and react/jsx-runtime.
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

/** Captured at register — `ctx.rest` is the only door to the backend. */
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
  if (/Not Found|NotFound|404/.test(raw)) return 'The plugin backend is older than this pane. Restart Hermes Desktop.'
  return raw
}

function titleCase(id) {
  return __str(id)
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/^./, c => c.toUpperCase())
}

const GATE_LABELS = { approve: 'Approve', reject: 'Reject' }

function StepList({ steps, run }) {
  const nodes = (run && run.nodes) || []
  const currentIndex = run && run.status !== 'none' ? run.current_step_index : -1
  if (!steps || !steps.length) return null
  return jsx('ol', {
    className: 'flex flex-col gap-1',
    children: steps.map((step, index) => {
      const node = nodes[index] || {}
      const done = node.phase === 'done'
      const active = index === currentIndex
      const failed = node.phase === 'failed'
      const mark = failed ? '!' : done ? '✓' : active ? '•' : String(index + 1)
      const tone = failed
        ? 'text-red-400'
        : done
          ? 'text-emerald-400'
          : active
            ? 'text-(--ui-accent)'
            : 'text-(--ui-text-tertiary)'
      return jsxs('li', {
        className: 'flex items-center gap-2 text-[0.6875rem]',
        children: [
          jsx('span', { className: `w-4 text-center font-mono ${tone}`, children: mark }),
          jsx('span', {
            className: active ? 'text-(--ui-text-primary)' : 'text-(--ui-text-secondary)',
            children: titleCase(step.id)
          }),
          step.type === 'gate' ? jsx(Badge, { variant: 'secondary', children: 'gate' }) : null
        ]
      }, step.id)
    })
  })
}

function ArtifactList({ artifacts, onOpen }) {
  if (!artifacts.length) {
    return jsx('p', {
      className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
      children: 'No artifacts yet. They appear as the workflow writes them.'
    })
  }
  return jsx('div', {
    className: 'flex flex-col gap-1',
    children: artifacts.map(item =>
      jsxs('button', {
        type: 'button',
        onClick: () => onOpen(item.path),
        className: 'flex items-center justify-between gap-2 rounded border border-(--ui-border) px-2 py-1 text-left text-[0.6875rem] hover:bg-(--ui-bg-tertiary)',
        children: [
          jsx('span', { className: 'truncate', children: item.name }),
          jsx('span', { className: 'shrink-0 font-mono text-[0.625rem] text-(--ui-text-tertiary)', children: item.feature })
        ]
      }, item.path)
    )
  })
}

function FolderGate({ draft, onDraft, onUse, onInit, hasSpecify, busy, error }) {
  return jsxs('div', { className: 'flex h-full flex-col gap-3 p-3', children: [
    jsx('h2', { className: 'text-sm font-medium', children: 'Spec Kit' }),
    jsx('p', {
      className: 'text-[0.6875rem] text-(--ui-text-secondary)',
      children: 'Point at the project folder. Spec Kit writes specs, plans and tasks into its .specify directory.'
    }),
    jsxs('div', { className: 'flex gap-2', children: [
      jsx(Input, {
        value: draft,
        placeholder: 'C:\\path\\to\\project',
        onChange: event => onDraft(event.target.value),
        onKeyDown: event => { if (event.key === 'Enter') onUse() }
      }),
      jsx(Button, { size: 'sm', onClick: onUse, disabled: busy || !__str(draft), children: 'Use' })
    ] }),
    hasSpecify === false
      ? jsxs('div', { className: 'flex flex-col gap-2 rounded border border-(--ui-border) p-2', children: [
          jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: 'This folder has no .specify directory yet.' }),
          jsx(Button, { size: 'sm', variant: 'outline', onClick: onInit, disabled: busy, children: 'Initialise Spec Kit here' })
        ] })
      : null,
    error ? jsx('p', { className: 'text-[0.6875rem] text-red-400', children: error }) : null
  ] })
}

function StartCard({ process, folder, value, onChange, onStart, busy, error }) {
  const inputs = (process && process.inputs) || []
  return jsxs('div', { className: 'flex flex-col gap-3', children: [
    jsxs('div', { children: [
      jsx('p', { className: 'text-[0.6875rem] font-medium', children: 'Describe what you want to build' }),
      jsx('p', {
        className: 'mt-1 text-[0.6875rem] text-(--ui-text-secondary)',
        children: 'Plain language. The first step turns this into a spec, and you review it before planning.'
      })
    ] }),
    jsx(Textarea, {
      value,
      rows: 5,
      placeholder: 'A todo web app where I can add, complete and delete tasks…',
      onChange: event => onChange(event.target.value)
    }),
    inputs.length
      ? jsx('div', { className: 'flex flex-wrap gap-1', children: inputs.map(input =>
          jsx(Badge, { variant: 'secondary', children: `${input.name}${input.required ? '' : ' (optional)'}` }, input.name)
        ) })
      : null,
    jsx(Button, { size: 'sm', onClick: onStart, disabled: busy || !__str(value), children: busy ? 'Starting…' : 'Start' }),
    error ? jsx('p', { className: 'text-[0.6875rem] text-red-400', children: error }) : null,
    jsx('p', { className: 'truncate text-[0.625rem] text-(--ui-text-tertiary)', children: folder })
  ] })
}

function RunningCard({ run }) {
  return jsxs('div', { className: 'flex flex-col gap-2', children: [
    jsxs('div', { className: 'flex items-center gap-2', children: [
      jsx(GlyphSpinner, { size: 'sm' }),
      jsx('span', { className: 'text-[0.6875rem]', children: `Running: ${titleCase(run.current_step_id) || 'workflow'}` })
    ] }),
    jsx('p', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: 'This step calls your agent. It can take a few minutes.' })
  ] })
}

function GateCard({ run, busy, onDecide, error }) {
  const gate = run.gate || {}
  const options = gate.options && gate.options.length ? gate.options : ['approve', 'reject']
  return jsxs('div', { className: 'flex flex-col gap-2 rounded border border-(--ui-accent) p-2', children: [
    jsx('p', { className: 'text-[0.6875rem] font-medium', children: gate.message || 'Review before continuing' }),
    jsx('p', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: `Step: ${titleCase(gate.step_id || run.current_step_id)}` }),
    jsxs('div', { className: 'flex flex-wrap gap-2', children: options.map(option =>
      jsx(Button, {
        size: 'sm',
        variant: option === 'reject' ? 'outline' : 'default',
        disabled: busy,
        onClick: () => onDecide(option),
        children: GATE_LABELS[option] || titleCase(option)
      }, option)
    ) }),
    error ? jsx('p', { className: 'text-[0.6875rem] text-red-400', children: error }) : null
  ] })
}

function DoneCard({ run, onRestart }) {
  const failed = run.status === 'aborted' || run.status === 'failed' || Boolean(run.error)
  return jsxs('div', { className: 'flex flex-col gap-2 rounded border border-(--ui-border) p-2', children: [
    jsx('p', { className: 'text-[0.6875rem] font-medium', children: failed ? 'Workflow stopped' : 'Workflow complete' }),
    run.error ? jsx('p', { className: 'text-[0.625rem] text-red-400', children: __str(run.error) }) : null,
    jsx(Button, { size: 'sm', variant: 'outline', onClick: onRestart, children: 'Start another feature' })
  ] })
}

function ArtifactViewer({ path, content, busy, onClose }) {
  return jsxs('div', { className: 'flex min-h-0 flex-1 flex-col gap-1 rounded border border-(--ui-border)', children: [
    jsxs('div', { className: 'flex items-center justify-between gap-2 border-b border-(--ui-border) px-2 py-1', children: [
      jsx('span', { className: 'truncate font-mono text-[0.625rem]', children: path }),
      jsx(Button, { size: 'xs', variant: 'ghost', onClick: onClose, children: 'Close' })
    ] }),
    busy
      ? jsx('div', { className: 'p-2', children: jsx(GlyphSpinner, { size: 'sm' }) })
      : jsx(ScrollArea, { className: 'min-h-0 flex-1', children:
          jsx('pre', { className: 'whitespace-pre-wrap p-2 text-[0.625rem] leading-relaxed', children: content || '(empty)' })
        })
  ] })
}

function SpecKitPane() {
  const workspaceCwd = useValue(host.state.cwd)
  const [folder, setFolder] = useState('')
  const [draftFolder, setDraftFolder] = useState('')
  const [hasSpecify, setHasSpecify] = useState(null)
  const [process, setProcess] = useState(null)
  const [run, setRun] = useState(null)
  const [description, setDescription] = useState('')
  const [artifacts, setArtifacts] = useState([])
  const [openArtifact, setOpenArtifact] = useState(null)
  const [openContent, setOpenContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pollRef = useRef(null)

  const refreshRun = useCallback(async target => {
    const path = __str(target)
    if (!path) return
    try {
      const latest = await rest(`/workflows/speckit/runs/latest?cwd=${encodeURIComponent(path)}`)
      setRun(latest)
      if (latest && latest.status && latest.status !== 'none') {
        const listed = await rest(`/artifacts?cwd=${encodeURIComponent(path)}`)
        setArtifacts((listed && listed.artifacts) || [])
      }
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  const loadFolder = useCallback(async target => {
    const path = __str(target)
    if (!path) return
    setBusy(true)
    setError('')
    try {
      const info = await rest(`/processes?cwd=${encodeURIComponent(path)}`)
      const list = (info && info.processes) || []
      setHasSpecify(Boolean(info && info.has_specify))
      setProcess(list.length ? list[0] : null)
      setFolder(path)
      setDraftFolder(path)
      setRun(null)
      if (ctxRef && ctxRef.storage) ctxRef.storage.set('specKitProject', path)
      if (info && info.has_specify) await refreshRun(path)
    } catch (err) {
      setError(errorText(err))
      setHasSpecify(null)
    } finally {
      setBusy(false)
    }
  }, [refreshRun])

  useEffect(() => {
    const stored = ctxRef && ctxRef.storage ? ctxRef.storage.get('specKitProject', '') : ''
    const initial = __str(stored) || __str(workspaceCwd)
    if (initial) {
      setDraftFolder(initial)
      loadFolder(initial)
    }
  }, [loadFolder])

  // Poll while the engine is working. A parked gate needs no polling.
  useEffect(() => {
    if (!folder || !run || run.status !== 'running') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return undefined
    }
    pollRef.current = setInterval(() => { refreshRun(folder) }, 2000)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [folder, run, refreshRun])

  const useFolder = useCallback(() => { loadFolder(draftFolder) }, [draftFolder, loadFolder])

  const initFolder = useCallback(async () => {
    const path = __str(draftFolder) || folder
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
  }, [draftFolder, folder, loadFolder])

  const start = useCallback(async () => {
    const spec = __str(description)
    if (!spec || !process || !folder) return
    setBusy(true)
    setError('')
    try {
      await rest(`/workflows/${encodeURIComponent(process.id)}/run`, {
        method: 'POST',
        body: { cwd: folder, inputs: { spec } }
      })
      setRun({ status: 'running', run_id: null, gate: null, current_step_id: '' })
      setTimeout(() => { refreshRun(folder) }, 800)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [description, process, folder, refreshRun])

  const decide = useCallback(async choice => {
    if (!run || !run.run_id || !run.gate) return
    setBusy(true)
    setError('')
    try {
      await rest(`/workflows/${encodeURIComponent(process.id)}/runs/${encodeURIComponent(run.run_id)}/resume`, {
        method: 'POST',
        body: { cwd: folder, answers: { [run.gate.verdict_input]: choice } }
      })
      setRun({ ...run, status: 'running', gate: null })
      setTimeout(() => { refreshRun(folder) }, 800)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [run, process, folder, refreshRun])

  const open = useCallback(async path => {
    setOpenArtifact(path)
    setOpenContent('')
    try {
      const file = await rest(`/artifact?cwd=${encodeURIComponent(folder)}&path=${encodeURIComponent(path)}`)
      setOpenContent(__str(file && file.content))
    } catch (err) {
      setOpenContent(errorText(err))
    }
  }, [folder])

  const restart = useCallback(() => {
    setRun(null)
    setDescription('')
    setError('')
  }, [])

  if (!folder) {
    return jsx(FolderGate, {
      draft: draftFolder,
      onDraft: setDraftFolder,
      onUse: useFolder,
      onInit: initFolder,
      hasSpecify,
      busy,
      error
    })
  }

  const status = (run && run.status) || 'none'
  const showStart = status === 'none' || !run
  const showRunning = status === 'running'
  const showGate = status === 'paused' && Boolean(run && run.gate)
  const showDone = status === 'completed' || status === 'aborted' || status === 'failed'

  return jsxs('div', { className: 'flex h-full min-h-0 flex-col gap-2 p-3', children: [
    jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
      jsx('div', { className: 'min-w-0', children: [
        jsx('p', { className: 'text-sm font-medium', children: 'Spec Kit' }),
        jsx('p', { className: 'truncate text-[0.625rem] text-(--ui-text-tertiary)', children: folder })
      ] }),
      jsx(Button, {
        size: 'xs',
        variant: 'ghost',
        onClick: () => { setFolder(''); setProcess(null); setRun(null); setError('') },
        children: 'Change'
      })
    ] }),
    jsx(StepList, { steps: (process && process.steps) || [], run }),
    jsx('div', { className: 'h-px bg-(--ui-border)' }),
    showStart ? jsx(StartCard, { process, folder, value: description, onChange: setDescription, onStart: start, busy, error }) : null,
    showRunning ? jsx(RunningCard, { run }) : null,
    showGate ? jsx(GateCard, { run, busy, onDecide: decide, error }) : null,
    showDone ? jsx(DoneCard, { run, onRestart: restart }) : null,
    jsxs('div', { className: 'flex min-h-0 flex-1 flex-col gap-1', children: [
      jsx('p', { className: 'text-[0.625rem] font-medium text-(--ui-text-secondary)', children: 'Artifacts' }),
      openArtifact
        ? jsx(ArtifactViewer, { path: openArtifact, content: openContent, busy, onClose: () => setOpenArtifact(null) })
        : jsx(ScrollArea, { className: 'min-h-0 flex-1', children: jsx(ArtifactList, { artifacts, onOpen: open }) })
    ] })
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
  description: 'Guided spec-kit workflow: describe, review at each gate, implement',
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

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

// ---- inlined from src/core.mjs — build artifact, edit the source instead ----
/**
 * Pure model for the Spec-Kit pane.
 *
 * Everything here is a decision the pane has to make about a workflow it did not
 * author: which inputs to ask a person for, where a run is, and which file a gate
 * is reviewing. Keeping them out of the components is what makes them testable —
 * both defects reported in the wizard came from this layer.
 *
 * This file is inlined into desktop/plugin.js by scripts/build.mjs, so it must
 * stay dependency-free (no imports) and side-effect-free.
 */

/** Human titles for spec-kit steps; falls back to the id when unknown. */
const STEP_TITLES = Object.freeze({
  constitution: 'Set the ground rules',
  specify: 'Describe what to build',
  clarify: 'Resolve ambiguity',
  plan: 'Choose the tech stack',
  checklist: 'Validate the spec',
  tasks: 'Break the work down',
  analyze: 'Check consistency',
  implement: 'Build it',
  converge: 'Verify completeness',
  assess: 'Assess the bug',
  fix: 'Fix the assessed cause',
  test: 'Test the fix',
  intake: 'Capture the idea',
  research: 'Research the evidence',
  define: 'Define the problem',
  shape: 'Shape the options',
  decide: 'Make the decision'
})

/**
 * Inputs worth asking a person about.
 *
 * `gate_*` carry gate verdicts to the engine and `integration` is project setup;
 * rendering them as questions was a visible defect.
 */
function visibleInputs(inputs = []) {
  return (inputs || []).filter(
    input => input && input.name && !/^gate_/.test(input.name) && input.name !== 'integration'
  )
}

/** Steps a person progresses through: gates are checkpoints, not work items. */
function flowSteps(steps = []) {
  return (steps || []).filter(step => step && step.type !== 'gate')
}

/**
 * Where the run is, in the flow, for the progress header.
 *
 * Gates sit directly after the step they review, so a gate's position is the last
 * command step before it. Matching gate ids by name is wrong in practice:
 * `specify`'s gate is `review-spec`, not `review-specify`.
 */
function progressFor(steps = [], run = null) {
  const list = steps || []
  const flow = flowSteps(list)
  if (!flow.length) return { index: 0, total: 0, title: '', id: '', percent: 0 }

  const currentId = run && run.current_step_id ? String(run.current_step_id) : ''
  let lastCommand = 0
  let position = 0
  for (const step of list) {
    if (step.type === 'gate') {
      if (step.id === currentId) position = lastCommand
      continue
    }
    const index = flow.findIndex(item => item.id === step.id)
    if (index >= 0) lastCommand = index
    if (step.id === currentId && index >= 0) position = index
  }

  const done = run && run.status === 'completed'
  const index = done ? flow.length : position + 1
  const id = (flow[position] || {}).id || ''
  return {
    index,
    total: flow.length,
    id,
    title: STEP_TITLES[id] || id,
    percent: Math.round((index / flow.length) * 100)
  }
}

/**
 * The artifact a gate is reviewing.
 *
 * Gate ids are `review-<step>`; artifacts are named after the step (`spec.md`,
 * `plan.md`, `assessment.md`). Falls back to a path containing the step name, then
 * to nothing rather than guessing wrong.
 */
function artifactForGate(artifacts = [], gateStepId = '') {
  const kind = String(gateStepId || '').replace(/^review-/, '').replace(/_/g, '-')
  if (!kind) return null
  const list = artifacts || []
  // Gates whose artifact is not named after the step. The assessment gate says
  // "verdict" and writes decision.md.
  const named = { verdict: 'decision.md' }[kind]
  return (
    (named && list.find(item => item && item.name === named)) ||
    list.find(item => item && item.name === `${kind}.md`) ||
    list.find(item => item && item.name === kind) ||
    list.find(item => item && String(item.path || '').toLowerCase().includes(kind.toLowerCase())) ||
    null
  )
}
// ---- end inlined core ----

const ID = 'spec-kit-hermes'
const PANE_ID = `${ID}:spec-kit`

let ctxRef = null

function __str(x) {
  if (x === null || x === undefined) return ''
  if (typeof x === 'object') return String(x.current || x.path || x.value || '').trim()
  return String(x).trim()
}

/** Own stylesheet: the app ships a prebuilt CSS bundle, so Tailwind arbitrary
 *  values (`sk-small`, `bg-(--ui-x)`) only exist when the app's own
 *  sources used them. These classes bind to the app's theme variables instead,
 *  so the pane follows whatever theme is set in Settings. */
const SK_CSS = `
.sk-root { color: var(--ui-text-primary, var(--foreground)); font-size: 12px; }
.sk-ink { color: var(--ui-text-primary, var(--foreground)); }
.sk-dim { color: var(--ui-text-secondary, var(--muted-foreground)); }
.sk-faint { color: var(--ui-text-tertiary, var(--muted-foreground)); opacity: .85; }
.sk-err { color: var(--ui-danger, #e5484d); }
.sk-ok { color: var(--ui-success, #30a46c); }
.sk-body { font-size: 13px; }
.sk-small { font-size: 11px; }
.sk-tiny { font-size: 10px; }
.sk-medium { font-weight: 500; }
.sk-mono { font-family: var(--ui-sk-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.sk-panel { background: var(--ui-bg-tertiary, var(--card)); }
.sk-card { background: var(--ui-bg-card, var(--card)); }
.sk-border { border-color: var(--ui-border, var(--border)); }
.sk-border-b { border-bottom: 1px solid var(--ui-border, var(--border)); }
.sk-border-t { border-top: 1px solid var(--ui-border, var(--border)); }
.sk-accent { border-color: var(--ui-accent, var(--primary)); }
.sk-accent-bg { background: var(--ui-accent, var(--primary)); }
.sk-hr { height: 1px; background: var(--ui-border, var(--border)); }
.sk-sk-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sk-bar { height: 4px; border-radius: 999px; overflow: hidden; background: var(--ui-bg-tertiary, var(--card)); }
.sk-bar-fill { height: 100%; border-radius: 999px; background: var(--ui-accent, var(--primary)); transition: width .2s ease; }
.sk-hover:hover { background: var(--ui-bg-tertiary, var(--card)); }
.sk-click { cursor: pointer; }
.sk-fade { opacity: .55; }
`

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById('spec-kit-styles')) return
  const style = document.createElement('style')
  style.id = 'spec-kit-styles'
  style.textContent = SK_CSS
  document.head.appendChild(style)
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

/** A 409 from /artifact carries the winning copy; surface it, don't just report it. */
function conflictOf(err) {
  const raw = err && err.message ? err.message : String(err || '')
  const start = raw.indexOf('{')
  if (start < 0) return null
  try {
    const parsed = JSON.parse(raw.slice(start))
    const detail = parsed && parsed.detail ? parsed.detail : parsed
    if (detail && detail.conflict) return detail
  } catch (err2) {
    return null
  }
  return null
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

function IntegrationBanner({ ok, busy, onRepair }) {
  if (ok !== false) return null
  return jsxs('div', { className: 'sk-panel flex flex-col gap-1 rounded border p-2 sk-border', children: [
    jsx('p', { className: 'sk-small sk-medium sk-err', children: 'Dispatched steps are not told which project they are in' }),
    jsx('p', { className: 'sk-tiny sk-dim', children: 'spec-kit was reinstalled and the working-directory fix is gone, so generated files land beside your workspace instead of in the project.' }),
    jsx(Button, { size: 'xs', variant: 'outline', onClick: onRepair, disabled: busy, children: 'Re-apply fix' })
  ] })
}

function ProgressHeader({ steps, run }) {
  const progress = progressFor(steps, run)
  if (!progress.total) return null
  return jsxs('div', { className: 'flex flex-col gap-1', children: [
    jsxs('div', { className: 'flex items-baseline justify-between gap-2', children: [
      jsx('p', { className: 'sk-body sk-medium', children: progress.title }),
      jsx('span', { className: 'shrink-0 sk-tiny sk-faint', children: `${progress.index} of ${progress.total}` })
    ] }),
    jsx('div', { className: 'sk-bar w-full', children:
      jsx('div', { className: 'sk-bar-fill', style: { width: `${progress.percent}%` } })
    })
  ] })
}

function ProcessChoice({ processes, onPick, onInstall, error, busy }) {
  const byId = {}
  for (const item of processes || []) byId[item.id] = item
  return jsxs('div', { className: 'sk-root flex h-full flex-col gap-3 p-3', children: [
    jsx('h2', { className: 'sk-body sk-medium', children: 'Choose your process' }),
    jsx('p', { className: 'sk-small sk-dim', children: 'Each one is an installed spec-kit workflow. They are independent entry points, not phases.' }),
    error ? jsx('p', { className: 'sk-small sk-err', children: error }) : null,
    jsx(ScrollArea, { className: 'min-h-0 flex-1', children:
      jsx('div', { className: 'flex flex-col gap-2', children: PROCESS_COPY.map(copy => {
        const installed = Boolean(byId[copy.id])
        return jsxs('div', {
          role: 'button',
          tabIndex: installed ? 0 : -1,
          onClick: () => { if (installed && !busy) onPick(byId[copy.id]) },
          className: installed
            ? 'flex flex-col gap-1 rounded border sk-border p-2 text-left hover:sk-accent'
            : 'flex flex-col gap-1 rounded border sk-border p-2 text-left opacity-50',
          children: [
            jsxs('span', { className: 'flex items-center gap-2', children: [
              jsx('span', { className: 'sk-body sk-medium', children: copy.title }),
              jsx(Badge, { variant: 'secondary', children: copy.banner })
            ] }),
            jsx('span', { className: 'sk-small sk-dim', children: copy.need }),
            jsx('span', { className: 'sk-tiny sk-faint', children: copy.get }),
            installed
              ? null
              : jsxs('span', { className: 'flex items-center gap-2 sk-tiny sk-faint', children: [
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

function Browser({ data, busy, onOpen, onUp, onUse, onClose }) {
  return jsxs('div', { className: 'flex min-h-0 flex-col gap-1 rounded border sk-border', children: [
    jsxs('div', { className: 'flex items-center justify-between gap-2 border-b sk-border px-2 py-1', children: [
      jsx('span', { className: 'sk-truncate sk-mono sk-tiny', children: data.path || 'This PC' }),
      jsx(Button, { size: 'xs', variant: 'ghost', onClick: onClose, children: 'Close' })
    ] }),
    jsx(ScrollArea, { className: 'max-h-56 min-h-0', children:
      jsxs('div', { className: 'flex flex-col gap-0.5 p-1', children: [
        data.parent
          ? jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => onOpen(data.parent), disabled: busy, children: '.. up' })
          : null,
        ...((data.entries || []).map(entry => jsxs('button', {
          type: 'button',
          onClick: () => onOpen(entry.path),
          className: 'flex items-center justify-between gap-2 rounded px-2 py-1 text-left sk-small hover:sk-panel',
          children: [
            jsx('span', { className: 'sk-truncate', children: entry.name }),
            entry.has_specify ? jsx(Badge, { variant: 'secondary', children: 'spec-kit' }) : null
          ]
        }, entry.path)))
      ] })
    }),
    jsxs('div', { className: 'flex items-center justify-between gap-2 border-t sk-border px-2 py-1', children: [
      jsx('span', { className: 'sk-tiny sk-faint', children: 'Open a folder to look inside it.' }),
      jsx(Button, { size: 'xs', onClick: onUse, disabled: busy || !data.path, children: 'Use this folder' })
    ] })
  ] })
}

function FolderRow({ draft, onDraft, onUse, onInit, hasSpecify, busy, onBrowse }) {
  return jsxs('div', { className: 'flex flex-col gap-2 rounded border sk-border p-2', children: [
    jsx('span', { className: 'sk-tiny sk-medium sk-dim', children: 'Project folder' }),
    jsxs('div', { className: 'flex gap-2', children: [
      jsx(Input, { value: draft, onChange: event => onDraft(event.target.value), onKeyDown: event => { if (event.key === 'Enter') onUse() } }),
      jsx(Button, { size: 'sm', variant: 'outline', onClick: onBrowse, disabled: busy, children: 'Browse…' }),
      jsx(Button, { size: 'sm', onClick: onUse, disabled: busy || !__str(draft), children: 'Use' })
    ] }),
    hasSpecify === false
      ? jsx(Button, { size: 'sm', variant: 'outline', onClick: onInit, disabled: busy, children: 'Initialise Spec Kit here' })
      : null
  ] })
}

function QuestionsPanel({ questions, answers, onChange, onApply, busy, error }) {
  if (!questions.length) return null
  return jsxs('div', { className: 'flex flex-col gap-2 rounded border sk-accent p-2', children: [
    jsxs('p', { className: 'sk-small sk-medium', children: [
      questions.length === 1 ? '1 open question' : `${questions.length} open questions`
    ] }),
    jsx('p', { className: 'sk-tiny sk-faint', children: 'These are the [NEEDS CLARIFICATION] markers in this file. Answers are written back in place.' }),
    ...questions.map(question => jsxs('div', { className: 'flex flex-col gap-1', children: [
      jsx('span', { className: 'sk-tiny sk-dim', children: question.text }),
      jsx(Input, {
        value: answers[String(question.index)] || '',
        placeholder: 'Your answer',
        onChange: event => onChange(String(question.index), event.target.value)
      })
    ] }, question.index)),
    error ? jsx('p', { className: 'sk-tiny sk-err', children: error }) : null,
    jsx(Button, { size: 'sm', onClick: onApply, disabled: busy, children: busy ? 'Writing…' : 'Apply answers' })
  ] })
}

function ConflictPanel({ conflict, busy, onReload, onKeep }) {
  if (!conflict) return null
  return jsxs('div', { className: 'sk-panel flex flex-col gap-1 rounded border p-2 sk-border', children: [
    jsx('p', { className: 'sk-small sk-medium', children: 'This file changed on disk' }),
    jsx('p', { className: 'sk-tiny sk-dim', children: conflict.reason || 'Someone else saved it after you opened it.' }),
    jsxs('div', { className: 'flex gap-2', children: [
      jsx(Button, { size: 'xs', variant: 'outline', onClick: onReload, disabled: busy, children: 'Load the disk version' }),
      jsx(Button, { size: 'xs', onClick: onKeep, disabled: busy, children: 'Keep mine' })
    ] })
  ] })
}

function ArtifactEditor({ artifact, draft, onDraft, onSave, onClose, busy, dirty, error }) {
  if (!artifact) return null
  return jsxs('div', { className: 'flex min-h-0 flex-1 flex-col gap-1 rounded border sk-border', children: [
    jsxs('div', { className: 'flex items-center justify-between gap-2 border-b sk-border px-2 py-1', children: [
      jsx('span', { className: 'sk-truncate sk-mono sk-tiny', children: artifact.path }),
      jsxs('div', { className: 'flex items-center gap-1', children: [
        dirty ? jsx(Badge, { variant: 'secondary', children: 'edited' }) : null,
        jsx(Button, { size: 'xs', onClick: onSave, disabled: busy || !dirty, children: 'Save' }),
        jsx(Button, { size: 'xs', variant: 'ghost', onClick: onClose, children: 'Close' })
      ] })
    ] }),
    error ? jsx('p', { className: 'px-2 sk-tiny sk-err', children: error }) : null,
    jsx(Textarea, {
      value: draft,
      onChange: event => onDraft(event.target.value),
      className: 'min-h-0 flex-1 resize-none sk-mono sk-tiny',
      rows: 14
    })
  ] })
}

const PATHS = [
  {
    id: 'short',
    title: 'Shorter path',
    for: 'Smaller features',
    steps: ['constitution', 'specify', 'plan', 'tasks', 'implement', 'converge']
  },
  {
    id: 'full',
    title: 'Full path',
    for: 'Production features, with quality gates',
    steps: ['constitution', 'specify', 'clarify', 'plan', 'checklist', 'tasks', 'analyze', 'implement', 'converge']
  }
]

function PathChoice({ onPick, busy }) {
  return jsxs('div', { className: 'flex flex-col gap-2', children: [
    jsx('p', { className: 'sk-small sk-medium', children: 'Which approach?' }),
    jsx('p', { className: 'sk-tiny sk-dim', children: 'Both run the same process. The full path adds clarify, checklist and analyze as review gates.' }),
    ...PATHS.map(path => jsxs('div', {
      role: 'button',
      tabIndex: 0,
      onClick: () => { if (!busy) onPick(path.id) },
      className: 'flex cursor-pointer flex-col gap-1 rounded border sk-border p-2 hover:sk-accent',
      children: [
        jsxs('span', { className: 'flex items-center gap-2', children: [
          jsx('span', { className: 'sk-body sk-medium', children: path.title }),
          jsx(Badge, { variant: 'secondary', children: path.id })
        ] }),
        jsx('span', { className: 'sk-small sk-faint', children: path.for }),
        jsx('span', { className: 'sk-tiny sk-faint', children: path.steps.join(' → ') })
      ]
    }, path.id))
  ] })
}

function StartCard({ process, values, onChange, onStart, busy, error }) {
  const inputs = visibleInputs((process && process.inputs) || [])
  const fields = inputs.length ? inputs : [{ name: 'spec', prompt: 'Describe what you want to build', required: true }]
  const ready = fields.filter(field => field.required).every(field => __str(values[field.name]))
  return jsxs('div', { className: 'flex flex-col gap-2', children: [
    ...fields.map(field => {
      const long = /slug/i.test(field.name) ? false : true
      const label = field.prompt || field.name
      return jsxs('div', { className: 'flex flex-col gap-1', children: [
        jsx('p', { className: 'sk-small sk-medium', children: `${label}${field.required ? '' : ' (optional)'}` }),
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
    error ? jsx('p', { className: 'sk-small sk-err', children: error }) : null,
    jsx(Button, { size: 'sm', onClick: onStart, disabled: busy || !ready, children: busy ? 'Starting…' : 'Start' })
  ] })
}

function GateCard({ run, busy, onDecide, error }) {
  const gate = run.gate || {}
  const options = gate.options && gate.options.length ? gate.options : ['approve', 'reject']
  return jsxs('div', { className: 'flex flex-col gap-2 rounded border sk-accent p-2', children: [
    jsx('p', { className: 'sk-small sk-medium', children: gate.message || 'Review before continuing' }),
    jsx('p', { className: 'sk-tiny sk-faint', children: 'Edit the file below if it needs work, then approve.' }),
    error ? jsx('p', { className: 'sk-small sk-err', children: error }) : null,
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
  return jsxs('div', { className: 'flex flex-col gap-2 rounded border sk-border p-2', children: [
    jsx('p', { className: 'sk-small sk-medium', children: failed ? 'Workflow stopped' : 'Workflow complete' }),
    run.error ? jsx('p', { className: 'sk-tiny sk-err', children: __str(run.error) }) : null,
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
  const [browseData, setBrowseData] = useState(null)
  const [mode, setMode] = useState('full')
  const [pathChosen, setPathChosen] = useState(false)
  const [questions, setQuestions] = useState([])
  const [answers, setAnswers] = useState({})
  const [logText, setLogText] = useState('')
  const [showLog, setShowLog] = useState(false)
  const [runs, setRuns] = useState([])
  const [integrationOk, setIntegrationOk] = useState(null)
  const [conflict, setConflict] = useState(null)
  const pollRef = useRef(null)

  const checkIntegration = useCallback(async () => {
    try {
      const health = await rest('/integration/health')
      setIntegrationOk(Boolean(health && health.patched))
    } catch (err) {
      setIntegrationOk(null)
    }
  }, [])

  const repairIntegration = useCallback(async () => {
    setBusy(true)
    try {
      const result = await rest('/integration/repair', { method: 'POST' })
      setIntegrationOk(Boolean(result && result.patched))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { checkIntegration() }, [checkIntegration])

  const openBrowser = useCallback(async path => {
    setBusy(true)
    setError('')
    try {
      const data = await rest(`/browse?path=${encodeURIComponent(__str(path))}`)
      setBrowseData(data)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
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
      const history = await rest(`/workflows/${encodeURIComponent(processId)}/runs?cwd=${encodeURIComponent(path)}`)
      setRuns((history && history.runs) || [])
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
    if (!folder || !run || run.status !== 'running') {
      return undefined
    }
    let alive = true
    const pull = async () => {
      try {
        const data = await rest(`/log?cwd=${encodeURIComponent(folder)}`)
        if (alive) setLogText(__str(data && data.output))
      } catch (err) {
        /* a missing log is not an error worth showing */
      }
    }
    pull()
    const id = setInterval(pull, 2000)
    return () => { alive = false; clearInterval(id) }
  }, [folder, run])

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
    setConflict(null)
    setEditError('')
    try {
      const file = await rest(`/artifact?cwd=${encodeURIComponent(folder)}&path=${encodeURIComponent(path)}`)
      setDraft(__str(file && file.content))
      setSavedContent(__str(file && file.content))
      setOpen({ path, mtime: file && file.mtime })
      setAnswers({})
      try {
        const asked = await rest(`/questions?cwd=${encodeURIComponent(folder)}&path=${encodeURIComponent(path)}`)
        setQuestions((asked && asked.questions) || [])
      } catch (err) {
        setQuestions([])
      }
    } catch (err) {
      setEditError(errorText(err))
    }
  }, [folder])

  // A gate opens the artifact it is reviewing, so you edit before approving.
  useEffect(() => {
    if (!run || run.status !== 'paused' || !run.gate || open) return
    const match = artifactForGate(artifacts, run.gate.step_id)
    if (match) openArtifact(match.path)
  }, [run, artifacts, open, openArtifact])

  const applyAnswers = useCallback(async () => {
    if (!open) return
    setBusy(true)
    setEditError('')
    try {
      const result = await rest('/clarify', {
        method: 'POST',
        body: { cwd: folder, path: open.path, answers }
      })
      setDraft(__str(result && result.content))
      setSavedContent(__str(result && result.content))
      setOpen({ path: open.path, mtime: result && result.mtime })
      const asked = await rest(`/questions?cwd=${encodeURIComponent(folder)}&path=${encodeURIComponent(open.path)}`)
      setQuestions((asked && asked.questions) || [])
      setAnswers({})
    } catch (err) {
      setEditError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [open, answers, folder])

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
      const clash = conflictOf(err)
      if (clash) {
        setConflict(clash)
        setEditError('')
      } else {
        setEditError(errorText(err))
      }
    } finally {
      setBusy(false)
    }
  }, [open, draft, folder])

  const loadTheirs = useCallback(() => {
    if (!conflict) return
    setDraft(__str(conflict.content))
    setSavedContent(__str(conflict.content))
    setOpen(prev => ({ path: prev ? prev.path : '', mtime: conflict.mtime }))
    setConflict(null)
  }, [conflict])

  const keepMine = useCallback(async () => {
    if (!open || !conflict) return
    setBusy(true)
    try {
      const result = await rest('/artifact', {
        method: 'PUT',
        body: { cwd: folder, path: open.path, content: draft, base_mtime: conflict.mtime }
      })
      setOpen({ path: open.path, mtime: result && result.mtime })
      setSavedContent(draft)
      setConflict(null)
      setEditError('')
    } catch (err) {
      setEditError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [open, conflict, draft, folder])

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
    setPathChosen(item.id !== 'speckit')
    setError('')
    await refreshRun(folder, item.id)
  }, [folder, refreshRun])

  const start = useCallback(async () => {
    const spec = __str(values.spec || values.report || values.idea)
    if (!spec || !process || !folder) return
    setBusy(true)
    setError('')
    try {
      if (process.id === 'speckit') {
        await rest('/workflow/shape', { method: 'POST', body: { cwd: folder, mode } })
        const shaped = await rest(`/processes?cwd=${encodeURIComponent(folder)}`)
        const updated = ((shaped && shaped.processes) || []).find(item => item.id === 'speckit')
        if (updated) setProcess(updated)
      }
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
  }, [values, process, folder, mode, refreshRun])

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

  const stop = useCallback(async () => {
    if (!run || !run.run_id || !process) return
    setBusy(true)
    setError('')
    try {
      await rest(`/workflows/${encodeURIComponent(process.id)}/runs/${encodeURIComponent(run.run_id)}/stop`, {
        method: 'POST',
        body: { cwd: folder, answers: {} }
      })
      setRun({ ...run, status: 'aborted', current_step_id: run.current_step_id })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [run, process, folder])

  const restart = useCallback(() => {
    setRun(null)
    setValues({})
    setPathChosen(process ? process.id !== 'speckit' : false)
    setOpen(null)
    setError('')
  }, [])

  if (!folder || hasSpecify === false) {
    return jsxs('div', { className: 'sk-root flex h-full flex-col gap-3 p-3', children: [
      jsx('h2', { className: 'sk-body sk-medium', children: 'Spec Kit' }),
      jsx(FolderRow, {
        draft: draftFolder,
        onDraft: setDraftFolder,
        onUse: () => loadFolder(draftFolder),
        onInit: initFolder,
        hasSpecify,
        busy,
        onBrowse: () => openBrowser(browseData && browseData.path ? browseData.path : draftFolder)
      }),
      browseData
        ? jsx(Browser, {
            data: browseData,
            busy,
            onOpen: openBrowser,
            onUp: () => browseData.parent && openBrowser(browseData.parent),
            onUse: () => { const chosen = browseData.path; setBrowseData(null); setDraftFolder(chosen); loadFolder(chosen) },
            onClose: () => setBrowseData(null)
          })
        : null,
      error ? jsx('p', { className: 'sk-small sk-err', children: error }) : null,
      hasSpecify === false
        ? jsx('p', { className: 'sk-small sk-faint', children: 'That folder has no .specify directory yet. Initialise it above.' })
        : null
    ] })
  }

  if (!process) {
    return jsxs('div', { className: 'sk-root flex h-full min-h-0 flex-col gap-2 p-3', children: [
      jsx(IntegrationBanner, { ok: integrationOk, busy, onRepair: repairIntegration }),
      jsx(ProcessChoice, { processes, onPick: pickProcess, onInstall: installExtension, error, busy }),
      jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
        jsx('span', { className: 'sk-truncate sk-tiny sk-faint', children: folder }),
        jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => setFolder(''), children: 'Change folder' })
      ] })
    ] })
  }

  const status = (run && run.status) || 'none'
  const dirty = draft !== savedContent

  return jsxs('div', { className: 'sk-root flex h-full min-h-0 flex-col gap-2 p-3', children: [
    jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
      jsx('div', { className: 'min-w-0', children: [
        jsx('p', { className: 'sk-body sk-medium', children: process.name || titleCase(process.id) }),
        jsx('p', { className: 'sk-truncate sk-tiny sk-faint', children: folder })
      ] }),
      jsxs('div', { className: 'flex shrink-0 items-center gap-1', children: [
        jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => { setFolder(''); setProcess(null); setRun(null) }, children: 'Change folder' }),
        jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => { setProcess(null); setRun(null) }, children: 'Change process' })
      ] })
    ] }),
    jsx(IntegrationBanner, { ok: integrationOk, busy, onRepair: repairIntegration }),
    jsx(ProgressHeader, { steps: process.steps || [], run }),
    jsx('div', { className: 'h-px sk-hr' }),
    status === 'none' || !run
      ? (process.id === 'speckit' && !pathChosen
          ? jsx(PathChoice, {
              busy,
              onPick: choice => { setMode(choice); setPathChosen(true) }
            })
          : jsxs('div', { className: 'flex flex-col gap-3', children: [
              process.id === 'speckit'
                ? jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
                    jsx('span', { className: 'sk-tiny sk-faint', children: mode === 'full' ? 'Full path' : 'Shorter path' }),
                    jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => setPathChosen(false), disabled: busy, children: 'Change' })
                  ] })
                : null,
              jsx(StartCard, { process, values, onChange: (name, value) => setValues(prev => ({ ...prev, [name]: value })), onStart: start, busy, error })
            ] }))
      : null,
    status === 'running'
      ? jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
          jsxs('div', { className: 'flex items-center gap-2', children: [
            jsx(GlyphSpinner, { size: 'sm' }),
            jsx('span', { className: 'sk-small', children: `Running: ${titleCase(run.current_step_id) || 'workflow'}` })
          ] }),
          jsx(Button, { size: 'xs', variant: 'outline', onClick: stop, disabled: busy || !run.run_id, children: 'Stop' })
        ] })
      : null,
    status === 'running' || (status === 'paused' && logText)
      ? jsxs('div', { className: 'flex flex-col gap-1', children: [
          jsxs('div', { className: 'flex items-center justify-between', children: [
            jsx('span', { className: 'sk-tiny sk-medium sk-dim', children: 'Step output' }),
            jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => setShowLog(v => !v), children: showLog ? 'Hide' : 'Show log' })
          ] }),
          showLog
            ? jsx(ScrollArea, { className: 'max-h-40', children:
                jsx('pre', { className: 'whitespace-pre-wrap p-2 sk-tiny leading-relaxed sk-dim', children: logText || 'No output yet.' })
              })
            : null
        ] })
      : null,
    status === 'completed' || status === 'aborted' || status === 'failed'
      ? jsx(DoneCard, { run, onRestart: restart })
      : null,
    open && questions.length
      ? jsx(QuestionsPanel, {
          questions,
          answers,
          onChange: (index, value) => setAnswers(prev => ({ ...prev, [index]: value })),
          onApply: applyAnswers,
          busy,
          error: editError
        })
      : null,
    open ? jsx(ConflictPanel, { conflict, busy, onReload: loadTheirs, onKeep: keepMine }) : null,
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
            jsx('p', { className: 'sk-tiny sk-medium sk-dim', children: 'Artifacts' }),
            runs.length > 1
              ? jsxs('div', { className: 'mt-2 flex flex-col gap-1', children: [
                  jsx('p', { className: 'sk-tiny sk-medium sk-dim', children: 'Previous runs' }),
                  ...runs.slice(1, 6).map(item => jsxs('div', {
                    className: 'flex items-center justify-between gap-2 rounded border sk-border px-2 py-1 sk-tiny',
                    children: [
                      jsx('span', { className: 'sk-truncate', children: item.summary || item.run_id }),
                      jsx('span', { className: 'shrink-0 sk-faint', children: item.status })
                    ]
                  }, item.run_id))
                ] })
              : null,
            artifacts.length
              ? artifacts.map(item => jsxs('button', {
                  type: 'button',
                  onClick: () => openArtifact(item.path),
                  className: 'flex items-center justify-between gap-2 rounded border sk-border px-2 py-1 text-left sk-small hover:sk-panel',
                  children: [
                    jsx('span', { className: 'sk-truncate', children: item.path.replace(/^specs\//, '') }),
                    jsx('span', { className: 'shrink-0 sk-mono sk-tiny sk-faint', children: item.feature })
                  ]
                }, item.path))
              : jsx('p', { className: 'sk-small sk-faint', children: 'Nothing written yet.' })
          ] })
        }),
    status === 'paused' && run.gate
      ? jsxs('div', { className: 'flex flex-col gap-2 border-t sk-border pt-2', children: [
          run.output_check && run.output_check.checked && run.output_check.unchanged
            ? jsx('p', {
                className: 'rounded border sk-border sk-panel p-2 sk-tiny sk-dim',
                children: 'The step before this gate finished without changing any artifact. The agent may have failed without saying so — check the artifact list before approving.'
              })
            : null,
          jsx(GateCard, { run, busy, onDecide: decide, error })
        ] })
      : null
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
    ensureStyles()
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

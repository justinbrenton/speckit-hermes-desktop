/**
 * Spec-Kit Hermes — desktop half.
 *
 * ONE pane in the right sidebar that drives spec-kit's own workflow engine. The
 * pane runs no workflow logic: `specify workflow run|resume|status` does, through
 * the plugin backend (`/api/plugins/spec-kit-hermes`, backend/plugin_api.py).
 *
 * Screens: pick a process -> fill its declared inputs -> run it, stopping at
 * gates for a human. The editors that used to live here are gone; the workflow
 * writes spec.md, constitution.md and tasks.md through the skills, and the pane
 * shows the artifacts read-only.
 *
 * Build: `npm run build` inlines src/core.mjs at the CORE_INJECT marker and writes
 * desktop/plugin.js. The runtime evaluates a single ESM file, so this module may
 * only import `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`.
 */
import {
  Badge,
  Button,
  EmptyState,
  GlyphSpinner,
  Input,
  ScrollArea,
  Textarea,
  cn,
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

/** The plugin context, captured at register — `ctx.rest` is the I/O door. */
let ctxRef = null

function rest(path, opts) {
  if (!ctxRef || typeof ctxRef.rest !== 'function') {
    return Promise.reject(new Error('plugin context unavailable — reload the plugin'))
  }
  return ctxRef.rest(path, opts)
}

function projectQuery(cwd) {
  return `cwd=${encodeURIComponent(cwd || '')}`
}

function shortPath(path) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : String(path || '')
}

function errorText(error) {
  if (!error) {
    return ''
  }
  if (typeof error === 'string') {
    return error
  }
  const detail = error.detail || error.message || ''
  if (typeof detail === 'string') {
    return detail
  }
  if (detail && detail.missing_inputs) {
    return `Missing: ${detail.missing_inputs.join(', ')}`
  }
  return JSON.stringify(detail)
}

function statusTone(status) {
  if (status === 'completed' || status === 'done') {
    return 'success'
  }
  if (status === 'failed' || status === 'aborted') {
    return 'muted'
  }
  return 'outline'
}

// ---------------------------------------------------------------------------
// small pieces
// ---------------------------------------------------------------------------

function Field({ label, hint, children }) {
  return jsxs('label', {
    className: 'flex flex-col gap-1',
    children: [
      jsx('span', { className: 'text-[0.6875rem] font-medium text-(--ui-text-secondary)', children: label }),
      children,
      hint ? jsx('span', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: hint }) : null
    ]
  })
}

function StatusChip({ run }) {
  if (!run || !run.status) {
    return null
  }
  return jsx(Badge, {
    variant: statusTone(run.status),
    className: 'text-[0.625rem] capitalize',
    children: run.status
  })
}

function ProcessCard({ process, onPick }) {
  const commandSteps = (process.steps || []).filter(step => step.type === 'command').length
  const gateSteps = (process.steps || []).filter(step => step.type === 'gate').length
  const missing = (process.steps || []).filter(step => step.type === 'command' && step.skill_installed === false)
  return jsxs('button', {
    type: 'button',
    onClick: () => onPick(process),
    className:
      'w-full rounded-md border border-(--ui-border) bg-(--ui-bg-tertiary) p-3 text-left transition-colors hover:border-(--ui-accent)',
    children: [
      jsxs('div', { className: 'flex items-start justify-between gap-2', children: [
        jsx('span', { className: 'text-sm font-medium', children: process.name || process.id }),
        process.ready
          ? jsx(Badge, { variant: 'success', className: 'text-[0.625rem]', children: 'ready' })
          : jsx(Badge, { variant: 'muted', className: 'text-[0.625rem]', children: 'skills missing' })
      ] }),
      process.description
        ? jsx('p', { className: 'mt-1 text-[0.6875rem] leading-snug text-(--ui-text-tertiary)', children: process.description })
        : null,
      jsxs('div', { className: 'mt-2 flex items-center gap-2 text-[0.625rem] text-(--ui-text-tertiary)', children: [
        jsx('span', { children: `${commandSteps} step${commandSteps === 1 ? '' : 's'}` }),
        gateSteps ? jsx('span', { children: `· ${gateSteps} gate${gateSteps === 1 ? '' : 's'}` }) : null,
        missing.length ? jsx('span', { children: `· ${missing.length} skill(s) missing` }) : null
      ] })
    ]
  })
}

function ProjectField({ project, busy, onUse }) {
  const [draft, setDraft] = useState(project || '')
  useEffect(() => {
    setDraft(project || '')
  }, [project])
  const commit = () => {
    const next = String(draft || '').trim()
    if (next && next !== project) {
      onUse(next)
    }
  }
  return jsx('div', { className: 'flex flex-col gap-1', children: [
    jsx('span', { className: 'text-[0.625rem] font-medium text-(--ui-text-secondary)', children: 'Project folder' }),
    jsxs('div', { className: 'flex items-center gap-1', children: [
      jsx(Input, {
        value: draft,
        placeholder: 'C:\\path\\to\\your\\project',
        className: 'text-[0.625rem] font-mono',
        onChange: event => setDraft(event.target.value),
        onKeyDown: event => {
          if (event.key === 'Enter') {
            commit()
          }
        }
      }),
      jsx(Button, { size: 'xs', variant: 'secondary', disabled: busy, onClick: commit, children: 'Use' })
    ] }),
    jsx('span', {
      className: 'text-[0.625rem] text-(--ui-text-tertiary)',
      children: 'Defaults to the folder Hermes has open. Point it at a spec-kit project if that is not the right one.'
    })
  ] })
}

function PickScreen({ processes, busy, error, onPick, onReload, onInit, project, hasSpecify, onUseFolder, backendDown }) {
  if (busy && !processes.length) {
    return jsxs('div', { className: 'flex h-full items-center justify-center gap-2', children: [
      jsx(GlyphSpinner, { size: 'sm' }),
      jsx('span', { className: 'text-xs text-(--ui-text-tertiary)', children: 'Reading installed workflows…' })
    ] })
  }

  if (!processes.length) {
    const title = !project
      ? 'Choose a project folder'
      : hasSpecify
        ? 'This project has no workflows'
        : 'Not a spec-kit project yet'
    const description = !project
      ? 'The pane works on one project folder at a time.'
      : hasSpecify
        ? `${project} has a .specify directory but no workflows in it. Install a bundle, or re-run "specify init".`
        : `${project} has no .specify directory. Initialise it here, or point at a folder that already has one.`
    return jsxs('div', { className: 'flex h-full flex-col gap-3 p-3', children: [
      jsx(ProjectField, { project, busy, onUse: onUseFolder }),
      backendDown
        ? jsx('p', {
            className: 'rounded border border-(--ui-border) bg-(--ui-bg-tertiary) p-2 text-[0.6875rem] text-(--ui-text-secondary)',
            children: 'The plugin backend is not answering. Either Hermes has not been restarted since the plugin was installed, or this Hermes home does not list spec-kit-hermes in plugins.enabled. Quit every Hermes process, check that config, then reopen.'
          })
        : null,
      error ? jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: error }) : null,
      jsx('div', { className: 'flex-1', children: jsx(EmptyState, {
        icon: icons.Book,
        title,
        description,
        action: jsxs('div', { className: 'flex items-center gap-1.5', children: [
          jsx(Button, { size: 'xs', variant: 'ghost', disabled: busy, onClick: () => onReload(project), children: 'Reload' }),
          project && !hasSpecify
            ? jsx(Button, { size: 'xs', variant: 'secondary', disabled: busy, onClick: () => onInit(project), children: busy ? 'Initialising…' : 'Initialise this folder' })
            : null
        ] })
      }) })
    ] })
  }

  return jsxs('div', { className: 'flex h-full flex-col gap-3 p-3', children: [
    jsx(ProjectField, { project, busy, onUse: onUseFolder }),
    jsxs('div', { children: [
      jsx('h3', { className: 'text-sm font-medium', children: 'What are we doing?' }),
      jsx('p', { className: 'mt-0.5 text-[0.6875rem] text-(--ui-text-tertiary)', children: 'Each process below is an installed spec-kit workflow.' })
    ] }),
    error ? jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: error }) : null,
    jsx(ScrollArea, {
      className: 'flex-1 min-h-0',
      children: jsx('div', { className: 'flex flex-col gap-2', children: processes.map(process =>
        jsx(ProcessCard, { process, onPick }, process.id)
      ) })
    }),
    jsx('div', { className: 'flex items-center justify-between pt-1', children: [
      jsx('span', { className: 'truncate text-[0.625rem] text-(--ui-text-tertiary)', children: shortPath(project) }),
      jsx(Button, { size: 'xs', variant: 'ghost', disabled: busy, onClick: onReload, children: 'Reload' })
    ] })
  ] })
}

function InputsScreen({ process, values, onChange, onSubmit, onBack, busy, error }) {
  const inputs = process.inputs || []
  return jsxs('div', { className: 'flex h-full flex-col gap-3 p-3', children: [
    jsxs('div', { children: [
      jsx('h3', { className: 'text-sm font-medium', children: process.name || process.id }),
      jsx('p', { className: 'mt-0.5 text-[0.6875rem] text-(--ui-text-tertiary)', children: 'These are the inputs the workflow declares.' })
    ] }),
    error ? jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: error }) : null,
    jsx(ScrollArea, {
      className: 'flex-1 min-h-0',
      children: jsx('div', { className: 'flex flex-col gap-3', children: inputs.length
        ? inputs.map(input => {
            const long = input.name === 'spec' || input.name === 'report' || (input.prompt || '').length > 40
            const value = values[input.name] == null ? '' : values[input.name]
            return jsx(Field, {
              label: `${input.prompt || input.name}${input.required ? ' *' : ''}`,
              hint: input.required ? 'required' : input.default ? `default: ${input.default}` : '',
              children: long
                ? jsx(Textarea, {
                    value,
                    rows: 4,
                    className: 'font-mono text-xs',
                    placeholder: input.prompt || input.name,
                    onChange: event => onChange(input.name, event.target.value)
                  })
                : jsx(Input, {
                    value,
                    placeholder: input.prompt || input.name,
                    onChange: event => onChange(input.name, event.target.value)
                  })
            }, input.name)
          })
        : jsx('p', { className: 'text-xs text-(--ui-text-tertiary)', children: 'This workflow takes no inputs.' })
      })
    }),
    jsxs('div', { className: 'flex items-center justify-between gap-2 pt-1', children: [
      jsx(Button, { size: 'xs', variant: 'ghost', onClick: onBack, children: 'Back' }),
      jsx(Button, { size: 'sm', variant: 'secondary', disabled: busy, onClick: onSubmit, children: busy ? 'Starting…' : 'Start' })
    ] })
  ] })
}

function StepList({ steps, run }) {
  const index = run && Number.isFinite(Number(run.current_step_index)) ? Number(run.current_step_index) : -1
  return jsx('div', { className: 'flex flex-col gap-1', children: steps.map((step, position) => {
    const isCurrent = index === position
    const isDone = index >= 0 ? position < index : run && run.status === 'completed'
    return jsxs('div', {
      className: cn(
        'flex items-center gap-1.5 rounded border px-2 py-1',
        isCurrent ? 'border-(--ui-accent) bg-(--ui-bg-tertiary)' : 'border-(--ui-border)'
      ),
      children: [
        jsx('span', {
          className: cn('w-4 text-center text-[0.625rem]', isDone ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary)'),
          children: isDone ? '✓' : String(position + 1)
        }),
        jsx('span', { className: 'flex-1 truncate text-[0.6875rem]', children: step.id }),
        jsx(Badge, {
          variant: 'outline',
          className: 'text-[0.625rem]',
          children: step.type === 'gate' ? 'gate' : step.skill || step.command || step.type
        })
      ]
    }, step.id)
  }) })
}

function GatePanel({ gate, step, busy, onDecide, problem }) {
  if (!gate) {
    return null
  }
  const verdictInput = step && step.verdict_input
  const options = gate.options && gate.options.length ? gate.options : ['approve', 'reject']
  return jsxs('div', {
    className: 'rounded-md border border-(--ui-accent) bg-(--ui-bg-tertiary) p-3',
    children: [
      jsx('p', { className: 'text-[0.6875rem] font-medium', children: 'Waiting on you' }),
      jsx('p', { className: 'mt-1 text-[0.6875rem] leading-snug text-(--ui-text-secondary)', children: gate.message || gate.step_id }),
      problem ? jsx('p', { className: 'mt-1 text-[0.625rem] text-(--ui-text-tertiary)', children: problem }) : null,
      jsx('div', { className: 'mt-2 flex items-center gap-1.5', children: options.map(option =>
        jsx(Button, {
          size: 'xs',
          variant: option === 'reject' ? 'ghost' : 'secondary',
          disabled: busy || !verdictInput,
          onClick: () => onDecide(option)
        }, option)
      ) })
    ]
  })
}

function ArtifactPanel({ artifacts, onOpen, open, busy }) {
  return jsxs('div', { className: 'flex flex-col gap-1', children: [
    jsxs('div', { className: 'flex items-center justify-between', children: [
      jsx('span', { className: 'text-[0.6875rem] font-medium', children: 'Artifacts' }),
      jsx('span', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: `${artifacts.length} file(s)` })
    ] }),
    jsx('div', { className: 'flex max-h-40 flex-col gap-0.5 overflow-y-auto', children: artifacts.length
      ? artifacts.map(row => jsxs('button', {
          type: 'button',
          onClick: () => onOpen(row.path),
          className: cn(
            'flex items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-[0.625rem] hover:bg-(--ui-bg-tertiary)',
            open && open.path === row.path ? 'bg-(--ui-bg-tertiary)' : ''
          ),
          children: [
            jsx('span', { className: 'truncate', children: row.path.replace(/^\.specify\//, '') }),
            jsx('span', { className: 'shrink-0 text-(--ui-text-tertiary)', children: row.size > 1024 ? `${Math.round(row.size / 1024)}k` : `${row.size}b` })
          ]
        }, row.path))
      : jsx('span', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: busy ? '…' : 'nothing written yet' })
    }),
    open
      ? jsxs('div', { className: 'mt-1 flex flex-col gap-1', children: [
          jsx('span', { className: 'truncate text-[0.625rem] text-(--ui-text-tertiary)', children: open.path }),
          jsx(Textarea, { value: open.content, readOnly: true, rows: 8, className: 'font-mono text-[0.625rem]' })
        ] })
      : null
  ] })
}

function RunScreen({ process, run, output, steps, gate, artifacts, open, busy, error, onDecide, onRestart, onBack, onOpen, project }) {
  const gateStep = gate && steps ? steps.find(step => step.id === gate.step_id) : null
  const gateProblem = gate && gateStep && !gateStep.verdict_input
    ? 'This workflow declares no input for this gate, so it cannot be answered from here. Add verdict_input to the gate.'
    : ''
  const paused = Boolean(run && run.status === 'paused')
  return jsxs('div', { className: 'flex h-full flex-col gap-2 p-3', children: [
    jsxs('div', { className: 'flex items-start justify-between gap-2', children: [
      jsxs('div', { className: 'min-w-0', children: [
        jsx('h3', { className: 'truncate text-sm font-medium', children: process.name || process.id }),
        jsx('p', { className: 'truncate text-[0.625rem] text-(--ui-text-tertiary)', children: run && run.run_id ? `run ${run.run_id} · ${shortPath(project)}` : shortPath(project) })
      ] }),
      jsxs('div', { className: 'flex shrink-0 items-center gap-1', children: [
        jsx(StatusChip, { run }),
        jsx(Button, { size: 'xs', variant: 'ghost', onClick: onBack, children: 'Exit' })
      ] })
    ] }),

    error ? jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: error }) : null,
    busy ? jsxs('div', { className: 'flex items-center gap-2 text-[0.6875rem] text-(--ui-text-tertiary)', children: [
      jsx(GlyphSpinner, { size: 'sm' }),
      jsx('span', { children: 'Running a step — this can take a minute.' })
    ] }) : null,

    jsx(ScrollArea, {
      className: 'flex-1 min-h-0',
      children: jsxs('div', { className: 'flex flex-col gap-3', children: [
        jsx(GatePanel, { gate, step: gateStep, busy, onDecide, problem: gateProblem }),
        steps && steps.length ? jsx(StepList, { steps, run }) : null,
        jsxs('div', { className: 'flex flex-col gap-1', children: [
          jsx('span', { className: 'text-[0.6875rem] font-medium', children: 'Output' }),
          jsx(Textarea, {
            value: output || 'No output yet. Press Run to start.',
            readOnly: true,
            rows: 10,
            className: 'font-mono text-[0.625rem]'
          })
        ] }),
        jsx(ArtifactPanel, { artifacts, open, onOpen, busy })
      ] })
    }),

    jsxs('div', { className: 'flex items-center justify-between gap-2 pt-1', children: [
      jsx(Button, { size: 'xs', variant: 'ghost', disabled: busy, onClick: onRestart, children: 'Start over' }),
      jsx(Button, {
        size: 'sm',
        variant: 'secondary',
        disabled: busy || paused,
        onClick: () => onDecide(null),
        children: busy ? 'Running…' : paused ? 'Answer the gate above' : 'Run next step'
      })
    ] })
  ] })
}

// ---------------------------------------------------------------------------
// master pane
// ---------------------------------------------------------------------------

function SpecKitPane() {
  const cwd = useValue(host.state.cwd)
  const [phase, setPhase] = useState('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [processes, setProcesses] = useState([])
  const [projectInfo, setProjectInfo] = useState({ hasSpecify: false, hasWorkflows: false })
  const [selected, setSelected] = useState(null)
  const [inputs, setInputs] = useState({})
  const [run, setRun] = useState(null)
  const [gate, setGate] = useState(null)
  const [output, setOutput] = useState('')
  const [artifacts, setArtifacts] = useState([])
  const [openArtifact, setOpenArtifact] = useState(null)
  const cwdRef = useRef('')
  const storedProject = useRef('')
  const [project, setProject] = useState('')
  const [backendDown, setBackendDown] = useState(false)

  // Whether the Python half is reachable is decided by the real /processes call
  // below, not by a synthetic probe: /status exists in older builds too, and an
  // empty cwd would 400 rather than prove anything.

  const refreshArtifacts = useCallback(async project => {
    try {
      const response = await rest(`/artifacts?${projectQuery(project)}`)
      setArtifacts((response && response.artifacts) || [])
    } catch (err) {
      setArtifacts([])
    }
  }, [])

  const loadProcesses = useCallback(async project => {
    setBusy(true)
    setError('')
    try {
      const response = await rest(`/processes?${projectQuery(project)}`)
      const list = (response && response.processes) || []
      setProcesses(list)
      setProjectInfo({
        hasSpecify: Boolean(response && response.has_specify),
        hasWorkflows: Boolean(response && response.has_workflows)
      })
      setPhase('pick')
      setBackendDown(false)
      if (response && response.errors && response.errors.length) {
        setError(`${response.errors.length} workflow file(s) could not be read`)
      }
      await refreshArtifacts(project)
    } catch (err) {
      setProcesses([])
      setPhase('pick')
      setBackendDown(true)
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [refreshArtifacts])

  // A pinned folder wins over the workspace folder: `host.state.cwd` follows the
  // app's workspace, which is not necessarily the project the user is working in.
  useEffect(() => {
    const stored = (ctxRef && ctxRef.storage && ctxRef.storage.get('specKitProject', '')) || ''
    storedProject.current = stored
    if (!stored) {
      return
    }
    cwdRef.current = stored
    setProject(stored)
    loadProcesses(stored)
  }, [loadProcesses])

  useEffect(() => {
    if (storedProject.current) {
      return
    }
    const next = String(cwd || '')
    if (!next || next === cwdRef.current) {
      return
    }
    cwdRef.current = next
    setProject(next)
    loadProcesses(next)
  }, [cwd, loadProcesses])

  const useFolder = useCallback(next => {
    const path = String(next || '').trim()
    if (!path) {
      return
    }
    storedProject.current = path
    if (ctxRef && ctxRef.storage) {
      ctxRef.storage.set('specKitProject', path)
    }
    cwdRef.current = path
    setProject(path)
    setSelected(null)
    setRun(null)
    setGate(null)
    setOutput('')
    setPhase('loading')
    loadProcesses(path)
  }, [loadProcesses])

  const initProject = useCallback(async explicit => {
    const target = String(explicit || cwdRef.current || '').trim()
    if (!target) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await rest('/init', { method: 'POST', body: { cwd: target } })
      if (response && response.ok === false) {
        setError(`specify init failed (exit ${response.exit_code}) ${(response.stderr || '').slice(-200)}`)
      }
      await loadProcesses(target)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [loadProcesses])

  const pick = useCallback(process => {
    const values = {}
    for (const input of process.inputs || []) {
      values[input.name] = input.default == null ? '' : input.default
    }
    setSelected(process)
    setInputs(values)
    setError('')
    setPhase('inputs')
  }, [])

  const startRun = useCallback(async () => {
    if (!selected) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await rest(`/workflows/${encodeURIComponent(selected.id)}/run`, {
        method: 'POST',
        body: { cwd: cwdRef.current, inputs }
      })
      setRun(response || null)
      setGate((response && response.gate) || null)
      setOutput((response && response.output) || '')
      setPhase('run')
      await refreshArtifacts(cwdRef.current)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [selected, inputs, refreshArtifacts])

  const resume = useCallback(async decision => {
    if (!selected) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const gateStep = (selected.steps || []).find(step => gate && step.id === gate.step_id)
      const answers = {}
      if (decision && gateStep && gateStep.verdict_input) {
        answers[gateStep.verdict_input] = decision
      }
      const response = await rest(
        `/workflows/${encodeURIComponent(selected.id)}/runs/${encodeURIComponent((run && run.run_id) || '')}/resume`,
        { method: 'POST', body: { cwd: cwdRef.current, answers } }
      )
      setRun(response || null)
      setGate((response && response.gate) || null)
      setOutput(previous => `${previous || ''}\n\n${(response && response.output) || ''}`.trim())
      await refreshArtifacts(cwdRef.current)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [selected, run, gate, refreshArtifacts])

  const openFile = useCallback(async path => {
    try {
      const response = await rest(`/artifact?${projectQuery(cwdRef.current)}&path=${encodeURIComponent(path)}`)
      setOpenArtifact({ path: response.path, content: response.content })
    } catch (err) {
      setOpenArtifact({ path, content: errorText(err) })
    }
  }, [])

  const back = useCallback(() => {
    setGate(null)
    setRun(null)
    setOutput('')
    setOpenArtifact(null)
    setError('')
    setPhase(selected ? 'inputs' : 'pick')
  }, [selected])

  const restart = useCallback(() => {
    setGate(null)
    setRun(null)
    setOutput('')
    setError('')
    setPhase('inputs')
  }, [])

  if (phase === 'inputs' && selected) {
    return jsx(InputsScreen, {
      process: selected,
      values: inputs,
      onChange: (name, value) => setInputs(previous => ({ ...previous, [name]: value })),
      onSubmit: startRun,
      onBack: () => setPhase('pick'),
      busy,
      error
    })
  }

  if (phase === 'run' && selected) {
    return jsx(RunScreen, {
      process: selected,
      run,
      steps: selected.steps,
      gate,
      output,
      artifacts,
      open: openArtifact,
      busy,
      error,
      project: cwdRef.current,
      onDecide: decision => resume(decision),
      onRestart: restart,
      onBack: back,
      onOpen: openFile
    })
  }

  return jsx(PickScreen, {
    processes,
    busy,
    error,
    onPick: pick,
    onReload: target => loadProcesses(String(target || cwdRef.current || '').trim()),
    onInit: initProject,
    onUseFolder: useFolder,
    project,
    hasSpecify: projectInfo.hasSpecify,
    backendDown
  })
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
  description: 'Run installed spec-kit processes — SDD, bug fixing, assessment — with gates and artifacts',
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

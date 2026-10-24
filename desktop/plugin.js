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

// ---- inlined from src/core.mjs — build artifact, edit the source instead ----
/**
 * Spec-Kit Hermes — pure core.
 *
 * Everything in this module is side-effect free and unit-tested (test/core.test.mjs).
 * The desktop half (`src/pane.js`) is UI only: it composes these functions with
 * `ctx.rest` I/O so the round-trip behaviour can be verified without a browser.
 *
 * Markdown model:
 *   .specify/spec.md                   spec model  (requirements + acceptance)
 *   .specify/memory/constitution.md    constitution (wizard answers)
 *   .specify/tasks.md                  tasks model (groups, [P:tag], [US#n], checkboxes)
 *
 * Round-trip rule: only the sections we own are regenerated. Every other byte of
 * the file — unknown sections, tables, comments, prose — is preserved verbatim.
 */

const FILE_PATHS = Object.freeze({
  spec: 'spec.md',
  constitution: 'memory/constitution.md',
  tasks: 'tasks.md'
})

/** Relative paths the backend will read and write. Mirrors backend/plugin_api.py. */
const ALLOWED_PATHS = Object.freeze([FILE_PATHS.spec, FILE_PATHS.constitution, FILE_PATHS.tasks])

function today(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Markdown section surgery
// ---------------------------------------------------------------------------

/**
 * Body line range of the first level-1/2 section whose heading matches `matcher`.
 * Level-3+ headings (`### FR-1: …`) stay inside the body: they are content, not
 * section boundaries, which is what keeps the requirement blocks intact.
 */
function sectionRange(lines, matcher) {
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,2})\s+(.*)$/.exec(lines[i])
    if (!m || !matcher(m[2].trim())) {
      continue
    }
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      if (/^#{1,2}\s+/.test(lines[j])) {
        end = j
        break
      }
    }
    return { start: i + 1, end }
  }
  return null
}

function sectionText(text, matcher) {
  const lines = text.split('\n')
  const r = sectionRange(lines, matcher)
  return r ? lines.slice(r.start, r.end).join('\n') : null
}

/** Replace a section body; returns null when the section is absent. */
function replaceSection(text, matcher, body) {
  const lines = text.split('\n')
  const r = sectionRange(lines, matcher)
  if (!r) {
    return null
  }
  const head = lines.slice(0, r.start)
  const tail = lines.slice(r.end)
  const next = [...head]
  // Exactly one blank line before the section body and one after it.
  if (next.length && next[next.length - 1].trim() !== '') {
    next.push('')
  }
  while (next.length > 1 && next[next.length - 1] === '' && next[next.length - 2] === '') {
    next.pop()
  }
  const bodyLines = body.split('\n')
  while (bodyLines.length && bodyLines[bodyLines.length - 1] === '') {
    bodyLines.pop()
  }
  next.push(...bodyLines)
  if (tail.length && tail[0].trim() !== '') {
    next.push('')
  }
  return next.concat(tail).join('\n')
}

const sameTitle = (...names) => title => names.some(n => title.toLowerCase() === n.toLowerCase())

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

function renderSpecTemplate({ feature = 'Untitled Feature', date = today() } = {}) {
  return [
    `# Feature Specification: ${feature}`,
    '',
    '> **Status**: Draft',
    `> **Created**: ${date}`,
    '> **Constitution**: `.specify/memory/constitution.md`',
    '',
    '## Functional Requirements',
    '',
    '### FR-1: First requirement',
    '**Description**: What the system must do.',
    '**Priority**: High',
    '**Acceptance Criteria**:',
    '- [ ] Observable outcome one',
    '- [ ] Observable outcome two',
    '',
    '---',
    '',
    '## Clarifications',
    '',
    '> Add at most three `[NEEDS CLARIFICATION]` lines. The constitution gate blocks more.',
    '',
    '---',
    ''
  ].join('\n')
}

function parseRequirementBlocks(body) {
  const lines = body.split('\n')
  const blocks = []
  let current = null
  for (const line of lines) {
    const head = /^###\s+FR-(\d+)\s*:\s*(.*)$/.exec(line.trim())
    if (head) {
      current = { id: `FR-${head[1]}`, title: head[2].trim(), description: '', priority: 'Medium', acceptance: [] }
      blocks.push(current)
      continue
    }
    if (!current) {
      continue
    }
    const desc = /^\*\*Description\*\*:\s*(.*)$/.exec(line.trim())
    if (desc) {
      current.description = desc[1].trim()
      continue
    }
    const prio = /^\*\*Priority\*\*:\s*(.*)$/.exec(line.trim())
    if (prio) {
      current.priority = prio[1].trim()
      continue
    }
    const box = /^-\s+\[( |x|X)\]\s*(.*)$/.exec(line.trim())
    if (box) {
      current.acceptance.push({ text: box[2].trim(), done: box[1].toLowerCase() === 'x' })
    }
  }
  return blocks
}

function renderRequirementBlocks(requirements) {
  if (!requirements.length) {
    return '_No requirements yet. Add one to start._'
  }
  return requirements
    .map((req, i) => {
      const id = `FR-${i + 1}`
      const acceptance = req.acceptance.length
        ? req.acceptance.map(a => `- [${a.done ? 'x' : ' '}] ${a.text}`)
        : ['- [ ] ']
      return [
        `### ${id}: ${req.title || 'Untitled requirement'}`,
        `**Description**: ${req.description || ''}`,
        `**Priority**: ${req.priority || 'Medium'}`,
        '**Acceptance Criteria**:',
        ...acceptance,
        ''
      ].join('\n')
    })
    .join('\n')
}

function parseSpec(text) {
  const source = typeof text === 'string' ? text : ''
  const titleLine = /^#\s+(.*)$/m.exec(source)
  const title = titleLine ? titleLine[1].replace(/^Feature Specification:\s*/i, '').trim() : ''
  const constitutionRef = /^>\s+\*\*Constitution\*\*:\s*(.+)$/m.exec(source)
  const reqBody = sectionText(source, sameTitle('Functional Requirements')) || ''
  const clarBody = sectionText(source, sameTitle('Clarifications')) || ''
  const clarifications = clarBody
    .split('\n')
    .map(line => /^\s*>?\s*\*\*\[NEEDS CLARIFICATION\]\*\*:\s*(.*)$/.exec(line))
    .filter(Boolean)
    .map(m => m[1].trim())
    .filter(Boolean)

  return {
    title,
    constitutionRef: constitutionRef ? constitutionRef[1].trim().replace(/^`|`$/g, '') : '',
    requirements: parseRequirementBlocks(reqBody),
    clarifications,
    empty: source.trim() === ''
  }
}

function serializeSpec(model, source = '') {
  let out = source
  if (!out.trim()) {
    out = renderSpecTemplate({ feature: model.title || 'Untitled Feature' })
  }
  const rendered = replaceSection(out, sameTitle('Functional Requirements'), renderRequirementBlocks(model.requirements))
  if (rendered !== null) {
    out = rendered
  }
  const clar = (model.clarifications || []).map(c => `> **[NEEDS CLARIFICATION]**: ${c}`).join('\n')
  const withClar = replaceSection(out, sameTitle('Clarifications'), clar || '> _No open clarifications._')
  if (withClar !== null) {
    out = withClar
  }
  return out
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function renderTasksTemplate({ feature = 'Untitled Feature' } = {}) {
  return [
    `# Task List: ${feature}`,
    '',
    '> **Status**: Draft',
    '> **Based on**: `.specify/spec.md`',
    '',
    '## Tasks',
    '',
    '### Sequential',
    '- [ ] **T-1**: First task',
    ''
  ].join('\n')
}

function parseTaskLine(line) {
  const m = /^-\s+\[( |x|X)\]\s+\*\*(T-\d+)\*\*:\s*(.*)$/.exec(line.trim()) ||
    /^-\s+\[( |x|X)\]\s+(.*)$/.exec(line.trim())
  if (!m) {
    return null
  }
  const done = m[1].toLowerCase() === 'x'
  if (m.length === 4) {
    const story = /\[US#([^\]]+)\]/.exec(m[3])
    const title = m[3].replace(/\[US#[^\]]+\]/g, '').replace(/\[P[^\]]*\]/g, '').trim()
    return { id: m[2], title, story: story ? story[1] : '', done }
  }
  const story = /\[US#([^\]]+)\]/.exec(m[2])
  const title = m[2].replace(/\[US#[^\]]+\]/g, '').replace(/\[P[^\]]*\]/g, '').trim()
  return { id: '', title, story: story ? story[1] : '', done }
}

function parseTasks(text) {
  const source = typeof text === 'string' ? text : ''
  const titleLine = /^#\s+(.*)$/m.exec(source)
  const body = sectionText(source, sameTitle('Tasks')) || ''
  const lines = body.split('\n')
  const groups = []
  let group = null
  for (const line of lines) {
    const head = /^###\s+(.*)$/.exec(line.trim())
    if (head) {
      const tag = /\[P:([^\]]+)\]/.exec(head[1])
      group = { heading: head[1].replace(/\[P:[^\]]+\]/g, '').trim(), parallel: tag ? tag[1].trim() : '', tasks: [] }
      groups.push(group)
      continue
    }
    const task = parseTaskLine(line)
    if (!task) {
      continue
    }
    if (!group) {
      group = { heading: 'Sequential', parallel: '', tasks: [] }
      groups.push(group)
    }
    group.tasks.push(task)
  }
  const flat = groups.flatMap(g => g.tasks)
  return {
    title: titleLine ? titleLine[1].replace(/^Task List:\s*/i, '').trim() : '',
    groups,
    tasks: flat,
    empty: source.trim() === ''
  }
}

function renderGroups(groups) {
  let n = 0
  const out = []
  for (const group of groups) {
    if (!group.tasks.length) {
      continue
    }
    const suffix = group.parallel ? ` [P:${group.parallel}]` : ''
    out.push(`### ${group.heading || 'Sequential'}${suffix}`, '')
    for (const task of group.tasks) {
      n += 1
      const story = task.story ? ` [US#${task.story}]` : ''
      out.push(`- [${task.done ? 'x' : ' '}] **T-${n}**: ${task.title}${story}`)
    }
    out.push('')
  }
  return out.join('\n')
}

function serializeTasks(model, source = '') {
  let out = source
  if (!out.trim()) {
    out = renderTasksTemplate({ feature: model.title || 'Untitled Feature' })
  }
  const body = renderGroups(model.groups || [{ heading: 'Sequential', tasks: model.tasks || [] }])
  const rendered = replaceSection(out, sameTitle('Tasks'), body || '_No tasks yet._')
  return rendered === null ? out : rendered
}

function toggleTask(model, index) {
  const groups = model.groups.map(g => ({ ...g, tasks: g.tasks.map(t => ({ ...t })) }))
  const flat = groups.flatMap(g => g.tasks)
  if (index < 0 || index >= flat.length) {
    return model
  }
  flat[index].done = !flat[index].done
  return { ...model, groups, tasks: flat }
}

function addTask(model, task, { group = 'Sequential' } = {}) {
  const groups = (model.groups || []).map(g => ({ ...g, tasks: [...g.tasks] }))
  let target = groups.find(g => g.heading.toLowerCase() === group.toLowerCase())
  if (!target) {
    target = { heading: group, parallel: '', tasks: [] }
    groups.push(target)
  }
  target.tasks.push({ id: '', title: task.title, story: task.story || '', done: false })
  return { ...model, groups, tasks: groups.flatMap(g => g.tasks) }
}

// ---------------------------------------------------------------------------
// Constitution
// ---------------------------------------------------------------------------

const CONSTITUTION_STEPS = Object.freeze([
  {
    id: 'purpose',
    title: 'Purpose',
    kind: 'single',
    prompt: 'What is this project?',
    options: [
      'Web Application', 'API Service', 'CLI Tool', 'Library / SDK',
      'Desktop App', 'Mobile App', 'Data Pipeline', 'ML Model', 'Internal Tool'
    ]
  },
  {
    id: 'principles',
    title: 'Principles',
    kind: 'multi',
    min: 3,
    max: 5,
    prompt: 'Pick 3–5 non-negotiables.',
    options: [
      'Simplicity first', 'Test before code', 'Explicit over clever', 'Small reviewable diffs',
      'Delete dead code', 'Observability by default', 'Security by default', 'Documentation as code',
      'Boring technology', 'Measured performance'
    ]
  },
  {
    id: 'architecture',
    title: 'Architecture',
    kind: 'selects',
    prompt: 'Baseline stack. These land in the constitution table.',
    fields: [
      { id: 'language', label: 'Language', options: ['TypeScript', 'Python', 'Go', 'Rust', 'Java', 'C#', 'Other'] },
      { id: 'framework', label: 'Framework', options: ['React', 'Next.js', 'FastAPI', 'Express', 'Gin', 'None', 'Other'] },
      { id: 'storage', label: 'Storage', options: ['PostgreSQL', 'SQLite', 'MySQL', 'MongoDB', 'Files', 'None', 'Other'] },
      { id: 'testing', label: 'Testing', options: ['TDD', 'Unit + integration', 'E2E focused', 'Property-based', 'Minimal'] },
      { id: 'delivery', label: 'Delivery', options: ['Docker', 'Kubernetes', 'Serverless', 'VM', 'Static hosting', 'Local only'] }
    ]
  },
  {
    id: 'governance',
    title: 'Governance',
    kind: 'single',
    prompt: 'How are changes to this project governed?',
    options: ['Solo, self-review', 'Peer review required', 'Consensus team', 'Formal change board']
  },
  {
    id: 'ratify',
    title: 'Review',
    kind: 'review',
    prompt: 'Check the draft, then ratify.'
  }
])

/** Validate one wizard step. Returns `{ ok, issues: string[] }`. */
function validateConstitutionStep(stepId, answers) {
  const step = CONSTITUTION_STEPS.find(s => s.id === stepId)
  if (!step) {
    return { ok: false, issues: [`unknown step ${stepId}`] }
  }
  const issues = []
  if (step.kind === 'single') {
    if (!answers?.[step.id]) {
      issues.push(`choose one ${step.title.toLowerCase()} option`)
    }
  }
  if (step.kind === 'multi') {
    const picked = answers?.[step.id]
    const count = Array.isArray(picked) ? picked.length : 0
    if (count < (step.min ?? 1)) {
      issues.push(`pick at least ${step.min} principles`)
    }
    if (step.max && count > step.max) {
      issues.push(`pick at most ${step.max} principles`)
    }
  }
  if (step.kind === 'selects') {
    const chosen = answers?.[step.id] || {}
    for (const field of step.fields) {
      if (!chosen[field.id]) {
        issues.push(`${field.label.toLowerCase()} is required`)
      }
    }
  }
  return { ok: issues.length === 0, issues }
}

function constitutionProgress(answers) {
  return CONSTITUTION_STEPS.filter(step => validateConstitutionStep(step.id, answers).ok).length
}

function serializeConstitution(answers = {}, { date = today(), version = '1.0' } = {}) {
  const principles = (answers.principles || []).slice(0, 5)
  const architecture = answers.architecture || {}
  const rows = CONSTITUTION_STEPS.find(s => s.id === 'architecture').fields.map(
    f => `| ${f.label} | ${architecture[f.id] || '_undecided_'} | Set during constitution wizard |`
  )
  const numbered = principles.length
    ? principles.map((name, i) => `${i + 1}. **${name}**: adopted as a non-negotiable for this project.`)
    : ['1. **TBD**: ratify at least three principles.']
  return [
    '# Project Constitution',
    '',
    `> **Version**: ${version}`,
    `> **Ratified**: ${date}`,
    '> **Review Cycle**: Quarterly',
    '',
    '## Purpose',
    '',
    answers.purpose || '_undecided_',
    '',
    '## Core Principles',
    '',
    ...numbered,
    '',
    '## Architecture Decisions',
    '',
    '| Area | Decision | Rationale |',
    '|------|----------|-----------|',
    ...rows,
    '',
    '## Governance',
    '',
    `- **Review Process**: ${answers.governance || '_undecided_'}`,
    '- **Amendment Procedure**: propose, review, record the change here',
    '- **Exception Handling**: documented in the spec it affects',
    '',
    '## Compliance Checklist',
    '',
    '- [ ] All specs reference this constitution',
    '- [ ] All plans validate against principles',
    '- [ ] Architecture decisions documented',
    '- [ ] Governance process followed',
    ''
  ].join('\n')
}

function parseConstitution(text) {
  const source = typeof text === 'string' ? text : ''
  const version = /^>\s+\*\*Version\*\*:\s*(.+)$/m.exec(source)
  const ratified = /^>\s+\*\*Ratified\*\*:\s*(.+)$/m.exec(source)
  const purposeBody = sectionText(source, sameTitle('Purpose')) || ''
  const purpose = purposeBody.split('\n').map(l => l.trim()).filter(Boolean).find(l => !l.startsWith('_')) || ''
  const principlesBody = sectionText(source, sameTitle('Core Principles')) || ''
  const principles = principlesBody
    .split('\n')
    .map(line => /^\d+\.\s+\*\*(.+?)\*\*/.exec(line.trim()))
    .filter(Boolean)
    .map(m => m[1].trim())
  const answers = {
    purpose,
    principles,
    architecture: {},
    governance: ''
  }
  const govBody = sectionText(source, sameTitle('Governance')) || ''
  const review = /-\s+\*\*Review Process\*\*:\s*(.+)$/m.exec(govBody)
  if (review) {
    answers.governance = review[1].trim()
  }
  const archBody = sectionText(source, sameTitle('Architecture Decisions')) || ''
  for (const line of archBody.split('\n')) {
    const row = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line.trim())
    if (!row || /^-+$/.test(row[1]) || row[1].toLowerCase() === 'area') {
      continue
    }
    const field = CONSTITUTION_STEPS.find(s => s.id === 'architecture').fields.find(
      f => f.label.toLowerCase() === row[1].toLowerCase()
    )
    if (field) {
      answers.architecture[field.id] = row[2]
    }
  }
  return {
    version: version ? version[1].trim() : '',
    ratified: ratified ? ratified[1].trim() : '',
    answers,
    empty: source.trim() === ''
  }
}

/**
 * The gate the Spec step shows live: a spec is "planning ready" only when a
 * ratified constitution backs it and the clarifications budget is respected.
 */
function constitutionGate(spec, constitution) {
  const issues = []
  if (!constitution || constitution.empty) {
    issues.push('constitution.md is missing — ratify it in step 2')
  } else if ((constitution.answers?.principles || []).length < 3) {
    issues.push('constitution has fewer than three principles')
  }
  if (!spec.requirements.length) {
    issues.push('spec has no functional requirements')
  }
  if (spec.clarifications.length > 3) {
    issues.push(`${spec.clarifications.length} open clarifications (max 3)`)
  }
  return { ok: issues.length === 0, issues }
}

// ---------------------------------------------------------------------------
// Cross-step data flow
// ---------------------------------------------------------------------------

/** Requirements with no task pointing at them become proposed task cards. */
function deriveTasksFromSpec(spec) {
  const existing = (spec.linkedTaskStories || []).map(String)
  return spec.requirements
    .map((req, i) => ({ req, id: `FR-${i + 1}` }))
    .filter(({ id }) => !existing.includes(id))
    .map(({ req, id }) => ({
      title: `Implement ${id}: ${req.title}`,
      body: [req.description, '', '**Acceptance criteria**', ...req.acceptance.map(a => `- ${a.text}`)].join('\n'),
      story: id
    }))
}

/** A requirement whose tasks are all done has its acceptance criteria ticked. */
function applyAcceptanceFromTasks(spec, taskModel) {
  const byStory = new Map()
  for (const task of taskModel.tasks || []) {
    if (!task.story) {
      continue
    }
    const list = byStory.get(String(task.story)) || []
    list.push(task)
    byStory.set(String(task.story), list)
  }
  let changed = false
  const requirements = spec.requirements.map((req, i) => {
    const id = `FR-${i + 1}`
    const tasks = byStory.get(id)
    if (!tasks || !tasks.length || !tasks.every(t => t.done)) {
      return req
    }
    const acceptance = req.acceptance.map(a => (a.done ? a : ((changed = true), { ...a, done: true })))
    return { ...req, acceptance }
  })
  return { spec: { ...spec, requirements }, changed }
}

// ---------------------------------------------------------------------------
// Sync state machine
// ---------------------------------------------------------------------------

/**
 * Decide what one poll tick should do.
 *   dirty    — the pane has unsaved local edits
 *   base     — mtime the pane last read or wrote
 *   remote   — mtime the backend reports now
 */
function decideSync({ dirty, base, remote }) {
  if (remote === base) {
    return dirty ? 'write' : 'idle'
  }
  return dirty ? 'conflict' : 'reload'
}

/**
 * The Electron REST bridge rejects with `Error("<status>: <json body>")` — there
 * is no typed error object, so the status and the FastAPI `detail` are parsed out
 * of the message. Anything else falls through as status 0.
 */
function parseRestError(error) {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const match = /^(\d{3}):\s*([\s\S]*)$/.exec(raw.trim())
  if (!match) {
    return { status: 0, detail: null, message: raw }
  }
  const status = Number(match[1])
  const body = match[2].trim()
  let detail = null
  try {
    const parsed = JSON.parse(body)
    detail = parsed && typeof parsed === 'object' && 'detail' in parsed ? parsed.detail : parsed
  } catch {
    detail = body || null
  }
  const message = typeof detail === 'string' ? detail : (detail && (detail.reason || detail.message)) || raw
  return { status, detail, message }
}

/** Debounce that can be flushed on unmount. Injected timer keeps it testable. */
function createDebouncer(fn, ms) {
  let handle = null
  let pending = null
  const run = () => {
    handle = null
    const args = pending
    pending = null
    if (args) {
      return fn(...args)
    }
    return undefined
  }
  return {
    schedule(...args) {
      pending = args
      if (handle !== null) {
        clearTimeout(handle)
      }
      handle = setTimeout(run, ms)
    },
    flush() {
      if (handle !== null) {
        clearTimeout(handle)
        handle = null
      }
      return run()
    },
    cancel() {
      if (handle !== null) {
        clearTimeout(handle)
        handle = null
      }
      pending = null
    },
    get pending() {
      return pending !== null
    }
  }
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

const STEPS = Object.freeze([
  { id: 'spec', label: 'Spec' },
  { id: 'constitution', label: 'Constitution' },
  { id: 'tasks', label: 'Tasks' }
])

function stepIndex(id) {
  const i = STEPS.findIndex(s => s.id === id)
  return i < 0 ? 0 : i
}

function stepAt(index) {
  return STEPS[Math.max(0, Math.min(STEPS.length - 1, index))]
}

/** What the stepper draws for one step: done / current / todo. */
function stepStates(activeId, { spec, constitution, tasks }) {
  const ready = {
    spec: Boolean(spec && spec.requirements && spec.requirements.length),
    constitution: Boolean(constitution && !constitution.empty && (constitution.answers?.principles || []).length >= 3),
    tasks: Boolean(tasks && (tasks.tasks || []).length)
  }
  return STEPS.map(s => ({
    ...s,
    ready: ready[s.id],
    current: s.id === activeId
  }))
}

/**
 * Suggestion for the step to open on pane load: the furthest step that has
 * content, so a returning user lands where they left off.
 */
function suggestStep({ spec, constitution, tasks }) {
  if (tasks && (tasks.tasks || []).length) {
    return 'tasks'
  }
  if (constitution && !constitution.empty && (constitution.answers?.principles || []).length >= 3) {
    return 'tasks'
  }
  if (spec && (spec.requirements || []).length) {
    return 'constitution'
  }
  return 'spec'
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const DISPATCH_ACTIONS = Object.freeze(['plan', 'implement'])

function projectPath(project, rel) {
  return `${String(project).replace(/[\\/]+$/, '')}/.specify/${rel}`
}

/**
 * Build the message handed to an agent session. The pane never pastes file
 * contents: the agent reads the files itself, so the on-disk copy stays the
 * source of truth and the prompt stays short.
 *
 * Throws when the request cannot be honoured, so the caller can disable the
 * button instead of sending a message that asks for the impossible.
 */
function dispatchMessage(action, { project, feature, spec, constitution, tasks } = {}) {
  if (!DISPATCH_ACTIONS.includes(action)) {
    throw new Error(`unknown dispatch action: ${JSON.stringify(action)}`)
  }
  if (!project || !String(project).trim()) {
    throw new Error('project root is required')
  }

  const files = {
    spec: projectPath(project, FILE_PATHS.spec),
    constitution: projectPath(project, FILE_PATHS.constitution),
    tasks: projectPath(project, FILE_PATHS.tasks)
  }
  const name = String(feature || spec?.title || tasks?.title || '').trim() || 'this feature'

  if (action === 'plan') {
    const ratified = Boolean(
      constitution && !constitution.empty && (constitution.answers?.principles || []).length >= 3
    )
    if (!ratified) {
      throw new Error('constitution is not ratified')
    }
    const count = (spec?.requirements || []).length
    if (!count) {
      throw new Error('no requirements in the spec')
    }
    const planPath = projectPath(project, 'plan.md')
    const prompt = [
      `Work in ${project}.`,
      '',
      'Read these first:',
      `- ${files.spec}`,
      `- ${files.constitution}`,
      '',
      `Write ${planPath} for ${name}. Cover the technical approach, the data it touches,`,
      `the contracts if any, and how each of the ${count} requirement${count === 1 ? '' : 's'} gets tested.`,
      `Every choice has to survive the principles in the constitution.`,
      '',
      `Do not change ${files.spec}. If a requirement is ambiguous, ask instead of guessing.`
    ].join('\n')
    return { action, title: `Plan: ${name}`, prompt, files }
  }

  const open = (tasks?.tasks || []).filter(task => !task.done)
  if (!open.length) {
    throw new Error('no open tasks to implement')
  }
  const next = open[0]
  const label = next.id ? `${next.id}: ${next.title}` : next.title
  const story = next.story ? ` It belongs to ${next.story} in ${files.spec}.` : ''
  const prompt = [
    `Work in ${project}.`,
    '',
    `Implement this task from ${files.tasks}:`,
    `- ${label}`,
    '',
    `Read ${files.spec} for the requirement and its acceptance criteria.${story}`,
    'When it works and the tests for it pass, change its line in the task file to `- [x]`',
    'and nothing else. Do not tick a task you did not finish, and do not touch other tasks.'
  ].join('\n')
  return { action, title: `Implement ${label}`, prompt, files }
}
// ---- end inlined core ----

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

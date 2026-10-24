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

function PickScreen({ processes, busy, error, onPick, onReload, onInit, project, hasSpecify, onUseFolder }) {
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
      if (response && response.errors && response.errors.length) {
        setError(`${response.errors.length} workflow file(s) could not be read`)
      }
      await refreshArtifacts(project)
    } catch (err) {
      setProcesses([])
      setPhase('pick')
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
    hasSpecify: projectInfo.hasSpecify
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

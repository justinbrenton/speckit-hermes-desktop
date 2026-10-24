/**
 * Spec-Kit Hermes — desktop half.
 *
 * ONE pane in the right sidebar: a three-step wizard (Spec -> Constitution -> Tasks)
 * backed by `.specify/` files through `ctx.rest` (the plugin's own backend namespace
 * `/api/plugins/spec-kit-hermes`, served by backend/plugin_api.py).
 *
 * Build: `npm run build` inlines src/core.mjs at the CORE_INJECT marker and writes
 * desktop/plugin.js. The plugin runtime evaluates a single ESM file, so this module
 * may only import `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`.
 */
import {
  Badge,
  Button,
  Checkbox,
  ErrorState,
  GlyphSpinner,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Textarea,
  cn,
  host,
  icons,
  PANES_AREA,
  STATUSBAR_AREAS,
  useValue
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
// ---- end inlined core ----

const ID = 'spec-kit-hermes'
const PANE_ID = `${ID}:spec-kit`
const DEBOUNCE_MS = 700
const POLL_MS = 3000

const SPEC_REL = FILE_PATHS.spec
const CONST_REL = FILE_PATHS.constitution
const TASKS_REL = FILE_PATHS.tasks

const PARSE = { [SPEC_REL]: parseSpec, [CONST_REL]: parseConstitution, [TASKS_REL]: parseTasks }

const PRIORITIES = ['High', 'Medium', 'Low']

/** The plugin context, captured once at register — `ctx.rest` is the I/O door. */
let ctxRef = null

function rest(path, opts) {
  if (!ctxRef || typeof ctxRef.rest !== 'function') {
    return Promise.reject(new Error('plugin context unavailable — reload the plugin'))
  }
  return ctxRef.rest(path, opts)
}

function projectQuery(cwd) {
  return `/files?cwd=${encodeURIComponent(cwd)}`
}

function parseModel(rel, text) {
  const parser = PARSE[rel]
  return parser(text)
}

/** Serialize a doc. The constitution is fully regenerated from wizard answers. */
function serializeModel(rel, doc) {
  if (rel === CONST_REL) {
    return serializeConstitution(doc.model.answers || {}, { date: doc.model.ratified || today() })
  }
  if (rel === SPEC_REL) {
    return serializeSpec(doc.model, doc.raw)
  }
  return serializeTasks(doc.model, doc.raw)
}

async function loadDocs(cwd) {
  const response = await rest(projectQuery(cwd))
  const docs = {}
  for (const rel of ALLOWED_PATHS) {
    const entry = (response.files && response.files[rel]) || { exists: false, content: '', mtime: null }
    docs[rel] = {
      rel,
      raw: entry.content,
      model: parseModel(rel, entry.content),
      mtime: entry.mtime,
      exists: entry.exists,
      dirty: false
    }
  }
  docs.project = response.specify || ''
  return docs
}

// ---------------------------------------------------------------------------
// small presentational helpers
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

function Choice({ active, onClick, children, keyProp }) {
  return jsx(Button, {
    key: keyProp,
    variant: active ? 'secondary' : 'outline',
    size: 'sm',
    className: cn('justify-start text-left whitespace-normal h-auto py-1.5', active && 'ring-1 ring-(--ui-accent)'),
    onClick,
    children
  })
}

/** Compact empty state — the SDK EmptyState has no icon or action slots. */
function EmptyBlock({ icon, title, description, actionLabel, onAction }) {
  const Icon = icons[icon] || icons.Book
  return jsx('div', {
    className: 'grid place-items-center p-6 text-center',
    children: jsxs('div', {
      className: 'flex flex-col items-center gap-2',
      children: [
        jsx(Icon, { className: 'size-5 text-(--ui-text-tertiary)' }),
        jsx('div', { className: 'text-xs font-medium', children: title }),
        description
          ? jsx('div', { className: 'max-w-[36ch] text-[0.6875rem] text-(--ui-text-tertiary)', children: description })
          : null,
        actionLabel ? jsx(Button, { variant: 'secondary', size: 'sm', onClick: onAction, children: actionLabel }) : null
      ]
    })
  })
}

function Spinner({ label }) {
  return jsxs('div', {
    className: 'flex h-full items-center justify-center gap-2',
    children: [
      jsx(GlyphSpinner, { size: 'lg' }),
      jsx('span', { className: 'text-sm text-(--ui-text-tertiary)', children: label })
    ]
  })
}

// ---------------------------------------------------------------------------
// stepper
// ---------------------------------------------------------------------------

function Stepper({ step, states, onPick }) {
  return jsx('div', {
    className: 'flex items-center gap-1 px-3 py-2 border-b border-(--ui-border)',
    role: 'tablist',
    'aria-label': 'Spec Kit steps',
    children: states.map((state, index) =>
      jsxs(
        'div',
        {
          className: 'flex items-center gap-1',
          children: [
            index > 0
              ? jsx('span', { className: 'text-(--ui-text-tertiary) text-xs', 'aria-hidden': true, children: '›' })
              : null,
            jsxs(Button, {
              variant: state.current ? 'secondary' : 'ghost',
              size: 'xs',
              role: 'tab',
              'aria-selected': state.current,
              className: cn('gap-1.5', state.current && 'ring-1 ring-(--ui-accent)'),
              onClick: () => onPick(state.id),
              children: [
                jsx('span', {
                  className: cn(
                    'grid size-4 place-items-center rounded-full text-[0.625rem] font-semibold',
                    state.ready ? 'bg-(--ui-accent) text-(--ui-accent-fg)' : 'bg-(--ui-bg-quaternary) text-(--ui-text-secondary)'
                  ),
                  children: state.ready && !state.current ? '✓' : String(index + 1)
                }),
                jsx('span', { children: state.label })
              ]
            })
          ]
        },
        state.id
      )
    )
  })
}

// ---------------------------------------------------------------------------
// step 1 — spec
// ---------------------------------------------------------------------------

function SpecStep({ spec, constitution, onEdit, onCreate }) {
  if (spec.empty) {
    return jsx(EmptyBlock, {
      icon: 'Book',
      title: 'No spec.md yet',
      description: 'Create .specify/spec.md and start with one requirement.',
      actionLabel: 'Create spec',
      onAction: onCreate
    })
  }
  const gate = constitutionGate(spec, constitution)
  const requirements = spec.requirements || []
  const clarifications = spec.clarifications || []

  const patchRequirement = (index, patch) =>
    onEdit(model => ({
      ...model,
      requirements: model.requirements.map((req, i) => (i === index ? { ...req, ...patch } : req))
    }))

  const patchCriterion = (index, criterion, patch) =>
    patchRequirement(index, {
      acceptance: spec.requirements[index].acceptance.map((item, i) => (i === criterion ? { ...item, ...patch } : item))
    })

  return jsxs('div', {
    className: 'flex flex-col gap-3 p-3',
    children: [
      jsxs('div', {
        className: cn(
          'rounded border px-2.5 py-2 text-[0.6875rem]',
          gate.ok
            ? 'border-(--ui-border) bg-(--ui-bg-tertiary) text-(--ui-text-secondary)'
            : 'border-(--ui-warning, var(--ui-border)) bg-(--ui-bg-tertiary) text-(--ui-text-primary)'
        ),
        children: [
          jsx('div', { className: 'font-medium mb-0.5', children: gate.ok ? 'Planning ready' : 'Gate not satisfied' }),
          gate.ok
            ? jsx('div', { children: 'Constitution satisfied, requirements present, clarification budget respected.' })
            : jsx('ul', {
                className: 'list-disc pl-4 space-y-0.5',
                children: gate.issues.map(issue => jsx('li', { children: issue }, issue))
              })
        ]
      }),

      jsxs('div', { className: 'flex items-center justify-between', children: [
        jsx('h3', { className: 'text-xs font-medium', children: `Requirements (${requirements.length})` }),
        jsx(Button, {
          size: 'xs',
          variant: 'secondary',
          onClick: () =>
            onEdit(model => ({
              ...model,
              requirements: [
                ...model.requirements,
                { id: `FR-${model.requirements.length + 1}`, title: 'New requirement', description: '', priority: 'Medium', acceptance: [{ text: '', done: false }] }
              ]
            })),
          children: '+ Requirement'
        })
      ] }),

      requirements.length === 0
        ? jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: 'No requirements yet.' })
        : requirements.map((req, index) =>
            jsxs(
              'div',
              {
                className: 'rounded border border-(--ui-border) bg-(--ui-bg-tertiary) p-2 flex flex-col gap-1.5',
                children: [
                  jsxs('div', { className: 'flex items-center gap-1.5', children: [
                    jsx(Badge, { variant: 'outline', className: 'text-[0.625rem] shrink-0', children: `FR-${index + 1}` }),
                    jsx(Input, {
                      value: req.title,
                      size: 'sm',
                      'aria-label': `Requirement ${index + 1} title`,
                      onChange: event => patchRequirement(index, { title: event.target.value })
                    }),
                    jsx(Button, {
                      size: 'xs',
                      variant: 'ghost',
                      title: 'Remove requirement',
                      onClick: () => onEdit(model => ({ ...model, requirements: model.requirements.filter((_, i) => i !== index) })),
                      children: jsx(icons.Trash2, { className: 'size-3' })
                    })
                  ] }),
                  jsx(Textarea, {
                    value: req.description,
                    rows: 2,
                    placeholder: 'What must the system do?',
                    onChange: event => patchRequirement(index, { description: event.target.value })
                  }),
                  jsx(Select, {
                    value: req.priority,
                    onValueChange: value => patchRequirement(index, { priority: value }),
                    children: jsxs('span', {
                      className: 'flex items-center gap-1 text-[0.625rem] text-(--ui-text-secondary)',
                      children: [
                        'Priority',
                        jsx(SelectTrigger, { className: 'h-7', children: jsx(SelectValue, {}) }),
                        jsx(SelectContent, {
                          children: PRIORITIES.map(priority =>
                            jsx(SelectItem, { value: priority, children: priority }, priority)
                          )
                        })
                      ]
                    })
                  }),
                  jsxs('div', { className: 'flex flex-col gap-1 pl-0.5', children: [
                    jsx('span', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: 'Acceptance criteria' }),
                    ...req.acceptance.map((item, criterion) =>
                      jsxs(
                        'div',
                        {
                          className: 'flex items-center gap-1.5',
                          children: [
                            jsx(Checkbox, {
                              checked: item.done,
                              'aria-label': `Criterion ${criterion + 1} done`,
                              onCheckedChange: checked => patchCriterion(index, criterion, { done: checked === true })
                            }),
                            jsx(Input, {
                              value: item.text,
                              size: 'sm',
                              placeholder: 'Observable outcome',
                              onChange: event => patchCriterion(index, criterion, { text: event.target.value })
                            })
                          ]
                        },
                        `${index}-${criterion}`
                      )
                    ),
                    jsx(Button, {
                      size: 'xs',
                      variant: 'ghost',
                      onClick: () => patchRequirement(index, { acceptance: [...req.acceptance, { text: '', done: false }] }),
                      children: '+ criterion'
                    })
                  ] })
                ]
              },
              `req-${index}`
            )
          ),

      jsx(Separator, {}),

      jsxs('div', { className: 'flex flex-col gap-1.5', children: [
        jsxs('div', { className: 'flex items-center justify-between', children: [
          jsx('h3', { className: 'text-xs font-medium', children: `Clarifications (${clarifications.length}/3)` }),
          jsx(Button, {
            size: 'xs',
            variant: 'secondary',
            disabled: clarifications.length >= 3,
            onClick: () => onEdit(model => ({ ...model, clarifications: [...model.clarifications, ''] })),
            children: '+ Clarification'
          })
        ] }),
        clarifications.length === 0
          ? jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: 'None open.' })
          : clarifications.map((text, index) =>
              jsxs(
                'div',
                {
                  className: 'flex items-center gap-1.5',
                  children: [
                    jsx(Input, {
                      value: text,
                      size: 'sm',
                      placeholder: 'Open question',
                      onChange: event =>
                        onEdit(model => ({
                          ...model,
                          clarifications: model.clarifications.map((value, i) => (i === index ? event.target.value : value))
                        }))
                    }),
                    jsx(Button, {
                      size: 'xs',
                      variant: 'ghost',
                      onClick: () =>
                        onEdit(model => ({ ...model, clarifications: model.clarifications.filter((_, i) => i !== index) })),
                      children: jsx(icons.Trash2, { className: 'size-3' })
                    })
                  ]
                },
                `clar-${index}`
              )
            )
      ] })
    ]
  })
}

// ---------------------------------------------------------------------------
// step 2 — constitution wizard
// ---------------------------------------------------------------------------

function ConstitutionStep({ constitution, wizard, setWizard, onRatify }) {
  const step = CONSTITUTION_STEPS[wizard.index] || CONSTITUTION_STEPS[0]
  const answers = wizard.answers
  const validation = validateConstitutionStep(step.id, answers)
  const ratified = !constitution.empty

  const setAnswer = (id, value) => setWizard(current => ({ ...current, answers: { ...current.answers, [id]: value } }))

  const togglePrinciple = name =>
    setWizard(current => {
      const picked = current.answers.principles || []
      const next = picked.includes(name) ? picked.filter(value => value !== name) : [...picked, name]
      return { ...current, answers: { ...current.answers, principles: next } }
    })

  const go = delta => setWizard(current => ({ ...current, index: Math.max(0, Math.min(CONSTITUTION_STEPS.length - 1, current.index + delta)) }))

  let body
  if (step.kind === 'single') {
    body = jsx('div', {
      className: 'grid grid-cols-2 gap-1.5',
      children: step.options.map(option =>
        Choice({
          keyProp: option,
          active: answers[step.id] === option,
          onClick: () => setAnswer(step.id, option),
          children: option
        })
      )
    })
  } else if (step.kind === 'multi') {
    body = jsxs('div', { className: 'flex flex-col gap-1.5', children: [
      jsx('div', {
        className: 'grid grid-cols-2 gap-1.5',
        children: step.options.map(option =>
          Choice({
            keyProp: option,
            active: (answers.principles || []).includes(option),
            onClick: () => togglePrinciple(option),
            children: option
          })
        )
      }),
      jsx('span', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: `${(answers.principles || []).length} of 3–5 picked` })
    ] })
  } else if (step.kind === 'selects') {
    body = jsx('div', {
      className: 'flex flex-col gap-2',
      children: step.fields.map(field =>
        jsx(
          Field,
          {
            label: field.label,
            children: jsx(Select, {
              value: (answers.architecture || {})[field.id] || '',
              onValueChange: value =>
                setAnswer('architecture', { ...(answers.architecture || {}), [field.id]: value }),
              children: jsxs('span', {
                className: 'flex items-center',
                children: [
                  jsx(SelectTrigger, { className: 'h-7 w-full', children: jsx(SelectValue, { placeholder: 'Choose…' }) }),
                  jsx(SelectContent, {
                    children: field.options.map(option => jsx(SelectItem, { value: option, children: option }, option))
                  })
                ]
              })
            })
          },
          field.id
        )
      )
    })
  } else {
    const parsedGate = constitutionGate(parseSpec('# x\n\n## Functional Requirements\n\n### FR-1: x\n- [ ] a\n'), {
      empty: false,
      answers
    })
    body = jsxs('div', { className: 'flex flex-col gap-2', children: [
      jsx('div', { className: 'rounded border border-(--ui-border) bg-(--ui-bg-tertiary) p-2 text-[0.6875rem] whitespace-pre-wrap font-mono', children: serializeConstitution(answers).slice(0, 900) }),
      jsxs('div', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: [
        'Principles: ',
        jsx('strong', { children: String((answers.principles || []).length) }),
        ' · Purpose: ',
        jsx('strong', { children: answers.purpose || '—' }),
        ' · Gate: ',
        jsx('strong', { children: parsedGate.ok ? 'pass' : parsedGate.issues.join('; ') })
      ] }),
      jsx(Button, {
        variant: 'primary',
        size: 'sm',
        onClick: () => onRatify(answers),
        children: ratified ? 'Re-ratify constitution' : 'Ratify constitution'
      })
    ] })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-3 p-3',
    children: [
      jsxs('div', { className: 'flex items-center justify-between', children: [
        jsx('h3', { className: 'text-xs font-medium', children: `Constitution · ${step.title}` }),
        jsx('span', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: `${wizard.index + 1}/${CONSTITUTION_STEPS.length}` })
      ] }),
      jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: step.prompt }),
      body,
      validation.ok
        ? null
        : jsx('div', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: validation.issues.join(' · ') }),
      jsxs('div', { className: 'flex items-center justify-between pt-1', children: [
        jsx(Button, { size: 'xs', variant: 'ghost', disabled: wizard.index === 0, onClick: () => go(-1), children: 'Previous' }),
        jsx(Button, {
          size: 'xs',
          variant: 'secondary',
          disabled: wizard.index === CONSTITUTION_STEPS.length - 1 || !validation.ok,
          onClick: () => go(1),
          children: 'Next'
        })
      ] }),
      ratified
        ? jsx('div', {
            className: 'text-[0.625rem] text-(--ui-text-tertiary)',
            children: `On disk: version ${constitution.version || '?'} ratified ${constitution.ratified || '?'}`
          })
        : null
    ]
  })
}

// ---------------------------------------------------------------------------
// step 3 — tasks
// ---------------------------------------------------------------------------

function TasksStep({ tasks, spec, links, busy, onEdit, onCreate, onGenerate, onSyncKanban, onPullKanban }) {
  const linkByStory = useMemo(() => {
    const map = new Map()
    for (const link of links || []) {
      map.set(String(link.story), link)
    }
    return map
  }, [links])

  if (tasks.empty) {
    return jsx(EmptyBlock, {
      icon: 'FileText',
      title: 'No tasks.md yet',
      description: 'Generate one task per requirement from the spec, or start from an empty list.',
      actionLabel: 'Create tasks',
      onAction: onCreate
    })
  }

  const done = tasks.tasks.filter(task => task.done).length

  return jsxs('div', {
    className: 'flex flex-col gap-3 p-3',
    children: [
      jsxs('div', { className: 'flex items-center justify-between', children: [
        jsx('h3', { className: 'text-xs font-medium', children: `Tasks (${done}/${tasks.tasks.length} done)` }),
        jsxs('div', { className: 'flex items-center gap-1', children: [
          jsx(Button, { size: 'xs', variant: 'secondary', disabled: busy, onClick: onGenerate, children: 'From spec' }),
          jsx(Button, { size: 'xs', variant: 'secondary', disabled: busy, onClick: onSyncKanban, children: 'To Kanban' }),
          jsx(Button, { size: 'xs', variant: 'ghost', disabled: busy, onClick: onPullKanban, children: 'From Kanban' })
        ] })
      ] }),

      tasks.groups.map((group, groupIndex) =>
        jsxs(
          'div',
          {
            className: 'flex flex-col gap-1.5',
            children: [
              jsxs('div', { className: 'flex items-center gap-1.5', children: [
                jsx('span', { className: 'text-[0.6875rem] font-medium', children: group.heading }),
                group.parallel ? jsx(Badge, { variant: 'outline', className: 'text-[0.625rem]', children: `[P:${group.parallel}]` }) : null
              ] }),
              group.tasks.map((task, taskIndex) => {
                const flatIndex =
                  tasks.groups.slice(0, groupIndex).reduce((sum, item) => sum + item.tasks.length, 0) + taskIndex
                const link = task.story ? linkByStory.get(String(task.story)) : null
                return jsxs(
                  'div',
                  {
                    className: 'flex items-center gap-1.5 rounded border border-(--ui-border) bg-(--ui-bg-tertiary) px-2 py-1',
                    children: [
                      jsx(Checkbox, {
                        checked: task.done,
                        'aria-label': `Task ${taskIndex + 1} done`,
                        onCheckedChange: () => onEdit(model => toggleTask(model, flatIndex))
                      }),
                      jsx('span', {
                        className: cn('text-[0.6875rem] flex-1', task.done && 'line-through text-(--ui-text-tertiary)'),
                        children: task.title
                      }),
                      task.story ? jsx(Badge, { variant: 'outline', className: 'text-[0.625rem]', children: `[US#${task.story}]` }) : null,
                      link
                        ? jsx(Badge, {
                            variant: link.done ? 'success' : 'muted',
                            className: 'text-[0.625rem]',
                            children: link.done ? 'kanban done' : link.status
                          })
                        : null
                    ]
                  },
                  `t-${groupIndex}-${taskIndex}`
                )
              })
            ]
          },
          `g-${groupIndex}`
        )
      ),

      jsx('div', { className: 'flex items-center gap-1.5 pt-1', children: [
        jsx(Input, {
          placeholder: 'New task title, then Enter',
          size: 'sm',
          onKeyDown: event => {
            if (event.key !== 'Enter') {
              return
            }
            const title = String(event.currentTarget.value || '').trim()
            if (!title) {
              return
            }
            event.currentTarget.value = ''
            onEdit(model => addTask(model, { title }))
          }
        }),
        spec.requirements.length
          ? jsx('span', {
              className: 'shrink-0 text-[0.625rem] text-(--ui-text-tertiary)',
              children: `${spec.requirements.length} FR`
            })
          : null
      ] })
    ]
  })
}

// ---------------------------------------------------------------------------
// master pane
// ---------------------------------------------------------------------------

function SpecKitPane() {
  const cwd = useValue(host.state.cwd)
  const [docs, setDocs] = useState(null)
  const [phase, setPhase] = useState('loading')
  const [error, setError] = useState(null)
  const [step, setStep] = useState('spec')
  const [conflict, setConflict] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [links, setLinks] = useState([])
  const [wizard, setWizard] = useState({ index: 0, answers: { principles: [], architecture: {} } })

  const docsRef = useRef(null)
  const timers = useRef({})
  const cwdRef = useRef('')
  const savingRef = useRef(false)

  const applyDocs = useCallback(next => {
    docsRef.current = next
    setDocs(next)
  }, [])

  const clearTimers = useCallback(() => {
    for (const handle of Object.values(timers.current)) {
      if (handle) {
        clearTimeout(handle)
      }
    }
    timers.current = {}
  }, [])

  // ---- load -------------------------------------------------------------
  const generation = useRef(0)

  const load = useCallback(async () => {
    const project = cwdRef.current
    if (!project) {
      setPhase('no-workspace')
      return
    }
    const run = ++generation.current
    setPhase('loading')
    setError(null)
    try {
      const next = await loadDocs(project)
      if (run !== generation.current) {
        return
      }
      applyDocs(next)
      setStep(suggestStep({ spec: next[SPEC_REL].model, constitution: next[CONST_REL].model, tasks: next[TASKS_REL].model }))
      setWizard(current => ({ ...current, answers: next[CONST_REL].model.answers || current.answers }))
      setPhase('ready')
    } catch (loadError) {
      if (run !== generation.current) {
        return
      }
      setError(loadError)
      setPhase('error')
    }
  }, [applyDocs])

  useEffect(() => {
    cwdRef.current = cwd || ''
    generation.current += 1
    if (!cwd) {
      setPhase('no-workspace')
      return
    }
    void load()
  }, [cwd, load])

  useEffect(() => clearTimers, [clearTimers])

  // ---- write ------------------------------------------------------------
  const saveDoc = useCallback(
    async rel => {
      const doc = docsRef.current && docsRef.current[rel]
      if (!doc || !doc.dirty) {
        return
      }
      const content = serializeModel(rel, doc)
      setBusy(true)
      savingRef.current = true
      try {
        const response = await rest('/file', {
          method: 'PUT',
          body: { cwd: cwdRef.current, path: rel, content, base_mtime: doc.mtime }
        })
        const next = { ...docsRef.current }
        next[rel] = { ...next[rel], raw: content, mtime: response.mtime, exists: true, dirty: false }
        applyDocs(next)
        setNotice(`saved ${rel}`)
        setConflict(current => (current && current.rel === rel ? null : current))
      } catch (saveError) {
        const { status, detail } = parseRestError(saveError)
        if (status === 409 && detail && detail.conflict) {
          setConflict({ rel, content: detail.content, mtime: detail.mtime })
        } else {
          const reason = (detail && (detail.reason || detail.message)) || (saveError && saveError.message) || 'save failed'
          setNotice(`save failed: ${reason}`)
          host.notifyError(`Spec Kit: ${reason}`)
        }
      } finally {
        savingRef.current = false
        setBusy(false)
      }
    },
    [applyDocs]
  )

  const touch = useCallback(
    (rel, updater) => {
      const previous = docsRef.current
      if (!previous) {
        return
      }
      const doc = previous[rel]
      const next = { ...previous, [rel]: { ...doc, model: updater(doc.model), dirty: true } }
      applyDocs(next)
      if (rel === CONST_REL) {
        return
      }
      if (timers.current[rel]) {
        clearTimeout(timers.current[rel])
      }
      timers.current[rel] = setTimeout(() => {
        timers.current[rel] = null
        void saveDoc(rel)
      }, DEBOUNCE_MS)
    },
    [applyDocs, saveDoc]
  )

  // ---- poll (file watcher) ---------------------------------------------
  const poll = useCallback(async () => {
    const project = cwdRef.current
    const previous = docsRef.current
    // A write in flight makes the server mtime legitimately newer than our base;
    // polling through it would report a conflict against our own save.
    if (!project || !previous || savingRef.current) {
      return
    }
    let response
    try {
      response = await rest(projectQuery(project))
    } catch {
      return // a dropped poll is not worth a toast; the next tick retries
    }
    const next = { ...previous }
    let changed = false
    for (const rel of ALLOWED_PATHS) {
      const entry = (response.files && response.files[rel]) || { content: '', mtime: null }
      const doc = previous[rel]
      const action = decideSync({ dirty: doc.dirty, base: doc.mtime, remote: entry.mtime })
      if (action === 'reload') {
        next[rel] = { ...doc, raw: entry.content, model: parseModel(rel, entry.content), mtime: entry.mtime, exists: true, dirty: false }
        changed = true
      } else if (action === 'conflict') {
        setConflict({ rel, content: entry.content, mtime: entry.mtime })
      }
    }
    if (changed) {
      applyDocs(next)
      setNotice('reloaded from disk')
    }
  }, [applyDocs])

  useEffect(() => {
    if (phase !== 'ready') {
      return undefined
    }
    const handle = setInterval(() => {
      void poll()
    }, POLL_MS)
    return () => clearInterval(handle)
  }, [phase, poll])

  // ---- actions ----------------------------------------------------------
  const models = useMemo(
    () => ({
      spec: docs ? docs[SPEC_REL].model : parseSpec(''),
      constitution: docs ? docs[CONST_REL].model : parseConstitution(''),
      tasks: docs ? docs[TASKS_REL].model : parseTasks('')
    }),
    [docs]
  )

  const createFile = useCallback(
    rel => {
      const content =
        rel === SPEC_REL
          ? renderSpecTemplate({ feature: baseName(cwdRef.current) })
          : rel === TASKS_REL
            ? renderTasksTemplate({ feature: baseName(cwdRef.current) })
            : serializeConstitution({ principles: [], architecture: {} })
      const previous = docsRef.current
      const next = {
        ...previous,
        [rel]: { rel, raw: content, model: parseModel(rel, content), mtime: null, exists: false, dirty: true }
      }
      applyDocs(next)
      void saveDoc(rel)
    },
    [applyDocs, saveDoc]
  )

  const generateFromSpec = useCallback(() => {
    const proposals = deriveTasksFromSpec({
      ...models.spec,
      linkedTaskStories: (models.tasks.tasks || []).map(task => task.story).filter(Boolean)
    })
    if (!proposals.length) {
      setNotice('every requirement already has a task')
      return
    }
    const base = models.tasks.empty ? parseTasks(renderTasksTemplate({ feature: models.spec.title })) : models.tasks
    const next = proposals.reduce((acc, proposal) => addTask(acc, { title: proposal.title, story: proposal.story }), base)
    touch(TASKS_REL, () => next)
    setNotice(`generated ${proposals.length} task(s) from the spec`)
  }, [models, touch])

  const syncKanban = useCallback(async () => {
    const proposals = deriveTasksFromSpec({
      ...models.spec,
      linkedTaskStories: (models.tasks.tasks || []).map(task => task.story).filter(Boolean)
    })
    setBusy(true)
    try {
      const response = await rest('/kanban/sync', {
        method: 'POST',
        body: {
          cwd: cwdRef.current,
          tasks: proposals.map(proposal => ({ title: proposal.title, body: proposal.body, story: proposal.story }))
        }
      })
      setNotice(`kanban: ${response.created.length} created, ${response.skipped.length} already linked`)
      const refreshed = await rest(`/kanban/links?cwd=${encodeURIComponent(cwdRef.current)}`)
      setLinks(refreshed.links || [])
    } catch (syncError) {
      const { detail } = parseRestError(syncError)
      setNotice(`kanban sync failed: ${(detail && (detail.reason || detail.message)) || 'backend unavailable'}`)
    } finally {
      setBusy(false)
    }
  }, [models])

  const pullKanban = useCallback(async () => {
    setBusy(true)
    try {
      const response = await rest(`/kanban/links?cwd=${encodeURIComponent(cwdRef.current)}`)
      const rows = response.links || []
      setLinks(rows)
      const byStory = new Map(rows.map(row => [String(row.story), row.done]))

      let mergedTasks = models.tasks
      let tasksChanged = false
      for (const task of models.tasks.tasks) {
        if (!task.story || !byStory.has(String(task.story))) {
          continue
        }
        if (Boolean(task.done) !== Boolean(byStory.get(String(task.story)))) {
          const index = models.tasks.tasks.indexOf(task)
          mergedTasks = toggleTask(mergedTasks, index)
          tasksChanged = true
        }
      }
      if (tasksChanged) {
        touch(TASKS_REL, () => mergedTasks)
      }

      const acceptance = applyAcceptanceFromTasks(models.spec, mergedTasks)
      if (acceptance.changed) {
        touch(SPEC_REL, () => acceptance.spec)
        setNotice('kanban status pulled — acceptance criteria updated')
      } else if (tasksChanged) {
        setNotice('kanban status pulled')
      } else {
        setNotice(`kanban status pulled (${rows.length} linked card(s))`)
      }
    } catch (pullError) {
      const { detail } = parseRestError(pullError)
      setNotice(`kanban read failed: ${(detail && (detail.reason || detail.message)) || 'backend unavailable'}`)
    } finally {
      setBusy(false)
    }
  }, [models, touch])

  const ratify = useCallback(
    answers => {
      const content = serializeConstitution(answers, { date: today() })
      const previous = docsRef.current
      const next = {
        ...previous,
        [CONST_REL]: { rel: CONST_REL, raw: content, model: parseConstitution(content), mtime: previous[CONST_REL].mtime, exists: true, dirty: true }
      }
      applyDocs(next)
      void saveDoc(CONST_REL)
      setNotice('constitution ratified')
    },
    [applyDocs, saveDoc]
  )

  const resolveConflict = useCallback(
    choice => {
      if (!conflict) {
        return
      }
      const { rel, content, mtime } = conflict
      setConflict(null)
      const previous = docsRef.current
      if (choice === 'theirs') {
        const next = { ...previous, [rel]: { ...previous[rel], raw: content, model: parseModel(rel, content), mtime, exists: true, dirty: false } }
        applyDocs(next)
        setNotice('took the version on disk')
        return
      }
      const next = { ...previous, [rel]: { ...previous[rel], mtime, dirty: true } }
      applyDocs(next)
      void saveDoc(rel)
    },
    [applyDocs, conflict, saveDoc]
  )

  // ---- render -----------------------------------------------------------
  if (phase === 'no-workspace') {
    return jsx(EmptyBlock, {
      icon: 'FolderOpen',
      title: 'No workspace open',
      description: 'Open a project folder in Hermes Desktop; Spec Kit writes to its .specify/ directory.'
    })
  }

  if (phase === 'loading') {
    return jsx(Spinner, { label: 'Reading .specify/…' })
  }

  if (phase === 'error') {
    const message = error && error.message ? error.message : String(error)
    return jsx(ErrorState, {
      title: 'Spec Kit backend unavailable',
      description: [
        message,
        '',
        'The pane needs the plugin backend at /api/plugins/spec-kit-hermes.',
        'Install it with `node scripts/install.mjs` and enable spec-kit-hermes in this profile.'
      ].join('\n'),
      children: jsx('div', {
        className: 'flex justify-center',
        children: jsx(Button, { variant: 'secondary', size: 'sm', onClick: () => load(), children: 'Retry' })
      })
    })
  }

  const states = stepStates(step, models)
  const index = stepIndex(step)
  const dirty = ALLOWED_PATHS.some(rel => docs[rel].dirty)
  const statusText = busy
    ? 'saving…'
    : conflict
      ? 'conflict — pick a side'
      : dirty
        ? 'unsaved'
        : notice || (docs.project ? shortPath(docs.project) : 'saved')

  return jsxs('div', {
    className: 'flex h-full flex-col overflow-hidden',
    'data-pane-id': PANE_ID,
    children: [
      jsxs('div', { className: 'flex items-center justify-between px-3 py-2 border-b border-(--ui-border)', children: [
        jsx('div', { className: 'flex items-center gap-1.5 min-w-0', children: [
          jsx(icons.Book, { className: 'size-3.5 shrink-0' }),
          jsx('span', { className: 'text-xs font-medium shrink-0', children: 'Spec Kit' }),
          jsx('span', { className: 'text-[0.625rem] text-(--ui-text-tertiary) truncate', title: cwd, children: cwd })
        ] }),
        jsx(Button, {
          size: 'xs',
          variant: 'ghost',
          disabled: busy || !dirty,
          onClick: () => {
            for (const rel of ALLOWED_PATHS) {
              void saveDoc(rel)
            }
          },
          children: 'Save'
        })
      ] }),

      jsx(Stepper, { step, states, onPick: setStep }),

      conflict
        ? jsxs('div', {
            className: 'flex flex-col gap-1 px-3 py-2 border-b border-(--ui-border) bg-(--ui-bg-tertiary)',
            children: [
              jsx('div', {
                className: 'text-[0.6875rem] font-medium',
                children: `${conflict.rel} changed on disk while you were editing`
              }),
              jsxs('div', { className: 'flex items-center gap-1', children: [
                jsx(Button, { size: 'xs', variant: 'secondary', onClick: () => resolveConflict('mine'), children: 'Keep mine' }),
                jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => resolveConflict('theirs'), children: 'Take theirs' })
              ] })
            ]
          })
        : null,

      jsx(ScrollArea, {
        className: 'flex-1 min-h-0',
        children:
          step === 'spec'
            ? jsx(SpecStep, {
                spec: models.spec,
                constitution: models.constitution,
                onEdit: updater => touch(SPEC_REL, updater),
                onCreate: () => createFile(SPEC_REL)
              })
            : step === 'constitution'
              ? jsx(ConstitutionStep, {
                  constitution: models.constitution,
                  wizard,
                  setWizard,
                  onRatify: ratify
                })
              : jsx(TasksStep, {
                  tasks: models.tasks,
                  spec: models.spec,
                  links,
                  busy,
                  onEdit: updater => touch(TASKS_REL, updater),
                  onCreate: () => createFile(TASKS_REL),
                  onGenerate: generateFromSpec,
                  onSyncKanban: syncKanban,
                  onPullKanban: pullKanban
                })
      }),

      jsxs('div', { className: 'flex items-center justify-between gap-2 px-3 py-2 border-t border-(--ui-border)', children: [
        jsx(Button, {
          size: 'xs',
          variant: 'ghost',
          disabled: index === 0,
          onClick: () => setStep(stepAt(index - 1).id),
          children: 'Back'
        }),
        jsx('span', { className: 'text-[0.625rem] text-(--ui-text-tertiary) truncate', children: statusText }),
        jsx(Button, {
          size: 'xs',
          variant: 'secondary',
          disabled: index === STEPS.length - 1,
          onClick: () => setStep(stepAt(index + 1).id),
          children: 'Next'
        })
      ] })
    ]
  })
}

function baseName(path) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : 'Untitled Feature'
}

function shortPath(path) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : String(path || '')
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
  description: 'Spec → Constitution → Tasks wizard writing .specify/ and syncing tasks to Kanban',
  defaultEnabled: true,
  register(ctx) {
    ctxRef = ctx
    // ONE pane — v1 registered three, v2 is a single wizard.
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

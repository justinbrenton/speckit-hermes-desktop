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

export const FILE_PATHS = Object.freeze({
  spec: 'spec.md',
  constitution: 'memory/constitution.md',
  tasks: 'tasks.md'
})

/** Relative paths the backend will read and write. Mirrors backend/plugin_api.py. */
export const ALLOWED_PATHS = Object.freeze([FILE_PATHS.spec, FILE_PATHS.constitution, FILE_PATHS.tasks])

export function today(now = new Date()) {
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

export function renderSpecTemplate({ feature = 'Untitled Feature', date = today() } = {}) {
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

export function parseSpec(text) {
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

export function serializeSpec(model, source = '') {
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

export function renderTasksTemplate({ feature = 'Untitled Feature' } = {}) {
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

export function parseTasks(text) {
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

export function serializeTasks(model, source = '') {
  let out = source
  if (!out.trim()) {
    out = renderTasksTemplate({ feature: model.title || 'Untitled Feature' })
  }
  const body = renderGroups(model.groups || [{ heading: 'Sequential', tasks: model.tasks || [] }])
  const rendered = replaceSection(out, sameTitle('Tasks'), body || '_No tasks yet._')
  return rendered === null ? out : rendered
}

export function toggleTask(model, index) {
  const groups = model.groups.map(g => ({ ...g, tasks: g.tasks.map(t => ({ ...t })) }))
  const flat = groups.flatMap(g => g.tasks)
  if (index < 0 || index >= flat.length) {
    return model
  }
  flat[index].done = !flat[index].done
  return { ...model, groups, tasks: flat }
}

export function addTask(model, task, { group = 'Sequential' } = {}) {
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

export const CONSTITUTION_STEPS = Object.freeze([
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
export function validateConstitutionStep(stepId, answers) {
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

export function constitutionProgress(answers) {
  return CONSTITUTION_STEPS.filter(step => validateConstitutionStep(step.id, answers).ok).length
}

export function serializeConstitution(answers = {}, { date = today(), version = '1.0' } = {}) {
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

export function parseConstitution(text) {
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
export function constitutionGate(spec, constitution) {
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
export function deriveTasksFromSpec(spec) {
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
export function applyAcceptanceFromTasks(spec, taskModel) {
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
export function decideSync({ dirty, base, remote }) {
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
export function parseRestError(error) {
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
export function createDebouncer(fn, ms) {
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

export const STEPS = Object.freeze([
  { id: 'spec', label: 'Spec' },
  { id: 'constitution', label: 'Constitution' },
  { id: 'tasks', label: 'Tasks' }
])

export function stepIndex(id) {
  const i = STEPS.findIndex(s => s.id === id)
  return i < 0 ? 0 : i
}

export function stepAt(index) {
  return STEPS[Math.max(0, Math.min(STEPS.length - 1, index))]
}

/** What the stepper draws for one step: done / current / todo. */
export function stepStates(activeId, { spec, constitution, tasks }) {
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
export function suggestStep({ spec, constitution, tasks }) {
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

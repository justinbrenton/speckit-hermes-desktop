import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ALLOWED_PATHS,
  CONSTITUTION_STEPS,
  FILE_PATHS,
  STEPS,
  STEP_TITLES,
  addTask,
  applyAcceptanceFromTasks,
  artifactForGate,
  constitutionGate,
  createDebouncer,
  decideSync,
  deriveTasksFromSpec,
  dispatchMessage,
  flowSteps,
  parseConstitution,
  parseRestError,
  parseSpec,
  parseTasks,
  progressFor,
  serializeConstitution,
  serializeSpec,
  serializeTasks,
  stepAt,
  stepIndex,
  stepStates,
  suggestStep,
  toggleTask,
  validateConstitutionStep,
  visibleInputs
} from '../src/core.mjs'

const SPEC = `# Feature Specification: Login

> **Status**: Draft
> **Created**: 2026-10-24
> **Constitution**: \`.specify/memory/constitution.md\`

## Functional Requirements

### FR-1: Email login
**Description**: Users sign in with email and password.
**Priority**: High
**Acceptance Criteria**:
- [ ] Wrong password shows an error
- [x] Successful login sets a session cookie

### FR-2: Logout
**Description**: Users can end their session.
**Priority**: Medium
**Acceptance Criteria**:
- [ ] Session cookie is cleared

---

## Clarifications

> **[NEEDS CLARIFICATION]**: Which password hashing algorithm?

---

## Custom Notes

Hand-written prose that the parser must not touch.
`

const TASKS = `# Task List: Login

> **Status**: Draft

## Tasks

### Parallel Group A [P:frontend]
- [ ] **T-1**: Build login form [US#FR-1]
- [x] **T-2**: Build logout button [US#FR-2]

### Sequential
- [ ] **T-3**: Wire session middleware

## Dependencies

\`\`\`mermaid
graph TD
    T-1 --> T-3
\`\`\`
`

// --- spec ------------------------------------------------------------------

test('parseSpec extracts requirements, acceptance state and clarifications', () => {
  const model = parseSpec(SPEC)
  assert.equal(model.title, 'Login')
  assert.equal(model.constitutionRef, '.specify/memory/constitution.md')
  assert.deepEqual(
    model.requirements.map(r => [r.id, r.title, r.priority]),
    [
      ['FR-1', 'Email login', 'High'],
      ['FR-2', 'Logout', 'Medium']
    ]
  )
  assert.deepEqual(model.requirements[0].acceptance, [
    { text: 'Wrong password shows an error', done: false },
    { text: 'Successful login sets a session cookie', done: true }
  ])
  assert.deepEqual(model.clarifications, ['Which password hashing algorithm?'])
})

test('parseSpec survives a malformed document', () => {
  assert.deepEqual(parseSpec('').requirements, [])
  assert.deepEqual(parseSpec('garbage without sections').requirements, [])
  assert.deepEqual(parseSpec(null).clarifications, [])
})

test('serializeSpec writes edits and preserves the sections it does not own', () => {
  const model = parseSpec(SPEC)
  model.requirements[1].title = 'Logout everywhere'
  model.requirements[0].acceptance[0].done = true
  model.clarifications.push('Which session store?')

  const out = serializeSpec(model, SPEC)

  assert.match(out, /### FR-2: Logout everywhere/)
  assert.match(out, /- \[x\] Wrong password shows an error/)
  assert.match(out, /> \*\*\[NEEDS CLARIFICATION\]\*\*: Which password hashing algorithm\?/)
  assert.match(out, /> \*\*\[NEEDS CLARIFICATION\]\*\*: Which session store\?/)
  assert.match(out, /## Custom Notes\n\nHand-written prose that the parser must not touch\./)
  // Re-parsing the serialized text must give the same model back.
  const again = parseSpec(out)
  assert.equal(again.requirements[1].title, 'Logout everywhere')
  assert.equal(again.clarifications.length, 2)
})

test('serializeSpec seeds a template when the file is absent', () => {
  const out = serializeSpec({ title: 'Billing', requirements: [] }, '')
  assert.match(out, /^# Feature Specification: Billing/)
  assert.match(out, /## Functional Requirements/)
})

// --- tasks -----------------------------------------------------------------

test('parseTasks reads groups, parallel tags, checkbox state and stories', () => {
  const model = parseTasks(TASKS)
  assert.equal(model.groups.length, 2)
  assert.equal(model.groups[0].heading, 'Parallel Group A')
  assert.equal(model.groups[0].parallel, 'frontend')
  assert.deepEqual(model.tasks.map(t => [t.title, t.story, t.done]), [
    ['Build login form', 'FR-1', false],
    ['Build logout button', 'FR-2', true],
    ['Wire session middleware', '', false]
  ])
})

test('serializeTasks writes toggles and preserves unrelated sections', () => {
  const model = toggleTask(parseTasks(TASKS), 0)
  const out = serializeTasks(model, TASKS)

  assert.match(out, /- \[x\] \*\*T-1\*\*: Build login form \[US#FR-1\]/)
  assert.match(out, /### Parallel Group A \[P:frontend\]/)
  assert.match(out, /## Dependencies/)
  assert.match(out, /graph TD/)
})

test('addTask appends into an existing or new group', () => {
  const base = parseTasks(TASKS)
  const sequential = addTask(base, { title: 'Smoke test', story: 'FR-1' })
  assert.equal(sequential.tasks.length, 4)
  const backend = addTask(base, { title: 'Session store' }, { group: 'Parallel Group B' })
  assert.equal(backend.groups.length, 3)
  assert.match(serializeTasks(backend, TASKS), /### Parallel Group B/)
})

test('toggleTask ignores an out-of-range index', () => {
  const model = parseTasks(TASKS)
  assert.deepEqual(toggleTask(model, 99), model)
})

// --- constitution ----------------------------------------------------------

test('constitution wizard validates each step kind', () => {
  assert.equal(validateConstitutionStep('purpose', {}).ok, false)
  assert.equal(validateConstitutionStep('purpose', { purpose: 'CLI Tool' }).ok, true)

  const tooFew = validateConstitutionStep('principles', { principles: ['Simplicity first'] })
  assert.equal(tooFew.ok, false)
  assert.match(tooFew.issues[0], /at least 3/)

  const tooMany = validateConstitutionStep('principles', {
    principles: ['a', 'b', 'c', 'd', 'e', 'f']
  })
  assert.equal(tooMany.ok, false)

  const arch = validateConstitutionStep('architecture', { architecture: { language: 'TypeScript' } })
  assert.equal(arch.ok, false)
  assert.ok(arch.issues.length >= 4)

  assert.equal(validateConstitutionStep('nope', {}).ok, false)
})

test('constitution round-trips through markdown', () => {
  const answers = {
    purpose: 'API Service',
    principles: ['Test before code', 'Small reviewable diffs', 'Delete dead code'],
    architecture: { language: 'Python', framework: 'FastAPI', storage: 'SQLite', testing: 'TDD', delivery: 'Docker' },
    governance: 'Peer review required'
  }
  const text = serializeConstitution(answers, { date: '2026-10-24' })
  assert.match(text, /> \*\*Version\*\*: 1\.0/)
  assert.match(text, /\| Language \| Python \|/)

  const parsed = parseConstitution(text)
  assert.equal(parsed.empty, false)
  assert.equal(parsed.answers.purpose, 'API Service')
  assert.deepEqual(parsed.answers.principles, answers.principles)
  assert.equal(parsed.answers.architecture.language, 'Python')
  assert.equal(parsed.answers.architecture.delivery, 'Docker')
  assert.equal(parsed.answers.governance, 'Peer review required')
})

test('constitution gate blocks an unratified project', () => {
  const spec = parseSpec(SPEC)
  const empty = parseConstitution('')
  const blocked = constitutionGate(spec, empty)
  assert.equal(blocked.ok, false)
  assert.ok(blocked.issues.some(i => /constitution.md is missing/.test(i)))

  const thin = parseConstitution(serializeConstitution({ purpose: 'x', principles: ['a', 'b'] }))
  assert.equal(constitutionGate(spec, thin).ok, false)

  const ok = parseConstitution(
    serializeConstitution({ purpose: 'x', principles: ['a', 'b', 'c'], governance: 'solo' })
  )
  assert.deepEqual(constitutionGate(spec, ok), { ok: true, issues: [] })
})

test('clarification budget is part of the gate', () => {
  const spec = parseSpec(SPEC)
  spec.clarifications = ['a', 'b', 'c', 'd']
  const constitution = parseConstitution(
    serializeConstitution({ purpose: 'x', principles: ['a', 'b', 'c'], governance: 'solo' })
  )
  const gate = constitutionGate(spec, constitution)
  assert.equal(gate.ok, false)
  assert.ok(gate.issues.some(i => /max 3/.test(i)))
})

// --- cross-step flow -------------------------------------------------------

test('deriveTasksFromSpec proposes one card per unlinked requirement', () => {
  const spec = parseSpec(SPEC)
  const proposals = deriveTasksFromSpec(spec)
  assert.deepEqual(proposals.map(p => p.story), ['FR-1', 'FR-2'])
  assert.match(proposals[0].title, /^Implement FR-1: Email login$/)
  assert.match(proposals[0].body, /Wrong password shows an error/)

  spec.linkedTaskStories = ['FR-1']
  assert.deepEqual(deriveTasksFromSpec(spec).map(p => p.story), ['FR-2'])
})

test('applyAcceptanceFromTasks ticks criteria only when every task is done', () => {
  const spec = parseSpec(SPEC)
  const open = parseTasks(TASKS)
  // FR-1's only task is still open; FR-2's only task is already done.
  const partial = applyAcceptanceFromTasks(spec, open)
  assert.equal(partial.changed, true)
  assert.deepEqual(partial.spec.requirements[0].acceptance.map(a => a.done), [false, true])
  assert.deepEqual(partial.spec.requirements[1].acceptance.map(a => a.done), [true])

  const allDone = parseTasks(TASKS)
  allDone.tasks[0].done = true
  const result = applyAcceptanceFromTasks(spec, allDone)
  assert.equal(result.changed, true)
  assert.deepEqual(result.spec.requirements[0].acceptance.map(a => a.done), [true, true])
  assert.deepEqual(result.spec.requirements[1].acceptance.map(a => a.done), [true])
  // Idempotent: nothing left to tick once everything is done.
  assert.equal(applyAcceptanceFromTasks(result.spec, allDone).changed, false)
})

test('applyAcceptanceFromTasks leaves requirements with open tasks alone', () => {
  const spec = parseSpec(SPEC)
  const open = parseTasks(TASKS)
  const fr1 = applyAcceptanceFromTasks(spec, open).spec.requirements[0]
  assert.deepEqual(fr1.acceptance.map(a => a.done), [false, true])
})

// --- sync state ------------------------------------------------------------

test('decideSync covers the four round-trip cases', () => {
  assert.equal(decideSync({ dirty: false, base: 1, remote: 1 }), 'idle')
  assert.equal(decideSync({ dirty: true, base: 1, remote: 1 }), 'write')
  assert.equal(decideSync({ dirty: false, base: 1, remote: 2 }), 'reload')
  assert.equal(decideSync({ dirty: true, base: 1, remote: 2 }), 'conflict')
})

test('parseRestError reads the bridge error format', () => {
  const conflict = parseRestError(
    new Error('409: {"detail":{"conflict":true,"path":"spec.md","content":"theirs","mtime":12}}')
  )
  assert.equal(conflict.status, 409)
  assert.equal(conflict.detail.conflict, true)
  assert.equal(conflict.detail.content, 'theirs')

  const plain = parseRestError(new Error('400: {"detail":"cwd must be absolute"}'))
  assert.equal(plain.status, 400)
  assert.equal(plain.detail, 'cwd must be absolute')
  assert.equal(plain.message, 'cwd must be absolute')

  const network = parseRestError(new Error('Failed to fetch'))
  assert.deepEqual(network, { status: 0, detail: null, message: 'Failed to fetch' })

  const notJson = parseRestError('503: backend unavailable')
  assert.equal(notJson.status, 503)
  assert.equal(notJson.detail, 'backend unavailable')
})

test('createDebouncer coalesces calls and can be flushed', async () => {
  const calls = []
  const debounced = createDebouncer(value => calls.push(value), 10)
  debounced.schedule(1)
  debounced.schedule(2)
  assert.equal(debounced.pending, true)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(calls, [2])
  assert.equal(debounced.pending, false)

  debounced.schedule(3)
  debounced.flush()
  assert.deepEqual(calls, [2, 3])

  debounced.schedule(4)
  debounced.cancel()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.deepEqual(calls, [2, 3])
})

// --- stepper ---------------------------------------------------------------

test('stepStates marks readiness and the active step', () => {
  const states = stepStates('constitution', {
    spec: parseSpec(SPEC),
    constitution: parseConstitution(''),
    tasks: parseTasks('')
  })
  assert.deepEqual(states.map(s => s.current), [false, true, false])
  assert.equal(states[0].ready, true)
  assert.equal(states[1].ready, false)
  assert.equal(states[2].ready, false)
})

test('suggestStep resumes at the furthest step with content', () => {
  assert.equal(suggestStep({ spec: parseSpec(''), constitution: parseConstitution(''), tasks: parseTasks('') }), 'spec')
  assert.equal(
    suggestStep({ spec: parseSpec(SPEC), constitution: parseConstitution(''), tasks: parseTasks('') }),
    'constitution'
  )
  assert.equal(
    suggestStep({ spec: parseSpec(SPEC), constitution: parseConstitution(''), tasks: parseTasks(TASKS) }),
    'tasks'
  )
})

test('step helpers clamp out-of-range indexes', () => {
  assert.equal(stepIndex('tasks'), 2)
  assert.equal(stepIndex('nonsense'), 0)
  assert.equal(stepAt(-1).id, 'spec')
  assert.equal(stepAt(99).id, STEPS[STEPS.length - 1].id)
})

// --- constants -------------------------------------------------------------

test('paths match the backend allowlist', () => {
  assert.deepEqual([...ALLOWED_PATHS], ['spec.md', 'memory/constitution.md', 'tasks.md'])
  assert.equal(FILE_PATHS.constitution, 'memory/constitution.md')
  assert.equal(CONSTITUTION_STEPS.length, 5)
  assert.equal(CONSTITUTION_STEPS.at(-1).id, 'ratify')
})

// --- dispatch --------------------------------------------------------------

const PROJECT = 'C:/work/calendar'
const DISPATCH_SPEC = parseSpec(`# Feature Specification: Calendar

## Functional Requirements

### FR-1: Create an event

An event has a title, a start and an end.

**Acceptance criteria**
- [ ] saving an event stores every field
- [ ] an end before the start is rejected

## Clarifications

> _No open clarifications._
`)
const DISPATCH_TASKS = parseTasks(`# Task List: Calendar

## Tasks

### Sequential

- [ ] **T-1**: wire the event form
- [x] **T-2**: add the storage schema [US#FR-1]
- [ ] **T-3**: validate the date range [US#FR-1]
`)

test('dispatch refuses an unknown action', () => {
  assert.throws(() => dispatchMessage('deploy', { project: PROJECT }), /unknown dispatch action/)
})

test('dispatch refuses a missing project root', () => {
  assert.throws(() => dispatchMessage('plan', { spec: DISPATCH_SPEC }), /project root is required/)
})

test('plan dispatch needs a ratified constitution and a requirement', () => {
  assert.throws(
    () => dispatchMessage('plan', { project: PROJECT, spec: parseSpec(''), constitution: parseConstitution('') }),
    /constitution is not ratified/,
  )
  const ratified = { empty: false, answers: { principles: ['one', 'two', 'three'] } }
  assert.throws(
    () => dispatchMessage('plan', { project: PROJECT, spec: parseSpec(''), constitution: ratified }),
    /no requirements/,
  )
})

test('plan dispatch names the files the agent has to read', () => {
  const ratified = { empty: false, answers: { principles: ['one', 'two', 'three'] } }
  const { action, title, prompt, files } = dispatchMessage('plan', {
    project: PROJECT,
    spec: DISPATCH_SPEC,
    constitution: ratified,
  })
  assert.equal(action, 'plan')
  assert.equal(title, 'Plan: Calendar')
  assert.match(prompt, /C:\/work\/calendar/)
  assert.match(prompt, /\.specify\/spec\.md/)
  assert.match(prompt, /\.specify\/memory\/constitution\.md/)
  assert.match(prompt, /plan\.md/)
  assert.match(prompt, /1 requirement\b/)
  assert.equal(files.spec, 'C:/work/calendar/.specify/spec.md')
})

test('implement dispatch picks the first open task and asks for it to be ticked', () => {
  const { action, title, prompt } = dispatchMessage('implement', { project: PROJECT, spec: DISPATCH_SPEC, tasks: DISPATCH_TASKS })
  assert.equal(action, 'implement')
  assert.match(title, /T-1/)
  assert.match(prompt, /wire the event form/)
  assert.doesNotMatch(prompt, /validate the date range/, 'only one task per dispatch')
  assert.match(prompt, /\[x\]/)
})

test('implement dispatch refuses when nothing is open', () => {
  const done = parseTasks('# Task List: X\n\n## Tasks\n\n### Sequential\n\n- [x] **T-1**: shipped\n')
  assert.throws(
    () => dispatchMessage('implement', { project: PROJECT, tasks: done }),
    /no open tasks/,
  )
})

test('dispatch output is deterministic', () => {
  const a = dispatchMessage('implement', { project: PROJECT, spec: DISPATCH_SPEC, tasks: DISPATCH_TASKS })
  const b = dispatchMessage('implement', { project: PROJECT, spec: DISPATCH_SPEC, tasks: DISPATCH_TASKS })
  assert.equal(a.prompt, b.prompt)
})


// ---------------------------------------------------------------------------
// wizard model
// ---------------------------------------------------------------------------

test('visibleInputs hides gate verdicts and project setup', () => {
  const inputs = [
    { name: 'principles', prompt: 'Constitution' },
    { name: 'spec', prompt: 'Describe', required: true },
    { name: 'gate_review_spec' },
    { name: 'gate_review_plan' },
    { name: 'integration', default: 'auto' }
  ]
  assert.deepEqual(visibleInputs(inputs).map(i => i.name), ['principles', 'spec'])
})

test('flowSteps drops gates but keeps order', () => {
  const steps = [
    { id: 'constitution', type: 'command' },
    { id: 'review-constitution', type: 'gate' },
    { id: 'specify', type: 'command' },
    { id: 'review-spec', type: 'gate' }
  ]
  assert.deepEqual(flowSteps(steps).map(s => s.id), ['constitution', 'specify'])
})

test('progressFor counts the work, not the gates', () => {
  const steps = [
    { id: 'constitution' }, { id: 'review-constitution', type: 'gate' },
    { id: 'specify' }, { id: 'review-spec', type: 'gate' },
    { id: 'plan' }
  ]
  // a paused gate points at the step it reviews
  const atGate = progressFor(steps, { status: 'paused', current_step_id: 'review-spec' })
  assert.equal(atGate.total, 3)
  assert.equal(atGate.index, 2)
  assert.equal(atGate.title, 'Describe what to build')

  const done = progressFor(steps, { status: 'completed', current_step_id: 'plan' })
  assert.equal(done.index, 3)
  assert.equal(done.percent, 100)

  assert.equal(progressFor([], null).total, 0)
})

test('progressFor survives an unknown step id', () => {
  const progress = progressFor([{ id: 'specify' }], { status: 'running', current_step_id: 'mystery' })
  assert.equal(progress.index, 1)
  assert.equal(progress.title, 'Describe what to build')
})

test('artifactForGate finds the file a gate reviews', () => {
  const artifacts = [
    { name: 'spec.md', path: 'specs/001-x/spec.md' },
    { name: 'plan.md', path: 'specs/001-x/plan.md' },
    { name: 'assessment.md', path: '.specify/bugs/login-crash/assessment.md' }
  ]
  assert.equal(artifactForGate(artifacts, 'review-spec').name, 'spec.md')
  assert.equal(artifactForGate(artifacts, 'review-plan').name, 'plan.md')
  assert.equal(artifactForGate(artifacts, 'review-assessment').name, 'assessment.md')
  assert.equal(artifactForGate(artifacts, 'review-unknown'), null)
  assert.equal(artifactForGate([], 'review-spec'), null)
})

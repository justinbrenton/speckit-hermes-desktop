import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  STEP_TITLES,
  artifactForGate,
  fieldLabel,
  flowSteps,
  progressFor,
  visibleInputs
} from '../src/core.mjs'

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

test('visibleInputs tolerates junk', () => {
  assert.deepEqual(visibleInputs(), [])
  assert.deepEqual(visibleInputs([null, {}, { name: '' }]), [])
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

test('every step id in a full path has a human title', () => {
  const full = ['constitution', 'specify', 'clarify', 'plan', 'checklist', 'tasks', 'analyze', 'implement', 'converge']
  for (const id of full) {
    assert.ok(STEP_TITLES[id], `missing title for ${id}`)
  }
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
  assert.equal(artifactForGate(artifacts, ''), null)
})

test('the assessment gate opens decision.md, not verdict.md', () => {
  const artifacts = [
    { name: 'intake.md', path: '.specify/assessments/x/intake.md' },
    { name: 'decision.md', path: '.specify/assessments/x/decision.md' }
  ]
  const found = artifactForGate(artifacts, 'review-verdict')
  assert.equal(found && found.name, 'decision.md')
})

test('a field label says optional once, whatever the prompt says', () => {
  assert.equal(fieldLabel({ name: 'focus', prompt: 'Clarify: focus area (optional)' }), 'Clarify: focus area (optional)')
  assert.equal(fieldLabel({ name: 'focus', prompt: 'Clarify: focus area' }), 'Clarify: focus area (optional)')
  assert.equal(fieldLabel({ name: 'spec', prompt: 'Describe what you want to build', required: true }), 'Describe what you want to build')
  assert.equal(fieldLabel({ name: 'stack' }), 'stack (optional)')
  assert.equal(fieldLabel(null), '')
})


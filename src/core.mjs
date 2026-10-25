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
export const STEP_TITLES = Object.freeze({
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
export function visibleInputs(inputs = []) {
  return (inputs || []).filter(
    input => input && input.name && !/^gate_/.test(input.name) && input.name !== 'integration'
  )
}

/** Steps a person progresses through: gates are checkpoints, not work items. */
export function flowSteps(steps = []) {
  return (steps || []).filter(step => step && step.type !== 'gate')
}

/**
 * Where the run is, in the flow, for the progress header.
 *
 * Gates sit directly after the step they review, so a gate's position is the last
 * command step before it. Matching gate ids by name is wrong in practice:
 * `specify`'s gate is `review-spec`, not `review-specify`.
 */
export function progressFor(steps = [], run = null) {
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
export function artifactForGate(artifacts = [], gateStepId = '') {
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

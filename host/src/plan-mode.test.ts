import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Settings, type AgentSession } from '@oh-my-pi/pi-coding-agent'

import { enterPlanMode, exitPlanMode, planModeEnabled, reviewPlan, restorePlanMode } from './plan-mode.ts'
import type { UiBridge } from './ui.ts'

/**
 * Plan mode against a session that records what it was asked to do.
 *
 * The engine owns the plan state, the proposal dispatch and the plan-file rules; what this host is
 * responsible for is the order (state, handler, journal), the approval dialog's two answers, and
 * the fact that an approval leaves the mode while a rejection keeps it.
 */

interface ModeEntry {
  type: 'mode_change'
  mode: string
  data?: Record<string, unknown>
}

function harness(
  options: {
    answer?: string
    goal?: boolean
    plan?: boolean
    journal?: string
    messages?: string[]
    settings?: Record<string, unknown>
  } = {},
) {
  const calls: string[] = []
  const entries: ModeEntry[] = []
  let state: { enabled: boolean; planFilePath: string } | undefined
  let handler: ((title: string) => Promise<unknown>) | null = null
  let reference: string | undefined
  const artifactDir = options.plan === true ? path.join(tmpdir(), 'omp-plan-fixture') : undefined
  const session = {
    isStreaming: false,
    messages: (options.messages ?? []).map((id) => ({ id })),
    settings: Settings.isolated({ 'plan.enabled': true, ...options.settings }),
    getGoalModeState: () => (options.goal === true ? { enabled: true } : undefined),
    getVibeModeState: () => undefined,
    getPlanModeState: () => state,
    setPlanModeState: (next: { enabled: boolean; planFilePath: string } | undefined) => {
      state = next
      calls.push(`state:${next === undefined ? 'none' : 'plan'}`)
    },
    setPlanProposalHandler: (next: typeof handler) => {
      handler = next
      calls.push(next === null ? 'handler:none' : 'handler:set')
    },
    setPlanReferencePath: (value: string) => {
      reference = value
      calls.push(`reference:${value}`)
    },
    sendPlanModeContext: async () => {
      calls.push('steer')
    },
    getEnabledToolNames: () => ['read', 'write', 'bash'],
    sessionManager: {
      getCwd: () => artifactDir ?? tmpdir(),
      getSessionId: () => 's01plan',
      getArtifactsDir: () => artifactDir ?? null,
      getBranch: () => entries,
      appendModeChange: (mode: string, data?: Record<string, unknown>) => {
        entries.push({ type: 'mode_change', mode, data })
        calls.push(`mode:${mode}`)
      },
    },
  }
  const ui = {
    context: () => ({
      select: async () => options.answer,
      confirm: async () => true,
    }),
  } as unknown as UiBridge
  return {
    session: session as unknown as AgentSession,
    ui,
    calls,
    entries,
    state: () => state,
    handler: () => handler,
    reference: () => reference,
  }
}

test('entering plan mode records the state, installs the proposal handler and journals the mode', async () => {
  const { session, ui, calls, entries, state, handler } = harness()
  const output: string[] = []
  assert.equal(await enterPlanMode(session, ui, (line) => output.push(line)), true)
  assert.equal(planModeEnabled(session), true)
  assert.deepEqual(calls, ['state:plan', 'handler:set', 'mode:plan'])
  assert.equal(state()?.planFilePath, 'local://PLAN.md')
  assert.ok(handler() !== null)
  assert.match(entries.at(-1)?.mode ?? '', /^plan$/)
  // No banner: the plan chip and its panel are the reading.
  assert.deepEqual(output, [])
})

test('goal or vibe mode keeps the conversation, with the engine’s own words', async () => {
  const goal = harness({ goal: true })
  assert.equal(await enterPlanMode(goal.session, goal.ui, () => {}), false)
  assert.deepEqual(goal.calls, [])
})

test('an approval records the plan as the next turn’s context and leaves the mode', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-plan-'))
  try {
    await mkdir(path.join(dir, 'local'), { recursive: true })
    await writeFile(path.join(dir, 'local', 'Ship-it-plan.md'), '# Ship it\n\n1. do the thing\n', 'utf8')
    const { session, ui, calls, entries, state, handler, reference } = harness({ answer: 'Execute the plan' })
    // Point the fixture's artifacts at the temporary directory the plan file lives in.
    ;(session.sessionManager as unknown as { getArtifactsDir: () => string }).getArtifactsDir = () => dir
    await enterPlanMode(session, ui)
    assert.ok(handler() !== null)
    calls.length = 0
    const result = await handler()!('Ship it')
    assert.deepEqual(calls, [
      'reference:local://Ship-it-plan.md',
      'handler:none',
      'state:none',
      'mode:none',
    ])
    assert.equal(reference(), 'local://Ship-it-plan.md')
    assert.equal(state(), undefined)
    assert.match(JSON.stringify(result), /Plan approved/)
    assert.equal(entries.at(-1)?.mode, 'none')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a refinement keeps the mode on and points it at the reviewed file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-plan-'))
  try {
    await mkdir(path.join(dir, 'local'), { recursive: true })
    await writeFile(path.join(dir, 'local', 'Ship-it-plan.md'), '# Ship it\n', 'utf8')
    const { session, ui, calls, state, handler } = harness({ answer: 'Keep planning' })
    ;(session.sessionManager as unknown as { getArtifactsDir: () => string }).getArtifactsDir = () => dir
    await enterPlanMode(session, ui)
    calls.length = 0
    const result = await handler()!('Ship it')
    assert.equal(state()?.enabled, true)
    assert.ok(calls.includes('state:plan'))
    assert.match(JSON.stringify(result), /Plan refinement requested/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('leaving plan mode journals a paused plan, and restoring re-enters only a live one', async () => {
  const exited = harness()
  await enterPlanMode(exited.session, exited.ui)
  await exitPlanMode(exited.session)
  assert.equal(planModeEnabled(exited.session), false)
  assert.equal(exited.entries.at(-1)?.mode, 'plan_paused')

  const live = harness({ messages: ['a prompt'] })
  live.entries.push({ type: 'mode_change', mode: 'plan', data: { planFilePath: 'local://PLAN.md' } })
  await restorePlanMode(live.session, live.ui)
  assert.equal(planModeEnabled(live.session), true)

  // Nothing said in it: the mode is not one to come back to, and the journal records the pause so a
  // later message does not resurrect it on the next open.
  const empty = harness()
  empty.entries.push({ type: 'mode_change', mode: 'plan', data: { planFilePath: 'local://PLAN.md' } })
  await restorePlanMode(empty.session, empty.ui)
  assert.equal(planModeEnabled(empty.session), false)
  assert.equal(empty.entries.at(-1)?.mode, 'plan_paused')

  const paused = harness()
  paused.entries.push({ type: 'mode_change', mode: 'plan_paused', data: { planFilePath: 'local://PLAN.md' } })
  await restorePlanMode(paused.session, paused.ui)
  assert.equal(planModeEnabled(paused.session), false)
})

test('plan.defaultOnStartup opens a fresh conversation planning, and only a fresh one', async () => {
  // The engine's own answer for a fresh interactive session (`shouldEnterPlanModeOnStartup`): the
  // setting is off by default, and a conversation the reader has already used is never a fresh one.
  const fresh = harness({ settings: { 'plan.defaultOnStartup': true } })
  await restorePlanMode(fresh.session, fresh.ui)
  assert.equal(planModeEnabled(fresh.session), true)
  assert.equal(fresh.entries.at(-1)?.mode, 'plan')

  // The setting is off by default: a fresh conversation without it stays out of the mode.
  const off = harness()
  await restorePlanMode(off.session, off.ui)
  assert.equal(planModeEnabled(off.session), false)

  // Already used: nothing said in it is what makes the default apply, and this one has said plenty.
  const used = harness({ messages: ['a prompt'], settings: { 'plan.defaultOnStartup': true } })
  await restorePlanMode(used.session, used.ui)
  assert.equal(planModeEnabled(used.session), false)
})

test('a conversation that has stepped out of a plan does not come back to it at startup', async () => {
  const stepped = harness({ settings: { 'plan.defaultOnStartup': true } })
  stepped.entries.push({ type: 'mode_change', mode: 'plan_paused', data: { planFilePath: 'local://PLAN.md' } })
  await restorePlanMode(stepped.session, stepped.ui)
  assert.equal(planModeEnabled(stepped.session), false)
})

test('reviewing a plan the conversation is not planning says so', async () => {
  const { session, ui } = harness()
  const output: string[] = []
  await reviewPlan(session, ui, (line) => output.push(line))
  assert.deepEqual(output, ['Plan mode is not active.'])
})

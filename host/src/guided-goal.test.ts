import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Settings, type AgentSession } from '@oh-my-pi/pi-coding-agent'

import { restoreAfterGuidedGoal, startGuidedGoal } from './guided-goal.ts'

/**
 * The guided-goal kickoff: the engine's own interview prompt, the goal tool exposed before a goal
 * exists, and the toolset an abandoned interview gives back.
 */

function harness(options: { goal?: { enabled: boolean; status: string }; plan?: boolean; streaming?: boolean } = {}) {
  const calls: string[] = []
  let tools = ['read', 'write', 'bash']
  const session = {
    isStreaming: options.streaming === true,
    settings: Settings.isolated({ 'goal.enabled': true }),
    getPlanModeState: () => (options.plan === true ? { enabled: true, planFilePath: 'local://PLAN.md' } : undefined),
    getVibeModeState: () => undefined,
    getGoalModeState: () =>
      options.goal === undefined
        ? undefined
        : { enabled: options.goal.enabled, mode: 'active', goal: { status: options.goal.status } },
    getEnabledToolNames: () => [...tools],
    setActiveToolsByName: async (names: string[]) => {
      tools = [...names]
      calls.push(`tools:${names.join(',')}`)
    },
    prompt: async (text: string) => {
      calls.push(`prompt:${text.includes('guided-goal') ? 'kickoff' : text}`)
      return true
    },
    followUp: async (text: string) => {
      calls.push(`followUp:${text.includes('guided-goal') ? 'kickoff' : text}`)
    },
  }
  return { session: session as unknown as AgentSession, calls, tools: () => tools }
}

test('the interview exposes the goal tool and sends the engine’s kickoff', async () => {
  const { session, calls, tools } = harness()
  const output: string[] = []
  assert.equal(await startGuidedGoal(session, 'ship the release', (line) => output.push(line)), true)
  assert.deepEqual(calls, ['tools:read,write,bash,goal', 'prompt:kickoff'])
  assert.deepEqual(tools(), ['read', 'write', 'bash', 'goal'])
  assert.deepEqual(output, [])
})

test('a running turn queues the kickoff behind it instead of aborting', async () => {
  const { session, calls } = harness({ streaming: true })
  await startGuidedGoal(session, '', () => {})
  assert.ok(calls.includes('followUp:kickoff'))
  assert.ok(!calls.some((call) => call.startsWith('prompt:')))
})

test('plan mode refuses the interview before any tool changes', async () => {
  const { session, calls } = harness({ plan: true })
  const output: string[] = []
  assert.equal(await startGuidedGoal(session, 'x', (line) => output.push(line)), false)
  assert.deepEqual(calls, [])
  assert.deepEqual(output, ['Exit plan mode first.'])
})

test('an existing goal (active or paused) has to be managed first', async () => {
  const active = harness({ goal: { enabled: true, status: 'active' } })
  const activeOut: string[] = []
  assert.equal(await startGuidedGoal(active.session, 'x', (line) => activeOut.push(line)), false)
  assert.match(activeOut.join('\n'), /already active/)

  const paused = harness({ goal: { enabled: false, status: 'paused' } })
  const pausedOut: string[] = []
  assert.equal(await startGuidedGoal(paused.session, 'x', (line) => pausedOut.push(line)), false)
  assert.match(pausedOut.join('\n'), /Resume the current goal/)
})

test('an abandoned interview restores the pre-interview toolset', async () => {
  const { session, tools } = harness()
  await startGuidedGoal(session, 'x', () => {})
  assert.deepEqual(tools(), ['read', 'write', 'bash', 'goal'])
  restoreAfterGuidedGoal(session)
  assert.deepEqual(tools(), ['read', 'write', 'bash'])
})

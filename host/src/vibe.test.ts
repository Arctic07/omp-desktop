import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentSession } from '@oh-my-pi/pi-coding-agent'

import { enterVibeMode, exitVibeMode, restoreVibeMode, vibeModeEnabled } from './vibe.ts'

/**
 * The desktop's body for `/vibe`, against a session that records what it was asked to do.
 *
 * The engine owns the mode's parts (the tool swap, the worker registry, the `mode_change` journal),
 * so what is checked here is the order and the persistence this host is responsible for: which
 * names the director keeps, what the exit path restores, and that a reopened conversation enters
 * the mode only when its journal says it was in it.
 */

interface ModeChange {
  type: 'mode_change'
  mode: string
  data?: Record<string, unknown>
}

/** The session methods this module drives, as the fake below records them. */
interface FakeSession {
  readonly calls: string[]
  readonly entries: ModeChange[]
  readonly session: AgentSession
  tools: () => string[]
}

/** One session's records, as the engine's own manager would hold them. */
function harness(
  options: {
    mode?: string
    tools?: string[]
    streaming?: boolean
    goal?: boolean
    plan?: boolean
    /** A turn whose `abort()` and `waitForIdle()` never settle, the way a blocked or hung turn behaves. */
    stuck?: boolean
    /** A toolset swap the engine refuses, for the mode that must still be left. */
    failingDeactivate?: boolean
  } = {},
): FakeSession {
  const calls: string[] = []
  const entries: ModeChange[] =
    options.mode === undefined ? [] : [{ type: 'mode_change', mode: options.mode }]
  let vibe: { enabled: boolean } | undefined
  let tools = [...(options.tools ?? ['read', 'write', 'bash', 'todo'])]
  const fake = {
    isStreaming: options.streaming === true,
    getAgentId: () => 'Main',
    getSessionId: () => 's01vibe',
    getSessionFile: () => null,
    settings: {},
    getVibeModeState: () => vibe,
    setVibeModeState: (state: { enabled: boolean } | undefined) => {
      vibe = state
      calls.push(`state:${state === undefined ? 'none' : String(state.enabled)}`)
    },
    getPlanModeState: () => (options.plan === true ? { enabled: true, planFilePath: 'plan.md' } : undefined),
    getGoalModeState: () => (options.goal === true ? { enabled: true, mode: 'active' } : undefined),
    hasBuiltInTool: (name: string) => name === 'todo',
    getEnabledToolNames: () => [...tools],
    activateVibeTools: async (base: string[]) => {
      calls.push(`activate:${base.join(',')}`)
      tools = [...base, 'vibe_spawn', 'vibe_send', 'vibe_wait', 'vibe_kill', 'vibe_list']
    },
    deactivateVibeTools: async (next: string[]) => {
      calls.push(`deactivate:${next.join(',')}`)
      if (options.failingDeactivate === true) throw new Error('the toolset cannot be restored')
      tools = [...next]
    },
    sendVibeModeContext: async () => {
      calls.push('steer')
    },
    abort: async () => {
      calls.push('abort')
      if (options.stuck === true) await new Promise<void>(() => {})
    },
    waitForIdle: async () => {
      calls.push('waitIdle')
      if (options.stuck === true) await new Promise<void>(() => {})
    },
    runModeExitTeardown: async (teardown: () => Promise<void>) => {
      calls.push('teardown')
      await teardown()
    },
    sessionManager: {
      getSessionId: () => 's01vibe',
      getSessionFile: () => 'D:/sessions/s01vibe.jsonl',
      getEntries: () => entries,
      getBranch: () => entries,
      buildSessionContext: () => ({ mode: entries.at(-1)?.mode ?? 'none' }),
      appendModeChange: (mode: string, data?: Record<string, unknown>) => {
        entries.push({ type: 'mode_change', mode, data })
        calls.push(`mode:${mode}`)
      },
      appendEntriesAtomically: async (write: () => void) => {
        write()
      },
    },
  }
  // The fake answers exactly the members above; the cast is the boundary between it and the
  // engine's session type, which the real session satisfies through those same members.
  return { session: fake as unknown as AgentSession, calls, entries, tools: () => tools }
}

test('entering the mode installs the director toolset and journals the previous one', async () => {
  const { session, calls, entries, tools } = harness()
  const output: string[] = []
  assert.equal(await enterVibeMode(session, (line) => output.push(line)), true)
  assert.equal(vibeModeEnabled(session), true)
  // Reading and the session's own todo list are the only tools left to the director; the five
  // vibe tools are the engine's to add, which is what `activate` names.
  assert.deepEqual(calls.slice(0, 2), ['activate:read,todo', 'state:true'])
  assert.deepEqual(tools(), [
    'read',
    'todo',
    'vibe_spawn',
    'vibe_send',
    'vibe_wait',
    'vibe_kill',
    'vibe_list',
  ])
  // The toolset before the mode is what an exit has to restore, so it is written with the mode.
  assert.deepEqual(entries.at(-1), {
    type: 'mode_change',
    mode: 'vibe',
    data: { previousTools: ['read', 'write', 'bash', 'todo'] },
  })
  // No banner: the mode's chip is the reading.
  assert.deepEqual(output, [])
})

test('a running turn receives the director instructions as a steer', async () => {
  const { session, calls } = harness({ streaming: true })
  await enterVibeMode(session)
  assert.ok(calls.includes('steer'))
})

test('goal mode keeps the conversation: entering vibe refuses instead of rewriting its toolset', async () => {
  const { session, calls } = harness({ goal: true })
  const output: string[] = []
  assert.equal(await enterVibeMode(session, (line) => output.push(line)), false)
  assert.deepEqual(calls, [])
  assert.deepEqual(output, ['Exit goal mode first.'])
})

test('plan mode refuses the mode for the same reason, with the engine’s own words', async () => {
  const { session, calls } = harness({ plan: true })
  const output: string[] = []
  assert.equal(await enterVibeMode(session, (line) => output.push(line)), false)
  assert.deepEqual(calls, [])
  assert.deepEqual(output, ['Exit plan mode first.'])
})

test('exiting restores the pre-vibe toolset, clears the state and journals the exit', async () => {
  const { session, calls, tools } = harness()
  await enterVibeMode(session)
  calls.length = 0
  const output: string[] = []
  assert.equal(await exitVibeMode(session, (line) => output.push(line)), 0)
  assert.equal(vibeModeEnabled(session), false)
  // The teardown wrapper is the engine's guard against a queued steer restarting on the vibe
  // tools; the worker kill writes `mode_change: none` itself.
  assert.deepEqual(calls, [
    'teardown',
    'mode:none',
    'deactivate:read,write,bash,todo',
    'state:none',
  ])
  assert.deepEqual(tools(), ['read', 'write', 'bash', 'todo'])
  assert.deepEqual(output, [])
})

test('an exit does not wait out a turn that will not settle', async () => {
  const { session, calls, tools } = harness({ streaming: true, stuck: true })
  await enterVibeMode(session)
  calls.length = 0
  const started = Date.now()
  // The grace is the only thing that ends the wait: both promises the engine would settle are held
  // open, which is what a director blocked in a tool or a silent provider looks like from here.
  assert.equal(await exitVibeMode(session, undefined, { abortGraceMs: 20 }), 0)
  assert.ok(Date.now() - started < 2_000, `${Date.now() - started}ms`)
  assert.equal(vibeModeEnabled(session), false)
  assert.deepEqual(tools(), ['read', 'write', 'bash', 'todo'])
  // The turn was asked to stop once, and the teardown ran past it rather than waiting behind it.
  assert.deepEqual(calls, [
    'teardown',
    'abort',
    'waitIdle',
    'mode:none',
    'deactivate:read,write,bash,todo',
    'state:none',
  ])
})

test('a toolset the engine refuses to restore still leaves the mode', async () => {
  const { session } = harness({ failingDeactivate: true })
  await enterVibeMode(session)
  await assert.rejects(exitVibeMode(session), /cannot be restored/)
  // The one thing an exit may never leave behind: a conversation whose chip is gone but whose tools
  // are still the director's.
  assert.equal(vibeModeEnabled(session), false)
})

test('an exit with no live snapshot reads the previous toolset from the journal', async () => {
  const { session, entries, tools } = harness({ mode: 'vibe' })
  entries[0] = { type: 'mode_change', mode: 'vibe', data: { previousTools: ['read', 'grep'] } }
  // A session whose mode is on but whose entry did not come through this module: the journal is
  // the only record of what to restore, which is the cold-start shape.
  session.setVibeModeState({ enabled: true })
  await exitVibeMode(session)
  assert.deepEqual(tools(), ['read', 'grep'])
})

test('opening a conversation that was directing workers enters the mode again', async () => {
  const { session, calls, entries, tools } = harness({ mode: 'vibe' })
  entries[0] = { type: 'mode_change', mode: 'vibe', data: { previousTools: ['read', 'write'] } }
  await restoreVibeMode(session)
  assert.equal(vibeModeEnabled(session), true)
  // A restore must not append a second `mode_change`: the journal already records the mode, and a
  // fresh snapshot would replace the toolset the original entry captured.
  assert.deepEqual(entries, [
    { type: 'mode_change', mode: 'vibe', data: { previousTools: ['read', 'write'] } },
  ])
  assert.ok(calls.includes('activate:read,todo'))
  // A cold open builds the default toolset, so that live set - not the journal - is what an exit
  // restores.
  await exitVibeMode(session)
  assert.deepEqual(tools(), ['read', 'write', 'bash', 'todo'])
})

test('opening a conversation that was not directing workers enters nothing', async () => {
  const { session, calls } = harness()
  await restoreVibeMode(session)
  assert.deepEqual(calls, [])
  assert.equal(vibeModeEnabled(session), false)
})

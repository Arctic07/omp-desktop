import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { InternalAvailableSlashCommand } from '@oh-my-pi/pi-coding-agent/slash-commands/available-commands'
import type { RpcGoalResult } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal'

import { runDesktopCommand, withDesktopCommands } from './slash-desktop.ts'
import type { SlashCommandOptions } from './slash.ts'

/**
 * The desktop's `/goal` command: what the palette advertises, and what the command does with the
 * engine's goal runtime.
 *
 * The engine advertises only commands that have a text-mode handler, so `/goal` (a TUI-only
 * command) has to be added by this host - and the merge is the part a reader sees: one `goal`
 * row, in the builtin group, replacing a file command that would otherwise shadow it.
 */

function command(
  name: string,
  source: InternalAvailableSlashCommand['source'],
): InternalAvailableSlashCommand {
  return { name, description: `${name} description`, source }
}

test('the desktop goal command follows the engine builtins and replaces a shadowing entry', () => {
  const merged = withDesktopCommands([
    command('model', 'builtin'),
    command('goal', 'file'),
    command('skill:one', 'skill'),
  ])
  assert.deepEqual(
    merged.map((entry) => `${entry.source}:${entry.name}`),
    [
      'builtin:model',
      'builtin:plan',
      'builtin:plan-review',
      'builtin:vibe',
      'builtin:goal',
      'builtin:guided-goal',
      'builtin:loop',
      'builtin:btw',
      'builtin:tan',
      'builtin:cleanse',
      'skill:skill:one',
    ],
  )
})

/** The smallest controller shape the dispatch reads, recording what it was asked to do. */
function harness(state: RpcGoalResult['state'] = null, answer?: string, streaming = false) {
  const calls: string[] = []
  const output: string[] = []
  const goal = {
    async handle(request: { op: string }) {
      calls.push(request.op)
      return { goal: null, state }
    },
  }
  let vibe: { enabled: boolean } | undefined
  const session = {
    isStreaming: streaming,
    getGoalModeState: () => state ?? undefined,
    goalRuntime: {
      replaceGoal: async () => {
        calls.push('replace')
        return null
      },
      onBudgetMutated: async (budget: number | undefined) => {
        calls.push(`budget:${String(budget)}`)
      },
    },
    setGoalModeState: () => {},
    prompt: async () => {
      calls.push('prompt')
    },
    // Vibe mode: the members `vibe.ts` drives. The harness only needs the ones a dispatch
    // reaches, and each call is recorded so the order can be asserted.
    getVibeModeState: () => vibe,
    setVibeModeState: (next: { enabled: boolean } | undefined) => {
      vibe = next
      calls.push(`vibe-state:${next === undefined ? 'none' : String(next.enabled)}`)
    },
    getPlanModeState: () => undefined,
    getSessionId: () => 's01slash',
    getAgentId: () => 'Main',
    getSessionFile: () => null,
    settings: {},
    hasBuiltInTool: (name: string) => name === 'todo',
    getEnabledToolNames: () => ['read', 'write', 'bash', 'todo'],
    activateVibeTools: async (base: string[]) => {
      calls.push(`vibe-activate:${base.join(',')}`)
    },
    deactivateVibeTools: async (next: string[]) => {
      calls.push(`vibe-deactivate:${next.join(',')}`)
    },
    sendVibeModeContext: async () => {
      calls.push('vibe-steer')
    },
    abort: async () => {
      calls.push('vibe-abort')
    },
    runModeExitTeardown: async (teardown: () => Promise<void>) => {
      calls.push('vibe-teardown')
      await teardown()
    },
    sessionManager: {
      getSessionId: () => 's01slash',
      getSessionFile: () => 'D:/sessions/s01slash.jsonl',
      getEntries: () => [] as Array<{ type: string; mode?: string; data?: unknown }>,
      getBranch: () => [] as Array<{ type: string; mode?: string }>,
      buildSessionContext: () => ({ mode: 'none' }),
      appendModeChange: (mode: string) => {
        calls.push(`vibe-mode:${mode}`)
      },
      appendEntriesAtomically: async (write: () => void) => {
        write()
      },
    },
  }
  const options = {
    sdk: { parseSlashCommand: (text: string) => {
      if (!text.startsWith('/')) return null
      const [name, ...rest] = text.slice(1).split(/\s+/)
      return { name, args: rest.join(' '), text }
    } },
    session,
    goal,
    output: (line: string) => output.push(line),
    refreshCommands: async () => {},
    publishState: () => {},
    publishTitle: () => {},
    behavior: undefined,
    ui: {
      requestText: async () => {
        calls.push('dialog')
        return answer
      },
    },
  } as unknown as SlashCommandOptions
  return { options, calls, output }
}

test('a non-goal text is not this dispatcher’s to run', async () => {
  const { options, calls } = harness()
  assert.equal(await runDesktopCommand(options, '/model'), null)
  assert.equal(await runDesktopCommand(options, 'plain text'), null)
  assert.deepEqual(calls, [])
})

test('/goal show reports an empty goal from the controller state', async () => {
  const { options, calls, output } = harness()
  const run = await runDesktopCommand(options, '/goal show')
  assert.deepEqual(run, { kind: 'handled', agentInvoked: false })
  assert.deepEqual(output, ['No goal set.'])
  assert.deepEqual(calls, ['get'])
})

test('/goal <objective> creates the goal and sends the objective as the first turn', async () => {
  const { options, calls, output } = harness()
  const run = await runDesktopCommand(options, '/goal ship the release')
  assert.deepEqual(run, { kind: 'prompt', text: 'ship the release' })
  assert.deepEqual(calls, ['get', 'create'])
  // No banner: the goal panel is the status line, so the command itself says nothing.
  assert.deepEqual(output, [])
})

test('/goal with no objective asks the reader for one and starts the goal with the answer', async () => {
  const { options, calls, output } = harness(null, 'cut the release')
  const run = await runDesktopCommand(options, '/goal')
  assert.deepEqual(run, { kind: 'prompt', text: 'cut the release' })
  assert.deepEqual(calls, ['get', 'dialog', 'create'])
  assert.deepEqual(output, [])
})

test('/goal cancels quietly when the objective box is dismissed', async () => {
  const { options, calls, output } = harness(null, undefined)
  const run = await runDesktopCommand(options, '/goal')
  assert.deepEqual(run, { kind: 'handled', agentInvoked: false })
  assert.deepEqual(calls, ['get', 'dialog'])
  assert.deepEqual(output, [])
})

test('a paused goal refuses a new objective, as the engine terminal command does', async () => {
  const paused: RpcGoalResult['state'] = {
    enabled: false,
    mode: 'active',
    goal: {
      objective: 'previous',
      status: 'paused',
      tokensUsed: 0,
      timeUsedSeconds: 0,
    },
  } as RpcGoalResult['state']
  const { options, calls, output } = harness(paused)
  const run = await runDesktopCommand(options, '/goal set another objective')
  assert.deepEqual(run, { kind: 'handled', agentInvoked: false })
  assert.deepEqual(calls, ['get'])
  assert.match(output.join('\n'), /Resume the current goal first/)
})

test('/goal budget validates before reaching the runtime', async () => {
  const active: RpcGoalResult['state'] = {
    enabled: true,
    mode: 'active',
    goal: {
      objective: 'work',
      status: 'active',
      tokensUsed: 10,
      timeUsedSeconds: 1,
    },
  } as RpcGoalResult['state']
  const { options, calls, output } = harness(active)
  await runDesktopCommand(options, '/goal budget nope')
  assert.deepEqual(calls, ['get'])
  assert.match(output.join('\n'), /positive integer/)

  output.length = 0
  await runDesktopCommand(options, '/goal budget off')
  assert.deepEqual(calls, ['get', 'get', 'budget:undefined'])
  // Silent: the budget is a field in the goal panel.
  assert.deepEqual(output, [])
})

test('the palette carries every served mode command, in the builtin group', () => {
  const merged = withDesktopCommands([command('model', 'builtin'), command('vibe', 'file')])
  assert.deepEqual(
    merged.map((entry) => `${entry.source}:${entry.name}`),
    [
      'builtin:model',
      'builtin:plan',
      'builtin:plan-review',
      'builtin:vibe',
      'builtin:goal',
      'builtin:guided-goal',
      'builtin:loop',
      'builtin:btw',
      'builtin:tan',
      'builtin:cleanse',
    ],
  )
})

test('/vibe turns the mode on, and the same word turns it off', async () => {
  const { options, calls, output } = harness()
  const entered = await runDesktopCommand(options, '/vibe')
  assert.deepEqual(entered, { kind: 'handled', agentInvoked: false })
  assert.deepEqual(calls, ['vibe-activate:read,todo', 'vibe-state:true', 'vibe-mode:vibe'])
  // The composer's chip and panel are the reading; the command adds no banner.
  assert.deepEqual(output, [])

  calls.length = 0
  const exited = await runDesktopCommand(options, '/vibe')
  assert.deepEqual(exited, { kind: 'handled', agentInvoked: false })
  assert.deepEqual(calls, [
    'vibe-teardown',
    'vibe-mode:none',
    'vibe-deactivate:read,write,bash,todo',
    'vibe-state:none',
  ])
  assert.deepEqual(output, [])
})

test('/vibe <prompt> enters the mode and sends the prompt as the director’s first turn', async () => {
  const { options, calls } = harness()
  const run = await runDesktopCommand(options, '/vibe split the release into workstreams')
  assert.deepEqual(run, { kind: 'prompt', text: 'split the release into workstreams' })
  assert.deepEqual(calls, ['vibe-activate:read,todo', 'vibe-state:true', 'vibe-mode:vibe'])
})

test('/vibe <prompt> steers the directive into a turn that is already running', async () => {
  const { options, calls } = harness(null, undefined, true)
  const run = await runDesktopCommand(options, '/vibe tighten the review')
  assert.deepEqual(run, { kind: 'handled', agentInvoked: true })
  // The mode's own context steer comes first (the entry runs while the turn is live), and the
  // directive follows as a steer on the same turn: a plain prompt here would be refused as busy.
  assert.deepEqual(calls, [
    'vibe-activate:read,todo',
    'vibe-state:true',
    'vibe-steer',
    'vibe-mode:vibe',
    'prompt',
  ])
})

test('an active vibe mode refuses a goal, so the two modes never rewrite one toolset', async () => {
  const { options, calls, output } = harness()
  await runDesktopCommand(options, '/vibe')
  calls.length = 0
  const run = await runDesktopCommand(options, '/goal ship it')
  assert.deepEqual(run, { kind: 'handled', agentInvoked: false })
  assert.deepEqual(output.at(-1), 'Exit vibe mode first.')
  // The command reads the current goal before it decides anything; the refusal has to stop the
  // mutation, which is the only thing that would rewrite the toolset.
  assert.deepEqual(calls, ['get'])
})

test('goal mode refuses /vibe before it touches the toolset', async () => {
  const active: RpcGoalResult['state'] = {
    enabled: true,
    mode: 'active',
    goal: { objective: 'work', status: 'active', tokensUsed: 0, timeUsedSeconds: 0 },
  } as RpcGoalResult['state']
  const { options, calls, output } = harness(active)
  // The session's own goal state is what the vibe entry reads; the harness answers the same state
  // through both views.
  const run = await runDesktopCommand(options, '/vibe')
  assert.deepEqual(run, { kind: 'handled', agentInvoked: false })
  assert.equal(output.at(-1), 'Exit goal mode first.')
  assert.deepEqual(calls, [])
})

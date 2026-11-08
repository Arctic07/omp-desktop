import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { AgentSession } from '@oh-my-pi/pi-coding-agent'

import {
  continueLoop,
  disableLoop,
  enableLoop,
  loopModeEnabled,
  loopModeView,
  noteLoopPrompt,
  pauseLoop,
} from './loop-mode.ts'

/**
 * Loop mode's own half: which prompt repeats, when an iteration is due, and the bounds.
 *
 * The parsing, the budget arithmetic and the shell condition are the engine's modules; what is
 * checked here is the host's driver — first prompt capture, one submission per settled turn, the
 * budget ending the loop, and a stop suspending it instead of dropping it.
 */

function harness() {
  const prompts: string[] = []
  const session = {
    isStreaming: false,
    prompt: async (text: string) => {
      prompts.push(text)
      return true
    },
    sessionManager: { getCwd: () => process.cwd(), getSessionId: () => 's01loop' },
  }
  return { session: session as unknown as AgentSession, prompts }
}

test('enabling takes the inline prompt, and the mode reports what it repeats', () => {
  const { session } = harness()
  const result = enableLoop(session, '3 tighten the review')
  assert.deepEqual(result, { ok: true, prompt: 'tighten the review' })
  assert.equal(loopModeEnabled(session), true)
  const view = loopModeView(session)
  assert.equal(view.enabled, true)
  assert.equal(view.prompt, 'tighten the review')
  assert.match(view.limit ?? '', /3/)
})

test('a second /loop turns it off, and an unparsable bound is reported instead of starting', () => {
  const { session } = harness()
  enableLoop(session, 'fix it')
  assert.deepEqual(enableLoop(session, ''), { ok: true })
  assert.equal(loopModeEnabled(session), false)

  const invalid = enableLoop(session, '--until')
  assert.equal(invalid.ok, false)
  assert.equal(loopModeEnabled(session), false)
})

test('the first submitted prompt becomes the one that repeats', () => {
  const { session } = harness()
  enableLoop(session, '')
  noteLoopPrompt(session, 'write the tests')
  noteLoopPrompt(session, 'a later prompt is not the loop')
  assert.equal(loopModeView(session).prompt, 'write the tests')
})

test('one iteration per settled turn, and the budget ends the loop', async () => {
  const { session, prompts } = harness()
  const output: string[] = []
  enableLoop(session, '1 keep going')
  await continueLoop(session, (line) => output.push(line))
  assert.deepEqual(prompts, ['keep going'])
  // The first iteration consumed the only one allowed: the next settled turn ends the loop.
  await continueLoop(session, (line) => output.push(line))
  assert.deepEqual(prompts, ['keep going'])
  assert.equal(loopModeEnabled(session), false)
  assert.match(output.join('\n'), /budget/)
})

test('a session that is already working is not given a second iteration', async () => {
  // The terminal's own busy reading, and the reason it exists here: a submission into a compaction
  // or a queued continuation throws `AgentBusyError`, which this host answers by *disabling* the
  // loop — one badly timed iteration would end a loop that was working fine.
  const prompts: string[] = []
  const session = {
    isStreaming: false,
    isCompacting: true,
    hasPostPromptWork: false,
    prompt: async (text: string) => {
      prompts.push(text)
      return true
    },
    sessionManager: { getCwd: () => process.cwd(), getSessionId: () => 's01loop' },
  } as unknown as AgentSession
  enableLoop(session, '1 keep going')
  await continueLoop(session, () => {})
  assert.deepEqual(prompts, [], 'no iteration while the session is compacting')
  assert.equal(loopModeEnabled(session), true, 'the skipped iteration keeps the loop alive')
  assert.equal(loopModeView(session).prompt, 'keep going')

  // The next settled turn takes the iteration that was held back.
  ;(session as unknown as { isCompacting: boolean }).isCompacting = false
  await continueLoop(session, () => {})
  assert.deepEqual(prompts, ['keep going'])
})

test('a stop suspends the loop; a disabled loop submits nothing', async () => {
  const { session, prompts } = harness()
  enableLoop(session, 'keep going')
  pauseLoop(session)
  assert.equal(loopModeView(session).paused, true)
  await continueLoop(session, () => {})
  assert.deepEqual(prompts, [])

  disableLoop(session)
  await continueLoop(session, () => {})
  assert.deepEqual(prompts, [])
})

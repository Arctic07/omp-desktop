import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deliverPrompt, type PromptTarget } from './session-prompt.ts'

/**
 * Where one delivered message actually went.
 *
 * The rule under test is the edge between the engine's atomic admission (`joinActiveTurn`, 18.12.6)
 * and its one-shot `prompt({streamingBehavior})`: a message the admission refuses must still arrive,
 * as its own turn or as the behaviour the caller asked for, and a message the admission cannot
 * carry (a `/` command, an `aside`) must not be handed to it at all.
 */

/** A stand-in engine that records the calls the rule makes. */
function target(options: { streaming: boolean; admitted?: boolean }) {
  const calls: string[] = []
  const images: unknown[] = []
  const agent = {
    isStreaming: options.streaming,
    joinActiveTurn: async (
      _text: string,
      messageImages?: unknown[],
      joinOptions?: { queue?: 'steering' | 'followUp' },
    ) => {
      calls.push(`join:${joinOptions?.queue ?? 'steering'}`)
      images.push(messageImages)
      return options.admitted ?? true
    },
    prompt: async (
      _text: string,
      promptOptions?: { streamingBehavior?: 'steer' | 'followUp' | 'aside' },
    ) => {
      calls.push(`prompt:${promptOptions?.streamingBehavior ?? 'none'}`)
      return true
    },
  }
  return { agent: agent as unknown as PromptTarget, calls, images }
}

test('a steer joins the live run through the atomic admission', async () => {
  const { agent, calls } = target({ streaming: true })
  assert.equal(await deliverPrompt(agent, 'look at this', undefined, 'steer'), true)
  assert.deepEqual(calls, ['join:steering'])
})

test('a follow-up uses the follow-up queue', async () => {
  const { agent, calls } = target({ streaming: true })
  assert.equal(await deliverPrompt(agent, 'then check the tests', undefined, 'followUp'), true)
  assert.deepEqual(calls, ['join:followUp'])
})

test('a run that settles mid-admission gives the message its own turn', async () => {
  const { agent, calls } = target({ streaming: false, admitted: false })
  assert.equal(await deliverPrompt(agent, 'next question', undefined, 'steer'), true)
  assert.deepEqual(calls, ['join:steering', 'prompt:none'])
})

test('a run the engine keeps for itself still takes the message as the behaviour said', async () => {
  const { agent, calls } = target({ streaming: true, admitted: false })
  assert.equal(await deliverPrompt(agent, 'still here?', undefined, 'steer'), true)
  assert.deepEqual(calls, ['join:steering', 'prompt:steer'])
})

test('slash text keeps the engine prompt path, which executes commands', async () => {
  const { agent, calls } = target({ streaming: true })
  assert.equal(await deliverPrompt(agent, '/compact', undefined, 'steer'), true)
  assert.deepEqual(calls, ['prompt:steer'])
})

test('aside keeps the engine prompt path, which has no admission queue', async () => {
  const { agent, calls } = target({ streaming: true })
  assert.equal(await deliverPrompt(agent, 'a side note', undefined, 'aside'), true)
  assert.deepEqual(calls, ['prompt:aside'])
})

test('a plain idle message starts a turn without a streaming behaviour', async () => {
  const { agent, calls } = target({ streaming: false })
  assert.equal(await deliverPrompt(agent, 'hello', undefined, undefined), true)
  assert.deepEqual(calls, ['prompt:none'])
})

test('images travel with the admitted message', async () => {
  const { agent, images } = target({ streaming: true })
  const parts = [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]
  await deliverPrompt(agent, 'what is this?', parts, 'steer')
  assert.deepEqual(images, [parts])
})

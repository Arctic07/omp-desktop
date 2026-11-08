import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BootServices } from './boot.ts'
import { complete, readRequest } from './plugin-agent.ts'
import type { SdkBundle } from './sdk.ts'

/**
 * `agent.complete`: the shape this side reads, and the projection of the engine's answer.
 *
 * The completion itself is the engine's (`completeSimple` through the SDK seam), so what is pinned
 * here is what this file owns - refusing a request whose fields cannot be read, resolving the model
 * through the role chain the rest of the application uses, and answering `{ text, usage }` rather
 * than the message object the engine keeps.
 */

test('a request without a prompt is refused rather than completed on nothing', () => {
  assert.throws(() => readRequest({ maxTokens: 16 }))
  assert.throws(() => readRequest({ prompt: '   ', maxTokens: 16 }))
  assert.throws(() => readRequest({ prompt: 'hi' }), 'maxTokens is required')
  assert.throws(() => readRequest({ prompt: 'hi', maxTokens: 0 }))
  assert.throws(() => readRequest({ prompt: 'hi', maxTokens: 1.5 }))
  assert.throws(() => readRequest({ prompt: 'hi', maxTokens: 16, system: 3 }))
  const ok = readRequest({ prompt: 'hi', maxTokens: 16, model: 'anthropic/claude' })
  assert.deepEqual(ok, { prompt: 'hi', maxTokens: 16, model: 'anthropic/claude' })
})

/** A bundle whose engine surface is only what a completion reaches. */
function fakeSdk(answer: unknown): SdkBundle {
  const model = { provider: 'anthropic', id: 'claude', name: 'Claude' }
  return {
    getModelMatchPreferences: () => ({}),
    roleCandidatePool: () => [model],
    resolveModelRoleValue: () => ({ model }),
    pickDefaultAvailableModel: () => model,
    completeSimple: async () => answer,
  } as unknown as SdkBundle
}

function fakeServices(): BootServices {
  return {
    settings: {},
    auth: {},
    registry: {
      getAvailable: () => [{ provider: 'anthropic', id: 'claude', name: 'Claude' }],
      hasConfiguredAuth: () => true,
      hasConcreteAuth: () => true,
      getApiKey: async () => 'sk-test',
      resolver: () => 'sk-test',
    },
  } as unknown as BootServices
}

test('the answer is the words and what they cost, not the engine message', async () => {
  const answer = await complete(fakeSdk({
    stopReason: 'stop',
    content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }],
    usage: { input: 11, output: 3, cacheRead: 2, cacheWrite: 0, reasoning: 1, costUsd: 0.004 },
  }), fakeServices(), { prompt: 'hi', maxTokens: 64 })
  assert.deepEqual(answer, {
    text: 'hello world',
    usage: { input: 11, output: 3, cacheRead: 2, cacheWrite: 0, reasoning: 1, costUsd: 0.004 },
  })
})

test('a completion the provider refused is this process failure, with the engine sentence', async () => {
  await assert.rejects(
    complete(fakeSdk({ stopReason: 'error', content: [], errorMessage: 'quota exhausted', usage: {} }), fakeServices(), {
      prompt: 'hi',
      maxTokens: 64,
    }),
    (error: unknown) => error instanceof Error && /quota exhausted/.test(error.message),
  )
})

test('a machine with no model configured answers what is missing', async () => {
  const sdk = { ...(fakeSdk({}) as object), pickDefaultAvailableModel: () => undefined, resolveModelRoleValue: () => ({}) } as unknown as SdkBundle
  await assert.rejects(complete(sdk, fakeServices(), { prompt: 'hi', maxTokens: 8 }), (error: unknown) =>
    error instanceof Error && /No model is available/.test(error.message))
})

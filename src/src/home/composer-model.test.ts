import assert from 'node:assert/strict'
import { test } from 'node:test'

import { namedModel, pendingPickHolds, PENDING_PICK_TTL_MS, type PendingPick } from './composer-model.ts'

const NEVER = { current: null, pending: null, defaultModel: 'dp/a', phase: 'hero' as const }

test('a conversation names its own model, never the engine default role', () => {
  assert.equal(namedModel({ ...NEVER, current: 'my/b', phase: 'conversation' }), 'my/b')
  // The model this app does not offer is not a reason to name a different one: the field says
  // nothing, which is what locks a strength that belongs to a model nobody named.
  assert.equal(namedModel({ ...NEVER, phase: 'conversation' }), null)
  // Not while it is still being read either — that is the same conversation, mid-open.
  assert.equal(namedModel({ ...NEVER, phase: 'reading' }), null)
  // A conversation whose open failed is not the hero: naming the role would offer a model to a
  // conversation that has none.
  assert.equal(namedModel({ ...NEVER, phase: 'failed' }), null)
})

test('a pick made while the conversation opens is named before it is written', () => {
  assert.equal(namedModel({ ...NEVER, pending: 'my/b', phase: 'reading' }), 'my/b')
  // The session's own answer wins once it lands, because that is what the engine says it runs.
  assert.equal(namedModel({ ...NEVER, current: 'my/b', pending: 'my/c', phase: 'conversation' }), 'my/b')
})

test('the hero screen names the role the next conversation starts on', () => {
  assert.equal(namedModel(NEVER), 'dp/a')
  assert.equal(namedModel({ ...NEVER, defaultModel: null }), null)
})

function pick(at = 1_000): PendingPick {
  return { model: 'my/b', at }
}

test('a held pick is written the moment its conversation has an id', () => {
  assert.equal(pendingPickHolds(pick(), { sessionId: 's1', phase: 'conversation', now: 1_100 }), 'apply')
  // The thinking level is held in the same slot and applied by the same rule.
  assert.equal(
    pendingPickHolds({ thinking: 'high', at: 1_000 }, { sessionId: 's1', phase: 'conversation', now: 1_100 }),
    'apply',
  )
})

test('a held pick waits only while its own conversation is still coming up', () => {
  assert.equal(pendingPickHolds(pick(), { sessionId: null, phase: 'reading', now: 1_100 }), 'hold')
  // The open failed: the pick must not travel to whatever is opened next.
  assert.equal(pendingPickHolds(pick(), { sessionId: null, phase: 'failed', now: 1_100 }), 'drop')
  // No open is this slow, so the pick belongs to one that is not coming back.
  assert.equal(
    pendingPickHolds(pick(), { sessionId: null, phase: 'reading', now: 1_000 + PENDING_PICK_TTL_MS + 1 }),
    'drop',
  )
  assert.equal(pendingPickHolds(null, { sessionId: 's1', phase: 'conversation', now: 2_000 }), 'drop')
})

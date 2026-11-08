import assert from 'node:assert/strict'
import { test } from 'node:test'

import { blankSeatToOpen, type BlankCandidate } from './blank-seat.ts'

/**
 * What "new conversation" opens in a workspace.
 *
 * The case pinned here is the one the reader hit (2026-10-26): a terminal and the work column opened
 * in a conversation nothing had been sent in went away as soon as they switched conversations and
 * asked for a new one — the desktop's blank conversation had come back under a new id, so nothing the
 * reader had opened in it could be found. The same request in another workspace must stay there.
 *
 * The same report also pinned the opposite: a new conversation came back in plan mode. A blank
 * conversation carrying a mode is not the empty seat "new" asks for unless the reader left a shell in
 * it.
 */

function record(id: string, workspaceId: number, messages: unknown[] = [], modes?: object): BlankCandidate {
  return {
    id,
    workspaceId,
    engineEmpty: messages.length === 0,
    messages,
    ...(modes === undefined ? {} : { runtime: { modes } }),
  }
}

const NO_WORK = () => false

test('the blank conversation this page holds is opened again after a switch', () => {
  const records = { blank: record('blank', 1), other: record('other', 1, ['a prompt']) }
  assert.equal(blankSeatToOpen(1, records, 'blank', 'other', NO_WORK), 'blank')
})

test('a conversation with a message in it is never the one a new conversation opens', () => {
  const records = { written: record('written', 1, ['a prompt']) }
  assert.equal(blankSeatToOpen(1, records, 'written', 'written', NO_WORK), null)
})

test('a blank conversation in another workspace is not this workspace new conversation', () => {
  const records = { blank: record('blank', 2) }
  assert.equal(blankSeatToOpen(1, records, 'blank', 'blank', NO_WORK), null)
})

test('the conversation on screen is reused when it is the blank one, remembered or not', () => {
  const records = { blank: record('blank', 1) }
  assert.equal(blankSeatToOpen(1, records, undefined, 'blank', NO_WORK), 'blank')
})

test('a remembered id whose record is gone opens nothing', () => {
  assert.equal(blankSeatToOpen(1, {}, 'blank', null, NO_WORK), null)
})

test('a blank conversation carrying a mode is not the seat a new conversation opens', () => {
  const records = { plan: record('plan', 1, [], { plan: { planFilePath: 'local://PLAN.md' } }) }
  assert.equal(blankSeatToOpen(1, records, 'plan', 'plan', NO_WORK), null)
})

test('a blank conversation in a mode is reused when the reader left column work in it', () => {
  const records = { plan: record('plan', 1, [], { plan: { planFilePath: 'local://PLAN.md' } }) }
  assert.equal(
    blankSeatToOpen(1, records, 'plan', 'plan', (id) => id === 'plan'),
    'plan',
  )
})

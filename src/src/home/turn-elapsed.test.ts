import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatMessage } from '../api/session-types.ts'
import { buildRows } from './conversation-rows.ts'
import { startOfTurn, turnElapsedSeconds } from './turn-elapsed.ts'

/**
 * The clock the running row counts from.
 *
 * One number with two possible sources, and the reason it exists at all is that the reader can leave
 * a conversation and come back to it: the row is drawn again from nothing, so what it counts from
 * has to be a fact about the turn rather than about the visit.
 */

function prompt(id: string, at: number): ChatMessage {
  return { kind: 'user', id, at, text: 'go', attachments: [] }
}

test('the turn counts from the host’s own stamp', () => {
  const rows = buildRows([prompt('u1', 1_000), prompt('u2', 2_000)])
  assert.equal(startOfTurn(rows, 2_500), 2_500)
})

test('a turn nothing stamped counts from the prompt it is answering', () => {
  // The process attached mid-turn: the frame that opened it was published before anything here was
  // reading, and the prompt's own stamp is the same moment by the same clock.
  const rows = buildRows([prompt('u1', 1_000), prompt('u2', 2_000)])
  assert.equal(startOfTurn(rows, null), 2_000)
  // Nothing on screen names a start, which is not the same fact as a start of zero.
  assert.equal(startOfTurn(buildRows([]), null), null)
  assert.equal(startOfTurn(buildRows([prompt('u1', 0)]), null), null)
})

test('a clock ahead of this one reads as a turn that has just begun', () => {
  assert.equal(turnElapsedSeconds(1_000, 2_500), 1.5)
  assert.equal(turnElapsedSeconds(2_000, 2_000), 0)
  assert.equal(turnElapsedSeconds(3_000, 2_500), 0)
  assert.equal(turnElapsedSeconds(null, 2_500), null)
})

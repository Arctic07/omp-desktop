import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatMessage } from '../api/session-types.ts'
import { buildRows } from './conversation-rows.ts'

/**
 * The engine notice that becomes a row of the transcript: the idle recap.
 *
 * Its own file rather than a block in `conversation-rows.test.ts`, which is at the 1000-line ceiling
 * (`rules.md#single-file-line-limit`): the row shape here is the one fact that file has no room to
 * state, and it is a contract the pane relies on — a notice row that named a speaker or carried a
 * turn's footer would claim a turn the recap never took part in.
 *
 * What the row does *not* cover is how the frame gets here (`state/transcript.ts` routes a notice by
 * its code, `state/session-record.ts` keeps it out of the strip above the composer); those two are
 * tested beside the modules they live in.
 */

let clock = 0

function user(id: string, text: string): ChatMessage {
  clock += 1000
  return { kind: 'user', id, at: clock, text, attachments: [] }
}

function assistant(id: string, text: string): ChatMessage {
  clock += 1000
  return {
    kind: 'assistant',
    id,
    at: clock,
    text,
    thinking: '',
    error: null,
    startedAt: clock,
    endedAt: clock,
    usage: null,
    modelProvider: null,
    modelId: null,
  }
}

test('the idle recap is one row of its own, with no sender and no turn footer', () => {
  const rows = buildRows([
    user('u1', 'go'),
    assistant('a1', 'done'),
    { kind: 'notice', id: 'engine_recap-9', at: clock + 5000, text: 'The parser is fixed.', code: 'engine_recap' },
  ])

  const last = rows[rows.length - 1]
  assert.ok(last !== undefined && last.kind === 'single')
  assert.equal(last.message.kind, 'notice')
  assert.equal(last.namesSender, false)
  assert.equal(last.tail, null)
  assert.equal(last.ending, null)
  // It is its own row: the answer before it keeps the row it already had.
  assert.ok(rows.some((row) => row.kind === 'single' && row.message.kind === 'assistant'))
})

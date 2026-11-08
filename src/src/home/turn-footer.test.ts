import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatMessage } from '../api/session-types.ts'
import { buildRows, type TranscriptRow } from './conversation-rows.ts'

/**
 * When a turn's footer is drawn.
 *
 * The footer is the turn's record, so a turn still being written has none — and that is a fact about
 * *that* turn only. Suppressing every footer while a turn ran took a row's worth of height out of
 * every settled answer on each send, which moved the transcript thousands of pixels under a reader
 * at its foot (2026-11-05, user report: 消息发送会导致上面消息上下抖动).
 */

let clock = 1_700_000_000_000

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
    startedAt: null,
    endedAt: null,
    usage: null,
    modelProvider: 'moonshot',
    modelId: 'kimi-k2',
  }
}

const footers = (rows: TranscriptRow[]): boolean[] =>
  rows.map((row) => (row.kind === 'single' ? row.tail !== null : false))

test('a turn in flight leaves the settled turns’ footers alone', () => {
  const messages = [
    user('u1', 'first'),
    assistant('a1', 'first answer'),
    user('u2', 'second'),
    assistant('a2', 'second answer'),
  ]
  assert.deepEqual(footers(buildRows(messages)), [false, true, false, true])
  // Only the last turn — the one being written — has no footer while it runs.
  assert.deepEqual(footers(buildRows(messages, { streaming: true })), [false, true, false, false])
})

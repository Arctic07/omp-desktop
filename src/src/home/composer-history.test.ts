import assert from 'node:assert/strict'
import { test } from 'node:test'

import { composerHistory, stepHistoryWalk } from './composer-history.ts'
import type { ChatAttachmentRef, ChatMessage } from '../api/session-types.ts'

/**
 * What Up and Down walk: the reader's own prompts of one conversation, newest first, with the files
 * each carried. The reading is pure so the ordering, the notice stripping and the dedupe can be
 * checked without a browser.
 */

const shot: ChatAttachmentRef = {
  name: 'shot.png',
  path: 'C:\\work\\shot.png',
  mimeType: 'image/png',
  bytes: 128,
}

function user(text: string, attachments: ChatAttachmentRef[] = [], at = 0): ChatMessage {
  return { kind: 'user', id: `u${at}`, at, text, attachments }
}

test('prompts come back newest first', () => {
  const history = composerHistory([user('first', [], 1), user('second', [], 2), user('third', [], 3)])
  assert.deepEqual(history.map((entry) => entry.text), ['third', 'second', 'first'])
})

test('the files a prompt carried travel with it', () => {
  const history = composerHistory([user('look \ue001', [shot], 1)])
  assert.deepEqual(history, [{ text: 'look \ue001', attachments: [shot] }])
})

test('an engine notice wrapped into the turn is not the reader’s words', () => {
  const text = '<system-notice>reminder</system-notice>\n\nwhat I asked'
  const history = composerHistory([user(text, [], 1)])
  assert.deepEqual(history.map((entry) => entry.text), ['what I asked'])
})

test('a prompt repeated back to back is one entry', () => {
  const history = composerHistory([user('again', [], 1), user('again', [], 2)])
  assert.equal(history.length, 1)
})

test('a message with only engine notices is not offered', () => {
  const history = composerHistory([user('<system-notice>time passed</system-notice>', [], 1)])
  assert.deepEqual(history, [])
})

test('an emphasized prompt comes back as its words, without the model’s tag', () => {
  // A prompt wrapped in `<important>` is the reader's own text, so it is offered again — as the
  // words it was written in, not as a recall of the wrapper.
  const history = composerHistory([user('<important>ship the stop fix</important>', [], 1)])
  assert.deepEqual(history.map((entry) => entry.text), ['ship the stop fix'])
})

test('a walk starts only from an empty box, newest prompt first', () => {
  const entries = composerHistory([user('one', [], 1), user('two', [], 2)])
  const typed = { text: 'half written', records: [] as readonly never[] }
  assert.equal(stepHistoryWalk(null, entries, 'up', typed).kind, 'ignore')
  assert.equal(stepHistoryWalk(null, [], 'up', typed).kind, 'ignore')

  const first = stepHistoryWalk(null, entries, 'up', { text: '', records: [] })
  assert.equal(first.kind, 'show')
  if (first.kind !== 'show') return
  assert.equal(first.entry.text, 'two')
  assert.equal(first.walk.saved.text, '')
})

test('Up walks older, stops at the oldest, and Down walks back and restores the draft', () => {
  const entries = composerHistory([user('one', [], 1), user('two', [], 2), user('three', [], 3)])
  const first = stepHistoryWalk(null, entries, 'up', { text: '', records: [] })
  if (first.kind !== 'show') throw new Error('a walk should start')

  const second = stepHistoryWalk(first.walk, entries, 'up', { text: '', records: [] })
  if (second.kind !== 'show') throw new Error('a second Up should move')
  assert.equal(second.entry.text, 'two')

  const third = stepHistoryWalk(second.walk, entries, 'up', { text: '', records: [] })
  if (third.kind !== 'show') throw new Error('a third Up should move')
  assert.equal(third.entry.text, 'one')

  assert.equal(stepHistoryWalk(third.walk, entries, 'up', { text: '', records: [] }).kind, 'keep')

  const back = stepHistoryWalk(third.walk, entries, 'down', { text: '', records: [] })
  if (back.kind !== 'show') throw new Error('Down should move back')
  assert.equal(back.entry.text, 'two')

  const newest = stepHistoryWalk(back.walk, entries, 'down', { text: '', records: [] })
  if (newest.kind !== 'show') throw new Error('Down should reach the newest')
  assert.equal(newest.entry.text, 'three')

  assert.equal(stepHistoryWalk(newest.walk, entries, 'down', { text: '', records: [] }).kind, 'restore')
  assert.equal(stepHistoryWalk(null, entries, 'down', { text: '', records: [] }).kind, 'ignore')
})

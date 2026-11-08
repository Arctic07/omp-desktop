import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SessionSummary } from '../api/session-types.ts'
import { buildSidebarTree } from '../home/sidebar-tree.ts'
import { dropsFileOnRelease, rowWithSentMessage } from './session-rows.ts'
import { isUnwritten } from './transcript.ts'

/**
 * The row a conversation gets from a message the reader has just sent.
 *
 * The engine's file is what the list reads, and its acknowledgement comes back before the write —
 * so the reader reported a conversation that only appeared in the rail once its first turn was
 * stopped (2026-10-26). These cases pin the correction that answers it: a blank row this side has
 * written in is a row the rail draws — and carry the send's time, so a conversation the reader just
 * wrote in sorts to the top of the rail at once instead of when its answer ends (2026-10-29).
 *
 * The same `blank` flag is what keeps a conversation's file on the way out, so the cases at the end
 * pin that reading too: a rewound conversation answers "holds a message" where its record answers
 * "draft" (2026-11-03).
 */

function summary(id: string, blank: boolean, updatedAt: number): SessionSummary {
  return {
    id,
    title: '',
    cwd: 'D:/project',
    status: 'pending',
    updatedAt,
    filePath: `D:/sessions/${id}.jsonl`,
    compressed: false,
    pinned: false,
    archived: false,
    blank,
  }
}

function railRows(items: SessionSummary[], running: string[] = []): string[] {
  const tree = buildSidebarTree([{ id: 1, name: 'workspace' }], {
    sessions: { 1: { status: 'ready', error: null, items } },
    readMarks: {},
    runningSessionIds: new Set(running),
    finishedTurns: new Map(),
    timeLabel: () => '',
    untitledLabel: 'Untitled',
    sessionOrder: () => [],
    visibleCount: () => 10,
    showArchived: false,
  })
  const workspace = tree[0]
  return workspace?.children?.map((child) => child.id) ?? []
}

test('a blank row the reader has written in becomes the rail row of that conversation', () => {
  const row = rowWithSentMessage(summary('session-1', true, 1_000), 5_000)
  assert.equal(row.blank, false)
  // The message is the row's newest fact, not the empty file's creation: the conversation the
  // reader is in the middle of sorts by what they wrote, not by when the blank one was opened.
  assert.equal(row.updatedAt, 5_000)
  assert.deepEqual(railRows([row], [row.id]), ['ws-1:session-1'])
  // A scan's own time ahead of the local message stays: a clock that disagrees with the engine's must
  // not move a row backwards.
  assert.equal(rowWithSentMessage(summary('session-1', true, 9_000), 5_000).updatedAt, 9_000)
})

test('a conversation nothing was sent in keeps its blank row', () => {
  const row = summary('session-1', true, 1_000)
  assert.equal(rowWithSentMessage(row, null), row)
  assert.deepEqual(railRows([row]), [])
})

test('sending into an older conversation sorts it above the one that was newer', () => {
  const newer = summary('newer', false, 9_000)
  const older = summary('older', false, 1_000)
  assert.deepEqual(railRows([older, newer], ['older']), ['ws-1:newer', 'ws-1:older'])
  const bumped = rowWithSentMessage(older, 10_000)
  assert.equal(bumped.updatedAt, 10_000)
  assert.deepEqual(railRows([bumped, newer], ['older']), ['ws-1:older', 'ws-1:newer'])
})

test('a scan that read the row after the send is left as the scan read it', () => {
  const row = summary('session-1', false, 5_000)
  assert.equal(rowWithSentMessage(row, 5_000), row)
})

test('a conversation rewound to nothing keeps its file while the list still holds a message', () => {
  // The shape `rewindToEntry` leaves: the record reads exactly like a draft, and the file keeps
  // everything the rewind cut away - so the list read after that rewind says this conversation holds
  // a message. Handing the file back here is what deleted a reader's history (2026-11-03).
  const rewound = { engineEmpty: true, messages: [] as const }
  const row = summary('session-1', false, 5_000)
  assert.equal(isUnwritten(rewound.engineEmpty, rewound.messages), true, 'the record is a draft')
  assert.equal(dropsFileOnRelease(rewound, row), false, 'and the file is not')
})

test('a draft the list has read as blank is given back with its file', () => {
  assert.equal(dropsFileOnRelease({ engineEmpty: true, messages: [] }, summary('s', true, 1_000)), true)
})

test('a conversation the list has not read yet keeps the answer it had', () => {
  // A draft opened since the last scan has no row at all: nothing said it holds anything.
  assert.equal(dropsFileOnRelease({ engineEmpty: true, messages: [] }, undefined), true)
})

test('a conversation holding rows is never given back with its file', () => {
  const record = {
    engineEmpty: false,
    messages: [{ kind: 'user' as const, id: 'm1', at: 1, text: 'hi', attachments: [] }],
  }
  assert.equal(dropsFileOnRelease(record, summary('s', false, 1_000)), false)
})

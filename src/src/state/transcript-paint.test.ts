import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatMessage } from '@/api/session-types'
import {
  EMPTY_PAINTED_WALK,
  paintHistoryPage,
  type PaintedWalk,
} from './transcript-paint.ts'

/** The rows a walk painted, as ids: what the screen is showing. */
function ids(rows: readonly ChatMessage[]): string[] {
  return rows.map((row) => row.id)
}

function user(id: string): ChatMessage {
  return {
    kind: 'user',
    id,
    at: 1,
    text: id,
    attachments: [],
  }
}

function page(idsToPaint: string[], reset = false) {
  return {
    kind: 'rows' as const,
    messages: idsToPaint.map(user),
    loaded: 0,
    total: 0,
    ...(reset ? { reset: true } : {}),
  }
}

test('a walk appends the pages it is given, and the screen holds what it painted', () => {
  let walk: PaintedWalk = EMPTY_PAINTED_WALK
  let onScreen: ChatMessage[] = []

  const first = paintHistoryPage(onScreen, walk, page(['m1', 'm2']))
  assert.deepEqual(ids(first.show ?? []), ['m1', 'm2'])
  walk = first.walk
  onScreen = first.show ?? []

  const second = paintHistoryPage(onScreen, walk, page(['m3']))
  assert.deepEqual(ids(second.show ?? []), ['m1', 'm2', 'm3'])
  assert.equal(second.walk.painting, true)
})

test('a page with no rows leaves the screen as it is', () => {
  const walk: PaintedWalk = { rows: [user('m1')], painting: true }
  const result = paintHistoryPage(walk.rows, walk, page([]))
  assert.equal(result.show, null)
  assert.equal(result.walk, walk)
})

test('a restarted walk replaces its own rows and drops the stale ones', () => {
  const walk: PaintedWalk = { rows: [user('m1'), user('m2')], painting: true }
  const result = paintHistoryPage(walk.rows, walk, page([], true))
  assert.deepEqual(result.show, [])
  assert.equal(result.walk.painting, true)
})

test('nothing is painted once something else wrote rows on screen', () => {
  // The reader sent a prompt while the transcript was still loading: its row is on screen and is not
  // one this walk painted.
  const walk: PaintedWalk = { rows: [user('m1')], painting: true }
  const onScreen = [...walk.rows, user('local:prompt')]

  const result = paintHistoryPage(onScreen, walk, page(['m2']))
  assert.equal(result.show, null, 'the page must not replace the prompt')
  assert.deepEqual(ids(result.walk.rows), ['m1'])
  assert.equal(result.walk.painting, false)

  // And it stays stopped.
  const later = paintHistoryPage(onScreen, result.walk, page(['m3']))
  assert.equal(later.show, null)
})

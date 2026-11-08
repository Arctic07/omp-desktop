import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  RETAINED_PANEL_SESSIONS,
  counterAfterWrite,
  sessionsOverBound,
} from './panel-bound.ts'

/**
 * The work column's ceiling, and the id counters it resets.
 *
 * What is pinned down: which conversations the column lets go of (the ones visited longest ago, and
 * never the one on screen), and when a tab id may be reused (only once nothing names a conversation
 * any more). The release path itself — `forgetSession` closing shells — is not re-tested here;
 * what it does to a conversation is covered where the column's actions are.
 */

/** A visit ranking: later in the list is more recent, which is what `session-visits` holds. */
function ranker(ordered: readonly string[]): (sessionId: string) => number {
  return (sessionId) => ordered.indexOf(sessionId)
}

test('a column inside the bound releases nothing', () => {
  const owners = Array.from({ length: RETAINED_PANEL_SESSIONS }, (_, index) => `session-${index}`)
  assert.deepEqual(sessionsOverBound(owners, owners[0], ranker(owners)), [])
})

test('one conversation over the bound is the one visited longest ago', () => {
  const owners = Array.from({ length: RETAINED_PANEL_SESSIONS + 1 }, (_, index) => `session-${index}`)
  // Every conversation visited in order, so `session-0` is the oldest visit and the last is the
  // one the reader was just in.
  assert.deepEqual(sessionsOverBound(owners, `session-${RETAINED_PANEL_SESSIONS}`, ranker(owners)), [
    'session-0',
  ])
})

test('the conversation on screen is never released, however long ago it was visited', () => {
  const owners = Array.from({ length: RETAINED_PANEL_SESSIONS + 2 }, (_, index) => `session-${index}`)
  const releasing = sessionsOverBound(owners, 'session-0', ranker(owners))
  assert.equal(releasing.length, 2)
  assert.ok(!releasing.includes('session-0'), 'the reader is looking at it')
  assert.deepEqual(releasing, ['session-1', 'session-2'], 'the next two oldest go instead')
})

test('a conversation this process never visited is shed before one it has', () => {
  const visited = Array.from({ length: RETAINED_PANEL_SESSIONS }, (_, index) => `session-${index}`)
  const owners = ['session-never-visited', ...visited]
  // `session-visits` answers -1 for a conversation it has no rank for, which sorts it first.
  assert.deepEqual(sessionsOverBound(owners, null, ranker(visited)), ['session-never-visited'])
})

test('a counter goes back to its first value once no conversation is named', () => {
  assert.equal(counterAfterWrite(9_000, [{}, {}, {}]), 1)
})

test('a counter keeps climbing while any map names a conversation', () => {
  assert.equal(counterAfterWrite(9_000, [{}, { 'session-1': null }, {}]), 9_000)
})

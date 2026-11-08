import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BackgroundJob } from '../api/session-types.ts'
import {
  autoReclaimDue,
  isReclaimable,
  silenceOf,
  STALL_RECLAIM_MS,
  type StallReadings,
} from './stall-rules.ts'

/**
 * The one decision that may end a turn from outside: what counts as a stuck conversation.
 *
 * What is pinned down here is the narrowness, because the cost of a wrong answer is a forced stop:
 * a working turn with a background service, a retry, a waiting dialog or a live child must never
 * read as stuck, and a conversation that has stopped producing frames must.
 */

const TURN = 1_700_000_000_000

function readings(overrides: Partial<StallReadings> & Partial<NonNullable<StallReadings['runtime']>> = {}): StallReadings {
  const {
    turnId = 'turn-1',
    dialogs = [],
    runtime = {},
    ...runtimeOverrides
  } = overrides
  return {
    turnId,
    dialogs,
    runtime: { isStreaming: true, ...runtime, ...runtimeOverrides },
  }
}

const JOB: BackgroundJob = { id: 'job-1', type: 'bash', label: 'pnpm dev', startedAt: TURN }

test('a turn with nothing else in flight is reclaimable', () => {
  assert.equal(isReclaimable(readings()), true)
  // The host's own `isStreaming` is enough: a conversation attached mid-turn has no `turnId` here.
  assert.equal(isReclaimable(readings({ turnId: null })), true)
})

test('a detached job, a live child, a retry or a waiting dialog is not a stuck turn', () => {
  assert.equal(isReclaimable(readings({ backgroundJobs: [JOB] })), false)
  assert.equal(isReclaimable(readings({ cancellableSubagents: 2 })), false)
  assert.equal(isReclaimable(readings({ pendingAsyncWork: true })), false)
  assert.equal(
    isReclaimable(
      readings({ retry: { attempt: 2, maxAttempts: 10, delayMs: 500, errorMessage: null } }),
    ),
    false,
  )
  assert.equal(isReclaimable(readings({ dialogs: [{ id: 'q1' }] })), false)
})

test('an idle conversation is never reclaimed, however long it has been quiet', () => {
  assert.equal(isReclaimable(readings({ turnId: null, runtime: { isStreaming: false } })), false)
  assert.equal(isReclaimable({ turnId: null, dialogs: [], runtime: null }), false)
})

test('silence is measured from the later of this process and the host', () => {
  const now = TURN + 5 * 60_000
  assert.equal(silenceOf(readings({ runtime: { lastEventAt: TURN } }), 0, now), 5 * 60_000)
  // A frame this process saw after the host's snapshot is the newer fact.
  assert.equal(
    silenceOf(readings({ runtime: { lastEventAt: TURN } }), TURN + 4 * 60_000, now),
    60_000,
  )
  // Neither ever reported anything: there is no silence to measure rather than an infinite one.
  assert.equal(silenceOf(readings({ runtime: { lastEventAt: 0 } }), 0, now), 0)
})

test('the automatic stop runs past the window for a conversation nobody is looking at', () => {
  const due = (silence: number, snoozeUntil = 0) =>
    autoReclaimDue({ silence, snoozeUntil, now: TURN, onScreen: false })
  assert.equal(due(STALL_RECLAIM_MS), true)
  assert.equal(due(STALL_RECLAIM_MS - 1), false)
  // A *keep waiting* still silences the automatic step.
  assert.equal(due(STALL_RECLAIM_MS, TURN + 1), false)
})

test('the conversation on screen is never taken down automatically', () => {
  // The reader is there and the row is theirs to answer: a slow provider request must not be
  // mistaken for a wedged turn and force-stopped under them (2026-11-02, user report).
  const due = (silence: number) =>
    autoReclaimDue({ silence, snoozeUntil: 0, now: TURN, onScreen: true })
  assert.equal(due(STALL_RECLAIM_MS), false)
  assert.equal(due(24 * 60 * 60_000), false)
})

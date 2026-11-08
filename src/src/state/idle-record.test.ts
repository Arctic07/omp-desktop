import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BackgroundJob, SessionRetry } from '../api/session-types.ts'
import { asIdle, type WorkReadings } from './idle-record.ts'

/**
 * What a conversation reads as after the authority says nothing is in flight.
 *
 * The case pinned here is the one the reader reported (2026-10-26): an answer finished, the screen
 * kept drawing 「工作中… 31m」 over it, and four presses of the stop each answered 「已经没有可以停止
 * 的工作了」. The host's `aborted:false` is a reading of the truth, so every reading that still said
 * "running" was stale - and nothing else was ever going to lower them, because the ending frame that
 * would have done it had already been missed.
 *
 * The opposite is pinned just as hard: a record with anything genuinely in flight is left alone, so
 * this rule can never lower a conversation a stop would have acted on.
 */

const JOB: BackgroundJob = { id: 'job-1', type: 'bash', label: 'pnpm dev', startedAt: 1 }
const RETRY: SessionRetry = { attempt: 2, maxAttempts: 10, delayMs: 500, errorMessage: null }

function running(overrides: Partial<WorkReadings> = {}, runtime: Partial<NonNullable<WorkReadings['runtime']>> = {}): WorkReadings {
  return {
    turnId: 'turn-1',
    turnStartedAt: 1_000,
    stopRequested: false,
    runtime: {
      isStreaming: true,
      pendingAsyncWork: false,
      cancellableSubagents: 0,
      ...runtime,
    },
    ...overrides,
  }
}

test('a stale streaming reading is lowered with the turn it belonged to', () => {
  const idle = asIdle(running())
  assert.equal(idle.turnId, null)
  assert.equal(idle.turnStartedAt, null)
  assert.equal(idle.runtime?.isStreaming, false)
})

test('a record attached mid-turn has no turn id, and its snapshot is lowered too', () => {
  // The screen that reported this bug had been reloaded mid-turn, so it held no `turn_started` of
  // its own: the snapshot was the only reading that said "running".
  const idle = asIdle(running({ turnId: null, turnStartedAt: null }))
  assert.equal(idle.runtime?.isStreaming, false)
})

test('every facet a stop would have acted on goes with it', () => {
  const idle = asIdle(
    running({}, { retry: RETRY, pendingAsyncWork: true, cancellableSubagents: 2, backgroundJobs: [JOB] }),
  )
  assert.equal(idle.runtime?.isStreaming, false)
  assert.equal(idle.runtime?.retry, undefined)
  assert.equal(idle.runtime?.pendingAsyncWork, false)
  assert.equal(idle.runtime?.cancellableSubagents, 0)
  assert.deepEqual(idle.runtime?.backgroundJobs, [])
})

test('the stop mark goes with the turn it was taken for', () => {
  assert.equal(asIdle(running({ stopRequested: true })).stopRequested, false)
})

test('a record already at rest is answered as itself, so no render is spent on it', () => {
  const rest: WorkReadings = {
    turnId: null,
    turnStartedAt: null,
    stopRequested: false,
    runtime: { isStreaming: false, pendingAsyncWork: false, cancellableSubagents: 0 },
  }
  assert.equal(asIdle(rest), rest)
  const bare: WorkReadings = { turnId: null, turnStartedAt: null, stopRequested: false, runtime: null }
  assert.equal(asIdle(bare), bare)
})

test('a clock left behind by an ending still counts as something to lower', () => {
  // `turnStartedAt` is cleared by the same frame as `turnId`, so one without the other is the shape
  // a lost ending leaves: the row counts a turn nothing else remembers.
  const idle = asIdle(running({ turnId: null }))
  assert.equal(idle.turnStartedAt, null)
})

test('the snapshot is copied rather than edited in place', () => {
  const before = running()
  const snapshot = before.runtime
  asIdle(before)
  assert.equal(snapshot?.isStreaming, true)
  assert.equal(before.turnId, 'turn-1')
})

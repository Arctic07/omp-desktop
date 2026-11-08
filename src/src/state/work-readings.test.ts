import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isStoppable, isWorking, runningSessionsKey } from './work-readings.ts'

/**
 * Which conversations the rail draws as running, what the field's stop is drawn on, and what that
 * mark may be built from.
 *
 * A conversation whose answer is finished is not running, however much work it still holds: a dev
 * server someone started, a detached `task` batch and a child a stop could still cancel all keep the
 * *session* alive long after the turn, and none of them is the engine answering (2026-10-30, user
 * report: 输出完毕了 左侧对话还是显示运行中图标). The readings therefore part company here — the
 * lifetime gate stays wide, the mark is the turn, and the field's stop is the agent still answering
 * (the turn or a live child), never a plain background job (2026-11-03, user report: 结束了但是输入框
 * 还是agent输出中的样子). These cases pin that split.
 */

type Readable = Parameters<typeof isWorking>[0]

function idle(overrides: Partial<NonNullable<Readable['runtime']>> = {}): Readable {
  return {
    turnId: null,
    runtime: { isStreaming: false, pendingAsyncWork: false, cancellableSubagents: 0, ...overrides },
  }
}

test('a conversation whose turn ended is not running, even with work still alive', () => {
  const leftoverServer = idle({ pendingAsyncWork: true })
  const leftoverChildren = idle({ cancellableSubagents: 2 })
  const both = idle({ pendingAsyncWork: true, cancellableSubagents: 1 })

  assert.equal(runningSessionsKey({ leftoverServer, leftoverChildren, both }), '')
  // The session is still held all the same: letting go of it would kill what it is running.
  assert.equal(isWorking(leftoverServer), true)
  assert.equal(isWorking(leftoverChildren), true)
  assert.equal(isWorking(both), true)
})

test('a turn in flight is the mark, whether it opened here or was joined', () => {
  const openedHere: Readable = { turnId: 't1', runtime: { isStreaming: false } }
  const joinedMidTurn: Readable = { turnId: null, runtime: { isStreaming: true } }

  assert.equal(isWorking(openedHere), true)
  assert.equal(runningSessionsKey({ openedHere, joinedMidTurn }), 'joinedMidTurn,openedHere')
  // A turn this process opened stays running until its ending arrives, whatever the snapshot says:
  // the snapshot is published on a turn's edges and can be older than the turn itself.
  assert.equal(runningSessionsKey({ openedHere }), 'openedHere')
})

test('an idle conversation is not kept open and is not marked', () => {
  const settled = idle()

  assert.equal(isWorking(settled), false)
  assert.equal(runningSessionsKey({ settled }), '')
})

test('the field stops the answer, never a background job that outlives it', () => {
  const devServer = idle({
    backgroundJobs: [{ id: 'job-1', type: 'bash', label: 'pnpm dev', startedAt: 1 }],
  })

  // The job ends through its own row in the conversation's background block, not through the field:
  // drawing the stop here is what left a finished turn looking like it was still being written.
  assert.equal(isStoppable(devServer), false)
  assert.equal(runningSessionsKey({ devServer }), '')

  assert.equal(isStoppable({ turnId: 't1', runtime: { isStreaming: true } }), true)
  assert.equal(isStoppable({ turnId: null, runtime: { isStreaming: true } }), true)
  // A `task` child is the agent answering in another branch and has no stop row of its own.
  assert.equal(isStoppable(idle({ cancellableSubagents: 1 })), true)
  assert.equal(isStoppable(null), false)
})

test('the key is a stable string, so the rail only redraws when the membership changes', () => {
  const running: Readable = { turnId: 't1', runtime: { isStreaming: true } }
  const quiet = idle()
  const once = runningSessionsKey({ b: running, a: quiet })
  const again = runningSessionsKey({ a: quiet, b: running })

  assert.equal(once, 'b')
  assert.equal(again, once)
})

test('a compaction is work, and it is stoppable, even with no turn streaming', () => {
  // `/compact` and `/handoff` spend a model call with the turn bit idle. The session has to stay
  // open for them — a close or an eviction would dispose the engine mid-pass — and the field has to
  // offer the stop, because `session_abort` reaches the engine's own `abortCompaction`.
  const compacting = idle({ isCompacting: true })
  assert.equal(isWorking(compacting), true)
  assert.equal(isStoppable(compacting), true)
  // The rail's mark is still the turn: a compaction is not an answer being written.
  assert.equal(runningSessionsKey({ compacting }), '')
  assert.equal(isWorking(idle()), false)
})

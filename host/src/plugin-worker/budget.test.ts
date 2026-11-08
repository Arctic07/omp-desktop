import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_FRAME_BYTES,
  PLUGIN_WORKER_INVOKES_PER_SECOND,
  PLUGIN_WORKER_INVOKE_WINDOW_MS,
  PLUGIN_WORKER_MAX_PENDING_INVOKES,
} from '../constants.ts'
import { InvokeBudget } from './budget.ts'
import { encodeWorkerFrame, parseWorkerFrame, settlementFrame, workerFrameBytes, workerLogFrame } from './frames.ts'

/** The two budgets: unanswered invokes, and the rolling-second pace. */

test('the 65th unanswered invoke is refused and a release makes room again', () => {
  const budget = new InvokeBudget()
  for (let index = 0; index < PLUGIN_WORKER_MAX_PENDING_INVOKES; index += 1) {
    assert.equal(budget.take(0).ok, true, `invoke ${index + 1}`)
  }
  const refused = budget.take(0)
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false ? refused.code : null, 'too_many_requests')
  budget.release()
  assert.equal(budget.take(0).ok, true)
})

test('the 201st invoke inside one second is refused, and the window resets after it', () => {
  const budget = new InvokeBudget()
  for (let index = 0; index < PLUGIN_WORKER_INVOKES_PER_SECOND; index += 1) {
    assert.equal(budget.take(0).ok, true, `invoke ${index + 1}`)
    budget.release()
  }
  const refused = budget.take(0)
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false ? refused.code : null, 'too_many_requests')
  assert.equal(budget.used(0), PLUGIN_WORKER_INVOKES_PER_SECOND)
  // One millisecond past the window, every old timestamp has fallen out.
  assert.equal(budget.take(PLUGIN_WORKER_INVOKE_WINDOW_MS + 1).ok, true)
})

test('a frame round-trips with its own fields, and an unreadable line is not a frame', () => {
  const frame = { type: 'worker_call', id: 'c1', method: 'command.execute', params: { commandId: 'a.b' } }
  const line = encodeWorkerFrame(frame)
  assert.notEqual(line, null)
  assert.deepEqual(parseWorkerFrame(line as string), frame)
  assert.equal(parseWorkerFrame('not json'), null)
  assert.equal(parseWorkerFrame('[1,2]'), null)
  assert.equal(parseWorkerFrame('{"id":"x"}'), null)
})

test('a frame over the ceiling is refused at encode time, not truncated', () => {
  const huge = 'x'.repeat(MAX_FRAME_BYTES)
  assert.equal(encodeWorkerFrame({ type: 'worker_result', id: 'c1', ok: true, value: huge }), null)
  assert.equal(workerFrameBytes('{"type":"worker_log"}') > 0, true)
})

test('a settlement carries only the fields its outcome names', () => {
  assert.deepEqual(settlementFrame('worker_result', 'c1', { ok: true }), { type: 'worker_result', id: 'c1', ok: true })
  assert.deepEqual(settlementFrame('worker_result', 'c1', { ok: true, value: null }), { type: 'worker_result', id: 'c1', ok: true, value: null })
  assert.deepEqual(
    settlementFrame('worker_result', 'c1', { ok: false, code: 'plugin_error', message: 'boom' }),
    { type: 'worker_result', id: 'c1', ok: false, code: 'plugin_error', message: 'boom' },
  )
  // A stray value on a refusal is not published: a failed answer carries a reason, not a payload.
  assert.deepEqual(settlementFrame('worker_result', 'c1', { ok: false, value: 1, code: 'x' }), { type: 'worker_result', id: 'c1', ok: false, code: 'x' })
})

test('a worker log line has its control characters replaced and its length bounded', () => {
  const frame = workerLogFrame('warn', 'one\ntwo\u0000three')
  assert.equal(frame.message, 'one two three')
  const long = workerLogFrame('info', 'x'.repeat(5_000))
  assert.equal(typeof long.message === 'string' ? long.message.length : 0, 1_024)
})

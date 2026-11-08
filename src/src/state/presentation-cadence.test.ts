/**
 * The cadence the shared beat folds at.
 *
 * What is asserted here is the one decision the beat makes about a window the reader can see
 * (`state/presentation.ts`): a conversation an opaque page covers is folded on the hidden cadence,
 * not on the display clock. The clock is mocked, so an assertion is about which delay the beat asked
 * for rather than how long a timer really took.
 *
 * Every case first settles the beat under the real clock: a pending tick's cancel closure belongs to
 * whichever clock created it, so a case that started with one left by the previous case would be
 * measuring the mock's bookkeeping instead of the beat.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  flushPresent,
  isPresentCovered,
  onPresent,
  schedulePresent,
  setPresentCovered,
} from './presentation.ts'

test('an uncovered window folds what arrived on the display clock', (t) => {
  flushPresent()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let folds = 0
  const stop = onPresent(() => {
    folds += 1
  })
  setPresentCovered(false)
  flushPresent()
  folds = 0
  schedulePresent()
  t.mock.timers.tick(0)
  assert.equal(folds, 1)
  stop()
  flushPresent()
})

test('a covered window waits out the hidden cadence, then folds', (t) => {
  flushPresent()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let folds = 0
  const stop = onPresent(() => {
    folds += 1
  })
  setPresentCovered(true)
  assert.equal(isPresentCovered(), true)
  flushPresent()
  folds = 0
  schedulePresent()
  t.mock.timers.tick(249)
  assert.equal(folds, 0, 'a covered page must not fold on the display clock')
  t.mock.timers.tick(1)
  assert.equal(folds, 1, 'the backlog still lands, a quarter second later')
  stop()
  setPresentCovered(false)
  flushPresent()
})

test('uncovering re-aims the pending fold at the display clock', (t) => {
  flushPresent()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let folds = 0
  const stop = onPresent(() => {
    folds += 1
  })
  setPresentCovered(true)
  flushPresent()
  folds = 0
  schedulePresent()
  setPresentCovered(false)
  t.mock.timers.tick(0)
  assert.equal(folds, 1)
  stop()
  flushPresent()
})

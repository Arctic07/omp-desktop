import assert from 'node:assert/strict'
import { test } from 'node:test'

import { greetingSlot } from './new-chat.ts'

/**
 * The blank conversation's greeting buckets. The clock is the only input, so the four boundaries are
 * the whole rule: a bucket that starts one hour early or late is a greeting that disagrees with the
 * hour the reader is living in.
 */

test('each bucket begins at its own hour', () => {
  assert.equal(greetingSlot(5), 'morning')
  assert.equal(greetingSlot(12), 'afternoon')
  assert.equal(greetingSlot(18), 'evening')
  assert.equal(greetingSlot(23), 'night')
})

test('each bucket ends one hour before the next begins', () => {
  assert.equal(greetingSlot(11), 'morning')
  assert.equal(greetingSlot(17), 'afternoon')
  assert.equal(greetingSlot(22), 'evening')
})

test('the night bucket wraps around midnight', () => {
  assert.equal(greetingSlot(0), 'night')
  assert.equal(greetingSlot(4), 'night')
  // A day is 24 hours: 24 is the same hour as 0, not the next day's morning.
  assert.equal(greetingSlot(24), 'night')
})

test('an hour outside a day is read as the hour it is', () => {
  // `Date#getHours()` is always 0–23, but an offset clock handed in by a caller should still land in
  // a bucket rather than falling through to none.
  assert.equal(greetingSlot(-1), 'night')
  assert.equal(greetingSlot(29), 'morning')
})

test('a value that is not an hour is read as midnight', () => {
  assert.equal(greetingSlot(Number.NaN), 'night')
  assert.equal(greetingSlot(Number.POSITIVE_INFINITY), 'night')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  forgetSessionActivity,
  lastSessionActivity,
  noteSessionActivity,
  onSessionHeard,
} from './session-activity.ts'

/**
 * What one arrival owes its subscribers.
 *
 * The clock is read by the stall watcher, and an arrival is what the same watcher ends a stall row
 * on, so the two are one event with two answers: the timestamp and the callback. A subscription
 * that outlives its watcher would take rows down for a surface nobody runs, and a subscriber that
 * throws would leave the clock stale for every other reader — neither is observable from the
 * stall module's own tests, which is why the listener's contract is pinned here.
 */

test('an arrival moves the clock and reaches every subscriber with the conversation', () => {
  const seen: string[] = []
  const stopFirst = onSessionHeard((sessionId) => {
    seen.push(`first:${sessionId}`)
  })
  const stopSecond = onSessionHeard((sessionId) => {
    seen.push(`second:${sessionId}`)
  })
  try {
    noteSessionActivity('session-a', 1000)
    noteSessionActivity('session-b', 2000)
    assert.equal(lastSessionActivity('session-a'), 1000)
    assert.equal(lastSessionActivity('session-b'), 2000)
  } finally {
    stopFirst()
    stopSecond()
  }
  assert.deepEqual(seen, [
    'first:session-a',
    'second:session-a',
    'first:session-b',
    'second:session-b',
  ])
})

test('an unsubscribed listener hears nothing after it leaves', () => {
  const seen: string[] = []
  const stop = onSessionHeard((sessionId) => seen.push(sessionId))
  noteSessionActivity('heard-while-subscribed')
  stop()
  noteSessionActivity('arrived-after-stop')
  assert.deepEqual(seen, ['heard-while-subscribed'])
})

test('a throwing subscriber neither starves the clock nor the other subscribers', () => {
  const seen: string[] = []
  const quiet = console.error
  const errors: unknown[][] = []
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  const stopBroken = onSessionHeard(() => {
    throw new Error('this subscriber is broken')
  })
  const stopHealthy = onSessionHeard((sessionId) => seen.push(sessionId))
  try {
    assert.doesNotThrow(() => noteSessionActivity('session-c', 3000))
  } finally {
    stopBroken()
    stopHealthy()
    console.error = quiet
  }
  assert.equal(lastSessionActivity('session-c'), 3000, 'the clock is written whatever a listener did')
  assert.deepEqual(seen, ['session-c'])
  assert.equal(errors.length, 1, 'and the failure is still reported')
  forgetSessionActivity('session-c')
})

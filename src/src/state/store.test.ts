import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createStore } from './store.ts'

/**
 * What one store write owes its subscribers.
 *
 * A write fans out to every subscriber, and those subscribers are arbitrary: React's own listener,
 * a selector, a surface that reads the state on every change. One of them throwing is a failure of
 * that subscriber, not of the write — the state is already the new one, and a writer that goes on to
 * do something else after `set` (the composer appends the reader's row and then sends the prompt)
 * must not be stopped by it.
 */

test('a throwing subscriber neither starves the others nor fails the write', () => {
  const store = createStore(0)
  const seen: number[] = []
  const quiet = console.error
  const errors: unknown[][] = []
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  try {
    store.subscribe(() => {
      seen.push(1)
    })
    store.subscribe(() => {
      throw new Error('this subscriber is broken')
    })
    store.subscribe(() => {
      seen.push(3)
    })
    assert.doesNotThrow(() => store.set(1))
  } finally {
    console.error = quiet
  }
  assert.equal(store.get(), 1)
  assert.equal(seen.length, 2, 'the two healthy subscribers both heard the write')
  assert.equal(errors.length, 1, 'and the failure is still reported')
})

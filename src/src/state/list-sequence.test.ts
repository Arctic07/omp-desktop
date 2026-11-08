import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createListSequence } from './list-sequence.ts'

/**
 * What the rail's list reads owe each other.
 *
 * The reads overlap — a turn edge, the window coming back and a conversation opening all ask — and
 * the answers can come back in either order. An older scan that lands last describes the store as
 * it was *before* the newer one was answered, so writing it drops rows the newer answer carried and
 * leaves the rail missing them until some later read. Only the newest answer may write.
 */

test('an answer a newer read has already superseded does not write', () => {
  const sequence = createListSequence()
  const older = sequence.start()
  const newer = sequence.start()

  assert.equal(sequence.accept(1, newer), true, 'the newer answer writes')
  assert.equal(
    sequence.accept(1, older),
    false,
    'the older answer lands last and is dropped rather than taking the row back',
  )
})

test('answers that land in the order they were asked for both write', () => {
  const sequence = createListSequence()
  const older = sequence.start()
  const newer = sequence.start()

  assert.equal(sequence.accept(1, older), true)
  assert.equal(sequence.accept(1, newer), true, 'the newer answer is still the newest fact')
})

test('the same ticket never writes twice', () => {
  const sequence = createListSequence()
  const ticket = sequence.start()

  assert.equal(sequence.accept(1, ticket), true)
  assert.equal(sequence.accept(1, ticket), false, 'a retried write is not a newer read')
})

test('one workspace\u2019s order says nothing about another\u2019s', () => {
  const sequence = createListSequence()
  const first = sequence.start()
  const second = sequence.start()

  assert.equal(sequence.accept(1, second), true)
  assert.equal(
    sequence.accept(2, first),
    true,
    'a read of another list is its own answer, whatever this one has applied',
  )
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_QUEUED_PROMPTS,
  dropQueuedPrompt,
  enqueuePrompt,
  forgetQueuedPrompts,
  queuedFor,
  requeuePrompt,
  resolveSubmitMode,
  takeQueuedHead,
  type QueuedPrompt,
} from './prompt-queue.ts'

/**
 * A queue built the way the store builds one: ids handed out in order, and no files unless the case
 * being tested is about them.
 */
function queueOf(...messages: [string, string][]): QueuedPrompt[] {
  let queue: QueuedPrompt[] = []
  messages.forEach(([sessionId, text], index) => {
    const next = enqueuePrompt(queue, sessionId, text, [], index + 1)
    assert.notEqual(next, null)
    queue = next as QueuedPrompt[]
  })
  return queue
}

test('a prompt with nothing running is a plain one, whatever the preference or the chord', () => {
  assert.equal(resolveSubmitMode('queue', false, 'enter'), 'send')
  assert.equal(resolveSubmitMode('queue', false, 'accelerated'), 'send')
  assert.equal(resolveSubmitMode('interrupt', false, 'enter'), 'send')
  assert.equal(resolveSubmitMode('interrupt', false, 'accelerated'), 'send')
})

test('while a turn runs plain Enter follows the preference and the chord takes the other mode', () => {
  // Waiting is the preference: plain Enter queues it, and Ctrl/Cmd steers into the turn instead.
  assert.equal(resolveSubmitMode('queue', true, 'enter'), 'queue')
  assert.equal(resolveSubmitMode('queue', true, 'accelerated'), 'steer')
  // Interrupting is the preference: the two swap, and neither gesture is left without a meaning.
  assert.equal(resolveSubmitMode('interrupt', true, 'enter'), 'steer')
  assert.equal(resolveSubmitMode('interrupt', true, 'accelerated'), 'queue')
})

test('a session holds a bounded number of messages and refuses the next', () => {
  let queue: QueuedPrompt[] = []
  for (let index = 0; index < MAX_QUEUED_PROMPTS; index += 1) {
    const next = enqueuePrompt(queue, 'a', `message ${index}`, [], index + 1)
    assert.notEqual(next, null)
    queue = next as QueuedPrompt[]
  }
  assert.equal(enqueuePrompt(queue, 'a', 'one too many', [], 99), null)
  assert.equal(queue.length, MAX_QUEUED_PROMPTS)
  // Another session's own ceiling is untouched by the first one being full.
  assert.notEqual(enqueuePrompt(queue, 'b', 'elsewhere', [], 100), null)
})

test('a queued message keeps the files it was written with', () => {
  const files = [{ name: 'a.png', path: 'C:\\work\\a.png', mimeType: 'image/png', bytes: 12 }]
  const queued = enqueuePrompt([], 'a', 'look at this', files, 1)

  assert.notEqual(queued, null)
  const head = takeQueuedHead(queued as QueuedPrompt[], 'a').head
  // The row carries them, not the composer that wrote it: the field's own list is cleared the moment
  // the message is queued, so a row that pointed at it would lose its files on the way out.
  assert.deepEqual(head?.attachments, files)
})

test('a turn end releases exactly the head row, and the one after it waits for the next turn', () => {
  let queue = queueOf(['a', 'first'], ['b', 'other'], ['a', 'second'], ['a', 'third'])

  const first = takeQueuedHead(queue, 'a')
  assert.equal(first.head?.text, 'first')
  queue = first.queue

  // One row per turn end: the second is still waiting until the turn the first opened ends.
  assert.deepEqual(
    queue.map((prompt) => prompt.text),
    ['other', 'second', 'third'],
  )

  const second = takeQueuedHead(queue, 'a')
  assert.equal(second.head?.text, 'second')
  assert.deepEqual(
    second.queue.map((prompt) => prompt.text),
    ['other', 'third'],
  )
})

test('a turn end over a session with nothing waiting releases nothing', () => {
  const queue = queueOf(['a', 'first'])

  const empty = takeQueuedHead(queue, 'b')
  assert.equal(empty.head, null)
  assert.deepEqual(
    empty.queue.map((prompt) => prompt.text),
    ['first'],
  )
  // Taking is also the release, so the same turn ending twice finds nothing to send again.
  assert.equal(takeQueuedHead(takeQueuedHead(queue, 'a').queue, 'a').head, null)
})

test('one message can be dropped while its neighbours stay', () => {
  const queue = queueOf(['a', 'first'], ['a', 'second'])

  const next = dropQueuedPrompt(queue, queue[0].id)

  assert.deepEqual(
    next.map((prompt) => prompt.text),
    ['second'],
  )
})

test('forgetting a session releases every one of its messages', () => {
  const queue = queueOf(['a', 'first'], ['b', 'other'], ['a', 'second'])

  assert.deepEqual(
    forgetQueuedPrompts(queue, 'a').map((prompt) => prompt.sessionId),
    ['b'],
  )
})

test('one session is read out of the queue without touching the rest', () => {
  const queue = queueOf(['a', 'first'], ['b', 'other'])

  assert.deepEqual(
    queuedFor(queue, 'a').map((prompt) => prompt.text),
    ['first'],
  )
  assert.deepEqual(queuedFor(queue, 'c'), [])
})

test('a taken head row goes back ahead of its session rows, and no other session moves', () => {
  const queue = queueOf(['a', 'first'], ['b', 'other'], ['a', 'second'])
  const taken = queue[0]

  const next = requeuePrompt(dropQueuedPrompt(queue, taken.id), taken)

  // Its own queue reads as it did — first, then the row that was behind it — and the other
  // session's waiting row keeps its place.
  assert.deepEqual(
    queuedFor(next, 'a').map((prompt) => prompt.text),
    ['first', 'second'],
  )
  assert.deepEqual(
    queuedFor(next, 'b').map((prompt) => prompt.text),
    ['other'],
  )
})

test('a row whose session left the queue comes back without touching the others', () => {
  const queue = queueOf(['b', 'other'])
  const taken: QueuedPrompt = { id: 7, sessionId: 'a', text: 'gone', attachments: [] }

  const next = requeuePrompt(queue, taken)

  assert.deepEqual(
    next.map((prompt) => prompt.text),
    ['other', 'gone'],
  )
})

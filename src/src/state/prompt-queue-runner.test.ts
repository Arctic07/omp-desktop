import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deliverQueuedPrompts, interruptQueuedPrompt } from './prompt-queue-runner.ts'
import { enqueuePromptFor, promptQueueStore, queuedPromptsFor } from './prompt-queue-store.ts'

/**
 * The queue's own traffic: one row per turn end, and the head row's press.
 *
 * What is pinned down here is the order the reader asked for — a press ends the turn before it
 * sends, a row whose ending failed is still theirs, and two acts never race into one conversation.
 * The words themselves are the store's business (`prompt-queue.test.ts`).
 */

function headTexts(sessionId: string): string[] {
  return queuedPromptsFor(promptQueueStore.get(), sessionId).map((prompt) => prompt.text)
}

test('a turn end releases the session head as a plain turn', async () => {
  // The store is one list for the process; every case starts from an empty one.
  promptQueueStore.set([])
  enqueuePromptFor('s', 'first', [])
  enqueuePromptFor('s', 'second', [])
  const sent: string[] = []

  await deliverQueuedPrompts('s', async (_sessionId, text, _attachments, behavior) => {
    sent.push(`${text}:${String(behavior)}`)
  })

  // One row per turn: sending the head opens the turn whose end brings the next one.
  assert.deepEqual(sent, ['first:null'])
  assert.deepEqual(headTexts('s'), ['second'])
})

test('an interrupt ends the turn first, then sends the pressed row as the next one', async () => {
  // The store is one list for the process; every case starts from an empty one.
  promptQueueStore.set([])
  enqueuePromptFor('s', 'first', [])
  const row = queuedPromptsFor(promptQueueStore.get(), 's')[0]
  const calls: string[] = []

  const done = await interruptQueuedPrompt(
    's',
    row.id,
    async (sessionId) => {
      calls.push(`interrupt:${sessionId}`)
    },
    async (_sessionId, text, _attachments, behavior) => {
      calls.push(`send:${text}:${String(behavior)}`)
    },
  )

  assert.equal(done, true)
  // The order is the point: a send first would be refused as busy and start nothing.
  assert.deepEqual(calls, ['interrupt:s', 'send:first:null'])
  assert.deepEqual(headTexts('s'), [])
})

test('an ending that fails puts the row back at the head and sends nothing', async () => {
  // The store is one list for the process; every case starts from an empty one.
  promptQueueStore.set([])
  enqueuePromptFor('s', 'first', [])
  enqueuePromptFor('s', 'second', [])
  const row = queuedPromptsFor(promptQueueStore.get(), 's')[0]
  let sent = false

  await assert.rejects(
    interruptQueuedPrompt(
      's',
      row.id,
      async () => {
        throw new Error('the turn could not be ended')
      },
      async () => {
        sent = true
      },
    ),
    /could not be ended/,
  )

  assert.equal(sent, false)
  assert.deepEqual(headTexts('s'), ['first', 'second'])
})

test('a second press while the ending is on its way is dropped', async () => {
  // The store is one list for the process; every case starts from an empty one.
  promptQueueStore.set([])
  enqueuePromptFor('s', 'first', [])
  const { id } = queuedPromptsFor(promptQueueStore.get(), 's')[0]
  const gate = Promise.withResolvers<void>()
  const first = interruptQueuedPrompt(
    's',
    id,
    async () => {
      await gate.promise
    },
    async () => {},
  )
  enqueuePromptFor('s', 'second', [])
  const behind = queuedPromptsFor(promptQueueStore.get(), 's')[0]

  const refused = await interruptQueuedPrompt('s', behind.id, async () => {}, async () => {})

  assert.equal(refused, false)
  gate.resolve()
  assert.equal(await first, true)
})

test('an interrupt waits for a delivery already on its way', async () => {
  // The store is one list for the process; every case starts from an empty one.
  promptQueueStore.set([])
  enqueuePromptFor('s', 'first', [])
  const gate = Promise.withResolvers<void>()
  const delivery = deliverQueuedPrompts('s', async () => {
    await gate.promise
  })
  enqueuePromptFor('s', 'second', [])
  const row = queuedPromptsFor(promptQueueStore.get(), 's')[0]

  const refused = await interruptQueuedPrompt('s', row.id, async () => {}, async () => {})

  assert.equal(refused, false)
  gate.resolve()
  await delivery
  assert.deepEqual(headTexts('s'), ['second'])
})

test('a row that is no longer waiting cannot be pressed', async () => {
  // The store is one list for the process; every case starts from an empty one.
  promptQueueStore.set([])
  let touched = false

  const done = await interruptQueuedPrompt(
    's',
    404,
    async () => {
      touched = true
    },
    async () => {
      touched = true
    },
  )

  assert.equal(done, false)
  assert.equal(touched, false)
})

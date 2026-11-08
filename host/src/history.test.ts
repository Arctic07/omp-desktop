import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { entryMessage, readColdPage } from './history.ts'
import type { SdkBundle } from './sdk.ts'

/**
 * Which session entries contribute a row to a transcript.
 *
 * Both transcript readers - the live branch and the cold file - go through `entryMessage`, so this
 * is the one place that decides whether reopening a conversation shows the same rows it showed
 * while it ran. A `custom_message` is how the engine stores what it injects outside a turn (a
 * user-invoked skill, a background job's delivery, a peer's aside, an advisor card), and dropping
 * it here is what made those rows disappear after a reload.
 */

test('a message entry contributes its own message object', () => {
  const message = { role: 'assistant', content: 'hello' }
  assert.equal(entryMessage({ type: 'message', message }), message)
})

test('a displayed custom message reads as a custom-role message', () => {
  const entry = {
    type: 'custom_message',
    customType: 'async-result',
    content: '<system-notice>done</system-notice>',
    display: true,
    attribution: 'agent',
    details: { jobs: [{ jobId: 'bg_1' }] },
    timestamp: '2026-10-20T00:00:00.000Z',
    id: 'e1',
  }
  assert.deepEqual(entryMessage(entry), { ...entry, role: 'custom' })
})

test('a user-invoked skill keeps the fields the user row is read from', () => {
  const entry = {
    type: 'custom_message',
    customType: 'skill-prompt',
    content: 'expanded instructions',
    display: true,
    attribution: 'user',
    details: { name: 'demo', args: '--fast', prompt: '/skill:demo --fast' },
  }
  assert.deepEqual(entryMessage(entry), { ...entry, role: 'custom' })
})

test('a hidden custom message is context, not conversation', () => {
  assert.equal(
    entryMessage({ type: 'custom_message', customType: 'reminder', content: 'x', display: false }),
    undefined,
  )
})

test('every other entry type contributes nothing', () => {
  for (const entry of [
    { type: 'model_change' },
    { type: 'custom', customType: 'x' },
    { type: 'title_change' },
    null,
    undefined,
    'message',
  ]) {
    assert.equal(entryMessage(entry), undefined)
  }
})

test('a cold page carries the displayed custom messages the live branch drew', async () => {
  const entries = [
    { type: 'message', message: { role: 'user', content: 'go', timestamp: 1 } },
    {
      type: 'custom_message',
      customType: 'async-result',
      display: true,
      content: '<system-notice>done</system-notice>',
      timestamp: 2,
    },
    {
      type: 'custom_message',
      customType: 'reminder',
      display: false,
      content: 'context only',
      timestamp: 3,
    },
    { type: 'message', message: { role: 'assistant', content: 'ok', timestamp: 4 } },
  ]
  const file = path.join(os.tmpdir(), `omp-history-custom-${process.pid}.jsonl`)
  fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n'), 'utf8')
  const sdk = {
    async visitSessionEntries(
      _file: string,
      visit: (entry: unknown) => void,
    ): Promise<undefined> {
      for (const entry of entries) visit(entry)
      return undefined
    },
  } as unknown as SdkBundle
  try {
    const page = await readColdPage(sdk, file, undefined, 10)
    assert.equal(page.totalMessages, 3, 'the hidden context entry is not conversation')
    assert.deepEqual(
      page.messages.map(message => (message as { role?: string }).role),
      ['user', 'custom', 'assistant'],
    )
  } finally {
    fs.rmSync(file, { force: true })
  }
})

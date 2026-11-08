import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatMessage } from '../api/session-types.ts'
import { buildRows } from './conversation-rows.ts'

/**
 * What a transcript does with a tool call the engine never parsed.
 *
 * The fragment is markup, not words: the step answered nothing and no call ran. The row keeps its
 * place — the step spent tokens and took time — and states that under itself, because a turn that
 * completed normally would otherwise read as an answer the model never gave.
 */

let clock = 1_700_000_000_000

function user(id: string, text: string): ChatMessage {
  clock += 1000
  return { kind: 'user', id, at: clock, text, attachments: [] }
}

function assistant(id: string, text: string, thinking = ''): ChatMessage {
  clock += 1000
  return {
    kind: 'assistant',
    id,
    at: clock,
    text,
    thinking,
    error: null,
    startedAt: null,
    endedAt: null,
    usage: null,
    modelProvider: 'me',
    modelId: 'deepseek-v4.1-flash',
  }
}

function tool(id: string, name: string): ChatMessage {
  clock += 1000
  return {
    kind: 'tool',
    id,
    at: clock,
    toolCallId: `call-${id}`,
    name,
    state: 'success',
    argsText: '{}',
    resultText: 'ok',
    startedAt: null,
    endedAt: null,
    intent: null,
  }
}

/** The fragment the recording holds, with the opener and its delimiters lost. */
const FRAGMENT =
  '<parameter name="i">Verifying the fold and bubble split</parameter>\n</parameter>\n</invoke>'

test('a step whose words are an unparsed tool call is stated as that, not drawn as prose', () => {
  const rows = buildRows(
    [user('u1', 'go'), { ...assistant('a1', FRAGMENT), stopReason: 'stop' } as ChatMessage],
    // The turn completed: from the engine's side this step is an ordinary answer, which is what made
    // the fragment read as the model's words.
    { turn: { turnId: 'T1', outcome: 'completed', error: null, at: clock, stopped: false } },
  )

  const answer = rows.find(
    (row) => row.kind === 'single' && row.message.kind === 'assistant',
  )
  assert.ok(answer !== undefined && answer.kind === 'single')
  assert.ok(answer.message.kind === 'assistant')
  // The markup never reaches a row: nothing else (a copy, a preview) can carry it either.
  assert.equal(answer.message.text, '')
  assert.equal(answer.ending?.outcome, 'miscall')
  for (const row of rows) {
    if (row.kind !== 'single') continue
    const words = 'text' in row.message ? row.message.text : ''
    assert.ok(!words.includes('parameter'), `${row.id} carries markup`)
  }
})

test('a fragment in a step that goes on to call a tool keeps its note mid-turn', () => {
  const rows = buildRows([
    user('u1', 'go'),
    {
      ...assistant('a1', '<parameter name="i">Checking the layout'),
      stopReason: 'stop',
    } as ChatMessage,
    tool('t1', 'bash'),
    assistant('a2', 'done'),
  ])

  const stray = rows.find((row) => row.kind === 'single' && row.id === 'a1')
  assert.ok(stray !== undefined && stray.kind === 'single')
  // The retried-away marking does not clear it: the missing call is what the reader is looking for.
  assert.equal(stray.ending?.outcome, 'miscall')
})

test('a legacy call the engine never parsed keeps the call it named on its row', () => {
  const rows = buildRows([
    user('u1', 'go'),
    {
      ...assistant(
        'a1',
        '<Browser> <action>screenshot</action> <i>Capturing 375 FAQ</i> </Browser>',
      ),
      stopReason: 'stop',
    } as ChatMessage,
  ])

  const answer = rows.find((row) => row.kind === 'single' && row.id === 'a1')
  assert.ok(answer !== undefined && answer.kind === 'single')
  assert.ok(answer.message.kind === 'assistant')
  // The markup never reaches the bubble; the row states the call it aimed at instead.
  assert.equal(answer.message.text, '')
  assert.equal(answer.stray?.name, 'Browser')
  assert.deepEqual(answer.stray?.args, { action: 'screenshot', i: 'Capturing 375 FAQ' })
  assert.equal(answer.ending?.outcome, 'miscall')
})

test('a thought block before a legacy call leaves the call as the step’s output', () => {
  const rows = buildRows([
    user('u1', 'go'),
    assistant(
      'a1',
      '<thought>Weighing the two files.</thought>\n\n<Browser><action>screenshot</action></Browser>',
    ),
  ])

  const answer = rows.find((row) => row.kind === 'single' && row.id === 'a1')
  assert.ok(answer !== undefined && answer.kind === 'single')
  assert.ok(answer.message.kind === 'assistant')
  // The thought is reasoning; the call is the step's output, and no bracket reaches the bubble.
  assert.equal(answer.thinking, 'Weighing the two files.')
  assert.equal(answer.message.text, '')
  assert.equal(answer.stray?.name, 'Browser')
  assert.deepEqual(answer.stray?.args, { action: 'screenshot' })
})

test('a thought-only step draws its plan as reasoning and no answer bubble', () => {
  const rows = buildRows([
    user('u1', 'go'),
    assistant('a1', '<thought>Weighing the two files.</thought>'),
  ])

  const answer = rows.find((row) => row.kind === 'single' && row.id === 'a1')
  assert.ok(answer !== undefined && answer.kind === 'single')
  assert.ok(answer.message.kind === 'assistant')
  assert.equal(answer.thinking, 'Weighing the two files.')
  assert.equal(answer.message.text, '')
  assert.equal(answer.stray, null)
})

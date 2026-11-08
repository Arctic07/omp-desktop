import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatMessage } from '../api/session-types.ts'
import { agentBrowserIntent, agentDrivesBrowser, type BrowserHoldInput } from './browser-agent.ts'

/**
 * What the chrome reads as "the agent has this page".
 *
 * The hold decides two things the reader can see: the toolbar goes inert, and the band above the
 * page names the call. It must appear for the turn that uses the browser and for nothing else —
 * a hold that survived its turn left the reader locked out of their own browser, and one that read
 * an earlier turn's rows announced the agent over a page it was not touching.
 */

function user(at: number, text = 'look it up'): ChatMessage {
  return { kind: 'user', id: `u${at}`, at, text, attachments: [] }
}

function tool(at: number, name: string, intent: string | null = null): ChatMessage {
  return {
    kind: 'tool',
    id: `t${at}`,
    toolCallId: `t${at}`,
    at,
    name,
    state: 'success',
    argsText: '{}',
    resultText: 'ok',
    startedAt: at,
    endedAt: at + 1,
    intent,
  }
}

function record(overrides: Partial<BrowserHoldInput> = {}): BrowserHoldInput {
  return { turnId: 'turn-1', turnStartedAt: null, messages: [], ...overrides }
}

test('no turn in flight is no hold, whatever the rows say', () => {
  const rows = [user(10), tool(11, 'Browser', 'open the docs')]
  assert.equal(agentDrivesBrowser(record({ turnId: null, messages: rows })), false)
  assert.equal(agentBrowserIntent(record({ turnId: null, messages: rows })), null)
  assert.equal(agentDrivesBrowser(undefined), false)
})

test('a browser call in the turn holds the page until the turn ends', () => {
  const rows = [user(10), tool(11, 'BrowserPreview', 'preview the report')]
  assert.equal(agentDrivesBrowser(record({ messages: rows })), true)
  assert.equal(agentBrowserIntent(record({ messages: rows })), 'preview the report')
})

test('another tool does not take the page', () => {
  const rows = [user(10), tool(11, 'bash'), tool(12, 'Read')]
  assert.equal(agentDrivesBrowser(record({ messages: rows })), false)
})

test('an earlier turn`s browser call is not this turn`s hold', () => {
  // The stamp is how a turn the engine started itself is bounded: its own rows start at the stamp,
  // and the prompt above it belongs to the turn before.
  const rows = [user(10), tool(11, 'Browser', 'open the docs'), user(20)]
  assert.equal(agentDrivesBrowser(record({ messages: rows })), false)
  assert.equal(agentDrivesBrowser(record({ turnStartedAt: 20, messages: rows })), false)
  assert.equal(
    agentDrivesBrowser(record({ turnStartedAt: 20, messages: [...rows, tool(21, 'Browser')] })),
    true,
  )
})

test('the first call of the turn names the hold, later calls do not re-label it', () => {
  const rows = [
    user(10),
    tool(11, 'Browser', 'open the docs'),
    tool(12, 'Browser', 'click download'),
  ]
  assert.equal(agentBrowserIntent(record({ messages: rows })), 'open the docs')
})

test('a call that named nothing reads as no name, not as the next call`s', () => {
  const rows = [user(10), tool(11, 'Browser'), tool(12, 'Browser', 'click download')]
  assert.equal(agentDrivesBrowser(record({ messages: rows })), true)
  assert.equal(agentBrowserIntent(record({ messages: rows })), null)
})

test('a conversation attached mid-turn is bounded by the prompt it is answering', () => {
  // No `turn_started` was seen here, so `turnStartedAt` is null and the last user row is the edge.
  const rows = [tool(5, 'Browser', 'from the turn before'), user(10), tool(11, 'Browser', 'now')]
  assert.equal(agentBrowserIntent(record({ messages: rows })), 'now')
})

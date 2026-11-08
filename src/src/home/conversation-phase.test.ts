import assert from 'node:assert/strict'
import { test } from 'node:test'

import { conversationPhase, type ConversationPhaseState } from './conversation-phase.ts'

/** A conversation column in a workspace, with no record yet unless one is given. */
function state(overrides: Partial<ConversationPhaseState> = {}): ConversationPhaseState {
  return {
    workspaceId: 1,
    openStatus: 'idle',
    openingNew: false,
    activeId: null,
    records: {},
    ...overrides,
  }
}

/** One record with the fields the phase rule reads, including the two legs `isStreaming` takes. */
function record(
  id: string,
  fields: {
    messages?: readonly unknown[]
    engineEmpty?: boolean
    historyStatus?: 'idle' | 'loading' | 'ready' | 'error'
    /** A turn in flight, as the record reads it: the frame that opened it here, or the engine's own. */
    turnId?: string | null
    streaming?: boolean
  } = {},
): ConversationPhaseState['records'] {
  return {
    [id]: {
      messages: fields.messages ?? [],
      engineEmpty: fields.engineEmpty ?? false,
      historyStatus: fields.historyStatus ?? 'loading',
      turnId: fields.turnId ?? null,
      runtime: fields.streaming === true ? { isStreaming: true } : null,
    },
  }
}

test('a click that is opening a conversation is a wait, not the hero', () => {
  assert.equal(conversationPhase(state({ openStatus: 'opening' })), 'reading')
  // A workspace switch that will open its newest conversation enters the same state before the
  // engine has answered, so the loading mark is never replaced by the hero on the way.
  assert.equal(conversationPhase(state({ openStatus: 'opening' })), 'reading')
})

test('a workspace with nothing open and nothing opening is the hero', () => {
  assert.equal(conversationPhase(state()), 'hero')
})

test('creating a conversation is the hero, not a wait over a transcript nobody wrote', () => {
  // The engine is asked for a new conversation and has not answered yet: there is nothing to read,
  // and the column is the screen the first message is written on (2026-10-29, user report).
  assert.equal(conversationPhase(state({ openStatus: 'opening', openingNew: true })), 'hero')
  // The same status for an open that is reading a listed conversation is still a wait.
  assert.equal(conversationPhase(state({ openStatus: 'opening', openingNew: false })), 'reading')
})

test('a conversation whose read is over is drawn at once, whatever its rows are', () => {
  // The reader is coming back to one this process kept warm: its rows are the transcript, and a
  // spinner over them would be a flash of the wrong state.
  const records = record('s1', { messages: [{}], historyStatus: 'ready' })
  assert.equal(conversationPhase(state({ activeId: 's1', records })), 'conversation')
})

test('a read in flight keeps the loading mark, even over the pages it has painted', () => {
  // A paged read acquires rows before it is complete. Drawing them is drawing a prefix: the pane
  // rewrites itself under the reader for as long as the read runs (2026-11-05, user report: 点开长
  // 会话没有加载动画，只看到文字挤压、图片闪烁、抖动一会才正常).
  const records = record('s1', { messages: [{}], historyStatus: 'loading' })
  assert.equal(conversationPhase(state({ activeId: 's1', openStatus: 'ready', records })), 'reading')
})

test('a turn in flight is drawn while its conversation is still being read', () => {
  // The reader came back to a conversation whose answer is arriving: those rows are the answer, not
  // a prefix of the read, and holding them back behind the mark would hide the one thing the reader
  // came for.
  const turnId = record('s1', { messages: [{}], historyStatus: 'loading', turnId: 'turn-1' })
  assert.equal(conversationPhase(state({ activeId: 's1', records: turnId })), 'conversation')
  // The engine's own snapshot counts the same way: a conversation attached mid-turn has no frame of
  // its own here.
  const attached = record('s1', { messages: [{}], historyStatus: 'loading', streaming: true })
  assert.equal(conversationPhase(state({ activeId: 's1', records: attached })), 'conversation')
  // With nothing on screen yet, a running turn is still the wait.
  const bare = record('s1', { messages: [], historyStatus: 'loading', turnId: 'turn-1' })
  assert.equal(conversationPhase(state({ activeId: 's1', records: bare })), 'reading')
})

test('a message the reader has written into a blank conversation is not the hero', () => {
  // The engine reported the conversation as holding nothing, and the reader's own first message is
  // already in it: the hero is the screen for a conversation nothing has been said in.
  const records = record('s1', { messages: [{}], engineEmpty: true, historyStatus: 'loading' })
  assert.equal(conversationPhase(state({ activeId: 's1', records })), 'conversation')
})

test('a read that failed after painting pages keeps its rows on screen', () => {
  // The failure is said beside the composer (`session-stream.ts`), not by replacing a transcript the
  // reader can already read with a failure card.
  const records = record('s1', { messages: [{}], historyStatus: 'error' })
  assert.equal(conversationPhase(state({ activeId: 's1', records })), 'conversation')
})

test('an empty record that has history to read shows the loading mark', () => {
  const records = record('s1', { engineEmpty: false, historyStatus: 'loading' })
  assert.equal(conversationPhase(state({ activeId: 's1', openStatus: 'ready', records })), 'reading')
})

test('a blank conversation is the hero from its first frame', () => {
  const records = record('s1', { engineEmpty: true, historyStatus: 'loading' })
  assert.equal(conversationPhase(state({ activeId: 's1', openStatus: 'ready', records })), 'hero')
})

test('a failed open or an empty failed read is the failure screen', () => {
  assert.equal(conversationPhase(state({ openStatus: 'error' })), 'failed')
  const records = record('s1', { engineEmpty: false, historyStatus: 'error' })
  assert.equal(conversationPhase(state({ activeId: 's1', records })), 'failed')
})

test('a read that finished with nothing to show is not a read still running', () => {
  // The conversation is listed as holding something (`engineEmpty: false`) and its read is over:
  // the pane must say so instead of keeping a loading mark over rows that are never coming.
  const records = record('s1', { engineEmpty: false, historyStatus: 'ready' })
  assert.equal(conversationPhase(state({ activeId: 's1', records })), 'failed')
  // The same record mid-read is still the loading mark: nothing has gone wrong yet.
  const loading = record('s1', { engineEmpty: false, historyStatus: 'loading' })
  assert.equal(conversationPhase(state({ activeId: 's1', records: loading })), 'reading')
})

test('no workspace wins over every open state', () => {
  assert.equal(conversationPhase(state({ workspaceId: null, openStatus: 'opening' })), 'hero')
})

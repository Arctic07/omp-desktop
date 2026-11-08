import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  carryComposerDraft,
  composerDraftOf,
  composerDraftsStore,
  conversationDraftKey,
  draftPinCoversRecord,
  forgetComposerDraft,
  newConversationDraftKey,
  NO_CONVERSATION_DRAFT_KEY,
  putComposerDraft,
  readComposerDraft,
  setComposerDraftText,
} from './composer-draft-store.ts'
import type { ComposerAttachment } from './composer-draft.ts'
import type { ChatMessage } from '../api/session-types.ts'

/**
 * The composer's drafts, per conversation.
 *
 * What is pinned down here is the one thing a seat must never get wrong: moving between
 * conversations shows each one's own words and files, and the only hand-overs that carry anything
 * are the two the composer's own design names (the empty seat, and a blank conversation that has
 * just sent its first message).
 */

function file(name: string, token: string): ComposerAttachment {
  return { token, name, path: `C:\\work\\${name}`, mimeType: 'image/png', bytes: 128 }
}

function record(id: string, messages: number, workspaceId = 1, engineEmpty = messages === 0) {
  return {
    id,
    workspaceId,
    engineEmpty,
    messages: Array.from({ length: messages }, () => ({})) as ChatMessage[],
  }
}

function reset(): void {
  composerDraftsStore.set(() => ({}))
}

test('each conversation keeps its own words and its own files', () => {
  reset()
  const shot = file('shot.png', '\ue001')
  putComposerDraft('session-a', `看这张 \ue001`, [shot])
  putComposerDraft('session-b', '另一句', [])

  assert.equal(readComposerDraft('session-a').text, `看这张 \ue001`)
  assert.deepEqual(readComposerDraft('session-a').attachments.map((it) => it.name), ['shot.png'])
  assert.equal(readComposerDraft('session-b').text, '另一句')
  assert.deepEqual(readComposerDraft('session-b').attachments, [])
  // A conversation nothing was written in is the empty draft, and reading it does not create one.
  assert.equal(composerDraftOf(composerDraftsStore.get(), 'session-c').text, '')
  assert.equal(composerDraftsStore.get()['session-c'], undefined)
})

test('a draft that has come back to nothing is dropped', () => {
  reset()
  putComposerDraft('session-a', 'words', [])
  setComposerDraftText('session-a', '')
  assert.equal(composerDraftsStore.get()['session-a'], undefined)
})

test('a conversation with rows sits under its own id, and the blank one under its workspace', () => {
  assert.equal(conversationDraftKey(null), NO_CONVERSATION_DRAFT_KEY)
  assert.equal(conversationDraftKey(record('session-a', 3)), 'session-a')
  // Two blank conversations in one workspace are the same seat: the desktop hands a blank one back
  // on every switch, so the id is not what an unsent draft can be kept under.
  assert.equal(
    conversationDraftKey(record('blank-1', 0)),
    newConversationDraftKey(1),
  )
  assert.equal(
    conversationDraftKey(record('blank-2', 0)),
    conversationDraftKey(record('blank-1', 0)),
  )
  assert.notEqual(
    conversationDraftKey(record('blank-3', 0, 2)),
    newConversationDraftKey(1),
  )
})

test('a blank conversation that sends its first message hands its draft to the session', () => {
  reset()
  const seat = newConversationDraftKey(1)
  putComposerDraft(seat, '1', [file('one.png', '\ue001')])
  carryComposerDraft(seat, 'session-a')

  assert.equal(readComposerDraft(seat).text, '')
  assert.equal(readComposerDraft('session-a').text, '1')
  assert.deepEqual(readComposerDraft('session-a').attachments.map((it) => it.name), ['one.png'])
  assert.equal(composerDraftsStore.get()[seat], undefined)
})

test('a hand-over keeps what the receiving seat already holds, under the moved words', () => {
  reset()
  putComposerDraft(NO_CONVERSATION_DRAFT_KEY, 'typed before a workspace opened', [])
  putComposerDraft('session-a', 'its own draft', [])
  carryComposerDraft(NO_CONVERSATION_DRAFT_KEY, 'session-a')

  assert.equal(readComposerDraft('session-a').text, 'typed before a workspace opened\nits own draft')
  assert.equal(composerDraftsStore.get()[NO_CONVERSATION_DRAFT_KEY], undefined)
})

test('forgetting one conversation leaves the others alone', () => {
  reset()
  putComposerDraft('session-a', 'a', [])
  putComposerDraft('session-b', 'b', [])
  forgetComposerDraft('session-a')

  assert.equal(readComposerDraft('session-a').text, '')
  assert.equal(readComposerDraft('session-b').text, 'b')
})

test('the seat pinned for an open covers the conversation it named, written or blank', () => {
  const written = { id: 'session-a', workspaceId: 1 }
  assert.equal(draftPinCoversRecord('session-a', written), true)
  assert.equal(draftPinCoversRecord('session-b', written), false)
  // A blank conversation lives in its workspace's seat; a pin that named the session still covers
  // it, which is what lets the words typed while it opened move there.
  assert.equal(draftPinCoversRecord(newConversationDraftKey(1), written), true)
  assert.equal(draftPinCoversRecord(newConversationDraftKey(2), written), false)
  assert.equal(draftPinCoversRecord(null, written), false)
})

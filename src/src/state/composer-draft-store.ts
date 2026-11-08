/**
 * The composer's drafts, one per conversation.
 *
 * The box at the foot of the column is one seat, but what is written in it belongs to the
 * conversation it was written for: switch away and the next conversation's own draft is what the
 * box holds, and switching back brings the words and the files back with it. Nothing is carried
 * across a switch — a draft the reader left in one conversation is not a prompt for another.
 *
 * A draft is one string and the files it names (`state/composer-draft.ts`): the text carries a
 * character per file, and the records behind those characters live here with it, so a draft can
 * never come back as "the words without the pictures" — the failure that made the attachments a
 * single global list once (2026-10-21). Both halves move together or not at all.
 *
 * Which key a conversation's draft sits under is decided once:
 *
 * - a conversation with something said in it is keyed by the engine's own session id;
 * - a conversation with nothing said in it yet — the hero, and the blank conversation a workspace
 *   opens on — is keyed by the *workspace*, not by its session id. The desktop hands a blank
 *   conversation back when the reader switches away (`session-store.ts::letGo`), so it comes back
 *   with a new id every time; a draft keyed by that id would be lost by the very switch it is
 *   meant to survive. The workspace's seat is the same seat across all of them;
 * - no conversation at all (the moment before a workspace opens one) is the empty key, and what is
 *   typed there moves into the first draft the box is given.
 */

// Relative, with their extensions: this module is read by the test runner as well as by the
// bundler, and the runner has no alias to resolve (the same reason `state/file-drag-store.ts` does it).
import { isUnwritten } from './transcript.ts'
import type { SessionRecord } from './session-record.ts'
import type { ComposerAttachment } from './composer-draft.ts'
import { createStore } from './store.ts'

/** One conversation's unsent prompt: its words, and the files they name. */
export interface ComposerDraft {
  readonly text: string
  readonly attachments: readonly ComposerAttachment[]
}

/** Stable empty list, so a draft with no files keeps one identity across reads. */
const NO_ATTACHMENTS: readonly ComposerAttachment[] = []

/** The draft of a conversation nothing has been written in. */
export const EMPTY_COMPOSER_DRAFT: ComposerDraft = { text: '', attachments: NO_ATTACHMENTS }

/** Every conversation's own draft, keyed by {@link conversationDraftKey}. */
export const composerDraftsStore = createStore<Readonly<Record<string, ComposerDraft>>>({})

/** The key of the seat no conversation is in yet. */
export const NO_CONVERSATION_DRAFT_KEY = ''

const NEW_CONVERSATION_PREFIX = 'new:'

/** The draft seat of a workspace's blank conversation. */
export function newConversationDraftKey(workspaceId: number | null): string {
  return `${NEW_CONVERSATION_PREFIX}${workspaceId ?? 'none'}`
}

/** Whether a key is a workspace's blank-conversation seat rather than a session id. */
export function isNewConversationDraftKey(key: string): boolean {
  return key.startsWith(NEW_CONVERSATION_PREFIX)
}

/** The fields of a record that decide which seat its draft lives in. */
type DraftSeatRecord = Pick<SessionRecord, 'id' | 'workspaceId' | 'engineEmpty' | 'messages'>

/**
 * The seat a conversation's draft lives in.
 *
 * Read from the record rather than from the session id alone: a conversation the engine reports as
 * holding nothing is the workspace's blank conversation, and its id is not what the draft is kept
 * under (see the module note). Null is the moment no conversation is open.
 */
export function conversationDraftKey(record: DraftSeatRecord | null): string {
  if (record === null) return NO_CONVERSATION_DRAFT_KEY
  return isUnwritten(record.engineEmpty, record.messages)
    ? newConversationDraftKey(record.workspaceId)
    : record.id
}

/** The draft a seat holds; a seat nothing was written in has the empty one. */
export function composerDraftOf(
  drafts: Readonly<Record<string, ComposerDraft>>,
  key: string,
): ComposerDraft {
  return drafts[key] ?? EMPTY_COMPOSER_DRAFT
}

/**
 * Whether the seat pinned for an open (`SessionStoreState.openingSeat`) is the one this record
 * settles on.
 *
 * A pin that names the session is *this* open's target even when the record turns out to be
 * unwritten and therefore lives under its workspace's blank seat: what the reader typed while the
 * conversation loaded belongs to it either way, and `adopt` is what carries it across.
 */
export function draftPinCoversRecord(
  pin: string | null,
  record: Pick<SessionRecord, 'id' | 'workspaceId'>,
): boolean {
  if (pin === null) return false
  if (isNewConversationDraftKey(pin)) {
    return pin === newConversationDraftKey(record.workspaceId)
  }
  return pin === record.id
}

/** The draft the box is showing right now, read straight from the store. */
export function readComposerDraft(key: string): ComposerDraft {
  return composerDraftOf(composerDraftsStore.get(), key)
}

/**
 * Write one seat's draft.
 *
 * A draft that has come back to nothing is dropped rather than kept as an empty entry: the map is
 * the set of conversations with something unsent in them, and an empty one would report a change on
 * every send.
 */
function writeDraft(
  key: string,
  text: string,
  attachments: readonly ComposerAttachment[],
): void {
  composerDraftsStore.set((current) => {
    const previous = current[key]
    if (previous !== undefined && previous.text === text && previous.attachments === attachments) {
      return current
    }
    const drafts = { ...current }
    if (text === '' && attachments.length === 0) delete drafts[key]
    else drafts[key] = { text, attachments }
    return drafts
  })
}

/** The reader's words in one draft, its files untouched. */
export function setComposerDraftText(key: string, text: string): void {
  writeDraft(key, text, readComposerDraft(key).attachments)
}

/** One draft's files, its words untouched. */
export function setComposerDraftAttachments(
  key: string,
  attachments: readonly ComposerAttachment[],
): void {
  writeDraft(key, readComposerDraft(key).text, attachments)
}

/** Both halves at once, for a draft replaced wholesale (a recall, a rewind's own draft). */
export function putComposerDraft(
  key: string,
  text: string,
  attachments: readonly ComposerAttachment[],
): void {
  writeDraft(key, text, attachments)
}

/** Add chip characters to the end of one draft — an import that finished after the reader left. */
export function appendComposerDraftChips(key: string, tokens: string): void {
  if (tokens === '') return
  const draft = readComposerDraft(key)
  writeDraft(key, `${draft.text}${tokens}`, draft.attachments)
}

/** Forget one seat's draft: the prompt was sent, or the conversation it belonged to is gone. */
export function forgetComposerDraft(key: string): void {
  composerDraftsStore.set((current) => {
    if (current[key] === undefined) return current
    const drafts = { ...current }
    delete drafts[key]
    return drafts
  })
}

/**
 * Move a draft into the seat that replaced it.
 *
 * Two seats hand over rather than being switched between: the empty seat moves into the first
 * conversation the box is given (words typed before a workspace opened belong to it), and a blank
 * conversation's seat moves into that same conversation's session key once its first message makes
 * it a real one — words typed while that message was on its way are still the reader's, and are
 * read back with the conversation that took them. What is already in the target seat stays, under
 * the moved text, the way a prefill is placed.
 */
export function carryComposerDraft(from: string, to: string): void {
  if (from === to) return
  const state = composerDraftsStore.get()
  const source = state[from]
  if (source === undefined) return
  const target = composerDraftOf(state, to)
  const text =
    source.text.trim() === ''
      ? target.text
      : target.text.trim() === ''
        ? source.text
        : `${source.text}\n${target.text}`
  const held = new Set(target.attachments.map((attachment) => attachment.token))
  const attachments = [
    ...target.attachments,
    ...source.attachments.filter((attachment) => !held.has(attachment.token)),
  ]
  const drafts = { ...state }
  delete drafts[from]
  if (text === '' && attachments.length === 0) delete drafts[to]
  else drafts[to] = { text, attachments }
  composerDraftsStore.set(drafts)
}

/**
 * `session_history_page`: paged transcript reads (contract §2.5-4, M7).
 *
 * Pages are handed out oldest first, which is what the engine's own pager does and what the
 * desktop's walk consumes: `offset` counts the messages already delivered from the earliest end,
 * so the walk appends each page in arrival order and never has to reverse or reorder anything.
 *
 * A cold session is read from its file and never activated - no AgentSession is created for it -
 * and the file is streamed once per request, retaining only the requested window, so memory stays
 * proportional to the page rather than to the transcript.
 *
 * A cold read is only ever served from a file that is there and can be opened: a path that is not
 * a readable transcript is refused, never answered with an empty page (see `readColdPage`).
 */

import * as fs from 'node:fs'

import { JUMP_PAGE_MESSAGES, PAGE_MESSAGES } from './constants.ts'
import { ERROR_CODES, HostError } from './protocol/errors.ts'
import type { SdkBundle } from './sdk.ts'

/** One page of a transcript window, oldest entry first. */
export interface HistoryPage {
  readonly messages: unknown[]
  readonly totalMessages: number
  /** Position of the next page, or `null` when this page is the last one. */
  readonly nextCursor: string | null
  /** Messages already delivered when this page starts; equals the request's offset. */
  readonly cursorOffset: number
}

/**
 * Opaque cursor: the number of messages the caller has already received, plus the size of the
 * transcript that count was taken against.
 *
 * The snapshot is what keeps a walk honest. A transcript that grew or was rewritten between two
 * pages makes the cursor stale instead of letting the walk skip or repeat rows, which is the same
 * bind the engine applies to its own `{sessionId, leafId, messageCount}` cursor.
 */
export function encodeCursor(offset: number, total: number): string {
  return `c${offset}@${total}`
}

/** A decoded cursor: where the next page starts, and the transcript size it was issued against. */
export interface CursorPosition {
  readonly offset: number
  readonly total: number
}

/** Parses a cursor, or reports it as stale when it was not produced by this scheme. */
export function decodeCursor(cursor: string): CursorPosition {
  const match = /^c(\d+)@(\d+)$/.exec(cursor)
  if (match === null) throw new HostError(ERROR_CODES.stale_cursor, 'The history cursor is not usable.')
  const offset = Number(match[1])
  const total = Number(match[2])
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(total) || offset > total) {
    throw new HostError(ERROR_CODES.stale_cursor, 'The history cursor is not usable.')
  }
  return { offset, total }
}

/** Requested page size, clamped to the contract's default and jump page. */
export function pageLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return PAGE_MESSAGES
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    throw new HostError(ERROR_CODES.invalid_input, 'The history limit must be a positive integer.')
  }
  return Math.min(limit, JUMP_PAGE_MESSAGES * 8)
}

/**
 * Windows one transcript page, oldest first.
 *
 * The page is `messages[offset .. min(offset + limit, total)]` and the returned cursor carries the
 * offset it reached together with `total`, so the caller can either fetch the next page or learn
 * that the transcript moved underneath it (`stale_cursor`).
 *
 * `messages` carries the transcript from index `windowStart` on - a live session keeps all of it,
 * a cold read keeps only the window it was asked for - and a request reaching outside that range is
 * reported stale rather than answered with a silently truncated page.
 */
export function windowOf(
  messages: readonly unknown[],
  total: number,
  cursor: string | undefined,
  limit: number,
  windowStart = 0,
): HistoryPage {
  const position = cursor === undefined ? { offset: 0, total } : decodeCursor(cursor)
  if (position.total !== total) {
    throw new HostError(ERROR_CODES.stale_cursor, 'The transcript changed since this cursor was issued.')
  }
  const start = position.offset
  const end = Math.min(start + limit, total)
  if (start < windowStart || end > windowStart + messages.length) {
    throw new HostError(ERROR_CODES.stale_cursor, 'The history cursor is beyond the transcript window this host read.')
  }
  return {
    messages: messages.slice(start - windowStart, end - windowStart),
    totalMessages: total,
    nextCursor: end < total ? encodeCursor(end, total) : null,
    cursorOffset: start,
  }
}

/** Message entries carried by a session file line. */
interface MessageEntry {
  type?: string
  message?: unknown
  display?: unknown
}

/**
 * Whether a session entry is conversation content.
 *
 * Two entry types are: `message`, and `custom_message` — what the engine stores outside a turn (a
 * skill invocation, a background job's answer, an aside). Everything else in a transcript is the
 * engine's own bookkeeping — the title slot, the session header, mode and model changes, turn
 * markers — and never a row.
 *
 * This is the format's vocabulary, not the display rule: {@link entryMessage} draws these entries and
 * additionally drops a `custom_message` whose `display` is `false`, which is context for the model
 * rather than conversation. Readers that count or keep files ask this one (`plugin-sessions.ts`,
 * `session-lifecycle.ts::transcriptHoldsMessage`), so a file cannot be readable through one path and
 * disposable through another.
 */
export function isConversationEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false
  const record = entry as MessageEntry
  return record.type === 'message' || record.type === 'custom_message'
}

/**
 * The message one session entry contributes to a transcript, or `undefined` for an entry that is
 * not conversation.
 *
 * Two entry types are messages. `message` carries the engine's own message object verbatim.
 * `custom_message` is how the engine stores what it injects outside a turn - a user-invoked skill,
 * the answer a background job or subagent hands back, a peer's aside, an advisor card - and it
 * participates in the conversation exactly like a message (`session-context.ts::isContextEntry`).
 * Its `display: false` is the engine saying the entry is context for the model rather than
 * conversation, which is the one thing that stays out.
 *
 * The projection gives the entry the shape every reader on this side already speaks: the wire
 * vocabulary is a message `role`, and a custom entry has none of its own. Both transcript paths -
 * the live branch and the cold file - read entries through this function, so reopening a
 * conversation cannot show a different conversation from the one that was on screen.
 */
export function entryMessage(entry: unknown): unknown | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as MessageEntry
  if (record.type === 'message') return record.message
  if (record.type !== 'custom_message' || record.display === false) return undefined
  return { ...(entry as Record<string, unknown>), role: 'custom' }
}

/**
 * Failure text for a cold read whose file is not there or cannot be opened.
 *
 * The path is deliberately absent: the caller supplied it, and a failure line is also written to
 * the host log, where echoing it would leak a profile layout (contract §2.8).
 */
const COLD_READ_FAILURE = 'The session file does not exist or cannot be read.'

/** Whether `file` is a regular file this process can open for reading. */
function readableSessionFile(file: string): boolean {
  try {
    // Existence is not enough: a directory opens without complaint on Windows, so the entry has to
    // be a regular file, and it has to open - a file held with an exclusive lock does not.
    if (!fs.statSync(file).isFile()) return false
    fs.closeSync(fs.openSync(file, 'r'))
    return true
  } catch {
    return false
  }
}

/**
 * Reads one page of a transcript off disk without activating anything.
 *
 * The file is streamed once: the scan counts every message entry and retains only
 * `[offset, offset + limit)`, so a transcript of any size costs one pass and one page of memory.
 * The count and the window come from the same pass (ruling A17), so a page can never be sized by
 * one source and validated against another.
 *
 * The file must be there to be read. The engine's streaming reader reports a path it cannot open as
 * a transcript with no entries, so without the check below "the file is gone" and "the transcript is
 * empty" would come back as the same successful page and the desktop would show a deleted session
 * as simply having no messages.
 */
export async function readColdPage(
  sdk: SdkBundle,
  file: string,
  cursor: string | undefined,
  limit: number,
): Promise<HistoryPage> {
  if (!readableSessionFile(file)) {
    throw new HostError(ERROR_CODES.invalid_session_path, COLD_READ_FAILURE)
  }
  const start = cursor === undefined ? 0 : decodeCursor(cursor).offset
  const messages: unknown[] = []
  let total = 0
  await sdk.visitSessionEntries(file, entry => {
    const message = entryMessage(entry)
    if (message === undefined) return
    const index = total
    total += 1
    if (index >= start && index < start + limit) messages.push(message)
  })
  return windowOf(messages, total, cursor, limit, start)
}

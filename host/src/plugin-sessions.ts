/**
 * `session.*` and `usage.turns`: the P1 read surfaces, answered from the index this application
 * already keeps (`omp.desktop` API 0.2.0).
 *
 * A plugin that declares `session.read` or `usage.read` is reading the same things this desktop's
 * own history list and usage page read - the session store's JSONL files, through the engine's own
 * entry stream - and nothing here writes: no file is opened for append, no session is activated, and
 * no engine call mutates state. That is the whole point of the split, and it is why this module can
 * be a pure projection over paths plus one port.
 *
 * Three rules shape it:
 *
 * - **Bounded, refused rather than trimmed.** The bridge's gate already refused a page over 500 and a
 *   body over 4 KiB (`src-tauri/src/services/plugins/bridge/capabilities.rs`); what is left here is to
 *   honour exactly the number that survived, and to answer the next cursor rather than a bigger page.
 * - **Bodies only on request.** A `session.messages` call with no `contentLimit` answers ids, roles
 *   and timestamps and no text at all. That is what keeps "list the conversation" and "read the
 *   conversation" two different requests under one permission.
 * - **The cursor is this host's, and only this host's.** It is opaque to the plugin, bound to the
 *   transcript size it was issued against (`history.ts`'s scheme), and a stale one is an error rather
 *   than a silently shifted page.
 *
 * `projectId` filters on the row's `cwd`: the engine keys a stored conversation by the workspace it
 * was written in (its `<encoded-cwd>` bucket is the directory it lives in), and that path is the only
 * project identity a read-only projection has. A plugin that names a path it has no business knowing
 * simply matches nothing.
 */

import * as fs from 'node:fs'

import { USAGE_MAX_FILES } from './constants.ts'
import type { HostPaths } from './env.ts'
import { encodeCursor, isConversationEntry } from './history.ts'
import { logLine } from './log.ts'
import { readLines } from './ndjson.ts'
import { invalidInput, ERROR_CODES, HostError } from './protocol/errors.ts'
import type { SdkBundle } from './sdk.ts'
import { conversationRows, sessionsById, type ConversationRow } from './session-history.ts'
import { listSessionFiles, sessionIdFor } from './store.ts'

/**
 * How many model calls one `usage.turns` answer may be built from.
 *
 * The whole window is read before the page is cut (the total is part of the answer), so the ceiling
 * is what keeps one call's cost independent of how much history the user has. Over it the call is
 * refused with the sentence that says to narrow the window - never trimmed, because a page cut from a
 * silently shortened list answers a different question than the one that was asked.
 */
const USAGE_TURNS_MAX = 20_000

/** What these reads need: where the store is, and the engine's own entry stream. */
export interface PluginSessionsPort {
  readonly paths: HostPaths
  readonly sdk: SdkBundle
}

/**
 * How many messages each session file holds, cached by the mtime it was counted at.
 *
 * Owner: this module (one host process). Bound: [`TURN_COUNT_CACHE_MAX`] entries, least recently
 * counted dropped first. Release: an entry is replaced when the file's mtime moves. Counting is a
 * streaming pass that keeps one number, so the cost per uncounted file is one read of its bytes and
 * nothing retained.
 */
const TURN_COUNT_CACHE_MAX = 512
const turnCounts = new Map<string, { mtimeMs: number; count: number }>()


/** How many `message`/`custom_message` entries one file holds. */
function turnCount(file: string, mtimeMs: number): number {
  const cached = turnCounts.get(file)
  if (cached !== undefined) {
    turnCounts.delete(file)
    if (cached.mtimeMs === mtimeMs) {
      turnCounts.set(file, cached)
      return cached.count
    }
  }
  let count = 0
  readLines(file, line => {
    if (line === '') return true
    try {
      if (isConversationEntry(JSON.parse(line))) count += 1
    } catch {
      // A malformed or half-written line is not a message.
    }
    return true
  })
  turnCounts.set(file, { mtimeMs, count })
  while (turnCounts.size > TURN_COUNT_CACHE_MAX) {
    const oldest = turnCounts.keys().next().value
    if (oldest === undefined) break
    turnCounts.delete(oldest)
  }
  return count
}

/** One conversation row as a plugin reads it. */
function sessionOf(row: ConversationRow): Record<string, unknown> {
  let mtimeMs = row.updatedAt
  try {
    mtimeMs = fs.statSync(row.file).mtimeMs
  } catch {
    // A file that vanished keeps the stamp the row was built with; its count reads as whatever the
    // cache holds, which is the honest answer for a conversation that is no longer there.
  }
  return {
    sessionId: row.id,
    projectId: row.cwd,
    title: row.title,
    updatedAt: row.updatedAt,
    turnCount: turnCount(row.file, mtimeMs),
  }
}

/** `session.list`: the conversation index, newest first, one page at a time. */
export function sessionList(port: PluginSessionsPort, frame: Record<string, unknown>): Record<string, unknown> {
  const limit = pageLimit(frame.limit)
  const projectId = text(frame.projectId)
  let rows = conversationRows(port.paths)
  if (projectId !== undefined) rows = rows.filter(row => row.cwd === projectId)
  const offset = offsetOf(frame.cursor, rows.length)
  const page = rows.slice(offset, offset + limit)
  const next = offset + limit < rows.length ? encodeCursor(offset + limit, rows.length) : null
  return { sessions: page.map(sessionOf), nextCursor: next, total: rows.length }
}

/** `session.get`: one conversation's metadata, or nothing. */
export function sessionGet(port: PluginSessionsPort, frame: Record<string, unknown>): Record<string, unknown> {
  const wanted = requiredText(frame.sessionId, 'sessionId')
  const row = conversationRows(port.paths).find(candidate => candidate.id === wanted)
  if (row === undefined) throw new HostError(ERROR_CODES.session_not_found, `Unknown session ${wanted}.`)
  return { session: sessionOf(row) }
}

/**
 * `session.messages`: one conversation's messages, one page at a time, oldest first unless the caller
 * asked for the newest first.
 *
 * The transcript on disk is the source - the same file the desktop's own history pane walks - because
 * it is the only place a message row still carries the **entry id** it was written under, and an id is
 * what the plugin contract publishes by default. A turn still in flight appears when it is written;
 * a reader outside the conversation is reading what the conversation is once stored.
 *
 * The cursor carries the offset *and* the transcript size it was issued against, so a page after a
 * write is refused (`stale_cursor`) rather than silently shifted - the same rule the desktop's own
 * pager applies, and the reason the count travels in the cursor rather than being remembered here.
 */
export async function sessionMessages(
  port: PluginSessionsPort,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = requiredText(frame.sessionId, 'sessionId')
  const limit = pageLimit(frame.limit)
  const contentLimit = contentLimitOf(frame.contentLimit)
  const descending = frame.order === 'desc'
  const file = sessionsById(port.paths).get(sessionId)
  if (file === undefined) throw new HostError(ERROR_CODES.session_not_found, `Unknown session ${sessionId}.`)

  // The transcript on disk is what a *read* means here: it is the same file the desktop's own history
  // pane walks, it is what the user's conversation is once written, and it carries the entry id every
  // row was written under. A turn still in flight appears when it is written, which is the honest
  // answer for a reader outside the conversation.
  const scan = scanTranscript(file, () => 0)
  const total = scan.total
  const position = cursorOffsetOf(frame.cursor, total, descending)
  const start = descending ? Math.max(0, position - limit) : position
  const end = descending ? position : Math.min(position + limit, total)
  // The second pass keeps only the window: one conversation is read twice and held once, in pages of
  // at most 500 rows, so a file of any size costs this process one page plus a chunk.
  const window = scanTranscript(file, matched => (matched > start && matched <= end ? 1 : 0)).rows
  const rows = (descending ? [...window].reverse() : window).map(row => projectRow(row, contentLimit))
  const nextCursor = descending
    ? (start > 0 ? `d${start}@${total}` : null)
    : (end < total ? encodeCursor(end, total) : null)
  return { messages: rows, nextCursor, total }
}

/** One transcript row before the body budget is applied. */
interface TranscriptRow {
  readonly id: string | null
  readonly role: string
  readonly at: number | null
  readonly content: unknown
}

/**
 * One stored conversation's conversation entries, oldest first, counted in full and kept only where
 * the caller asked for them.
 *
 * `keep(matchedIndex)` answers `1` for a row the caller wants and `0` for one it does not (the index
 * is 1-based), so the same single pass serves both questions a page asks: how many entries there are
 * (`total`), and which of them to hold. `message` carries the engine's own message object,
 * `custom_message` is how the engine stores what it injected outside a turn (a skill, a subagent's
 * answer, an aside), and both participate exactly as they do in the desktop's own transcript. A
 * malformed line is skipped rather than fatal - a truncated tail is what a killed writer leaves, and
 * the rest of the conversation is still readable.
 */
function scanTranscript(file: string, keep: (matched: number) => number): { total: number; rows: TranscriptRow[] } {
  let total = 0
  const rows: TranscriptRow[] = []
  readLines(file, line => {
    if (line === '') return true
    let entry: {
      id?: unknown
      type?: unknown
      timestamp?: unknown
      message?: { role?: unknown; content?: unknown; timestamp?: unknown }
    }
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      return true
    }
    if (!isConversationEntry(entry)) return true
    total += 1
    if (keep(total) === 0) return true
    const message = entry.message ?? {}
    const at = typeof message.timestamp === 'number'
      ? message.timestamp
      : (typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN)
    rows.push({
      id: typeof entry.id === 'string' ? entry.id : null,
      role: typeof message.role === 'string' ? message.role : 'unknown',
      at: Number.isFinite(at) ? at : null,
      content: message.content,
    })
    return true
  })
  return { total, rows }
}

/** Where a page starts, from the cursor that named it: the offset, checked against the transcript. */
function cursorOffsetOf(cursor: unknown, total: number, descending: boolean): number {
  if (cursor === undefined || cursor === null) return descending ? total : 0
  if (typeof cursor !== 'string') throw invalidInput('The cursor must be a string.')
  const match = (descending ? /^d(\d+)@(\d+)$/ : /^c(\d+)@(\d+)$/).exec(cursor)
  if (match === null) throw new HostError(ERROR_CODES.stale_cursor, 'The cursor is not usable.')
  const offset = Number(match[1])
  const issued = Number(match[2])
  if (issued !== total || offset > total) {
    throw new HostError(ERROR_CODES.stale_cursor, 'The transcript changed since this cursor was issued.')
  }
  return offset
}

/** One row as a plugin reads it: the id, the role, the time, and a body only inside its budget. */
function projectRow(row: TranscriptRow, contentLimit: number | null): Record<string, unknown> {
  const projected: Record<string, unknown> = { id: row.id, role: row.role, at: row.at }
  if (contentLimit !== null) projected.text = textOf(row.content, contentLimit)
  return projected
}

/** The text one message carries, in the shape the engine stores it, cut to a byte budget. */
function textOf(content: unknown, byteLimit: number): string {
  const parts: string[] = []
  if (typeof content === 'string') {
    parts.push(content)
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue
      const record = part as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    }
  }
  const text = parts.join('\n')
  return cutBytes(text, byteLimit)
}

/** Cuts a string to at most `limit` UTF-8 bytes, never splitting a character. */
function cutBytes(text: string, limit: number): string {
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.length <= limit) return text
  let end = limit
  // A UTF-8 continuation byte starts with `10`; stepping back to the start of a sequence keeps the
  // cut on a character boundary, which is what makes the answer valid text.
  while (end > 0 && (encoded[end] & 0b1100_0000) === 0b1000_0000) end -= 1
  return encoded.subarray(0, end).toString('utf8')
}

/**
 * `usage.turns`: one row per model call inside the window the caller named, oldest call first.
 *
 * The whole window is read before the page is cut, because `total` is part of the answer and a page
 * that guessed at it would hand a plugin a `nextCursor: null` in the middle of a history. What keeps
 * that affordable is the cap: a window holding more calls than [`USAGE_TURNS_MAX`] is refused
 * (`invalid_request`, with the sentence saying to narrow it) instead of being read into memory, so the
 * cost of one call is bounded by a number this build publishes rather than by the user's history.
 */
export async function usageTurns(
  port: PluginSessionsPort,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const limit = pageLimit(frame.limit)
  const fromMs = optionalNumber(frame.fromMs)
  const toMs = optionalNumber(frame.toMs)
  const sessionId = text(frame.sessionId)
  const projectId = text(frame.projectId)

  // The project filter is the row's workspace (a stored conversation's cwd is the bucket it lives in),
  // resolved to the ids it names *once*, so the filter runs inside the scan and the page offsets are
  // offsets into the filtered stream - applying it afterwards would have paginated the unfiltered one.
  let inProject: Set<string> | null = null
  if (projectId !== undefined) {
    inProject = new Set(
      conversationRows(port.paths)
        .filter(row => row.cwd === projectId)
        .map(row => row.id),
    )
  }

  const rows: Record<string, unknown>[] = []
  for (const file of listSessionFiles(port.paths).slice(0, USAGE_MAX_FILES)) {
    const id = sessionIdFor(file)
    if (sessionId !== undefined && id !== sessionId) continue
    if (inProject !== null && !inProject.has(id)) continue
    try {
      await port.sdk.visitSessionEntries(file, value => {
        const row = turnRow(id, file, value, fromMs, toMs)
        if (row !== null) rows.push(row)
      })
    } catch (error) {
      logLine(`usage.turns skipped ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (rows.length > USAGE_TURNS_MAX) {
      throw new HostError(
        ERROR_CODES.invalid_input,
        `That window holds more than ${USAGE_TURNS_MAX} model calls; narrow it by time or by session.`,
      )
    }
  }
  rows.sort((left, right) => Number(left.at) - Number(right.at))
  const offset = offsetOf(frame.cursor, rows.length)
  const page = rows.slice(offset, offset + limit)
  const next = offset + limit < rows.length ? encodeCursor(offset + limit, rows.length) : null
  return { turns: page, nextCursor: next, total: rows.length }
}

/** One entry's accounting, when the entry is a model call inside the window. */
function turnRow(
  sessionId: string,
  file: string,
  value: unknown,
  fromMs: number | null,
  toMs: number | null,
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as {
    type?: string
    timestamp?: string
    message?: { usage?: Record<string, unknown>; provider?: string; model?: string }
    usage?: Record<string, unknown>
    provider?: string
    model?: string
  }
  const isMessage = entry.type === 'message'
  if (!isMessage && entry.type !== 'model_usage') return null
  const usage = isMessage ? entry.message?.usage : entry.usage
  if (usage === undefined) return null
  const at = entry.timestamp === undefined ? Number.NaN : Date.parse(entry.timestamp)
  if (!Number.isFinite(at)) return null
  if (fromMs !== null && at < fromMs) return null
  if (toMs !== null && at > toMs) return null
  return {
    sessionId,
    at,
    provider: (isMessage ? entry.message?.provider : entry.provider) ?? null,
    model: (isMessage ? entry.message?.model : entry.model) ?? null,
    input: numberField(usage, 'input'),
    output: numberField(usage, 'output'),
    cacheRead: numberField(usage, 'cacheRead'),
    cacheWrite: numberField(usage, 'cacheWrite'),
    reasoning: numberField(usage, 'reasoning'),
    costUsd: numberField(usage, 'costUsd'),
    file,
  }
}

function numberField(usage: Record<string, unknown>, name: string): number {
  const value = usage[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** A page size: the default when none was named, or what the caller named. */
function pageLimit(value: unknown): number {
  if (value === undefined || value === null) return 200
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw invalidInput('The limit must be a positive integer.')
  }
  return value
}

/** A body budget: `null` when the caller asked for no bodies at all. */
function contentLimitOf(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw invalidInput('The contentLimit must be a positive integer.')
  }
  return value
}

/**
 * The offset an ascending cursor names, checked against the list size it was issued for.
 *
 * The size travels in the cursor (`c<offset>@<total>`, `history.ts`'s scheme) so a list that changed
 * between two pages is refused rather than silently shifted: a plugin that kept a cursor across a
 * new conversation would otherwise skip or repeat the row the shift moved onto its boundary.
 */
function offsetOf(cursor: unknown, total: number): number {
  if (cursor === undefined || cursor === null) return 0
  if (typeof cursor !== 'string') throw invalidInput('The cursor must be a string.')
  const match = /^c(\d+)@(\d+)$/.exec(cursor)
  if (match === null) throw new HostError(ERROR_CODES.stale_cursor, 'The cursor is not usable.')
  const offset = Number(match[1])
  const issued = Number(match[2])
  if (issued !== total || offset > total) {
    throw new HostError(ERROR_CODES.stale_cursor, 'The list changed since this cursor was issued.')
  }
  return offset
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function requiredText(value: unknown, name: string): string {
  const found = text(value)
  if (found === undefined) throw invalidInput(`${name} must be a non-empty string.`)
  return found
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidInput('A millisecond bound must be a number.')
  return value
}

/**
 * The commands that only report on a live session: its state, the catalogue, a dialog answer, and a
 * replay of its retained events.
 *
 * Split out of the registry because none of them touches the record's lifecycle - no open, no
 * eviction, no teardown - and the registry's only part in each is the lookup that turns an id into
 * the record (or into `session_not_found`). What they read is the record itself, which is why the
 * port they need is one call wide.
 */

import type { HostPaths } from './env.ts'
import { entryMessage, pageLimit, readColdPage, windowOf } from './history.ts'
import type { HistoryPage } from './history.ts'
import type { ModelSummary } from './models.ts'
import { ERROR_CODES, HostError, invalidInput } from './protocol/errors.ts'
import { text } from './protocol/fields.ts'
import type { SdkBundle } from './sdk.ts'
import type { LiveSession, TranscriptView } from './sessions.ts'
import { sessionStateView } from './session-view.ts'
import { resolveSessionFile, sessionIdFor } from './store.ts'

/** What the reads below need from the registry: its records, and the model catalogue. */
export interface SessionReadsPort {
  /** The live record an id names, or the refusal the wire contract states. */
  require: (sessionId: string) => LiveSession
  /** The models the engine currently offers, as `session_config` reports them. */
  models: () => ModelSummary[]
  /** The thinking-level vocabulary the engine accepts. */
  thinkingLevels: readonly string[]
}

/** Current state of one session, published after the frames it counts. */
export async function readState(port: SessionReadsPort, sessionId: unknown): Promise<Record<string, unknown>> {
  const live = port.require(text(sessionId, 'sessionId', true) as string)
  live.lastActivityMs = Date.now()
  await live.events.flush()
  return { state: sessionStateView(live) }
}

/**
 * Model, command and thinking-level catalogue for the engine, optionally scoped to a session.
 *
 * The session half is optional on purpose: the catalogue is what a hero - or the settings page -
 * needs before any conversation exists, and only a session can report the command list it was
 * given.
 */
export function readConfig(port: SessionReadsPort, sessionId: unknown): Record<string, unknown> {
  const models = port.models()
  const requested = text(sessionId, 'sessionId', false)
  const live = requested === undefined ? undefined : port.require(requested)
  const first = models[0]
  return {
    models,
    commands: live?.commands ?? [],
    thinkingLevels: port.thinkingLevels,
    ...(first === undefined ? {} : { defaultModel: { provider: first.provider, id: first.id } }),
  }
}

/** Answers one engine dialog. */
export function respondUi(port: SessionReadsPort, request: Record<string, unknown>): Record<string, unknown> {
  const live = port.require(text(request.sessionId, 'sessionId', true) as string)
  const requestId = text(request.requestId, 'requestId', true) as string
  const response = request.response
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw invalidInput('A UI response must be an object.')
  }
  live.lastActivityMs = Date.now()
  live.ui.respond(requestId, response as Record<string, unknown>)
  return {}
}

/** Replays a session's retained events. */
export function replayEvents(port: SessionReadsPort, request: Record<string, unknown>): Record<string, unknown> {
  const live = port.require(text(request.sessionId, 'sessionId', true) as string)
  const from = request.fromSeq
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 1) {
    throw invalidInput('fromSeq must be a positive integer.')
  }
  const to = request.toSeq
  if (to !== undefined && to !== null && (typeof to !== 'number' || !Number.isInteger(to))) {
    throw invalidInput('toSeq must be an integer.')
  }
  const replayed = live.events.replay(from, to === undefined || to === null ? null : to)
  return { events: replayed.events, truncated: replayed.truncated }
}

/** What the paged read needs on top of the projection port: the store, and both lookups. */
export interface SessionHistoryPort {
  readonly paths: HostPaths
  readonly sdk: SdkBundle
  /** The live record one routing id names, or `undefined` when nothing loaded holds it. */
  live: (sessionId: string) => LiveSession | undefined
  /** The same, or the refusal the wire contract states. */
  require: (sessionId: string) => LiveSession
}

/**
 * Reads one page of a transcript: from memory when the session is live, from disk otherwise.
 *
 * A conversation this process holds is read from its own **transcript** - the message entries the
 * active branch holds, in the order the engine wrote them - which is the same thing a cold read gets
 * out of the file. It is deliberately *not* `agent.messages`: that array is the engine's **context**,
 * what the next request would carry, and the engine rewrites it when it compacts. A compaction
 * replaces the archived span with a summary and keeps only the retained window, so a read through the
 * context makes an auto-compaction *delete the reader's history from the screen* - the conversation
 * they were reading turns into its last two or three rows, with no rail and nothing to scroll,
 * because what is left is shorter than the pane. The branch is what the conversation *is*: compaction
 * adds a node to it and leaves every message before that node in place. A session nothing holds is a
 * file, and its page comes from the streaming reader in `history.ts`. Both are addressed by `cursor`,
 * and a live session refuses a cursor while it is writing: the cursor is bound to a transcript size,
 * and a running turn moves it.
 */
export async function readHistoryPage(
  port: SessionHistoryPort,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const limit = pageLimit(request.limit)
  const cursor = text(request.cursor, 'cursor', false)
  const requestedId = text(request.sessionId, 'sessionId', false)
  const requestedFile = text(request.sessionFile, 'sessionFile', false)
  if (requestedId === undefined && requestedFile === undefined) {
    throw invalidInput('session_history_page requires a sessionId or a sessionFile.')
  }

  const file = requestedFile === undefined ? null : resolveSessionFile(port.paths, requestedFile)
  const live = requestedId === undefined
    ? port.live(sessionIdFor(file as string))
    : port.require(requestedId)

  if (live !== undefined) {
    if (cursor !== undefined && live.agent.isStreaming) {
      // A cursor is bound to the transcript size it was issued against, and a running turn
      // appends to the transcript, so the page after it is guaranteed to come back stale.
      // Saying the session is writing names the real cause instead of the symptom.
      throw new HostError(ERROR_CODES.session_busy, 'The session is writing, so a paged read cannot be positioned.')
    }
    const view = transcriptOf(live)
    const page = windowOf(view.messages, view.messages.length, cursor, limit)
    return pageResponse(withEntryIds(view.entryIds, page), live.sessionId)
  }

  const target = file as string
  return pageResponse(await readColdPage(port.sdk, target, cursor, limit), sessionIdFor(target))
}

/**
 * A live conversation's rows, projected once per revision.
 *
 * The branch is the conversation as it was written, and the two readings only part company when the
 * engine compacts - which is exactly when the difference is visible to the reader. A branch that
 * holds no message at all (a session that was just opened, or one whose every entry was rewritten
 * away) falls back to the context, so a read is never answered with an empty page for a session the
 * engine can describe.
 *
 * Both things a page needs - the rows in order, and the entry id each row was written as - come out
 * of one pass and are kept on the record until an engine event moves {@link LiveSession.historyRevision}.
 * A walk asks for several pages in a row, and rebuilding the branch twice per page (once for the
 * rows, once for the id map, as this used to) made a long conversation's open cost grow with
 * pages × entries instead of with the transcript.
 */
function transcriptOf(live: LiveSession): TranscriptView {
  const cached = live.transcript
  if (cached !== null && cached.revision === live.historyRevision) return cached
  const messages: unknown[] = []
  const entryIds = new Map<unknown, string>()
  for (const entry of live.manager.getBranch()) {
    if (entry.type === 'message') entryIds.set(entry.message, entry.id)
    const message = entryMessage(entry)
    if (message !== undefined) messages.push(message)
  }
  const view: TranscriptView = {
    revision: live.historyRevision,
    messages: messages.length > 0 ? messages : (live.agent.messages as unknown[]),
    entryIds,
  }
  live.transcript = view
  return view
}

/**
 * Stamps one page with the session entry each message was written from.
 *
 * A conversation's entries carry the ids every entry-addressed command speaks - a rewind names
 * one - while the messages a reader sees are the engine's own context. The two are paired by
 * object identity first, which is exact rather than positional: the engine's context is built by
 * pushing `entry.message` itself (`session/session-context.ts`, `appendMessage`), so a message
 * the active branch does not hold - a synthetic reminder, a file mention, a compaction summary -
 * simply finds no id and travels without one.
 *
 * A rewrite performed *inside* a live session (continuing the conversation from an earlier
 * entry) can hand back a message the engine rebuilt rather than the entry's own object - it did
 * so for the one whose tool result the rewind cut away - and that row legitimately carries no id:
 * it is not the message the entry holds any more. Measured against the SDK, a rewritten row keeps
 * neither the object nor the entry's timestamp (the message's own stamp is when it was created),
 * so identity is the only pairing that cannot lie, and a row it does not claim is left without an
 * id. The frontend then offers its rewind action only where an id exists, or where the host's own
 * `tipEntryId` names the turn that just settled.
 *
 * The copy is made only for messages that own an id: a page is at most a few hundred entries, and
 * the engine's own message objects are never mutated.
 */
function withEntryIds(entryIds: ReadonlyMap<unknown, string>, page: HistoryPage): HistoryPage {
  if (entryIds.size === 0) return page
  const messages = page.messages.map((message) => {
    if (typeof message !== 'object' || message === null) return message
    const entryId = entryIds.get(message)
    if (entryId === undefined) return message
    return { ...(message as Record<string, unknown>), entryId }
  })
  return { ...page, messages }
}

/** One page as the wire carries it: the rows, the transcript size, and the next cursor. */
function pageResponse(page: HistoryPage, sessionId: string): Record<string, unknown> {
  return {
    messages: page.messages,
    totalMessages: page.totalMessages,
    sessionId,
    ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
  }
}

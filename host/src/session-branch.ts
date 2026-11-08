/**
 * Moving one conversation through its own history: rewinding to a message, starting a new
 * conversation beside it, and continuing from a point inside it.
 *
 * The three are one gesture with different targets, and the engine already carries each in the
 * shape it needs:
 *
 * - **Rewind** (a user message taken back) is `navigateTree`: the leaf moves to the message's
 *   parent, in the *same* file, and the message's own text comes back for the composer. The engine
 *   keeps the abandoned tail as an off-branch sibling of the session tree, so the conversation list
 *   still has one row, the title still names it, and reopening it reads the shortened branch.
 * - **A new conversation from a message** is `branch`: the engine rewrites the session onto a file
 *   of its own ending before the message, and the conversation that was left stays openable as its
 *   own row.
 * - **Continue from here** is `navigateTree` + `fork`: a copy that ends on the entry the reader
 *   pointed at, with the original whole.
 *
 * This module is the host's half of all three - the reads the picker is drawn from, the
 * preconditions the engine does not state as wire errors, and the identity move the registry has to
 * make after a command that changes the session's file (never for a rewind: that one stays put).
 *
 * Nothing here restores files: the engine's rewind is a conversation operation, and a working tree
 * is not part of what it moves (see `docs/tree.md` upstream). A caller that wants code state to
 * follow a branch is asking for a hook (`session_before_branch`), not for this command.
 */

import { MAX_BRANCH_POINTS } from './constants.ts'
import { ERROR_CODES, HostError, invalidInput } from './protocol/errors.ts'
import { text } from './protocol/fields.ts'
import type { SessionEntry, SessionMessageEntry } from './sdk.ts'
import { canonicalSessionPath, sessionIdFor } from './store.ts'
import type { LiveSession } from './sessions.ts'
import { sessionTitleText } from './session-title.ts'
import { sessionStateView } from './session-view.ts'

/** What the commands below need from the registry: its records, and its own map surgery. */
export interface SessionBranchPort {
  /**
   * The engine's type tag for the message a `/skill:<name>` invocation is stored as.
   *
   * Read from the engine bundle rather than spelled here: the entry it names is part of the
   * engine's stored session format, and the one command that resolves a rewind against that format
   * has to read the same tag the engine wrote.
   */
  skillPromptType: string
  /** The live record an id names, or the refusal the wire contract states. */
  require: (sessionId: string) => LiveSession
  /**
   * Moves a record onto the identity its engine session now has.
   *
   * The registry owns the map, so the move happens there: the old id is dropped, the new one is
   * taken, and the record's own fields and event pipe follow, so every later frame is stamped with
   * the id the file now digests to.
   */
  rekey: (live: LiveSession, next: { sessionId: string; sessionFile: string }) => void
}

/** A user turn, as the engine stores it: its text, and any text parts beside it. */
interface BranchSourceMessage {
  readonly role: 'user'
  readonly content: string | readonly { readonly type?: unknown; readonly text?: unknown }[]
}

/** One message a conversation can branch from, as the picker reads it. */
function branchPoint(entry: SessionMessageEntry & { message: BranchSourceMessage }): Record<string, unknown> {
  const content = entry.message.content
  let body = ''
  if (typeof content === 'string') {
    body = content
  } else {
    const parts: string[] = []
    for (const part of content) {
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    }
    body = parts.join('\n')
  }
  return {
    entryId: entry.id,
    text: stripComposerMarks(body).trim(),
    timestamp: entry.timestamp,
  }
}

/** A user message of the conversation, in the engine's own entry shape. */
function isUserMessageEntry(
  entry: SessionEntry,
): entry is SessionMessageEntry & { message: BranchSourceMessage } {
  if (entry.type !== 'message') return false
  const message: unknown = entry.message
  if (typeof message !== 'object' || message === null || !('role' in message)) return false
  // `in` leaves the property `unknown`, which is what an engine-owned union has to be read as
  // here: the role word is the whole of the check, and the predicate above states the rest.
  return message.role === 'user'
}

/**
 * Whether one entry is a turn the reader wrote, which is what a rewind cuts at.
 *
 * A plain prompt is a `message` entry. A `/skill:<name>` invocation is a `custom_message` entry
 * instead: its content is the expanded SKILL.md the model reads, and the draft the reader typed
 * lives in `details.prompt` - but it is still the message they sent, and the engine's own rewind
 * reads it as one (`pi-tui/chat/transcript-entry.ts::isUserRequestEntry`,
 * `agent-session.ts::navigateTree`: leaf moves to the parent and the draft returns to the editor).
 * Leaving it out refused exactly the row the reader had just sent: the transcript reported its
 * timestamp, the host found no user message carrying it, and the answer was "No user message of
 * this conversation was written at that time" (2026-10-31, user report).
 */
function isUserTurnEntry(entry: SessionEntry, skillPromptType: string): boolean {
  if (isUserMessageEntry(entry)) return true
  if (entry.type !== 'custom_message') return false
  return (
    entry.customType === skillPromptType && entry.attribution === 'user' && entry.display !== false
  )
}

/**
 * The messages this conversation can branch from, oldest first.
 *
 * Read from the manager's own branch - the root-to-leaf path the engine would rewrite - so the
 * picker offers exactly the points `branch` accepts, and a message on an abandoned path (a branch
 * this session already left) is not offered as one. The list is capped at its newest end: a long
 * conversation is branched from near its end, and a picker nobody can scroll to the top of would
 * still be a picker.
 */
export function readBranchPoints(port: SessionBranchPort, request: Record<string, unknown>): Record<string, unknown> {
  const live = port.require(text(request.sessionId, 'sessionId', true) as string)
  const entries = live.manager.getBranch().filter(isUserMessageEntry)
  const points = entries.map(entry => branchPoint(entry))
  const kept = points.length > MAX_BRANCH_POINTS ? points.slice(points.length - MAX_BRANCH_POINTS) : points
  return { points: kept, truncated: kept.length < points.length }
}

/**
 * Branches the conversation at one user message: a new session file, continuing from before it.
 *
 * The engine's own refusal is the gate on the message (only a user message branches), and the
 * running turn is the host's: the engine does not stop a turn to branch, and a rewrite under one
 * would take the transcript out from under the work that is appending to it - the same line every
 * other command that replaces a transcript draws.
 *
 * The answer carries the new identity and the branch point's own text, which is what the caller
 * offers back as a draft. The old transcript is not touched: the engine wrote the new file with the
 * old one as its parent, so the conversation that was left stays openable as a row of its own.
 */
export async function branchConversation(
  port: SessionBranchPort,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const live = port.require(text(request.sessionId, 'sessionId', true) as string)
  const entryId = text(request.entryId, 'entryId', true) as string
  requireIdle(live)
  const entry = live.manager.getEntry(entryId)
  if (entry === undefined || !isUserMessageEntry(entry)) {
    throw invalidInput('entryId must name a user message of this session.')
  }

  // A goal continuation waiting at a yield is void across a rewrite, and goal state has to be
  // quiesced before the transcript moves: the engine's own RPC host brackets branch, switch and
  // fork with the same two calls (`rpc-mode.ts`).
  await live.goal.beginSessionChange()
  const branched = await live.agent.branch(entryId).finally(() => live.goal.endSessionChange())
  if (branched.cancelled) {
    // Nothing was written and nothing moved: an extension refused the branch before the engine
    // rewrote anything, so the caller keeps the session it had.
    return { cancelled: true }
  }

  // The branch is the rewrite the engine just performed, so the file it landed on is the one fact
  // the rest of this answer is derived from. A manager without one is a session that cannot be
  // addressed afterwards, which is what this failure says rather than digesting `undefined` into
  // an id no command could reach.
  const branchedFile = live.manager.getSessionFile()
  if (branchedFile === undefined) {
    throw new HostError(
      ERROR_CODES.session_not_found,
      'The branched conversation has no session file, so it cannot be addressed.',
    )
  }
  const sessionFile = canonicalSessionPath(branchedFile)
  const sessionId = sessionIdFor(sessionFile)
  const previous = { sessionId: live.sessionId, sessionFile: live.sessionFile }
  const title = live.agent.sessionName ?? null
  port.rekey(live, { sessionId, sessionFile })
  await nameBranch(live, title)
  // Published on the new identity, so a reader already listening to it gets the snapshot the
  // engine's rewrite produced; the response carries the same view for the caller that is not.
  live.events.emit({ type: 'state', state: sessionStateView(live) })
  await live.events.flush()

  return {
    cancelled: false,
    sessionId,
    sessionFile,
    previousSessionId: previous.sessionId,
    previousSessionFile: previous.sessionFile,
    text: branched.selectedText,
    state: sessionStateView(live),
  }
}

/**
 * Rewinds a conversation to just before one of its user messages, in place.
 *
 * The URL-facing name of the gesture (`撤回`): the message and everything after it leave the
 * conversation's active branch, and the caller offers the message back as a draft. The engine's
 * `navigateTree` is the operation the reference client's rewind uses (`selector-controller.ts`'s
 * esc-esc): it moves the session's leaf to the message's parent **inside the same file**, so the
 * conversation keeps its id, its file, its title and its one row in the list. The entries the cut
 * dropped are still in the file as the engine's off-branch sibling, which is what makes the move
 * reversible from the session tree and what keeps this a conversation operation rather than a
 * deletion.
 *
 * `navigateTree` writes nothing (`summarize: false`), and the loader rebuilds the active branch
 * from the journal's last physical entry - so the leaf move alone would be undone by the next open.
 * The durable form is the engine's own: an empty `branch_summary` at the new leaf, the marker
 * `SessionManager.discardEntryDurably` writes to state the same thing. Nothing displays it (both
 * readers skip a summary with no text) and it makes the cut the last word in the file.
 *
 * A timestamp is the engine's own fact on both paths (the transcript read reports the same
 * `timestamp` the live frame carried), so the two identify the same entry. The newest match wins:
 * two prompts in the same millisecond are the same address, and the one the reader can still see is
 * the one being taken back.
 */
export async function rewindConversation(
  port: SessionBranchPort,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const live = port.require(text(request.sessionId, 'sessionId', true) as string)
  const requestedId = text(request.entryId, 'entryId', false)
  const at = typeof request.at === 'number' && Number.isSafeInteger(request.at) ? request.at : undefined
  const entryId = resolveRewindEntry(
    live.manager.getBranch(),
    requestedId,
    at,
    port.skillPromptType,
  )
  requireIdle(live)

  // A goal continuation waiting at a yield is void across a rewrite, and goal state has to be
  // quiesced before the transcript moves: the same brackets the branch below and the engine's own
  // RPC host use (`rpc-mode.ts`).
  await live.goal.beginSessionChange()
  const navigated = await live.agent
    .navigateTree(entryId, { summarize: false })
    .finally(() => live.goal.endSessionChange())
  if (navigated.cancelled) {
    // An extension refused the leaf move before anything was written, so the conversation is
    // exactly as it was.
    return { cancelled: true }
  }

  live.manager.branchWithSummary(live.manager.getLeafId(), '')
  // The branch moved without an engine event, so a paged read that cached it before this point has
  // to rebuild (`session-reads.ts::transcriptOf`).
  live.historyRevision += 1
  live.events.emit({ type: 'state', state: sessionStateView(live) })
  await live.events.flush()

  return {
    cancelled: false,
    sessionId: live.sessionId,
    text: navigated.editorText ?? '',
  }
}

/**
 * The entry a rewind addresses, from what the row carried.
 *
 * Exported for the two rules worth checking without an engine: a live row's timestamp names the
 * message the transcript will report (the newest match is the row the reader can still see), and the
 * messages a rewind may cut at are the reader's own turns - which includes the `/skill:<name>`
 * invocation the engine stores as a custom message (`isUserTurnEntry`).
 */
export function resolveRewindEntry(
  branch: readonly SessionEntry[],
  requestedId: string | undefined,
  at: number | undefined,
  skillPromptType: string,
): string {
  if (requestedId !== undefined) return requestedId
  if (at === undefined) throw invalidInput('Rewind needs the entry id or the message timestamp.')
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]
    if (entry === undefined || !isUserTurnEntry(entry, skillPromptType)) continue
    if (entryStamp(entry) === at) return entry.id
  }
  throw new HostError(ERROR_CODES.invalid_input, 'No user message of this conversation was written at that time.')
}

/**
 * The engine's timestamp for one entry, in Unix milliseconds, when it carries one.
 *
 * A `message` entry keeps its own stamp inside the message; a `custom_message` has no message to
 * wrap it, so the entry's own `timestamp` is the one both readers report (`history.rs::timestamp_of`).
 * An older journal writes it as ISO, the engine's live type only names milliseconds.
 */
function entryStamp(entry: SessionEntry): number | null {
  const message: unknown = 'message' in entry ? entry.message : entry
  if (typeof message !== 'object' || message === null || !('timestamp' in message)) return null
  const stamp = message.timestamp
  if (typeof stamp === 'number' && Number.isFinite(stamp)) return stamp
  if (typeof stamp !== 'string') return null
  const millis = Date.parse(stamp)
  return Number.isNaN(millis) ? null : millis
}

/**
 * Starts a conversation of its own that continues from one entry inside this one.
 *
 * The other half of the same gesture (`branch` above): the point a reader picks when it is not a
 * message to rewrite but a place to carry on from — a turn's output, the call it ended on. The
 * conversation they were reading is *not* rewritten: one engine call, `fork(entryId)`, gives it a
 * copy that ends where they pointed and leaves the original whole.
 *
 * The atomic form matters here. Its refusals — an extension's `session_before_branch` cancel, or a
 * session that became busy while the hook awaited — happen **before** any state is discarded, so a
 * copy that cannot be made leaves the conversation exactly as the reader had it. The two-step this
 * replaced (move the leaf with `navigateTree`, then `fork()`) had no safe undo: `navigateTree`
 * treats a user-message target as a rewind past itself, so moving the leaf back to that entry was
 * not the inverse of moving it away.
 *
 * The new conversation's active path ends at the entry, the original keeps every message it had, and
 * both remain openable rows; the caller switches to the new identity.
 */
export async function branchFromEntry(
  port: SessionBranchPort,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const live = port.require(text(request.sessionId, 'sessionId', true) as string)
  const entryId = text(request.entryId, 'entryId', true) as string
  requireIdle(live)
  if (live.manager.getEntry(entryId)?.type !== 'message') {
    throw invalidInput('entryId must name a message entry of this session.')
  }

  await live.goal.beginSessionChange()
  let forked: boolean
  try {
    // The engine's atomic form: `session_before_branch` (reason `fork`) may cancel it, a session
    // that became busy refuses it, and both happen before anything is discarded. Only then is the
    // new file cut at this entry and this session switched onto it.
    forked = await live.agent.fork(entryId)
  } finally {
    live.goal.endSessionChange()
  }
  if (!forked) {
    // A hook refused the copy before any state was discarded: the conversation is exactly as it was.
    return { cancelled: true }
  }
  const branchedFile = live.manager.getSessionFile()
  if (branchedFile === undefined) {
    throw new HostError(
      ERROR_CODES.session_not_found,
      'The branched conversation has no session file, so it cannot be addressed.',
    )
  }
  const sessionFile = canonicalSessionPath(branchedFile)
  const sessionId = sessionIdFor(sessionFile)
  const previous = { sessionId: live.sessionId, sessionFile: live.sessionFile }
  const title = live.agent.sessionName ?? null
  port.rekey(live, { sessionId, sessionFile })
  await nameBranch(live, title)
  live.events.emit({ type: 'state', state: sessionStateView(live) })
  await live.events.flush()

  return {
    cancelled: false,
    sessionId,
    sessionFile,
    previousSessionId: previous.sessionId,
    previousSessionFile: previous.sessionFile,
    state: sessionStateView(live),
  }
}

/**
 * Names a conversation that was just branched off, so the list does not carry two rows reading the
 * same.
 *
 * The engine copies the title with everything else, and the reference client is what this follows
 * to the letter: the child is `Fork of <parent title>` (`zcode-cli`, `session-fork.ts`'s
 * `buildForkedSessionInput`), which reads the same in either language and leaves the parent named
 * as it was. Both gestures that start a conversation - a user message rewritten, and an answer
 * continued from - name it this way, because a list where one kind of branch is renamed and the
 * other is not is a list the reader has to learn twice.
 *
 * A title the engine has not written yet (a conversation nobody has named) is left alone: a name
 * invented here would claim a subject the conversation has not stated. The parent's name is taken
 * through {@link sessionTitleText} first, so a title model's translated marker
 * (`<标题>…</标题>`) is not carried into the child as part of its name.
 */
async function nameBranch(live: LiveSession, title: string | null): Promise<void> {
  const parent = sessionTitleText(title)
  if (parent === '') return
  await live.agent.setSessionName(`Fork of ${parent}`)
}

/**
 * The running-turn gate both rewrites share.
 *
 * The engine does not stop a turn to rewrite the conversation under it, and it does not have to:
 * the caller's own stop is what ends that work. Saying so is better than a rewrite that lands
 * halfway through a turn and takes the streamed messages with it.
 */
function requireIdle(live: LiveSession): void {
  if (live.agent.isStreaming) {
    throw new HostError(
      ERROR_CODES.session_busy,
      'The session is answering a turn; rewind after it ends or stop it first.',
    )
  }
}

/**
 * Drops the composer's own inline-attachment marks from message text.
 *
 * The desktop's composer writes one private-use code point per attachment into the draft, and
 * those code points travel to the engine with the prompt. A live editor is what they belong to: a
 * session title (material the engine hands to a title model, which has no font for them and would
 * name the conversation with a box), a picker row, or a draft offered back after a branch would
 * each render them as one. `U+FFFC` is the same fact from the other direction - the placeholder
 * some editors substitute for an image - and is dropped with them. The prompt itself keeps them,
 * because the feed pairs a sent message's chips to its files by their position.
 */
export function stripComposerMarks(text: string): string {
  return text.replace(/[\uE000-\uF8FF\uFFFC]/g, ' ')
}

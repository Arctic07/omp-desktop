/**
 * Letting one conversation go.
 *
 * A session's teardown is the part of the registry that touches nothing but the record it is
 * given: it releases that record's watches, disposes the engine session and closes the session
 * file's handle. Split out of the registry because it is self-contained, and because the record it
 * works on is structurally known here - any live session satisfies {@link DisposableSession} without
 * the registry exporting its own shape. Whether a transcript may be removed afterwards is its
 * caller's question, answered from the file ({@link transcriptHoldsMessage}).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { RpcGoalController } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal'

import { closeBtw } from './btw.ts'
import type { SessionEvents } from './events.ts'
import { isConversationEntry } from './history.ts'
import { logError, logLine } from './log.ts'
import { readLines } from './ndjson.ts'
import type { AgentSession, SessionManager, SdkBundle } from './sdk.ts'
import { canonicalSessionPath, sessionIdFor } from './store.ts'
import type { SubagentWatch } from './subagents.ts'
import type { UiBridge } from './ui.ts'
import { forgetUpstreamCompaction } from './upstream-compaction.ts'
import { writeGuard } from './write-guard.ts'

/** The record fields a teardown needs. */
export interface DisposableSession {
  readonly sessionId: string
  readonly sessionFile: string
  /**
   * The workspace the conversation was opened in.
   *
   * Read by the LSP release: the engine's language servers are keyed by the directory they were
   * started for and shared between every conversation in it, so which ones a teardown may stop is
   * a question about this field rather than about the session file.
   */
  readonly cwd: string
  readonly agent: AgentSession
  readonly manager: SessionManager
  /** Goal mode's non-terminal half; it holds no timer and dies with the engine session. */
  readonly goal: RpcGoalController
  readonly subagents: SubagentWatch
  /**
   * This session's dialog channel.
   *
   * Its open dialogs are settled here rather than by each caller: a dialog holds a timer and a
   * resolver that outlive every other part of the record, and a teardown that forgot them left a
   * failed open's dialogs to time out on their own. Nothing may emit through it after
   * {@link SessionEvents.dispose} has run, so the cancel is the first thing this teardown does.
   */
  readonly ui: UiBridge
  /** This session's outbound pipe; its queue and retry are ended with the record. */
  readonly events: SessionEvents
  /** Stops the engine's own name watch. */
  readonly releaseNameWatch: () => void
  /** Stops the engine's command-metadata watch. */
  readonly releaseCommandWatch: () => void
}

/**
 * Closes one session file's handle and drops what the engine retained for it.
 *
 * The three calls belong together and in this order: `seal()` raises the terminal write barrier,
 * `close()` drains the disk tail and closes the append writer, and `releaseRetainedEntries()` drops
 * the manager's in-memory transcript - work a later append would otherwise keep alive. A failure is
 * logged rather than raised: this runs inside teardowns that have already ended a conversation, and
 * a session that goes away with a log line is still gone.
 *
 * `label` names the session in that log line; the caller that has no record yet (an activation that
 * failed before one was registered) passes its own word for it.
 */
export async function closeSessionManager(manager: SessionManager, label: string): Promise<void> {
  try {
    manager.seal()
    await manager.close()
    manager.releaseRetainedEntries()
  } catch (error) {
    logError(`${label} file handle teardown failed`, error)
  }
}

/**
 * Takes back an open that failed before it produced a session.
 *
 * `SessionRegistry.open` builds a manager first - `SessionManager.create`/`open`, then
 * `ensureOnDisk`, which is what writes the file - and only then does the engine work that can
 * throw (`createAgentSession`, the extension runner's initialization). Nothing of that attempt is
 * reachable through the registry, so nothing else would ever collect it: the manager still holds
 * the file's single-writer lock, and - when this open created the file - the transcript holds
 * nothing but the engine's own stub header, which no later open would ever list or write to. Both
 * are released here. `existed` is what keeps a real transcript out of the removal: a conversation
 * that was already on disk is the user's, and a failed reopen has to leave it exactly as it was.
 */
export async function abandonOpen(manager: SessionManager, existed: boolean): Promise<void> {
  const opened = manager.getSessionFile()
  const sessionFile = typeof opened === 'string' ? canonicalSessionPath(opened) : null
  await closeSessionManager(manager, 'an abandoned session')
  if (!existed && sessionFile !== null) {
    removeSessionFiles(sessionFile, sessionIdFor(sessionFile), 'the open failed before it was written')
  }
}

/**
 * Takes one session down: watches off, engine disposed, file handle closed.
 *
 * Every path that ends a conversation goes through here - a close, an eviction, a release after a
 * hand-back, the process shutdown - so no path can leave a listener, a child or a file handle
 * behind. This method reads no file and decides nothing about one: whether a transcript may be
 * removed is its caller's question, answered from the file *after* the engine's tail has been drained
 * here ({@link transcriptHoldsMessage}).
 */
export async function disposeSession(session: DisposableSession, reason: string): Promise<void> {
  // The guard's per-conversation view dies with the conversation. Its version table stays: those
  // entries are what keeps a *surviving* conversation's view stale after this one wrote a file.
  writeGuard.forget(session.sessionId)
  // An armed upstream summary belongs to the engine session going away, never to the next one
  // opened on the same routing id.
  forgetUpstreamCompaction(session.sessionId)
  // Released before the teardown below, so a name the engine reports while the session is going
  // away never publishes through an event pipe this method is about to take down - and so the
  // children being disposed here do not publish their exit frames into it either.
  session.releaseNameWatch()
  session.releaseCommandWatch()
  session.subagents.dispose()
  // Open dialogs first, and before the pipe goes: a pending dialog holds a timer and a resolver no
  // other teardown step reaches, and after `events.dispose()` there is no pipe to answer through.
  session.ui.cancelAll()
  // And the pipe itself, once nothing can publish into it any more: a released session's queued
  // frames would otherwise be written under an id no reader has, and the congestion retry would keep
  // re-asking on its own schedule (`events.ts`'s `dispose`).
  session.events.dispose()
  // Before the engine session goes: a side answer still in flight lands its checkpoint, and the
  // controller dies with the conversation it belonged to.
  await closeBtw(session.agent)
  try {
    // Why this conversation went away is the host's fact, so the host writes it: the engine drops
    // the reason on the way to the transcript. `createAgentSession` replaces `session.dispose` with
    // a wrapper that takes no parameters and calls the class method bare
    // (`oh-my-pi:src/sdk.ts`, "originalDispose = session.dispose.bind(session)"), so every
    // `session_exit` this app can read says `reason:"dispose", kind:"normal"` whatever teardown
    // asked for. Measured 2026-10-29: 1145 of 1150 markers in the installed data root say that,
    // including the evictions and closures whose reason is logged elsewhere; see the note
    // `removed:notes/implemented/bug-fix/2026-10-29-session-exit-reason-dropped-by-dispose-wrapper.md`.
    logLine(`session ${session.sessionId} teardown (${reason})`)
    await session.agent.dispose({ reason: reason as never })
  } catch (error) {
    logError(`session ${session.sessionId} dispose failed`, error)
  }
  await closeSessionManager(session.manager, `session ${session.sessionId}`)
}

/**
 * The last pass over a conversation as the process ends.
 *
 * A close keeps its file - the caller may hand a transcript back and forth, and what is written
 * there is not the host's to throw away (contract §4) - but a process that ends with a conversation
 * nothing was ever written to would leave an empty file behind for every hero the user looked at,
 * because the desktop opens one for its composer before the first message. Only that case is taken
 * away, and only here.
 *
 * Written to is read off the file, after {@link disposeSession} drained the engine's tail into it —
 * the same reading, at the same point, that `session-files.ts::closeConversation` takes. The engine's
 * message list is not that reading: a conversation rewound to its first prompt holds no messages in
 * the branch the engine reports and still has them on disk.
 */
export async function disposeSessionsAtShutdown(sessions: readonly DisposableSession[], reason: string): Promise<number> {
  let removed = 0
  for (const session of sessions) {
    await disposeSession(session, reason)
    if (!transcriptHoldsMessage(session.sessionFile)) {
      removeSessionFiles(session.sessionFile, session.sessionId, 'nothing was written to it')
      removed += 1
    }
  }
  return removed
}

/**
 * Whether a transcript on disk holds conversation content.
 *
 * This is the question a removal has to answer, and the file is the only thing that can answer it: a
 * session the reader rewound to its first prompt holds no messages *in the branch the engine reports*
 * while the file keeps every cut-away entry as an off-branch sibling of its session tree
 * (`state/session-rows.ts::dropsFileOnRelease`). The rail still lists it, because its `blank` flag
 * only reads a window of the file's head (`src-tauri/src/services/session_index.rs`), while the record
 * on screen looks empty.
 *
 * What counts as content is `history.ts::isConversationEntry`, the vocabulary every other reader on
 * this side speaks: a file is never drawn as a conversation here and disposable there.
 *
 * The read stops at the first conversation line, so the cost is one chunk for every transcript that
 * has one. A transcript without any is a draft, and a draft is small.
 */
export function transcriptHoldsMessage(sessionFile: string): boolean {
  let holds = false
  const readable = readLines(sessionFile, (line) => {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      // A line that does not parse is the engine's or a killed writer's half-entry, never a message:
      // the caller hears about it as "no message on this line" and the read goes on.
      return true
    }
    if (!isConversationEntry(entry)) return true
    holds = true
    return false
  })
  // A file this cannot read is kept: an unreadable transcript is not evidence that it holds nothing.
  return holds || !readable
}

/**
 * Removes what a conversation owns on disk: its transcript, and the artifact directory the engine
 * keeps beside it.
 *
 * The directory is the transcript's own path without the `.jsonl` suffix - the engine's convention,
 * not ours (`session-manager.ts`'s `artifactsDirectoryFor`: `<file>.jsonl` -> `<file>`) - and it is
 * where a turn's subagent outputs land, so leaving it behind would leave a deleted conversation's
 * children readable under a name nothing lists any more.
 *
 * Only ever called with a path the caller has already resolved inside the host session directory
 * (`resolveSessionFile`), and the directory it derives is checked to be that path's sibling
 * ({@link artifactsDirectoryFor}) rather than trusted to be: a name that is nothing but the suffix -
 * `<sessionDir>/.jsonl`, which `resolveSessionFile` accepts - used to derive the store's own root and
 * hand `rm -r` every conversation in it (2026-11-03, security review).
 *
 * Answers whether anything was actually there, which is what a delete reports back.
 */
export function removeSessionFiles(sessionFile: string, sessionId: string, why: string): boolean {
  // Derived before the transcript goes: the rule reads the transcript's own kind, and a directory
  // wearing a transcript's name owns no artifact directory.
  const artifacts = artifactsDirectoryFor(sessionFile)
  let removed = false
  removed = removePath(sessionFile, `session ${sessionId} transcript removal failed`, false) || removed
  if (artifacts !== null) {
    removed = removePath(artifacts, `session ${sessionId} artifact removal failed`, true) || removed
  }
  if (removed) logLine(`session ${sessionId} files removed (${why})`)
  return removed
}

/**
 * The artifact directory of a transcript, by the engine's own rule; null for a path that is not one.
 *
 * `<name>.jsonl` keeps `<name>` beside it, so the derived directory is a sibling of the transcript by
 * construction and the check below is what holds that: a path whose stem is not a sibling name is not
 * the engine's layout, and `rm -r` is not pointed at whatever it derived.
 */
function artifactsDirectoryFor(sessionFile: string): string | null {
  if (!sessionFile.endsWith('.jsonl')) return null
  const stem = sessionFile.slice(0, -'.jsonl'.length)
  // `<name>` beside `<name>.jsonl` is a real name, and it is the transcript's own: `.` and `..` are
  // directory references, not names, so a file called `..jsonl` or `...jsonl` derives the store or
  // its parent and hands `rm -r` every conversation in it (2026-11-03, security review of the fix).
  const name = path.basename(stem)
  if (name === '' || name === '.' || name === '..') return null
  if (name !== path.basename(sessionFile, '.jsonl')) return null
  if (path.dirname(stem) !== path.dirname(sessionFile)) return null
  return isTranscriptOrGone(sessionFile) ? stem : null
}

/**
 * Whether the path is a transcript on disk rather than a directory wearing the name.
 *
 * A path that is gone counts: its artifacts may outlive it, and deleting those is what the caller
 * asked for. A failure to look is the conservative answer of the two.
 */
function isTranscriptOrGone(sessionFile: string): boolean {
  try {
    return fs.lstatSync(sessionFile).isFile()
  } catch {
    return true
  }
}

/**
 * One removal, whose failure is logged rather than raised: a delete that cannot finish still reports.
 *
 * **A link is unlinked, never traversed** (`rules.md#boundaries-invariants-and-defensive-patterns`): the
 * shape comes from `lstat`, and a recursive delete is reserved for a confirmed real directory. A
 * symbolic link or junction — including one planted at a target's own name between the caller's
 * `resolveSessionFile` and this call — goes away as the link it is, and whatever it pointed at is
 * untouched.
 *
 * Existence is read with `lstat`, not `stat`: a dangling link — a conversation's artifacts directory
 * whose target was already removed — is an entry that still has to go, and `stat`/`existsSync` answer
 * "nothing there" for it. The answer is what the caller reports; it never gates the delete, because
 * `force` already keeps a path that vanished in between from failing.
 */
function removePath(target: string, failure: string, recursive: boolean): boolean {
  let shape: fs.Stats
  try {
    shape = fs.lstatSync(target)
  } catch {
    return false
  }
  try {
    // Recursive delete is reserved for a confirmed real directory; a link is unlinked as the link it
    // is, so what it points at is never the thing removed.
    if (recursive && shape.isDirectory()) fs.rmSync(target, { recursive: true, force: true })
    else fs.unlinkSync(target)
    return true
  } catch (error) {
    logError(failure, error)
    return false
  }
}

/**
 * Process-level LSP teardown (contract §4): `session.dispose()` does not reclaim private servers.
 *
 * This is the process ending, so it is the one place the whole client table is taken down: every
 * conversation is going away with it and nothing is left to serve.
 */
export async function shutdownLsp(sdk: SdkBundle, reason: string): Promise<void> {
  if (sdk.lspClients() === 0) return
  try {
    await sdk.shutdownLsp()
  } catch (error) {
    logError(`LSP shutdown after ${reason} failed`, error)
  }
}

/**
 * Releases the language servers of one workspace, after the last conversation in it went away.
 *
 * The engine registers one client per (server command, workspace, configuration identity) and every
 * conversation opened in that directory shares it, so a teardown may only stop the servers of the
 * workspace it emptied: a repository with two conversations open would otherwise see the surviving
 * one's servers restarted from scratch - a cold start and every diagnostic lost - because the
 * other conversation was closed. Whether the workspace really is empty is the caller's question
 * (its registry holds the live sessions); this does the release and nothing else.
 *
 * The teardown itself is the engine's own: `shutdownStaleClients(dir, [])` invalidates that
 * directory's clients and the initialization still in flight for it, then runs the shutdown/exit
 * handshake on each. Its failure is logged rather than raised, for the same reason the process-wide
 * one is: the conversation is already gone, and a language server that would not stop is a log
 * line, not a failed command.
 */
export async function releaseWorkspaceLsp(sdk: SdkBundle, cwd: string, reason: string): Promise<void> {
  try {
    await sdk.shutdownLspWorkspace(cwd)
  } catch (error) {
    logError(`LSP release for the workspace of a ${reason} failed`, error)
  }
}

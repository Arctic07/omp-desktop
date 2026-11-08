/**
 * The commands that end a conversation: close, delete, and the forced stop a stuck turn needs.
 *
 * A delete names a transcript instead of a session id because the conversations a user deletes are
 * rows of a list, and most of them were never opened in this process: the registry holds only what a
 * screen asked for, so addressing the file is what lets one command serve both a conversation that
 * is live here and one that has not been read since the app started. The path is resolved through
 * the same gate every other file-addressed command uses (`resolveSessionFile`), so what a delete can
 * touch is the host's own session directory and nothing else. The same frame also takes a routing id
 * for the plugin surface, which holds no paths (`deleteConversation`); that form is bounded by the
 * conversation index, not by a path.
 *
 * All of them are split out of the registry because they are the commands that end a conversation
 * rather than act on one, and because what they need from the registry is narrow enough to state as
 * a port: its live records, its one busy rule, and the engine. Everything else here - the teardown,
 * the file removal, the LSP release - is the same code path every other teardown uses.
 */

import type { HostPaths } from './env.ts'
import { logLine } from './log.ts'
import { ERROR_CODES, HostError } from './protocol/errors.ts'
import { conversationFileById } from './session-history.ts'
import type { DisposableSession } from './session-lifecycle.ts'
import {
  disposeSession,
  releaseWorkspaceLsp,
  removeSessionFiles,
  transcriptHoldsMessage,
} from './session-lifecycle.ts'
import type { SdkBundle } from './sdk.ts'
import { resolveSessionFile, sessionIdFor } from './store.ts'
import type { UiBridge } from './ui.ts'

/** The record these commands need: the teardown shape, plus the session's own dialog bridge. */
export interface FileSession extends DisposableSession {
  readonly ui: UiBridge
}

/** What the registry lends them: its live records, its busy rule, and the engine. */
export interface SessionFilesPort {
  /** The live record one routing id names, without touching it. */
  peek: (sessionId: string) => FileSession | undefined
  /** The same, removed from the registry as it is read - the caller is about to take it down. */
  take: (sessionId: string) => FileSession | undefined
  /** Whether that record still has work in flight (the registry's one busy fact). */
  isWorking: (live: FileSession) => boolean
  /**
   * Whether any session the registry still holds was opened in this workspace.
   *
   * Asked after this command took its record out, so it answers about the conversations left in
   * the directory - the ones whose shared language servers the teardown below must not stop.
   */
  usesWorkspace: (cwd: string) => boolean
  readonly paths: HostPaths
  readonly sdk: SdkBundle
}

/**
 * Closes one conversation; unknown ids answer `closed:false` rather than failing.
 *
 * `dropFile` is the caller's claim that the conversation holds nothing — the desktop makes it for the
 * draft a workspace opened for an empty composer — and the transcript and its artifacts go **only
 * when the claim holds**. The reading is taken from the file, after `takeDown` drained the engine's
 * tail into it (`session-lifecycle.ts::transcriptHoldsMessage`), so a transcript that holds a message
 * stays; the caller's own record can be wrong about that, and the file is the reader's history
 * (`state/session-rows.ts::dropsFileOnRelease`).
 *
 * The flag's meaning does not change with that guard, which is why `PROTOCOL_VERSION` does not step
 * (`rules.md#version-axes`): the desktop still asks for a draft to be handed back, a host that keeps
 * a written transcript answers the same `closed:true`, and an older host with a newer desktop simply
 * behaves as it always did. What changes is that the precondition this command always documented is
 * now checked instead of assumed.
 */
export async function closeConversation(
  port: SessionFilesPort,
  sessionId: string,
  dropFile: boolean,
): Promise<{ closed: boolean }> {
  const live = port.peek(sessionId)
  if (live === undefined) return { closed: false }
  // A session let go while it is still working is not dropped here. What it is running is the
  // user's own work - a turn, a background job that can still wake it, or children of a detached
  // batch - and disposing the session aborts that work mid-flight; it is dropped when all of it and
  // the queue behind it are over instead (the registry's deferred release). Dropping the file is
  // the exception: that caller is ending everything the session holds.
  if (!dropFile && (port.isWorking(live) || live.agent.queuedMessageCount > 0)) {
    return { closed: false }
  }
  const taken = port.take(sessionId)
  if (taken === undefined) return { closed: false }
  await takeDown(port, taken, 'session_close')
  if (dropFile && transcriptHoldsMessage(taken.sessionFile)) {
    logLine(`session ${taken.sessionId} transcript kept (session_close): the file holds messages`)
  } else if (dropFile) {
    removeSessionFiles(taken.sessionFile, taken.sessionId, 'session_close')
  }
  return { closed: true }
}

/**
 * Ends one conversation by taking its record down, whatever it is doing.
 *
 * `closeConversation` refuses a session that is still working, and that refusal is right for a
 * screen letting go: the work it would cut short is the user's own. This is the one caller that may
 * cut it short, and it exists for the case where the work cannot be ended any other way - a turn
 * that ignored its abort window (`session-stop.ts`). The teardown is the same one either way
 * (`takeDown`), so nothing else about a forced stop differs from a close: the transcript stays, and
 * the next open loads the conversation back.
 *
 * Answers whether the record was still there to take. A conversation already closed or evicted by
 * the time the caller asked is not a failure: what the caller wanted - this process no longer
 * holding it - is already true.
 */
export async function forceStopConversation(
  port: SessionFilesPort,
  sessionId: string,
  reason: string,
): Promise<boolean> {
  const taken = port.take(sessionId)
  if (taken === undefined) return false
  await takeDown(port, taken, reason)
  return true
}

/**
 * Deletes one conversation: its transcript, its artifacts directory, and the live session if the
 * host is the one holding it.
 *
 * A live session that is still working is refused (`session_busy`) instead of being cut down:
 * deleting its transcript under it would take the file out from under an engine that is still
 * writing to it, and what that work is producing is the user's own. The caller that asked for the
 * delete is the one that can stop it first - the desktop's stop is that step, and it is what its
 * confirmation says - so the refusal is a race guard, not a dead end.
 *
 * A transcript that is already gone answers `deleted: false` rather than failing: the caller asked
 * for it to not exist, and it does not.
 *
 * The conversation is named one of two ways (see {@link deleteTarget}): this desktop's own frames
 * carry the file a list row named, and a plugin call carries the routing id `session.read` published.
 * Both end in this one delete, so there is one writer of a conversation's files and one set of
 * refusals - `session_busy` for work in flight, `session_not_found` for an id the index does not
 * carry.
 */
export async function deleteConversation(
  port: SessionFilesPort,
  request: Record<string, unknown>,
): Promise<{ deleted: boolean }> {
  const file = deleteTarget(port.paths, request)
  const id = sessionIdFor(file)
  const live = port.peek(id)
  if (live !== undefined) {
    if (port.isWorking(live)) {
      throw new HostError(
        ERROR_CODES.session_busy,
        'The session is still working; stop it before deleting it.',
      )
    }
    const taken = port.take(id)
    if (taken !== undefined) await takeDown(port, taken, 'session_delete')
  }
  return { deleted: removeSessionFiles(file, id, 'session_delete') }
}

/**
 * The transcript one delete names: the caller's own file path, or a routing id the conversation
 * index lists.
 *
 * The path form is the desktop's - a user deletes a row of the list, and most rows were never opened
 * here - and it is resolved through `resolveSessionFile`, the gate every file-addressed command uses.
 * The id form is the plugin surface's: `session.read` publishes ids and never a path, so a plugin's
 * `session.delete` names one, and it is bounded by exactly the ids those reads could have returned
 * (`conversationFileById`). The two are the same set of conversations; what differs is only what the
 * caller happens to hold.
 *
 * The path wins when both are there, because a caller that sent both made a mistake this process
 * cannot see: the desktop's own frame never carries an id.
 */
function deleteTarget(paths: HostPaths, request: Record<string, unknown>): string {
  const sessionFile = request.sessionFile
  if (typeof sessionFile === 'string' && sessionFile !== '') {
    return resolveSessionFile(paths, sessionFile)
  }
  const sessionId = request.sessionId
  if (typeof sessionId === 'string' && sessionId !== '') {
    const file = conversationFileById(paths, sessionId)
    if (file === undefined) {
      throw new HostError(ERROR_CODES.session_not_found, `Unknown session ${sessionId}.`)
    }
    return file
  }
  // Neither address: resolved through the file rule so the refusal is the one this command has
  // always answered a request without a path with.
  return resolveSessionFile(paths, sessionFile)
}

/** One record out of the registry and off the process: engine disposed, dialogs cancelled, LSP released. */
async function takeDown(port: SessionFilesPort, live: FileSession, reason: string): Promise<void> {
  await disposeSession(live, reason)
  // The record left the registry (`take`) before this ran, so what is asked here is whether the
  // workspace still holds a conversation. Its language servers are shared between all of them, so
  // only the directory this teardown emptied is released (`session-lifecycle.ts`).
  if (!port.usesWorkspace(live.cwd)) await releaseWorkspaceLsp(port.sdk, live.cwd, reason)
}

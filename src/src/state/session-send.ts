/**
 * Writing into the conversation on screen: prompts, stops, the model and level, and dialogs.
 *
 * Every one of these is a command the reader's own controls issue, and each is addressed to the
 * conversation the screen is showing (`sessionStore.activeId`) rather than to one named by the
 * caller — the exception is the prompt itself, which a queued row delivers into the conversation it
 * was written in whether or not that is the one on screen.
 *
 * Two things every write here owes the reader: the control must not spring back while the round trip
 * is in flight (so the answer is patched onto the record's own snapshot), and a refusal must land
 * where the reader is looking (a notice beside the conversation, or a returned `ApiError` for a
 * caller that has a place of its own to put it).
 */

import type { ApiError } from '@/api/client'
import { hasCode, isApiError, toApiError } from '@/api/client'
import {
  sessionAbort,
  sessionPrompt,
  sessionSetModel,
  sessionSetThinking,
  sessionStopJob,
  sessionUiRespond,
} from '@/api/agent'
import type {
  ChatAttachmentRef,
  ChatMessage,
  SessionThinkingLevel,
  StreamingBehavior,
  UiResponse,
} from '@/api/session-types'
import { clearReclaimNotices, LOCAL_MESSAGE_PREFIX, pushNotice } from '@/state/transcript'
import { markSessionSeenNow, noteSessionWritten, refreshSessionRow } from '@/state/session-lists'
import { asIdle } from '@/state/idle-record'
import {
  noteFailure,
  patchRuntime,
  sessionStore,
  setRecord,
} from '@/state/session-record'
import { isStreaming } from '@/state/work-readings'
import {
  deliverQueuedPrompts,
  interruptQueuedPrompt as interruptQueuedPromptNow,
} from '@/state/prompt-queue-runner'
import { restoreWithdrawnPrompts } from '@/state/restored-prompts'
import { noteVisit } from '@/state/session-visits'

/** The prefix a row written here carries until the engine claims it with its own id. */
let localMessageSeq = 0

/**
 * The conversation, opened again after the host dropped it.
 *
 * Supplied by `state/session-rejoin.ts`, which owns the reopen (`reopenForWrite`) and the record it
 * lands in. Calling back into the store from here would close the import cycle it opens by
 * re-exporting this module's writes. Answers whether the conversation is open again, which is
 * exactly what the one retry in {@link sendPromptTo} is worth.
 */
type SessionReopener = (sessionId: string) => Promise<boolean>

let reopenSession: SessionReopener | null = null

/** Bind the reopen a refused prompt asks for (see {@link sendPromptTo}). */
export function provideSessionReopener(reopener: SessionReopener): void {
  reopenSession = reopener
}

/**
 * One `session_prompt`, with the single recovery a refusal can need.
 *
 * The host drops a conversation that sat past its own idle window (`host/src/evict.ts`,
 * `IDLE_EVICT_MS`), and an eviction publishes no frame: the record here keeps its listener, so the
 * conversation on screen is the one whose next message is refused with `session_not_found`, under
 * the reader's own row — "Unknown session <id>", a line about a session, for a conversation they
 * are looking at. The file it is stored in is still on disk (an eviction keeps transcripts, and the
 * host derives the routing id from that file), so the conversation is opened again and the prompt
 * goes out once more — one retry, not a loop: a second refusal is a transcript that cannot be
 * opened, which the reader has to hear.
 */
async function writePrompt(
  sessionId: string,
  text: string,
  attachments: ChatAttachmentRef[],
  behavior: StreamingBehavior | null,
): Promise<void> {
  try {
    await sessionPrompt(sessionId, text, attachments, behavior)
  } catch (error) {
    if (!hasCode(error, 'session_not_found') || reopenSession === null) throw error
    if (await reopenSession(sessionId)) {
      await sessionPrompt(sessionId, text, attachments, behavior)
      return
    }
    // The reopen reported why it could not be made (a file nothing can name, a host that refused
    // it); what is left to say is that the reader's words did not go out.
    throw {
      code: 'session_not_found',
      message: 'The conversation could not be opened again, so this message was not sent.',
    } satisfies ApiError
  }
}

/**
 * Send one prompt into a named conversation.
 *
 * The user's own row is written here rather than waited for: it is the one thing this side already
 * knows in full, and waiting for the engine to echo it would leave the composer looking as though
 * nothing had happened. The row carries a local id until `message_started` claims it, which is what
 * keeps the echo from becoming a second copy.
 *
 * Named rather than read off the screen, because a message can also be delivered into a conversation
 * nobody is looking at: a queued one goes out at its own turn's end, which happens whether or not
 * that conversation is the one on screen.
 */
async function sendPromptTo(
  sessionId: string,
  text: string,
  attachments: ChatAttachmentRef[],
  behavior: StreamingBehavior | null,
): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed && attachments.length === 0) return
  noteVisit(sessionId)
  localMessageSeq += 1
  const row: ChatMessage = {
    kind: 'user',
    id: `${LOCAL_MESSAGE_PREFIX}${localMessageSeq}`,
    at: Date.now(),
    text: trimmed,
    attachments,
  }
  setRecord(sessionId, (record) => ({
    ...record,
    messages: [...record.messages, row],
    // The reclaim notice described the turn this ask replaces; a reply is the answer to it now.
    notices: clearReclaimNotices(record.notices),
  }))
  // A new ask means the previous ending has been read: sending is an interaction with the row, and
  // the green completion dot should not outlive it into the next turn.
  markSessionSeenNow(sessionId)
  try {
    await writePrompt(sessionId, trimmed, attachments, behavior)
  } catch (error) {
    // The row stays: the prompt was written by the user and hiding it would misreport what they
    // did. The refusal is reported beside it.
    setRecord(sessionId, (record) => ({
      ...record,
      notices: pushNotice(
        record.notices,
        'error',
        isApiError(error) ? error.code : null,
        toApiError(error).message,
      ),
    }))
    return
  }
  // Sending is what starts a conversation: the engine writes its file with the first prompt, but
  // the acknowledgement comes back before that write — so the row is marked from the message this
  // side already holds rather than waited for (see `state/session-lists.ts::noteSessionWritten`).
  const record = sessionStore.get().records[sessionId]
  if (record !== undefined) {
    await noteSessionWritten(record.workspaceId, sessionId, row.at)
  }
}

/** Send one prompt into the conversation on screen. */
export async function sendPrompt(
  text: string,
  attachments: ChatAttachmentRef[] = [],
  behavior: StreamingBehavior | null = null,
): Promise<void> {
  const sessionId = sessionStore.get().activeId
  if (sessionId !== null) await sendPromptTo(sessionId, text, attachments, behavior)
}

/** Hand a conversation's queue head over, now that its turn has ended. */
export function promoteQueuedPrompt(sessionId: string): void {
  void deliverQueuedPrompts(sessionId, sendPromptTo)
}

/**
 * End the running turn, then send the pressed queued row as the next one — the queue's own control.
 *
 * Only the head row is offered it, and only while a turn runs: the ending is what makes the row a
 * send instead of a steer, so a conversation with nothing running has nothing to interrupt, and the
 * rows behind the head have not had their turn. A failure leaves the row in the queue
 * (`state/prompt-queue-runner.ts::interruptQueuedPrompt`) and lands as a notice.
 */
export function interruptQueuedPrompt(sessionId: string, id: number): Promise<boolean> {
  return interruptQueuedPromptNow(
    sessionId,
    id,
    async (target) => {
      await endTurn(target, 'interrupt')
    },
    sendPromptTo,
  )
}

/**
 * What a stop that ended nothing says.
 *
 * The store has no language of its own — every other notice carries the desktop's or the engine's
 * words — so this is the fallback text, and the composer draws the reader's language for the code
 * (`stop_found_nothing`) instead of it.
 */
const STOP_FOUND_NOTHING = 'There was nothing left to stop.'

/**
 * The code a stop that did not end everything is reported under.
 *
 * The composer draws the reader's language for it and the forced-stop button beside it
 * (`home/ConversationComposer.tsx`): a stop that leaves a turn behind is the one case the reader has
 * an action for.
 */
export const STOP_LEFT_WORK = 'stop_left_work'

/**
 * Stop what the conversation on screen is doing.
 *
 * **One stop per conversation at a time.** The host answers a stop only once the engine is idle,
 * which can be most of the abort window; a control that keeps taking presses in that stretch turns
 * one gesture into a queue of `session_abort` frames, each answered separately — which is what a
 * reader reports as "nothing happened, so I pressed it ten times" and then, when the answers land,
 * as a burst of stop notices (`report` below). The second press while one is in flight is therefore
 * dropped here, and the record says so (`SessionRecord.stopPending`) so the control can draw the
 * wait instead of inviting another press.
 *
 * **The stop takes the reader's unsent queue with it.** The host withdraws the engine's steering and
 * follow-up messages before aborting — a message left there is a turn the engine starts as soon as
 * the abort unwinds, which is the "stop did nothing" report at its root — and answers with their
 * words (`AbortOutcome.restored`). They go back to the composer as the reader's own draft, and the
 * local row that echoed them leaves the transcript: a prompt the model never received must not read
 * as one it did.
 *
 * The stop's own answer is what says whether anything was stopped: `aborted:false` means there was
 * nothing for it to end, and the reader who pressed it deserves that sentence rather than a button
 * that appeared to work. The turn's own end is drawn by its row (`turn_finished` → the row's stop
 * note); this function reports the two cases the row cannot: a stop that found nothing, and a stop
 * that could not end everything (`STOP_LEFT_WORK`).
 *
 * **A stop that found nothing also lowers the readings that drew its button.** The host answers
 * `aborted:false` from the facts the eviction and release gates read, so an empty answer is the
 * authority saying this conversation has nothing in flight - which makes this side's "still
 * streaming" stale by definition (`state/idle-record.ts`). Leaving it standing is what the reader
 * reported on 2026-10-26: an answer finished at 01:30, the screen drew 「工作中… 31m」 over it, and
 * four presses of the stop each answered that there was nothing to stop. The notice still says so -
 * the press did end nothing - but the row stops claiming to run.
 *
 * The queue's own press asks for the same ending, with a prompt going out behind it
 * (`interruptQueuedPrompt`): one turn per conversation is ended through `endTurn`, so a stop and an
 * interrupt cannot both be on their way — the second is dropped by `stopPending` alone.
 */
export async function abortTurn(): Promise<void> {
  const sessionId = sessionStore.get().activeId
  if (!sessionId) return
  await endTurn(sessionId, 'stop')
}

/**
 * Where the ending came from: the stop control, or a press on the queue's head row.
 *
 * The difference is only what the reader is told when nothing was there to end. A stop press that
 * found nothing is news ("stop_found_nothing" — the button that appeared to work did not); the
 * queue's press found a turn already over, and its row goes out as the next turn either way, so the
 * same sentence would be noise on top of the send the reader asked for.
 */
type Ending = 'stop' | 'interrupt'

/**
 * End one conversation's running turn, with the record bookkeeping both callers need.
 *
 * A stop that fails reports what the reader can act on and resolves; an interrupt that fails hands
 * the error back, because the row it was meant to release has to return to the queue instead
 * (`state/prompt-queue-runner.ts::interruptQueuedPrompt`).
 */
async function endTurn(sessionId: string, ending: Ending): Promise<void> {
  if (sessionStore.get().records[sessionId]?.stopPending === true) return
  // Whether a turn was under the press when it was made. A stop also ends a compaction, and that
  // has no turn of its own: without this fact the answer below would mark the *previous* turn as
  // stopped, drawing a note on an answer the reader never interrupted.
  const held = sessionStore.get().records[sessionId]
  const stopHadTurn = held !== undefined && isStreaming(held)
  setRecord(sessionId, (record) => (record.stopPending ? record : { ...record, stopPending: true }))
  try {
    const outcome = await sessionAbort(sessionId)
    if (!outcome.aborted) {
      setRecord(sessionId, (record) => {
        const idle = asIdle(record)
        if (ending === 'interrupt') return idle
        return {
          ...idle,
          notices: pushNotice(idle.notices, 'info', 'stop_found_nothing', STOP_FOUND_NOTHING),
        }
      })
      // A turn whose ending frame was lost never reached `turn_finished`, so the row's own refresh
      // (which that frame starts) never ran either: the conversation's status is written again from
      // the transcript, which is where its real ending still is.
      const settled = sessionStore.get().records[sessionId]
      if (settled !== undefined) void refreshSessionRow(settled.workspaceId, sessionId)
      return
    }
    // The host withdrew the reader's own queued input before it aborted (a steer waiting behind the
    // turn is a turn the engine starts the moment the abort unwinds). The words are theirs and were
    // never delivered: the local row that echoed them goes, and the prompt returns to the composer.
    if (outcome.restored.length > 0) {
      restoreWithdrawnPrompts(sessionId, outcome.restored)
      setRecord(sessionId, (record) => ({
        ...record,
        notices: pushNotice(
          record.notices,
          'info',
          'stop_restored_prompts',
          `${String(outcome.restored.length)} unsent message(s) were returned to the composer.`,
        ),
      }))
    }
    // The host took the stop, so the turn it ends is the reader's own act — including a turn that
    // was waiting out a retry when the press landed, whose engine-side ending carries the failure
    // it was retrying rather than an abort.
    //
    // The answer can arrive after the turn it ended: the host waits for the engine to go idle before
    // it answers. A flag set then would belong to the *next* turn, so a turn already over has its
    // ending patched instead — the one it was stopped by, which is the last one on record.
    setRecord(sessionId, (record) => {
      if (record.turnId !== null) return { ...record, stopRequested: true }
      if (!stopHadTurn) return record
      const lastTurn = record.lastTurn
      if (lastTurn === null || lastTurn.stopped) return record
      return { ...record, lastTurn: { ...lastTurn, stopped: true } }
    })
    // The ending was folded before the host answered, so the row was refreshed without the stop in
    // hand and may already carry a mark for it. The stop was the reader's own act; the row is told
    // so here, whether or not the screen still holds this conversation (2026-10-21).
    const settled = sessionStore.get().records[sessionId]
    if (settled !== undefined && settled.turnId === null && settled.lastTurn?.stopped === true) {
      void refreshSessionRow(settled.workspaceId, sessionId)
    }
    // A stop that ended the turn but not everything under it (`remaining`) is a partial answer, and
    // the reader is the one who has to decide whether the rest is worth taking down. A queued
    // message never reaches this count: the host withdraws the reader's own queue before aborting
    // (`outcome.restored`), so what is left here is work no button of theirs can dismiss.
    const left = outcome.remaining.filter((facet) => facet !== 'queued')
    if (left.length > 0) {
      setRecord(sessionId, (record) => ({
        ...record,
        notices: pushNotice(
          record.notices,
          'warning',
          STOP_LEFT_WORK,
          `Stop left ${String(left.length)} item(s) running: ${left.join(', ')}.`,
        ),
      }))
    }
  } catch (error) {
    const failure = toApiError(error)
    // A conversation the host no longer holds (its idle eviction, a host restart) has nothing for a
    // stop to end, and reporting that as the reader's failure blames them for a stale record. The
    // press is still a reading of the truth: the screen stops claiming work it cannot reach, and
    // the next visit rejoins the conversation from its file. An interrupt is the exception: its row
    // has not been sent either, so it goes back to the queue and the refusal is said out loud.
    if (failure.code === 'session_not_found' && ending === 'stop') {
      setRecord(sessionId, (record) => {
        const idle = asIdle(record)
        return {
          ...idle,
          notices: pushNotice(idle.notices, 'info', 'stop_found_nothing', STOP_FOUND_NOTHING),
        }
      })
      const settled = sessionStore.get().records[sessionId]
      if (settled !== undefined) void refreshSessionRow(settled.workspaceId, sessionId)
      return
    }
    noteFailure(sessionId, failure)
    if (ending === 'interrupt') throw error
  } finally {
    // Whatever the answer was, the wait is over: a stop that ended nothing must not leave the
    // control drawn as if one were still on its way.
    setRecord(sessionId, (record) =>
      record.stopPending ? { ...record, stopPending: false } : record,
    )
  }
}

/** Stop one piece of work the conversation started that outlives its turn. */
export async function stopJob(jobId: string): Promise<void> {
  const sessionId = sessionStore.get().activeId
  if (!sessionId) return
  try {
    await sessionStopJob(sessionId, jobId)
  } catch (error) {
    // The row stays until the engine's next snapshot says the job is gone; a refusal is said out
    // loud beside the conversation rather than swallowed by the button that asked for it.
    noteFailure(sessionId, toApiError(error))
  }
}

/**
 * Point the open conversation at another model.
 *
 * The engine owns which model a conversation runs on, so this is the write that tells it; the row
 * takes the pick straight away because the engine's own state frame follows the answer, and a
 * control that sprang back to the previous model for the length of a round trip would read as a
 * refusal. A failure is returned rather than thrown: the caller is a control, and where it belongs
 * on screen is the caller's to say.
 */
export async function setSessionModel(
  sessionId: string,
  provider: string,
  modelId: string,
): Promise<ApiError | null> {
  try {
    await sessionSetModel(sessionId, provider, modelId)
  } catch (error) {
    return toApiError(error)
  }
  patchRuntime(sessionId, { modelProvider: provider, modelId })
  return null
}

/**
 * Set the level the open conversation thinks at.
 *
 * Only the conversation is written: its level is the engine's record of that session, not this
 * application's default. A new conversation starts on the engine's configured default (the model
 * settings' `default` role), so a level chosen here must not travel to the next one.
 *
 * With no conversation open there is no session to write; the composer edits the `default` role
 * instead, which is the engine's own setting for the next conversation (`ConversationComposer`).
 */
export async function setSessionThinking(
  sessionId: string,
  level: SessionThinkingLevel,
): Promise<ApiError | null> {
  try {
    await sessionSetThinking(sessionId, level)
  } catch (error) {
    return toApiError(error)
  }
  patchRuntime(sessionId, { thinkingLevel: level })
  return null
}

export async function answerDialog(requestId: string, response: UiResponse): Promise<void> {
  const sessionId = sessionStore.get().activeId
  if (!sessionId) return
  // The dialog is dropped here first: the desktop also emits `ui_cancelled`, but waiting for it
  // would leave a card on screen after the user answered it.
  setRecord(sessionId, (record) => ({
    ...record,
    dialogs: record.dialogs.filter((dialog) => dialog.id !== requestId),
  }))
  await sessionUiRespond(sessionId, requestId, response)
}

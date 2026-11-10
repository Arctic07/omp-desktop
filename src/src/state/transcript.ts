/**
 * One conversation's rows, folded from the two ways they arrive.
 *
 * A transcript is read twice over: once as the rows already on disk (`session_history`) and once as
 * a stream (`omp:session:<id>`, what the turn is doing now). This module is the fold between them —
 * a pure function of the rows on hand and one frame, so the same conversation can be held for as
 * long as the reader keeps coming back to it, and so the fold can be exercised without a desktop.
 *
 * Everything here is keyed by the engine's own id: an assistant turn by `messageId`, a tool call by
 * `toolCallId`. A row that arrives both ways therefore updates in place rather than appearing
 * twice — which is the whole reason the fold is a function of the *current* rows rather than an
 * append.
 */

import type {
  ChatMessage,
  SessionEvent,
  SessionRuntimeState,
  SubagentRow,
  TurnOutcome,
  UiRequest,
} from '@/api/session-types'
// Relative with its extension: this module is read by the test runner as well as by the bundler,
// and the runner has no alias to resolve (`home/composer-commands.ts` says the same).
import {
  ENGINE_COMPACTION_REPORT_CODE,
  ENGINE_RECAP_CODE,
  type TranscriptNoticeCode,
} from '../api/session-types.ts'

/** The transcript half of a conversation: what a frame can change. */
export interface TranscriptState {
  messages: ChatMessage[]
  subagents: Record<string, SubagentRow>
  /** The side question (`/btw`), while one is running or its answer is still worth reading. */
  btw: BtwView | null
  /** The turn in flight, as the desktop framed it; null when nothing is running. */
  turnId: string | null
  runtime: SessionRuntimeState | null
  /** Dialogs the engine is waiting on, oldest first. */
  dialogs: UiRequest[]
  /**
   * How the turn that just ended ended, and why.
   *
   * The turn's own outcome, kept after the turn is over: `turn_finished` is the one frame that
   * states it, and the row it belongs to has no way to ask once it is gone. `null` until a turn
   * ends in this process — a conversation read from disk carries its outcomes on the rows
   * themselves (`stopReason`, `error`).
   */
  lastTurn: TurnEnding | null
}

/** One side question's state, as the engine's controller reported it. */
export interface BtwView {
  question: string
  answer: string
  status: string
  error?: string
}

/** How a turn ended, as `turn_finished` reported it. */
export interface TurnEnding {
  turnId: string
  outcome: TurnOutcome
  error: string | null
  at: number
  /**
   * Whether the host had confirmed a stop for this turn when it ended.
   *
   * Carried on the ending rather than read from the record's live flag: the flag is cleared by the
   * same frame that writes the ending, and a screen that read the two separately would lose the
   * fact on exactly the turn it describes.
   */
  stopped: boolean
}

export const EMPTY_TRANSCRIPT: TranscriptState = {
  messages: [],
  subagents: {},
  btw: null,
  turnId: null,
  runtime: null,
  dialogs: [],
  lastTurn: null,
}

/** One notice the conversation put on screen; `id` is assigned here, the frame carries none. */
export interface SessionNotice {
  id: number
  level: 'info' | 'warning' | 'error'
  code: string | null
  message: string
  at: number
}

/** Notices are a running commentary, not a record: the last few are all anyone reads. */
const NOTICE_LIMIT = 50

/**
 * The notices drawn where the conversation is rather than in the strip above the field.
 *
 * The codes and their union live in `api/session-types.ts`; this table only says which of them
 * become rows here. The guard is the fold's gate, so a notice without one of these codes stays out
 * of the transcript.
 */
const TRANSCRIPT_NOTICE_CODES: Readonly<Record<TranscriptNoticeCode, true>> = {
  [ENGINE_RECAP_CODE]: true,
  [ENGINE_COMPACTION_REPORT_CODE]: true,
}

/** Whether one notice's code makes it a row of the conversation (a type guard for the row's code). */
function isTranscriptNoticeCode(code: string | undefined): code is TranscriptNoticeCode {
  return typeof code === 'string' && Object.hasOwn(TRANSCRIPT_NOTICE_CODES, code)
}

let noticeSeq = 0

/** The prefix a row written here carries until the engine claims it with its own id. */
export const LOCAL_MESSAGE_PREFIX = 'local:'

/**
 * Whether the conversation can be cut at one of the reader's own messages.
 *
 * A rewind names the engine's own message and lets the host cut the transcript in front of it, so the
 * question is whether the engine holds this message at all. A `/` command the host runs itself
 * (`/vibe`, `/compact`, `/handoff`) writes nothing into the session - it is not a turn, there is no
 * message and no entry id - and its row keeps the id written above forever. Offering to rewind it
 * asks the host to cut at a message the conversation never wrote, which it answers with "No user
 * message of this conversation was written at that time."; on a row the engine wrote, the timestamp
 * is a real address even before a transcript read names its entry.
 */
export function canRewindMessage(message: ChatMessage): boolean {
  if (message.kind !== 'user') return false
  if (message.id.startsWith(LOCAL_MESSAGE_PREFIX)) return false
  return message.entryId !== undefined || message.at > 0
}

/**
 * Where a rewind cuts the rows on screen: the index of the message it names, or null when the rows
 * this process holds no longer carry it.
 *
 * The engine ends the branch *before* the message, so the rows that stay are the prefix. A rewind
 * paints that prefix in the same write that drops the cut rows, instead of emptying the transcript
 * for the read that follows: an empty record is the hero — the screen of a conversation nothing was
 * ever said in — and a reader watching the confirmation they had just accepted saw the
 * new-conversation page flash under it (2026-11-02, user report).
 *
 * The row is addressed the way the host addresses it (`canRewindMessage`): the entry id when a read
 * named one, the engine's timestamp otherwise.
 */
export function rewindCutIndex(
  messages: readonly ChatMessage[],
  target: { entryId?: string; at?: number },
): number | null {
  // The entry id is the address itself, so it wins when a read named one; a live row has none yet
  // and falls back to the stamp the host resolves. The two are asked in that order rather than in
  // one predicate, so a stamp that another user row happens to share cannot answer first.
  let index = -1
  if (target.entryId !== undefined) {
    index = messages.findIndex(
      (message) => message.kind === 'user' && message.entryId === target.entryId,
    )
  }
  if (index === -1 && target.at !== undefined && target.at > 0) {
    index = messages.findIndex(
      (message) => message.kind === 'user' && message.at === target.at,
    )
  }
  return index === -1 ? null : index
}

function replaceAt<T>(items: T[], index: number, value: T): T[] {
  const next = items.slice()
  next[index] = value
  return next
}

/**
 * Move every row holding one id aside, so the frame about to write can own it.
 *
 * A row is addressed by the id the engine reported, and the fold trusts that name: `message_started`
 * draws the row it announces, `delta` appends to the row it names, `message_finished` closes that
 * same row. A record also keeps its rows longer than the session that announced them — a
 * conversation the reader left merges its transcript back into the rows still in memory, and the
 * window outlives a host restart — so a name can already be taken by a row from an earlier session.
 * Writing into it is not a repair but a loss: the words land under another prompt, read far above,
 * and where that row was of another kind — the reader's own prompt, most often — they land nowhere
 * at all, because `applyDelta` writes into an assistant row and answers the rest unchanged. That is
 * the reader's report of 2026-10-27: an answer whose words only appeared after the app was reopened.
 *
 * The projector no longer mints a name twice (`services/runtime/events.rs::EventState::mint`), and
 * this is the fold's own half of that guarantee: the words are the one thing it must never lose,
 * whatever a name turns out to be holding.
 *
 * The older row keeps its words under a name of its own; a later merge replaces it with the
 * transcript's copy anyway (`writtenKey` pairs by moment and words, not by id).
 */
function releaseId(messages: ChatMessage[], id: string): ChatMessage[] {
  if (!messages.some((message) => message.id === id)) return messages
  const taken = new Set(messages.map((message) => message.id))
  return messages.map((message) => {
    if (message.id !== id) return message
    let suffix = 1
    let candidate = `${id}#${suffix}`
    while (taken.has(candidate)) {
      suffix += 1
      candidate = `${id}#${suffix}`
    }
    taken.add(candidate)
    return { ...message, id: candidate }
  })
}

/**
 * Hand a locally written user row over to the engine's own id.
 *
 * The row this frame is about is the prompt sent just before it, and its own moment is what says so:
 * a `/` command the host runs itself ( `/compact`, `/handoff`) writes no engine message at all, so
 * its echo waits ahead of every real prompt forever and "the first row still waiting" would be
 * claimed in the real prompt's place — the command would take the answer's id and the prompt would
 * stay a pending row nothing ever claims (2026-10-22). The frame's own timestamp picks the nearest
 * echo instead, and with no timestamp the newest, which is the one just written.
 */
function confirmUserMessage(
  messages: ChatMessage[],
  messageId: string,
  at: number | null,
): ChatMessage[] {
  let index = -1
  let nearest = Number.POSITIVE_INFINITY
  messages.forEach((message, candidate) => {
    if (message.kind !== 'user' || !message.id.startsWith(LOCAL_MESSAGE_PREFIX)) return
    // No timestamp on the frame: larger index means closer, i.e. the row written last.
    const distance = at === null ? -candidate : Math.abs(message.at - at)
    if (distance < nearest) {
      nearest = distance
      index = candidate
    }
  })
  if (index === -1) return messages
  const row = messages[index]
  if (row.kind !== 'user') return messages
  // The engine's id is this row's now, and a row it still names is an older one: two rows under one
  // name make every frame for it land in whichever came first (`releaseId`).
  return replaceAt(releaseId(messages, messageId), index, {
    ...row,
    id: messageId,
    at: at ?? row.at,
  })
}

function applyDelta(
  messages: ChatMessage[],
  event: Extract<SessionEvent, { type: 'delta' }>,
): ChatMessage[] {
  const text = event.textDelta ?? ''
  const thinking = event.thinkingDelta ?? ''
  const index = messages.findIndex((message) => message.id === event.messageId)
  const row = index === -1 ? undefined : messages[index]
  if (row !== undefined && row.kind === 'assistant') {
    return replaceAt(messages, index, {
      ...row,
      text: row.text + text,
      thinking: row.thinking + thinking,
    })
  }
  // A message whose start frame predates the subscription still streams into a row of its own
  // (`message_finished` fills in the rest when it arrives) — and so does one whose id a row of
  // another kind is holding, which is a name this side may not write the answer into (`releaseId`).
  return [
    ...(row === undefined ? messages : releaseId(messages, event.messageId)),
    {
      kind: 'assistant',
      id: event.messageId,
      at: Date.now(),
      text,
      thinking,
      error: null,
      startedAt: null,
      endedAt: null,
      usage: null,
      modelProvider: null,
      modelId: null,
    } satisfies ChatMessage,
  ]
}

function applyToolStarted(
  messages: ChatMessage[],
  event: Extract<SessionEvent, { type: 'tool_started' }>,
): ChatMessage[] {
  const index = messages.findIndex(
    (message) => message.kind === 'tool' && message.toolCallId === event.toolCallId,
  )
  const row = {
    kind: 'tool',
    id: event.toolCallId,
    at: event.startedAt,
    toolCallId: event.toolCallId,
    name: event.name,
    state: 'running',
    argsText: event.argsText,
    resultText: '',
    startedAt: event.startedAt,
    endedAt: null,
    intent: event.intent,
  } satisfies ChatMessage
  if (index === -1) return [...messages, row]
  return replaceAt(messages, index, row)
}

function applyToolProgress(
  messages: ChatMessage[],
  event:
    | Extract<SessionEvent, { type: 'tool_updated' }>
    | Extract<SessionEvent, { type: 'tool_finished' }>,
): ChatMessage[] {
  const index = messages.findIndex(
    (message) => message.kind === 'tool' && message.toolCallId === event.toolCallId,
  )
  if (index === -1) return messages
  const row = messages[index]
  if (row.kind !== 'tool') return messages
  const finished = event.type === 'tool_finished'
  return replaceAt(messages, index, {
    ...row,
    state: finished ? event.state : row.state,
    resultText: event.resultText,
    details: event.details ?? row.details,
    images: event.images ?? row.images,
    endedAt: finished ? event.endedAt : row.endedAt,
  })
}

/**
 * What the fold needs to know that is not in the frame.
 *
 * One fact today: whether the host had confirmed a stop for the turn being closed. It lives on the
 * record (`SessionRecord.stopRequested`) rather than in the transcript, because it is the reader's
 * ask rather than the engine's account — but the ending it decides is written here, in the same
 * write the frame arrives on.
 */
export interface FoldOptions {
  stopRequested?: boolean
}

/**
 * Fold one frame into a transcript.
 *
 * The frame is applied exactly once, and to the rows it is about — which is what makes the fold
 * safe to run on every frame however many conversations are being held: a frame that arrives twice
 * would append its text twice, so the one place frames are delivered (the store's per-session
 * listener) is the one place that has to be sure it is the only listener there is.
 */
export function foldTranscript(
  state: TranscriptState,
  event: SessionEvent,
  options: FoldOptions = {},
): TranscriptState {
  switch (event.type) {
    case 'state':
      // A snapshot is a reading of the host's own clock, not a frame in this one's order: the
      // desktop asks for a fresh one on the edges it cares about and publishes whatever comes back
      // (`replay::refresh_state`, one round trip each), so a snapshot built while the turn was
      // running can be emitted after the ending that disproves it. `lastEventAt` is when the host
      // last heard from the engine, `lastTurn.at` is when it emitted the ending: a snapshot whose
      // own clock is not past the ending cannot know what came after it, so its "streaming" claim
      // is the one field this fold refuses. Leaving it in is what the reader reported on
      // 2026-10-26 - an answer finished at 01:30, 「工作中… 31m 29.7s」 drawn over it, and four
      // presses of a stop that answered there was nothing to end (`session_abort` had the truth the
      // whole time). A genuinely new turn stamps `lastEventAt` after that ending, so its snapshots
      // are applied as they come - and its own `turn_started` opens the turn either way.
      if (
        state.lastTurn !== null &&
        event.state.isStreaming &&
        event.state.lastEventAt <= state.lastTurn.at
      ) {
        return { ...state, runtime: { ...event.state, isStreaming: false } }
      }
      return { ...state, runtime: event.state }
    case 'btw': {
      if (event.kind === 'cleared') return { ...state, btw: null }
      if (event.kind === 'record') {
        return {
          ...state,
          btw: {
            question: event.question,
            answer: event.answer,
            status: event.status,
            ...(event.error === undefined ? {} : { error: event.error }),
          },
        }
      }
      const current = state.btw
      if (current === null) return state
      return { ...state, btw: { ...current, answer: current.answer + event.delta } }
    }
    case 'turn_started':
      return { ...state, turnId: event.turnId }
    case 'turn_finished':
      return {
        ...state,
        turnId: null,
        // The turn is over, and the runtime snapshot's own streaming flag has to agree. The host
        // republishes that snapshot on the edges *inside* a turn (a model change, a stop, a child
        // settling, a queued prompt being accepted), and its only republish after the ending comes
        // from the `session_prompt` command's own runner — which a turn the engine starts itself
        // (a queued follow-up, a goal continuation, a background result) does not have. Such a
        // turn then ends with the last snapshot still saying "streaming", and `isStreaming` keeps
        // answering true with no turn in flight: the rail's newest card stays on "Working…" after
        // the agent answered, the turn's footer never appears, and the send control stays a stop
        // (2026-10-22, user report). A conversation attached mid-turn still reads as streaming
        // until its own ending arrives, which is what the snapshot is for.
        runtime:
          state.runtime === null ? null : { ...state.runtime, isStreaming: false },
        lastTurn: {
          turnId: event.turnId,
          outcome: event.outcome,
          error: event.error,
          at: event.at,
          // Carried onto the ending, because the record's live flag is cleared by this same frame
          // (`foldRecord`): a screen that read the two separately would lose the fact on exactly
          // the turn it describes. `stopRequested` is supplied by the caller, which owns it.
          stopped: options.stopRequested === true,
        },
      }
    case 'message_started': {
      if (event.role === 'user') {
        // The user's own row is written when the prompt is sent; this frame is the engine claiming
        // it, and the row takes the engine's id so the two can never both appear.
        return { ...state, messages: confirmUserMessage(state.messages, event.messageId, event.at) }
      }
      const occupant = state.messages.find((message) => message.id === event.messageId)
      if (occupant?.kind === 'assistant') return state
      // A name held by a row of another kind is an older row's, and this message is the one the
      // frame is about: the old row moves aside rather than the new one going unannounced
      // (`releaseId` — an unannounced row is one every following delta is dropped by).
      const messages =
        occupant === undefined ? state.messages : releaseId(state.messages, event.messageId)
      return {
        ...state,
        messages: [
          ...messages,
          {
            kind: 'assistant',
            id: event.messageId,
            at: event.at ?? Date.now(),
            text: '',
            thinking: '',
            error: null,
            startedAt: event.at,
            endedAt: null,
            usage: null,
            modelProvider: null,
            modelId: null,
          },
        ],
      }
    }
    case 'delta':
      return { ...state, messages: applyDelta(state.messages, event) }
    case 'message_finished': {
      // The closing frame is the authority on the row's words, whatever the delta stream carried:
      // the engine's own record is the only complete copy, and this is what keeps an answer whole
      // when an increment was shed, when this listener was not attached for part of the stream, or
      // when the engine rewrote the message after streaming it. `??` keeps an older host (which
      // sends no `text`) on exactly the delta behaviour it had.
      const text = event.text ?? null
      const thinking = event.thinking ?? null
      const index = state.messages.findIndex((message) => message.id === event.messageId)
      if (index === -1) {
        // A listener attached after the message started can miss its opening frame and every delta
        // (an answer that is only a picture has no delta at all). The closing frame is still a
        // complete statement of the row: draw it rather than dropping the answer.
        return {
          ...state,
          messages: [
            ...state.messages,
            {
              kind: 'assistant',
              id: event.messageId,
              at: event.startedAt ?? event.endedAt,
              text: text ?? '',
              thinking: thinking ?? '',
              error: event.error ?? null,
              stopReason: event.stopReason,
              startedAt: event.startedAt,
              endedAt: event.endedAt,
              usage: event.usage,
              modelProvider: event.modelProvider,
              modelId: event.modelId,
              images: event.images,
            },
          ],
        }
      }
      const row = state.messages[index]
      if (row.kind !== 'assistant') {
        // A name a row of another kind is holding is an older row's, and this answer is the one the
        // frame is about: the old row moves aside so the answer is drawn rather than dropped
        // (`releaseId`, the same rule `message_started` and `applyDelta` follow).
        return {
          ...state,
          messages: [
            ...releaseId(state.messages, event.messageId),
            {
              kind: 'assistant',
              id: event.messageId,
              at: event.startedAt ?? event.endedAt,
              text: text ?? '',
              thinking: thinking ?? '',
              error: event.error ?? null,
              stopReason: event.stopReason,
              startedAt: event.startedAt,
              endedAt: event.endedAt,
              usage: event.usage,
              modelProvider: event.modelProvider,
              modelId: event.modelId,
              images: event.images,
            },
          ],
        }
      }
      return {
        ...state,
        messages: replaceAt(state.messages, index, {
          ...row,
          text: text ?? row.text,
          thinking: thinking ?? row.thinking,
          startedAt: event.startedAt,
          endedAt: event.endedAt,
          usage: event.usage,
          modelProvider: event.modelProvider,
          modelId: event.modelId,
          // Why this answer stopped, carried with the frame that closes it: the live path used to
          // learn it only by reading the transcript back from disk, so a stopped or failed turn
          // looked like an empty answer until the conversation was reopened.
          stopReason: event.stopReason ?? row.stopReason,
          error: event.error ?? row.error,
          images: event.images ?? row.images,
        }),
      }
    }
    case 'reminder': {
      // A reminder arrives whole, once: there is no stream to fold, and a repeated id (the frame
      // replayed after a read) replaces the row it made rather than stacking a second one.
      const row: ChatMessage = { kind: 'reminder', id: event.messageId, at: event.at, text: event.text }
      const index = state.messages.findIndex((message) => message.id === event.messageId)
      if (index === -1) return { ...state, messages: [...state.messages, row] }
      const messages = [...state.messages]
      messages[index] = row
      return { ...state, messages }
    }
    // The notices about the conversation, and only those: the idle recap and the report a
    // compaction prints. A repeated id (the frame replayed after a read) replaces the row it made
    // rather than stacking a second one.
    case 'notice': {
      const code = event.code
      if (!isTranscriptNoticeCode(code)) return state
      const row: ChatMessage = {
        kind: 'notice',
        id: `${code}-${event.seq ?? state.messages.length}`,
        at: Date.now(),
        text: event.message,
        code,
      }
      return { ...state, messages: [...state.messages, row] }
    }
    case 'tool_started':
      return {
        ...state,
        messages: applyToolStarted(state.messages, event),
      }
    case 'tool_updated':
    case 'tool_finished':
      return { ...state, messages: applyToolProgress(state.messages, event) }
    case 'subagent_updated':
      return { ...state, subagents: { ...state.subagents, [event.subagent.id]: event.subagent } }
    case 'ui_request':
      if (state.dialogs.some((dialog) => dialog.id === event.request.id)) return state
      return { ...state, dialogs: [...state.dialogs, event.request] }
    case 'ui_cancelled': {
      const dialogs = state.dialogs.filter((dialog) => dialog.id !== event.requestId)
      return dialogs.length === state.dialogs.length ? state : { ...state, dialogs }
    }
    default:
      // `title_changed`, `notice` and `error` are the store's own: the first names the conversation
      // in the rail as well as here, and the last two are the conversation's commentary rather than
      // its rows. They are folded by the store, not by this function.
      return state
  }
}

/**
 * Append one notice, keeping only the last few.
 *
 * The same line about the same state replaces itself rather than stacking. A reader who presses a
 * control that answers the same thing every time - the stop that finds nothing, above all - used to
 * get one row per press, each with its own ✕, and the stack grew until it had eaten the whole
 * column and pushed the field it was reporting on out of the window (2026-10-27, user report: 16
 * presses of a stop behind an engine that had already gone idle).
 *
 * The row keeps a fresh id so a press that follows a dismissed notice is answered again rather than
 * silently swallowed; what it does not do is add a second copy of the words.
 */
export function pushNotice(
  notices: SessionNotice[],
  level: SessionNotice['level'],
  code: string | null,
  message: string,
): SessionNotice[] {
  noticeSeq += 1
  const notice = { id: noticeSeq, level, code, message, at: Date.now() }
  const last = notices[notices.length - 1]
  if (last !== undefined && last.level === level && last.code === code && last.message === message) {
    return [...notices.slice(0, -1), notice]
  }
  const next = [...notices, notice]
  return next.length > NOTICE_LIMIT ? next.slice(next.length - NOTICE_LIMIT) : next
}

/**
 * The notices a new ask makes stale.
 *
 * A reclaim notice describes the turn the reader was waiting on when the conversation was taken
 * down. Sending again is the reader's answer to that row: the conversation is running, and the
 * notice would otherwise sit above the field as though it were the reply. A reclaim that *failed*
 * is not cleared — it is still something the reader may need to act on.
 */
export function clearReclaimNotices(notices: SessionNotice[]): SessionNotice[] {
  return notices.filter(
    (notice) => notice.code !== 'stalled_reclaimed' && notice.code !== 'force_stopped',
  )
}

/** The key two rows of the same conversation share: the engine's own id for what they stand for. */
function rowKey(message: ChatMessage): string {
  return message.kind === 'tool' ? `tool:${message.toolCallId}` : `row:${message.id}`
}

/**
 * Fold a transcript read back from disk into the rows already on hand.
 *
 * Returning to a conversation whose rows are still in memory must not re-read it as if it were new:
 * the rows on screen are what the reader left, and the read is there to fill the gap a released
 * listener left behind. So the file is the base — it is what the engine wrote down — and a row this
 * side holds that the file does not is kept, in the order it was held.
 *
 * The one row the file *replaces* rather than extends is the reader's own: a prompt written here
 * carries a local id until a frame claims it, and a prompt sent just before the listener was
 * released is one the file already has under the engine's id. Keeping both would show the message
 * twice, so a local row whose words the file already carries is dropped.
 *
 * Where a kept row goes is its own moment, not the end of the walk. A row the file has not caught up
 * with is newer than every row in it and belongs at the end; a row the file will *never* carry - the
 * reader's `/compact`, a command the host runs itself and the engine never writes as a message - is
 * older than the rows around it and must stay there. Appending that one would move a message the
 * reader sent minutes ago under the answer that came after it, which reads as the conversation
 * sending an old line by itself (2026-10-22).
 */
/**
 * What one non-tool row says, for pairing two copies of the same message written under different
 * ids: its kind, the engine's own timestamp, and the words it carries (or, for a thinking-only
 * step, the reasoning). `null` for a row with nothing to say - a tool row is paired by its call id,
 * and an empty row has no identity of its own.
 */
function writtenKey(message: ChatMessage): string | null {
  if (message.kind === 'tool') return null
  const text = message.text.trim()
  const thinking = message.kind === 'assistant' ? message.thinking.trim() : ''
  const body = text !== '' ? `t:${text}` : thinking !== '' ? `k:${thinking}` : ''
  return body === '' ? null : `${message.kind}\u0000${message.at}\u0000${body}`
}

export function mergeTranscript(
  local: readonly ChatMessage[],
  fromFile: readonly ChatMessage[],
): ChatMessage[] {
  const seen = new Set(fromFile.map(rowKey))
  const claimed = new Set(
    fromFile
      .filter((message): message is Extract<ChatMessage, { kind: 'user' }> => message.kind === 'user')
      .map((message) => message.text.trim()),
  )
  /**
   * The same message written by both paths under different ids.
   *
   * A custom message (a delivery a background job hands back, a user-invoked skill) has no engine id
   * on the live path, so the row is announced under a host-generated one; the file carries the
   * entry's own id, and the read back hashes it. Ids therefore cannot pair those two rows, but the
   * moment and the words are the same message's: dropping the local copy when both match is what
   * keeps a reopened conversation from drawing the same delivery twice.
   */
  const written = new Set(
    fromFile
      .map(writtenKey)
      .filter((key): key is string => key !== null),
  )
  const kept = local.filter((message) => {
    const key = writtenKey(message)
    return (
      !seen.has(rowKey(message)) &&
      (key === null || !written.has(key)) &&
      !(
        message.kind === 'user' &&
        message.id.startsWith(LOCAL_MESSAGE_PREFIX) &&
        claimed.has(message.text.trim())
      )
    )
  })
  if (kept.length === 0) return fromFile.slice()
  // Every kept row goes back to the moment it happened, so one the file will never carry stays
  // where the reader sent it instead of being dragged to the bottom of the conversation.
  const merged = fromFile.slice()
  for (const row of kept) {
    let index = 0
    while (index < merged.length && merged[index].at <= row.at) index += 1
    merged.splice(index, 0, row)
  }
  return merged
}

/**
 * Remove the reader's local echoes of the prompts a stop withdrew.
 *
 * A prompt this side sent is drawn immediately as a local row (`state/session-send.ts`), and a stop
 * withdraws the ones the engine had not delivered yet (`AbortOutcome.restored`). A message the engine
 * injected into the turn has already been claimed by its own frame and carries the engine's id, so it
 * is not a local row and is never touched here - it reached the model, so it is not something the
 * stop took back. Matching is newest first and consumes one row per withdrawn prompt, which keeps two
 * identical steers distinct.
 */
export function withdrawLocalPrompts(
  messages: readonly ChatMessage[],
  texts: readonly string[],
): { messages: ChatMessage[]; paths: string[] } {
  const wanted = texts.map((text) => text.trim()).filter((text) => text !== '')
  if (wanted.length === 0) return { messages: [...messages], paths: [] }
  const dropped = new Set<number>()
  const paths: string[] = []
  for (const text of wanted) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (dropped.has(index)) continue
      const row = messages[index]
      if (row === undefined || row.kind !== 'user') continue
      if (!row.id.startsWith(LOCAL_MESSAGE_PREFIX)) continue
      if (row.text.trim() !== text) continue
      dropped.add(index)
      paths.push(...row.attachments.map((attachment) => attachment.path))
      break
    }
  }
  if (dropped.size === 0) return { messages: [...messages], paths: [] }
  return { messages: messages.filter((_, index) => !dropped.has(index)), paths }
}

/**
 * Whether the conversation still holds nothing at all.
 *
 * The engine's own reading at open decides this, never the rows on hand: a conversation whose
 * history is still being walked looks empty here for as long as the read runs, and calling that
 * "nothing has been said" is what would draw an empty conversation over a full one.
 */
export function isUnwritten(engineEmpty: boolean, messages: readonly ChatMessage[]): boolean {
  return engineEmpty && messages.length === 0
}

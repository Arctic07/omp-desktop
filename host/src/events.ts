/**
 * Per-session event fanout: sequence numbers, the replay journal, and the bounded outbound queue.
 *
 * The host emits the engine's own event vocabulary (contract §2.6) with `sessionId`/`seq` added;
 * nothing here normalizes payload shapes - that stays the Rust projection's job.
 */

import { Buffer } from 'node:buffer'

import { EVENT_JOURNAL_BYTES, EVENT_JOURNAL_FRAMES, SESSION_EVENT_QUEUE_BYTES, SESSION_EVENT_QUEUE_FRAMES } from './constants.ts'
import { stampFrameLine } from './protocol/frames.ts'
import { sanitizeMessage } from './log.ts'

/**
 * What one session's pipe needs of the transport: write a prepared frame line, and say whether the
 * consumer is behind.
 *
 * A port rather than the writer itself, so the two budgets and the numbering rule can be exercised
 * without a process to write to (`events.test.ts`); `FrameWriter` is what the host passes in. The
 * line arrives serialized, with the identity it goes out under already in it: the frame is prepared
 * once (`#prepare`) and the writer's job is to frame those bytes, not to produce them again.
 */
export interface SessionEventWriter {
  sendLine(line: string, sessionId: string): void
  readonly congested: boolean
  flush(): Promise<void>
}

/**
 * Whether one queued frame is an increment a later frame supersedes.
 *
 * `message_update` is a turn's own increment, and it is *not* superseded by the next one: the
 * cumulative snapshot it once repeated is already gone by the time the frame is queued
 * (`trimStreamingSnapshot`), so what a shed frame costs is the words it was carrying. It is still
 * shed for the budget - a congested session cannot hold a stream nobody is reading - and the loss
 * is repaired rather than hidden: the projector completes the message from the engine's own record
 * of it when the message ends (`services/runtime/events.rs::message_end_repair`), which is what
 * keeps a shed answer from reaching the screen as a fragment or as no row at all.
 *
 * A `subagent` frame is two different things under one type, and only one of them is superseded.
 * A `progress` half is a snapshot of what a child is doing, so the next snapshot for that child
 * says at least as much as this one. A `lifecycle` half is an edge - a child started, or settled -
 * and nothing later repairs it: the settled edge is the only frame that says a child's work is
 * over, and for a detached batch the parent's `task` result carries no final roster either (it
 * returns with `results: []` before its children finish). Shedding by type alone would therefore
 * drop the one frame that ends a child, and both the roster and the session's own busy fact would
 * keep reading it as running. So the decision looks at the frame's `kind`, not only its type.
 *
 * A `subagent_event` frame is a child's own event passed through, so the increments in it are
 * increments here too: one wrapping a `message_update` is superseded by the next one for that same
 * child exactly like a top-level delta. This is the hottest stream the host carries - every child
 * streams tokens - so leaving it out would make the one stream that most needs shedding the one
 * stream the queue cannot shed, and a congested desktop would grow this session's queue instead.
 *
 * A `tool_execution_update` is cumulative in the same way: it carries the whole partial result so
 * far, and the engine re-sends the growing result on every tick. The desktop's own reader replaces
 * an earlier one for the same call with the newer rather than accumulating them
 * (`events.rs::buffer_tool_update`), so an earlier one is superseded exactly like a delta - and a
 * long-running command streaming its output is the other way a queue fills with frames that say
 * nothing a later frame does not. The call's *end* is a different frame (`tool_execution_end`,
 * which carries the final result) and is never shed, so no output is lost by this: the reader loses
 * an intermediate snapshot of something it is about to be handed whole.
 *
 * A `tool_stream_update` is the raw output chunk of a call in flight, and no reader on this side
 * has a use for it: the desktop's routing table lists it as ignored (`routing.rs::IGNORED`, "tool
 * cards are built from `tool_execution_start`/`_update`/`_end`"). It is also the one ignored frame
 * that arrives in bulk, so under pressure it is the first thing to go - nothing is lost by dropping
 * a frame nobody reads, and leaving it un-sheddable is what would let a chatty command fill this
 * session's queue while the consumer is behind.
 */
function sheddable(frame: Record<string, unknown>): boolean {
  const type = String(frame.type)
  if (type === 'message_update' || type === 'tool_execution_update' || type === 'tool_stream_update') return true
  if (type === 'subagent') return frame.kind === 'progress'
  if (type === 'subagent_event') {
    const event = frame.event
    if (typeof event !== 'object' || event === null) return false
    const nested = String((event as Record<string, unknown>).type)
    return nested === 'message_update' || nested === 'tool_execution_update' || nested === 'tool_stream_update'
  }
  return false
}

/**
 * Whether one frame carries a fragment of an answer's own words.
 *
 * `assistantMessageEvent` is where the increment lives, and a `subagent_event` wraps a child's own
 * event, so the child's fragments are recognised by the same rule as a top-level turn's - the same
 * nesting `sheddable` reads. These frames are the last ones the budget spends: everything else it
 * may shed says nothing a later frame does not, while the text is the answer itself.
 */
function isTextDelta(frame: Record<string, unknown>): boolean {
  const event = frame.type === 'subagent_event' && typeof frame.event === 'object' && frame.event !== null
    ? (frame.event as Record<string, unknown>).assistantMessageEvent
    : frame.assistantMessageEvent
  return typeof event === 'object' && event !== null && (event as Record<string, unknown>).type === 'text_delta'
}

/**
 * Frame types that may be merged under backpressure: idempotent snapshots whose newest member
 * already carries everything the earlier ones said (ruling A18).
 *
 * A `subagent` frame is not one of these whatever its kind: its two halves are not
 * interchangeable, and a lifecycle edge is not a snapshot at all (see `sheddable`).
 */
const SNAPSHOT_FRAMES: Record<string, true> = {
  state: true,
  session_info_update: true,
  available_commands_update: true,
}

/** One journaled frame: the line that went out, with the sequence number it went out under. */
interface JournalFrame {
  readonly seq: number
  readonly line: string
  readonly bytes: number
}

/**
 * One frame waiting to go out: prepared (trimmed, redacted, serialized, measured) but not yet
 * numbered.
 *
 * The number is assigned when the frame is written, not when it is queued, and that is what keeps
 * the stream a reader counts free of holes. The budget below has to take frames when the consumer
 * falls behind, and a frame that never got a number cannot leave one behind: dropping a waiting
 * frame is invisible to a reader following `seq`, while dropping one that had already been numbered
 * is a hole - and, because the journal's window is no larger than the queue's budget, one the
 * journal had already evicted by the time the replay was asked for. Every such hole was answered
 * with a resync, a warning line and a full re-read of the conversation, and a session streaming
 * faster than its consumer stayed in that state: the next frame after each resync was a hole too.
 *
 * A waiting frame is its own serialization: the body is written once here and the identity is
 * spliced ahead of it when the number exists (`stampFrameLine`), so a frame costs one serialization
 * and one copy of its payload rather than two of each. What the shedding rules ask about a frame -
 * whether it is a superseded increment, whether it carries an answer's words, which snapshot type it
 * is - is answered here as well and kept as flags, because the frame object itself is not retained.
 *
 * `droppable` is the one thing a frame can say about the budget: a report that must not be subject
 * to it (`emitProtected`) says no, and is published whatever the queue holds.
 */
interface PendingFrame {
  readonly line: string
  readonly bytes: number
  readonly droppable: boolean
  /** Whether a later frame supersedes this one (`sheddable`). */
  readonly shed: boolean
  /** Whether this frame carries a fragment of an answer's own words (`isTextDelta`). */
  readonly text: boolean
  /** The snapshot type this frame is the newest of (`SNAPSHOT_FRAMES`), or null. */
  readonly snapshot: string | null
}

/** Frame types whose human-readable text is quoted from the engine or from a caller. */
const REDACTED_TEXT_FRAMES: Record<string, true> = {
  error: true,
  notice: true,
  extension_error: true,
}

/**
 * Redacts the free-text fields of a frame that may quote outside text (contract §2.8).
 *
 * The host redacts first and the Rust host redacts again; only fields that are messages rather
 * than payloads are touched, so conversation content is never rewritten.
 */
function redactExternalText(frame: Record<string, unknown>): Record<string, unknown> {
  if (REDACTED_TEXT_FRAMES[String(frame.type)] !== true) return frame
  const redacted = { ...frame }
  for (const field of ['message', 'error', 'detail']) {
    const value = redacted[field]
    if (typeof value === 'string') redacted[field] = sanitizeMessage(value)
  }
  return redacted
}

/**
 * Drops the cumulative snapshot a streaming frame repeats, before the frame is queued.
 *
 * `message_update` carries the assistant message as it stands at that instant *and* the increment
 * that moved it (`assistantMessageEvent`): that is the engine's own type
 * (`pi-agent-core/src/types.ts`: `message: AgentMessage` beside the event). The desktop's reader
 * takes only the increment plus three facts off the message - its id, its role, and, for a message
 * it never announced, its timestamp (`events.rs::on_delta`) - while the rest of it is the whole
 * answer so far, repeated on every delta. A long answer's transport cost therefore grows with the
 * square of its length, on the one stream that runs for minutes.
 *
 * The engine's own RPC mode makes exactly this cut, down to `{ role }` and a delta event without
 * `partial` (`modes/rpc/rpc-session-events.ts::withoutPartial`, its `messageUpdates: "delta"`
 * setting); this is that decision plus the id and timestamp the desktop reads by.
 * `assistantMessageEvent.partial` is the same snapshot under the event, so it goes with it.
 *
 * Nothing else changes: the frame keeps its type and its increment, and keeps a `message` for a
 * reader that expects one. `message_start` and `message_end` carry the message once each and are
 * left alone - they are where the reader gets the whole thing. An engine message carries no id of
 * its own, so the trim does not require one: the desktop pairs the increment with the row its
 * opening frame announced, and the role is what that reader needs from the message here.
 *
 * A `subagent_event` wraps a child's own event, and a child streams through the same reader, so the
 * nested copy is trimmed by the same rule.
 */
function trimStreamingSnapshot(frame: Record<string, unknown>): Record<string, unknown> {
  const type = String(frame.type)
  if (type === 'message_update') return withoutSnapshot(frame)
  if (type !== 'subagent_event') return frame
  const nested = frame.event
  if (typeof nested !== 'object' || nested === null) return frame
  const inner = nested as Record<string, unknown>
  if (String(inner.type) !== 'message_update') return frame
  const trimmed = withoutSnapshot(inner)
  return trimmed === inner ? frame : { ...frame, event: trimmed }
}

/** One `message_update` without the cumulative snapshot it repeats; unchanged when it has none. */
export function withoutSnapshot(frame: Record<string, unknown>): Record<string, unknown> {
  const message = frame.message
  if (typeof message !== 'object' || message === null) return frame
  const source = message as Record<string, unknown>
  const slim: Record<string, unknown> = { role: source.role }
  if (typeof source.id === 'string' && source.id.length > 0) slim.id = source.id
  if (source.timestamp !== undefined) slim.timestamp = source.timestamp
  const event = frame.assistantMessageEvent
  if (typeof event !== 'object' || event === null || !('partial' in event)) {
    return { ...frame, message: slim }
  }
  const { partial: _partial, ...increment } = event as Record<string, unknown>
  return { ...frame, message: slim, assistantMessageEvent: increment }
}

/**
 * One session's outbound side.
 *
 * Frames are queued per session so a single congested session cannot starve the others, and so
 * the shedding rule can protect terminal frames per session rather than globally.
 */
export class SessionEvents {
  #sessionId: string
  readonly #writer: SessionEventWriter
  readonly #onDropped: (count: number) => void
  readonly #onCoalesced: (count: number) => void
  #seq = 0
  #journal: JournalFrame[] = []
  #journalBytes = 0
  #pending: PendingFrame[] = []
  #pendingBytes = 0
  #timer: NodeJS.Timeout | null = null

  constructor(
    sessionId: string,
    writer: SessionEventWriter,
    onDropped: (count: number) => void,
    onCoalesced: (count: number) => void,
  ) {
    this.#sessionId = sessionId
    this.#writer = writer
    this.#onDropped = onDropped
    this.#onCoalesced = onCoalesced
  }

  /** Sequence number of the most recently published frame. */
  get seq(): number {
    return this.#seq
  }

  /** The id every frame this pipe publishes is stamped with. */
  get sessionId(): string {
    return this.#sessionId
  }

  /**
   * Stamps later frames with a new session id, without touching the sequence or the journal.
   *
   * Branching rewrites a conversation onto another file, and a session is addressed by the digest
   * of its file - so the pipe a live session publishes through has to follow it. The numbering is
   * deliberately kept: the frames already sent described this conversation, and a reader resyncing
   * against the branch's own `state` counts from the sequence it carries either way.
   *
   * Frames still waiting go out first, under the identity they were produced by: a reader is
   * following that identity now and will only be moved to the new one by the caller that asked for
   * the branch, so a frame published after the move would reach a channel nobody is on yet.
   */
  rekey(sessionId: string): void {
    const publishing = this.#pending
    this.#pending = []
    this.#pendingBytes = 0
    for (const entry of publishing) this.#publish(entry)
    this.#sessionId = sessionId
  }

  /**
   * Charges frames this session lost before they ever reached the queue.
   *
   * The queue's own shedding already reports through the injected callback, and the two counters
   * behind it are the session's whole loss figure (`session_state.droppedFrames` and
   * `host_health.droppedFrames`). A frame a producer dropped upstream - a child event with no
   * transcript to address it to (`subagents.ts`'s `#dropEventFrame`) - has to be charged to the
   * same two counters, or that figure would be smaller than the truth and nothing else would say
   * how much smaller.
   */
  noteDroppedFrames(count: number): void {
    this.#onDropped(count)
  }

  /** Queues one engine event; it is numbered when it goes out (see `PendingFrame`). */
  emit(frame: Record<string, unknown>): void {
    this.#pending.push(this.#prepare(frame, true))
    this.#schedule(0)
  }

  /**
   * Queues one frame the outbound budget must not take.
   *
   * Used for a report that must not itself be subject to the budget it describes. It is published
   * ahead of everything already waiting and is never a candidate for the budget, but it is still
   * numbered and journaled like any other frame, so a reader's expectation keeps advancing.
   */
  emitProtected(frame: Record<string, unknown>): void {
    this.#pending.unshift(this.#prepare(frame, false))
    this.#schedule(0)
  }

  /**
   * Frames between `fromSeq` and `toSeq` inclusive.
   *
   * `truncated` reports that the requested start predates the retained journal, which is the
   * caller's signal to rebuild from `session_state` + `session_history_page` instead. The journal
   * holds only frames that went out, numbered consecutively (`PendingFrame`), so this is the one
   * case a reader meets a hole it cannot be handed back: its own cursor fell further behind than the
   * window, rather than a frame having been dropped under it.
   */
  replay(fromSeq: number, toSeq: number | null): { events: Record<string, unknown>[]; truncated: boolean } {
    const oldest = this.#journal.length > 0 ? (this.#journal[0] as JournalFrame).seq : this.#seq + 1
    const truncated = fromSeq < oldest
    const events = this.#journal
      .filter(entry => entry.seq >= fromSeq && (toSeq === null || entry.seq <= toSeq))
      // Parsed back from the line that went out, which is the frame as the reader would have
      // received it: the journal holds no second copy of the payload.
      .map(entry => JSON.parse(entry.line) as Record<string, unknown>)
    return { events, truncated }
  }

  /**
   * Publishes everything waiting for this session now instead of on the next tick.
   *
   * A response that carries a `state.seq` anchor must not overtake the frames that anchor counts:
   * the caller would be told "you are caught up to N" while frames 1..N are still in flight, and
   * a gap-detecting reader would then see them as duplicates or as a hole. The anchor is read off
   * this pipe after the call, and only published frames carry a number, so the two cannot disagree.
   */
  async flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#flush()
    await this.#writer.flush()
  }

  /** Trims, redacts, serializes and measures one frame, so the budget can judge it before it is numbered. */
  #prepare(frame: Record<string, unknown>, droppable: boolean): PendingFrame {
    const prepared = trimStreamingSnapshot(redactExternalText(frame))
    const line = JSON.stringify(prepared)
    const type = String(prepared.type)
    return {
      line,
      bytes: Buffer.byteLength(line, 'utf8'),
      droppable,
      shed: sheddable(prepared),
      text: isTextDelta(prepared),
      snapshot: SNAPSHOT_FRAMES[type] === true ? type : null,
    }
  }

  /**
   * Numbers one waiting frame, journals it and writes it.
   *
   * The number is assigned here rather than when the frame was queued, because the journal and the
   * reader's cursor both count published frames: only a frame that reaches the wire may have a
   * number (see `PendingFrame`). The measurement taken at queue time is reused rather than repeated
   * over the stamped frame, which is that same frame plus the session id and the number - and so is
   * the serialization: the stamp is spliced ahead of the body the frame was prepared with, which is
   * what keeps a long answer's payload from being copied twice per increment.
   */
  #publish(entry: PendingFrame): void {
    this.#seq += 1
    const line = stampFrameLine(entry.line, this.sessionId, this.#seq)
    const journaled: JournalFrame = { seq: this.#seq, line, bytes: entry.bytes }
    this.#journal.push(journaled)
    this.#journalBytes += journaled.bytes
    this.#enforceJournal()
    this.#writer.sendLine(line, this.sessionId)
  }

  /**
   * Trims the journal back to its budget, oldest first.
   *
   * A replay that starts before what is left is answered `truncated`; the reader then rebuilds the
   * conversation from `session_state` + `session_history_page` instead of projecting a stream with a
   * hole in it. That is why the depth and the bytes both bound it from the same end, and why
   * nothing here sheds by frame type the way the outbound queue does: a `message_update` in the
   * journal is *not* superseded by a later one for a replay that never saw either - the frames the
   * frontend missed are rebuilt in order from exactly these - so the only honest way to shrink the
   * window is to move its oldest edge.
   */
  #enforceJournal(): void {
    while (this.#journal.length > EVENT_JOURNAL_FRAMES || this.#journalBytes > EVENT_JOURNAL_BYTES) {
      const dropped = this.#journal.shift()
      if (dropped === undefined) break
      this.#journalBytes -= dropped.bytes
    }
  }

  /**
   * Ends this pipe: the waiting frames go, and the congestion retry stops.
   *
   * A released session is out of the registry, so nothing it still holds can be addressed: the
   * frames would be written for a conversation no reader has, and while the transport is congested
   * the retry timer would keep re-asking on its 50 ms schedule for as long as that lasts. Every
   * teardown path comes through here (`session-lifecycle.ts`'s `disposeSession`).
   */
  dispose(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#pending = []
    this.#pendingBytes = 0
    this.#journal = []
    this.#journalBytes = 0
  }

  #schedule(delayMs: number): void {
    if (this.#timer !== null) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#flush()
    }, delayMs)
  }

  /**
   * Numbers and writes the waiting frames, shrinking the queue to its budget first.
   *
   * Over budget, increments go first - `message_update`, and a `subagent` frame's progress half
   * (see `sheddable`) - because they are the stream a congested session cannot hold. A shed
   * `message_update` costs the words it carried (its snapshot is already gone; see `sheddable`),
   * which the projector repairs from the engine's own record when the message ends. When no
   * increment is left to shed, the queue is shrunk by merging idempotent snapshots (`state`,
   * `session_info_update`, `available_commands_update`) down to their newest
   * member: those are last-write-wins, so the reader sees the same thing it would have seen had
   * every earlier one arrived. Terminal frames (`agent_end`, `turn_end`, `message_end`, `error`)
   * and subagent lifecycle edges are never touched, so an overloaded session still loses no
   * completion signal.
   *
   * Everything here happens before the frames are numbered (`PendingFrame`), so what the budget
   * takes is a frame the reader never knew about - no hole, and so nothing to replay. A notice is
   * published for every frame the budget took, on both branches: the consumer being behind is
   * exactly when shedding happens, and a notification that is skipped in that case would never be
   * seen at all.
   *
   * The frames being written are taken out of the queue first, because writing one can put another
   * there: an encoder that refuses a frame reports it through `emitProtected`, and that report must
   * survive this pass rather than be swept away with it.
   */
  #flush(): void {
    const dropped = this.#enforceBudget()
    if (this.#writer.congested && this.#pending.length > 0) {
      // The consumer is behind: hold this session's frames rather than growing the writer's queue.
      this.#schedule(50)
    } else {
      const publishing = this.#pending
      this.#pending = []
      this.#pendingBytes = 0
      for (const entry of publishing) this.#publish(entry)
    }
    if (dropped.dropped > 0 || dropped.coalesced > 0) this.#reportBudget(dropped.dropped, dropped.coalesced)
  }

  /** Shrinks the queue back to its budget; returns what the budget cost. */
  #enforceBudget(): { dropped: number; coalesced: number } {
    // An answer's own words go last. A hidden reasoning fragment, a cumulative tool update and the
    // raw tool stream all say nothing a later frame does not, while a `text_delta` is the one
    // increment nothing else repeats - so the first pass sheds those, and the answer's text is
    // only spent once there is nothing else left to spend.
    let dropped = this.#dropIncrements(entry => !entry.text)
    if (this.#overBudget()) dropped += this.#dropIncrements(entry => entry.text)
    const coalesced = this.#overBudget() ? this.#coalesceSnapshots() : 0
    if (dropped > 0) this.#onDropped(dropped)
    if (coalesced > 0) this.#onCoalesced(coalesced)
    return { dropped, coalesced }
  }

  #overBudget(): boolean {
    return this.#pending.length > SESSION_EVENT_QUEUE_FRAMES || this.#pendingBytes > SESSION_EVENT_QUEUE_BYTES
  }

  /** Drops every waiting frame `wanted` picks, until the budget is met or none is left. */
  #dropIncrements(wanted: (entry: PendingFrame) => boolean): number {
    let dropped = 0
    for (let index = 0; index < this.#pending.length && this.#overBudget(); ) {
      const entry = this.#pending[index] as PendingFrame
      if (entry.droppable && entry.shed && wanted(entry)) {
        this.#release(index)
        dropped += 1
        continue
      }
      index += 1
    }
    return dropped
  }

  /** Keeps only the newest waiting frame of each snapshot type. */
  #coalesceSnapshots(): number {
    const newestOfType = new Map<string, number>()
    for (let index = 0; index < this.#pending.length; index += 1) {
      const entry = this.#pending[index] as PendingFrame
      if (entry.droppable && entry.snapshot !== null) newestOfType.set(entry.snapshot, index)
    }
    let coalesced = 0
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      const entry = this.#pending[index] as PendingFrame
      const snapshot = entry.snapshot
      if (!entry.droppable || snapshot === null || newestOfType.get(snapshot) === index) continue
      this.#release(index)
      coalesced += 1
    }
    return coalesced
  }

  #release(index: number): void {
    const [removed] = this.#pending.splice(index, 1)
    if (removed !== undefined) this.#pendingBytes -= removed.bytes
  }

  /** Publishes the budget report; the notice itself is neither sheddable nor a candidate for it. */
  #reportBudget(dropped: number, coalesced: number): void {
    const parts: string[] = []
    if (dropped > 0) parts.push(`${dropped} incremental frame(s) shed`)
    if (coalesced > 0) parts.push(`${coalesced} superseded snapshot(s) merged`)
    this.#pending.push(this.#prepare({ type: 'notice', level: 'warning', message: `Host under backpressure: ${parts.join(', ')}.` }, false))
    this.#schedule(0)
  }
}

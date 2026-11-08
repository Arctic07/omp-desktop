/**
 * Which of its states the conversation column is in.
 *
 * Four facts, kept apart because each reads as itself: the **hero** is the workspace's own screen
 * (no workspace at all, or a conversation with nothing said in it yet — the same screen, because
 * both ask the same question), **reading** is a conversation whose rows have not arrived, the
 * **conversation** is one with rows to draw, and **failed** is an open or a read the desktop
 * refused. Drawing an empty transcript for the first three is what used to report the wrong one —
 * "还没有对话内容" over a conversation that had plenty in it.
 *
 * `opening` is what makes a click a *wait* rather than a blank screen: the store sets it from the
 * first moment an open or a workspace switch is going to produce a conversation, so the column holds
 * its loading mark until that conversation is named.
 *
 * **A read in flight is the wait, whatever rows it has painted so far.** The read reports a page at a
 * time, so a long conversation acquires rows before it is complete: those rows are a prefix, and a
 * pane mounted on them draws a transcript that keeps rewriting itself — the reader watched rows
 * overlap for a frame as each page landed, the view re-anchored at the foot on every page, and the
 * pictures inside the window mount, decode and unmount again (2026-11-05, user report: 点开长会话
 * 没有加载动画，只看到文字挤压、图片闪烁、抖动一会才正常). The mark stays up for the read instead,
 * with the count of the pages it has, and the transcript is drawn once, whole, where the reader is
 * left (the foot). A conversation whose read has *finished* is drawn at once: coming back to one kept
 * warm must not flash a spinner over its own content.
 *
 * A **turn in flight** is the one thing the wait yields to. The reader who comes back to a
 * conversation whose turn is still running is watching an answer arrive, and that answer is not the
 * read's to hold back: a conversation attached mid-turn draws at once, and the rows the walk paints
 * are merged under it when the read lands.
 *
 * An open that is *creating* a conversation (`openingNew`) is the hero, not a wait: nothing is
 * being read, and the reader is looking at the screen their first message will be written on
 * (2026-10-29, user report: creating a new conversation showed "正在读取会话" under it).
 *
 * The shape below is the whole of what the rule reads; it is declared here rather than importing
 * the store so the rule can be decided by `node --test` without the store's runtime dependencies.
 * `isStreaming` is imported rather than restated because "a turn in flight" has one home
 * (`state/work-readings.ts`), and it is that same rule the rail's mark and the field's stop read.
 */
import { isStreaming } from '../state/work-readings.ts'

export type ConversationPhase = 'hero' | 'reading' | 'conversation' | 'failed'

/** The part of the session store this rule reads. */
export interface ConversationPhaseState {
  readonly workspaceId: number | null
  readonly openStatus: 'idle' | 'opening' | 'ready' | 'error'
  /** Whether the open in flight is creating a conversation rather than reading one. */
  readonly openingNew: boolean
  readonly activeId: string | null
  readonly records: Readonly<
    Record<
      string,
      {
        readonly engineEmpty: boolean
        readonly messages: readonly unknown[]
        readonly historyStatus: 'idle' | 'loading' | 'ready' | 'error'
        /** The two legs `isStreaming` reads: the turn opened here, and the engine's own snapshot. */
        readonly turnId: string | null
        readonly runtime: { readonly isStreaming?: boolean } | null
      }
    >
  >
}

export function conversationPhase(state: ConversationPhaseState): ConversationPhase {
  // No workspace: the hero is the workspace's own screen, and its row is how one is picked.
  if (state.workspaceId === null) return 'hero'
  if (state.openStatus === 'error') return 'failed'
  const record = state.activeId === null ? null : (state.records[state.activeId] ?? null)
  // A conversation being opened, or one whose rows are still being read: never the hero, so coming
  // back to a long conversation does not flash the workspace screen first. A conversation being
  // *created* is the exception: there is nothing to read, and the hero is the screen its first
  // message is written on.
  if (record === null) return state.openStatus === 'opening' && !state.openingNew ? 'reading' : 'hero'
  if (record.historyStatus === 'error' && record.messages.length === 0) return 'failed'
  // Nothing on screen: the hero, unless the engine says there is history to read. A conversation the
  // engine reports as holding nothing is the empty one it is, from the first frame — and one the
  // reader has already written into is not that conversation any more, whatever the engine said.
  if (record.engineEmpty && record.messages.length === 0) return 'hero'
  // The read in flight is the wait, rows or none: the pages it has written are a prefix of a
  // transcript still arriving, and a pane drawn on them rewrites itself under the reader for as long
  // as the read runs. The rows stay in the record — the walk writes them — and are what the pane is
  // drawn from the moment the read is over. A turn in flight is the exception: the reader is watching
  // an answer arrive, and that is drawn while the read lands under it. (A conversation the engine
  // calls empty, which the reader has already written into, is the branch above.)
  if (record.historyStatus === 'loading' && !record.engineEmpty && !isStreaming(record)) return 'reading'
  if (record.messages.length > 0) return 'conversation'
  // A read that is *over* and produced nothing is not a read still in progress. Left as `reading`,
  // this state drew a loading mark over a conversation nothing was ever going to fill — the pane
  // never showed rows, a failure or a retry (2026-10-27, user report: "switched to it and the
  // conversation never loaded"). It is the read's own ending, so it is drawn as one.
  return record.historyStatus === 'ready' ? 'failed' : 'reading'
}

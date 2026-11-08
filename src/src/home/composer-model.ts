/**
 * The model the composer's field names, and the pick a conversation that is still opening waits on.
 *
 * Kept out of the composer so the rule can be decided by `node --test`: it is the whole of what a
 * reader reads as "the model this conversation is on", and getting it wrong is invisible until
 * someone notices answers from a model they did not choose.
 */
import type { ConversationPhase } from './conversation-phase.ts'

/**
 * The model the field names, or null when there is none to name.
 *
 * A conversation names **its own** model: the one its session reports (`current`), or the pick it is
 * still being switched to (`pending`). The engine's `default` role is named only on the hero screen —
 * there is no conversation there to be wrong about, and that role is what the next one starts on.
 *
 * Naming it over a conversation is how the field came to state a model the conversation was not
 * running: a pick made at the start became the role, the conversation started on it, and every later
 * pick was written to the session alone — so a reopen that named the role again read as "the
 * conversation forgot the model I chose last" (2026-10-29, user report). Null is a real state rather
 * than an empty one: it locks the thinking control, because a strength belongs to a model.
 */
export function namedModel(input: {
  /** The session's own model, when this app's catalogue carries it. */
  current: string | null
  /** A pick still waiting for its conversation to open. */
  pending: string | null
  /** Which screen is on. */
  phase: ConversationPhase
  /** The engine's `default` role, as a selector this app offers. */
  defaultModel: string | null
}): string | null {
  if (input.current !== null) return input.current
  if (input.pending !== null) return input.pending
  return input.phase === 'hero' ? input.defaultModel : null
}

/**
 * A pick made for a conversation that has not opened yet, and when it was made.
 *
 * The two controls share one slot because they are one gesture apart in time and only one
 * conversation can be opening: whichever the reader touched last is the one waiting.
 */
export interface PendingPick {
  /** The model selector, as `provider/id`. */
  readonly model?: string
  /** The thinking level the conversation was asked for. */
  readonly thinking?: string
  readonly at: number
}

/**
 * How long such a pick stays armed.
 *
 * An open is a host activation plus a transcript load — seconds, not tens of seconds — so a pick
 * that has waited longer belongs to an open that failed, and must not travel to whatever the reader
 * opens next.
 */
export const PENDING_PICK_TTL_MS = 30_000

/**
 * Whether a held pick still belongs to the open it was made for.
 *
 * `sessionId` non-null means that open landed: the pick is written now. Otherwise it is kept only
 * while the conversation is still coming up and it has not aged out — a failed open, or one that
 * took longer than any open does, drops it rather than handing it to the next conversation.
 */
export function pendingPickHolds(
  pending: PendingPick | null,
  state: { sessionId: string | null; phase: ConversationPhase; now: number },
): 'apply' | 'hold' | 'drop' {
  if (pending === null) return 'drop'
  if (state.sessionId !== null) return 'apply'
  if (state.phase === 'failed') return 'drop'
  return state.now - pending.at > PENDING_PICK_TTL_MS ? 'drop' : 'hold'
}

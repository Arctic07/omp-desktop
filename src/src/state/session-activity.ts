/**
 * When each conversation last said anything, in this process's own clock.
 *
 * A conversation's frame arrivals are the one continuous proof that its turn is still moving. The
 * state snapshot carries the host's `lastEventAt`, but that snapshot is published on edges — a
 * healthy turn that has been streaming for ten minutes can have a snapshot that is ten minutes old —
 * so a watchdog built on it alone would call a working turn silent. Every frame folded here moves
 * this clock, including the ones the transcript does not draw.
 *
 * The clock is deliberately not part of the session store: writing it on every frame would replace
 * the store's state (and re-run every subscription) hundreds of times per turn for a value no row
 * displays. A `Map` keyed by session id is enough, and the stall watcher is its only reader —
 * of the clock ({@link lastSessionActivity}) and of the activity notes ({@link onSessionHeard}).
 *
 * Owner: this module. Bound: the conversations this process holds a record for. Released: the clock
 * and the snooze with the record — `forgetSessionActivity` is called from every path that deletes
 * one — and the arrival subscriptions with the disposer their registration answers (see {@link heard}).
 */
const activity = new Map<string, number>()

/**
 * The activity notes a surface can act on, beside the clock they move.
 *
 * The clock answers "when", never "now", so a surface that has to stop drawing something the moment
 * the conversation produces again (the stall row, `state/session-stall.ts`) subscribes here instead
 * of comparing timestamps on its own timer. A callback and not a store write, for the same reason
 * the clock is a `Map`: per-frame state would re-run every subscription for a fact no row displays.
 *
 * Owner: this module. Bound: the live subscriptions (one today: the stall watch). Released: the
 * disposer each registration answers, called by `state/session-stall.ts::stopStallWatch`.
 */
const heard = new Set<(sessionId: string) => void>()

/**
 * When the reader's *keep waiting* expires, for conversations with an overdue turn.
 *
 * It lives beside the clock so both are released by the same call: a conversation that is deleted,
 * shed or let go must not leave a snooze behind for an id nobody will see again.
 */
const snoozed = new Map<string, number>()

/** Note that a conversation produced something: a frame arrived, or an open wrote its baseline. */
export function noteSessionActivity(sessionId: string, at: number = Date.now()): void {
  activity.set(sessionId, at)
  for (const listener of heard) {
    // A listener that throws must not cost the clock every other reader depends on: the note has
    // already landed, and the readers of the clock still get their answer.
    try {
      listener(sessionId)
    } catch (error) {
      console.error('a session activity listener failed', error)
    }
  }
}

/**
 * Subscribe to activity notes — a frame arrival, or the open that baselines the clock
 * (`session-store.ts::createRecord`, `paintSummary`). The answer is the disposer.
 */
export function onSessionHeard(listener: (sessionId: string) => void): () => void {
  heard.add(listener)
  return () => {
    heard.delete(listener)
  }
}

/** The last moment this process heard from one conversation, or 0 when it never did. */
export function lastSessionActivity(sessionId: string): number {
  return activity.get(sessionId) ?? 0
}

/** Silence the automatic reclaim of one conversation until `until`. */
export function snoozeSession(sessionId: string, until: number): void {
  snoozed.set(sessionId, until)
}

/** When that silence ends, or 0 when the conversation is not snoozed. */
export function sessionSnoozed(sessionId: string): number {
  return snoozed.get(sessionId) ?? 0
}

/** Drop one conversation's clock and snooze, with the record they belonged to. */
export function forgetSessionActivity(sessionId: string): void {
  activity.delete(sessionId)
  snoozed.delete(sessionId)
}

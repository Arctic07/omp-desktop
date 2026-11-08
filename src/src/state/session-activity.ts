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
 * displays. A `Map` keyed by session id is enough, and the stall watcher is its only reader.
 *
 * Owner: this module. Bound: the conversations this process holds a record for. Released: with the
 * record — `forgetSessionActivity` is called from every path that deletes one.
 */
const activity = new Map<string, number>()

/**
 * When the reader's *keep waiting* expires, for conversations with an overdue turn.
 *
 * It lives beside the clock so both are released by the same call: a conversation that is deleted,
 * shed or let go must not leave a snooze behind for an id nobody will see again.
 */
const snoozed = new Map<string, number>()

/** Note that a conversation's stream produced something now. */
export function noteSessionActivity(sessionId: string, at: number = Date.now()): void {
  activity.set(sessionId, at)
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

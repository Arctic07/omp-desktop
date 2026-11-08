/**
 * Which conversations this process has been in, and how recently.
 *
 * A visit is taken where the reader's own actions land — a conversation adopted onto the screen, a
 * prompt sent — because those are the moments that say the conversation is wanted rather than merely
 * remembered. It is what the ceiling reads when it has to shed one: the oldest visit goes first
 * (`session-store.ts::pruneRecords`).
 *
 * It is kept here rather than in the store that reads it because two writers take visits and neither
 * owns the other: the store adopts a conversation onto the screen, and the sender marks one it is
 * about to write into. The counter only ever grows, and a conversation that is forgotten takes its
 * rank with it, so the map is bounded by the conversations this process has been in.
 */

const visitOrder = new Map<string, number>()
let visits = 0

/** Mark a conversation as the one just visited. */
export function noteVisit(sessionId: string): void {
  visits += 1
  visitOrder.set(sessionId, visits)
}

/** How recently a conversation was visited; -1 for one this process has never been in. */
export function visitRank(sessionId: string): number {
  return visitOrder.get(sessionId) ?? -1
}

/** Drop a conversation's rank, for one that no longer exists at all. */
export function forgetVisit(sessionId: string): void {
  visitOrder.delete(sessionId)
}

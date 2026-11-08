/**
 * How much of the work column's per-conversation state this process keeps.
 *
 * The column's maps (its flags, its terminals, its tabs) are keyed by session id and were only ever
 * released when a conversation disappeared for good
 * (`state/panel-store.ts::forgetSession`). A reader who opened a shell in a hundred conversations
 * therefore kept a hundred entries — and, worse, kept their conversations from being shed at all: a
 * conversation whose column holds anything is not recyclable (`ownsPanelState`, read by
 * `session-store.ts::pruneRecords`), so the record ceiling could never reach the sessions the column
 * was holding. Both bounds are the same idea applied twice, and this one is the column's.
 *
 * Two facts decide what goes. **Recency** is the visit order the session store already keeps
 * (`state/session-visits.ts`): the same ranking that sheds a record sheds its column state, so the
 * two ceilings agree on which conversations the reader has left behind. **The conversation on
 * screen is never released** — the reader is looking at it, and its tabs are what is drawn.
 *
 * The counter rule is the second half: a tab id only has to be unique among the tabs that exist, so
 * once no conversation is named at all the counter may start over. Without that, a long install
 * climbs forever, and the numbers the strip prints (`PowerShell-1`, `-2`…) drift far from what a
 * conversation actually holds.
 *
 * Pure by construction: the maps, the ranking and the counters are arguments, so the rules are
 * testable without a store or a renderer (`state/panel-bound.test.ts`).
 */

/**
 * How many conversations the column keeps state for.
 *
 * Above the session store's own record ceiling (`RETAINED_RECORDS`, 16) on purpose: the record is
 * the expensive thing, the column's entries are a handful of keys and numbers each, and a reader who
 * has visited sixty-four conversations still expects the terminal in the one from this morning to be
 * there. Below the point where the maps themselves would be a memory question - they are thousands
 * of times smaller than one transcript.
 */
export const RETAINED_PANEL_SESSIONS = 64

/**
 * The conversations whose column state has to be released, oldest visit first.
 *
 * Nothing is taken while the column fits, and the conversation on screen is never a candidate - so
 * a bound that has to shed one keeps the reader's own column whole and lets the conversation behind
 * them be released on the next switch back into it.
 */
export function sessionsOverBound(
  owners: readonly string[],
  activeId: string | null,
  rank: (sessionId: string) => number,
  limit: number = RETAINED_PANEL_SESSIONS,
): string[] {
  const excess = owners.length - limit
  if (excess <= 0) return []
  return owners
    .filter((id) => id !== activeId)
    .sort((left, right) => rank(left) - rank(right))
    .slice(0, excess)
}

/**
 * The counter one write leaves behind: whatever the write asked for, or its first value once the
 * maps name no conversation at all.
 *
 * Read as "is there anything alive", the same way `ownsPanelState` is: one key in any of the maps is
 * a conversation whose tabs could still carry an id, and then the counter must not repeat one.
 */
export function counterAfterWrite(
  next: number,
  named: readonly Record<string, unknown>[],
): number {
  return named.some((map) => Object.keys(map).length > 0) ? next : 1
}

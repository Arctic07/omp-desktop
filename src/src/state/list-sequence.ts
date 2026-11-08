/**
 * The order a workspace's list reads are applied in.
 *
 * A list read is a round trip — `session_list` scans the session store — and several can be in
 * flight for one workspace at once: a turn edge asks, the window coming back asks, and a
 * conversation opening asks. Their answers may come back in either order, and the older scan can
 * arrive last. Writing it would put the rail back to the store as it was when that scan started,
 * which drops whatever the newer answer had: a conversation the older scan began before, or one
 * whose transcript the engine was publishing a rewrite over at that instant (the row the user then
 * misses until some later read — 2026-10-26, user report: a running conversation vanished from the
 * list, and came back when the next conversation's turn started).
 *
 * So each read takes a ticket, and only a ticket newer than the answer already applied may write.
 * A ticket is taken per read rather than per workspace, because two reads for *different*
 * workspaces are independent facts (the rail draws every workspace's list).
 *
 * Pure and import-free on purpose: the front end's store modules import through the bundler's
 * `@/` alias, which the Node test runner cannot resolve (see `home/rail-rows.ts` for the same
 * rule), so the order rule lives where a test can read it.
 */
export interface ListSequence {
  /** A ticket for a read that is about to start. */
  start(): number
  /**
   * Whether that read's answer may be written, moving the workspace's applied ticket up to it.
   *
   * An answer older than the one already applied answers `false`, and the caller drops it: the
   * store already holds a newer read of the same list.
   */
  accept(workspaceId: number, ticket: number): boolean
}

export function createListSequence(): ListSequence {
  let issued = 0
  const applied = new Map<number, number>()
  return {
    start(): number {
      issued += 1
      return issued
    },
    accept(workspaceId: number, ticket: number): boolean {
      if (ticket <= (applied.get(workspaceId) ?? 0)) return false
      applied.set(workspaceId, ticket)
      return true
    },
  }
}

/**
 * Which of the tool column's owners no longer name a conversation.
 *
 * The column keeps state per session id (tabs, the active tab), and a conversation can disappear
 * for good — the rail's list stops carrying it, which is a deletion (a conversation that is merely
 * archived stays listed). That state is released then.
 *
 * **A conversation this process is holding is alive even when the list has never carried it.**
 * The list is a read of what is on disk, and it is re-read on switches and turn ends, not on every
 * open: the blank conversation "new conversation" asks the engine for has an id and a record at
 * once, but its row arrives only with a later read. Judging by the list alone therefore threw away
 * the tabs of a conversation the reader was looking at — the terminal opened and vanished in the
 * same turn (2026-10-24, user report: it would not open in a new conversation).
 */

/**
 * The owners whose tabs must be released now.
 *
 * `held` is the session store's records: a conversation open in this process owns its state, even
 * before the rail's list has a row for it.
 */
export function stalePanelOwners(
  owners: readonly string[],
  listed: ReadonlySet<string>,
  held: Readonly<Record<string, unknown>>,
): string[] {
  return owners.filter((id) => !listed.has(id) && held[id] === undefined)
}

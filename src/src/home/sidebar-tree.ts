/**
 * The workspace store and the session store, shaped as the rail's resource tree.
 *
 * The rail is one level of workspaces with their conversations under them — not the folders on disk.
 * A workspace row is the workspace; its children are the sessions the desktop knows for it, newest
 * first, each carrying the mark its own status earns. A workspace shows a page of them at a time —
 * the caller decides how big that page is — and the caller draws its own control for the rest.
 *
 * A node id carries which workspace it belongs to and, for a conversation, which session file it
 * stands for. The session id is not the file path: a conversation the host has not written yet has
 * no file, so the file path is what the row carries and `null` is what "the blank one" is.
 */

import type { SidebarResource, SidebarResourceStatus } from '@/components/agents/ai-sidebar'
import type { SessionOrderEntry, SessionSummary, TurnOutcome } from '@/api/session-types'
import type { WorkspaceSessions } from '@/state/session-store'
import { isListedSession } from '../state/session-rows.ts'

const ID_PREFIX = 'ws-'

/** The turn a conversation last finished here, before its workspace list caught up. */
export interface FinishedTurn {
  outcome: TurnOutcome
  /** Host time of the ending, compared with the row's own `updatedAt`. */
  at: number
  /** Whether this ending was the reader's own stop, the one ending they already know. */
  seen: boolean
}

export type SidebarNode =
  | { kind: 'workspace'; workspaceId: number }
  | { kind: 'session'; workspaceId: number; sessionId: string }

export function workspaceNodeId(workspaceId: number): string {
  return `${ID_PREFIX}${workspaceId}`
}

function sessionNodeId(workspaceId: number, sessionId: string): string {
  return `${ID_PREFIX}${workspaceId}:${sessionId}`
}

export function parseSidebarNodeId(id: string): SidebarNode | null {
  if (!id.startsWith(ID_PREFIX)) return null
  const rest = id.slice(ID_PREFIX.length)
  const cut = rest.indexOf(':')
  const idPart = cut === -1 ? rest : rest.slice(0, cut)
  const workspaceId = Number(idPart)
  if (!Number.isInteger(workspaceId)) return null
  if (cut === -1) return { kind: 'workspace', workspaceId }
  return { kind: 'session', workspaceId, sessionId: rest.slice(cut + 1) }
}

/**
 * The mark a conversation row carries.
 *
 * The engine's cold status is a snapshot of the file, and what this process watched happen outranks
 * it: a turn in flight marks the row as running whatever the file still says. A status the reader
 * has already seen stops marking, and the next status the engine writes marks it again.
 */
function sessionStatus(
  session: SessionSummary,
  options: {
    working: boolean
    read: boolean
    /** When this row's status was last seen (host clock); compared with the ending's own time. */
    seenAt: number
    finished: FinishedTurn | undefined
  },
): SidebarResourceStatus | undefined {
  if (options.working) return 'running'
  // The workspace list lags the ending: it still holds the status from before the turn (usually
  // `pending`) until the read that `turn_finished` started comes back. Drawing that stale word is
  // the amber flash on every normal completion; the ending this process watched is the newer fact.
  const finished = options.finished
  if (finished !== undefined && finished.at >= session.updatedAt) {
    // A mark written after the ending — an open, a click, or the ending itself when the reader
    // watched it — spends the mark whatever the ending was: a stop or a failure the reader has
    // already seen is not news, and reopening the conversation has to settle the row (2026-10-21).
    if (finished.seen || options.seenAt >= finished.at) return 'completed'
    switch (finished.outcome) {
      case 'failed':
        return 'error'
      case 'aborted':
        return 'cancelled'
      default:
        return 'unread'
    }
  }
  if (options.read) return 'completed'
  switch (session.status) {
    case 'complete':
      return 'unread'
    case 'interrupted':
    case 'aborted':
      return 'cancelled'
    case 'pending':
      return 'pending'
    case 'error':
      return 'error'
    default:
      // `unknown` is a status this build cannot read; neither mark would be true, so the row
      // carries the time alone.
      return undefined
  }
}

export interface SidebarTreeFacts {
  sessions: Record<number, WorkspaceSessions>
  /** When each conversation's current status was last seen (host clock), keyed by session id. */
  readMarks: Record<string, number>
  /**
   * Every conversation whose turn is in flight in this process, whoever is on screen.
   *
   * The mark follows the turn, not the tab: a turn keeps running after the reader moves to
   * another conversation, and a row that only knew about the active one fell back to its cold
   * status there (a time, or the amber "stopped" arc) while the agent was still answering
   * (2026-10-20, user report). Work that outlives the answer — a background job, a detached batch, a
   * cancelable child — is not a turn and does not belong in this set: `runningSessionsKey` in
   * `state/work-readings.ts` is where that line is drawn.
   */
  runningSessionIds: ReadonlySet<string>
  /** The last ending each held conversation watched, for rows whose list has not caught up. */
  finishedTurns: ReadonlyMap<string, FinishedTurn>
  /** How a conversation's recency reads on the row, e.g. `36分`. */
  timeLabel: (updatedAt: number) => string
  /** What a conversation the engine has not named yet reads as. */
  untitledLabel: string
  /**
   * One workspace's conversations in the order the reader dragged them into, each with the time
   * its row carried when it was placed.
   *
   * Empty for a workspace that was never rearranged. The arrangement is a preference, not a fact
   * about a conversation: a row it does not name — or one written after it was placed — sorts by
   * recency above the arranged rows (`openSessionsOf`).
   */
  sessionOrder: (workspaceId: number) => readonly SessionOrderEntry[]
  /**
   * How many of a workspace's conversations to put under it.
   *
   * The rail pages them, so the count grows as the reader asks for more; everything past it waits
   * behind the control the caller draws for that workspace.
   */
  visibleCount: (workspaceId: number) => number
  /**
   * Whether conversations the reader put away are drawn too.
   *
   * Off by default: an archived conversation left the list on purpose, and drawing it anyway would
   * make the archive a decoration rather than a place. The rail's own control turns them on, and
   * the rows then read as the last ones of their workspace.
   */
  showArchived: boolean
}

/**
 * One workspace's conversations as the rail lists them, before the page's cut.
 *
 * Pinned rows first, then two zones. A row still standing where the reader placed it keeps that
 * place; a row written since it was placed — or one the arrangement never named, which is a
 * conversation started after it was written — sorts by recency *above* the arranged rows. Activity
 * is never frozen out of the list: a conversation that receives a turn returns to the top, and the
 * arrangement holds only for the rows nobody has written in since.
 *
 * Archived rows are not part of it: the rail draws them after the open list, by recency, and the
 * arrangement is about the rows that are in the list.
 */
export function openSessionsOf(
  items: readonly SessionSummary[],
  order: readonly SessionOrderEntry[],
): SessionSummary[] {
  const placed = new Map<string, { rank: number; at: number }>()
  order.forEach((entry, rank) => placed.set(entry.id, { rank, at: entry.at }))
  /** The arrangement's rank, or null when the row has been written since it was placed. */
  const rankOf = (session: SessionSummary): number | null => {
    const entry = placed.get(session.id)
    return entry !== undefined && session.updatedAt <= entry.at ? entry.rank : null
  }
  return items
    .filter((session) => isListedSession(session) && !session.archived)
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
      const leftRank = rankOf(left)
      const rightRank = rankOf(right)
      if (leftRank !== null && rightRank !== null) return leftRank - rightRank
      if (leftRank !== null) return 1
      if (rightRank !== null) return -1
      return right.updatedAt - left.updatedAt
    })
}

/**
 * The list with `item` placed beside `target`, or `null` when the target is not in it.
 *
 * The rail's lists are one level deep, so this is the whole placement rule: a row lands before or
 * after the row it was dropped on, and the row that moved leaves the place it had. A null target
 * appends, which is the tree's own top-level strip.
 */
export function movedList<T>(
  list: readonly T[],
  item: T,
  target: T | null,
  after: boolean,
): T[] | null {
  const rest = list.filter((entry) => entry !== item)
  if (target === null) return [...rest, item]
  const at = rest.indexOf(target)
  if (at === -1) return null
  const cut = after ? at + 1 : at
  return [...rest.slice(0, cut), item, ...rest.slice(cut)]
}

/**
 * One workspace's conversation rows, in the order the rail draws them.
 *
 * The open rows come from `openSessionsOf` (pins, then the arrangement, then recency). Archived
 * rows come last and only when the caller asks for them, which is why they never enter the pinned
 * comparison - a row the reader put away is not competing for the top of the list.
 */
function sessionsOf(workspaceId: number, facts: SidebarTreeFacts): SidebarResource[] {
  // The blank conversation a workspace is on is not one of its rows: it has no message, and the
  // rail is a list of conversations the reader has had (`state/session-rows.ts::isListedSession`).
  const items = (facts.sessions[workspaceId]?.items ?? []).filter(isListedSession)
  const open = openSessionsOf(items, facts.sessionOrder(workspaceId))
  const archived = facts.showArchived
    ? items
        .filter((session) => session.archived)
        .sort((left, right) => right.updatedAt - left.updatedAt)
    : []
  // Paged separately: the archived rows are what the reader just asked to see, so a page already
  // filled by open conversations must not hide them behind *Show more*. Each list grows with the
  // same count, which is also what keeps either from drawing more than one page's worth.
  const page = Math.max(0, facts.visibleCount(workspaceId))
  return [...open.slice(0, page), ...archived.slice(0, page)]
    .map((session) => ({
      id: sessionNodeId(workspaceId, session.id),
      // A conversation the engine has not named yet still needs something to be called: an empty
      // row is a row the reader cannot pick out.
      label: session.title.trim() || facts.untitledLabel,
      kind: 'file',
      status: sessionStatus(session, {
        working: facts.runningSessionIds.has(session.id),
        // Seen means seen *this* ending, not "a completed status was seen once": a second completed
        // turn has the same word as the first, so the comparison is the time the row was last
        // looked at against the file's own latest write (2026-10-21, user report).
        read: (facts.readMarks[session.id] ?? 0) >= session.updatedAt,
        seenAt: facts.readMarks[session.id] ?? 0,
        finished: facts.finishedTurns.get(session.id),
      }),
      lastActive: session.updatedAt > 0 ? facts.timeLabel(session.updatedAt) : '',
      // An archived row is drawn after the open ones by recency, and the arrangement is the open
      // list's: it must not be dragged, nor displaced by a drag among the rows that are in it.
      sortable: !session.archived,
    }))
}

export function buildSidebarTree(
  workspaces: Array<{ id: number; name: string }>,
  facts: SidebarTreeFacts,
): SidebarResource[] {
  return workspaces.map((workspace) => ({
    id: workspaceNodeId(workspace.id),
    label: workspace.name,
    kind: 'project',
    children: sessionsOf(workspace.id, facts),
  }))
}

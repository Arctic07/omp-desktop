/**
 * What the rail's conversation search reads: every workspace's list, flattened and filtered.
 *
 * The list a workspace carries (`state/session-lists.ts`) is the index of what is on disk, which is
 * also what the rail draws, so searching it searches exactly what the reader can see — no second
 * read, no separate index, and a conversation that has appeared in the rail is findable at once.
 * Archived conversations are left out for the same reason the rail hides their rows: they were put
 * away on purpose, and the switch above the tree is where they come back. A conversation nothing has
 * been said in is left out too — it has no row in the rail (`state/session-rows.ts`).
 *
 * Types only are imported, and with their extensions, because this module is also read by the test
 * runner, which resolves neither the alias nor a bare relative path.
 */

import type { WorkspaceSummary } from "../api/types.ts";
import type { WorkspaceSessions } from "../state/session-lists.ts";
import { isListedSession } from "../state/session-rows.ts";

/** One conversation the search would open. */
export interface ConversationMatch {
  workspaceId: number;
  sessionId: string;
  /** The row's own title; empty when the engine has not named the conversation yet. */
  title: string;
  /** Host time (ms), newest first. */
  updatedAt: number;
}

/**
 * The conversations that answer `query`, newest first, at most `limit` of them.
 *
 * An empty query is every conversation this rail is drawing, which is what opening the search
 * shows before a key is pressed: the recent ones, ready to be picked. A query is matched against
 * the title alone, because the title is the whole of what a result row shows — a row found by a
 * word it does not display would read as a mismatch.
 */
export function searchConversations(
  workspaces: readonly WorkspaceSummary[],
  sessions: Readonly<Record<number, WorkspaceSessions>>,
  query: string,
  limit: number,
): ConversationMatch[] {
  if (limit <= 0) return [];
  const needle = query.trim().toLowerCase();
  const matches: ConversationMatch[] = [];
  for (const workspace of workspaces) {
    const list = sessions[workspace.id];
    if (list === undefined) continue;
    for (const session of list.items) {
      // The rows the rail draws: a conversation nothing has been said in has no row and no title
      // of its own, so searching it would offer a result that cannot be read.
      if (!isListedSession(session) || session.archived) continue;
      if (needle !== "" && !session.title.toLowerCase().includes(needle)) continue;
      matches.push({
        workspaceId: workspace.id,
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
      });
    }
  }
  matches.sort((left, right) => right.updatedAt - left.updatedAt);
  return matches.slice(0, limit);
}

/* ------------------------------------------------------------ message contents */

/**
 * The characters the desktop wraps a match in (`services::session_index::projection::search`).
 *
 * Control characters, so they cannot occur in a transcript: a snippet carrying them is unambiguous,
 * and nothing here has to escape anything to draw it.
 */
export const SEARCH_MARK_START = "\u0001";
export const SEARCH_MARK_END = "\u0002";

/** One run of snippet text, and whether it is part of the match. */
export interface SnippetSegment {
  text: string;
  match: boolean;
}

/**
 * A snippet split into what matched and what did not.
 *
 * The desktop marks the matched span rather than returning ranges, because a range measured in the
 * engine's text would have to survive every transformation between there and here. Splitting on the
 * markers is exact: an unterminated run - a snippet whose tail was cut - is still drawn as text, so
 * a malformed answer shows what it has instead of swallowing the row.
 */
export function snippetSegments(text: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let rest = text;
  while (rest.length > 0) {
    const start = rest.indexOf(SEARCH_MARK_START);
    const end = start === -1 ? -1 : rest.indexOf(SEARCH_MARK_END, start + 1);
    if (start === -1 || end === -1) {
      segments.push({ text: rest.split(SEARCH_MARK_START).join(""), match: false });
      break;
    }
    if (start > 0) segments.push({ text: rest.slice(0, start), match: false });
    segments.push({ text: rest.slice(start + 1, end), match: true });
    rest = rest.slice(end + 1);
  }
  return segments;
}

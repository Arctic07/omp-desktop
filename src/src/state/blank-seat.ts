/**
 * Which conversation "new conversation" opens in a workspace.
 *
 * A conversation nothing has been sent in is not a conversation the rail can offer back: the desktop
 * hands a blank one over with a fresh session id every time it is opened, so an id remembered from an
 * earlier visit names nothing. What the reader *did* in that blank one — the work column they opened,
 * the shell they started — is real, though, and it must not be thrown away by asking for a new
 * conversation again. The rule below is what keeps the two facts apart:
 *
 * - the workspace's blank conversation is opened again when this page still holds it (it is unwritten:
 *   the engine reports nothing in it and nothing was appended here);
 * - the conversation that is already on screen is still refused when it has been written in — asking
 *   for a new one then means a genuinely new one;
 * - a blank conversation **carrying a mode** is not the empty seat a new conversation asks for
 *   (2026-10-26, user report: a new conversation came back in plan mode). A mode is a decision about
 *   how to work, which belongs to a conversation with work in it; a blank one that holds nothing of
 *   the reader's is left behind and the release path hands it back. The exception is the reader's own
 *   column work — a shell in that blank wins, because abandoning it would orphan the pty;
 * - a conversation from another workspace is never reused, however blank it looks.
 *
 * Read from the records on hand rather than from the rail's list: a blank conversation has no row the
 * reader looks for (the rail hides it), so the list cannot answer this.
 */

/** The fields of a record this rule reads. */
export interface BlankCandidate {
  id: string
  workspaceId: number
  engineEmpty: boolean
  messages: readonly unknown[]
  /** What the engine says the conversation is in; a mode that is off is absent. */
  runtime?: { modes?: object | null } | null
}

/**
 * A conversation nothing has been sent in yet — the same reading as `state/transcript.ts::isUnwritten`
 * (not imported: this module is covered by a Node test, which resolves relative imports only).
 */
function unwritten(candidate: BlankCandidate): boolean {
  return candidate.engineEmpty && candidate.messages.length === 0
}

/** Whether the engine has this conversation in a mode (plan, goal, vibe, loop). */
function inMode(candidate: BlankCandidate): boolean {
  const modes = candidate.runtime?.modes
  return modes !== undefined && modes !== null && Object.keys(modes).length > 0
}

/**
 * The conversation to open for a workspace's "new conversation", or null when one has to be created.
 *
 * `remembered` is the conversation this workspace's last "new conversation" opened; it wins over the
 * one on screen so a switch that opened some other blank row on the way does not take "new" with it.
 * `holdsWork` answers whether a conversation has anything of the reader's own in it — the work
 * column's tabs and shells — which is the one fact a blank conversation in a mode may still be reused
 * for.
 */
export function blankSeatToOpen(
  workspaceId: number,
  records: Readonly<Record<string, BlankCandidate>>,
  remembered: string | undefined,
  activeId: string | null,
  holdsWork: (sessionId: string) => boolean,
): string | null {
  for (const id of [remembered, activeId]) {
    if (id === undefined || id === null) continue
    const candidate = records[id]
    if (candidate === undefined || candidate.workspaceId !== workspaceId) continue
    if (!unwritten(candidate)) continue
    if (inMode(candidate) && !holdsWork(candidate.id)) continue
    return candidate.id
  }
  return null
}

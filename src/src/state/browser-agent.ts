/**
 * Whether the agent holds a conversation's browser page, and what its call said it was doing there.
 *
 * The turn is the unit: the first `Browser`/`BrowserPreview` row of the turn in flight holds the
 * page until `turn_finished` clears the record's own `turnId`. Both readings are pure functions of
 * one conversation's rows, so the panel hands them to `useStoreSelector` and gets a boolean or a
 * string the record already holds — never a fresh object (`state/store.ts`).
 *
 * This is the chrome's reading, not the desktop's. The page keeps running and stays on screen
 * either way; what the hold changes is that the toolbar goes inert — a navigation from there would
 * replace the document the agent is working in — and the panel's status band names the call.
 */

import type { ChatMessage } from '@/api/session-types'

/** The slice of a conversation the hold is read from. */
export interface BrowserHoldInput {
  /** The turn in flight, as framed here; null when nothing is running. */
  turnId: string | null
  /** When that turn began, as the host stamped it; null for one this screen attached to mid-turn. */
  turnStartedAt: number | null
  messages: ChatMessage[]
}

/** The tool calls whose row means the agent has taken the page. */
const BROWSER_TOOLS: Readonly<Record<string, true>> = { Browser: true, BrowserPreview: true }

/**
 * The first row of the turn in flight that took the page, or -1.
 *
 * The scan runs backwards from the newest row and stops at the turn's own edge: the host's stamp of
 * when the turn began, when this record saw it — a turn the engine started itself (a queued
 * follow-up, a goal continuation) has no user row of its own — otherwise the last user row, which is
 * the prompt that turn answers. A conversation attached mid-turn saw no `turn_started`, and its
 * replayed rows carry their own stamps, so its row edge is the only boundary there.
 */
function holdIndex(record: BrowserHoldInput | undefined): number {
  if (record === undefined || record.turnId === null) return -1
  const started = record.turnStartedAt
  const rows = record.messages
  let found = -1
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (started !== null) {
      if (row.at < started) break
    } else if (row.kind === 'user') {
      break
    }
    if (row.kind === 'tool' && BROWSER_TOOLS[row.name] === true) found = index
  }
  return found
}

/** Whether the agent holds this conversation's page for the turn in flight. */
export function agentDrivesBrowser(record: BrowserHoldInput | undefined): boolean {
  return holdIndex(record) >= 0
}

/**
 * What the hold's own call said it was doing, or null when it named nothing.
 *
 * The first call of the turn names the whole hold: the band does not re-label itself as later calls
 * arrive, so the line stays readable while the agent works through the page.
 */
export function agentBrowserIntent(record: BrowserHoldInput | undefined): string | null {
  if (record === undefined) return null
  const index = holdIndex(record)
  if (index < 0) return null
  const row = record.messages[index]
  return row.kind === 'tool' ? row.intent : null
}

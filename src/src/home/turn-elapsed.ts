// Relative, with its extension: this module is read by the test runner as well as by the bundler,
// and the runner has no alias to resolve.
import type { TranscriptRow } from './conversation-rows.ts'

/**
 * The clock the turn in flight is counted from.
 *
 * Two readings, and the host's is the true one: `turn_started` carries the stamp the side that ran
 * the turn put on it, so it is the same number whatever the reader does to the screen — which a row
 * counting from its own mount cannot be. The fallback is the prompt the turn is answering: a
 * conversation this process attached to mid-turn never saw that frame, and every other surface
 * measures a turn from its prompt too (`buildRows`' `openedAt` is that same message's own `at`).
 * Neither source means nothing here knows when the turn began, which is not the same fact as "it
 * began at zero" — the row falls back to counting from the moment it was drawn.
 */
export function startOfTurn(rows: TranscriptRow[], hostStartedAt: number | null): number | null {
  if (hostStartedAt !== null) return hostStartedAt
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.kind === 'single' && row.message.kind === 'user') {
      return row.message.at > 0 ? row.message.at : null
    }
  }
  return null
}

/**
 * How long a turn has been running, in seconds — or null when nothing says when it began.
 *
 * A stamp from ahead of this clock (the two are not the same clock: the host stamps in its own
 * process) reads as a turn that has just begun rather than as a negative age.
 */
export function turnElapsedSeconds(startedAt: number | null, now: number): number | null {
  if (startedAt === null) return null
  return Math.max(0, (now - startedAt) / 1000)
}

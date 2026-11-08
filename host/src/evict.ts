/**
 * Eviction policy (contract §4).
 *
 * Pure ordering rules: which sessions are eligible, and which one goes when the soft cap is
 * exceeded. The registry owns the act of eviction; this module owns the decision, so the rules
 * can be read - and exercised - without an engine.
 */

import { IDLE_EVICT_MS, MAX_LIVE_SESSIONS } from './constants.ts'

/** What the policy needs to know about one live session. */
export interface EvictionCandidate {
  readonly sessionId: string
  /**
   * Whether the session still has work to finish - its own busy fact, not its turn bit.
   *
   * The two are not the same: a detached `task` batch leaves the turn idle while its children keep
   * working, so a policy that dropped a "not streaming" session would take the event pipe down
   * under work the user asked for. `sessions.ts#isWorking` is the one place that decides this
   * (turn, pending background work, live children).
   */
  readonly working: boolean
  readonly queuedMessages: number
  readonly lastActivityMs: number
}

/** A session may only be dropped when it is not working, holds no queue and has been quiet long enough. */
export function evictable(candidate: EvictionCandidate, now: number): boolean {
  return !candidate.working && candidate.queuedMessages === 0 && now - candidate.lastActivityMs > IDLE_EVICT_MS
}

/**
 * Sessions to drop right now, oldest activity first.
 *
 * Two independent rules apply. Every session idle past the TTL is dropped. Independently, the
 * soft cap holds: while more sessions are live than {@link MAX_LIVE_SESSIONS}, the oldest quiet
 * sessions - not working and holding no queue, even if just looked at - are dropped until the
 * count is back at the cap.
 */
export function selectEvictions(candidates: readonly EvictionCandidate[], now: number): string[] {
  const chosen = new Set(candidates.filter(candidate => evictable(candidate, now)).map(candidate => candidate.sessionId))
  const quiet = candidates
    .filter(candidate => !candidate.working && candidate.queuedMessages === 0)
    .sort((left, right) => left.lastActivityMs - right.lastActivityMs)
  let remaining = candidates.length - chosen.size
  for (const candidate of quiet) {
    if (remaining <= MAX_LIVE_SESSIONS) break
    if (chosen.has(candidate.sessionId)) continue
    chosen.add(candidate.sessionId)
    remaining -= 1
  }
  return [...chosen]
}

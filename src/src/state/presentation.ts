/**
 * The one presentation tick every streamed surface shares.
 *
 * A conversation's frames and a subagent transcript's frames both arrive far faster than anything
 * is drawn: a turn publishes text, tool updates and roster edges, and several conversations can be
 * streaming at once. Each queue folds its own frames and asks for **one** tick, so the whole app
 * renders once per display frame however many streams are arriving — and once per quarter second
 * when the reader cannot see the window at all.
 *
 * The cadence is the point:
 *
 * - **visible and focused** → `requestAnimationFrame`, the display's own clock;
 * - **anything else** → a timer, because a hidden or occluded window has its `requestAnimationFrame`
 *   throttled by Chromium (the same treatment a background tab gets), and a queue waiting on a
 *   frame that will not come is a screen that stops updating until the reader returns;
 * - **on focus / visibility change** → `flushPresent`, so returning to the window never shows a
 *   quarter-second-old answer.
 *
 * A window that is visible but not focused (another application in front, or a game on another
 * monitor) is treated as unseen: the reader is not looking at it, and rendering it at the display
 * cadence is CPU spent on nobody.
 *
 * **Covered** is the same fact one layer in: the window is in front and focused, and an opaque page
 * — the settings overlay — is drawn over the conversation. Nothing of the conversation is on screen,
 * so it falls back to the hidden cadence and the reveal snaps its text (measured 2026-11-01: with a
 * turn streaming into the covered transcript, the skills page's scroll had a 14.0 ms p90 and 16 of
 * 220 frames over 20 ms, against 7.1 ms and 4 once covered;
 * `notes/implemented/bug-fix/2026-11-01-covered-conversation-stops-presenting.md`).
 */

/** How long a window the reader cannot see waits before folding what arrived. */
const HIDDEN_FLUSH_MS = 250

/** The queues registered here, each folding its own pending frames into one write. */
const flushers = new Set<() => void>()

/** How the scheduled tick is cancelled, when one is scheduled. */
let cancel: (() => void) | null = null

/**
 * Whether the reader can actually see this window.
 *
 * A window that is visible but not focused is one the reader is looking past: its frames are folded
 * on the hidden cadence, and the bridge is told the same thing (`session_watch`), so a game in the
 * foreground does not pay for a conversation drawn behind it.
 */
export function isViewing(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden' && document.hasFocus()
}

/**
 * Whether an opaque surface covers everything this window draws.
 *
 * Set by the shell while the settings page is up (`setConversationCovered`), never by a screen of
 * its own: the conversation underneath stays mounted, and it is the shell that knows it is hidden.
 */
let covered = false

/** Whether what this window draws is currently behind an opaque page. */
export function isPresentCovered(): boolean {
  return covered
}

/**
 * Mark what this window draws as covered or uncovered.
 *
 * The reader is not looking at the conversation while something opaque is over it, so it is
 * presented on the hidden cadence. The pending tick is re-aimed rather than dropped: uncovering
 * schedules one at the display cadence, and `flushPresent` is the caller's way to fold the backlog
 * in the same frame the cover came off.
 */
export function setPresentCovered(next: boolean): void {
  if (covered === next) return
  covered = next
  reschedulePresent()
}

/** Register one queue's flush. Module lifetimes, so the returned unregister is only for tests. */
export function onPresent(flush: () => void): () => void {
  flushers.add(flush)
  return () => {
    flushers.delete(flush)
  }
}

/** Schedule one tick, at the cadence the window is being seen at. */
export function schedulePresent(): void {
  if (cancel !== null) return
  // Nothing of this is on screen when the window is not being watched, and not when an opaque page
  // covers it (`setPresentCovered`): both fold what arrives on the hidden cadence.
  const seen = !covered && isViewing()
  if (seen && typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(() => {
      cancel = null
      flushPresent()
    })
    cancel = () => cancelAnimationFrame(handle)
    return
  }
  const handle = setTimeout(
    () => {
      cancel = null
      flushPresent()
    },
    seen ? 0 : HIDDEN_FLUSH_MS,
  )
  cancel = () => clearTimeout(handle)
}

/** Apply every queued frame now. Called on focus, visibility changes and before a walk takes hold. */
export function flushPresent(): void {
  if (cancel !== null) {
    cancel()
    cancel = null
  }
  for (const flush of flushers) flush()
}

/** Re-aim the scheduled tick after the window's visibility changed (a hidden rAF never fires). */
export function reschedulePresent(): void {
  if (cancel !== null) {
    cancel()
    cancel = null
  }
  schedulePresent()
}

/**
 * How much of a still-arriving answer to draw on one frame.
 *
 * The transport delivers text in whatever units the provider produces — a token every few
 * milliseconds from one model, a whole sentence at a time from another, and occasionally a paragraph
 * that was held back. Drawing each delivery whole is the "block at a time" stutter the reader sees;
 * drawing it at a fixed rate is a second kind of stutter, because the answer then falls further
 * behind the faster it is written.
 *
 * So the rate is read from the backlog: a quiet stream advances at `RATE_FLOOR`, an arrival that has
 * to be caught up advances in proportion to how far behind it is (`CATCH_UP_S`), and only a backlog
 * past `RATE_CEILING` is drawn faster than anyone can read it. The step is integrated over the
 * frame's real elapsed time and the remainder is carried to the next frame, so the pace holds on a
 * 60 Hz display, a 144 Hz one, and across a dropped frame — the text never moves two characters in
 * one commit and none in the next.
 *
 * Pure, so the pacing is a number a test can read rather than an animation nobody can measure.
 */
export interface RevealPacing {
  /** Characters drawn so far. */
  shown: number
  /** Characters owed to the reader but not yet drawn, as a fraction of one. */
  carry: number
}

/** Characters per second a quiet stream is revealed at: about one every other frame at 60 Hz. */
export const RATE_FLOOR = 45;
/** How long a backlog is meant to take to draw, once it is too big for the floor. */
export const CATCH_UP_S = 0.6;
/** Past this rate the backlog is a burst being caught up, not text being read. */
export const RATE_CEILING = 900;
/** A frame this far after the previous one means nothing was being drawn in between. */
export const SUSPENDED_FRAME_MS = 200;

export function paceReveal(
  target: number,
  pacing: RevealPacing,
  elapsedMs: number,
): RevealPacing {
  const pending = target - pacing.shown;
  if (pending <= 0) return { shown: pacing.shown, carry: 0 };
  const rate = Math.min(RATE_CEILING, Math.max(RATE_FLOOR, pending / CATCH_UP_S));
  const elapsed = Math.min(SUSPENDED_FRAME_MS, Math.max(0, elapsedMs));
  const owed = pacing.carry + (rate * elapsed) / 1000;
  const whole = Math.floor(owed);
  if (whole < 1) return { shown: pacing.shown, carry: owed };
  const advance = Math.min(whole, pending);
  return {
    shown: pacing.shown + advance,
    // A step cut short by the end of the text has nothing left to carry: the next arrival reads the
    // backlog itself, and a stale fraction would spend it on the next word.
    carry: advance < whole ? 0 : owed - whole,
  };
}

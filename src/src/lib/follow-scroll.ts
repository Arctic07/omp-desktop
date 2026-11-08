/**
 * Gliding a transcript to a floor it is not already at — the rail's jumps, not the follow.
 *
 * Growth is *not* this module's business any more (2026-10-25). A row that grows under a following
 * reader is pinned by the scroller's resize observer in the frame it grew, which is after layout and
 * before paint — the reader sees the foot hold still while the rows above it move. Gliding that
 * instead (the previous behaviour) left the foot a line low for a frame and then walked it back a
 * pixel per frame, which is the bounce readers reported as 思考内容会挤压运行中到下方…如此循环.
 *
 * What is left is a jump the reader asked for — a mark in the rail, a transcript's foot from far
 * away — where the distance is tens or hundreds of pixels and an instant write reads as a lurch.
 * The native `scrollTo({ behavior: "smooth" })` would be the obvious answer, but a jump re-issued
 * while one is running restarts the animation and lurches; this one reads its target on every frame
 * (a newer ask retargets it without restarting anything), advances by a fraction of the remaining
 * distance capped per frame, and stops within half a pixel.
 *
 * The state lives per element (a `WeakMap`), because a transcript is one scrollport per mounted
 * conversation and nothing here may outlive it.
 */

/** Time constant of the approach: a line that just wrapped is in place in about a tenth of a second. */
const FOLLOW_TAU_MS = 140;
/** Ceiling on one frame's advance, so a jump across a whole transcript stays an even glide. */
const FOLLOW_MAX_STEP_PX = 120;
/** Close enough to the floor to call it taken. */
export const FOLLOW_SETTLED_PX = 0.5;

/** How many pixels the follow moves this frame, for a gap this large. */
export function followAdvance(gap: number, elapsedMs: number): number {
  if (gap <= FOLLOW_SETTLED_PX) return 0;
  const elapsed = Math.min(64, Math.max(1, elapsedMs));
  const approach = gap * (1 - Math.exp(-elapsed / FOLLOW_TAU_MS));
  return Math.min(gap, Math.max(1, Math.min(FOLLOW_MAX_STEP_PX, approach)));
}

interface Glide {
  frame: number;
  last: number;
}

const glides = new WeakMap<HTMLElement, Glide>();

/** Stop following this scrollport, leaving it exactly where it is. */
export function stopFollowing(viewport: HTMLElement | null): void {
  if (viewport === null) return;
  const glide = glides.get(viewport);
  if (glide === undefined) return;
  cancelAnimationFrame(glide.frame);
  glides.delete(viewport);
}

/**
 * Follow `viewport`'s floor: to its end now (`instant`), or there in a glide that keeps reading the
 * floor as the content grows.
 *
 * A glide already running is left alone — it reads the floor itself, so a second ask while the
 * answer is still arriving is already answered.
 */
export function followFloor(
  viewport: HTMLElement,
  options: { instant?: boolean } = {},
): void {
  if (options.instant === true) {
    stopFollowing(viewport);
    viewport.scrollTop = viewport.scrollHeight;
    return;
  }
  if (glides.has(viewport)) return;
  const glide: Glide = { frame: 0, last: 0 };
  const step = (now: number) => {
    const gap =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (gap <= FOLLOW_SETTLED_PX) {
      glides.delete(viewport);
      return;
    }
    const elapsed = glide.last === 0 ? 1000 / 60 : now - glide.last;
    glide.last = now;
    viewport.scrollTop = viewport.scrollTop + followAdvance(gap, elapsed);
    glide.frame = requestAnimationFrame(step);
  };
  glides.set(viewport, glide);
  glide.frame = requestAnimationFrame(step);
}

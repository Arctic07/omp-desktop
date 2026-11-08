/**
 * Putting a reader back on the row they left, over the frames a fresh window needs to measure it.
 *
 * Split out of `ConversationFeed.tsx` so neither file outgrows the project's file-length limit
 * (`rules.md#single-file-line-limit`), the way `feed-placement.ts` was. The feed owns when a landing
 * starts and when it ends; this file owns the frames in between, and nothing here touches React.
 */

/**
 * Frames a landing may spend putting the reader's line back. A fresh window measures the rows it
 * draws as it draws them, and every measurement above the line moves it, so the chances are spent
 * across the frames that window needs rather than on the first one.
 */
const FEED_LANDING_FRAMES = 24;
/** How far the landed line may sit from the recorded one and still count as landed. */
const FEED_LANDING_SLACK_PX = 1;
/** The reader's own input, which ends a landing the moment it arrives. */
const FEED_READER_EVENTS = ["wheel", "pointerdown", "touchstart", "keydown"] as const;

export interface LandingOptions {
  viewport: HTMLElement
  rowElement: (id: string) => HTMLElement | null
  anchorId: string | null
  index: number
  anchorTop: number
  aim: (index: number) => void
  /** The landing is over — whether it settled or the reader ended it. */
  onRelease?: () => void
}

/**
 * Put the reader back on the row they left, over the frames a fresh window needs to measure it.
 *
 * The correction a row's box asks for — its present distance from the scrollport's top edge, minus
 * the distance the record holds — is a complete answer on its own: where the scrollport happens to
 * sit when it is read makes no difference to a quantity that moves with it. So the aim is a starting
 * point rather than a target, and it is corrected only while there is a box to correct against.
 *
 * The loop is bounded, and the reader's own input ends it early: a window that has settled is a
 * window that has nothing left to put back, and a reader who has started scrolling has said where
 * they want to be. Returns the release, so the caller can end it on unmount.
 */
export function landReader({ viewport, rowElement, anchorId, index, anchorTop, aim, onRelease }: LandingOptions): () => void {
  if (anchorId === null || index < 0) return () => undefined;
  aim(index);
  let frames = FEED_LANDING_FRAMES;
  let frame = 0;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    for (const type of FEED_READER_EVENTS) {
      viewport.removeEventListener(type, release, { capture: true });
    }
    onRelease?.();
  };
  const land = () => {
    frame = 0;
    if (released) return;
    if (frames <= 0) {
      release();
      return;
    }
    frames -= 1;
    const target = rowElement(anchorId);
    if (target !== null) {
      const delta = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) > FEED_LANDING_SLACK_PX) viewport.scrollTop += delta;
    }
    frame = requestAnimationFrame(land);
  };
  for (const type of FEED_READER_EVENTS) {
    viewport.addEventListener(type, release, { capture: true, passive: true });
  }
  frame = requestAnimationFrame(land);
  return release;
}

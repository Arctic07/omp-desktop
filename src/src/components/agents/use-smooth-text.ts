import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { SUSPENDED_FRAME_MS, paceReveal } from "@/lib/reveal-pacing";
import { isPresentCovered } from "@/state/presentation";

/**
 * The answer as the reader sees it while the engine is still writing it.
 *
 * The transport already coalesces deltas into one frame per display window
 * (`services/runtime/mod.rs::DELTA_FLUSH_MS`), but what that frame carries is whatever arrived in
 * the window: a fast model puts several tokens in it, and a slow one may pause and then deliver a
 * whole sentence. Drawing the frame whole is what reads as a jump followed by a burst of
 * characters; `lib/reveal-pacing` is the pace that turns those arrivals into writing.
 *
 * Two moments skip the animation entirely, because there is nothing to animate:
 *
 * - the reader cannot see the window (hidden, or the frame loop was suspended long enough that the
 *   backlog is text nobody watched arrive) — the answer is drawn as it stands;
 * - `streaming` turns false. A settled answer is handed over whole on that frame, so the last words
 *   cannot be left half-drawn behind a footer that already appeared.
 *
 * The reveal is not a second source of truth: the transcript, the rail's previews and everything
 * copied still read the complete text. Only the painted Markdown — and this conversation's
 * reasoning — goes through here.
 */
export function useSmoothText(text: string, streaming: boolean): string {
  const reduce = useReducedMotion() ?? false;
  const [shown, setShown] = useState(text);
  const shownRef = useRef(text);
  const frameRef = useRef<number | undefined>(undefined);
  const lastFrameRef = useRef(0);
  const carryRef = useRef(0);

  useEffect(() => {
    const snap = () => {
      carryRef.current = 0;
      lastFrameRef.current = 0;
      if (shownRef.current !== text) {
        shownRef.current = text;
        setShown(text);
      }
    };
    // An opaque page over this row is the same fact as a hidden window: the reader is not watching
    // the text arrive, so it is drawn as it stands rather than revealed frame by frame into a tree
    // nobody is painting (`state/presentation.ts::setPresentCovered`).
    if (!streaming || reduce || isPresentCovered() || document.visibilityState === "hidden") {
      snap();
      return;
    }
    // A row that was rewritten (a merge, a switch back) is not an incremental stream: revealing it
    // from the old text would be a backwards animation.
    if (!text.startsWith(shownRef.current)) {
      snap();
      return;
    }
    if (shownRef.current.length >= text.length) return;

    const step = (now: number) => {
      const last = lastFrameRef.current;
      lastFrameRef.current = now;
      // The window stopped being drawn (it was hidden, or the frame loop was suspended): what
      // arrived meanwhile is not motion the reader watched, and animating it on return would show a
      // stale answer crawling up to date. A page drawn over the row is the same case.
      if (
        document.visibilityState === "hidden" ||
        isPresentCovered() ||
        (last !== 0 && now - last > SUSPENDED_FRAME_MS)
      ) {
        snap();
        frameRef.current = undefined;
        return;
      }
      const paced = paceReveal(
        text.length,
        { shown: shownRef.current.length, carry: carryRef.current },
        last === 0 ? 1000 / 60 : now - last,
      );
      carryRef.current = paced.carry;
      if (paced.shown === shownRef.current.length) {
        frameRef.current = requestAnimationFrame(step);
        return;
      }
      const end = safeEnd(text, paced.shown);
      const next = text.slice(0, end);
      shownRef.current = next;
      setShown(next);
      if (end >= text.length) {
        // Caught up, so this chain ends here. The next one starts from a cleared clock: the pause
        // until the model's next chunk is not a suspended frame, and reading it as one would hand
        // that chunk over whole — the very burst this pacing exists to avoid.
        lastFrameRef.current = 0;
        frameRef.current = undefined;
        return;
      }
      frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    };
  }, [reduce, streaming, text]);

  return streaming && !reduce ? shown : text;
}

/**
 * The end of a revealed prefix, moved so the step never lands inside one drawn glyph.
 *
 * Half a surrogate pair paints as the replacement glyph for a frame; a combining mark or a
 * variation selector revealed without its base is the same defect one layer up. Both are one
 * comparison away, so the step simply takes them with it.
 */
function safeEnd(text: string, end: number): number {
  let at = Math.min(Math.max(0, end), text.length);
  while (at > 0 && at < text.length) {
    const head = text.charCodeAt(at - 1);
    const tail = text.charCodeAt(at);
    const surrogatePair =
      head >= 0xd800 && head <= 0xdbff && tail >= 0xdc00 && tail <= 0xdfff;
    const continuation =
      (tail >= 0x0300 && tail <= 0x036f) || tail === 0x200d || tail === 0xfe0f;
    if (!surrogatePair && !continuation) break;
    at += 1;
  }
  return at;
}

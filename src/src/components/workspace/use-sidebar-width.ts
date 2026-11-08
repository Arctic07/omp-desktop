/**
 * The work column's width: the reader's own drag, and the expand switch's whole-inset width.
 *
 * Two widths, one value. The drag is instant and belongs to the pointer; expanding is a move of the
 * column onto the conversation's half of the inset, and it has to be seen as a move — the browser
 * cannot interpolate the thing that carries it by itself:
 *
 * ① **The column's width comes from a CSS variable** (`--sidebar-width`, set on the provider in
 *    `components/workspace/right-sidebar.tsx`). `AnimatedSidebar`'s own motion is no use here: its
 *    target is the same `var(--sidebar-width)` string in both open states, so a change of the
 *    variable's value is not a change of target, and motion sets it in one frame.
 * ② **The variable is registered as a length** (`styles/panel-width.css`), which is what makes it
 *    interpolable at all, and the transition is switched on only while the switch is moving it —
 *    a drag under that transition would trail the pointer by a third of a second.
 * ③ **The inset is measured, not assumed**: `100%` cannot be interpolated with the px value the
 *    variable holds before it.
 *
 * Owner: the sidebar that calls it. Bound: one `width` per column. Released with the component;
 * the pending timer is cleared on unmount because it only exists to end the transition.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

/** The width a dragged column starts at, before anybody has moved it. */
export const DEFAULT_SIDEBAR_WIDTH = 22 * 16 * 1.3;

/** How long the width stays under its transition: a little past `styles/panel-width.css`'s own. */
const WIDTH_ANIMATION_MS = 420;

export interface SidebarWidth {
  /** The column's own box, for the width the inset gives it while expanded. */
  asideRef: React.RefObject<HTMLElement | null>;
  /** The width the column stands at: the reader's drag, or the whole inset when expanded. */
  width: number;
  /** Whether the transition is on, i.e. whether the switch is moving the width right now. */
  animating: boolean;
  /**
   * Whether the width changed because the *conversation* did.
   *
   * The column's open and expanded flags belong to a conversation, so a switch changes this width in
   * the same commit that changes the screen. A switch snaps (the old column must not slide shut
   * across the conversation the reader just picked); the reader's own toggle morphs — and so does the
   * fold of a new conversation, which runs inside the no-active-session window of its open: there the
   * column still belongs to the conversation being left, and the reader is the one who asked for it
   * to go (`home/ChatAppHome.tsx`).
   */
  snap: boolean;
  /** The drag's own setter: the reader moving the edge. */
  setWidth: (width: number) => void;
  /** The expand switch's handler, which puts the transition on while the width moves. */
  toggle: () => void;
}

export function useSidebarWidth(
  sessionId: string | null,
  expanded: boolean,
  onToggleExpanded: () => void,
): SidebarWidth {
  const [draggedWidth, setWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const asideRef = useRef<HTMLElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const reduceMotion = useReducedMotion() ?? false;
  const [animating, setAnimating] = useState(false);
  const timer = useRef<number | null>(null);

  // The conversation this column's width belongs to, as of the last committed render. A mismatch to
  // another *conversation* is the render that switched. A mismatch to no conversation at all is the
  // open's own no-session window, where the column still belongs to the conversation being left and
  // the only width change is the one the reader asked for (a new conversation folds it): that one
  // animates.
  const lastSessionId = useRef(sessionId);
  const snap = lastSessionId.current !== sessionId && sessionId !== null;
  useEffect(() => {
    lastSessionId.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    if (!expanded) return;
    const aside = asideRef.current;
    const stage = aside?.closest<HTMLElement>('[data-slot="sidebar-inset"]') ?? null;
    if (aside === null || stage === null) return;
    // The observer's first report is the measurement: it arrives with the frame that first lays the
    // expanded column out, so the transition starts from the width the reader last saw. Its later
    // reports are the window being resized while expanded.
    const observer = new ResizeObserver(([entry]) =>
      setStageWidth(Math.round(entry.contentRect.width)),
    );
    observer.observe(stage);
    return () => observer.disconnect();
  }, [expanded]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const toggle = useCallback(() => {
    if (!reduceMotion) {
      setAnimating(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setAnimating(false), WIDTH_ANIMATION_MS);
    }
    onToggleExpanded();
  }, [onToggleExpanded, reduceMotion]);

  /**
   * The drag's setter. It ends any transition still running from the switch: a reader who grabs the
   * edge has taken the width back, and a column trailing the pointer by a third of a second reads as
   * a broken drag.
   */
  const drag = useCallback((next: number) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
      setAnimating(false);
    }
    setWidth(next);
  }, []);

  return {
    asideRef,
    // Before the first report there is nothing to expand into but the width the column already has.
    width: expanded && stageWidth > 0 ? stageWidth : draggedWidth,
    animating,
    snap,
    setWidth: drag,
    toggle,
  };
}

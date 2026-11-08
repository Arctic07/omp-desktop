"use client";

import { motion, type HTMLMotionProps, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

export interface AgentDisclosureProps
  extends Omit<HTMLMotionProps<"div">, "animate" | "initial"> {
  open: boolean;
  openHeight?: CSSProperties["height"];
}

/**
 * How long the box takes to fold away, from the height it is folding.
 *
 * The eye tracks the box's edge, not the fraction of the motion, so what has to stay bounded is
 * pixels per frame: a fixed duration puts a tall reasoning block away at two or three times the
 * speed of a short tool result, and the tall one is exactly the box the reader is watching. The
 * floor keeps a shallow box from feeling instant; the ceiling keeps a very long one from stalling
 * the transcript behind it. Within that range the pace is roughly constant — a 30px tool row takes
 * 0.17s, a 900px reasoning block 0.38s — so the fold reads as one speed rather than as a snap that
 * happens to be longer. The whole band was shortened on 2026-10-24 (user report: "思考 工具调用收起
 * 动画速度也太慢了一点"): every box is now ~30% quicker than the 0.22s + height/1800, 0.55s-cap band
 * it replaced, with the sine curve untouched so the faster fold still lands rather than cuts. The
 * cap is what keeps that speed-up from turning a very tall block into a flicker: past ~620px the
 * fold stops getting faster in wall-clock terms.
 */
function closeSeconds(from: number) {
  return Math.min(0.38, 0.16 + from / 2800);
}

/**
 * The fold's curve.
 *
 * A box changing its own height has to rest at both ends — a curve that puts most of the distance in
 * its first frames spends the rest of the fold crawling (measured on `EASE_OUT`: 49% of a 226px box
 * in the first frame, then 100px over the remaining ones; 2026-10-23, user report "收起动画不够流畅
 * 略显卡顿"). What still reads as stiff with an ease-in-out is its peak: `cubic-bezier(0.4, 0, 0.2,
 * 1)` runs at ~2.5× the fold's average speed in the middle, which is a rush out of a slow start. The
 * sine curve peaks at 1.57× — half the acceleration, the same ends at rest — and that flat pace is
 * what a fold reads as smooth.
 */
const CLOSE_EASE = "cubic-bezier(0.37, 0, 0.63, 1)";

/** A fold nobody finishes (a hidden window pauses the animation) must not strand the body. */
const CLOSE_BACKSTOP_MS = 120;

/**
 * Shared reveal for collapsible agent content.
 *
 * A settled closed block draws nothing, so it *holds* nothing: the body is mounted while the block
 * is open and unmounted once it is closed. That matters because a block used to collapse in the
 * same commit as `open` — `height: 0` landed on that commit — while the price was paid in full:
 * every folded tool call tokenized its arguments and its whole result through the syntax
 * highlighter, and a turn with a few dozen calls mounted all of them at once.
 *
 * Folding away is the one stretch that needs the body: a box that dropped to zero height in a frame
 * was a row that flickered out of the transcript instead of collapsing (2026-10-22, user report —
 * "思考 和工具这些输出后自动关闭是没有动画"). So the closing frame keeps what is *already* mounted
 * for the fold the reader watches, then unmounts it. No body is mounted a frame longer than it was
 * before, because a block that closes was mounted open in the frame before.
 *
 * The fold is one `Animation` of the box's own height, from what it measures to zero, rather than a
 * CSS transition fed by a state update. A transition needs the starting length to be *resolved*
 * before the closing length can replace it, which costs a frame in between — measured as two frames
 * of a box that had not moved yet before the first, largest step (2026-10-23). An animation carries
 * both ends and starts in the frame the closing state lands on.
 */
export function AgentDisclosure({
  open,
  openHeight = "auto",
  className,
  style,
  transition,
  children,
  ...props
}: AgentDisclosureProps) {
  const reduce = useReducedMotion() ?? false;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const foldRef = useRef<Animation | null>(null);
  /** The growth back from an interrupted fold, which a closing box takes over from. */
  const growRef = useRef<Animation | null>(null);
  // The body is drawn while the box is open, or while it is folding away.
  const [mounted, setMounted] = useState(open);
  // An open box rests at `openHeight` and a closed one at zero; the fold itself is not a style at
  // all, it is the animation started below.
  const [height, setHeight] = useState<CSSProperties["height"]>(open ? openHeight : 0);
  const closing = mounted && !open;

  useLayoutEffect(() => {
    const box = boxRef.current;

    if (open) {
      // A fold that already settled (its height is 0) opens the way it always did: the height is
      // the state's and the wipe is the reveal. Only a fold still in flight has a starting height
      // of its own to grow back from.
      const fold = foldRef.current;
      if (fold === null) {
        setHeight(openHeight);
        setMounted(true);
        return;
      }
      const from = box === null ? 0 : box.getBoundingClientRect().height;
      // Read before the cancel: taking the animation away is what puts the element back on its
      // style's opacity, and the reopen has to start from the fade the fold had reached.
      const fromOpacity = box === null ? 1 : Number(getComputedStyle(box).opacity);
      fold.cancel();
      foldRef.current = null;
      setHeight(openHeight);
      setMounted(true);
      if (box === null || reduce || from <= 0) return;
      // The box rests at `openHeight` from the update above. A numeric one is already the target;
      // for `auto` the body is mounted, so writing it here answers the natural height without
      // waiting for the re-render (React writes the same value on the commit that follows).
      box.style.height = "auto";
      const to = typeof openHeight === "number" ? openHeight : box.getBoundingClientRect().height;
      if (to <= from) return;
      const grow = box.animate(
        [
          { height: `${from}px`, opacity: fromOpacity },
          { height: `${to}px`, opacity: 1 },
        ],
        { duration: closeSeconds(to - from) * 1000, easing: CLOSE_EASE, fill: "forwards" },
      );
      growRef.current = grow;
      // The box rests at `openHeight` once this lands, so letting the fill go changes no pixels —
      // and a fill left behind would keep winning over the style the state writes. A fold that
      // takes over before then cancels it itself (it reads the height first).
      void grow.finished.then(
        () => {
          if (growRef.current === grow) growRef.current = null;
          grow.cancel();
        },
        () => {},
      );
      return;
    }
    if (!mounted || !box) return;
    // A fold already in flight owns the box until it settles. Starting a second one from here would
    // measure a box this animation is holding (its resting height is already zero), and the fold
    // would end in the frame it restarted in.
    if (foldRef.current) return;
    const from = box.getBoundingClientRect().height;
    // A box being closed in the middle of its own reveal is at whatever opacity the wipe reached,
    // and a box still growing back from an interrupted fold is mid-height: the fold takes over from
    // both, which is why they are read before the growth is taken away.
    const fromOpacity = Number(getComputedStyle(box).opacity);
    growRef.current?.cancel();
    growRef.current = null;
    if (reduce || from === 0) {
      setHeight(0);
      setMounted(false);
      return;
    }
    const seconds = closeSeconds(from);
    const animation = box.animate(
      [
        { height: `${from}px`, opacity: fromOpacity },
        // The box's own edge is what carries the fold, but a shutter that simply cuts the text in
        // half reads as a wipe. Fading it over the same stretch turns the cut into a fold away.
        { height: "0px", opacity: 0 },
      ],
      {
        duration: seconds * 1000,
        easing: CLOSE_EASE,
        // The box's resting height is zero from this same commit, so the fill is what keeps the
        // folded length on screen until the body has been let go of.
        fill: "forwards",
      },
    );
    foldRef.current = animation;
    setHeight(0);

    const settle = () => {
      if (foldRef.current !== animation) return;
      foldRef.current = null;
      // A finished fill keeps *winning* over the box's own style, and `height: 0` would then outlive
      // the fold: the next open sets `height: auto` on an element whose computed height is still the
      // animation's 0, so the block would grow its state and draw nothing (measured 2026-10-23).
      // The box rests at zero either way, so taking the animation away here changes no pixels.
      animation.cancel();
      setMounted(false);
    };
    // The animation's own end is the fold's end; the timer only covers a timeline that stopped (a
    // hidden window pauses animations, and the body must not stay mounted behind a zero-height box).
    const backstop = window.setTimeout(settle, seconds * 1000 + CLOSE_BACKSTOP_MS);
    void animation.finished.then(settle, () => {});
    return () => {
      // A fold still in flight keeps its own backstop: this effect re-runs when `openHeight`
      // changes under a folding box (a measured viewport), and a cleanup that took the timer with
      // it would leave a paused fold's body mounted behind a zero-height box for good. The timer
      // is cheap when the fold is cancelled instead — its `settle` finds a ref that is no longer
      // its own animation and does nothing.
      if (foldRef.current !== animation) window.clearTimeout(backstop);
    };
  }, [mounted, open, openHeight, reduce]);

  return (
    <motion.div
      {...props}
      ref={boxRef}
      aria-hidden={!open}
      inert={!open}
      initial={false}
      animate={
        reduce
          ? { opacity: open ? 1 : 0 }
          : {
              // A folding box is clipped by the height it is giving up, and the fold's own fade is
              // carried by the animation above — this value is only what the box rests at, so a
              // closing box keeps the open frame's opacity and transform while the animation drives
              // them. The wipe belongs to a box that is opening.
              opacity: open || closing ? 1 : 0,
              clipPath: open || closing ? "inset(0 0 0% 0)" : "inset(0 0 100% 0)",
              y: open || closing ? 0 : -4,
            }
      }
      transition={transition ?? { duration: reduce ? 0 : 0.22, ease: EASE_OUT }}
      className={cn("overflow-hidden", className)}
      style={{
        ...style,
        height,
        pointerEvents: open ? undefined : "none",
        transformOrigin: "top",
      }}
    >
      {mounted ? children : null}
    </motion.div>
  );
}

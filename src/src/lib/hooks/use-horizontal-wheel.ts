"use client";

import { type RefObject, useEffect } from "react";

/** The part of a wheel event this rule reads, so the step is testable without a DOM. */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  /** DOM_DELTA_PIXEL = 0, DOM_DELTA_LINE = 1, DOM_DELTA_PAGE = 2. */
  deltaMode: number;
  ctrlKey: boolean;
}

/** One wheel line, the notch every platform's line delta is meant to stand for. */
const LINE_PX = 16;

/**
 * How far a wheel event moves a strip that only scrolls sideways, in pixels.
 *
 * Zero means "leave the event to the browser": a mouse reports its travel as a
 * vertical `deltaY`, which a `overflow-x`-only row never consumes — the work
 * panel's tab strip overflowed and nothing could reach the rest of it with a
 * mouse (reported 2026-10-26). Trackpads already send a sideways `deltaX`, and
 * Ctrl+wheel is the browser's zoom; both stay native.
 */
export function horizontalWheelStep(event: WheelLike, viewportWidth: number): number {
  if (event.ctrlKey) return 0;
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return 0;
  if (event.deltaY === 0) return 0;
  // Line and page deltas are counts, not pixels.
  const scale = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? viewportWidth : 1;
  return event.deltaY * scale;
}

/**
 * Wheel over a sideways-only strip scrolls it, the way a trackpad already does.
 *
 * The listener is native and non-passive because React's synthetic `onWheel`
 * cannot `preventDefault`; it is prevented only once the strip actually moves,
 * so a wheel over a row that fits still reaches whatever is behind it.
 */
export function useHorizontalWheel(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const onWheel = (event: WheelEvent) => {
      const step = horizontalWheelStep(event, node.clientWidth);
      if (step === 0) return;
      const max = node.scrollWidth - node.clientWidth;
      if (max <= 0) return;
      const next = Math.max(0, Math.min(max, node.scrollLeft + step));
      if (Math.abs(next - node.scrollLeft) < 0.5) return;
      node.scrollLeft = next;
      event.preventDefault();
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [ref]);
}

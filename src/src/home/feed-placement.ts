/**
 * Where a windowed transcript's rows belong, given the boxes they actually have.
 *
 * The model places a row from the height it last measured, and a pane that changes width reflows
 * every drawn row under it — so between the width change and the model's own next measurement the
 * rows are laid out on the previous frame's heights and paint over each other (see
 * `removed:notes/implemented/bug-fix/2026-10-30-window-not-painted-on-stale-heights.md`). This is the
 * arithmetic that stands them on the boxes they have instead: the first row of the window keeps the
 * place the model gave it, and every row after it sits under the one before.
 */

/** A drawn row, as the DOM reports it: where it stands and how tall it is. */
export interface DrawnRowBox {
  top: number;
  height: number;
}

/**
 * The top each drawn row belongs at, in order: `null` where the row is already there.
 *
 * A row is left alone when its own top is within a whole pixel of the stacked one, so the pass
 * writes nothing on a frame where nothing moved and React's own value stands.
 */
export function stackedRowTops(rows: readonly DrawnRowBox[], gap: number): (number | null)[] {
  const tops: (number | null)[] = [];
  let next: number | null = null;
  for (const row of rows) {
    const top = next === null ? null : Math.round(next);
    tops.push(top === null || Math.round(row.top) === top ? null : top);
    next = (next ?? row.top) + row.height + gap;
  }
  return tops;
}

/**
 * Stand a window's rows on the boxes they have now, writing only the ones that moved.
 *
 * Positions and never sizes: a row's box changing size inside a `ResizeObserver` callback leaves
 * that observer's notifications undelivered and logs the loop warning, while `top` is not observed.
 * The rows are taken in `data-index` order — the model's own order, which the DOM does not promise.
 */
export function standRowsOnBoxes(spacer: HTMLElement, gap: number): void {
  const rows = Array.from(spacer.children)
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
  const tops = stackedRowTops(
    rows.map((node) => ({ top: node.offsetTop, height: node.offsetHeight })),
    gap,
  );
  tops.forEach((top, index) => {
    if (top !== null) rows[index]!.style.top = `${top}px`;
  });
}

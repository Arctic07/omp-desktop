/**
 * Which drawn rows are *arrivals*.
 *
 * A transcript is drawn in two very different situations, and they must not look the same: the
 * reader switching to a conversation whose rows are on disk, and a row that appears while they are
 * reading one. The first is not an arrival — the rows were written before the pane existed, and
 * running the entrance over all of them is a whole-tree animation on every switch, on rows nothing
 * about which changed.
 *
 * `drawnBefore` is the row set the pane had committed as of its last render, or `null` while it has
 * committed none yet — which is the mount, and nothing on a mount is an arrival.
 */
export function isArrival(
  drawnBefore: ReadonlySet<string> | null,
  rowId: string,
): boolean {
  return drawnBefore !== null && !drawnBefore.has(rowId)
}

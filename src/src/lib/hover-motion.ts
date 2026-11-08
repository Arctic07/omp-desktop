/**
 * beUI's buttons grow by 2% under the pointer.
 *
 * A fractional scale makes the webview rasterise the icon and the label again, and at these sizes —
 * on a 125% display — that reads as a blur, with the glyph a half pixel lower than it was. Spread
 * this onto a button whose hover feedback is its fill alone: the press spring and the fill stay, the
 * growth goes.
 */
export const NO_HOVER_GROWTH = { whileHover: undefined } as const;

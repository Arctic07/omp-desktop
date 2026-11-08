/**
 * The tag vocabulary of every Markdown surface: one description of how `h1`…`h6`, `p`, `ul`, `ol`,
 * `blockquote`, `hr`, `table`, `a`, `code` and `pre` are drawn, shared by both renderers the app
 * has — the transcript's own (`markdown.tsx`, over `home/markdown.ts`) and a repository document's
 * (`workspace/markdown-file-view.tsx`, over `react-markdown`).
 *
 * They used to carry a copy each, and the copies had drifted: the transcript's anchor had no class
 * at all (a browser-blue link in a BeUI column), the document's was painted a literal sky pair for
 * light and dark — which both `src/rules.md#global-token-values` and this surface's own header forbid — its table
 * was one size smaller than the transcript's, and neither table sat on a framed surface while every
 * other box in the app does. A tag is drawn once here, so a change lands on every surface that
 * renders Markdown.
 *
 * Vocabulary only, no components and no text: every class is a token from `index.css` (the
 * `--color-*` / `--radius-*` pairs and the `--omp-content-font-size` the reader's own setting
 * drives) or a Tailwind scale step. Nothing is a literal colour, and nothing re-paints an element a
 * surface has already sized — a caller that needs a different body size sets it on the root.
 */

import { cn } from "@/lib/utils";

/** The body type of a rendered answer: the content size the reader set, at the app's leading. */
const BODY = "text-[length:var(--omp-content-font-size,0.875rem)]";

/** The column every block sits in. The first block drops its top margin so a row starts on its own
 *  line rather than one gap down.
 *
 *  `wrap-anywhere` rather than `break-words`: the root is a `fit-content` item of the transcript's
 *  content column, so its width is floored by its own min-content, and `break-words` leaves that
 *  floor at the longest unbreakable run — one pasted URL or path then drew the whole answer at that
 *  width, every line unwrapped and clipped by the scrollport. `anywhere` is the value that lowers
 *  the floor, the same reason the reasoning body takes it (`home/AssistantRow.tsx`). */
export const MARKDOWN_ROOT = cn(
  "min-w-0 wrap-anywhere leading-6 text-foreground/90 [&>:first-child]:mt-0",
  BODY,
);

/** A list item's or a quote's own blocks are a box of their own, so their first block drops its top
 *  margin the way the root's does. */
export const MARKDOWN_NESTED = "[&>:first-child]:mt-0";

/**
 * How far a card under a list item pulls back to the column's own left edge.
 *
 * `pl-5` above is the bullet's gutter, not the line the blocks under the bullet start on: a fence
 * drawn from there read as a narrower card than the one above it in the same answer, and the two
 * were told apart by their widths before their contents (2026-10-28 reader report). A card is a box
 * of the column, so it cancels the gutter it happens to sit in — one step per list level, and a list
 * nested deeper than the table keeps the deepest step rather than inventing a fourth.
 *
 * Only cards do this — a fence, a diff, a table. Text stays in the item's own column, where the
 * bullet and its words line up.
 */
const LIST_CARD_OUTDENT = [
  "",
  "-ml-5 w-[calc(100%+1.25rem)]",
  "-ml-10 w-[calc(100%+2.5rem)]",
] as const;

/** The class a card takes for the list depth it sits in; `0` is the top of the answer. */
export function markdownListCardOutdent(listDepth: number): string {
  return LIST_CARD_OUTDENT[Math.min(Math.max(listDepth, 0), LIST_CARD_OUTDENT.length - 1)];
}

export const MARKDOWN_PARAGRAPH = "mt-3";

/** The element each heading depth is drawn as, and its rank.
 *
 *  The sizes step down from the body rather than up to the settings page's display scale: a reply
 *  is one column of prose, and a heading only has to rank against the blocks beside it. Depths 4–6
 *  used to be the same size *and* the same ink as depth 3, so a document's structure below `h3` was
 *  invisible; they now rank by ink and by weight, and `h6` — the last step — is the only muted one. */
export const MARKDOWN_HEADINGS = {
  1: { tag: "h1", className: "mt-5 text-lg font-semibold text-foreground" },
  2: { tag: "h2", className: "mt-5 text-base font-semibold text-foreground" },
  3: { tag: "h3", className: "mt-4 text-sm font-semibold text-foreground" },
  4: { tag: "h4", className: "mt-4 text-sm font-semibold text-foreground/85" },
  5: { tag: "h5", className: "mt-3 text-sm font-medium text-foreground/85" },
  6: { tag: "h6", className: "mt-3 text-sm font-medium text-muted-foreground" },
} as const;

export type MarkdownHeadingDepth = keyof typeof MARKDOWN_HEADINGS;

/** The markers carry the mute, the item text keeps the body's ink. */
const LIST_MARKER = "[&_li]:marker:text-muted-foreground";

export const MARKDOWN_BULLET_LIST = cn("mt-3 list-disc space-y-1 pl-5", LIST_MARKER);
export const MARKDOWN_ORDERED_LIST = cn("mt-3 list-decimal space-y-1 pl-5", LIST_MARKER);

/** The quote is marked by its rule alone; its text keeps the body's ink. */
export const MARKDOWN_QUOTE = "mt-3 border-border border-l pl-3";

export const MARKDOWN_RULE = "mt-4 border-border border-t";

/** Inline code, at the same scale as the app's other inline code: the radius token rather than a
 *  literal one, so it steps with `--radius` like every chip beside it. */
export const MARKDOWN_INLINE_CODE = "rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em]";

/** A span that names a file. It reads as inline code and opens like a link: the document's listener
 *  (`lib/file-links.ts`) answers the click, and the same `data-omp-file` carries the path it opens. */
export const MARKDOWN_FILE_CODE = cn(
  MARKDOWN_INLINE_CODE,
  "cursor-pointer underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground",
);

/** A link is primary ink plus an underline: a token, never the browser's own blue, and never a
 *  literal sky. `primary` is this app's one accent step — near-black in the light palette, near-white
 *  in the dark one — so the underline, not a hue, is what marks the anchor, which is also how
 *  `beUI`'s own prose (`alert`'s description) draws one. The transcription of an anchor's destination
 *  is the host's (`lib/links.ts`), not the webview's: the class describes it, it does not make it
 *  work. */
export const MARKDOWN_LINK = cn(
  // `wrap-anywhere` for the same min-content reason the root takes it: an anchor holding a long
  // destination is the one inline run that is routinely unbreakable, and `break-words` would let it
  // widen the whole column instead of breaking inside the label.
  "rounded-sm wrap-anywhere text-primary underline decoration-primary/40 underline-offset-2",
  "transition-colors hover:decoration-primary",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
);

/** A table is a card: the frame is the app's own box vocabulary — `border-border` plus the
 *  `rounded-2xl` step `Card` and the code block both take — the head row is the muted tint, and the
 *  cells keep a readable width while the frame scrolls sideways instead of squeezing its columns.
 *  The last row drops its bottom rule so the box does not draw a second edge. */
export const MARKDOWN_TABLE_FRAME =
  "mt-3 max-w-full overflow-x-auto rounded-2xl border border-border";

export const MARKDOWN_TABLE = cn(
  "w-full border-collapse",
  "[&_tr>*]:border-b [&_tr>*]:border-border [&_tbody_tr:last-child>*]:border-b-0",
);

export const MARKDOWN_TABLE_HEAD_CELL =
  "min-w-24 max-w-80 bg-muted/50 px-3 py-2 font-medium text-foreground";

export const MARKDOWN_TABLE_CELL = "min-w-24 max-w-80 px-3 py-2 align-top";

/** A fence no grammar claims — the document viewer's fallback, and the one the transcript never
 *  reaches (every fence there is a `CodeBlock`). It takes the code block's own surface, so a fence
 *  with a language and a fence without one are the same card. */
export const MARKDOWN_PREFORMATTED =
  "mt-3 overflow-x-auto rounded-2xl bg-muted/80 p-3 font-mono text-xs leading-relaxed";

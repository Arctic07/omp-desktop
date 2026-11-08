/**
 * The composer field's own arithmetic: what is in it, where the caret is, and what a chip is.
 *
 * The field is a `contenteditable` box whose content is a *draft string* — text plus one private-use
 * character per attachment (`state/composer-draft.ts`) — so every position the reader can put a
 * caret at has one coordinate in common with the draft: the index. What this module holds is the
 * three translations that need the DOM to make — string → nodes, selection → index, index → caret —
 * and they are here rather than in the component because they are about the box, not about React.
 *
 * A chip is one character *and* one element, and the element is `contenteditable="false"`: it is one
 * thing the reader can select and delete, not a run of nodes they can edit the inside of.
 *
 * The module is a React-side implementation of the composer's chip semantics — coordinates,
 * attributes, and the reasons for them (`rules.md#the-only-frontend`). Two differences, both about
 * this app: the ✕ is drawn from the icons the rest of this app draws (`lucide-react`'s geometry, as
 * markup, because a chip is built without React), and a paste is text rather than markup.
 */

import { chipLabel, isChipToken, type ComposerAttachment } from "@/state/composer-draft";

/** Attribute carrying a chip's own token, which is how a painted chip is found again. */
export const CHIP_TOKEN_ATTRIBUTE = "data-chip-token";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * The chip's glyphs, as `lucide-react` draws them elsewhere in this app.
 *
 * A chip is built by hand rather than rendered by React — painting a controlled tree into a
 * `contenteditable` rewrites the nodes the caret lives in — so the icons come as the geometry
 * `lucide-react` uses (`file-text`, `image`, `x`), drawn with the same stroke the components use.
 */
const GLYPH = {
  file: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  remove: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
} as const;

function glyph(name: keyof typeof GLYPH): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = GLYPH[name];
  return svg;
}

/** Whether a file's own type says it is a picture, which is the one chip a reader sees as one. */
function looksLikeImage(mimeType: string): boolean {
  return mimeType.trim().toLowerCase().startsWith("image/");
}

/** One attachment, as the chip the reader clicks, reads, and takes out of the draft. */
export interface ChipActions {
  /** The ✕'s accessible name for one file, in the reader's own language. */
  removeLabel: (name: string) => string
  /** Take this file out of the draft, which is the same act as deleting its character. */
  onRemove: (token: string) => void
  /**
   * The pointer reached or left one chip, which is what shows the picture the file holds.
   *
   * The chip is an element this module builds, so the surface that can draw a preview - a floating
   * card in the window - has to be told about it: `element` is the chip the pointer is on, and null
   * when it left. Reporting the element rather than only the file is what lets that card hang over
   * the chip the pointer is actually on, wherever the chip sits in the sentence.
   */
  onHover: (element: HTMLElement | null, attachment: ComposerAttachment | null) => void
  /**
   * A picture's chip was clicked: show the file itself at the size of the window.
   *
   * Only a chip whose own type is an image is given this — the card's hover is a glance, and a
   * screenshot's text is not readable in it, so the click is the reader asking to actually look.
   */
  onOpen: (attachment: ComposerAttachment) => void
}

function createChip(attachment: ComposerAttachment, actions: ChipActions): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "omp-file-chip omp-file-chip-field";
  chip.contentEditable = "false";
  chip.setAttribute(CHIP_TOKEN_ATTRIBUTE, attachment.token);
  chip.title = attachment.path;
  chip.setAttribute("aria-label", `${attachment.name} — ${attachment.path}`);

  const icon = document.createElement("span");
  icon.className = "omp-file-chip-icon";
  icon.appendChild(glyph(looksLikeImage(attachment.mimeType) ? "image" : "file"));

  // The label is a bare text node: a wrapping inline-block would need `overflow: hidden` for its
  // ellipsis, and CSS 2.1 §10.8.1 moves such a box's baseline to its bottom margin edge — which is
  // the chip's text off the line the reader's own words are on. Long names are elided in JS
  // (`state/composer-draft.ts::chipLabel`).
  const label = document.createTextNode(chipLabel(attachment.name));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "omp-file-chip-remove";
  const removeLabel = actions.removeLabel(attachment.name);
  remove.title = removeLabel;
  remove.setAttribute("aria-label", removeLabel);
  remove.appendChild(glyph("remove"));
  // Swallow the mousedown so taking a file out never drops the editable's caret.
  remove.addEventListener("mousedown", (event) => event.preventDefault());
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    actions.onRemove(attachment.token);
  });

  // The chip's own hover, for the preview card: the element travels with it, so the card is drawn
  // over the chip the pointer is on and not over the sentence it was written in.
  chip.addEventListener("pointerenter", () => actions.onHover(chip, attachment));
  chip.addEventListener("pointerleave", () => actions.onHover(null, null));

  // A picture's chip is also the way to see the picture: the card above it is a glance, and the
  // click opens the file at the size of the window. A file with no picture to show keeps its plain
  // chip — a click on it would promise something there is nothing to draw.
  if (looksLikeImage(attachment.mimeType)) {
    chip.classList.add("omp-file-chip-openable");
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      actions.onOpen(attachment);
    });
  }

  chip.append(icon, label, remove);
  return chip;
}

/** What one paint produced: the nodes to put in the box, and the draft they spell. */
export interface PaintedDraft {
  nodes: Node[]
  /**
   * The draft as the box will read it back.
   *
   * It is not always the string that was handed in: a token with no attachment behind it is dropped
   * rather than drawn as the private-use box the font would show for it. The two differ exactly when
   * the records and the draft have drifted apart — a conversation switched under a draft that names
   * another one's files — and the caller reports the second string, so the two sides converge.
   */
  text: string
}

/** The box's content for one draft: its words as text, its chips as elements. */
export function paintDraft(
  draft: string,
  attachments: readonly ComposerAttachment[],
  actions: ChipActions,
): PaintedDraft {
  const byToken = new Map(attachments.map((attachment) => [attachment.token, attachment]));
  const nodes: Node[] = [];
  let buffer = "";
  let text = "";

  const flush = () => {
    if (buffer.length === 0) return;
    nodes.push(document.createTextNode(buffer));
    text += buffer;
    buffer = "";
  };

  for (const char of draft) {
    const attachment = isChipToken(char) ? byToken.get(char) : undefined;
    if (attachment === undefined) {
      if (isChipToken(char)) continue;
      buffer += char;
      continue;
    }
    flush();
    nodes.push(createChip(attachment, actions));
    text += char;
  }
  flush();
  if (nodes.length === 0) {
    // Chromium needs one node in the box before it will put a caret in it.
    nodes.push(document.createTextNode(""));
  }
  return { nodes, text };
}

/** The token of an element standing for a chip, or null for anything else in the box. */
function chipTokenOf(node: Node): string | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const token = (node as HTMLElement).getAttribute(CHIP_TOKEN_ATTRIBUTE) ?? "";
  return isChipToken(token) ? token : null;
}

/** Read the box back into a draft string; every chip counts as the one character it stands for. */
export function readDraft(root: HTMLElement): string {
  let draft = "";

  const walk = (parent: Node, blockStart: boolean): void => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        draft += child.nodeValue ?? "";
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const token = chipTokenOf(child);
      if (token !== null) {
        draft += token;
        continue;
      }
      const element = child as HTMLElement;
      if (element.tagName === "BR") {
        draft += "\n";
        continue;
      }
      if (element !== root && (element.tagName === "DIV" || element.tagName === "P")) {
        // Native undo can reintroduce block wrappers; keep each one a newline.
        if (!blockStart && draft.length > 0 && !draft.endsWith("\n")) draft += "\n";
        walk(element, draft.length === 0);
        continue;
      }
      walk(element, blockStart && draft.length === 0);
    }
  };

  walk(root, true);
  return draft;
}

/** The tokens of the chips the box is actually holding, in order. */
export function chipTokensInDom(root: HTMLElement): string[] {
  const tokens: string[] = [];
  for (const chip of Array.from(root.querySelectorAll(`[${CHIP_TOKEN_ATTRIBUTE}]`))) {
    const token = chipTokenOf(chip);
    if (token !== null) tokens.push(token);
  }
  return tokens;
}

/** How many draft characters a node stands for. */
function draftLengthOfNode(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? "").length;
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return 0;
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (chipTokenOf(node) !== null) return 1;
    if ((node as HTMLElement).tagName === "BR") return 1;
  }
  let total = 0;
  for (const child of Array.from(node.childNodes)) total += draftLengthOfNode(child);
  return total;
}

/** One node and offset of the box as a draft index, or null when the node is not in it. */
function draftIndexAt(root: HTMLElement, node: Node, offset: number): number | null {
  if (!root.contains(node)) return null;
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(node, offset);
  } catch {
    return null;
  }
  return draftLengthOfNode(range.cloneContents());
}

/** The caret or selection as a draft range; null when it is outside the box. */
export function selectionRange(root: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = draftIndexAt(root, range.startContainer, range.startOffset);
  const end = draftIndexAt(root, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/** Where a draft index is in the box: a node and the offset inside it. */
function caretPointOf(root: HTMLElement, target: number): { node: Node; offset: number } {
  let remaining = target;
  let point: { node: Node; offset: number } | null = null;

  const descend = (parent: Node): boolean => {
    const children = Array.from(parent.childNodes);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child === undefined) continue;
      const length = draftLengthOfNode(child);
      if (child.nodeType === Node.TEXT_NODE) {
        if (point === null && remaining <= length) {
          point = { node: child, offset: remaining };
          return true;
        }
        remaining -= length;
        continue;
      }
      // A chip and a `<br>` are one character each, and neither can hold a caret inside it: the
      // index before it and the index after it are the two positions it offers.
      if (chipTokenOf(child) !== null || (child as HTMLElement).tagName === "BR") {
        if (point === null && remaining <= 1) {
          point = { node: parent, offset: remaining === 0 ? index : index + 1 };
          return true;
        }
        remaining -= 1;
        continue;
      }
      if (child.nodeType === Node.ELEMENT_NODE && descend(child)) return true;
    }
    return false;
  };

  descend(root);
  return point ?? { node: root, offset: root.childNodes.length };
}

/** Put the caret at one draft index, collapsing any selection onto it. */
export function placeCaret(root: HTMLElement, index: number): void {
  const point = caretPointOf(root, Math.max(0, index));
  const selection = window.getSelection();
  if (selection === null) return;
  const limit =
    point.node.nodeType === Node.TEXT_NODE
      ? (point.node.nodeValue ?? "").length
      : point.node.childNodes.length;
  const range = document.createRange();
  range.setStart(point.node, Math.min(point.offset, limit));
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Ask Chromium's editor to break lines with `<br>` rather than with block wrappers.
 *
 * A draft is one string of lines, not a tree of blocks, so a block wrapper is one more shape to read
 * back (`readDraft` handles `DIV`/`P` as newlines for that reason, which is also what native undo can
 * reintroduce). This is the preference, not the requirement: the field intercepts every Enter itself,
 * so the paragraph path is one the browser never takes here.
 */
export function setLineBreakParagraphs(): void {
  document.execCommand("defaultParagraphSeparator", false, "br");
}

/**
 * Whether a keydown still belongs to the input method.
 *
 * Chromium reports `isComposing` for the Enter that confirms an IME candidate, and some engines
 * leave it false while reporting the legacy `keyCode === 229`; both spell "this key belongs to the
 * composition, not to the app". A confirmed candidate is not a submission.
 */
export function isCompositionKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/**
 * The words of a selection, the files its chips stood for, and where each stood in those words.
 *
 * A chip's label is visible text, so a selection over a message that carries a file includes it —
 * and a label pasted back into a composer is the file's name written as prose, a second copy of the
 * chip the same paste imports. The field does not have this problem (its words are read off the
 * draft, where a chip is one character), but the transcript does: it draws the same chip inside the
 * same sentence and keeps no draft of its own. So the words are read off a *copy* of the range with
 * those elements removed, which leaves exactly the sentence the reader wrote around them.
 *
 * The place a chip stood cannot travel in the selected words: a private-use character marking it
 * would paste into another application as invisible junk. It is reported here instead, as the prose
 * offset before each file, and the copy remembers it beside the clipboard's own text
 * (`lib/clipboard.ts::copyTextWithFiles`), so a paste of that copy puts the chips back where they
 * were. Each chip is replaced by one marker character for a first read: that read's runs are the
 * text between the chips, and the marker position is the run's own prose length plus the
 * whitespace that preceded the chip, bounded by the next visible character. The bound is why a
 * collapsed whitespace run keeps the chip where `state/composer-draft.ts::chipPlacements` puts it:
 * the marker itself is not whitespace, so the marked read keeps two runs apart that the unmarked
 * read collapses into one (`看这张 [chip] 和` has two spaces with the marker and one without it).
 *
 * `innerText` rather than `textContent`, because a copy has to break lines where the screen does and
 * nowhere else — `textContent` glues every block of a message into one line, and
 * `selection.toString()` glues the chip's label into the sentence. It only answers that way for an
 * element that is laid out, hence the box parked off-screen for the length of one read; the box's
 * own `white-space` stays the default, so the copy keeps the styles the elements brought with them
 * (a `pre` block still breaks where it should). The app is a single Chromium (WebView2), so its
 * `innerText` is the one this is written against — measured against `Selection.toString()` in
 * Chrome, which returns the same words plus the labels.
 *
 * A file the selection names twice is one file: the mention block dedups its path and a paste
 * attaches it once, so the first chip's offset is the one kept.
 */

/** The attribute a message's chip carries its file's path in (`home/AttachmentChip.tsx`). */
const FILE_ATTRIBUTE = "data-copy-file";

export interface SelectionCopy {
  /** The selected words, with the chips' labels taken out. */
  words: string
  /** The files behind the selected chips, in the order they stood, each path once. */
  files: string[]
  /** Offset in `words` at which each file's chip stood, aligned with `files`. */
  placements: number[]
}

/** A single private-use character the text does not contain, or null when none is left. */
function freeMarker(text: string): string | null {
  for (let code = 0xe000; code <= 0xf8ff; code += 1) {
    const candidate = String.fromCharCode(code);
    if (!text.includes(candidate)) return candidate;
  }
  return null;
}

/** The characters `innerText` collapses into one space in normal flow. */
function isCollapsible(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

/** The first character after `from` that the whitespace read keeps, or null for only space left. */
function nextVisible(runs: readonly string[], from: number): string | null {
  for (let index = from; index < runs.length; index += 1) {
    for (const char of runs[index] ?? "") {
      if (!isCollapsible(char)) return char;
    }
  }
  return null;
}

/**
 * Where each marker in a chip-marked read stands in the unmarked words.
 *
 * `runs` are the pieces between markers, in order; `words` is the same selection after the markers
 * are removed. A marker goes after the whitespace that preceded it, not after the next visible
 * character: with preserved whitespace (`pre`) that is the chip's exact place, and where whitespace
 * collapsed, the next visible character bounds it to the single space the unmarked words kept.
 */
export function markerOffsets(runs: readonly string[], words: string): number[] {
  const placements: number[] = [];
  let cursor = 0;
  let previous = 0;
  for (let index = 0; index < runs.length - 1; index += 1) {
    const run = runs[index] ?? "";
    for (const char of run) {
      if (isCollapsible(char)) continue;
      const at = words.indexOf(char, cursor);
      cursor = at < 0 ? words.length : at + char.length;
    }
    let trailing = 0;
    for (let at = run.length - 1; at >= 0; at -= 1) {
      const char = run[at];
      if (char === undefined || !isCollapsible(char)) break;
      trailing += 1;
    }
    const next = nextVisible(runs, index + 1);
    const right = next === null ? words.length : words.indexOf(next, cursor);
    const limit = right < 0 ? words.length : right;
    const placement = Math.min(Math.max(cursor + trailing, previous), limit);
    placements.push(placement);
    previous = placement;
  }
  return placements;
}

export function selectionCopy(range: Range): SelectionCopy {
  const frame = document.createElement("div");
  frame.style.cssText = "position:fixed;top:0;left:-100000px;pointer-events:none";
  frame.append(range.cloneContents());

  const chips = Array.from(frame.querySelectorAll<HTMLElement>(`[${FILE_ATTRIBUTE}]`));
  const paths = chips.map((chip) => chip.getAttribute(FILE_ATTRIBUTE) ?? null);
  const marker = freeMarker(frame.textContent ?? "");
  if (marker === null) {
    // A selection holding every private-use character has no marker left. The words and files are
    // still a copy; only the chip places are lost, so the paste lands its files at the caret.
    for (const chip of chips) chip.remove();
    document.body.append(frame);
    const words = frame.innerText;
    frame.remove();
    const files: string[] = [];
    for (const path of paths) {
      if (path !== null && path !== undefined && !files.includes(path)) files.push(path);
    }
    return { words, files, placements: [] };
  }
  const marks: Text[] = [];
  for (const chip of chips) {
    const mark = document.createTextNode(marker);
    marks.push(mark);
    chip.replaceWith(mark);
  }

  document.body.append(frame);
  // The chip-marked read keeps each run's own non-whitespace characters and where they sit beside
  // a marker; the unmarked one is the copy itself, with the collapsed whitespace the reader sees.
  const marked = frame.innerText;
  for (const mark of marks) mark.remove();
  const words = frame.innerText;
  frame.remove();

  const runs = marked.split(marker);
  const atMarker = markerOffsets(runs, words);

  const files: string[] = [];
  const placements: number[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    if (path === null || path === undefined || files.includes(path)) continue;
    files.push(path);
    placements.push(atMarker[index] ?? words.length);
  }
  return { words, files, placements };
}

/**
 * The words of a selection, with the elements a copy carries as files taken out of them.
 *
 * A chip's label is visible text, so a selection over a message that carries a file includes it —
 * and a label pasted back into a composer is the file's name written as prose, a second copy of the
 * chip the same paste imports. The field does not have this problem (its words are read off the
 * draft, where a chip is one character), but the transcript does: it draws the same chip inside the
 * same sentence and keeps no draft of its own. So the words are read off a *copy* of the range with
 * those elements removed, which leaves exactly the sentence the reader wrote around them.
 *
 * `innerText` rather than `textContent`, because a copy has to break lines where the screen does and
 * nowhere else — `textContent` glues every block of a message into one line, and `selection.toString()`
 * glues the chip's label into the sentence. It only answers that way for an element that is laid out,
 * hence the box parked off-screen for the length of one read; the box's own `white-space` stays the
 * default, so the copy keeps the styles the elements brought with them (a `pre` block still breaks
 * where it should). The app is a single Chromium (WebView2), so its `innerText` is the one this is
 * written against — measured against `Selection.toString()` in Chrome, which returns the same words
 * plus the labels.
 */
export function selectionWords(range: Range, filesSelector: string): string {
  const frame = document.createElement("div");
  frame.style.cssText = "position:fixed;top:0;left:-100000px;pointer-events:none";
  frame.append(range.cloneContents());
  for (const element of Array.from(frame.querySelectorAll(filesSelector))) element.remove();
  document.body.append(frame);
  const words = frame.innerText;
  frame.remove();
  return words;
}

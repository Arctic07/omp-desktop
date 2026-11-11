/**
 * Writing text to the reader's clipboard.
 *
 * The clipboard API is missing or refused in places this app runs (a document that is not focused,
 * a permission the platform withheld), and it throws rather than answering — so the one thing every
 * caller needs is a yes/no, and the surfaces that copy decide what to say when it is no.
 */

import { copyTextAndFiles, readClipboardText as desktopClipboardText } from "@/api/agent";
import { isWrittenCopy, textWithFileMentions, type WrittenFileCopy } from "@/lib/file-mention";

/** The copy this page last wrote as words plus files: its exact text beside what it stood for. */
let writtenCopy: (WrittenFileCopy & { text: string }) | null = null;

/**
 * The words and files of a paste that is this page's own copy, or null for any other clipboard.
 *
 * The clipboard is the one place where the page cannot mark what it wrote: `text/plain` is all a
 * target learns, and the mention block the copy appends is a shape another application's text can
 * have too. So the last copy this page wrote is remembered with its exact text, and a paste that
 * matches it byte for byte is that copy — its words as they were typed and one chip per path it
 * named, instead of the block read back as prose (the reported `@<path>` left in the box after
 * cutting a chip and pasting it back).
 */
export function recallOwnCopy(text: string): WrittenFileCopy | null {
  if (writtenCopy === null || writtenCopy.paths.length === 0) return null;
  if (!isWrittenCopy(text, writtenCopy.text)) return null;
  return {
    words: writtenCopy.words,
    paths: writtenCopy.paths,
    placements: writtenCopy.placements,
  };
}

export async function copyText(value: string): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy text together with the files it carried.
 *
 * The web clipboard can write words, never a file list, so the desktop publishes both in one
 * replace; when it refuses (another process holds the clipboard, the platform has no file list) the
 * words still go through the web API — a copy of a message must copy the message. Either way the
 * files are named in the text as mention lines, so a target that takes only text still learns which
 * files went with it.
 *
 * `placements` is where each chip stood inside `text`; the clipboard has no room for it, so it is
 * remembered beside the copy (`lib/file-mention.ts::WrittenFileCopy`) and restored by a paste of it.
 * The offsets are clamped to the words the clipboard ends up holding.
 *
 * The copy is remembered on the way out, whichever write took it — and it stays remembered even
 * when both writes fail. The record is not a claim about the clipboard; it is what makes a paste
 * that comes back with exactly these words this page's own copy (`recallOwnCopy`), and a caller
 * whose copy reached the clipboard by its own path (the composer writes the same text on its
 * clipboard event, `writeSelection`) must still be read back as words and chips.
 */
export async function copyTextWithFiles(
  text: string,
  files: readonly string[],
  placements: readonly number[] = [],
): Promise<boolean> {
  const written = textWithFileMentions(text, files)
  const words = text.trimEnd()
  writtenCopy = {
    text: written,
    words,
    paths: files,
    placements: placements.map((at) => Math.min(Math.max(at, 0), words.length)),
  }
  if (files.length > 0) {
    try {
      if (await copyTextAndFiles(written, files)) return true
    } catch {
      // A desktop write that failed leaves the words to the web API below.
    }
  }
  return copyText(written)
}

/**
 * Reading text off the reader's clipboard.
 *
 * Same shape as `copyText`: the API can be missing or refused and it throws instead of answering,
 * so a refusal is `null` for the caller to say out loud.
 */
export async function readText(): Promise<string | null> {
  if (typeof navigator === "undefined" || typeof navigator.clipboard?.readText !== "function") {
    return null;
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/**
 * The words a file-list paste hid from the page.
 *
 * A clipboard that holds a file list gives the webview `Files` and no `text/plain` at all
 * (measured in Chromium on Windows, 2026-10-24), so a copy this app wrote as "words and files" — a
 * message with an image — pastes back as the image alone. The text is still on the clipboard, and
 * the desktop is the only side that can read it. Empty is a complete answer: the words are the
 * optional half of that paste, and the files land on their own either way.
 */
export async function recoverPastedText(): Promise<string> {
  try {
    return await desktopClipboardText();
  } catch {
    return "";
  }
}

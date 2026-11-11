/**
 * The composer's draft, as one string: the reader's words and the files they carry, in one flow.
 *
 * A prompt carries its attachments beside its text — `session_prompt` takes `attachments` as its own
 * array — but the *editing* surface is one thing: a file inserted into a sentence sits where the caret
 * was, and the reader's caret, selection and backspace all move through it as if it were a character.
 * So it is a character: each attachment owns one private-use code point
 * (U+E000–U+F8FF, a range no keyboard produces and no font draws), and the draft string is what
 * text and files have in common.
 *
 * This module is the arithmetic of that idea and nothing else — no DOM, no store, no IPC — which is
 * what lets the pairing be checked without a browser (`composer-draft.test.ts`). What draws a chip
 * for a token is `components/agents/composer-field.tsx`; what holds the records is
 * `state/composer-attachments.ts`.
 */

import type { ChatAttachmentRef } from "@/api/session-types";
// Relative with its extension: this module is read by the test runner as well as by the bundler and
// the runner has no alias to resolve (`home/composer-history.ts` does the same).
import {
  carriesOwnFileMentions,
  textWithoutFileMentions,
  type WrittenFileCopy,
} from "../lib/file-mention.ts";

/** One file the composer is holding, and the character that stands for it in the draft. */
export interface ComposerAttachment extends ChatAttachmentRef {
  token: string
}

const TOKEN_FIRST = 0xe000;
const TOKEN_LAST = 0xf8ff;
const TOKEN_SPAN = TOKEN_LAST - TOKEN_FIRST + 1;

let tokenSequence = 0;

/**
 * Hand out the next code point a chip is addressed by.
 *
 * The sequence is per visit and never resets: two attachments alive at once must not share a token,
 * and a token that outlived its record would otherwise be read back as the wrong file. Running off
 * the end of the range starts over, which is where the desktop's own cap on one prompt's files
 * (ten) makes a collision unreachable in practice.
 */
export function createChipToken(): string {
  tokenSequence = (tokenSequence % TOKEN_SPAN) + 1;
  return String.fromCharCode(TOKEN_FIRST + tokenSequence - 1);
}

/** Whether one character is a chip's token rather than something the reader typed. */
export function isChipToken(value: string): boolean {
  if (value.length !== 1) return false;
  const code = value.charCodeAt(0);
  return code >= TOKEN_FIRST && code <= TOKEN_LAST;
}

/** A draft split into the text between its chips and the chips themselves, in order. */
export interface ComposerDraftSegment {
  text: string
  attachment: ComposerAttachment | null
}

/**
 * Split a draft into ordered segments.
 *
 * A code point in the token range with no attachment behind it stays verbatim text rather than
 * vanishing: a pasted private-use glyph the reader cannot see is still their draft, and this side
 * does not get to delete what it does not understand.
 */
export function splitComposerDraft(
  text: string,
  attachments: readonly ComposerAttachment[],
): ComposerDraftSegment[] {
  const byToken = new Map(attachments.map((attachment) => [attachment.token, attachment]));
  const segments: ComposerDraftSegment[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer.length === 0) return;
    segments.push({ text: buffer, attachment: null });
    buffer = "";
  };

  for (const char of text) {
    const attachment = isChipToken(char) ? byToken.get(char) : undefined;
    if (attachment === undefined) {
      buffer += char;
      continue;
    }
    flush();
    segments.push({ text: "", attachment });
  }
  flush();
  return segments;
}

/**
 * What the reader wrote, with every chip's character taken out.
 *
 * The whole token range goes, not just the tokens this draft has records for: the range is this
 * application's own vocabulary, so a character in it is a file's address — and one with no file
 * behind it is nothing to send to the engine.
 */
export function draftProse(text: string): string {
  let prose = "";
  for (const char of text) {
    if (isChipToken(char)) continue;
    prose += char;
  }
  return prose;
}

/**
 * The attachments a draft names, in the order it names them.
 *
 * This is the list a prompt is sent with, and it is read from the draft rather than from the store:
 * a record whose token has been backspaced out of the draft is a file the reader took out of this
 * prompt, whatever the store still holds, and one whose token sits early in the sentence goes to the
 * engine early — which is the order the reader built by typing.
 */
export function draftAttachments(
  text: string,
  attachments: readonly ComposerAttachment[],
): ComposerAttachment[] {
  return splitComposerDraft(text, attachments)
    .map((segment) => segment.attachment)
    .filter((attachment): attachment is ComposerAttachment => attachment !== null);
}

/**
 * The files a draft slice names, and the prose offset each one stood at.
 *
 * A copy of a selection writes the words without their chips' characters — those code points are
 * this application's own vocabulary and would paste into another application as invisible junk —
 * so the positions have to travel beside the copy rather than inside it (`WrittenFileCopy.placements`
 * in `lib/file-mention.ts`). `prose` counts exactly what `draftProse` keeps: a token, with or
 * without a record, is not one of the reader's characters.
 */
export function chipPlacements(
  sentence: string,
  attachments: readonly ComposerAttachment[],
): { paths: string[]; placements: number[] } {
  const byToken = new Map(
    attachments.map((attachment) => [attachment.token, attachment]),
  );
  const paths: string[] = [];
  const placements: number[] = [];
  let prose = 0;
  for (const char of sentence) {
    const attachment = isChipToken(char) ? byToken.get(char) : undefined;
    if (attachment !== undefined) {
      paths.push(attachment.path);
      placements.push(prose);
      continue;
    }
    // `char` is one code point but `draftProse` and the draft's slice indices count UTF-16 code
    // units: an astral character before a chip occupies two of them.
    if (!isChipToken(char)) prose += char.length;
  }
  return { paths, placements };
}

/** The attachments a draft no longer names, for a store that should stop holding them. */
export function orphanAttachments(
  text: string,
  attachments: readonly ComposerAttachment[],
): ComposerAttachment[] {
  const named = new Set(draftAttachments(text, attachments).map((attachment) => attachment.token));
  return attachments.filter((attachment) => !named.has(attachment.token));
}

/** One segment of a message that has been sent: its words, or one of the files it carried. */
export interface MessageSegment {
  text: string
  attachment: ChatAttachmentRef | null
}

/**
 * The segments of a message already sent, from its own text and the files it carried.
 *
 * A sent message is the draft it was written as: the reader's words, with the composer's placeholders
 * still in them, and the files in the order the prompt carried them. The pairing here is
 * *positional* — the nth placeholder stands for the nth file — because that is the pairing that
 * survives the round trip through the engine: what the transcript holds is the placeholders and the
 * `@<path>` lines the host appended, and the read pairs them by order
 * (`src-tauri/src/services/attachment_mentions.rs`). Nothing about a sent message depends on which
 * code point its placeholder happens to be.
 *
 * A file with no placeholder left to stand at — a message sent before the composer kept them, or one
 * whose placeholders were lost on the way — is drawn at the end of the words rather than dropped: the
 * message did carry it, and a chip with no place is still truer than no chip at all. A placeholder
 * with no file behind it goes the other way and is dropped, because the range is this application's
 * own vocabulary and a character in it that stands for nothing is not the reader's text (the same
 * rule `draftProse` applies to a draft).
 */
export function messageSegments(
  text: string,
  attachments: readonly ChatAttachmentRef[],
): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let buffer = "";
  let taken = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    segments.push({ text: buffer, attachment: null });
    buffer = "";
  };

  for (const char of text) {
    if (!isChipToken(char)) {
      buffer += char;
      continue;
    }
    const attachment = attachments[taken];
    if (attachment === undefined) continue;
    flush();
    segments.push({ text: "", attachment });
    taken += 1;
  }
  flush();
  for (const attachment of attachments.slice(taken)) {
    segments.push({ text: "", attachment });
  }
  return segments;
}

/**
 * Where each file's chip stood in the words of a message, as a copy from the row's own control
 * needs it.
 *
 * `messageSegments` has already placed every attachment — a file with no placeholder left is
 * appended after the words — so the answer is one offset per attachment, in the order the message
 * carries them. A text segment contributes its own length; a chip contributes the prose collected
 * before it.
 */
export function messagePlacements(segments: readonly MessageSegment[]): number[] {
  let at = 0;
  const placements: number[] = [];
  for (const segment of segments) {
    if (segment.attachment === null) {
      at += segment.text.length;
      continue;
    }
    placements.push(at);
  }
  return placements;
}

/** A draft rebuilt from a sent message: its words with fresh chip tokens, and the records behind them. */
export interface RestoredDraft {
  text: string
  attachments: ComposerAttachment[]
}

/**
 * Rebuild a message as an editable draft, for a message taken back into the composer.
 *
 * The pairing is the same positional one `messageSegments` draws with: the nth placeholder stands
 * for the nth file. What differs is the token each record gets — a sent message's characters are
 * addresses its own draft owned, and this draft is a new one — so the words are rewritten with the
 * tokens minted here, and the records carry those tokens. A placeholder with no file behind it is
 * dropped (the range is this application's own vocabulary, not the reader's text), a file with no
 * placeholder left is appended where the draft ends, and `limit` is the room the store has left:
 * a file that no longer fits is left out of both the words and the records rather than written as
 * a chip with nothing behind it.
 */
export function draftFromMessage(
  text: string,
  attachments: readonly ChatAttachmentRef[],
  limit: number = Number.POSITIVE_INFINITY,
): RestoredDraft {
  const records: ComposerAttachment[] = [];
  const mint = (ref: ChatAttachmentRef): ComposerAttachment => ({ ...ref, token: createChipToken() });
  let draft = "";
  let taken = 0;

  for (const char of text) {
    if (!isChipToken(char)) {
      draft += char;
      continue;
    }
    const attachment = attachments[taken];
    if (attachment === undefined) continue;
    taken += 1;
    if (records.length >= limit) continue;
    const record = mint(attachment);
    records.push(record);
    draft += record.token;
  }
  for (const attachment of attachments.slice(taken)) {
    if (records.length >= limit) break;
    const record = mint(attachment);
    records.push(record);
    draft += record.token;
  }
  return { text: draft, attachments: records };
}

const CHIP_LABEL_HEAD = 16;
const CHIP_LABEL_TAIL = 10;

/**
 * Elide a long file name in JS rather than in CSS.
 *
 * `text-overflow: ellipsis` needs `overflow: hidden`, and CSS 2.1 §10.8.1 redefines the baseline of
 * an inline-block with non-visible overflow as its bottom margin edge — which lifts the chip's text
 * off the line it shares with the reader's words and leaves the icon hanging below them. So the
 * shortening happens here, where it costs nothing, and the chip's own box stays overflow-visible.
 */
export function chipLabel(name: string): string {
  if (name.length <= CHIP_LABEL_HEAD + CHIP_LABEL_TAIL + 1) return name;
  return `${name.slice(0, CHIP_LABEL_HEAD)}…${name.slice(-CHIP_LABEL_TAIL)}`;
}

/**
 * The attachments in the shape a prompt is written with: what the engine is told about each file.
 *
 * A chip's token is this side's address for a file *inside a draft*; a prompt has no draft, so the
 * token stops here — `ChatAttachmentRef` is the wire's own shape, and the engine reads each file from
 * the path it names.
 */
export function attachmentRefs(attachments: readonly ComposerAttachment[]): ChatAttachmentRef[] {
  return attachments.map(({ name, path, mimeType, bytes }) => ({ name, path, mimeType, bytes }));
}

/** The leaf name of a pasted file, or a name of this side's own when the clipboard had none. */
export function pastedFileName(name: string, index: number): string {  const leaf = name.trim().split(/[\\/]/).pop()?.trim() ?? "";
  return leaf.length > 0 && leaf !== "." ? leaf : `pasted-file-${index + 1}`;
}

/** A pasted file's MIME type, with the clipboard's silence answered as bytes. */
export function pastedMimeType(type: string): string {
  const mimeType = type.trim().toLowerCase();
  return mimeType.length > 0 ? mimeType : "application/octet-stream";
}

/** What one paste means for the box. */
export interface ClipboardPaste {
  /** The words to insert, with any address block the copy appended taken back out. */
  words: string
  /**
   * The files a copy names itself, to be attached by path.
   *
   * This is the paste of a copy *this page* wrote: the words are known exactly (they are the ones
   * that were copied, not a reconstruction from a block of addresses), and so are the files — so
   * neither is read back out of the text, and no chapter of the paste has to guess.
   */
  paths: readonly string[]
  /**
   * Offset in `words` each path's chip stood at, aligned with `paths`.
   *
   * Empty when the paste did not carry that knowledge — every clipboard from another application,
   * and the copies this page made before it remembered placements. Then the files land at the
   * paste's anchor, one after the other, which is the only placement the clipboard itself offers.
   */
  placements: readonly number[]
  /** Whether the clipboard's own bytes are files the box has to import. */
  importFiles: boolean
}

/**
 * Read one paste back into its words and its files.
 *
 * Three shapes arrive this way, and the first two need telling apart. A copy *this application*
 * wrote starts with the words and ends with a block of mention lines naming exactly the files that
 * travel beside it (`lib/clipboard.ts`); those lines are this side's own bookkeeping — a file is a
 * chip in the sentence, not a line under it — so they come back out and the files land as chips.
 * A copy out of a browser or a document is a sentence plus a rendered picture of it: the reader
 * wanted the sentence, and the picture is a snapshot this application has no use for. Everything
 * else (Explorer's file list, a picture out of another chat app) is the files.
 *
 * `own` is the same first shape with its provenance intact: the page still remembers the copy it
 * wrote, so its words, paths and chip offsets are taken as they are rather than recovered from the
 * text. That is the branch a cut-and-paste or copy-and-paste *inside* this app takes, and it is why
 * a chip comes back as a chip even when the clipboard hands the page no file list at all. The caller
 * only passes one when `text` *is* that copy (`lib/clipboard.ts::recallOwnCopy`), which is the one
 * place that comparison can be made: it holds the text that was written.
 *
 * Telling the first apart from the second is why the mention lines are written at all: without them
 * a message copied from this app and a sentence copied from a browser are the same clipboard — words
 * plus one image — and the image was silently dropped in favour of the words.
 */
export function planClipboardPaste(
  text: string,
  files: readonly { name: string; type: string }[],
  own: WrittenFileCopy | null = null,
): ClipboardPaste {
  if (own !== null && own.paths.length > 0) {
    return {
      words: own.words,
      paths: own.paths,
      placements:
        own.placements !== undefined && own.placements.length === own.paths.length
          ? own.placements
          : [],
      importFiles: false,
    };
  }
  if (files.length === 0) return { words: text, paths: [], placements: [], importFiles: false };
  const names = files.map((file) => file.name);
  if (carriesOwnFileMentions(text, names)) {
    return {
      words: textWithoutFileMentions(text, names),
      paths: [],
      placements: [],
      importFiles: true,
    };
  }
  const snapshot =
    text.trim().length > 0 &&
    files.every((file) => file.type.trim().toLowerCase().startsWith("image/"));
  return { words: text, paths: [], placements: [], importFiles: !snapshot };
}

/** The pasted words' place in the draft, and the chips the copy says stood inside them. */
export interface PastedChipPositions {
  /** The paths the copy named, in the order its chips stood. */
  paths: readonly string[]
  /** Offset in the pasted words at which each path's chip stood, aligned with `paths`. */
  placements: readonly number[]
  /** Where the pasted words begin in the draft. */
  start: number
  /** Where the pasted words end in the draft. */
  end: number
}

/** A range in a draft, without the words' contents. */
export interface DraftSpan {
  start: number
  end: number
}

/**
 * Carry a pasted words' span across an edit, or answer null when the edit touched those words.
 *
 * The chip offsets are measured from `start` inside the pasted block, so an edit before the block
 * moves both ends, an edit after it changes nothing, and an edit that overlaps the block makes the
 * offsets describe a string that no longer exists. The edit is found by the common prefix and
 * suffix, which is enough for every text edit a field produces: a keystroke, a delete, a cut, a
 * paste, a drop.
 */
export function shiftPasteSpan(
  span: DraftSpan,
  before: string,
  after: string,
): DraftSpan | null {
  let prefix = 0;
  const limit = Math.min(before.length, after.length);
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  const changeStart = prefix;
  const changeEnd = before.length - suffix;
  const delta = after.length - before.length;
  if (changeStart >= span.end) return span;
  if (changeEnd <= span.start) {
    return { start: span.start + delta, end: span.end + delta };
  }
  return null;
}

/**
 * Write imported chips back into the words a paste inserted, at the offsets the copy remembered.
 *
 * A copy's text cannot say where its chips stood, so the paste that carries this page's own copy
 * (`planClipboardPaste`'s `paths`) is the one that can put them back: `records` are the files the
 * desktop just imported, one per `paths` entry, and each token goes at `start + its placement`.
 * `placements` is aligned with `paths`; a record whose path has no offset left — the clipboard
 * named a file the import skipped, or the caller attached something else — goes at the end of the
 * pasted words rather than nowhere. The offsets are clamped to the pasted words, because a copy
 * trims their trailing space and the paste must not write outside the block it describes.
 *
 * Chips at the same offset keep `records`' order: the token inserted first ends up leftmost.
 */
export function insertPastedChips(
  draft: string,
  records: readonly { token: string; path: string }[],
  positions: PastedChipPositions,
): string {
  const used = new Set<number>();
  const insertions = records.map((record, order) => {
    const occurrence = positions.paths.findIndex(
      (path, index) => path === record.path && !used.has(index),
    );
    const offset = occurrence < 0 ? undefined : positions.placements[occurrence];
    if (occurrence < 0 || offset === undefined) {
      return { token: record.token, at: positions.end, order };
    }
    used.add(occurrence);
    return {
      token: record.token,
      at: Math.min(
        Math.max(positions.start + offset, positions.start),
        positions.end,
      ),
      order,
    };
  });

  // Insertion back to front keeps every earlier offset valid. Sorting first means the import's
  // answer does not have to arrive in chip order; the record's own order only breaks a tie, where
  // the token inserted first ends up leftmost.
  insertions.sort((left, right) => left.at - right.at || left.order - right.order);
  let text = draft;
  for (let at = insertions.length - 1; at >= 0; at -= 1) {
    const insertion = insertions[at];
    if (insertion === undefined) continue;
    text = `${text.slice(0, insertion.at)}${insertion.token}${text.slice(insertion.at)}`;
  }
  return text;
}

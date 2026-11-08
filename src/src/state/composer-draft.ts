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
 * wrote, so its words and paths are taken as they are rather than recovered from the text. That is
 * the branch a cut-and-paste or copy-and-paste *inside* this app takes, and it is why a chip comes
 * back as a chip even when the clipboard hands the page no file list at all. The caller only passes
 * one when `text` *is* that copy (`lib/clipboard.ts::recallOwnCopy`), which is the one place that
 * comparison can be made: it holds the text that was written.
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
    return { words: own.words, paths: own.paths, importFiles: false };
  }
  if (files.length === 0) return { words: text, paths: [], importFiles: false };
  const names = files.map((file) => file.name);
  if (carriesOwnFileMentions(text, names)) {
    return { words: textWithoutFileMentions(text, names), paths: [], importFiles: true };
  }
  const snapshot =
    text.trim().length > 0 &&
    files.every((file) => file.type.trim().toLowerCase().startsWith("image/"));
  return { words: text, paths: [], importFiles: !snapshot };
}

/**
 * The reasoning envelope a model writes for itself, read back out of either channel.
 *
 * A step's thinking belongs in the engine's own reasoning channel (`thinking`), and the answer in
 * the words that channel is separate from. Models break that split in two ways, and both reach the
 * reader as markup rather than as what the step meant:
 *
 * - Some write the reasoning into the words they stream, wrapped in a `previous_reasoning` or
 *   `thought` element, so the tags read as angle-bracket prose in the middle of an answer — the
 *   reader sees `<previous_reasoning_empty/>` at the head of a paragraph and `</previous_reasoning>`
 *   under it (2026-10-29, a step that did its planning in the text channel and then called a tool),
 *   or a whole plan between `<thought>` and `</thought>` (2026-11-04, `me/deepseek-v4.1-flash`).
 * - Some stream *both* channels into the reasoning one and write `</thinking>` where the answer
 *   begins, so the answer arrives as the tail of the thinking and the bubble stays empty under a
 *   marker (`readModelReasoning`).
 *
 * What is inside either envelope is a thought, not something the reader was meant to read as an
 * answer, so it is handed to the reasoning surface and the answer is what the message says outside
 * it. Nothing here drops words a model wrote as its answer.
 */

// Relative, with its extension: this module is read by the test runner as well as by the bundler.
import { codeRanges, inSpans, startsLine, without, type Span } from './code-ranges.ts'

/** What one message says: the reasoning its envelope carried, and the words outside it. */
export interface ReasoningEcho {
  /** The step's thinking, empty when the text carries no envelope. */
  reasoning: string;
  /** What the message says outside its envelopes. */
  answer: string;
}

/** The envelopes a model writes around its own thinking in the answer channel. */
const ENVELOPES = ["previous_reasoning", "thought"] as const;

/** The tag vocabulary, in the one spelling the models that emit it use. */
const OPENER = new RegExp(`<(${ENVELOPES.join("|")})(?:_empty)?[ \\t]*\\/?>`, "g");

/** The closing tag that ends one envelope. */
function closerOf(name: string): string {
  return `</${name}>`;
}

/**
 * The reasoning block's own markers, in the channel that carries everything.
 *
 * The opener is read although no recorded step wrote one: a model that marks where its reasoning
 * starts has said the same thing as one that only marks where it ends, and the marker is markup
 * either way. Group 1 is the slash, which is what tells the two apart.
 */
const THINKING_MARKER = /<(\/?)thinking[ \t]*>/g;

/**
 * A message's reasoning and its answer, split out of the text one envelope vocabulary.
 *
 * Only an opening that starts its own line counts. A model opens its envelope at the head of what
 * it writes, while an answer that merely *mentions* one — a bug report, a patch, a quotation —
 * mentions it mid-sentence, and reading that as an envelope would eat the words around it.
 * Fenced code is text for the same reason: a block that spells the vocabulary out is showing it.
 *
 * Two spellings are read because two were measured: the engine's own `previous_reasoning` echo and
 * the `<thought>` block a model writes when it keeps its plan in the answer channel (2026-11-04).
 */
export function splitReasoningEcho(text: string): ReasoningEcho {
  if (
    !ENVELOPES.some(
      (name) => text.includes(`<${name}`) || text.includes(`</${name}>`),
    )
  ) {
    return { reasoning: "", answer: text };
  }
  const fenced = codeRanges(text);
  const openers = [...text.matchAll(OPENER)];
  const opened = new Set(openers.map((match) => match[1]!));
  const cuts: Span[] = [];
  const reasoning: string[] = [];
  // Where the envelope being read ends: an opening inside one is reasoning, not a second envelope.
  let consumed = 0;
  for (const match of openers) {
    const at = match.index;
    const name = match[1]!;
    if (at < consumed || inSpans(fenced, at) || !startsLine(text, at)) continue;
    const start = at + match[0].length;
    const closer = closerOf(name);
    const closed = findCloser(text, start, closer, fenced);
    // An envelope nothing closed yet is the message still being written: everything it has said
    // since the opening is its thinking, and it has not started answering.
    if (closed === -1) {
      reasoning.push(text.slice(start));
      cuts.push([at, text.length]);
      consumed = text.length;
      break;
    }
    reasoning.push(text.slice(start, closed));
    cuts.push([at, closed + closer.length]);
    consumed = closed + closer.length;
  }
  // A closing tag whose opening is not in this message — the model echoed across steps, or the
  // provider's stream cut the opening — is dropped rather than drawn. A message that opens an
  // envelope *anywhere* is a message about the vocabulary (a bug report, a patch), and its closing
  // tags are part of what it is saying. Each envelope is read on its own: a step that thought in
  // `<thought>` still has no `previous_reasoning` opener, and its stray closer is markup.
  for (const name of ENVELOPES) {
    if (opened.has(name)) continue;
    const closer = closerOf(name);
    for (let at = text.indexOf(closer); at !== -1; at = text.indexOf(closer, at + closer.length)) {
      if (inSpans(fenced, at)) continue;
      cuts.push([at, at + closer.length]);
    }
  }
  // A mention of the vocabulary that opened nothing and closed nothing is the text it was, byte for
  // byte: trimming it here would rewrite an answer for saying the word.
  if (cuts.length === 0) return { reasoning: "", answer: text };
  return { reasoning: reasoningText(reasoning), answer: without(text, cuts).trim() };
}

/** The reasoning pieces as one stretch of thinking, the way adjacent thoughts are joined. */
function reasoningText(pieces: readonly string[]): string {
  return pieces
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "")
    .join("\n\n");
}

/**
 * One step's reasoning and its answer, as both of its channels state them.
 *
 * The two readings are independent — a model does one or the other, and most do neither — so each
 * side is whatever it found, and a step with no envelope in either channel comes back byte for byte.
 */
export function readModelReasoning(text: string, thinking: string): ReasoningEcho {
  const echo = splitReasoningEcho(text);
  const answer = withoutThinkingMarkers(echo.answer);
  const read = splitThinkingMarker(thinking);
  return {
    reasoning: joinSections(read.reasoning, echo.reasoning),
    // The answer channel is the engine's own split, so it is the answer whenever it says anything;
    // a model that streamed its answer into the reasoning channel left it empty.
    answer: answer.trim() === "" ? read.answer : answer,
  };
}

/**
 * A step's reasoning and the answer that followed its transition marker, read out of its thinking.
 *
 * Some models do not hand the engine two channels: they stream every token into the reasoning one
 * and write `</thinking>` where the reasoning ends and the answer begins. The engine records what
 * the stream said, so the answer arrives as the tail of the thinking — the fold draws the step's
 * whole answer, and the bubble under it stays empty (measured 2026-11-01 on `me/deepseek-v4.1-flash`
 * through `openai-completions`: 142 recorded steps carry the closer between 2026-10-26 and
 * 2026-10-31, 15 of them with the answer after it, 127 with nothing after it, and not one
 * `<thinking>` opener).
 *
 * The channel is read the way the text channel's envelope is read: before the first closer is
 * thinking, after it is the answer, and the marker itself is neither. Only a closer that reads as
 * the transition counts — one outside code, with the answer beginning right after it — because a
 * step *writing about* the marker says `</thinking>` in prose too, and taking that for a transition
 * publishes the rest of its thinking as its answer.
 */
export function splitThinkingMarker(thinking: string): ReasoningEcho {
  if (!thinking.includes("thinking")) return { reasoning: thinking, answer: "" };
  const code = codeRanges(thinking);
  const closer = [...thinking.matchAll(THINKING_MARKER)].find((match) => {
    if (match[1] !== "/") return false;
    const at = match.index ?? 0;
    return !inSpans(code, at) && beginsAnswer(thinking, at + match[0].length);
  });
  if (closer === undefined) {
    // No transition: the thinking is handed back untouched, so a step discussing the markers — and a
    // channel a model marks with an opener alone — reads as it wrote it.
    return { reasoning: thinking, answer: "" };
  }
  const at = closer.index ?? 0;
  return {
    reasoning: withoutThinkingMarkers(thinking.slice(0, at)),
    answer: withoutThinkingMarkers(thinking.slice(at + closer[0].length)),
  };
}

/**
 * What may not stand on either side of a transition marker.
 *
 * A marker that ends a step's reasoning falls where a thought stopped and an answer starts: the
 * character before it belongs to that last thought (`Let me write and run.`) and the character after
 * it opens the first word of the answer (`是`, `Starting…`, `## Docs`). A step writing *about* the
 * marker instead has it inside a sentence — `the \`</thinking>\` tag`, `writes </thinking> in the
 * text channel` — so quoted, spaced, or bracketed neighbours are the tell, and only the end of the
 * message is accepted on the following side with nothing there at all.
 */
const CONTINUING = /^[\s\\"'`<([{*_~,.;:!?…、，。；：！？）】」』]/;
const QUOTED = /[\s\\"'`<([{*_~]$/;

/** Whether the text at `from` opens an answer rather than continuing the sentence around it. */
function beginsAnswer(text: string, from: number): boolean {
  const next = text[from];
  if (next === undefined) return true;
  if (CONTINUING.test(next)) return false;
  const previous = text[from - 1] ?? "";
  return !QUOTED.test(previous);
}

/** The first closing tag at or after `from` that is not inside a fenced block, or -1. */
function findCloser(text: string, from: number, closer: string, fenced: readonly Span[]): number {
  for (let at = text.indexOf(closer, from); at !== -1; at = text.indexOf(closer, at + closer.length)) {
    if (!inSpans(fenced, at)) return at;
  }
  return -1;
}

/**
 * The text without the reasoning block's markers, and with the line they left trimmed.
 *
 * The marker is the model's markup, not something it thought, so it goes wherever it stands —
 * including the answer channel, where two recorded steps ended an answer with a stray closer. A
 * text with no marker is handed back as it was, which is what lets a step that wrote no envelope
 * reach the transcript byte for byte.
 */
function withoutThinkingMarkers(text: string): string {
  if (!text.includes("thinking")) return text;
  const code = codeRanges(text);
  const cuts: Span[] = [];
  for (const match of text.matchAll(THINKING_MARKER)) {
    const at = match.index ?? 0;
    if (!inSpans(code, at)) cuts.push([at, at + match[0].length]);
  }
  return cuts.length === 0 ? text : without(text, cuts).trim();
}

/** Two stretches of one message's words, kept as they were when the other is empty. */
function joinSections(first: string, second: string): string {
  if (first === "") return second;
  if (second === "") return first;
  return `${first.trim()}\n\n${second.trim()}`;
}

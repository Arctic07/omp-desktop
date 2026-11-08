/**
 * The engine's `<irc>` envelope, read back into the message it carries.
 *
 * A peer agent talks to this session over IRC, and the engine delivers that message as a message
 * body wrapped in `<irc>` (`prompts/system/irc-incoming.md`): who wrote it, what they said, whether
 * it arrived mid-turn, and the instruction to the model about how to answer. Drawn as prose the
 * wrapper is a wall of angle brackets around a peer's words — the same problem `system-notice.ts`
 * solves for the engine's other wrappers, which is why that module hands this one the block's body.
 *
 * The facts come from two places, and this module keeps them apart rather than guessing:
 *
 * - **The wrapper's first line** names the sender (`Incoming IRC message from agent `x``), and the
 *   parenthesised `(reply to y)` beside it names the message being answered.
 * - **The body** is the peer's own words. The engine writes up to two sentences of its own around
 *   them, each the whole of one paragraph, and each is recognised by the template it is written
 *   from. They are read out of the body so the card can state the one that matters in the reader's
 *   language instead of drawing the engine's English at the reader.
 *
 * Only whole paragraphs leave, and only from the ends: a peer that *quotes* one of these sentences
 * has its quotation in the middle of its own words, where it survives as the peer's text.
 *
 * Nothing here is drawn: `components/agents/irc-message.tsx` decides what to show. A block whose
 * first line is not this header answers `null`, and the caller draws the block as it always did.
 */

/** Who wrote a relayed message, and what the engine said around it. */
export interface ParsedIrcMessage {
  /** The sending agent's id, as the wrapper's first line names it. Empty when it named none. */
  from: string
  /** The message this one answers, when the engine wrote a `(reply to …)` beside the sender. */
  replyTo: string | null
  /** The peer's own words, with the engine's own sentences taken off both ends. */
  body: string
  /**
   * Whether the engine said it arrived while the turn was working. That is why the turn above this
   * row stopped mid-step, so it is the one engine sentence the card still has to say.
   */
  interrupting: boolean
}

/** `Incoming IRC message from agent `x` (reply to y):` — the wrapper's own first line. */
const HEADER = /^Incoming IRC message from agent\s+`([^`]*)`(?:\s*\(reply to\s+([^)]*)\))?\s*:\s*$/i

/**
 * The sentences the engine writes around a peer's words, each matched whole.
 *
 * Whole, not by prefix: a peer that writes *about* one of them ("if you see a sentence saying …")
 * is quoting, and a quotation has to survive as the peer's text.
 */
const INTERRUPTING =
  /^Sent while waiting\/working\. Active interruptible wait stopped early for immediate reading\.$/
const REPLY_NOW =
  /^If response expected, reply via `write` \(`path: "agent:\/\/[^"]*"`, `content: "…"`\); may finish current step first\. No one replies on your behalf\.$/
const REPLY_ON_STOP =
  /^If response expected, reply via `write` \(`path: "agent:\/\/[^"]*"`, `content: "…"`\), when available; otherwise what you `yield` or say last this turn is delivered to `[^`]*` when you stop\.$/

/** Every sentence the engine wrote for the model rather than for the reader. */
const INSTRUCTIONS: readonly RegExp[] = [INTERRUPTING, REPLY_NOW, REPLY_ON_STOP]

/**
 * The message in this `<irc>` block's own text, or `null` when it is not one.
 *
 * `text` is the block's content with the tags already off (`splitSystemNotices` hands it over that
 * way). A block whose first line is not the header is not a message — a quotation, or a shape this
 * build does not know — and the caller draws it as text.
 */
export function parseIrcMessage(text: string): ParsedIrcMessage | null {
  const lines = text.trim().split('\n')
  const header = HEADER.exec((lines[0] ?? '').trim())
  if (header === null) {
    return null
  }
  const paragraphs = lines
    .slice(1)
    .join('\n')
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
  let interrupting = false
  // Backwards, so the engine's trailing sentences leave before the body between them is read. A
  // paragraph the engine wrote is never the peer's words, whichever end it is found at.
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const paragraph = paragraphs[index] ?? ''
    const sentence = INSTRUCTIONS.find((pattern) => pattern.test(paragraph))
    if (sentence === undefined) continue
    if (sentence === INTERRUPTING) interrupting = true
    paragraphs.splice(index, 1)
  }
  const replyTo = header[2]?.trim() ?? ''
  return {
    from: header[1]?.trim() ?? '',
    replyTo: replyTo === '' ? null : replyTo,
    body: unescapeHarnessTags(paragraphs.join('\n\n').trim()),
    interrupting,
  }
}

/**
 * The peer's words as they were written, from the envelope the engine escaped them into.
 *
 * A message body is agent-authored, so the engine escapes the `<` of every harness tag in it before
 * wrapping it (`session/harness-tags.ts::escapeHarnessTags`), which is what stops a peer from closing
 * the block it is rendered inside or forging a parent's steer. The reader is not the model, though:
 * the entity is not a fact about the message, and a peer that wrote `a < b` would otherwise be
 * quoted as `a &lt; b`. Only the harness tag names come back, exactly the set that was escaped —
 * every other `&lt;` is the peer's own text and stays as it was.
 */
function unescapeHarnessTags(text: string): string {
  return text.replace(/&lt;(?=\s*\/?\s*(?:irc|system-[a-z][a-z-]*)(?![\w-]))/gi, '<')
}

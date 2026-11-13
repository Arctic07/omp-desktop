/**
 * Auto continue: when a *remote* interruption ends a turn before any answer exists, resend
 * "继续" (or "continue", following the operator's language) so the work resumes.
 *
 * Every turn settle is classified once (`classifyTurn`) and only one class continues. The classes
 * exist because "the turn stopped" is not one fact:
 *
 * - **`normal`** — the model finished (`stop`), handed off to tools (`toolUse`), hit its output cap
 *   (`length`), or the failure arrived after the answer was already delivered. Nothing to resume.
 * - **`user-stop`** — the operator stopped the turn (`aborted`), or the process running it went away
 *   (`Previous OMP process exited before completing the turn.`). A decision the user made is never
 *   overridden, and a dead process has no session left to continue in.
 * - **`reconnect`** — the transport is healing itself: the engine announced a retry
 *   (`auto_retry_start`), or the error text says it is reconnecting. The retry is the engine's own
 *   recovery and a prompt sent into it would race the resume, so this class never continues —
 *   including the retry whose budget ran out, because those attempts already were the reconnect.
 * - **`unrepairable`** — credentials, quota, rate limiting, an invalid request or model, an
 *   over-long context, a local endpoint that is not running, or an error this build cannot read as
 *   transport. Another turn cannot fix any of them.
 * - **`remote`** — the provider or its transport died mid-answer: a stream cut, a socket reset, an
 *   HTTP/2 reset, a gateway close with no terminal frame, a stalled or truncated stream, a provider
 *   5xx/internal answer, or a provider finish reason that ended the turn without a normal stop. This
 *   is the only class the plugin acts on.
 *
 * Two conditions belong to `remote` itself:
 *
 * - **No answer text may have been delivered.** A failure after committed text is the engine's own
 *   mid-stream transport class to resume, and a second delivery would duplicate what the reader has.
 *   Tool-call markup a provider leaked into the body is not an answer: the text is cut at the first
 *   leaked tag, and what precedes it still counts as delivered.
 * - **The settle must be terminal.** `willContinue` / `awaitingAsyncWork` means a retry, compaction,
 *   or background result is still scheduled.
 *
 * The prompt goes through the engine (`sendUserMessage`), not the desktop composer: an idle session
 * starts a new turn, so text already typed in the composer is untouched. It is attributed to the
 * agent, which keeps it out of the conversation title and out of the operator's own prompts.
 *
 * Bounded: at most `MAX_CONSECUTIVE` automatic continuations between two operator prompts, so a
 * provider that keeps failing stops instead of looping. An operator prompt, or a terminal turn that
 * did not fail, resets the budget.
 */

const CONTINUE_TEXT_ZH = "继续"
const CONTINUE_TEXT_EN = "continue"
const MAX_CONSECUTIVE = 3
/** Let the failed prompt unwind before starting the next turn. */
const CONTINUE_DELAY_MS = 900

/** Any Han character in the operator's own prompt means they are working in Chinese. */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** The engine's own record of a turn the process died under (`exit-diagnostics.ts`), lowercased. */
const INTERRUPTED_TURN_ERROR = "previous omp process exited before completing the turn"

/**
 * Failure text a new turn cannot repair: bad credentials, exhausted quota, rate limiting, an invalid
 * request or model, an over-long context, or a local endpoint that is not running. Checked before the
 * remote patterns, so a message naming both is never read as a remote interruption.
 */
const UNREPAIRABLE_PATTERNS: readonly RegExp[] = [
  /\b(?:400|401|402|403|404|429)\b/i,
  /invalid (?:api )?key|invalid token|unauthorized|forbidden|authentication/i,
  /api key|credential/i,
  /insufficient(?:[_\s]balance)?|quota|credits? (?:exhausted|used up)|credit package|rate limit|frequency limit|usage exceeds/i,
  /context (?:window|length|limit)|maximum context|prompt is too long|token limit|max_tokens/i,
  /invalid (?:model|request)|model not found|no such model/i,
  /127\.0\.0\.1|localhost|connection refused/i,
]

/**
 * The transport healing itself. A reconnection is not a failed turn: the engine retries it, and a
 * prompt sent into that retry races the resume. Checked before the remote patterns, because a
 * reconnect notice usually carries the transport wording too.
 */
const RECONNECT_PATTERNS: readonly RegExp[] = [
  /re-?connect(?:ing|ed|ion)?\b/i,
  /will retry|retrying|retry attempt|attempt \d+ of \d+/i,
  /stream (?:is )?(?:being )?resumed|resuming (?:the )?stream/i,
]

/**
 * Failure text a provider or its transport produces: a stream cut, a socket reset, an HTTP/2 reset, a
 * gateway closing without a terminal frame, a stalled or truncated stream, a provider 5xx/internal
 * answer, and a provider finish reason that ends the turn without a normal stop.
 */
const REMOTE_PATTERNS: readonly RegExp[] = [
  /socket connection (?:was )?closed|socket closed|econnreset|connection reset|broken pipe/i,
  /error reading stream|read tcp|write tcp|premature (?:close|stream)/i,
  /stream (?:stalled|timed out|error|ended|interrupted|envelope|truncated|reset|stall)/i,
  /upstream (?:response )?stream|upstream http\/2|http\/2 stream|terminal chunk|no terminal event/i,
  /connection lost|connection closed|network (?:error|failure)|fetch failed/i,
  /finish_reason|content[_ ]filter|internal[_ ]error/i,
  /service temporarily unavailable|bad gateway|gateway timeout|overloaded|(?:^|\s)(?:500|502|503|504)(?:\s|$)/i,
  /thinking loop detected/i,
]

/**
 * Markup that is not an answer.
 *
 * Three shapes, three rules, because they are three different facts:
 *
 * - **A body that opens with a tag is an envelope.** The provider wrote a call, or wrapped the
 *   model's own reasoning (`<analysis>`, `<thinking>`) where an answer belongs; either way the
 *   reader was given nothing. This covers every dialect without naming a tool, including the legacy
 *   spelling whose root element is the tool's own name.
 * - **A tool-call envelope takes the rest of the body with it.** After `<tool_calls>` /
 *   `<function_calls>` / `<invoke>` / `<parameter>` the text is an argument, not prose, so the cut is
 *   where the answer ends. The names are the protocol's own closed set — the same grammar the desktop
 *   reads (`src/src/home/tool-call-markup.ts`) — not a list of tools.
 * - **Any other tag is markup inside prose.** `修好了 <div> 的样式` delivered its words; the tag goes
 *   and the words stay, so a reply that merely mentions markup is still an answer.
 */
const MARKUP_TAG = /<\/?[A-Za-z_|｜][\w.:|｜-]*(?:\s[^<>]*)?>/g
/** A body that begins with a tag is an envelope rather than an answer. */
const OPENS_WITH_TAG = /^\s*<\/?[A-Za-z_|｜!]/
/** The protocol's tool-call element names, with DeepSeek's optional `｜DSML｜` delimiter. */
const ENVELOPE_OPENER =
  /<\/?(?:[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*)?(?:tool_calls|tool_call|function_calls|invoke|parameter)\b[^<>]*>/i

interface ContentBlock {
  type: string
  text?: string
}

interface Message {
  role?: string
  stopReason?: string
  errorMessage?: string
  content?: readonly ContentBlock[]
  synthetic?: boolean
  attribution?: "user" | "agent"
}

interface AgentEndEvent {
  type: "agent_end"
  messages: readonly Message[]
  willContinue?: boolean
  awaitingAsyncWork?: boolean
}

interface MessageStartEvent {
  type: "message_start"
  message: Message
}

interface SessionShutdownEvent {
  type: "session_shutdown"
}

interface AutoRetryStartEvent {
  type: "auto_retry_start"
  attempt: number
  maxAttempts: number
  errorMessage: string
}

interface ExtensionContext {
  agent?: { kind?: string }
  hasPendingMessages(): boolean
  isIdle(): boolean
  sessionManager: { getSessionId(): string }
}

interface Logger {
  warn(message: string, details?: unknown): void
}

interface ExtensionApi {
  logger: Logger
  on(event: "agent_end", handler: (event: AgentEndEvent, ctx: ExtensionContext) => void): void
  on(event: "message_start", handler: (event: MessageStartEvent, ctx: ExtensionContext) => void): void
  on(event: "auto_retry_start", handler: (event: AutoRetryStartEvent) => void): void
  on(event: "session_shutdown", handler: (event: SessionShutdownEvent) => void): void
  sendUserMessage(content: string, options?: { attribution?: "user" | "agent" }): Promise<void>
}

/**
 * The answer a message actually delivered: its text blocks with leaked tool-call markup removed.
 * Empty means the turn never produced an answer the reader could see.
 */
/**
 * The spans of `text` that are code: fenced blocks and inline backticks.
 *
 * A message that shows markup inside a fence is showing an example of it, so a tag there is prose the
 * reader was given. The desktop's reader (`src/src/home/code-ranges.ts`) is the same rule, and this
 * extension cannot import it - a plugin is loaded from its own directory - so the rule is restated
 * in its smallest form: an unterminated fence runs to the end, because a block still being streamed
 * is code too.
 */
function codeSpans(text: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = []
  let open = -1
  let offset = 0
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      if (open === -1) open = offset
      else {
        spans.push([open, offset + line.length])
        open = -1
      }
    }
    offset += line.length + 1
  }
  if (open !== -1) spans.push([open, text.length])
  for (const match of text.matchAll(/`[^`\n]*`/g)) {
    const at = match.index ?? 0
    if (!spans.some(([start, end]) => at >= start && at < end)) {
      spans.push([at, at + match[0].length])
    }
  }
  return spans
}

/** Whether `at` falls inside one of the spans. */
function inCode(spans: readonly (readonly [number, number])[], at: number): boolean {
  return spans.some(([start, end]) => at >= start && at < end)
}

export function deliveredText(message: Message): string {
  const blocks = message.content ?? []
  let text = ""
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") text += block.text
  }
  const code = codeSpans(text)
  // A body that begins with a tag outside code is an envelope rather than an answer.
  const opening = OPENS_WITH_TAG.exec(text)
  if (opening !== null && !inCode(code, opening.index)) return ""
  const envelope = ENVELOPE_OPENER.exec(text)
  const kept = envelope === null || inCode(code, envelope.index) ? text : text.slice(0, envelope.index)
  return kept
    .replace(MARKUP_TAG, (tag: string, offset: number) =>
      inCode(code, offset) ? tag : " ",
    )
    .trim()
}

/** What ended one turn, as this plugin reads it. Only `remote` is acted on. */
export type TurnOutcome =
  | "remote"
  | "reconnect"
  | "user-stop"
  | "unrepairable"
  | "normal"

/**
 * The prose one run delivered: every assistant step the operator has seen since their last prompt.
 *
 * A run is several steps, and "the answer came out" is a fact about the run rather than about the
 * step that failed last. A run whose earlier step printed a reply and whose final step died empty
 * gave the reader words — continuing there would duplicate them, and would race the new instruction
 * the operator is already typing.
 */
export function runDeliveredText(messages: readonly Message[]): string {
  let start = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && isOperatorPrompt(message)) {
      start = index + 1
      break
    }
  }
  let text = ""
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role === "assistant") text += deliveredText(message)
  }
  return text.trim()
}

/**
 * What ended one turn. Exported so a caller can read — and test — the whole decision without an
 * engine, and so each class is pinned on its own instead of through a chain of exclusions.
 *
 * `retried` is the caller's own fact: whether the engine announced a retry for this turn
 * (`auto_retry_start`). It outranks the error text, because a retried turn is a reconnection the
 * engine already performed — including the one whose retry budget ran out.
 *
 * `runText` is what the whole run delivered (`runDeliveredText`): a failure is only worth resuming
 * when the run said nothing at all, which is the condition the plugin exists for.
 */
export function classifyTurn(
  message: Message,
  retried = false,
  runText = deliveredText(message),
): TurnOutcome {
  if (message.stopReason !== "error") {
    // `aborted` is the operator's stop, or a process that went away; the rest finished normally.
    return message.stopReason === "aborted" ? "user-stop" : "normal"
  }
  const error = (message.errorMessage ?? "").trim()
  if (error === "") return "normal"
  if (error.toLowerCase().includes(INTERRUPTED_TURN_ERROR)) return "user-stop"
  if (retried) return "reconnect"
  if (RECONNECT_PATTERNS.some((pattern) => pattern.test(error))) return "reconnect"
  if (UNREPAIRABLE_PATTERNS.some((pattern) => pattern.test(error))) return "unrepairable"
  if (!REMOTE_PATTERNS.some((pattern) => pattern.test(error))) return "unrepairable"
  return runText === "" ? "remote" : "normal"
}

/** The continue word in the operator's own language. */
export function continueText(operatorText: string): string {
  return CJK_PATTERN.test(operatorText) ? CONTINUE_TEXT_ZH : CONTINUE_TEXT_EN
}

function lastAssistant(messages: readonly Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") return messages[index]
  }
  return undefined
}

/** A prompt the operator wrote, as opposed to one this plugin or another extension sent. */
export function isOperatorPrompt(message: Message): boolean {
  return (
    message.role === "user" &&
    message.synthetic !== true &&
    message.attribution !== "agent"
  )
}

/** The last prompt the operator wrote, which decides the language of the continuation. */
export function lastOperatorText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && isOperatorPrompt(message)) return deliveredText(message)
  }
  return ""
}

export default function autoContinue(pi: ExtensionApi): void {
  let consecutive = 0
  let cancel: (() => void) | undefined
  let dormant = false
  /** Whether the engine announced a retry since the last operator prompt. */
  let retried = false
  /** The latest operator prompt seen live, kept when a resumed conversation has none in the run. */
  let operatorText = ""

  const scheduleContinue = (callback: () => void): void => {
    const handle = setTimeout(callback, CONTINUE_DELAY_MS)
    cancel = () => clearTimeout(handle)
  }

  pi.on("session_shutdown", () => {
    dormant = true
    cancel?.()
    cancel = undefined
  })

  // The engine's own retry loop is the reconnection. Once it ran in a turn, no terminal error of
  // that same turn earns a second attempt from this plugin — a retry that gave up already spent its
  // attempts, and one that succeeded resumed the turn. The mark lives until the turn ends or the
  // operator prompts again.
  pi.on("auto_retry_start", () => {
    retried = true
  })

  pi.on("message_start", (event) => {
    // The operator is driving again: their prompt resets the budget and the retry memory, and sets
    // the language.
    const message = event.message
    if (isOperatorPrompt(message)) {
      consecutive = 0
      retried = false
      cancel?.()
      cancel = undefined
      operatorText = deliveredText(message)
    }
  })

  pi.on("agent_end", (event, ctx) => {
    if (dormant) return
    // Subagents share the engine's event names; a continuation there would be a second loop under
    // the parent's, and the parent already sees the failure.
    if (ctx.agent?.kind !== "main") return
    // A retry, compaction, or background result is still scheduled: this settle is not terminal.
    if (event.willContinue === true || event.awaitingAsyncWork === true) return

    const last = lastAssistant(event.messages)
    const outcome =
      last === undefined
        ? "normal"
        : classifyTurn(last, retried, runDeliveredText(event.messages))
    if (outcome !== "remote") {
      // Any other ending supersedes a continuation this plugin was about to send, and proves the
      // previous one worked. A reconnection keeps the budget, because the retry it names is not this
      // plugin's attempt; every other ending resets it.
      if (outcome !== "reconnect") consecutive = 0
      retried = false
      cancel?.()
      cancel = undefined
      return
    }
    if (consecutive >= MAX_CONSECUTIVE) {
      pi.logger.warn("auto-continue: the remote failure budget is spent for this operator prompt")
      return
    }
    // A prompt the operator already queued will start a turn on its own; adding another would
    // answer a request they did not make and race their message.
    if (ctx.hasPendingMessages() || !ctx.isIdle()) return

    const sessionId = ctx.sessionManager.getSessionId()
    const text = continueText(operatorText || lastOperatorText(event.messages))
    consecutive += 1
    retried = false
    cancel?.()
    cancel = undefined
    scheduleContinue(() => {
      cancel = undefined
      if (dormant) return
      if (ctx.sessionManager.getSessionId() !== sessionId) return
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return
      // Deliberately not awaited: `agent_end` notifications have a 30 s handler budget, and a whole
      // new turn can take longer. The promise's rejection is the only thing this needs.
      void pi.sendUserMessage(text, { attribution: "agent" }).catch((error: unknown) => {
        pi.logger.warn("auto-continue: the continuation prompt was not admitted", {
          error: String(error),
        })
      })
    })
  })
}

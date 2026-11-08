/**
 * Adopting a context compaction an upstream endpoint performed on its own.
 *
 * A conversation can outgrow the *served* window of a relay or gateway while the model still
 * declares a larger one, and some of those endpoints do not fail the request: they replace it with
 * a "summarize this conversation" instruction and return the summary as the completion. Nothing in
 * this application did anything about that, so the summary arrived as an ordinary assistant turn
 * with no tool calls, the turn ended there, and the next prompt re-sent the same oversized
 * history - every turn answered with another summary (measured 2026-11-01, one session at 456k,
 * 488k and 504k cached tokens on a model declared at 1,000,000).
 *
 * The engine's own compaction cannot be the answer for that arrival: it summarizes from a
 * `completeSimple` side call, so a summary the model already wrote is not one of its values, and
 * its threshold sits at 85% of the *declared* window (850,000 here), which is above the point the
 * endpoint cut in. Asking the engine to summarize again would spend the same oversized prompt a
 * second time.
 *
 * So the summary the endpoint returned is adopted as this conversation's compaction summary: the
 * engine is asked to compact with an armed summary, its `session_before_compact` hook hands the
 * text back in place of a summarizer call, and the rewrite lands through the engine's own commit
 * path - one entry on the branch, the archived span replaced, every message still readable in the
 * transcript. The turn then continues from the compacted context with the engine's own
 * auto-continue nudge, which is what the caller asked for: adapt to the return, move the context,
 * keep going.
 *
 * What decides that a reply is such a summary, in order:
 *
 * - it is the last settled assistant message, text only - one tool call and this was work;
 * - its text carries the `<summary>` envelope a compaction instruction asks for (with an
 *   `<analysis>` block or the numbered section headings), not a plain prose answer;
 * - the message before it is a `toolResult`. A user who asks for a summary gets one right after
 *   their own message, and that answer is theirs to read - it is never turned into a compaction;
 * - the conversation is idle. A live turn is left alone; its own ending re-runs this check.
 *
 * A turn the engine pauses for background work ends on `agent_end` tagged `awaitingAsyncWork`: the
 * job's report resumes it. That is still an ending a summary can arrive on, and the one where
 * adopting matters most - the resumed turn would otherwise re-send the history the endpoint just
 * refused - so it is adopted there too, without the resume nudge, which the pending wake already
 * owns (measured 2026-11-01: a conversation with a background job running ended on a summary, the
 * terminal-only gate skipped it, and the job's result resumed the turn on the un-compacted branch).
 *
 * State is per host process, keyed by routing id, and bounded: one armed summary per conversation
 * (consumed by the hook that reads it) and one cooldown stamp that keeps a conversation which
 * keeps arriving at this from compacting on every single turn.
 */

import { logError, logLine } from './log.ts'
import type { ExtensionFactory, SessionEntry } from './sdk.ts'
import type { LiveSession } from './sessions.ts'

/**
 * The section headings a compaction instruction asks for.
 *
 * Read only as evidence that the text is a summary document rather than ordinary prose: the
 * endpoint's own prompt is not this repository's, so the check is on the shape it produces, and a
 * reply with three of these sections is one whatever wording surrounded them.
 */
const SUMMARY_SECTIONS = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Files and Code Sections',
  'Errors and fixes',
  'Problem Solving',
  'All user messages',
  'Pending Tasks',
  'Current Work',
  'Optional Next Step',
]

/** How many sections make the text a summary rather than a mention of one. */
const SECTION_THRESHOLD = 3

/** Shortest text worth adopting: a handoff for a long conversation is longer than this. */
const MIN_SUMMARY_CHARS = 200

/** One adoption per conversation per window; a conversation that keeps hitting the endpoint waits. */
const ADOPTION_COOLDOWN_MS = 30_000

/** How long an adoption waits for the engine to finish settling the turn that ended. */
const DEFAULT_SETTLE_MS = 5_000

/** One poll of the settle wait; short enough to act the moment the engine is idle. */
const SETTLE_INTERVAL_MS = 50

/** Summary text waiting for the next `session_before_compact` of one conversation. */
const armed = new Map<string, string>()

/** When each conversation last adopted, in epoch ms. */
const adoptedAt = new Map<string, number>()

/**
 * The summary inside an upstream compaction reply, or `undefined` when the text is not one.
 *
 * Pure, so the shape rules are testable without a session: the `<summary>` pair is required and
 * its body must be substantial, and the reply must show the summarizer's own scaffolding - the
 * `<analysis>` block the instruction asks for before the summary, or enough of the numbered
 * section headings to be a summary document.
 */
export function upstreamSummaryBody(text: string): string | undefined {
  const open = text.indexOf('<summary>')
  const close = text.lastIndexOf('</summary>')
  if (open < 0 || close <= open) return undefined
  const body = text.slice(open + '<summary>'.length, close).trim()
  if (body.length < MIN_SUMMARY_CHARS) return undefined
  if (text.includes('<analysis>')) return body
  const sections = SUMMARY_SECTIONS.filter(section => text.includes(section)).length
  return sections >= SECTION_THRESHOLD ? body : undefined
}

/**
 * The settled assistant message, narrowed to the two fields that decide this.
 *
 * Taken as a shape rather than the engine's own message type so the rules can be exercised without
 * a session, exactly as `session-prompt.ts` narrows the engine session it delivers into.
 */
export interface SettledReply {
  readonly role: string
  readonly stopReason: string
  readonly content: readonly (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: string }
  )[]
}

/**
 * The compaction summary this conversation's last turn ended on, if it ended on one.
 *
 * Read from the branch alone - the transcript as written - and only when the branch *ends* on the
 * reply: the tip is what says this is the turn's last word rather than a summary somewhere in the
 * middle of a turn that carried on.
 *
 * What the reply answered decides whether it is the endpoint's compaction or the reader's own
 * answer. After a `toolResult` it is the endpoint's: nothing in the conversation asked for a
 * summary there, and the summary is the work the reader was waiting for being replaced. After the
 * reader's own message it is a summary the reader asked for - unless that message asked for
 * something else, which is the case the first report of this defect was: a follow-up prompt
 * answered with a compaction summary, and the whole oversized history re-sent on the next one.
 */
export function upstreamSummaryOf(branch: readonly SessionEntry[]): string | undefined {
  const last = branch.at(-1)
  if (last === undefined || last.type !== 'message') return undefined
  const reply = last.message as SettledReply
  if (reply.role !== 'assistant' || reply.stopReason !== 'stop') return undefined
  if (reply.content.some(block => block.type === 'toolCall')) return undefined
  const text = reply.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
  if (text.length === 0) return undefined
  const before = branch.at(-2)
  if (before?.type !== 'message') return undefined
  const role = (before.message as { role?: unknown }).role
  if (role === 'user' && asksForSummary(before.message)) return undefined
  if (role !== 'toolResult' && role !== 'user') return undefined
  return upstreamSummaryBody(text)
}

/**
 * The words a reader uses when the summary *is* what they asked for.
 *
 * The one case this must not swallow: a reader who types "总结一下" gets an answer shaped exactly
 * like the endpoint's compaction, and turning their answer into a context rewrite plus an
 * unrequested turn would be worse than leaving it. Deliberately broad - a false negative only
 * means one summary is drawn as prose, a false positive means the endpoint's compaction goes
 * unadopted.
 */
const SUMMARY_REQUEST = /总结|摘要|汇总|概括|精简|梳理|compact|summar|recap|handoff/i

/** Whether one user message asked for a summary, so its answer is theirs and not a compaction. */
function asksForSummary(message: object): boolean {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return SUMMARY_REQUEST.test(content)
  if (!Array.isArray(content)) return false
  return content.some(
    block =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      SUMMARY_REQUEST.test(String((block as { text?: unknown }).text ?? '')),
  )
}

/**
 * The extension that hands an armed summary back to the engine's compaction.
 *
 * `session_before_compact` is the engine's own seam for a summarizer an embedder already has
 * (`session-maintenance.ts` `#prepareCompactionFromHooks`): a returned `compaction` is committed
 * verbatim, with no model call, and the cut point and token count come from the preparation the
 * event carries. The arm is consumed on read, so a compaction the user runs themselves - or a
 * second pass of the same adoption - falls through to the engine's configured method.
 */
export function upstreamCompactionExtension(sessionId: string): ExtensionFactory {
  return pi => {
    pi.on('session_before_compact', event => {
      const summary = armed.get(sessionId)
      if (summary === undefined) return undefined
      armed.delete(sessionId)
      return {
        compaction: {
          summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: { kind: 'upstream-compaction', version: 1 },
        },
      }
    })
  }
}

/**
 * Waits until the engine is idle, or the wait runs out.
 *
 * This is triggered by the engine's own `agent_end`, which can arrive while its settle-time passes -
 * the compaction check, a stop-time reminder, a queued continuation - are still unwinding
 * (`agent-session.ts` `#flushPendingAgentEnd` defers exactly that). Compacting into them would cut
 * work the engine is in the middle of, and there is no second ending to come back on, so the wait
 * lives here rather than a re-check there. Bounded: a turn that never settles is not something this
 * may wait on, and giving up says so in the log.
 */
async function waitForSettle(live: LiveSession, settleMs: number): Promise<boolean> {
  const deadline = Date.now() + settleMs
  for (;;) {
    if (!live.agent.isStreaming && !live.agent.isCompacting && !live.agent.hasPostPromptWork) return true
    if (Date.now() >= deadline) return false
    await new Promise<void>(resolve => setTimeout(resolve, SETTLE_INTERVAL_MS))
  }
}

/** Whether this conversation is past the point where a second adoption is worth making. */
function cooledDown(live: LiveSession): boolean {
  const previous = adoptedAt.get(live.sessionId)
  return previous === undefined || Date.now() - previous >= ADOPTION_COOLDOWN_MS
}

/**
 * Turns an endpoint's own summarization into this conversation's compaction, then resumes the turn.
 *
 * The compaction comes first and the continuation second: continuing on the unchanged history would
 * send the same oversized prompt back to the endpoint, which is the loop this exists to break. A
 * compaction that fails says so on the conversation's notice line instead of being thrown at the
 * caller - this runs after a turn the user is reading has already settled, so a summary they can
 * see is a better end than a silent error - and nothing continues on the history that was not
 * compacted. A conversation the engine will not cut is not a failure and is only logged.
 *
 * `continueAfter: false` is the paused ending: the engine owns the continuation there, so the
 * adoption commits the compaction and returns before the resume nudge.
 */
export async function adoptUpstreamCompaction(
  live: LiveSession,
  options: { settleMs?: number; continueAfter?: boolean } = {},
): Promise<boolean> {
  if (!cooledDown(live)) return false
  if (!(await waitForSettle(live, options.settleMs ?? DEFAULT_SETTLE_MS))) {
    logLine(
      `session ${live.sessionId} did not settle (streaming=${String(live.agent.isStreaming)}, ` +
        `compacting=${String(live.agent.isCompacting)}, postPrompt=${String(live.agent.hasPostPromptWork)}), ` +
        'so an upstream compaction was not adopted',
    )
    return false
  }
  let summary: string | undefined
  try {
    summary = upstreamSummaryOf(live.manager.getBranch())
  } catch (error) {
    logError('upstream compaction check failed', error)
    return false
  }
  if (summary === undefined) return false
  armed.set(live.sessionId, summary)
  try {
    await live.agent.compact(undefined, { suppressContinuation: true })
  } catch (error) {
    armed.delete(live.sessionId)
    // A conversation the engine will not cut - too small to have anything behind the retained tail,
    // or already ending on a compaction - is not a failure: there is nothing to adopt, and the
    // endpoint summarized a history this context does not carry.
    if (error instanceof Error && /Nothing to compact|Already compacted/.test(error.message)) {
      logLine(`session ${live.sessionId} has nothing the engine would compact, so the upstream summary was dropped`)
      return false
    }
    logError('upstream compaction not adopted', error)
    live.agent.emitNotice(
      'warning',
      `The endpoint compacted this conversation on its own, and adopting that summary failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'compaction',
    )
    return false
  }
  adoptedAt.set(live.sessionId, Date.now())
  logLine(`session ${live.sessionId} adopted an upstream compaction summary`)
  if (options.continueAfter === false) {
    // The engine is already holding this turn's continuation - a background job it is waiting on -
    // and resumes it when that job reports back. A nudge here would start a second turn beside it.
    live.agent.emitNotice(
      'info',
      'The endpoint compacted this conversation on its own; its summary is now this context and the pending background work continues the turn.',
      'compaction',
    )
    return true
  }
  live.agent.emitNotice(
    'info',
    'The endpoint compacted this conversation on its own; its summary is now this context and the turn continues.',
    'compaction',
  )
  try {
    // Synthetic: this is the engine's own continuation of a turn, not words the user typed, and
    // the transcript should not show a user message nothing wrote. `skipCompactionCheck` keeps the
    // engine's own threshold pass from running over a context that was just compacted.
    await live.agent.prompt(live.autoContinuePrompt.trim(), { synthetic: true, skipCompactionCheck: true })
  } catch (error) {
    logError('upstream compaction continuation failed', error)
    live.agent.emitNotice(
      'warning',
      `The turn after the adopted compaction could not be resumed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'compaction',
    )
  }
  return true
}

/** Drops one conversation's state when it is torn down. */
export function forgetUpstreamCompaction(sessionId: string): void {
  armed.delete(sessionId)
  adoptedAt.delete(sessionId)
}

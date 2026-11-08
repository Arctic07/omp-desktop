/**
 * One prompt's run: the `/`-command split, and the output its commands print.
 *
 * Split out of the session registry because the run is self-contained: it reads the record's
 * engine session and event pipe, and everything it needs from the registry is behind
 * {@link SessionPromptPort} - the lookup and the eviction sweep it triggers when it finishes.
 *
 * The acknowledgement contract lives here too: the caller is answered immediately (`accepted`)
 * while the run happens behind it, because a prompt's turn may be held back by the engine itself
 * (a running turn, image preparation), and a response that waited for it would look like a hang.
 */

import { MAX_PROMPT_BYTES } from './constants.ts'
import { logError } from './log.ts'
import { ERROR_CODES, HostError, invalidInput } from './protocol/errors.ts'
import { text } from './protocol/fields.ts'
import { noteLoopPrompt } from './loop-mode.ts'
import { clampCommandOutput, runSlashCommand } from './slash.ts'
import type { SlashCommandOptions } from './slash.ts'
import { callOffRelease } from './session-stop.ts'
import { emitSessionState } from './session-view.ts'
import type { AgentSession, SdkBundle } from './sdk.ts'
import type { LiveSession } from './sessions.ts'

/** What one prompt needs from the registry that owns the records. */
export interface SessionPromptPort {
  /** Engine services: what the prompt's `/`-command options are built against. */
  readonly sdk: SdkBundle
  /** Resolves the prompt's session id to the record it addresses, or refuses with `session_not_found`. */
  require: (sessionId: string) => LiveSession
  /** The registry's eviction sweep, asked for once a prompt finishes. */
  collect: () => void
  /** Rebuilds the session's advertised command list after a command changed it. */
  refreshCommands: (live: LiveSession) => Promise<void>
}

/**
 * What one prompt collects from the commands it runs: the parts printed while it was running, and
 * whether they have been published yet.
 *
 * The flag is the whole point: a command may hand its work to `runCommandInBackground` and report
 * afterwards, and those parts belong to no batch the prompt can still be holding.
 */
interface CommandOutput {
  readonly parts: string[]
  flushed: boolean
}

/** Streaming behaviours a prompt may declare while a turn is already running. */
const STREAMING_BEHAVIORS = ['steer', 'followUp', 'aside']

/** Images travel as the engine's own content parts; the host only checks their container shape. */
function imagesField(value: unknown): unknown[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw invalidInput('images must be an array.')
  return value
}

/** The streaming behaviour an inbound request declared, or the refusal naming the vocabulary. */
function behaviorField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !STREAMING_BEHAVIORS.includes(value)) {
    throw invalidInput('streamingBehavior must be one of steer, followUp or aside.')
  }
  return value
}

/**
 * The engine calls one plain message needs, narrowed to the ones the delivery rule reads.
 *
 * Taken as a {@link AgentSession} slice rather than the whole session so the rule can be exercised
 * without a live engine (`session-prompt.test.ts`); every production caller passes `live.agent`.
 */
export type PromptTarget = Pick<AgentSession, 'isStreaming' | 'joinActiveTurn' | 'prompt'>

/**
 * Delivers one message: atomically into the run that is live, or as its own turn.
 *
 * `joinActiveTurn` is the engine's atomic admission, the primitive its own ACP bridge uses for
 * `_session/steering` (18.12.6). It parks while the owning prompt is still dispatching, re-checks
 * liveness after its own image preprocessing, and hands the message back (`false`) when that run
 * settled in between - so the words start their own turn instead of landing on a queue nothing
 * drains. `prompt` with a `streamingBehavior` decides once and cannot take the message back, which
 * is the race this rule closes.
 *
 * Three cases keep the engine's prompt path, because they are not plain messages:
 * - a `/`-prefixed text may be an extension or custom command, which only `prompt` executes (the
 *   atomic admission refuses those by design);
 * - `aside` has no `joinActiveTurn` queue;
 * - the engine refused admission (no live client prompt): the words then either start their own
 *   turn, or join a run the engine keeps for itself (a goal continuation) exactly as before.
 */
export async function deliverPrompt(
  agent: PromptTarget,
  message: string,
  images: unknown[] | undefined,
  behavior: string | undefined,
): Promise<boolean> {
  const steerable = behavior === 'steer' || behavior === 'followUp'
  if (steerable && !message.startsWith('/')) {
    const admitted = await agent.joinActiveTurn(message, images as never, {
      queue: behavior === 'followUp' ? 'followUp' : 'steering',
    })
    if (admitted) return true
  }
  return await agent.prompt(message, {
    images: images as never,
    ...(behavior !== undefined && agent.isStreaming ? { streamingBehavior: behavior as never } : {}),
  })
}

/** Sends a prompt, or an acknowledgement plus a later failure under the same id. */
export async function sendPrompt(
  port: SessionPromptPort,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const live = port.require(text(request.sessionId, 'sessionId', true) as string)
  const message = text(request.message, 'message', true) as string
  if (Buffer.byteLength(message, 'utf8') > MAX_PROMPT_BYTES) {
    throw invalidInput(`The prompt is too large to send as a single command (limit ${MAX_PROMPT_BYTES} bytes).`)
  }
  const images = imagesField(request.images)
  const behavior = behaviorField(request.streamingBehavior)
  const streaming = live.agent.isStreaming
  if (streaming && behavior === undefined) {
    throw new HostError(ERROR_CODES.session_busy, 'The session is already answering a turn.')
  }
  live.lastActivityMs = Date.now()
  // A prompt means a screen is using this session again, so a release left over from an earlier
  // hand-back is called off: what that screen asked for has to run to its end.
  callOffRelease(live)

  const id = text(request.id, 'id', false)
  // A prompt that spells a `/` command reaches one of four places, in the engine's own order
  // (`slash.ts`): a skill, a command this host owns because the engine ships it only for its
  // terminal (`/goal`), or a builtin runs here, and everything else - file commands, TypeScript
  // commands, MCP prompts, extension commands, plain text - is the engine's prompt path. What a
  // local command prints is held until the run below has answered, so the frame that releases its
  // turn cannot clear the line it just wrote; a command that starts a turn flushes first, because
  // its line belongs to the moment before the work, not after it.
  const commandOutput: CommandOutput = { parts: [], flushed: false }
  const command = slashCommandOptions(port, live, behavior, commandOutput)
  const run = async (): Promise<void> => {
    try {
      const slash = await runSlashCommand(command, message)
      let invoked = false
      if (slash === null) {
        // The first plain prompt after `/loop` is the one that repeats.
        noteLoopPrompt(live.agent, message)
        invoked = await deliverPrompt(live.agent, message, images, behavior)
      } else if (slash.kind === 'prompt') {
        // A command that starts a turn (`/goal <objective>`) reports before the turn begins:
        // holding its line until the turn's result would show "Goal mode enabled" only after the
        // whole objective had run, so it is published now. The result that ends the turn arrives
        // later and only clears the line the turn ended on.
        flushCommandOutput(live, commandOutput)
        // A builtin's residual prompt is an engine prompt like any other; the behaviour the
        // user's own message declared does not carry over to it.
        invoked = await live.agent.prompt(slash.text, { images: images as never })
      } else {
        invoked = slash.agentInvoked
      }
      if (id !== undefined) live.events.emit({ type: 'prompt_result', id, agentInvoked: invoked !== false })
    } catch (error) {
      logError('prompt failed', error)
      if (id !== undefined) {
        live.events.emit({
          type: 'error',
          level: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
        live.events.emit({ type: 'prompt_result', id, agentInvoked: false })
      }
    } finally {
      flushCommandOutput(live, commandOutput)
      emitSessionState(live)
      port.collect()
    }
  }
  void run()

  return { accepted: true, agentInvoked: true, queued: streaming && behavior !== undefined }
}

/**
 * Publishes what a `/` command printed, as one line on the engine's own notice channel.
 *
 * Called once the run has answered: a builtin is local work, and the acknowledgement that ends
 * its turn is exactly what clears the session's previous notice in the frontend. The parts arrive
 * as the engine wrote them - often a small report over several lines - so they are joined into one
 * line rather than overwriting each other on the way out.
 *
 * Output that arrives afterwards is published by {@link publishCommandOutput} as it comes:
 * `/compact`, `/handoff` and a no-argument `/rename` hand their work to `runCommandInBackground`
 * and only report once it is done, which is after this flush.
 */
function flushCommandOutput(live: LiveSession, output: CommandOutput): void {
  output.flushed = true
  publishCommandOutput(live, output.parts)
  output.parts.length = 0
}

/** One notice per batch of parts, bounded and joined. */
function publishCommandOutput(live: LiveSession, parts: readonly string[]): void {
  const text = clampCommandOutput(parts.filter(part => part.trim().length > 0).join('\n'))
  if (text.length === 0) return
  try {
    live.agent.emitNotice('info', text, 'slash-command')
  } catch (error) {
    // The report is a side effect of a command that has already run, and this is called from the
    // prompt path's own cleanup: a session that went away under the command must not turn a
    // finished prompt into an error.
    logError('slash command output dropped', error)
  }
}

/**
 * The ports a `/` command needs from this conversation.
 *
 * Read per prompt rather than stored: every one of them is a closure over the record the prompt
 * arrived for, and the session the command runs against is that record.
 */
function slashCommandOptions(
  port: SessionPromptPort,
  live: LiveSession,
  behavior: string | undefined,
  output: CommandOutput,
): SlashCommandOptions {
  return {
    sdk: port.sdk,
    session: live.agent,
    // Until the run has answered, what the command prints is collected and published in one
    // notice by `flushCommandOutput` - the acknowledgement it waits for is what clears the
    // session's previous notice on the frontend. A command that reports later (its work was
    // handed to `runCommandInBackground`) has nothing left to batch with, so its line goes out
    // as it arrives.
    output: text => {
      if (output.flushed) {
        publishCommandOutput(live, [text])
        return
      }
      output.parts.push(text)
    },
    refreshCommands: () => port.refreshCommands(live),
    publishState: () => emitSessionState(live),
    publishTitle: () =>
      live.events.emit({
        type: 'session_info_update',
        title: live.agent.sessionName,
        sessionId: live.sessionId,
      }),
    behavior,
    goal: live.goal,
    ui: live.ui,
    emit: frame => live.events.emit(frame),
    mcpManager: live.mcpManager,
  }
}

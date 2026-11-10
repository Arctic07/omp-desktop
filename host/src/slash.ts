/**
 * The `/` commands one conversation can run.
 *
 * The engine expands most of what a leading slash means inside `AgentSession.prompt()` - file
 * commands from the project's command directories, TypeScript commands, MCP prompts, extension
 * commands - and that path needs nothing from this host. Two families sit outside it, because the
 * engine only dispatches them in its own front-ends:
 *
 * - `skill` commands (`/skill:<name>`): resolved before the prompt, then delivered as a
 *   user-attributed custom message carrying the skill's own body.
 * - builtin commands that have a text handler (`/compact`, `/model`, `/session`, `/plugins`, ...):
 *   the engine ships `executeAcpBuiltinSlashCommand` for a host with no terminal, which is what
 *   this is.
 * - commands the engine only implements for its terminal (`/goal`): its advertisement filters
 *   them out and its text dispatch answers `false`, so this host carries the one whose non-terminal
 *   half the engine ships (`RpcGoalController`) and dispatches it before the builtin path
 *   (`slash-desktop.ts`).
 *
 * A plugin's commands (the engine calls them extensions) are reached through one of those paths or
 * through the prompt expansion, so a new source needs no branch here: the advertised list already
 * carries where each command came from, and `/reload-plugins` is the entry point that rebuilds it.
 */

import type { AgentSession } from '@oh-my-pi/pi-coding-agent'
import type { RpcGoalController } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal'
import type { AcpBuiltinSlashCommandResult } from '@oh-my-pi/pi-coding-agent/slash-commands/types'

import { logError } from './log.ts'
import { reloadPluginStateForSession } from './plugin-reload.ts'
import { runDesktopCommand } from './slash-desktop.ts'
import type { EngineMcpConfig, MCPManager, SdkBundle } from './sdk.ts'
import type { UiBridge } from './ui.ts'

/**
 * Longest command output kept for one notice.
 *
 * Command output is text the engine wrote for a terminal, and a few commands print a report rather
 * than a line (`/tools`, `/context`, `/changelog`). The notice the frontend draws is a bounded row
 * above the composer, so the text is cut here, where the cut is explicit, instead of being left to
 * an unknown consumer.
 */
const OUTPUT_LIMIT = 4_000

/**
 * The notice code a `/compact` prints its report under.
 *
 * The report is about the conversation — how many tokens the rewrite saved — rather than the
 * machinery, so it travels with a code the frontend routes to a transcript row
 * (`src/src/state/transcript.ts`) instead of the dismissible strip above the field. Every other
 * command output keeps the engine's own notice channel.
 */
export const COMPACTION_REPORT_CODE = 'engine_compaction_report'

/**
 * The report code one command's output belongs under, or `undefined` for the notice strip.
 *
 * A builtin is addressed by the prompt's first word and may carry a mode or instructions after it,
 * so the address is read the way the engine reads it: the first whitespace-delimited token.
 */
export function commandReportCode(text: string): string | undefined {
  const first = text.trimStart().split(/\s+/, 1)[0]
  return first === '/compact' ? COMPACTION_REPORT_CODE : undefined
}

/** What a `/` prompt did, or `null` when the text is not a command this host runs itself. */
export type SlashCommandRun =
  | { readonly kind: 'handled'; readonly agentInvoked: boolean }
  | { readonly kind: 'prompt'; readonly text: string }

/**
 * Where a command's output goes.
 *
 * The engine's handlers write to this both while the command runs (`/tools`, `/context`) and after
 * work they handed to `runCommandInBackground` finishes (`/compact`, `/handoff`, a no-argument
 * `/rename`), so it is a sink the caller owns rather than a callback with one fixed moment.
 */
export type CommandOutputSink = (text: string) => void

/** What a `/skill:` text turned out to be. */
type SkillCommandRun =
  /** Not a skill invocation at all: the text goes on to the builtins and the engine. */
  | 'not-skill'
  /** Delivered to the engine as the skill's own message. */
  | 'delivered'
  /** It was a skill, and the engine dropped the submission before dispatch. */
  | 'dropped'

/** Everything one command needs from the conversation it runs in. */
export interface SlashCommandOptions {
  readonly sdk: SdkBundle
  readonly session: AgentSession
  /**
   * One command output. The caller decides where it lands: a report with a host code (the one a
   * `/compact` prints under) becomes a transcript row, every other output a line in the strip.
   */
  readonly output: CommandOutputSink
  /** Rebuild the session's advertised command list and republish it. */
  readonly refreshCommands: () => Promise<void>
  /** Republish the session's state after a command moved its model, thinking level or name. */
  readonly publishState: () => void
  /** Republish the session's name, which commands like `/session pin` rewrite. */
  readonly publishTitle: () => void
  /** The streaming behaviour this prompt declared; a queued skill joins the turn the same way. */
  readonly behavior: string | undefined
  /** Goal mode, for the commands this host owns because the engine only ships them for its TUI. */
  readonly goal: RpcGoalController
  /** The conversation's dialog channel, for a command that has to ask the reader for a value. */
  readonly ui: UiBridge
  /**
   * Publish one frame on this conversation's own pipe, for a command whose surface is a panel
   * rather than a notice line (the side question's answer).
   */
  readonly emit: (frame: Record<string, unknown>) => void
  /**
   * The live MCP manager this session owns, when it has one.
   *
   * `/mcp` consults it for servers that exist only in the manager (ACP-declared entries live in
   * no config file), and `/mcp reauth` asks the host to reconnect the reauthorized server here so
   * the fresh credential is picked up without restarting the conversation.
   */
  readonly mcpManager: MCPManager | undefined
}

/**
 * Runs the command a prompt text spells, or answers `null` for everything the engine's own prompt
 * path handles.
 *
 * The order is the engine's own (its ACP and RPC hosts both resolve a skill before anything else),
 * and a builtin that answers with a residual prompt is handed back to the caller as one.
 */
export async function runSlashCommand(
  options: SlashCommandOptions,
  text: string,
): Promise<SlashCommandRun | null> {
  if (!text.startsWith('/')) return null
  const skill = await runSkillCommand(options, text)
  if (skill !== 'not-skill') return { kind: 'handled', agentInvoked: skill === 'delivered' }
  const desktop = await runDesktopCommand(options, text)
  if (desktop !== null) return desktop
  return await runBuiltinCommand(options, text)
}

/**
 * Runs a `/skill:<name>` invocation, and says what the text turned out to be.
 *
 * A registered skill is delivered as the custom message the engine's own front-ends build: the
 * body goes to the model, and the transcript keeps the draft the user typed (`details.prompt`),
 * never the expanded file.
 */
async function runSkillCommand(options: SlashCommandOptions, text: string): Promise<SkillCommandRun> {
  const { sdk, session } = options
  // The engine registers skill commands unless the setting says otherwise, and only an explicit
  // `false` turns them off (`settings-schema`'s default is true, and the engine's own input path
  // reads the switch the same way).
  if (session.skillsSettings?.enableSkillCommands === false) return 'not-skill'
  const parsed = sdk.parseSkillInvocation(text)
  if (parsed === undefined) return 'not-skill'
  const skill = session.skills.find((candidate) => candidate.name === parsed.name)
  if (skill === undefined) return 'not-skill'
  const built = await sdk.buildSkillPromptMessage(skill, parsed, 'user')
  const delivered = await session.promptCustomMessage(
    {
      customType: sdk.skillPromptMessageType,
      content: built.message,
      display: true,
      details: built.details,
      attribution: 'user',
    },
    // A skill prompt is a user turn: with the session streaming it joins that turn the way the
    // engine's own hosts queue one, and a prompt that declared no behaviour cannot reach here
    // (the caller refuses an unlabelled prompt while a turn runs).
    { streamingBehavior: (options.behavior ?? 'steer') as never },
  )
  // A submission the engine dropped before dispatch (an abort that won the generation race, a
  // denied usage preflight) is still a skill: falling through would hand the literal
  // `/skill:<name>` to the engine's prompt path, which does not expand skills, and would send it
  // to the model as prose. The engine's own hosts treat it as handled too.
  return delivered ? 'delivered' : 'dropped'
}

/** Runs the engine's own builtin dispatch for a text-mode host. */
async function runBuiltinCommand(
  options: SlashCommandOptions,
  text: string,
): Promise<SlashCommandRun | null> {
  const { sdk, session } = options
  const manager = options.mcpManager
  const result: AcpBuiltinSlashCommandResult = await sdk.executeBuiltinCommand(text, {
    session,
    sessionManager: session.sessionManager,
    settings: session.settings,
    cwd: session.sessionManager.getCwd(),
    output: options.output,
    refreshCommands: options.refreshCommands,
    reloadPlugins: () => reloadPluginStateForSession(sdk, session),
    // Detached like the engine's own RPC host: this host answers the prompt before dispatch, so
    // nothing waits on the command, and a command that says it does not hold the caller (a
    // provider-backed `/usage reset`, a rename) must not hold the turn either. What it reports
    // arrives on the notice channel when it arrives.
    runCommandInBackground: (task) => {
      void task()
        .then(() => options.publishState())
        .catch((error: unknown) => logError('slash command background task failed', error))
    },
    // `/mcp reauth` reconnects the server it just reauthorized in this conversation's own manager.
    // The manager's tools-changed callback already rebuilds the session's bindings; the explicit
    // refresh is what makes the command's success line wait for them, so the next prompt cannot
    // start against the old tool set (the engine's RPC host does the same for the same reason).
    ...(manager === undefined
      ? {}
      : {
          mcpManager: manager,
          reconnectMcpServer: async (name: string, selected: EngineMcpConfig) => {
            const state = await sdk.reconnectMcpServer(manager, name, selected)
            if (state !== undefined) await session.refreshMCPTools(manager.getTools())
            return state
          },
        }),
    notifyTitleChanged: options.publishTitle,
    notifyConfigChanged: options.publishState,
  })
  if (result === false) return null
  if ('prompt' in result) return { kind: 'prompt', text: result.prompt }
  return { kind: 'handled', agentInvoked: result.agentInvoked === true }
}

/** One command output, bounded for the notice that carries it. */
export function clampCommandOutput(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text
  return `${text.slice(0, OUTPUT_LIMIT)}…`
}

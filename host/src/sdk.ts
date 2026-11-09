/**
 * The one place the SDK module graph is loaded.
 *
 * Every SDK entry point below is resolved as a runtime-selected dynamic import: the SDK builds
 * its directory table while its modules are evaluated, so these imports cannot be static - they
 * must happen after `pinEnv()`. No other host module imports the engine.
 */

import type {
  AgentSession,
  AgentSessionEvent,
  AuthStorage,
  buildSkillPromptMessage,
  CustomTool,
  CustomToolAPI,
  ExtensionUISelectItem,
  MCPManager,
  ModelRegistry,
  parseSkillInvocation,
  SessionManager,
  Settings,
  Theme,
  createAgentSession,
  discoverSkills,
} from '@oh-my-pi/pi-coding-agent'
import type {
  clearPluginRootsAndCaches,
  resolveActiveProjectRegistryPath,
  resolveOrDefaultProjectRegistryPath,
} from '@oh-my-pi/pi-coding-agent/discovery/helpers'
import type { generateGitCommit, formatConventionalCommit } from '@oh-my-pi/pi-coding-agent/commit'
import type { resolvePrimaryModel } from '@oh-my-pi/pi-coding-agent/commit/model-selection'
import type { generateCommitMessage } from '@oh-my-pi/pi-coding-agent/utils/commit-message-generator'
import type { completeSimple, SqliteAuthCredentialStore } from '@oh-my-pi/pi-ai'
import type { formatModelRoleAlias, getKnownRoleIds, getRoleInfo, roleCandidatePool } from '@oh-my-pi/pi-coding-agent/config/model-roles'
import type { getModelMatchPreferences, pickDefaultAvailableModel, resolveAllowedModels, resolveModelRoleValue } from '@oh-my-pi/pi-coding-agent/config/model-resolver'
import type { MCPServer as EngineMcpServer } from '@oh-my-pi/pi-coding-agent/capability/mcp'
import type { MCPServerConfig as EngineMcpConfig } from '@oh-my-pi/pi-coding-agent/mcp'
import type { loadSkillsFromDir, Skill, SkillWarning } from '@oh-my-pi/pi-coding-agent/extensibility/skills'
import type { classifyInstallTarget } from '@oh-my-pi/pi-coding-agent/cli/classify-install-target'
import type { PluginManager, validateSetting } from '@oh-my-pi/pi-coding-agent/extensibility/plugins/manager'
import type {
  InstalledPluginEntry,
  InstalledPluginSummary,
  MarketplaceManager,
  MarketplacePluginEntry,
  MarketplaceRegistryEntry,
  PluginSource,
  parsePluginId,
} from '@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace'
import type { InstalledPlugin, PluginManifest, PluginSettingSchema } from '@oh-my-pi/pi-coding-agent/extensibility/plugins/types'
import type {
  getMCPServer,
  readDisabledServers,
  readEnabledServers,
  readMCPConfigFile,
  removeMCPServer,
  setMcpServerEnabled,
  updateMCPServer,
  validateServerName,
} from '@oh-my-pi/pi-coding-agent/mcp/config-writer'
import type { ModelsConfig } from '@oh-my-pi/pi-coding-agent/config/models-config-schema'
import type { MemoryBackend, MemoryBackendStatus, resolveMemoryBackend } from '@oh-my-pi/pi-coding-agent/memory-backend'
import type { getMemoryRoot } from '@oh-my-pi/pi-coding-agent/memories'
import type { AgentLifecycleManager } from '@oh-my-pi/pi-coding-agent/registry/agent-lifecycle'
import type { AgentRegistry } from '@oh-my-pi/pi-coding-agent/registry/agent-registry'
import type { ASYNC_RESULT_MESSAGE_TYPE } from '@oh-my-pi/pi-coding-agent/session/async-job-delivery'
import type { FileEntry, SessionEntry, SessionMessageEntry } from '@oh-my-pi/pi-coding-agent/session/session-entries'
import type { VisitEntriesFromFileStreamOptions } from '@oh-my-pi/pi-coding-agent/session/session-loader'
import type { InternalAvailableSlashCommand } from '@oh-my-pi/pi-coding-agent/slash-commands/available-commands'
import type { parseSlashCommand } from '@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse'
import type { RPC_GOAL_CONTINUATION_MODE, RpcGoalController } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal'
import type { cfgGoalContinuationModes, cfgGoalEnabled } from '@oh-my-pi/pi-coding-agent/goals/settings'
import type {
  AcpBuiltinSlashCommandResult,
  SlashCommandRuntime,
} from '@oh-my-pi/pi-coding-agent/slash-commands/types'
import type {
  refreshAgentDiscovery,
  TASK_SUBAGENT_EVENT_CHANNEL,
  TASK_SUBAGENT_LIFECYCLE_CHANNEL,
  TASK_SUBAGENT_PROGRESS_CHANNEL,
} from '@oh-my-pi/pi-coding-agent/task'
import type { EventBus } from '@oh-my-pi/pi-coding-agent/utils/event-bus'
import type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionHandler,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import autoContinuePrompt from '@oh-my-pi/pi-coding-agent/prompts/system/auto-continue' with { type: 'text' }

/**
 * The parts of an internal URL a desktop `history` handler reads.
 *
 * Structural on purpose: `session-history.ts` must not import the engine module graph, and the
 * router's real types are wider than what this host needs.
 */
export interface InternalUrlLike {
  readonly rawHost?: string
  readonly hostname: string
  readonly href: string
  readonly pathname: string
}

/** One resolved internal resource, as the router returns it to the read tool. */
export interface InternalResourceLike {
  url: string
  content: string
  contentType: 'text/markdown' | 'application/json' | 'text/plain'
  size?: number
  sourcePath?: string
  notes?: string[]
}

/** One autocomplete candidate offered for a scheme. */
export interface UrlCompletionLike {
  value: string
  label?: string
  description?: string
}

/** One protocol handler, as far as the desktop wrapper needs to delegate. */
export interface InternalUrlHandlerLike {
  readonly scheme: string
  /**
   * The handler's declared consumption contract. The 18.12.3 router requires it on registration
   * and derives immutability, selectors and write policy from it, so the wrapper must carry the
   * delegate's own spec rather than invent one.
   */
  readonly spec: unknown
  resolve(url: InternalUrlLike, context?: unknown): Promise<InternalResourceLike>
  complete?(query?: string, context?: unknown): Promise<UrlCompletionLike[]>
}

/** The engine's process-global router, as far as the wrapper needs it. */
export interface InternalUrlRouterLike {
  getHandler(scheme: string): InternalUrlHandlerLike | undefined
  register(handler: InternalUrlHandlerLike): void
}

/** The engine's MCP capability load: every discovered server, with its source metadata. */
export interface DiscoveredMcpServers {
  readonly items: readonly EngineMcpServer[]
  /** Failures the discovery itself reported - a provider that could not load its config file. */
  readonly warnings: readonly string[]
}

/** Engine entry points the host needs, loaded as one bundle after the environment is pinned. */
export interface SdkBundle {
  readonly version: string
  readonly createAgentSession: typeof createAgentSession
  readonly SessionManager: typeof SessionManager
  readonly Settings: typeof Settings
  readonly AuthStorage: typeof AuthStorage
  /** The SQLite credential store the host wraps for its in-memory key pools. */
  readonly SqliteAuthCredentialStore: typeof SqliteAuthCredentialStore
  readonly ModelRegistry: typeof ModelRegistry
  /** Process-level LSP teardown; `session.dispose()` does not reclaim session-private servers. */
  readonly shutdownLsp: () => Promise<void>
  /**
   * Workspace-level LSP teardown: the servers of one working directory, and nothing else.
   *
   * The engine keys a client by server command + workspace + configuration identity and hands the
   * same instance to every session opened in that directory, so a conversation ending may only
   * release the directory it was opened in - and only once nothing else holds it. This is the
   * engine's own per-directory teardown (`shutdownStaleClients` with no surviving configuration
   * identity, i.e. every client of that directory), including the initialization still in flight
   * for it; `shutdownLsp` above stays the process-wide one, for the process ending.
   */
  readonly shutdownLspWorkspace: (cwd: string) => Promise<void>
  /** Active LSP clients; each owns at most one child process. */
  readonly lspClients: () => number
  /** Connected MCP server names of the process-global manager (empty when none is active). */
  readonly connectedMcpServers: () => string[]
  /** The process-global MCP manager, owned by whichever session registered one. */
  readonly mcpManager: () => MCPManager | undefined
  /**
   * Reconnect one live manager's MCP server after its credentials changed (`/mcp reauth`).
   *
   * The engine's own helper: it matches the reauthorized definition against the manager's entry
   * (so a name collision cannot reconnect an unrelated server), supersedes a pending automatic
   * attempt that captured the old definition, and reports the post-reconnect state. `undefined`
   * means the manager does not own that definition; the command then falls back to its restart
   * guidance.
   */
  readonly reconnectMcpServer: (
    manager: MCPManager | undefined,
    name: string,
    selected: EngineMcpConfig,
  ) => Promise<'connected' | 'connecting' | 'disconnected' | undefined>
  /** Session command list, as advertised to the frontend palette. */
  readonly availableCommands: (session: AgentSession) => Promise<InternalAvailableSlashCommand[]>
  /**
   * The engine's own text-mode dispatch for builtin commands.
   *
   * The handlers behind it are the ones the engine's ACP and RPC front-ends call, so a command's
   * effect is the engine's, not a copy of it. `false` means no builtin answered the text.
   */
  readonly executeBuiltinCommand: (
    text: string,
    runtime: SlashCommandRuntime,
  ) => Promise<AcpBuiltinSlashCommandResult>
  /**
   * The engine's goal-mode controller for hosts without a terminal.
   *
   * Goal mode's durable lifecycle lives on the session (`goalRuntime`), but the engine only ships
   * the half a front-end owns - the `goal` tool's place in the active set, reattach after a
   * session change, and an event-driven continuation driver - for its RPC host. That controller
   * already implements the half, so this host runs the engine's own rather than a second copy
   * (`host/src/slash-desktop.ts`).
   */
  readonly RpcGoalController: typeof RpcGoalController
  /** The engine's own slash spelling: name, arguments, and the `:`/whitespace separator. */
  readonly parseSlashCommand: typeof parseSlashCommand
  /**
   * Goal-mode settings the desktop command reads: whether the mode is enabled in configuration,
   * and which run modes may auto-continue between turns (the desktop adds its own `rpc`).
   */
  readonly goalSettings: {
    readonly enabled: typeof cfgGoalEnabled
    readonly continuationModes: typeof cfgGoalContinuationModes
    /** The `goal.continuationModes` value this host adds to drive goal turns without a terminal. */
    readonly rpcContinuationMode: typeof RPC_GOAL_CONTINUATION_MODE
  }
  /** Detect a `/skill:<name>` invocation in a draft, whatever else the draft says. */
  readonly parseSkillInvocation: typeof parseSkillInvocation
  /** Build the user-attributed message a skill invocation is delivered as. */
  readonly buildSkillPromptMessage: typeof buildSkillPromptMessage
  /** The engine's own type tag for that message, so the host never spells it itself. */
  readonly skillPromptMessageType: string
  /** Plugin reload: the project registry path whose caches the engine invalidates. */
  readonly resolveActiveProjectRegistryPath: typeof resolveActiveProjectRegistryPath
  /** Plugin reload: drop the cached plugin roots and their discovery results. */
  readonly clearPluginRootsAndCaches: typeof clearPluginRootsAndCaches
  /**
   * Plugin management: the engine's own plugin manager for one working directory.
   *
   * `PluginManager` reads the pinned environment through `getPluginsDir()`, which is why it is
   * loaded here with the rest of the graph rather than imported by the module that uses it.
   */
  readonly PluginManager: typeof PluginManager
  /**
   * Plugin settings: the engine's own value-vs-schema check, which is what
   * `omp plugin config validate` runs. A value the desktop form submits is judged by this rule
   * rather than a second table of types kept here.
   */
  readonly validatePluginSetting: typeof validateSetting
  /** Plugin management: the engine's marketplace manager, whose options name every registry path. */
  readonly MarketplaceManager: typeof MarketplaceManager
  /**
   * The engine's install-spec classifier.
   *
   * A pasted source string is routed by the engine's own rule (local path, npm package, or
   * `name@marketplace`) instead of a second regular expression in this host, so
   * `omp plugin install` and the desktop's install button resolve the same way.
   */
  readonly classifyInstallTarget: typeof classifyInstallTarget
  /** `name@marketplace` parsing, for the two places a plugin id's shape decides which manager acts. */
  readonly parsePluginId: typeof parsePluginId
  /**
   * The project installed-plugins registry path a `scope: "project"` write addresses.
   *
   * The engine's own fallback: a directory with no `.omp/` or `.git/` anchor still gets
   * `<cwd>/.omp/plugins/installed_plugins.json` rather than silently writing the user registry.
   */
  readonly resolveOrDefaultProjectRegistryPath: typeof resolveOrDefaultProjectRegistryPath
  /**
   * Where the plugin and marketplace registries and caches live under the pinned data root.
   *
   * Functions, not values: each resolves the directory table when it is called, which is only
   * correct after `pinEnv()` has run.
   */
  readonly pluginPaths: {
    readonly marketplacesRegistry: () => string
    readonly installedRegistry: () => string
    readonly marketplacesCache: () => string
    readonly pluginsCache: () => string
  }
  /** Plugin reload: re-read the agents and subagents plugins contribute. */
  readonly refreshAgentDiscovery: typeof refreshAgentDiscovery
  /**
   * The engine's own commit pipeline: reads the staged diff, picks the model the settings give it,
   * and answers with a conventional commit form.  renders that form into
   * the message a reader commits with.
   */
  readonly generateGitCommit: typeof generateGitCommit
  readonly formatConventionalCommit: typeof formatConventionalCommit
  /**
   * The model the commit pipeline runs on, resolved the way the engine's own role chain resolves
   * it (the `commit` role, then `smol`, then the chat roles) against the shared settings and
   * registry.
   *
   * A draft must be pinned to this model: given no `modelOverride`, `generateGitCommit` fills its
   * `smol` role from the engine's built-in `MODEL_PRIO.smol` priority list, which reaches free
   * models this machine is not authorized to call - and the provider's refusal then fails the
   * whole draft. Engine's own agentic commit pins the same way.
   */
  readonly resolvePrimaryModel: typeof resolvePrimaryModel
  /**
   * The engine's lighter commit-message generator: one stateless completion per candidate model,
   * with the credential read through the registry this process actually serves.
   *
   * It is the fallback when the pipeline above cannot authenticate. `generateGitCommit` builds a
   * *fresh* auth storage of its own (`discoverAuthStorage`, inside the engine), which only sees
   * credentials written to the engine's store; the key this desktop holds lives in the OS keyring
   * and is installed as a runtime override on the host's own `AuthStorage` (`host/src/auth-keys.ts`),
   * so the fresh storage can find a stale stored key and answer 401 while chat works. This one takes
   * the shared registry, which is where that override lives (2026-10-20, user report).
   */
  readonly generateCommitMessage: typeof generateCommitMessage
  /**
   * One non-streaming completion on a model this process resolved (`@oh-my-pi/pi-ai`'s own
   * `completeSimple`), which is what a plugin's `agent.complete` runs on (`omp.desktop` API 0.2.0).
   *
   * The engine's LLM layer rather than a second HTTP client: the model, its API key and its thinking
   * effort all come from the registry and the role chain this application already resolved
   * (`host/src/plugin-agent.ts`), and a completion written here would be a second implementation of
   * every provider's protocol. Loading it here keeps the engine's module graph behind this one seam.
   */
  readonly completeSimple: typeof completeSimple
  /** Streaming read of a session file, used by the cold history path and the usage scan. */
  readonly visitSessionEntries: (
    filePath: string,
    visit: (entry: FileEntry) => void | boolean,
    options?: VisitEntriesFromFileStreamOptions,
  ) => Promise<unknown>
  /**
   * The engine's process-global internal-URL router.
   *
   * `history://` is resolved inside the engine's `read` tool, so a desktop conversation can only
   * become addressable from another conversation by installing a handler here. The router is a
   * singleton whose `register` replaces a scheme wholesale, which is what `session-history.ts`
   * wraps: desktop session ids are resolved by the host, everything else is delegated to the
   * engine's own handler.
   */
  readonly InternalUrlRouter: { instance(): InternalUrlRouterLike }
  /** The engine's read-only transcript loader, used for a desktop conversation's history. */
  readonly loadSessionMessagesReadOnly: (filePath: string) => Promise<readonly unknown[]>
  /** The engine's transcript markdown renderer, so a desktop read has the engine's own shape. */
  readonly formatSessionHistoryMarkdown: (messages: unknown[], options?: { title?: string }) => string
  /** Skill discovery: the host asks twice, with the maximal and the effective settings. */
  readonly discoverSkills: typeof discoverSkills
  /**
   * Every discovered MCP server, before the engine's user-level suppression.
   *
   * This is the capability load the engine's own extension dashboard uses; `loadAllMCPConfigs`
   * would answer with the servers that survived the denylist, which is the one thing a settings
   * page cannot show (ruling C6).
   */
  readonly mcpServers: (cwd: string) => Promise<DiscoveredMcpServers>
  /** User-level MCP overrides, read from the config file the engine's writer maintains. */
  readonly readDisabledServers: typeof readDisabledServers
  readonly readEnabledServers: typeof readEnabledServers
  /** The engine's own MCP enable/disable writer, which knows which config file may be rewritten. */
  readonly setMcpServerEnabled: typeof setMcpServerEnabled
  /**
   * The engine's own definition writer and its name rule.
   *
   * `updateMCPServer` is the upsert (it adds when the name is absent, replaces when it is there)
   * and it validates both the name and the config before touching the file, so this host never
   * re-implements either rule. `removeMCPServer` and `getMCPServer` complete the pair: the first
   * completes a delete, the second is how a form edit keeps the fields it does not own.
   */
  readonly updateMCPServer: typeof updateMCPServer
  readonly removeMCPServer: typeof removeMCPServer
  readonly getMCPServer: typeof getMCPServer
  /** The engine's message when a server name is not one its config files may carry, else undefined. */
  readonly validateServerName: typeof validateServerName
  /** The engine's own `mcp.json` reader, for a definition copied from another installation. */
  readonly readMCPConfigFile: typeof readMCPConfigFile
  /**
   * The engine's own `models.yml` reader over an arbitrary path.
   *
   * `ConfigFile` is the engine's parser, schema and normalization for that file, so a provider
   * definition this host copies out of another installation is read exactly as the engine would
   * read it. The source file must exist: `tryLoad` short-circuits its legacy JSON migration when
   * the YAML file is there, which is what makes reading another installation's file side-effect
   * free.
   */
  readonly readModelsConfig: (filePath: string) => {
    config: ModelsConfig | null
    error: string | null
  }
  /** The engine's skill frontmatter reader over one directory. */
  readonly loadSkillsFromDir: typeof loadSkillsFromDir
  /** The engine's memory-backend selector, including its migration of the legacy enabled flag. */
  readonly resolveMemoryBackend: typeof resolveMemoryBackend
  /** The engine's per-project memory root. */
  readonly getMemoryRoot: typeof getMemoryRoot
  /**
   * Drop the engine's capability caches (file contents and directory listings).
   *
   * Discovery reads config through that cache, so a file another process wrote - or a skill
   * directory that did not exist at boot - stays invisible until it is dropped: the engine itself
   * calls this after a filesystem change (`capability/index.ts` `reset()`, ruling C22).
   */
  readonly resetCapabilities: () => void
  /** Shared default theme instance (extensions read it; this host has no TUI). */
  readonly theme: Theme
  /** Label of one select option, as other frontends render it. */
  readonly selectOptionLabel: (option: ExtensionUISelectItem) => string
  /** Model role ids the engine knows: the built-ins plus every role settings mentions. */
  readonly getKnownRoleIds: typeof getKnownRoleIds
  /** Tag, display name and section of one role (configured metadata overrides the built-in). */
  readonly getRoleInfo: typeof getRoleInfo
  /** Models eligible for one role, in registry order; the pool role resolution works on. */
  readonly roleCandidatePool: typeof roleCandidatePool
  /**
   * A role written as the engine's own selector alias (`@<role>`).
   *
   * The spelling is the engine's, not a string this host keeps: the legacy `pi/<role>` prefix is
   * still accepted, but the current one is what the engine's own pickers and documentation show.
   */
  readonly formatModelRoleAlias: typeof formatModelRoleAlias
  /** Resolve a role selector - or the `@<role>` alias - into the model the engine would use. */
  readonly resolveModelRoleValue: typeof resolveModelRoleValue
  /**
   * The models a session is allowed to use under the active settings (`enabledModels` scoping
   * included), which is the set the engine resolves a session's starting model against.
   */
  readonly resolveAllowedModels: typeof resolveAllowedModels
  /** The match preferences those resolutions rank candidates with. */
  readonly getModelMatchPreferences: typeof getModelMatchPreferences
  /**
   * The engine's own "first usable model" pick: the model a session with no recorded and no
   * configured model starts on.
   *
   * Exposed so the model-role table can answer what an unassigned `default` role means without a
   * second implementation of the engine's startup order.
   */
  readonly pickDefaultAvailableModel: typeof pickDefaultAvailableModel
  /**
   * The engine's agent registry class, whose process-global instance holds every agent of this
   * host - each conversation under its own id, and every `task` child under the id the engine
   * allocated it.
   *
   * The engine also takes one per session (`agentRegistry`), but this host deliberately does not
   * supply one: no spawn path forwards a caller's registry to a child, so a private registry would
   * separate a session from its own children. What the stop path needs is this registry, because
   * that is where a child actually is.
   */
  readonly AgentRegistry: typeof AgentRegistry
  /**
   * The engine's process-global lifecycle, whose `release(id, ref, { tombstone: true })` is the
   * engine's own explicit kill: it detaches the child's session, marks the ref a terminal
   * `aborted` row and disposes the captured session (`registry/agent-lifecycle.ts:441`).
   */
  readonly AgentLifecycleManager: typeof AgentLifecycleManager
  /** The engine's event bus class: one instance per session, used for both of its bus slots. */
  readonly EventBus: typeof EventBus
  /** Channel a subagent's lifecycle edges are published on (started, then settled). */
  readonly subagentLifecycleChannel: typeof TASK_SUBAGENT_LIFECYCLE_CHANNEL
  /** Channel a subagent's coalesced progress snapshots are published on. */
  readonly subagentProgressChannel: typeof TASK_SUBAGENT_PROGRESS_CHANNEL
  /**
   * Channel a subagent's own session events are published on.
   *
   * Not a third roster channel: the two above say what a child is doing, this one is the child's
   * own event stream (`{id, event}`), which is what a screen attached to that child's transcript
   * draws its live turn from.
   */
  readonly subagentEventChannel: typeof TASK_SUBAGENT_EVENT_CHANNEL
  /**
   * The message type the engine stamps on a background job's result when it delivers that result
   * back into the session that owns the job.
   *
   * The stop path needs the engine's own word for it, not a copy: a delivery parked on the
   * session's yield queue under this type is exactly what re-wakes a session that has just been
   * stopped (`session/yield-queue.ts`'s `clear`, `session/async-job-delivery.ts`'s registration),
   * and a second spelling of the string would silently stop matching the day it changed.
   */
  readonly asyncResultMessageType: typeof ASYNC_RESULT_MESSAGE_TYPE
  /**
   * The engine's own auto-continue nudge.
   *
   * The words the engine sends a turn that compaction interrupted. An adopted upstream compaction
   * resumes the same way (`host/src/upstream-compaction.ts`), so the wording stays the engine's
   * rather than being restated here.
   */
  readonly autoContinuePrompt: string
}

/**
 * Hands a compiled host's process over to the engine's own CLI entry when the invocation carries a
 * worker selector (`__omp_worker_*`).
 *
 * A compiled host is re-entered as the engine's worker host, and the selector-to-worker dispatch is
 * the engine's, not this host's: the CLI module runs it from its own top-level entry as soon as the
 * module is evaluated, so the import *is* the hand-off and nothing here calls `runCli`. The import
 * stays dynamic and stays in this file so that an ordinary host run never evaluates the CLI module,
 * and so the engine import seam remains this file alone (spec §15.1-2). Selectors this host does not
 * recognize are still handed over: the engine's dispatch rejects them, and the host does not keep a
 * second spelling of that dispatch to fall out of step.
 */
export async function handOffCompiledWorkerSelector(argv: readonly string[]): Promise<boolean> {
  if (process.env.PI_COMPILED !== 'true') return false
  if (!argv.some(arg => arg.startsWith('__omp_worker_'))) return false
  // A static import cannot work: it would evaluate the engine's CLI entry - and with it the whole
  // CLI module graph - on every host start, worker selector or not. The specifier is a literal, so
  // the compiler still resolves it at build time; only the evaluation is deferred to this branch.
  await import('@oh-my-pi/pi-coding-agent/cli')
  return true
}

/**
 * Loads every engine module the host uses, after the process environment is pinned, and initializes
 * the engine's theme singleton in the same pass: a headless host renders no terminal, but the engine
 * reads the theme outside its rendering paths.
 */
export async function loadSdk(): Promise<SdkBundle> {
  const sdk = await import('@oh-my-pi/pi-coding-agent')
  const lsp = await import('@oh-my-pi/pi-coding-agent/lsp')
  const lspClient = await import('@oh-my-pi/pi-coding-agent/lsp/client')
  const mcp = await import('@oh-my-pi/pi-coding-agent/mcp')
  // `/mcp reauth` writes a fresh credential row and asks the live manager to pick it up; the
  // engine's helper is the one implementation of that hand-off (RPC and ACP both call it).
  const mcpOauth = await import('@oh-my-pi/pi-coding-agent/mcp/oauth-reauth')
  const commands = await import('@oh-my-pi/pi-coding-agent/slash-commands/available-commands')
  // The text-mode builtin dispatch the engine's own ACP and RPC front-ends call.
  const builtins = await import('@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins')
  // Goal mode's non-terminal half, and the settings its lifecycle reads. Dynamic like every other
  // import in this function: the engine builds its directory table while these modules evaluate,
  // so they must load after `pinEnv()` (see the file header).
  const rpcGoal = await import('@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal')
  const goalSettings = await import('@oh-my-pi/pi-coding-agent/goals/settings')
  // The engine's own `/` spelling, used by the desktop's goal commands so a name/argument split
  // cannot drift from what the engine's dispatcher would have done.
  const slashParse = await import('@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse')
  // Roles resolve against the settings/registry trio, which only exists after `pinEnv()`.
  const roles = await import('@oh-my-pi/pi-coding-agent/config/model-roles')
  const resolver = await import('@oh-my-pi/pi-coding-agent/config/model-resolver')
  const loader = await import('@oh-my-pi/pi-coding-agent/session/session-loader')
  // The process-global internal-URL router and the engine's own transcript renderer: the desktop
  // history wrapper replaces the `history` handler so another conversation can resolve a desktop
  // session id, and hands non-desktop ids back to the engine's handler.
  const internalUrls = await import('@oh-my-pi/pi-coding-agent/internal-urls')
  const historyFormat = await import('@oh-my-pi/pi-coding-agent/session/session-history-format')
  // The async job delivery: the message type the stop path clears off the yield queue, read from
  // the module that registers it there rather than spelled out.
  const asyncDelivery = await import('@oh-my-pi/pi-coding-agent/session/async-job-delivery')
  const extensionUi = await import('@oh-my-pi/pi-coding-agent/extensibility/extensions/types')
  // Capability discovery and the memory backend both read the engine's own directory tables,
  // which is why they load here rather than in the modules that project them.
  const discovery = await import('@oh-my-pi/pi-coding-agent/discovery')
  // Plugin reload reads the project registry path and drops the discovery caches that a plugin
  // file lives behind; both live in the discovery helper module the engine's own reload uses.
  const discoveryHelpers = await import('@oh-my-pi/pi-coding-agent/discovery/helpers')
  // Plugin management: the manager classes themselves, plus the classifier that decides what an
  // install spec names. All three resolve the pinned directory table at call time.
  const plugins = await import('@oh-my-pi/pi-coding-agent/extensibility/plugins/manager')
  const marketplaces = await import('@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace')
  const installTarget = await import('@oh-my-pi/pi-coding-agent/cli/classify-install-target')
  const capability = await import('@oh-my-pi/pi-coding-agent/capability')
  const mcpCapability = await import('@oh-my-pi/pi-coding-agent/capability/mcp')
  const memoryBackend = await import('@oh-my-pi/pi-coding-agent/memory-backend')
  const memories = await import('@oh-my-pi/pi-coding-agent/memories')
  // The `models.yml` reader an import uses on another installation's file: the same ConfigFile the
  // engine loads its own catalogue through, so a definition copied out of it is parsed, validated
  // and normalized exactly as the engine would.
  const modelsConfig = await import('@oh-my-pi/pi-coding-agent/config/models-config')
  const skillFiles = await import('@oh-my-pi/pi-coding-agent/extensibility/skills')
  const registry = await import('@oh-my-pi/pi-coding-agent/registry/agent-registry')
  const lifecycle = await import('@oh-my-pi/pi-coding-agent/registry/agent-lifecycle')
  const eventBus = await import('@oh-my-pi/pi-coding-agent/utils/event-bus')
  // The subagent observability channels: a session-level capability, loaded with the rest of the
  // graph for the same reason.
  const task = await import('@oh-my-pi/pi-coding-agent/task')
  // The commit pipeline: the settings page's "draft the message" button runs the engine's own
  // `omp commit` machinery, so the message is the engine's, not a second prompt written here.
  const commit = await import('@oh-my-pi/pi-coding-agent/commit')
  // The commit pipeline's own role resolution, loaded beside it: a draft pins the model the
  // engine would pick instead of leaving the pipeline to its `MODEL_PRIO.smol` fallback list.
  const commitSelection = await import('@oh-my-pi/pi-coding-agent/commit/model-selection')
  // The pipeline's lighter sibling: a diff in, one message out, on the registry this process
  // serves. Used only when the pipeline cannot authenticate (see the interface entry).
  const commitMessage = await import('@oh-my-pi/pi-coding-agent/utils/commit-message-generator')
  // The engine's LLM layer: one non-streaming completion on a model this process resolved. Loaded
  // here with the rest of the graph for the same reason as everything above - a plugin's
  // `agent.complete` must go through the one seam, and the package is declared in `package.json`
  // rather than reached through a hoisted copy of another version.
  const ai = await import('@oh-my-pi/pi-ai')

  // The engine's theme is a module-level singleton that starts undefined and is assigned only by
  // its own initializer: the CLI runs it for every mode before dispatch, and engine code reads it
  // outside any terminal path. `tools/ask.ts` labels its completion row with `theme.status.success`
  // before it ever looks for a dialog surface, so an uninitialized singleton makes every `ask`
  // call fail with `undefined is not an object (evaluating 'theme.status')`. Initialized here, next
  // to the module graph that owns it, so the `theme` binding below is never the undefined one.
  await sdk.ensureTheme()

  return {
    version: sdk.VERSION,
    createAgentSession: sdk.createAgentSession,
    SessionManager: sdk.SessionManager,
    Settings: sdk.Settings,
    AuthStorage: sdk.AuthStorage,
    SqliteAuthCredentialStore: ai.SqliteAuthCredentialStore,
    ModelRegistry: sdk.ModelRegistry,
    shutdownLsp: lspClient.shutdownAll,
    // No surviving configuration identity means every client of that directory: the engine's own
    // reload teardown, used here for the one case that wants all of them.
    shutdownLspWorkspace: async cwd => {
      await lspClient.shutdownStaleClients(cwd, [])
    },
    lspClients: () => lsp.getLspStatus().length,
    connectedMcpServers: () => mcp.MCPManager.instance()?.getConnectedServers() ?? [],
    // `instance()` is typed as `MCPManagerApi` because a subagent worker thread installs a proxy
    // there; this host runs the process that owns the connections, and the capability commands need
    // the class's lifecycle accessors (`getConnectionStatus`, `waitForStartup`, `connectServers`),
    // which the proxy API deliberately does not carry. A proxied value is not one this accessor can
    // serve, and the session records below are the second place the commands look.
    mcpManager: () => {
      const manager = mcp.MCPManager.instance()
      return manager instanceof mcp.MCPManager ? manager : undefined
    },
    reconnectMcpServer: mcpOauth.reconnectMcpManagerServer,
    availableCommands: session => commands.buildAvailableSlashCommands(session),
    executeBuiltinCommand: (text, runtime) => builtins.executeAcpBuiltinSlashCommand(text, runtime),
    RpcGoalController: rpcGoal.RpcGoalController,
    parseSlashCommand: slashParse.parseSlashCommand,
    goalSettings: {
      enabled: goalSettings.cfgGoalEnabled,
      continuationModes: goalSettings.cfgGoalContinuationModes,
      rpcContinuationMode: rpcGoal.RPC_GOAL_CONTINUATION_MODE,
    },
    parseSkillInvocation: sdk.parseSkillInvocation,
    buildSkillPromptMessage: sdk.buildSkillPromptMessage,
    skillPromptMessageType: sdk.SKILL_PROMPT_MESSAGE_TYPE,
    resolveActiveProjectRegistryPath: discoveryHelpers.resolveActiveProjectRegistryPath,
    clearPluginRootsAndCaches: discoveryHelpers.clearPluginRootsAndCaches,
    PluginManager: plugins.PluginManager,
    validatePluginSetting: plugins.validateSetting,
    MarketplaceManager: marketplaces.MarketplaceManager,
    classifyInstallTarget: installTarget.classifyInstallTarget,
    parsePluginId: marketplaces.parsePluginId,
    resolveOrDefaultProjectRegistryPath: discoveryHelpers.resolveOrDefaultProjectRegistryPath,
    pluginPaths: {
      marketplacesRegistry: marketplaces.getMarketplacesRegistryPath,
      installedRegistry: marketplaces.getInstalledPluginsRegistryPath,
      marketplacesCache: marketplaces.getMarketplacesCacheDir,
      pluginsCache: marketplaces.getPluginsCacheDir,
    },
    refreshAgentDiscovery: task.refreshAgentDiscovery,
    generateGitCommit: commit.generateGitCommit,
    formatConventionalCommit: commit.formatConventionalCommit,
    resolvePrimaryModel: commitSelection.resolvePrimaryModel,
    generateCommitMessage: commitMessage.generateCommitMessage,
    completeSimple: ai.completeSimple,
    visitSessionEntries: (filePath, visit, options) => loader.visitEntriesFromFileStream(filePath, visit, options),
    InternalUrlRouter: internalUrls.InternalUrlRouter,
    loadSessionMessagesReadOnly: loader.loadSessionMessagesReadOnly,
    formatSessionHistoryMarkdown: historyFormat.formatSessionHistoryMarkdown,
    discoverSkills: sdk.discoverSkills,
    mcpServers: async cwd => {
      const result = await discovery.loadCapability<EngineMcpServer>(mcpCapability.mcpCapability.id, { cwd })
      return { items: result.items, warnings: result.warnings }
    },
    readDisabledServers: mcp.readDisabledServers,
    readEnabledServers: mcp.readEnabledServers,
    setMcpServerEnabled: mcp.setMcpServerEnabled,
    updateMCPServer: mcp.updateMCPServer,
    removeMCPServer: mcp.removeMCPServer,
    getMCPServer: mcp.getMCPServer,
    validateServerName: mcp.validateServerName,
    readMCPConfigFile: mcp.readMCPConfigFile,
    readModelsConfig: filePath => {
      // `relocate` reads the same engine ConfigFile at another path. A missing file is the only way
      // `tryLoad` reports `not-found`, and callers here only pass an existing one.
      const result = modelsConfig.ModelsConfigFile.relocate(filePath).tryLoad()
      if (result.status === 'ok') return { config: result.value ?? null, error: null }
      const error = result.error
      return { config: null, error: error instanceof Error ? error.message : result.status }
    },
    loadSkillsFromDir: skillFiles.loadSkillsFromDir,
    resolveMemoryBackend: memoryBackend.resolveMemoryBackend,
    getMemoryRoot: memories.getMemoryRoot,
    resetCapabilities: capability.reset,
    theme: sdk.theme,
    selectOptionLabel: extensionUi.getExtensionUISelectOptionLabel,
    getKnownRoleIds: roles.getKnownRoleIds,
    getRoleInfo: roles.getRoleInfo,
    roleCandidatePool: roles.roleCandidatePool,
    formatModelRoleAlias: roles.formatModelRoleAlias,
    resolveModelRoleValue: resolver.resolveModelRoleValue,
    resolveAllowedModels: resolver.resolveAllowedModels,
    getModelMatchPreferences: resolver.getModelMatchPreferences,
    pickDefaultAvailableModel: resolver.pickDefaultAvailableModel,
    AgentRegistry: registry.AgentRegistry,
    AgentLifecycleManager: lifecycle.AgentLifecycleManager,
    EventBus: eventBus.EventBus,
    subagentLifecycleChannel: task.TASK_SUBAGENT_LIFECYCLE_CHANNEL,
    subagentProgressChannel: task.TASK_SUBAGENT_PROGRESS_CHANNEL,
    subagentEventChannel: task.TASK_SUBAGENT_EVENT_CHANNEL,
    asyncResultMessageType: asyncDelivery.ASYNC_RESULT_MESSAGE_TYPE,
    autoContinuePrompt,
  }
}

/** Types re-exported for the modules that work with engine objects. */
export type {
  AgentSession,
  AgentSessionEvent,
  AuthStorage,
  // The custom-tool contract: the shape a tool this host contributes to every session is written
  // against (`host/src/tools.ts`). Re-exported here rather than imported there, because the engine
  // import seam is this file alone (spec §15.1-2).
  CustomTool,
  EngineMcpConfig,
  EngineMcpServer,
  EventBus,
  FileEntry,
  InstalledPlugin,
  InstalledPluginEntry,
  InstalledPluginSummary,
  MCPManager,
  MarketplaceManager,
  MarketplacePluginEntry,
  MarketplaceRegistryEntry,
  MemoryBackend,
  MemoryBackendStatus,
  ModelRegistry,
  // The engine's `models.yml` shape: what an import reads out of another installation's file
  // (`host/src/omp-import.ts`).
  ModelsConfig,
  PluginManager,
  PluginManifest,
  PluginSettingSchema,
  PluginSource,
  SessionEntry,
  SessionManager,
  SessionMessageEntry,
  // The compaction hook an in-process extension answers (`host/src/upstream-compaction.ts`): the
  // engine's own seam for a summary the embedder already has.
  ExtensionAPI,
  ExtensionFactory,
  ExtensionHandler,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  Settings,
  Skill,
  SkillWarning,
  VisitEntriesFromFileStreamOptions,
}

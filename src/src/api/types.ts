/**
 * Wire types for the engine surfaces this front end talks to.
 *
 * Field names mirror the Rust DTOs in `src-tauri/src/models/**` one for one, including each
 * `#[serde(rename)]`: Tauri matches command arguments by camelCase name, and a DTO's own
 * `rename`/`rename_all` decides its fields, so neither side may be normalized here. A field the
 * Rust side omits when empty is optional below; a field it always serializes (possibly as `null`)
 * is required and nullable.
 *
 * Session, transcript and event shapes live in `session-types.ts`, which is the half that grows.
 */

/** Every command this front end calls, spelled once so no caller builds a name by concatenation. */
export const COMMANDS = {
  runtimeStatus: 'runtime_status',
  runtimeRestart: 'runtime_restart',
  engineModels: 'engine_models',
  engineModelRoles: 'engine_model_roles',
  engineRoleCandidates: 'engine_role_candidates',
  engineSetModelRole: 'engine_set_model_role',
  engineWarm: 'engine_warm',
  engineDataPaths: 'engine_data_paths',
  providerList: 'provider_list',
  providerKeysApply: 'provider_keys_apply',
  providerClearKey: 'provider_clear_key',
  customProviderList: 'custom_provider_list',
  customProviderSave: 'custom_provider_save',
  customProviderRemove: 'custom_provider_remove',
  customProviderFetchModels: 'custom_provider_fetch_models',
  workspaceList: 'workspace_list',
  workspaceAdd: 'workspace_add',
  workspaceRename: 'workspace_rename',
  workspaceRemove: 'workspace_remove',
  workspaceTouch: 'workspace_touch',
  workspaceReorder: 'workspace_reorder',
  openDirectoryInFileManager: 'open_directory_in_file_manager',
  currentWorkingDirectory: 'current_working_directory',
  listWorkspaceEntries: 'list_workspace_entries',
  readWorkspaceFile: 'read_workspace_file',
  writeWorkspaceFile: 'write_workspace_file',
  searchWorkspacePaths: 'search_workspace_paths',
  openExternal: 'open_external',
  mainWindowReady: 'main_window_ready',
  flashTaskbar: 'flash_taskbar',
  appBackground: 'app_background',
  presenceGet: 'presence_get',
  presenceSet: 'presence_set',
  trayLanguageSet: 'tray_language_set',
  startupThemeSet: 'startup_theme_set',
  startupThemeGet: 'startup_theme_get',
  engineCompactionStatus: 'engine_compaction_status',
  engineCompactionSetEnabled: 'engine_compaction_set_enabled',
  engineCompactionSetOptions: 'engine_compaction_set_options',
  engineSkills: 'engine_skills',
  engineSkillsSet: 'engine_skills_set',
  engineMcp: 'engine_mcp',
  engineMcpSetEnabled: 'engine_mcp_set_enabled',
  engineMcpUpsert: 'engine_mcp_upsert',
  engineMcpRemove: 'engine_mcp_remove',
  mcpImportScan: 'mcp_import_scan',
  mcpImportApply: 'mcp_import_apply',
  engineMemory: 'engine_memory',
  engineMemoryAction: 'engine_memory_action',
  engineMemoryCatalog: 'engine_memory_catalog',
  engineMemoryReveal: 'engine_memory_reveal',
  engineUsage: 'engine_usage',
  engineRules: 'engine_rules',
  engineRulesSet: 'engine_rules_set',
  ompImportProbe: 'omp_import_probe',
  ompImportScan: 'omp_import_scan',
  ompImportApply: 'omp_import_apply',
  ompImportDismiss: 'omp_import_dismiss',
  logsOverview: 'logs_overview',
  logsOpenDirectory: 'logs_open_directory',
  logsClear: 'logs_clear',
  logsWrite: 'logs_write',
  cachesClear: 'caches_clear',
  enginePlugins: 'engine_plugins',
  enginePluginInstall: 'engine_plugin_install',
  enginePluginInstallPackage: 'engine_plugin_install_package',
  enginePluginInstallUrl: 'engine_plugin_install_url',
  enginePluginInspectPackage: 'engine_plugin_inspect_package',
  enginePluginScaffold: 'engine_plugin_scaffold',
  enginePluginUninstall: 'engine_plugin_uninstall',
  enginePluginSetEnabled: 'engine_plugin_set_enabled',
  enginePluginUpgrade: 'engine_plugin_upgrade',
  enginePluginUpdateSwitch: 'engine_plugin_update_switch',
  enginePluginCheckUpdates: 'engine_plugin_check_updates',
  enginePluginEngineInfo: 'engine_plugin_engine_info',
  enginePluginConfig: 'engine_plugin_config',
  enginePluginConfigSet: 'engine_plugin_config_set',
  enginePluginConfigReset: 'engine_plugin_config_reset',
  enginePluginReload: 'engine_plugin_reload',
  enginePluginGrants: 'engine_plugin_grants',
  enginePluginGrantSet: 'engine_plugin_grant_set',
  enginePluginPanelOpen: 'engine_plugin_panel_open',
  enginePluginWorkspaceSet: 'engine_plugin_workspace_set',
  enginePluginProcess: 'engine_plugin_process',
  enginePluginProcessRestart: 'engine_plugin_process_restart',
  enginePluginActivate: 'engine_plugin_activate',
  enginePluginCommandRun: 'engine_plugin_command_run',
  enginePluginRendererCall: 'engine_plugin_renderer_call',
  pluginPromptAnswer: 'plugin_prompt_answer',
  pluginTaskCancel: 'plugin_task_cancel',
  engineMarketplaces: 'engine_marketplaces',
  engineMarketplaceAdd: 'engine_marketplace_add',
  engineMarketplacePlugins: 'engine_marketplace_plugins',
  engineMarketplaceRemove: 'engine_marketplace_remove',
  engineMarketplaceUpdate: 'engine_marketplace_update',
  importComposerFiles: 'import_composer_files',
  saveComposerPaste: 'save_composer_paste',
  resolveClipboardFilePaths: 'resolve_clipboard_file_paths',
  copyTextAndFiles: 'copy_text_and_files',
  readClipboardText: 'read_clipboard_text',
  readExternalFile: 'read_external_file',
  revealWorkspaceEntry: 'reveal_workspace_entry',
  openInAppApps: 'open_in_app_apps',
  openInAppIcon: 'open_in_app_icon',
  openInAppLaunch: 'open_in_app_launch',
  terminalOpen: 'terminal_open',
  terminalListLive: 'terminal_list_live',
  terminalAttach: 'terminal_attach',
  terminalTail: 'terminal_tail',
  terminalWrite: 'terminal_write',
  terminalResize: 'terminal_resize',
  terminalLabelSet: 'terminal_label_set',
  terminalClose: 'terminal_close',
  terminalCloseSession: 'terminal_close_session',
  terminalCloseWorkspace: 'terminal_close_workspace',
  browserOpenTab: 'browser_open_tab',
  browserNavigate: 'browser_navigate',
  browserShowTab: 'browser_show_tab',
  browserSetBounds: 'browser_set_bounds',
  browserSetVisible: 'browser_set_visible',
  browserAction: 'browser_action',
  browserGetState: 'browser_get_state',
  browserPages: 'browser_pages',
  browserOpenExternal: 'browser_open_external',
  browserCloseTab: 'browser_close_tab',
  browserCloseSession: 'browser_close_session',
  workspaceWatchSet: 'set_workspace_watch',
  gitGetWorkspaceReview: 'get_workspace_review',
  gitGetWorkspaceBranches: 'get_workspace_branches',
  gitCheckoutWorkspaceBranch: 'checkout_workspace_branch',
  gitStageWorkspaceFiles: 'stage_workspace_files',
  gitUnstageWorkspaceFiles: 'unstage_workspace_files',
  gitDiscardWorkspaceFiles: 'discard_workspace_files',
  gitCommitWorkspace: 'commit_workspace',
  gitSyncWorkspace: 'sync_workspace',
  draftCommitMessage: 'draft_commit_message',
  updateStatus: 'update_status',
  updateCheck: 'update_check',
  updateInstall: 'update_install',
  updateRelaunch: 'update_relaunch',
} as const

export const SESSION_EVENT_CHANNEL_PREFIX = 'omp:session:'
export const RUNTIME_EVENT_CHANNEL = 'omp:runtime'
export const DESKTOP_COMMAND_EVENT = 'omp:desktop'
export const TERMINAL_EVENT = 'omp:terminal'
/** One browser page's visible state (`services::browser::page`). */
export const BROWSER_STATE_EVENT = 'browser-state'
/** The agent/link asking the shell to open or focus a browser tab. */
export const BROWSER_REVEAL_EVENT = 'browser-reveal'
/** A guest's `window.open` asking the shell for a new tab. */
export const BROWSER_OPEN_EVENT = 'browser-open'
/** The coalesced file-watch report (`services/workspace_watch.rs`), named there. */
export const WORKSPACE_CHANGED_EVENT = 'omp:workspace-changed'
/** One complete update status per transition (`services/updater.rs`). */
export const UPDATE_EVENT = 'omp:update'

/**
 * What the tray's forwarding entries ask the window to do (`services/presence.rs`). Each one is the
 * action the window's own button runs, so the tray is only another way to reach it.
 */
export type DesktopCommand = 'new-session' | 'open-workspace'

export interface TerminalUiSummary {
  id: string
  shell: string
  cwd: string
  ownerSessionId: string
  ownerSessionFile: string
  workspaceKey: string
}

export type TerminalUiEvent =
  | { kind: 'open'; terminal: TerminalUiSummary }
  | { kind: 'exit'; terminal: TerminalUiSummary; code: number }

/** The four channels a plugin surface listens on; the desktop emits them to the main window. */
export const PLUGIN_TASK_EVENT = 'plugin-task'
export const PLUGIN_NOTICE_EVENT = 'plugin-notice'
export const PLUGIN_PROMPT_EVENT = 'plugin-prompt'
/**
 * The supervisor's own table, pushed whenever a process starts, stops, crashes or times out.
 *
 * It carries the whole list rather than a delta: a crash and the restart it triggers are two writes
 * to the same row, and a reader that patched instead would have to guess which one it missed.
 */
export const PLUGIN_PROCESS_EVENT = 'plugin-process'

/* ------------------------------------------------------------------ runtime */

export interface RuntimeProcess {
  workspaceId: number | null
  role: 'host'
  pid: number
  state: 'starting' | 'ready' | 'exited'
  sessionId: string | null
  workspaceRoot: string | null
}

export interface RuntimeStatus {
  enginePath: string
  engineVersion: string
  engineVerified: boolean
  engineError: string | null
  protocolVersion: number
  dataRoot: string
  agentDir: string
  credentialBackend: string
  hostVersion: string | null
  sdkVersion: string | null
  hostStatus: 'stopped' | 'starting' | 'ready' | 'degraded'
  liveSessions: number
  dataRootHost: string
  unknownFrames: number
  droppedFrames: number
  replayAttempts: number
  processes: RuntimeProcess[]
}

export type RuntimeExitReason =
  | 'exit'
  | 'restart'
  | 'idle'
  | 'startup_failed'
  | 'startup_timeout'
  | 'workspace_removed'

export type RuntimeEvent =
  | { type: 'engine_ready'; workspaceId: number | null }
  | { type: 'engine_exit'; workspaceId: number | null; reason: RuntimeExitReason }

export interface EngineDataPaths {
  dataRoot: string
  agentDir: string
  configRoot: string
  hostRoot: string
}

/* ------------------------------------------------------------------ models */

export interface EngineModel {
  provider: string
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  supportsImages: boolean
  reasoning: boolean
  /** Empty is a fact: the model has no controllable effort surface. `auto` is never listed. */
  thinkingLevels: string[]
}

export interface EngineModelList {
  models: EngineModel[]
}

export interface ModelRoleModel {
  provider: string
  id: string
  name: string
}

/** Which family a role belongs to; the engine's own metadata decides, never this side. */
export type ModelRoleSection = 'chat' | 'kind'

export interface ModelRoleRow {
  id: string
  /** The engine's short tag (`SMOL`, `TASK`, …); null when it has none. */
  tag: string | null
  name: string
  section: ModelRoleSection
  configured: boolean
  /** The raw selector, `<provider>/<id>` with an optional `:<level>` suffix. */
  value: string | null
  source: 'global' | 'project' | 'default'
  model: ModelRoleModel | null
  thinkingLevel: string | null
  autoSelected: boolean
}

export interface ModelRoleTable {
  roles: ModelRoleRow[]
}

export interface EngineRoleCandidates {
  role: string
  models: EngineModel[]
  truncated: boolean
}

/* --------------------------------------------------------------- providers */

export interface ProviderSummary {
  id: string
  name: string
  apiKeyEnv: string
  configured: boolean
  authenticated: boolean
  available: boolean
  /** The stored keys' masked display forms, so the form can show what is saved. */
  apiKeyMasks: string[]
}

/** `live: false` means the key is stored but only takes effect after a host restart. */
export interface ProviderKeyResult {
  live: boolean
}

export interface CustomModelDefinition {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  supportsImages: boolean
  supportsReasoning: boolean
}

export interface CustomProviderInput {
  id: string
  name: string
  baseUrl: string
  api: string
  models: CustomModelDefinition[]
}

/** `CustomProviderInput` flattened onto the row, plus what the store knows about its key. */
export interface CustomProvider extends CustomProviderInput {
  keyEnv: string
  apiKeyConfigured: boolean
  /** The stored keys' masked display forms, so the editor can show what is saved. */
  apiKeyMasks: string[]
}

export interface CustomModelList {
  models: CustomModelDefinition[]
}

/** The API dialects the engine's custom-provider layer accepts. */
export const CUSTOM_PROVIDER_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'google-vertex',
  'azure-openai-responses',
  'mistral-conversations',
  'bedrock-converse-stream',
  'ollama-chat',
] as const

export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number]

/* -------------------------------------------------------------- workspaces */

export interface WorkspaceSummary {
  id: number
  rootPath: string
  name: string
  pinned: boolean
  /** The directory is no longer on disk. */
  missing: boolean
  lastOpenedAt: number
  sessionCount: number
}

/* --------------------------------------------------------- omp config import */

/** One item a scan found, with this application's judgement of it. */
export interface ImportRoleRow {
  role: string
  selector: string
  /** `importable` | `configured` | `unsupported` | `unresolved`. */
  status: string
}

export interface ImportCredentialRow {
  provider: string
  /** `api_key` | `oauth`. */
  kind: string
  /** `importable` | `unsupported`. */
  status: string
}

export interface ImportProviderRow {
  id: string
  name: string
  baseUrl: string
  api: string
  models: CustomModelDefinition[]
  /** The source carried a literal key; its value never reaches this page. */
  hasKey: boolean
}

export interface ImportServerRow {
  name: string
  transport: string
  target: string
  /** `importable` | `configured`. */
  status: string
}

export interface ImportSkillRow {
  name: string
  description: string
  /** `importable` | `configured`. */
  status: string
}

export interface ImportScan {
  /** The absolute agent directory that was read. */
  source: string
  found: boolean
  models: { roles: ImportRoleRow[]; credentials: ImportCredentialRow[]; providers: ImportProviderRow[] }
  mcp: { servers: ImportServerRow[] }
  skills: { skills: ImportSkillRow[] }
  warnings: string[]
  truncated: boolean
}

export interface ImportProbe {
  /** The user already answered the first-run prompt. */
  prompted: boolean
  source: string
  available: boolean
}

/** One identity an apply skipped, and the closed reason word for it. */
export interface ImportSkip {
  name: string
  reason: string
}

export interface ImportApplyResult {
  source: string
  found: boolean
  models: {
    rolesImported: string[]
    rolesSkipped: ImportSkip[]
    credentialsImported: string[]
    credentialsSkipped: ImportSkip[]
  }
  mcp: { imported: string[]; skipped: ImportSkip[] }
  skills: { imported: string[]; skipped: ImportSkip[] }
  providersImported: string[]
  providersSkipped: ImportSkip[]
  keysStored: string[]
  warnings: string[]
  truncated: boolean
}

/* ------------------------------------------------- MCP from other agents */

/** One MCP server another coding agent defines, as the import dialog lists it. */
export interface McpSourceServerRow {
  name: string
  /** `stdio` | `http` | `sse`. */
  transport: string
  target: string
  /** `importable` | `configured`. */
  status: string
  /** `environment-reference` | `environment-forwarded` | null: a credential the source resolves
   * through its own environment, which this application cannot carry. */
  note: string | null
}

/** One agent this machine has, and every MCP server it defines. */
export interface McpSourceRow {
  /** `claude` | `codex` | `omp` | `pi`. */
  id: string
  /** The file the definitions come from, or would have. */
  path: string
  present: boolean
  servers: McpSourceServerRow[]
}

export interface McpSourceScan {
  /** The real user profile the read used. */
  home: string
  sources: McpSourceRow[]
  warnings: string[]
  truncated: boolean
}

export interface McpSourceApply {
  home: string
  imported: string[]
  skipped: ImportSkip[]
  warnings: string[]
  truncated: boolean
}

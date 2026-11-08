/**
 * Wire types for the engine surfaces behind the settings page's capability sections.
 *
 * Field names mirror `src-tauri/src/models/capabilities.rs` one for one, including every
 * `#[serde(rename)]`: the Rust side derives `Deserialize` from the host's own frames and `Serialize`
 * for the frontend, so a name normalized here would break the contract in one direction or the
 * other. A field the Rust type declares `Option` is `| null` below; a field with `#[serde(default)]`
 * that the host always writes is a plain value.
 *
 * The engine owns every fact here. Nothing on this side derives, defaults or recomputes one: a
 * write's answer is the host's own refreshed view, which is what the page then renders.
 */

/* ------------------------------------------------------------------ skills */

export interface EngineSkillRow {
  name: string
  description: string
  /** Absolute path of the skill's `SKILL.md`. */
  filePath: string
  /** The directory the skill was loaded from. */
  baseDir: string
  /** `SourceMeta.provider`, e.g. `native`, `claude`, `omp-managed`. */
  source: string
  /**
   * The plugin whose package carries this skill, when one does. Its switch is the plugin's: the row
   * cannot be turned off or removed on its own, and the engine stops discovering it with the plugin.
   */
  plugin: string | null
  /** A machine token the page words itself, never rendered raw. */
  sourceName: string
  /** `user` | `project` | `native` | `unknown`. */
  level: string
  /** Loaded and reachable, but kept out of the rendered list by the skill's own frontmatter. */
  hidden: boolean
  /** Present under the switches the engine's settings currently carry. */
  enabled: boolean
}

/** One of the engine's skill source switches; `id` is also what a write sends. */
export interface EngineSkillSource {
  id: string
  /** `<provider>/<level>`, a machine token. */
  label: string
  enabled: boolean
}

export interface EngineSkillWarning {
  skillPath: string
  message: string
}

export interface EngineSkillsSummary {
  total: number
  enabled: number
  hidden: number
  disabled: number
  warnings: number
}

/** The skills page's whole payload, as both the read and every write answer it. */
export interface EngineSkillsView {
  /** The engine's master `skills.enabled` switch. */
  masterEnabled: boolean
  cwd: string
  skills: EngineSkillRow[]
  sources: EngineSkillSource[]
  ignoredPatterns: string[]
  includedPatterns: string[]
  warnings: EngineSkillWarning[]
  summary: EngineSkillsSummary
  /** The host capped `skills`; `summary.total` still counts everything it found. */
  truncated: boolean
}

/** Which switch a skills write turns: the master switch, one source, or one skill. */
export type EngineSkillSetTarget = 'master' | 'source' | 'skill'

/* --------------------------------------------------------------------- MCP */

/** One MCP server: its definition, the user's override on it, and the live manager's report. */
export interface EngineMcpServerRow {
  name: string
  /** `stdio` | `http` | `sse`. */
  transport: string
  /** `command …args` for stdio, the URL for http/sse. A rendering, not the file's own fields. */
  target: string
  command: string | null
  args: string[]
  url: string | null
  timeoutMs: number | null
  sourcePath: string | null
  sourceProvider: string
  /** `user` | `project` | `native` | `unknown`. */
  level: string
  /** The definition's own `enabled` flag, before any user-level override. */
  configuredEnabled: boolean
  /** Effective state after the user's denylist/allowlist. */
  enabled: boolean
  /** `none` | `disabledByUser` | `forceEnabledByUser`. */
  override: string
  /** `connected` | `connecting` | `disconnected` | `unknown`. */
  status: string
  /** Whether the desktop may rewrite this definition in place. */
  writable: boolean
  /** `user` | `project`, or null when it lives in a file this application does not own. */
  scope: string | null
  toolCount: number
  resourceCount: number
  promptCount: number
  /** The engine's own last failure for this server, already redacted. */
  error: string | null
}

export interface EngineMcpError {
  serverName: string | null
  sourcePath: string | null
  message: string
}

export interface EngineMcpSummary {
  total: number
  enabled: number
  connected: number
  failed: number
}

/** One MCP definition as the editor submits it: the transport shape, and nothing else. */
export interface EngineMcpDefinitionInput {
  /** `stdio` (a command), or `http` / `sse` (a url). */
  transport: string
  command?: string | null
  args?: string[] | null
  env?: Record<string, string> | null
  url?: string | null
  headers?: Record<string, string> | null
  cwd?: string | null
  timeoutMs?: number | null
}

/** The MCP page's whole payload, as both the read and every write answer it. */
export interface EngineMcpView {
  /** Whether the process's MCP manager exists yet. */
  live: boolean
  cwd: string
  servers: EngineMcpServerRow[]
  errors: EngineMcpError[]
  disabledByUser: string[]
  forceEnabledByUser: string[]
  summary: EngineMcpSummary
  truncated: boolean
}

/** Which of the engine's two definition files a write targets. */
export type EngineMcpScope = 'user' | 'project'

/* ------------------------------------------------------------------ memory */

export interface EngineMemoryArtifact {
  name: string
  /** `file` | `directory`. */
  kind: string
  bytes: number
  files: number
  updatedAtMs: number | null
}

export interface EngineMemoryFile {
  name: string
  path: string
  bytes: number
  modifiedAtMs: number | null
}

export interface EngineMemoryWorkspace {
  workspaceId: number
  label: string
  cwd: string
  root: string
  files: EngineMemoryFile[]
}

/** The memory backend, and the memory files of every named workspace. */
export interface EngineMemoryCatalogView {
  backend: string
  enabled: boolean
  /** The engine's own rule restated: file-backed memory belongs to `memory.backend=local`. */
  localOnly: boolean
  workspaces: EngineMemoryWorkspace[]
}

/** The engine's own `MemoryBackendStatus`, field for field. */
export interface EngineMemoryBackendStatus {
  backend: string
  active: boolean
  writable: boolean
  searchable: boolean
  scope: string | null
  retainBank: string | null
  recallBanks: string[] | null
  workingCount: number | null
  episodicCount: number | null
  tripleCount: number | null
  lastMemory: string | null
  lastRecall: boolean | null
  database: string | null
  message: string | null
  error: string | null
}

/** The memory page's whole payload, as both the read and every action answer it. */
export interface EngineMemoryView {
  /** The selected `MemoryBackendId`. */
  backend: string
  /** The engine's whole backend list, in its own order — what the picker offers. */
  backends: string[]
  cwd: string
  /** The local backend's memory directory; null for every backend that keeps none on disk. */
  root: string | null
  artifacts: EngineMemoryArtifact[]
  /** What the engine's own backend would inject into a session, as the backend rendered it. */
  injection: string | null
  injectionTruncated: boolean
  status: EngineMemoryBackendStatus | null
  /** Why there is no status: `timeout` | `unsupported` | `failed`, or null when there is one. */
  statusError: string | null
}

/** The three memory actions the engine accepts; the page uses only `set_backend`. */
export type EngineMemoryAction = 'set_backend' | 'enqueue' | 'clear'

/* ------------------------------------------------------------------- usage */

export interface EngineUsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  costUsd: number
  calls: number
}

/** What the scan itself did, so a shortened answer is visible rather than silent. */
export interface EngineUsageScanned {
  files: number
  sessions: number
  /** Files or lines the host could not read; they are missing from every table. */
  skipped: number
  /** The host stopped at its file ceiling, so older sessions are not counted. */
  truncated: boolean
  elapsedMs: number
}

/** `provider`/`model` are null for entries the engine recorded without naming a model. */
export interface EngineUsageModelRow extends EngineUsageTotals {
  provider: string | null
  model: string | null
}

export interface EngineUsageDayRow extends EngineUsageTotals {
  /** `YYYY-MM-DD`, in this machine's local time. */
  day: string
}

export interface EngineUsageDayModelRow extends EngineUsageTotals {
  day: string
  provider: string | null
  model: string | null
}

export interface EngineUsageSessionRow extends EngineUsageTotals {
  sessionId: string
  fileName: string
  firstActivityMs: number | null
  lastActivityMs: number | null
}

/** The usage page's whole payload. */
export interface EngineUsageView {
  generatedAtMs: number
  /** The window the host was asked for; null means all history. */
  rangeDays: number | null
  scanned: EngineUsageScanned
  totals: EngineUsageTotals
  byModel: EngineUsageModelRow[]
  byDay: EngineUsageDayRow[]
  byDayModel: EngineUsageDayModelRow[]
  bySession: EngineUsageSessionRow[]
}

/* ------------------------------------------------------ compaction + rules */

/** Whether the engine compacts a filling context by itself (its own `compaction.enabled`). */
export interface EngineCompactionStatus {
  enabled: boolean
  /** A settled conversation is compacted while the reader is away (`compaction.idleEnabled`). */
  idleEnabled: boolean
  /** An idle stretch is summarized (`recap.enabled`). */
  recapEnabled: boolean
}

/** The engine's user-scope `RULES.md`: where it lives, whether it exists, and the whole file. */
export interface EngineRulesView {
  path: string
  exists: boolean
  content: string
  /** What the host measured on disk, so the page never re-counts the text it was given. */
  bytes: number
  updatedAtMs: number | null
}

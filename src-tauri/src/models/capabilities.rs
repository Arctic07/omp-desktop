//! The DTOs of the settings payloads that report engine state: skills, MCP servers, the memory
//! backend, the session usage roll-up, and the tool approval mode.
//!
//! Every type mirrors one frozen frame payload (contract §2.1-§2.8) field for field, using the
//! camelCase spelling the frontend already declares. They derive `Deserialize` as well as
//! `Serialize`, so a host answer is read straight into the type the command returns rather than
//! being walked field by field through `Value` - one place holds the field names, and nothing
//! between the host and the page renames, reorders or recomputes a value.
//!
//! A key the host leaves out reads as that field's empty value (`#[serde(default)]`): a missing key
//! is one blank cell on a page, not a reason to fail the whole read. Fields the engine can
//! genuinely report as absent are `Option`, which is also how the contract spells them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

// ---- skills (contract §2.1) ----

/// One skill the engine's discovery loaded, with the facts the page renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineSkillRow {
    #[serde(default)]
    pub(crate) name: String,
    /// The skill's own one-line summary; engine text.
    #[serde(default)]
    pub(crate) description: String,
    /// Absolute path of the skill's `SKILL.md`.
    #[serde(default, rename = "filePath")]
    pub(crate) file_path: String,
    /// Directory the skill was loaded from - what the row shows, clipped.
    #[serde(default, rename = "baseDir")]
    pub(crate) base_dir: String,
    /// `SourceMeta.provider`, e.g. `native`, `claude`, `omp-managed`.
    #[serde(default)]
    pub(crate) source: String,
    /// `SourceMeta.providerName`: a machine token the desktop words itself, never rendered raw.
    #[serde(default, rename = "sourceName")]
    pub(crate) source_name: String,
    /// The plugin whose package carries this skill, when one does (`SourceMeta.pluginName`). A row
    /// with one belongs to its plugin: the page disables its own switch, and the plugin's switch is
    /// what makes the engine discover it at all.
    #[serde(default)]
    pub(crate) plugin: Option<String>,
    /// `user` | `project` | `native` | `unknown`.
    #[serde(default)]
    pub(crate) level: String,
    /// Loaded and reachable, but kept out of the rendered list by the skill's own frontmatter.
    #[serde(default)]
    pub(crate) hidden: bool,
    /// Present in the engine's live skill set: discovered with every switch on, and still present
    /// under the switches the settings currently carry.
    #[serde(default)]
    pub(crate) enabled: bool,
}

/// One of the engine's skill source switches.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineSkillSource {
    /// The engine's settings path for this source (`enablePiUser`, ...); also the id a write sends.
    #[serde(default)]
    pub(crate) id: String,
    /// `<provider>/<level>`, a machine token.
    #[serde(default)]
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) enabled: bool,
}

/// A skill the engine refused to load, in the engine's own words.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineSkillWarning {
    #[serde(default, rename = "skillPath")]
    pub(crate) skill_path: String,
    #[serde(default)]
    pub(crate) message: String,
}

/// The counts the overview line renders. `total` counts everything discovery found, so it stays
/// true even when the row list itself was capped.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct EngineSkillsSummary {
    #[serde(default)]
    pub(crate) total: i64,
    #[serde(default)]
    pub(crate) enabled: i64,
    #[serde(default)]
    pub(crate) hidden: i64,
    #[serde(default)]
    pub(crate) disabled: i64,
    #[serde(default)]
    pub(crate) warnings: i64,
}

/// The skills page's whole payload, as both `skills_list` and `skills_set` answer it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineSkillsView {
    /// The engine's master `skills.enabled` switch.
    #[serde(default, rename = "masterEnabled")]
    pub(crate) master_enabled: bool,
    #[serde(default)]
    pub(crate) cwd: String,
    #[serde(default)]
    pub(crate) skills: Vec<EngineSkillRow>,
    #[serde(default)]
    pub(crate) sources: Vec<EngineSkillSource>,
    #[serde(default, rename = "ignoredPatterns")]
    pub(crate) ignored_patterns: Vec<String>,
    #[serde(default, rename = "includedPatterns")]
    pub(crate) included_patterns: Vec<String>,
    #[serde(default)]
    pub(crate) warnings: Vec<EngineSkillWarning>,
    #[serde(default)]
    pub(crate) summary: EngineSkillsSummary,
    /// The host capped `skills`; `summary.total` still counts everything it found.
    #[serde(default)]
    pub(crate) truncated: bool,
}

// ---- MCP (contract §2.4) ----

/// One MCP server: its definition, the user's override on it, and whatever the live manager
/// reports about it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineMcpServerRow {
    #[serde(default)]
    pub(crate) name: String,
    /// `stdio` | `http` | `sse`.
    #[serde(default)]
    pub(crate) transport: String,
    /// `command …args` for stdio, the URL for http/sse.
    #[serde(default)]
    pub(crate) target: String,
    /// The definition's own structural fields, for an editor to start from. `target` is a
    /// rendering; these are what the file holds, and none of them can carry a credential.
    #[serde(default)]
    pub(crate) command: Option<String>,
    #[serde(default)]
    pub(crate) args: Vec<String>,
    #[serde(default)]
    pub(crate) url: Option<String>,
    #[serde(default, rename = "timeoutMs")]
    pub(crate) timeout_ms: Option<i64>,
    /// The config file the definition came from, when the engine attributes one.
    #[serde(default, rename = "sourcePath")]
    pub(crate) source_path: Option<String>,
    #[serde(default, rename = "sourceProvider")]
    pub(crate) source_provider: String,
    /// `user` | `project` | `native` | `unknown`.
    #[serde(default)]
    pub(crate) level: String,
    /// The definition's own `enabled` flag, before any user-level override.
    #[serde(default, rename = "configuredEnabled")]
    pub(crate) configured_enabled: bool,
    /// Effective state after the user's denylist/allowlist.
    #[serde(default)]
    pub(crate) enabled: bool,
    /// `none` | `disabledByUser` | `forceEnabledByUser`.
    #[serde(default, rename = "override")]
    pub(crate) override_mode: String,
    /// `connected` | `connecting` | `disconnected` | `unknown`. `unknown` is what every row says
    /// while no live manager exists, rather than claiming a connection nobody observed.
    #[serde(default)]
    pub(crate) status: String,
    /// Whether the desktop may rewrite this definition in place, and which of its two files holds
    /// it (`None` when it lives in a file this application does not own). The host decides both,
    /// from the same rule its write path uses.
    #[serde(default)]
    pub(crate) writable: bool,
    #[serde(default)]
    pub(crate) scope: Option<String>,
    #[serde(default, rename = "toolCount")]
    pub(crate) tool_count: i64,
    #[serde(default, rename = "resourceCount")]
    pub(crate) resource_count: i64,
    #[serde(default, rename = "promptCount")]
    pub(crate) prompt_count: i64,
    /// The engine's own last failure for this server, already redacted; `null` when there was none.
    #[serde(default)]
    pub(crate) error: Option<String>,
}

/// One config file the engine could not read, or one server it could not build from its
/// definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineMcpError {
    #[serde(default, rename = "serverName")]
    pub(crate) server_name: Option<String>,
    #[serde(default, rename = "sourcePath")]
    pub(crate) source_path: Option<String>,
    #[serde(default)]
    pub(crate) message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct EngineMcpSummary {
    #[serde(default)]
    pub(crate) total: i64,
    #[serde(default)]
    pub(crate) enabled: i64,
    #[serde(default)]
    pub(crate) connected: i64,
    #[serde(default)]
    pub(crate) failed: i64,
}

/// One MCP definition as the editor submits it: the transport shape, and nothing else.
///
/// The engine's own format carries more per server - authentication, OAuth, request-id encoding,
/// the plugin policies - and those keys belong to the file: the host replaces exactly the keys this
/// struct names and leaves the rest untouched, so a form that does not show a field cannot lose it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct EngineMcpDefinitionInput {
    /// `stdio` (a command), or `http` / `sse` (a url).
    #[serde(default)]
    pub(crate) transport: String,
    #[serde(default)]
    pub(crate) command: Option<String>,
    #[serde(default)]
    pub(crate) args: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) env: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub(crate) url: Option<String>,
    #[serde(default)]
    pub(crate) headers: Option<BTreeMap<String, String>>,
    /// Working directory for a stdio server.
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    #[serde(default, rename = "timeoutMs")]
    pub(crate) timeout_ms: Option<i64>,
}

/// The MCP page's whole payload, as both `mcp_list` and `mcp_set_enabled` answer it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineMcpView {
    /// Whether the process's MCP manager exists yet: a server can only report a connection once a
    /// session has brought one up.
    #[serde(default)]
    pub(crate) live: bool,
    #[serde(default)]
    pub(crate) cwd: String,
    #[serde(default)]
    pub(crate) servers: Vec<EngineMcpServerRow>,
    #[serde(default)]
    pub(crate) errors: Vec<EngineMcpError>,
    #[serde(default, rename = "disabledByUser")]
    pub(crate) disabled_by_user: Vec<String>,
    #[serde(default, rename = "forceEnabledByUser")]
    pub(crate) force_enabled_by_user: Vec<String>,
    #[serde(default)]
    pub(crate) summary: EngineMcpSummary,
    /// The host capped `servers`; `summary.total` still counts everything it found.
    #[serde(default)]
    pub(crate) truncated: bool,
}

// ---- memory (contract §2.6) ----

/// One thing the local backend keeps under its memory root: a file, or one directory of them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineMemoryArtifact {
    #[serde(default)]
    pub(crate) name: String,
    /// `file` | `directory`.
    #[serde(default)]
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) bytes: i64,
    #[serde(default)]
    pub(crate) files: i64,
    /// Last modification, or `null` when the entry could not be stat'ed.
    #[serde(default, rename = "updatedAtMs")]
    pub(crate) updated_at_ms: Option<i64>,
}

/// One file under a workspace's memory root, as the catalog read it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineMemoryFile {
    /// The file's own name, which is how the row is labelled.
    pub(crate) name: String,
    /// Absolute path inside the memory root, for the row's reveal action.
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) bytes: i64,
    /// Last modification, or `null` when it could not be read.
    #[serde(default, rename = "modifiedAtMs")]
    pub(crate) modified_at_ms: Option<i64>,
}

/// One workspace's memory: the root the engine derives, and the documents it holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineMemoryWorkspace {
    #[serde(rename = "workspaceId")]
    pub(crate) workspace_id: i64,
    /// The store's name for the workspace, which is what the scope menu shows.
    pub(crate) label: String,
    pub(crate) cwd: String,
    pub(crate) root: String,
    #[serde(default)]
    pub(crate) files: Vec<EngineMemoryFile>,
}

/// `engine_memory_catalog`: the memory backend, and the memory files of every named workspace.
///
/// `localOnly` is the engine's own rule restated - file-backed memory belongs to
/// `memory.backend=local` - so the page can say why there is nothing to list instead of showing an
/// empty list for a backend that never had files.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineMemoryCatalog {
    pub(crate) backend: String,
    pub(crate) enabled: bool,
    #[serde(rename = "localOnly")]
    pub(crate) local_only: bool,
    #[serde(default)]
    pub(crate) workspaces: Vec<EngineMemoryWorkspace>,
}

/// The host's `memory_catalog` answer: one derived root per named working directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MemoryCatalogRootsView {
    #[serde(default)]
    pub(crate) backend: String,
    #[serde(default)]
    pub(crate) enabled: bool,
    #[serde(default, rename = "localOnly")]
    pub(crate) local_only: bool,
    /// One row per requested working directory, in the order they were sent.
    #[serde(default)]
    pub(crate) workspaces: Vec<MemoryCatalogRootRow>,
}

/// One working directory's memory root, or `null` when the active backend keeps no files.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MemoryCatalogRootRow {
    #[serde(default)]
    pub(crate) cwd: String,
    #[serde(default)]
    pub(crate) root: Option<String>,
}

/// The engine's own `MemoryBackendStatus`, field for field. Anything the backend does not report
/// arrives as `null` rather than being left out or guessed at.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineMemoryBackendStatus {
    #[serde(default)]
    pub(crate) backend: String,
    #[serde(default)]
    pub(crate) active: bool,
    #[serde(default)]
    pub(crate) writable: bool,
    #[serde(default)]
    pub(crate) searchable: bool,
    #[serde(default)]
    pub(crate) scope: Option<String>,
    /// The bank new memories are retained in, for the backends that name one.
    #[serde(default, rename = "retainBank")]
    pub(crate) retain_bank: Option<String>,
    /// The banks recall reads, for the backends that name them.
    #[serde(default, rename = "recallBanks")]
    pub(crate) recall_banks: Option<Vec<String>>,
    #[serde(default, rename = "workingCount")]
    pub(crate) working_count: Option<i64>,
    #[serde(default, rename = "episodicCount")]
    pub(crate) episodic_count: Option<i64>,
    #[serde(default, rename = "tripleCount")]
    pub(crate) triple_count: Option<i64>,
    #[serde(default, rename = "lastMemory")]
    pub(crate) last_memory: Option<String>,
    /// Whether the backend's last recall attempt succeeded; `null` when it reports none.
    #[serde(default, rename = "lastRecall")]
    pub(crate) last_recall: Option<bool>,
    #[serde(default)]
    pub(crate) database: Option<String>,
    #[serde(default)]
    pub(crate) message: Option<String>,
    #[serde(default)]
    pub(crate) error: Option<String>,
}

/// The memory page's whole payload, as both `memory_status` and `memory_action` answer it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineMemoryView {
    /// The selected `MemoryBackendId`.
    #[serde(default)]
    pub(crate) backend: String,
    /// The engine's whole backend list, in its own order - what the picker offers.
    #[serde(default)]
    pub(crate) backends: Vec<String>,
    #[serde(default)]
    pub(crate) cwd: String,
    /// The local backend's memory directory; `null` for every backend that keeps none on disk.
    #[serde(default)]
    pub(crate) root: Option<String>,
    #[serde(default)]
    pub(crate) artifacts: Vec<EngineMemoryArtifact>,
    /// What the engine's own backend would inject into a session for this project, as the backend
    /// rendered it. The engine renders it; nothing here assembles, summarizes or rewrites memory.
    #[serde(default)]
    pub(crate) injection: Option<String>,
    /// The host clamped `injection`; the text is the backend's own, only cut.
    #[serde(default, rename = "injectionTruncated")]
    pub(crate) injection_truncated: bool,
    #[serde(default)]
    pub(crate) status: Option<EngineMemoryBackendStatus>,
    /// Why there is no status: `timeout` | `unsupported` | `failed`, or `null` when there is one.
    #[serde(default, rename = "statusError")]
    pub(crate) status_error: Option<String>,
}

// ---- usage (contract §2.8) ----

/// One bucket of engine-reported accounting. The totals, the per-model rows, the per-day rows and
/// the per-session rows all carry these same seven numbers, which is why the three row types below
/// repeat them instead of flattening this struct in: the host's answer is read field by field, and
/// a flattened struct would be deserialized through a buffering path whose treatment of a missing
/// bucket is not worth depending on.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct EngineUsageTotals {
    #[serde(default)]
    pub(crate) input: i64,
    #[serde(default)]
    pub(crate) output: i64,
    #[serde(default, rename = "cacheRead")]
    pub(crate) cache_read: i64,
    #[serde(default, rename = "cacheWrite")]
    pub(crate) cache_write: i64,
    #[serde(default)]
    pub(crate) reasoning: i64,
    /// The engine's four cost buckets, summed.
    #[serde(default, rename = "costUsd")]
    pub(crate) cost_usd: f64,
    /// One per accounted entry - the number of model calls behind these tokens.
    #[serde(default)]
    pub(crate) calls: i64,
}

/// What the scan itself did, so a shortened answer is visible rather than silent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct EngineUsageScanned {
    #[serde(default)]
    pub(crate) files: i64,
    #[serde(default)]
    pub(crate) sessions: i64,
    /// Files or lines the host could not read; they are missing from every table above.
    #[serde(default)]
    pub(crate) skipped: i64,
    /// The host stopped at its file ceiling, so older sessions are not counted.
    #[serde(default)]
    pub(crate) truncated: bool,
    #[serde(default, rename = "elapsedMs")]
    pub(crate) elapsed_ms: i64,
}

/// One model's accounting. `provider`/`model` are `null` for entries the engine recorded without
/// naming a model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineUsageModelRow {
    #[serde(default)]
    pub(crate) provider: Option<String>,
    #[serde(default)]
    pub(crate) model: Option<String>,
    #[serde(default)]
    pub(crate) input: i64,
    #[serde(default)]
    pub(crate) output: i64,
    #[serde(default, rename = "cacheRead")]
    pub(crate) cache_read: i64,
    #[serde(default, rename = "cacheWrite")]
    pub(crate) cache_write: i64,
    #[serde(default)]
    pub(crate) reasoning: i64,
    #[serde(default, rename = "costUsd")]
    pub(crate) cost_usd: f64,
    #[serde(default)]
    pub(crate) calls: i64,
}

/// One model's accounting for one local date: what the trend chart draws.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineUsageDayModelRow {
    /// `YYYY-MM-DD`, in this machine's local time.
    #[serde(default)]
    pub(crate) day: String,
    #[serde(default)]
    pub(crate) provider: Option<String>,
    #[serde(default)]
    pub(crate) model: Option<String>,
    #[serde(default)]
    pub(crate) input: i64,
    #[serde(default)]
    pub(crate) output: i64,
    #[serde(default, rename = "cacheRead")]
    pub(crate) cache_read: i64,
    #[serde(default, rename = "cacheWrite")]
    pub(crate) cache_write: i64,
    #[serde(default)]
    pub(crate) reasoning: i64,
    #[serde(default, rename = "costUsd")]
    pub(crate) cost_usd: f64,
    #[serde(default)]
    pub(crate) calls: i64,
}

/// One local date's accounting, `YYYY-MM-DD`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineUsageDayRow {
    #[serde(default)]
    pub(crate) day: String,
    #[serde(default)]
    pub(crate) input: i64,
    #[serde(default)]
    pub(crate) output: i64,
    #[serde(default, rename = "cacheRead")]
    pub(crate) cache_read: i64,
    #[serde(default, rename = "cacheWrite")]
    pub(crate) cache_write: i64,
    #[serde(default)]
    pub(crate) reasoning: i64,
    #[serde(default, rename = "costUsd")]
    pub(crate) cost_usd: f64,
    #[serde(default)]
    pub(crate) calls: i64,
}

/// One session's accounting. `session_id` is the host's routing id, the same one the sidebar
/// addresses the session by.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineUsageSessionRow {
    #[serde(default, rename = "sessionId")]
    pub(crate) session_id: String,
    #[serde(default, rename = "fileName")]
    pub(crate) file_name: String,
    /// First and last accounted activity, so a reader can tell how long the session ran.
    #[serde(default, rename = "firstActivityMs")]
    pub(crate) first_activity_ms: Option<i64>,
    #[serde(default, rename = "lastActivityMs")]
    pub(crate) last_activity_ms: Option<i64>,
    #[serde(default)]
    pub(crate) input: i64,
    #[serde(default)]
    pub(crate) output: i64,
    #[serde(default, rename = "cacheRead")]
    pub(crate) cache_read: i64,
    #[serde(default, rename = "cacheWrite")]
    pub(crate) cache_write: i64,
    #[serde(default)]
    pub(crate) reasoning: i64,
    #[serde(default, rename = "costUsd")]
    pub(crate) cost_usd: f64,
    #[serde(default)]
    pub(crate) calls: i64,
}

/// The usage page's whole payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineUsageView {
    #[serde(default, rename = "generatedAtMs")]
    pub(crate) generated_at_ms: i64,
    /// The window the host was asked for; `null` means all history.
    #[serde(default, rename = "rangeDays")]
    pub(crate) range_days: Option<i64>,
    #[serde(default)]
    pub(crate) scanned: EngineUsageScanned,
    #[serde(default)]
    pub(crate) totals: EngineUsageTotals,
    #[serde(default, rename = "byModel")]
    pub(crate) by_model: Vec<EngineUsageModelRow>,
    #[serde(default, rename = "byDay")]
    pub(crate) by_day: Vec<EngineUsageDayRow>,
    /// The day-by-model table: one row per model per day the window covers.
    #[serde(default, rename = "byDayModel")]
    pub(crate) by_day_model: Vec<EngineUsageDayModelRow>,
    #[serde(default, rename = "bySession")]
    pub(crate) by_session: Vec<EngineUsageSessionRow>,
}

// ---- tool approval ----

/// The engine's tool approval mode, and whether its settings file carries the key at all.
///
/// `mode` is the engine's own resolved value (`always-ask` | `write` | `yolo`) - what the engine
/// would act on right now. `configured` tells the engine's schema default apart from a value the
/// file actually stores; it is reported by the host unchanged, because only the engine can read its
/// own file, and nothing on this side branches on it: the desktop publishes no approval setting any
/// more (the settings page's card was removed on 2026-10-07), holds the engine at `yolo`, and reads
/// this shape only to see whether that write is still needed
/// (`services::runtime::approval::converge`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineApprovalMode {
    #[serde(default)]
    pub(crate) mode: String,
    #[serde(default)]
    pub(crate) configured: bool,
}

// ---- context compaction ----

/// Whether the engine compacts a filling context by itself.
///
/// `enabled` is the engine's own resolved value (`compaction.enabled`) - what the engine's agent
/// loop would act on right now. How full the context has to be, which method runs and what it
/// keeps are the engine's rules and are not restated here; the engine's schema default is `true`,
/// and this application keeps no copy that could disagree with it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineCompactionStatus {
    #[serde(default)]
    pub(crate) enabled: bool,
    /// Whether a settled conversation is compacted while the reader is away
    /// (`compaction.idleEnabled`). The engine's schema default is `false`.
    #[serde(default, rename = "idleEnabled")]
    pub(crate) idle_enabled: bool,
    /// Whether an idle stretch is summarized (`recap.enabled`). The engine's schema default is
    /// `true`, and the delay it waits out is the engine's own (`recap.idleSeconds`).
    #[serde(default, rename = "recapEnabled")]
    pub(crate) recap_enabled: bool,
}

// ---- global rules (contract §2.9) ----

/// The engine's user-scope `RULES.md`: where it lives, whether it exists yet, and the whole file.
///
/// One file answers for every workspace - the engine reads `<agentDir>/RULES.md` into each request -
/// while project-level rules stay in a workspace's `AGENTS.md`, which is why the page that shows
/// this payload takes no workspace either. A file this application has not created yet is not an
/// error: it reports `exists = false` with empty `content`, zero `bytes` and no timestamp, and the
/// first write creates it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineRulesView {
    #[serde(default)]
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) exists: bool,
    #[serde(default)]
    pub(crate) content: String,
    /// What the host measured on disk, so a page never has to re-count the text it was given.
    #[serde(default)]
    pub(crate) bytes: i64,
    /// The file's modification time in milliseconds; `null` when there is no file (or no readable
    /// one) to stamp.
    #[serde(default, rename = "updatedAtMs")]
    pub(crate) updated_at_ms: Option<i64>,
}

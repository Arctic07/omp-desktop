use serde::{Deserialize, Serialize};
use serde_json::Value;

mod chat;
mod children;
mod search;
mod stop;
mod work;

pub(crate) use chat::{
    ChatAttachmentRef, ChatImage, ChatMessage, ChatTokenUsage, HistoryChunk, HistoryProgress,
    SessionHistory,
};
pub(crate) use children::{SessionChild, SessionChildren};
pub(crate) use search::{SessionSearchHit, SessionSearchSnippet};
pub(crate) use stop::{AbortOutcome, BackgroundJob, ForceStopOutcome, StopJobOutcome};
pub(crate) use work::{
    subagent_model, SubagentRecentTool, SubagentRow, TodoItem, TodoPhase, TodoStatus, ToolDetails,
    ToolFileChange, ToolMinimized, ToolSource, ToolSubagent,
};

/// Kind of process the runtime status reports. The frontend's type union still spells the
/// per-conversation kinds (`session`, `probe`) that the process pool used; this build runs one
/// host for every conversation, so `Host` is the only kind it can produce.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProcessRole {
    Host,
}

/// Lifecycle of the reported process, in the vocabulary the frontend already renders.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProcessState {
    Starting,
    Ready,
    Exited,
}

#[derive(Debug, Serialize)]
pub(crate) struct RuntimeProcess {
    #[serde(rename = "workspaceId")]
    pub(crate) workspace_id: Option<i64>,
    pub(crate) role: ProcessRole,
    pub(crate) pid: u32,
    pub(crate) state: ProcessState,
    #[serde(rename = "sessionId")]
    pub(crate) session_id: Option<String>,
    #[serde(rename = "workspaceRoot")]
    pub(crate) workspace_root: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct RuntimeStatus {
    #[serde(rename = "enginePath")]
    pub(crate) engine_path: String,
    /// SDK version the host was built against (from `omp-host.json`).
    #[serde(rename = "engineVersion")]
    pub(crate) engine_version: String,
    #[serde(rename = "protocolVersion")]
    pub(crate) protocol_version: u32,
    #[serde(rename = "dataRoot")]
    pub(crate) data_root: String,
    #[serde(rename = "agentDir")]
    pub(crate) agent_dir: String,
    #[serde(rename = "credentialBackend")]
    pub(crate) credential_backend: String,
    /// True only when the located host binary matched the digest recorded in the manifest shipped
    /// next to it (`omp-host.json`). Every candidate is verified the same way, including a
    /// development override: an artifact without a manifest of its own is refused rather than
    /// trusted, so `true` here always means the file that was just hashed.
    #[serde(rename = "engineVerified")]
    pub(crate) engine_verified: bool,
    /// Stable code when the located host cannot be used (`ENGINE_NOT_FOUND`,
    /// `ENGINE_CHECKSUM_MISMATCH`, `ENGINE_PROTOCOL` - an artifact built for another protocol),
    /// `None` when nothing is known to be wrong with it.
    #[serde(rename = "engineError")]
    pub(crate) engine_error: Option<String>,
    /// The host's own package version, reported by its `hello`. `None` while no host has greeted.
    #[serde(rename = "hostVersion")]
    pub(crate) host_version: Option<String>,
    /// SDK version the running host reported, which is what a live process is actually serving.
    #[serde(rename = "sdkVersion")]
    pub(crate) sdk_version: Option<String>,
    /// Sessions the running host currently holds.
    #[serde(rename = "liveSessions")]
    pub(crate) live_sessions: usize,
    /// The host's own data root, `<dataRoot>/host`. Additive; the frontend may ignore it.
    #[serde(rename = "dataRootHost")]
    pub(crate) data_root_host: String,
    /// Lifecycle of the one host process: `stopped` | `starting` | `ready` | `degraded`.
    ///
    /// Additive, and the only place "nothing was ever started" and "it gave up after repeated
    /// crashes" can be told apart: both render as a process entry that is not running. A degraded
    /// host is not started again by an implicit call, so this is what tells the user to restart it.
    #[serde(rename = "hostStatus")]
    pub(crate) host_status: &'static str,
    /// Frames the host sent that this build does not recognize. Additive; a rising count means the
    /// host is speaking a newer vocabulary.
    #[serde(rename = "unknownFrames")]
    pub(crate) unknown_frames: u64,
    /// Frames this build knows were lost - a replay whose journal no longer covered the gap. The
    /// session is resynchronized from a state snapshot when this happens, so the count is the only
    /// trace the loss leaves.
    #[serde(rename = "droppedFrames")]
    pub(crate) dropped_frames: u64,
    /// Replays asked of the host to repair an out-of-order stream. Additive; a count that keeps
    /// growing on an idle session means its frames keep arriving with holes.
    #[serde(rename = "replayAttempts")]
    pub(crate) replay_attempts: u64,
    pub(crate) processes: Vec<RuntimeProcess>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct EngineModel {
    pub(crate) provider: String,
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(rename = "contextWindow")]
    pub(crate) context_window: i64,
    #[serde(rename = "maxTokens")]
    pub(crate) max_tokens: i64,
    #[serde(rename = "supportsImages")]
    pub(crate) supports_images: bool,
    pub(crate) reasoning: bool,
    /// The thinking levels this model offers, in the host's own order. Empty is a fact about the
    /// model, not a missing row: the catalogue reports no efforts for a model with no controllable
    /// effort surface, and a picker built on the list then offers nothing rather than a level the
    /// model would have to adapt away.
    #[serde(rename = "thinkingLevels")]
    pub(crate) thinking_levels: Vec<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct EngineModelList {
    pub(crate) models: Vec<EngineModel>,
}

/// The model one role resolves to, in the three fields the role panel renders. Only the identity
/// crosses the IPC boundary: the panel shows `provider/id` and the engine's display name, and a
/// role assignment is written back as a selector, never as a full model row.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ModelRoleModel {
    pub(crate) provider: String,
    pub(crate) id: String,
    pub(crate) name: String,
}

/// One row of the engine's role table: the role, the selector stored for it, and the model the
/// engine resolves from that selector.
///
/// `value` and `model` are deliberately two facts. A stored selector can name a model the
/// catalogue no longer carries - the row then has no `model` and still has to render so the user
/// can fix it - and a role nobody configured still resolves to something, which is the engine's
/// own automatic choice (`autoSelected`).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ModelRoleRow {
    pub(crate) id: String,
    /// The engine's short label for the role, `null` for a role it does not tag.
    pub(crate) tag: Option<String>,
    pub(crate) name: String,
    /// The group the engine files the role under: `"chat"` or `"kind"`.
    pub(crate) section: String,
    /// True when the user configured this role, as opposed to the engine having picked for it.
    pub(crate) configured: bool,
    /// The stored selector verbatim (`provider/id`, optionally with a `:level` suffix), `null`
    /// when nothing was configured for this role.
    pub(crate) value: Option<String>,
    /// Where the value comes from: `"global"` | `"project"` | `"default"`.
    pub(crate) source: String,
    /// The model the engine resolves for this role, `null` when the selector names none.
    pub(crate) model: Option<ModelRoleModel>,
    /// The thinking level, present only when the stored selector spells one out; a level inherited
    /// from the global preference is not this row's fact.
    #[serde(rename = "thinkingLevel")]
    pub(crate) thinking_level: Option<String>,
    /// True when the engine chose the model by itself, because no role assignment applies.
    #[serde(rename = "autoSelected")]
    pub(crate) auto_selected: bool,
}

/// The engine's whole role table, as both the read and the write command report it.
#[derive(Debug, Serialize)]
pub(crate) struct ModelRoleTable {
    pub(crate) roles: Vec<ModelRoleRow>,
}

/// The models one role may be assigned, in the engine's own order.
#[derive(Debug, Serialize)]
pub(crate) struct EngineRoleCandidates {
    /// Echo of the role that was asked about, so a caller can match the answer to its request.
    pub(crate) role: String,
    pub(crate) models: Vec<EngineModel>,
    /// True when the engine's candidate pool held more rows than this list carries: the list is a
    /// prefix of the pool, not the whole of it.
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct WorkspaceSummary {
    pub(crate) id: i64,
    #[serde(rename = "rootPath")]
    pub(crate) root_path: String,
    pub(crate) name: String,
    pub(crate) pinned: bool,
    pub(crate) missing: bool,
    #[serde(rename = "lastOpenedAt")]
    pub(crate) last_opened_at: i64,
    #[serde(rename = "sessionCount")]
    pub(crate) session_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SessionColdStatus {
    Complete,
    /// Observed by the host's own turn ledger (a turn that never finished), never derivable from a
    /// session file's tail window, which is why only a stored read mark can name it.
    Interrupted,
    Aborted,
    Error,
    Pending,
    Unknown,
}

impl SessionColdStatus {
    /// The status a stored mark holds, `None` for anything else.
    ///
    /// A mark outlives the build that wrote it, so the text is read back through this one table
    /// instead of being spelled out where it is consumed.
    pub(crate) fn from_wire(value: &str) -> Option<Self> {
        match value {
            "complete" => Some(Self::Complete),
            "interrupted" => Some(Self::Interrupted),
            "aborted" => Some(Self::Aborted),
            "error" => Some(Self::Error),
            "pending" => Some(Self::Pending),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }

    /// The text [`Self::from_wire`] reads back: the same lowercase names the enum serializes to,
    /// declared once so a new status cannot be stored under a name nothing can read.
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Interrupted => "interrupted",
            Self::Aborted => "aborted",
            Self::Error => "error",
            Self::Pending => "pending",
            Self::Unknown => "unknown",
        }
    }
}

/// One session whose cold status the user has already read, as this app recorded it. The app owns
/// the "seen" fact; the status itself is still the engine's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct SessionReadMark {
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    pub(crate) status: SessionColdStatus,
    /// When the reader saw that status, as the host clock wrote it.
    ///
    /// The status alone cannot say whether a *new* completion is unread: two completed turns are
    /// the same word, so a mark keyed by the word calls every later completion read. The reader's
    /// row compares this time with the session file's own `updatedAt` instead (2026-10-21).
    #[serde(rename = "seenAt")]
    pub(crate) seen_at: i64,
}

/// One row of a workspace's stored arrangement: a conversation, and when it was last written when
/// the reader placed it.
///
/// `at` is the row's own `updatedAt` at that moment, taken from the same transcript clock the list
/// sorts by. It is what keeps the arrangement from freezing the list: a conversation written after
/// it was placed is newer than its place, and sorts by recency again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SessionOrderEntry {
    pub(crate) id: String,
    pub(crate) at: i64,
}

/// One message a conversation can branch from, as the branch picker draws it.
///
/// Read from the engine's own branch, so the rows a user may pick are exactly the points the
/// engine accepts: a user turn of the active conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SessionBranchPoint {
    #[serde(rename = "entryId")]
    pub(crate) entry_id: String,
    /// The message's own text, with the composer's inline-attachment marks dropped: this is drawn
    /// as a row, not edited, and a private-use code point would be a box.
    pub(crate) text: String,
    /// When the turn was written, as the engine stamped it.
    pub(crate) timestamp: String,
}

/// The messages one conversation can branch from, oldest first.
///
/// `truncated` is the host's cap speaking: a conversation with more turns than one answer carries
/// is answered with its newest ones, and the picker says so rather than presenting a list that
/// looks whole.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SessionBranchPoints {
    pub(crate) points: Vec<SessionBranchPoint>,
    pub(crate) truncated: bool,
}

/// The result of starting a conversation of its own from an entry inside another one.
///
/// No draft comes with it: the point a reader picks here is where the new conversation carries on
/// from, not a message to write again.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionBranchFrom {
    /// The id of the new session file, derived the same way every other session id is.
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    /// The new session file, in the spelling the session index reads off disk.
    #[serde(rename = "sessionFile")]
    pub(crate) session_file: String,
    /// The file the new conversation was taken from; it keeps every entry it had and stays openable.
    #[serde(rename = "previousSessionFile")]
    pub(crate) previous_session_file: String,
}

/// The result of branching one conversation: the new identity, and the draft it was branched at.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionBranch {
    /// The id of the new session file, derived the same way every other session id is.
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    /// The new session file, in the spelling the session index reads off disk.
    #[serde(rename = "sessionFile")]
    pub(crate) session_file: String,
    /// The file the conversation was branched from; its transcript is untouched and stays openable.
    ///
    /// Carried because the open that follows can fail: the engine has already rewritten the
    /// conversation onto the new file by then, so the row the user came from is the only way back,
    /// and this is the file that names it.
    #[serde(rename = "previousSessionFile")]
    pub(crate) previous_session_file: String,
    /// The branched message's own text, for the composer.
    pub(crate) text: String,
}

/// The result of rewinding one conversation: the same conversation, ending before the message.
///
/// Nothing moved, so there is no new identity to name: the id the host answers is the one the
/// caller sent (checked against it), and the file, the title and the list row are unchanged. The
/// message's own text comes back for the composer, which is what a recall hands to the field.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionRewind {
    /// The conversation's own id, echoed from the live registration.
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    /// The message's own text, as the engine stored it.
    pub(crate) text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SessionSummary {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) cwd: String,
    pub(crate) status: SessionColdStatus,
    /// When the conversation was last written *in*, in Unix milliseconds: the stamp of the newest
    /// message the transcript holds, taken from the message itself.
    ///
    /// Deliberately not the file's modification time. Opening a conversation appends the engine's
    /// own bookkeeping (`session_exit`, model and thinking-level changes), so a row timed by its
    /// file would read "just now" the moment the user clicked a session nobody had written in for
    /// hours - a row that says when the user last touched it rather than when it was last written.
    /// A transcript whose tail window holds no readable message keeps the modification time as the
    /// only fact available; see `session_index::read_summary`.
    #[serde(rename = "updatedAt")]
    pub(crate) updated_at: i64,
    #[serde(rename = "filePath")]
    pub(crate) file_path: String,
    /// The file is the engine's compressed form (`*.jsonl.gz`) rather than a transcript it can
    /// open: an archive the engine's own collection tool left behind, not a decision the user made.
    pub(crate) compressed: bool,
    /// The user pinned this conversation to the top of its workspace's list.
    ///
    /// This application's own fact (`store::session_flags`), merged into the row by the list
    /// command: a session file has no slot for it, and the engine never decides it.
    pub(crate) pinned: bool,
    /// The user put this conversation away: the rail leaves its row out until the reader asks for
    /// the archived rows.
    ///
    /// Also this application's own fact, and deliberately not a file state: the transcript stays
    /// where the engine wrote it, keeps its tabs in this process, and is one unarchive away from
    /// the list again.
    pub(crate) archived: bool,
    /// The transcript holds nothing: no message was ever written to it.
    ///
    /// A conversation is opened for a workspace's composer before the first message - the engine's
    /// command list belongs to a session - so such a row exists before anything the user said does.
    /// It is the row a list hides unless it is the one on screen (the provisional new
    /// conversation), and it is what tells the composer's surface that the conversation it shows is
    /// still empty rather than one whose rows have not been read yet.
    pub(crate) blank: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct SessionView {
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    #[serde(rename = "workspaceId")]
    pub(crate) workspace_id: i64,
    #[serde(rename = "workspaceRoot")]
    pub(crate) workspace_root: String,
    #[serde(rename = "sessionFile")]
    pub(crate) session_file: Option<String>,
    pub(crate) title: Option<String>,
    #[serde(rename = "modelProvider")]
    pub(crate) model_provider: Option<String>,
    #[serde(rename = "modelId")]
    pub(crate) model_id: Option<String>,
    #[serde(rename = "thinkingLevel")]
    pub(crate) thinking_level: Option<String>,
    /// Whether the engine was running a turn at the moment this answer was written. A conversation
    /// the host already serves may well be mid-turn (re-attaching never interrupts it), and a panel
    /// opening onto that turn has to know it: the frontend restores the running turn's row from
    /// this fact, because the event that opened that row (`turn_started`) was published while
    /// nobody was listening, and the host replays nothing.
    #[serde(rename = "streaming")]
    pub(crate) streaming: bool,
    /// The session's state as the open answered, in the same shape a `state` frame carries.
    ///
    /// The host publishes that frame *inside* the open, before this desktop can have a listener
    /// for a session whose id it did not know yet, so a brand-new conversation would otherwise
    /// start with an empty record: no command list, no thinking levels, no context usage, until
    /// some later frame happened to republish them. The answer is where that first snapshot
    /// travels instead.
    pub(crate) state: SessionRuntimeState,
}

/// The empty modes object a host that never sent one reads as.
pub(crate) fn default_modes() -> Value {
    serde_json::json!({})
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionRuntimeState {
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    /// The entry the conversation's active path ends on, when that end is a message.
    ///
    /// A row this process built from live frames carries no entry id of its own - the engine pairs
    /// ids with the messages it wrote, and those arrive over this stream rather than as entries -
    /// so the turn that just settled takes its rewind point from here. `None` while the path holds
    /// no message at all.
    #[serde(rename = "tipEntryId", skip_serializing_if = "Option::is_none")]
    pub(crate) tip_entry_id: Option<String>,
    #[serde(rename = "modelProvider")]
    pub(crate) model_provider: Option<String>,
    #[serde(rename = "modelId")]
    pub(crate) model_id: Option<String>,
    #[serde(rename = "thinkingLevel")]
    pub(crate) thinking_level: Option<String>,
    /// The levels the picker offers for this session's current model, `auto` first. Empty means
    /// the model has no controllable effort surface - the same fact a model row's empty list
    /// carries, not missing data - so the automatic level is the only one with an effect.
    #[serde(rename = "thinkingLevels")]
    pub(crate) thinking_levels: Vec<String>,
    #[serde(rename = "isStreaming")]
    pub(crate) is_streaming: bool,
    /// Whether the engine is rewriting the context (a compaction or a handoff).
    ///
    /// It runs with no turn in flight, so the turn bit alone says "idle" through it: the composer
    /// draws the stop control on this as well, and a host that predates the field reports `false`,
    /// which is the same reading as a session that is not compacting.
    #[serde(rename = "isCompacting", default)]
    pub(crate) is_compacting: bool,
    /// The modes this conversation is in, as one object: `goal`, `plan`, `vibe`.
    ///
    /// A mode that is off is an absent key, so the composer's strip draws a chip per present mode
    /// and nothing for the rest. Carried as the host's own JSON because the shapes are the engine's
    /// (goal accounting, plan file, vibe worker rows) and a new mode must not need a Rust release
    /// to reach the screen; a missing object reads as "no modes".
    #[serde(rename = "modes", default = "default_modes")]
    pub(crate) modes: Value,
    /// The retry the engine is waiting on, absent whenever the turn is not retrying. Serialized
    /// only when set, so the field stays additive for a frontend running against a host that
    /// predates it.
    #[serde(rename = "retry", skip_serializing_if = "Option::is_none")]
    pub(crate) retry: Option<SessionRetry>,
    #[serde(rename = "messageCount")]
    pub(crate) message_count: i64,
    #[serde(rename = "contextTokens")]
    pub(crate) context_tokens: i64,
    #[serde(rename = "contextWindow")]
    pub(crate) context_window: i64,
    #[serde(rename = "contextPercent")]
    pub(crate) context_percent: f64,
    /// Where the engine would compact this conversation, as a share of the window it measured, or
    /// `null` when it would not compact at all (the setting is off, or no method is configured).
    ///
    /// Serialized unconditionally, so "the engine will not compact" and "the host never said" stay
    /// two different answers: an absent field means the host predates this one.
    #[serde(rename = "autoCompactPercent")]
    pub(crate) auto_compact_percent: Option<f64>,
    /// Whether the occupancy stands on usage a provider actually reported, or is the engine's own
    /// tokenizer estimate of what the next request would carry.
    ///
    /// Always serialized: a caller that marks estimates has to be able to tell them apart from
    /// measurements, and "unknown" would force it to present both the same way.
    #[serde(rename = "contextAnchored")]
    pub(crate) context_anchored: bool,
    /// The engine's own split of the context in use, under the engine's category ids.
    ///
    /// Serialized unconditionally: a category the engine reports as empty is `0`, which is a fact
    /// about the session, while an absent object means the host predates this field.
    #[serde(rename = "contextCategories")]
    pub(crate) context_categories: ContextCategories,
    /// What this session's calls have spent so far, cumulative.
    ///
    /// Serialized unconditionally: a session that has spent nothing reports three zeros, which is a
    /// fact about it, while an absent object means the host predates the field.
    #[serde(rename = "sessionUsage")]
    pub(crate) session_usage: SessionUsageTotals,
    /// The engine's live slash-command list for this process, empty until it has advertised
    /// one. Part of the snapshot so a consumer that mounts after the advertisement still
    /// sees it, and serialized exactly as the frontend contract in `src/utils/agentTypes.ts`
    /// spells it (`EngineCommand` / `EngineSubcommand`).
    pub(crate) commands: Vec<EngineCommand>,
    /// True while the session carries a turn the host lost: it was streaming when the host died
    /// or was restarted, and this host rebuilt it from its session file instead of replaying the
    /// turn. Serialized only when set, so the field stays additive for the frontend.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(crate) interrupted: bool,
    /// The engine's live todo list, in the order it keeps it. Serialized only when it names a
    /// phase: "no phases" and "nothing to show" are the same fact to a reader, and the field stays
    /// additive for a frontend running against a host that predates it.
    #[serde(rename = "todoPhases", skip_serializing_if = "Vec::is_empty")]
    pub(crate) todo_phases: Vec<TodoPhase>,
    /// True while the engine still owes this session work it accepted in the background: a job or
    /// a subagent that will deliver its result into the conversation on its own, after the turn
    /// that started it has ended.
    ///
    /// Always serialized, because the two things its absence would mean - "nothing outstanding"
    /// and "a host old enough not to track this" - are the same answer to the question the field
    /// asks, and the projection reads a missing field as `false` rather than leaving the frontend
    /// to guess which one it is looking at.
    #[serde(rename = "pendingAsyncWork")]
    pub(crate) pending_async_work: bool,
    /// How many of this session's children the host can still cancel right now.
    ///
    /// The host's own live set, read from the watch its stop verb walks, so a control drawn on this
    /// count is offered exactly where pressing it cancels something. `pending_async_work` above is
    /// the wider fact and cannot stand in for it: a detached batch that has already delivered its
    /// results leaves that flag set with nothing left to cancel.
    ///
    /// Absent on a host that predates the field, and absent reads as zero: the same rule the other
    /// fields on this shape follow, and a host that cannot name a cancellable child has none.
    #[serde(rename = "cancellableSubagents", default)]
    pub(crate) cancellable_subagents: usize,
    /// Epoch milliseconds of the newest engine event the host had observed for this session when it
    /// sent this frame, or `0` while it has seen none.
    ///
    /// Always serialized: the frontend uses it to tell a session that is genuinely still working
    /// from one whose host has gone quiet, and it gates on `> 0` - so `0` is the honest "unknown"
    /// for a host that predates the field, never a fabricated timestamp this side could not have.
    #[serde(rename = "lastEventAt")]
    pub(crate) last_event_at: i64,
    /// The session's running background jobs, in the order the host reported them.
    ///
    /// Serialized only when it names one, the same additivity rule `todo_phases` follows: "no jobs"
    /// and "nothing to show" are one fact to a reader, and the field stays additive for a frontend
    /// running against a host that predates it.
    #[serde(rename = "backgroundJobs", skip_serializing_if = "Vec::is_empty")]
    pub(crate) background_jobs: Vec<BackgroundJob>,
}

/// The engine's own split of the context in use, in tokens per category.
///
/// The ids are the engine's (`pi-tui/status-line/context-usage.ts`), and the frontend names them
/// back in `ContextCategoryTokens`: the system prompt, the tool definitions the engine published,
/// the injected system context, the skills it loaded, and the conversation itself. All five travel
/// even when empty, because a bar drawn from a partial set would misstate what is left.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextCategories {
    pub(crate) system_prompt: i64,
    pub(crate) system_tools: i64,
    pub(crate) system_context: i64,
    pub(crate) skills: i64,
    pub(crate) messages: i64,
}

/// What one session's calls have spent, in the engine's own buckets.
///
/// The three prompt-side numbers are what a cache hit rate is measured from: hits (`cacheRead`) over
/// hits plus misses (`input`). Writes are the cache being populated rather than a miss, so they
/// travel beside the rate rather than inside it, and the frontend words the ratio.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionUsageTotals {
    /// Prompt tokens the provider billed as fresh.
    pub(crate) input_tokens: i64,
    pub(crate) cache_read_tokens: i64,
    pub(crate) cache_write_tokens: i64,
}

/// One retry in flight, as the engine's `auto_retry_start` reports it.
///
/// The words are the wire contract the frontend declares by name (`SessionRetry` in
/// `src/utils/agentTypes.ts`): the attempt being waited on, the ceiling it counts against, the
/// delay before it, and the failure it is retrying from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRetry {
    pub(crate) attempt: i64,
    pub(crate) max_attempts: i64,
    pub(crate) delay_ms: i64,
    pub(crate) error_message: Option<String>,
}

/// One slash command as the engine advertises it in `available_commands_update`.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct EngineCommand {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) aliases: Vec<String>,
    /// The engine's `input.hint`: what shape the command's arguments take. Its own field
    /// name on the wire is dotted, so the projection renames it rather than leaking that.
    #[serde(rename = "inputHint")]
    pub(crate) input_hint: String,
    pub(crate) subcommands: Vec<EngineSubcommand>,
    /// Where the command comes from (`builtin`, `skill`, `file`, `custom`, `mcp_prompt`,
    /// `extension`), exactly as the engine names it.
    ///
    /// Carried rather than interpreted: it is what tells a reader (and a future plugin surface)
    /// which of the session's capabilities a command belongs to, and this side has no list of its
    /// own to check it against - the engine is the one that knows what it registered.
    pub(crate) source: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct EngineSubcommand {
    pub(crate) name: String,
    pub(crate) description: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ProviderSummary {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(rename = "apiKeyEnv")]
    pub(crate) api_key_env: String,
    pub(crate) configured: bool,
    pub(crate) authenticated: bool,
    pub(crate) available: bool,
    /// The stored keys' masked display forms, so the form can show what is saved without revealing it.
    #[serde(rename = "apiKeyMasks")]
    pub(crate) api_key_masks: Vec<String>,
}

/// The answer to a provider-key write: whether the *running* host took the key.
///
/// `live: false` is not a failed write. The key is in the OS credential store either way and the
/// next host spawn reads it from there; what the flag says is that no running process could be
/// told, so the settings page has to state that the key takes effect after a restart instead of
/// showing a success the user cannot observe yet.
#[derive(Debug, Clone, Copy, Serialize)]
pub(crate) struct ProviderKeyResult {
    pub(crate) live: bool,
}

/// One model of a user-defined provider, written into the engine's `models.yml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CustomModelDefinition {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(rename = "contextWindow")]
    pub(crate) context_window: i64,
    #[serde(rename = "maxTokens")]
    pub(crate) max_tokens: i64,
    #[serde(rename = "supportsImages")]
    pub(crate) supports_images: bool,
    #[serde(rename = "supportsReasoning")]
    pub(crate) supports_reasoning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CustomProviderInput {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(rename = "baseUrl")]
    pub(crate) base_url: String,
    pub(crate) api: String,
    pub(crate) models: Vec<CustomModelDefinition>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CustomProvider {
    #[serde(flatten)]
    pub(crate) input: CustomProviderInput,
    /// Environment variable the host injects the stored key into.
    #[serde(rename = "keyEnv")]
    pub(crate) key_env: String,
    #[serde(rename = "apiKeyConfigured")]
    pub(crate) api_key_configured: bool,
    /// The stored keys' masked display forms, so the editor can show what is saved without revealing it.
    #[serde(rename = "apiKeyMasks")]
    pub(crate) api_key_masks: Vec<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct CustomModelList {
    pub(crate) models: Vec<CustomModelDefinition>,
}

/// Why the host became unavailable. A stable token, never engine output or a path: the frontend
/// maps it to localized copy.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EngineExitReason {
    /// The host ended on its own (crash or stdin close).
    Exit,
    /// The host was restarted on request.
    Restart,
    /// Retired with the process pool: one host has no idle recycling, and the variant is kept
    /// because the enum is part of the frozen event contract.
    #[allow(dead_code)]
    Idle,
    /// The host ended before the protocol handshake (a missing or unusable artifact).
    StartupFailed,
    /// The host never became ready in time.
    StartupTimeout,
    /// Retired with per-workspace processes: no process belongs to a workspace any more.
    #[allow(dead_code)]
    WorkspaceRemoved,
}

/// Global runtime channel payload. The host serves every workspace, so no process is attributed
/// to one and `workspaceId` is always null now.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum RuntimeEvent {
    EngineReady {
        #[serde(rename = "workspaceId")]
        workspace_id: Option<i64>,
    },
    EngineExit {
        #[serde(rename = "workspaceId")]
        workspace_id: Option<i64>,
        reason: EngineExitReason,
    },
}

#[derive(Debug, Serialize)]
pub(crate) struct EngineDataPaths {
    #[serde(rename = "dataRoot")]
    pub(crate) data_root: String,
    #[serde(rename = "agentDir")]
    pub(crate) agent_dir: String,
    #[serde(rename = "configRoot")]
    pub(crate) config_root: String,
    /// Subtree the host process owns, `<dataRoot>/host`. Additive.
    #[serde(rename = "hostRoot")]
    pub(crate) host_root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "method", rename_all = "lowercase")]
pub(crate) enum UiRequest {
    Confirm {
        id: String,
        title: String,
        message: String,
        #[serde(rename = "timeoutMs")]
        timeout_ms: Option<u64>,
    },
    Select {
        id: String,
        title: String,
        message: String,
        options: Vec<String>,
        #[serde(rename = "optionDescriptions")]
        option_descriptions: Vec<String>,
        #[serde(rename = "timeoutMs")]
        timeout_ms: Option<u64>,
    },
    Input {
        id: String,
        title: String,
        message: String,
        placeholder: String,
        /// The engine's host hint that the answer is a credential: the field masks what is typed.
        /// Absent from an older host, which never asked for masking either.
        #[serde(skip_serializing_if = "is_false")]
        secret: bool,
        #[serde(rename = "timeoutMs")]
        timeout_ms: Option<u64>,
    },
    Editor {
        id: String,
        title: String,
        message: String,
        placeholder: String,
        #[serde(rename = "timeoutMs")]
        timeout_ms: Option<u64>,
    },
    /// The engine's rich ask dialog: one or more questions, each with its own options. This is the
    /// `ask` tool's own surface (`ExtensionUIContext.askDialog`), not the per-question `select`.
    Ask {
        id: String,
        questions: Vec<UiAskQuestion>,
        #[serde(rename = "timeoutMs")]
        timeout_ms: Option<u64>,
    },
}

/// One option of one question: the label is required, the two extras are the engine's own hints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UiAskOption {
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) preview: Option<String>,
}

/// One question of an `ask` dialog, field for field as the engine asked it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UiAskQuestion {
    pub(crate) id: String,
    pub(crate) question: String,
    #[serde(default)]
    pub(crate) header: Option<String>,
    #[serde(default)]
    pub(crate) options: Vec<UiAskOption>,
    /// Whether the reader may pick more than one option.
    #[serde(default)]
    pub(crate) multi: bool,
    /// Index of the recommended option; the engine also appends " (Recommended)" to its label.
    #[serde(default)]
    pub(crate) recommended: Option<i64>,
}

/// One answer within an ask response: the question it belongs to, and what was chosen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UiAskResult {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) question: String,
    #[serde(default)]
    pub(crate) options: Vec<String>,
    #[serde(default)]
    pub(crate) multi: bool,
    #[serde(default, rename = "selectedOptions")]
    pub(crate) selected_options: Vec<String>,
    #[serde(default, rename = "customInput")]
    pub(crate) custom_input: Option<String>,
    #[serde(default)]
    pub(crate) note: Option<String>,
    /// The answer came from the deadline rather than from the reader.
    #[serde(default, rename = "timedOut")]
    pub(crate) timed_out: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct UiResponse {
    #[serde(default)]
    pub(crate) value: Option<String>,
    #[serde(default)]
    pub(crate) confirmed: Option<bool>,
    #[serde(default)]
    pub(crate) cancelled: Option<bool>,
    /// `submit` (the questions were answered) or `chat` (the reader asked to discuss instead).
    #[serde(default)]
    pub(crate) kind: Option<String>,
    /// One entry per question, in the order they were asked.
    #[serde(default)]
    pub(crate) results: Option<Vec<UiAskResult>>,
}

impl UiResponse {
    /// Validates the response payload against the method that produced the request.
    pub(crate) fn validate(&self, method: &str) -> Result<(), &'static str> {
        if self.cancelled == Some(true) {
            return Ok(());
        }
        match method {
            "confirm" => match self.confirmed {
                Some(_) => Ok(()),
                None => Err("A confirm response requires `confirmed`."),
            },
            "select" | "input" | "editor" => match self.value.as_deref() {
                Some(_) => Ok(()),
                None => Err("This response requires `value`."),
            },
            // A chat answer carries no selections: the engine redirects the turn instead of
            // reading them. A submission must carry the results, one per question.
            "ask" => match (self.kind.as_deref(), self.results.is_some()) {
                (Some("chat"), _) => Ok(()),
                (Some("submit"), true) => Ok(()),
                _ => Err("An ask response requires `kind` and, for `submit`, `results`."),
            },
            _ => Err("This request does not accept a response."),
        }
    }
}

#[cfg(test)]
mod tests;

/// Serde predicate for a boolean that only travels when it is true: an optional fact, not a field
/// every older reader has to learn.
fn is_false(value: &bool) -> bool {
    !*value
}

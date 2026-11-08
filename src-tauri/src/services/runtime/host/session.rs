//! One conversation, as this process tracks it while the host serves it.
//!
//! A session is addressed by the id the host minted for its file (`s<16 hex>`); nothing here
//! holds an engine object, because the engine lives on the other side of the pipe. What this
//! process keeps is the routing key, the file it belongs to, the turn state the UI has to see,
//! the dialogs the host is waiting on, and one projector per session - so two conversations can
//! stream at the same time without either one's events reaching the other's channel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::AppHandle;

use super::super::events::EventState;
use super::super::{clamp_text, emit_session, nonempty_text, stringify};
use crate::models::agent::{
    default_modes, subagent_model, BackgroundJob, ContextCategories, EngineCommand,
    EngineSubcommand, SessionRetry, SessionRuntimeState, SessionUsageTotals, SubagentRecentTool,
    SubagentRow, TodoItem, TodoPhase, TodoStatus,
};
use crate::services::session_title::clean_title_text;

/// Shortest interval between two replay attempts for one session.
pub(crate) const REPLAY_MIN_INTERVAL_MS: u64 = 5_000;

/// Consecutive failed stream repairs after which the conversation is told it stopped updating.
///
/// A repair is the replay asked for when a frame arrives ahead of the cursor, or the state resync a
/// truncated replay re-anchors to; a repair that fails leaves the cursor where it was, so every later
/// live frame reads as another gap and is dropped. One failure is not worth a row on screen - the host
/// may be busy inside the turn it is running, and the next attempt is `REPLAY_MIN_INTERVAL_MS` away -
/// but this many in a row means the reader has been looking at a frozen conversation, and the notice
/// is what says so. The count is reset by the first repair that lands, so a later episode reports
/// again.
pub(crate) const REPLAY_FAILURES_BEFORE_NOTICE: u32 = 3;

/// What a frame's `seq` says about where it belongs in the session's stream.
///
/// The three answers are the whole of the gap logic: a frame that advances the cursor is the next
/// one, a frame below it was already delivered, and a frame above it means the frames in between
/// never arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrameOrder {
    /// The next frame expected (or one that carries no `seq` at all): deliver it.
    Next,
    /// Already delivered: the host resent it, or a replay overlapped a live frame.
    Duplicate,
    /// Ahead of the cursor: the frames in between are missing, so a replay is owed.
    Gap,
}

/// Everything this process knows about one live conversation.
pub(crate) struct SessionRuntime {
    /// Routing key minted by the host: the digest of the session file.
    pub(crate) id: String,
    /// Session file, spelled the way the frontend's index spells it. Kept across a close so a
    /// restart can rebuild the conversation from it.
    file: Mutex<Option<String>>,
    /// Working directory the session was opened with.
    cwd: String,
    workspace_id: Option<i64>,
    /// Whether a turn is running. The host is the authority; this mirrors what it reported.
    streaming: AtomicBool,
    /**
     * Whether the reader has this conversation on screen.
     *
     * It is not a fact about the conversation - the engine does not stream differently - but about
     * how much of its stream is worth carrying across the IPC: text for a conversation nobody is
     * looking at is delivered on a slower window (see `events.rs` and `BACKGROUND_DELTA_FLUSH_MS`),
     * so several conversations running side by side no longer cost the webview one event per
     * frame each. It starts **watched** - the default is the cadence every reader had before this
     * existed, and a child transcript (which the frontend never watches) keeps it - and the
     * frontend clears it when a conversation is left (`commands/sessions.rs::session_watch`).
     */
    watched: AtomicBool,
    /// Set while this session's projector holds increments no delivery window has flushed yet.
    ///
    /// The dispatcher's flush pass runs on every inbound frame (and on the idle tick), and this is
    /// what keeps it from locking every live conversation's projector to find out that most of them
    /// have nothing buffered: a session without the flag is skipped on one atomic load. It is a
    /// hint rather than the truth - the buffers behind it live inside the projector's own mutex -
    /// so a pass that misses a fresh increment delivers it on the next one.
    delta_pending: AtomicBool,
    /// Set while the session carries a turn the host lost (it was streaming when the host died or
    /// was restarted) and cleared as soon as a new turn starts.
    interrupted: AtomicBool,
    /// `seq` of the last frame this process routed for the session, for the optional `seq` field
    /// on the frontend events.
    last_frame_seq: AtomicU64,
    /// Next `seq` this process expects from the host.
    expected_seq: AtomicU64,
    /// One replay at a time: a gap is repaired by asking the host, not by asking twice.
    replaying: AtomicBool,
    /// Host time of the last replay attempt, so a host that cannot answer `session_replay` is not
    /// asked once per missing frame.
    last_replay_ms: AtomicU64,
    /// Repairs that have failed in a row, for the one report a stalled conversation gets.
    ///
    /// Owner: this session record; bound: a small counter, never a container; release: the first
    /// repair that lands resets it, and it goes with the record when the session is closed, evicted
    /// or torn down (`host/ops.rs`, `host/session.rs::remove_session`).
    repair_failures: AtomicU32,
    /// Request id -> UI method, so an answer can be validated against the request that asked.
    ui_requests: Mutex<HashMap<String, String>>,
    /// The engine's live roster of the subagents this session spawned, merged from the lifecycle
    /// and progress frames that describe each child.
    subagents: Mutex<SubagentRoster>,
    /// Projector: engine events in, frontend frames out.
    pub(crate) events: tokio::sync::Mutex<EventState>,
    /// Serializes session state reads, so two refreshes cannot publish out of order.
    pub(crate) state_lock: tokio::sync::Mutex<()>,
}

impl SessionRuntime {
    pub(crate) fn new(
        id: String,
        cwd: String,
        workspace_id: Option<i64>,
        file: Option<String>,
    ) -> Self {
        Self {
            events: tokio::sync::Mutex::new(EventState::new(id.clone())),
            id,
            file: Mutex::new(file),
            cwd,
            workspace_id,
            streaming: AtomicBool::new(false),
            watched: AtomicBool::new(true),
            delta_pending: AtomicBool::new(false),
            interrupted: AtomicBool::new(false),
            last_frame_seq: AtomicU64::new(0),
            // The host numbers a session's events from 1, and `session_open` is the resync point.
            expected_seq: AtomicU64::new(1),
            replaying: AtomicBool::new(false),
            last_replay_ms: AtomicU64::new(0),
            repair_failures: AtomicU32::new(0),
            ui_requests: Mutex::new(HashMap::new()),
            subagents: Mutex::new(SubagentRoster::default()),
            state_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub(crate) fn file(&self) -> Option<String> {
        super::lock(&self.file).clone()
    }

    pub(crate) fn set_file(&self, file: Option<String>) {
        *super::lock(&self.file) = file;
    }

    pub(crate) fn cwd(&self) -> &str {
        &self.cwd
    }

    pub(crate) fn workspace_id(&self) -> Option<i64> {
        self.workspace_id
    }

    /// Whether this is a conversation the reader owns rather than a subagent's own projection.
    ///
    /// A child's projector is built with no workspace (`host/child_events.rs`), so this is the one
    /// fact that tells a turn the reader waits on apart from a step inside one.
    pub(crate) fn is_top_level(&self) -> bool {
        self.workspace_id.is_some()
    }

    pub(crate) fn is_streaming(&self) -> bool {
        self.streaming.load(Ordering::Relaxed)
    }

    pub(crate) fn set_streaming(&self, streaming: bool) {
        self.streaming.store(streaming, Ordering::Relaxed);
    }

    /// Whether the reader has this conversation on screen (see [`SessionRuntime::watched`]).
    pub(crate) fn is_watched(&self) -> bool {
        self.watched.load(Ordering::Relaxed)
    }

    pub(crate) fn set_watched(&self, watched: bool) {
        self.watched.store(watched, Ordering::Relaxed);
    }

    /// Whether this session's projector holds increments a delivery window has not flushed yet.
    pub(crate) fn has_pending_deltas(&self) -> bool {
        self.delta_pending.load(Ordering::Relaxed)
    }

    /// Records that buffered increments are waiting for the next window; called by the projector
    /// while it holds its own lock, on the edge that first buffers something.
    pub(crate) fn mark_delta_pending(&self) {
        self.delta_pending.store(true, Ordering::Relaxed);
    }

    /// Records that the projector's buffers are empty again; also called by the projector, under
    /// the same lock, once a delivery has taken everything it held.
    pub(crate) fn clear_delta_pending(&self) {
        self.delta_pending.store(false, Ordering::Relaxed);
    }

    pub(crate) fn is_interrupted(&self) -> bool {
        self.interrupted.load(Ordering::Relaxed)
    }

    pub(crate) fn set_interrupted(&self, interrupted: bool) {
        self.interrupted.store(interrupted, Ordering::Relaxed);
    }

    pub(crate) fn last_frame_seq(&self) -> u64 {
        self.last_frame_seq.load(Ordering::Relaxed)
    }

    /// Records the `seq` of one routed frame.
    pub(crate) fn note_frame_seq(&self, seq: u64) {
        self.last_frame_seq.store(seq, Ordering::Relaxed);
    }

    /// Accounts for the `seq` one frame arrived with, and says what the caller must do with it.
    ///
    /// This is the single place the cursor moves: the host stamps **every** frame it publishes for
    /// a session (`host/src/events.ts::#stamp`), so the dedicated frames - a prompt result, a
    /// dialog, a command advertisement - carry a `seq` exactly like a projected engine event does.
    /// Accounting for the projected ones alone left the cursor behind, and the frame that followed
    /// such a dedicated one was then read as a hole: a pointless replay and a live frame dropped.
    ///
    /// A frame with no `seq` makes no ordering claim and is always delivered.
    pub(crate) fn accept_seq(&self, seq: Option<u64>, from_replay: bool) -> FrameOrder {
        let Some(seq) = seq else {
            return FrameOrder::Next;
        };
        let expected = self.expected_seq();
        if seq < expected {
            return FrameOrder::Duplicate;
        }
        if seq > expected && !from_replay {
            // The frames in between are still in the host's journal: ask for them rather than
            // projecting a conversation with a hole in it. The cursor is left where it is, so the
            // replay starts at the first missing frame.
            return FrameOrder::Gap;
        }
        self.set_expected_seq(seq + 1);
        self.note_frame_seq(seq);
        FrameOrder::Next
    }

    pub(crate) fn expected_seq(&self) -> u64 {
        self.expected_seq.load(Ordering::Relaxed)
    }

    pub(crate) fn set_expected_seq(&self, seq: u64) {
        self.expected_seq.store(seq, Ordering::Relaxed);
    }

    /// Returns true for the single caller that may start a replay for this session, and refuses
    /// while one is already running or while the last attempt is still fresh.
    pub(crate) fn begin_replay(&self, now_ms: u64) -> bool {
        if self.replaying.swap(true, Ordering::SeqCst) {
            return false;
        }
        let last = self.last_replay_ms.load(Ordering::Relaxed);
        if now_ms.saturating_sub(last) < REPLAY_MIN_INTERVAL_MS {
            self.replaying.store(false, Ordering::SeqCst);
            return false;
        }
        self.last_replay_ms.store(now_ms, Ordering::Relaxed);
        true
    }

    pub(crate) fn end_replay(&self) -> bool {
        self.replaying.swap(false, Ordering::SeqCst)
    }

    /// Charges one failed stream repair and answers how many have failed in a row.
    ///
    /// The caller compares the answer against [`REPLAY_FAILURES_BEFORE_NOTICE`], which is what makes
    /// the report once per episode: the count only returns to zero when a repair lands.
    pub(crate) fn note_repair_failure(&self) -> u32 {
        self.repair_failures.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Ends the failure episode: a repair landed, so this conversation is updating again.
    pub(crate) fn note_repair_success(&self) {
        self.repair_failures.store(0, Ordering::Relaxed);
    }

    /// Merges one `subagent` frame's payload into this session's roster and answers with the row
    /// when the frame changed it, `None` when the roster already said exactly that.
    ///
    /// `kind` is the host's own word for which half of a child the payload carries, and `now_ms` is
    /// the host clock the row is timed by on first sight - passed in rather than read here so the
    /// projection stays the only place that asks for the time.
    pub(crate) fn merge_subagent(
        &self,
        kind: &str,
        payload: &Value,
        now_ms: i64,
    ) -> Option<SubagentRow> {
        super::lock(&self.subagents).apply(kind, payload, now_ms)
    }

    pub(crate) fn remember_ui_request(&self, request_id: &str, method: &str) {
        super::lock(&self.ui_requests).insert(request_id.to_owned(), method.to_owned());
    }

    /// Removes the request if this process still holds it. The removal is the one-answer gate
    /// shared by the user's reply, the timeout and the host's own cancel.
    pub(crate) fn take_ui_request(&self, request_id: &str) -> Option<String> {
        super::lock(&self.ui_requests).remove(request_id)
    }

    /// The method the request was opened with, without consuming it.
    ///
    /// An answer is validated against the request that asked, and only a shape that passes may take
    /// the id: taking it first would let one malformed answer consume the gate, leaving the card
    /// with nothing that could answer it - neither the user's retry nor the timeout.
    pub(crate) fn ui_request_method(&self, request_id: &str) -> Option<String> {
        super::lock(&self.ui_requests).get(request_id).cloned()
    }

    /// Takes every still-open request id, so the callers can close those dialogs.
    pub(crate) fn drain_ui_requests(&self) -> Vec<String> {
        let mut requests = super::lock(&self.ui_requests);
        let ids = requests.keys().cloned().collect();
        requests.clear();
        ids
    }

    /// Publishes one frontend frame for this session, stamped with the `seq` of the host frame it
    /// was derived from. `seq` is additive: a frontend that ignores it sees the shape it saw
    /// before.
    pub(crate) fn emit(&self, app: &AppHandle, mut payload: Value) {
        let seq = self.last_frame_seq();
        if seq > 0 {
            if let Some(object) = payload.as_object_mut() {
                object.insert("seq".to_owned(), json!(seq));
            }
        }
        emit_session(app, &self.id, payload);
    }
}

/// Upper bound on the child rows one session keeps.
///
/// A roster is a live window rather than an archive: what a reader looks at is the children still
/// running plus the few that just settled. The cap is what keeps the frame size of a long-lived
/// session flat, whatever a batch happened to spawn.
const SUBAGENT_ROSTER_MAX: usize = 64;

/// Upper bound on each of a row's two lists. The engine tails bounded windows of its own (the last
/// few tools, the last few lines of output) and this repeats the bound, because a row is written by
/// another process: how large it can be is this side's decision, not the sender's.
const SUBAGENT_LIST_MAX: usize = 8;

/// The one word a row reads while the child works, and every word the roster itself may hold.
///
/// The frontend keeps the same vocabulary: a child is live while its status is neither settled word
/// and no other reading of a row exists on either side. `pending` is where a named child starts,
/// `running` is what the lifecycle edge and any progress a live child reports become, and the
/// settled words travel from the lifecycle frame verbatim.
const RUNNING_STATUS: &str = "running";
const ROSTER_STATUSES: [&str; 5] = ["pending", RUNNING_STATUS, "completed", "failed", "aborted"];

/// The engine's live subagent roster for one session, keyed by the child's own id.
///
/// One child is described by more than one frame and no single frame carries all of it: the
/// lifecycle frame names it and settles it, the progress frames say what it is doing. A row is
/// therefore the merge of both, and a frame that says nothing about a field leaves that field alone -
/// "this frame did not mention a tool" is not the same fact as "it is not inside one". A frame
/// that changes nothing is not published again either: the engine already coalesces its progress
/// frames, and a snapshot that repeats itself is one fact sent twice.
#[derive(Default)]
struct SubagentRoster {
    rows: HashMap<String, SubagentRow>,
    /// Ids in the order they were first seen, so the cap can take the ones settled longest first.
    order: Vec<String>,
}

impl SubagentRoster {
    /// Merges the half of a child one frame carries, and answers with the row when it changed.
    ///
    /// `kind` is the host's own word for which half it is (`lifecycle` / `progress`). A payload
    /// that names no child is dropped: there would be nothing to key the merge by, and a row
    /// nothing can be matched against is not a row.
    fn apply(&mut self, kind: &str, payload: &Value, now_ms: i64) -> Option<SubagentRow> {
        let id = subagent_id(kind, payload)?;
        if !self.rows.contains_key(&id) {
            self.make_room();
            self.order.push(id.clone());
            self.rows.insert(id.clone(), SubagentRow::new(&id, now_ms));
        }
        let row = self.rows.get(&id)?;
        // The merge is applied to a copy and compared, so "this frame changed something" is decided
        // by the row itself rather than by a flag per field: a merge that had to prove it mattered
        // field by field would eventually stop proving it.
        let mut merged = row.clone();
        match kind {
            "lifecycle" => merged.merge_lifecycle(payload),
            _ => merged.merge_progress(payload),
        }
        if merged == *row {
            return None;
        }
        self.rows.insert(id, merged.clone());
        Some(merged)
    }

    /// Drops one row, making room for the next.
    ///
    /// A settled row goes first - oldest first - because a child that has ended is the one nobody
    /// is waiting on any more. A roster whose children are all still running has nothing settled to
    /// drop, and then the oldest row goes: the cap is a bound on memory first, and the child that
    /// lost its row is one whose next frame simply opens a fresh one.
    fn make_room(&mut self) {
        while self.rows.len() >= SUBAGENT_ROSTER_MAX && !self.order.is_empty() {
            let victim = self
                .order
                .iter()
                .position(|id| self.rows.get(id).is_some_and(SubagentRow::is_settled))
                .unwrap_or(0);
            let id = self.order.remove(victim);
            self.rows.remove(&id);
        }
    }
}

/// The child a frame's payload names.
///
/// A lifecycle frame names it beside its other fields; a progress frame carries it inside the
/// progress record, which is where the engine's own registry reads it from too. One that names no
/// child at all is answered with `None` rather than being given an invented id.
fn subagent_id(kind: &str, payload: &Value) -> Option<String> {
    let holder = match kind {
        "progress" => payload.get("progress")?,
        _ => payload,
    };
    nonempty_text(holder.get("id"))
}

/// The merge of the frames that describe one child into the row they agree on.
///
/// Every field follows the same two rules: what a frame does not mention keeps the value the row
/// already holds, and what it does mention is bounded before it is kept.
impl SubagentRow {
    /// A row for a child the engine has just named, with nothing observed about it yet.
    ///
    /// `pending` is the engine's own word for a child that is known but not yet reported as
    /// running, and `now_ms` is this process's reading of when the child first appeared: the engine
    /// reports how long a child has run, never when it started.
    fn new(id: &str, now_ms: i64) -> Self {
        Self {
            id: id.to_owned(),
            agent: String::new(),
            index: 0,
            parent_tool_call_id: None,
            detached: false,
            status: "pending".to_owned(),
            description: None,
            assignment: None,
            tool_count: None,
            current_tool: None,
            current_tool_args: None,
            last_intent: None,
            model: None,
            tokens: None,
            duration_ms: None,
            started_at: now_ms,
            recent_tools: Vec::new(),
            recent_output: Vec::new(),
        }
    }

    /// True for a child that has ended, in whichever of the engine's three words it ended with.
    fn is_settled(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed" | "aborted")
    }

    /// Merges a lifecycle half: the child was named, and either started or settled.
    ///
    /// `started` becomes `running` because it is the lifecycle frame's own word for the state the
    /// roster calls `running`; every other status the engine sends is already a roster word and
    /// travels verbatim, including one this build has never seen - the frontend draws an unknown
    /// word as itself, and renaming it here would be this process inventing a state.
    fn merge_lifecycle(&mut self, payload: &Value) {
        set_required_text(&mut self.agent, payload.get("agent"));
        if let Some(status) = payload
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| !status.is_empty())
        {
            self.status = if status == "started" {
                "running".to_owned()
            } else {
                status.to_owned()
            };
        }
        if let Some(index) = payload.get("index").and_then(Value::as_i64) {
            self.index = index;
        }
        if let Some(detached) = payload.get("detached").and_then(Value::as_bool) {
            self.detached = detached;
        }
        set_text(&mut self.description, payload.get("description"));
        set_text(
            &mut self.parent_tool_call_id,
            payload.get("parentToolCallId"),
        );
    }

    /// Merges a progress half: what the child reports about itself right now.
    ///
    /// Everything above the `progress` record belongs to the spawn; everything inside it is the
    /// child's own report. The status inside it is the child's *own* word for what it is doing,
    /// which is not the roster's vocabulary - the engine's live rows say `active` where this
    /// roster says `running` - so an unknown one is read as the running state it describes rather
    /// than published as a word no reader of the roster knows. A row that has already settled is
    /// left with the outcome the lifecycle frame gave it: progress frames are the child talking
    /// about itself and the last of them can arrive after the edge that ended it, so letting one
    /// write `status` would let a finished child read as running for good.
    fn merge_progress(&mut self, payload: &Value) {
        set_required_text(&mut self.agent, payload.get("agent"));
        if let Some(index) = payload.get("index").and_then(Value::as_i64) {
            self.index = index;
        }
        if let Some(detached) = payload.get("detached").and_then(Value::as_bool) {
            self.detached = detached;
        }
        set_text(&mut self.assignment, payload.get("assignment"));
        set_text(
            &mut self.parent_tool_call_id,
            payload.get("parentToolCallId"),
        );
        let Some(progress) = payload.get("progress") else {
            return;
        };
        if !self.is_settled() {
            if let Some(status) = progress
                .get("status")
                .and_then(Value::as_str)
                .filter(|status| !status.is_empty())
            {
                self.status = if ROSTER_STATUSES.contains(&status) {
                    status.to_owned()
                } else {
                    RUNNING_STATUS.to_owned()
                };
            }
        }
        set_text(&mut self.description, progress.get("description"));
        set_text(&mut self.last_intent, progress.get("lastIntent"));
        set_text(&mut self.current_tool, progress.get("currentTool"));
        set_text(&mut self.current_tool_args, progress.get("currentToolArgs"));
        if let Some(model) = subagent_model(progress) {
            self.model = Some(model);
        }
        set_count(&mut self.tool_count, progress.get("toolCount"));
        set_count(&mut self.tokens, progress.get("tokens"));
        set_count(&mut self.duration_ms, progress.get("durationMs"));
        self.recent_tools = recent_tools(progress.get("recentTools"));
        self.recent_output = recent_output(progress.get("recentOutput"));
    }
}

/// What one frame said about a string field, or nothing when it said nothing.
///
/// Absent and empty are the same fact here - the engine did not say - so an empty string never
/// replaces what the row already holds. Everything that is kept goes through `clamp_text`, which is
/// the one place a cut is written into the value itself.
fn set_text(field: &mut Option<String>, value: Option<&Value>) {
    let Some(text) = value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    else {
        return;
    };
    *field = Some(clamp_text(text.to_owned()));
}

/// What one frame said about a numeric field, under the same "absent is not a value" rule.
fn set_count(field: &mut Option<i64>, value: Option<&Value>) {
    if let Some(number) = value.and_then(Value::as_i64) {
        *field = Some(number);
    }
}

/// The same rule for the two strings a row always carries: the agent type and the status.
///
/// They are not optional on the wire - a row without a status is not a row the frontend can draw -
/// so a frame that does not mention one leaves the word the row already holds, exactly as an
/// optional field does.
fn set_required_text(field: &mut String, value: Option<&Value>) {
    let Some(text) = value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    else {
        return;
    };
    *field = clamp_text(text.to_owned());
}

/// The tools a child finished recently, newest first.
///
/// An entry without a tool name is not a call a row can draw, so it is dropped rather than rendered
/// as an unnamed chip; the arguments are read exactly as a tool card's are, through the same
/// `stringify`, so a child's call reads the same here as it does in the transcript. The engine's
/// window is already small - the bound is repeated because the list crosses a process boundary.
fn recent_tools(value: Option<&Value>) -> Vec<SubagentRecentTool> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    Some(SubagentRecentTool {
                        tool: nonempty_text(entry.get("tool"))?,
                        args: stringify(entry.get("args")),
                    })
                })
                .take(SUBAGENT_LIST_MAX)
                .collect()
        })
        .unwrap_or_default()
}

/// The tail of what a child last printed, newest first.
///
/// Every line is clamped like every other string this process publishes, and the list carries the
/// same bound as the tool window: what the engine sends is already short, and a row is not the
/// place to find out whether that is still true.
fn recent_output(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|lines| {
            lines
                .iter()
                .filter_map(Value::as_str)
                .map(|line| clamp_text(line.to_owned()))
                .take(SUBAGENT_LIST_MAX)
                .collect()
        })
        .unwrap_or_default()
}

///
/// The command list one state payload carries, in the frontend's shape.
///
/// An entry without a name is dropped rather than projected as an empty-named command nothing
/// could address, and aliases, hints and subcommands are optional on the wire.
fn project_commands(state: &Value) -> Vec<EngineCommand> {
    let Some(entries) = state.get("commands").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut commands = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(name) = entry
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        commands.push(EngineCommand {
            name: name.to_owned(),
            description: entry
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            aliases: super::string_array(entry, "aliases"),
            // The engine's entry spells the hint inside `input`, which is why the frontend's
            // field is named differently: the projection renames it rather than leaking that.
            input_hint: entry
                .get("input")
                .and_then(|input| input.get("hint"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            subcommands: entry
                .get("subcommands")
                .and_then(Value::as_array)
                .map(|subcommands| {
                    subcommands
                        .iter()
                        .filter_map(|subcommand| {
                            Some(EngineSubcommand {
                                name: subcommand.get("name").and_then(Value::as_str)?.to_owned(),
                                description: subcommand
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_owned(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
            source: entry
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        });
    }
    commands
}

/// Projects the engine's category split, under the engine's own ids.
///
/// A category the engine did not report is zero rather than missing: every id travels, so the bar
/// drawn from this answer never has to guess whether a category is empty or simply unknown.
fn project_context_categories(categories: Option<&Value>) -> ContextCategories {
    let field = |name: &str| {
        categories
            .and_then(|value| value.get(name))
            .and_then(Value::as_i64)
            .unwrap_or_default()
    };
    ContextCategories {
        system_prompt: field("systemPrompt"),
        system_tools: field("systemTools"),
        system_context: field("systemContext"),
        skills: field("skills"),
        messages: field("messages"),
    }
}

/// Projects one session's cumulative token buckets, under the engine's own names.
///
/// A bucket the engine did not report is zero rather than missing: a session that has spent nothing
/// answers with three zeros, which is what a hit rate has to be able to divide by.
fn project_session_usage(usage: Option<&Value>) -> SessionUsageTotals {
    let field = |name: &str| {
        usage
            .and_then(|value| value.get(name))
            .and_then(Value::as_i64)
            .unwrap_or_default()
    };
    SessionUsageTotals {
        input_tokens: field("inputTokens"),
        cache_read_tokens: field("cacheReadTokens"),
        cache_write_tokens: field("cacheWriteTokens"),
    }
}

/// Projects the host's session state into the payload the frontend renders.
///
/// The state's own `sessionId` is the SDK's own session identity and is deliberately not used
/// anywhere: routing, channels and the frontend's key all use the digest this process opened the
/// session with.
pub(crate) fn project_state(session: &SessionRuntime, state: &Value) -> SessionRuntimeState {
    let (model_provider, model_id) = model_of(state);
    let usage = state.get("contextUsage").cloned().unwrap_or(Value::Null);
    SessionRuntimeState {
        session_id: session.id.clone(),
        tip_entry_id: state
            .get("tipEntryId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        model_provider,
        model_id,
        thinking_level: state
            .get("thinkingLevel")
            .and_then(Value::as_str)
            .map(str::to_owned),
        // The same field the model rows carry, read the same way: what the host did not send is an
        // empty list, which is the session's honest answer to "what can this model be asked for".
        thinking_levels: super::string_array(state, "thinkingLevels"),
        is_streaming: state
            .get("isStreaming")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| session.is_streaming()),
        is_compacting: state
            .get("isCompacting")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        // The modes are the host's own JSON (goal accounting, plan file, vibe worker rows), so
        // they travel unchanged; an absent object is a host that predates modes.
        modes: state
            .get("modes")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(default_modes),
        retry: project_retry(state),
        message_count: state
            .get("messageCount")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        context_tokens: usage
            .get("tokens")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        context_window: usage
            .get("contextWindow")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        context_percent: usage
            .get("percent")
            .and_then(Value::as_f64)
            .unwrap_or_default(),
        // The engine's own boundary for this session's model: what the ring cannot say by itself,
        // and the number the settings card's switch either lets happen or turns off.
        auto_compact_percent: usage.get("autoCompactPercent").and_then(Value::as_f64),
        // Whether the occupancy is a measurement or the engine's estimate of the next request's
        // size: the frontend marks the estimated case rather than showing both the same way.
        context_anchored: usage
            .get("anchored")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        // The engine's own split of the occupancy, read under its own category ids: a category it
        // did not report counts as none of it, which is what a session holding no skills has.
        context_categories: project_context_categories(usage.get("categories")),
        // What the session has spent so far, read from the same state view: the three prompt-side
        // buckets a cache hit rate is measured from, counted by the engine's own index.
        session_usage: project_session_usage(state.get("sessionUsage")),
        // Read from the same payload as every other field here: the host carries the list in both
        // the open response and every state frame, and the advertisement that would have filled a
        // copy on this side arrives *before* the session this process opens is registered - so a
        // copy is exactly what a new conversation would not have.
        commands: project_commands(state),
        interrupted: session.is_interrupted(),
        todo_phases: project_todo_phases(state),
        // A host that predates the field has nothing outstanding by this build's reckoning: the
        // field exists to tell the frontend whether poking the session can still produce work, and
        // "not tracked" is answered the same way as "nothing pending".
        pending_async_work: state
            .get("pendingAsyncWork")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        // What the host says its own stop can still cancel. A host that predates the field names
        // none, and none is the honest reading of a count nothing reported.
        cancellable_subagents: state
            .get("cancellableSubagents")
            .and_then(Value::as_u64)
            .map_or(0, |count| count as usize),
        // When the host last saw an engine event for this conversation, or `0` when it has seen
        // none: a host that predates the field answers with nothing, and `0` is the honest
        // "unknown" the frontend already gates on rather than a timestamp this side could invent.
        last_event_at: state
            .get("lastEventAt")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        // The jobs the host still runs in the background for this conversation, read off the same
        // payload: a host that predates the field reports none, which is the same answer as a
        // session with nothing outstanding.
        background_jobs: project_background_jobs(state.get("backgroundJobs")),
    }
}

/// The session's running background jobs, read off the host's state payload.
///
/// A job needs an id to be one - anything else in the list is a shape this build cannot address,
/// and dropping it is better than drawing a row that names nothing (the same tolerance
/// [`project_todo_phases`] shows). The remaining fields are carried as the host worded them, and
/// the two it may omit default to `""`/`0` rather than making the whole entry unusable.
fn project_background_jobs(value: Option<&Value>) -> Vec<BackgroundJob> {
    let Some(jobs) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    jobs.iter()
        .filter_map(|job| {
            let id = job
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())?;
            Some(BackgroundJob {
                id: id.to_owned(),
                kind: job
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                label: job
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                started_at: job
                    .get("startedAt")
                    .and_then(Value::as_i64)
                    .unwrap_or_default(),
            })
        })
        .collect()
}

/// The retry the host reports, when it reports one.
///
/// A record with no attempt is not a retry this build can describe, and the frontend's label
/// counts attempts: absent is the honest reading, and the closing line falls back to the plain
/// working one rather than claiming a retry it cannot number.
fn project_retry(state: &Value) -> Option<SessionRetry> {
    let retry = state.get("retry")?;
    let attempt = retry.get("attempt").and_then(Value::as_i64)?;
    Some(SessionRetry {
        attempt,
        max_attempts: retry
            .get("maxAttempts")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        delay_ms: retry
            .get("delayMs")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        error_message: retry
            .get("errorMessage")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
    })
}

/// The engine's live todo list, read off the host's state payload.
///
/// A task needs a content and a status to be one - anything else in the list is a shape this build
/// does not know, and dropping it is better than rendering a row with no words in it. A status the
/// engine has moved past becomes `Unknown`, which the dock still draws as a task.
fn project_todo_phases(state: &Value) -> Vec<TodoPhase> {
    let Some(phases) = state.get("todoPhases").and_then(Value::as_array) else {
        return Vec::new();
    };
    phases
        .iter()
        .filter_map(|phase| {
            let name = phase.get("name").and_then(Value::as_str)?;
            let tasks = phase
                .get("tasks")
                .and_then(Value::as_array)
                .map(|tasks| {
                    tasks
                        .iter()
                        .filter_map(|task| {
                            let content = task.get("content").and_then(Value::as_str)?;
                            let status = task
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            Some(TodoItem {
                                content: content.to_owned(),
                                status: TodoStatus::from_wire(status),
                                blocker: task
                                    .get("blocker")
                                    .and_then(Value::as_str)
                                    .filter(|note| !note.is_empty())
                                    .map(str::to_owned),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(TodoPhase {
                name: name.to_owned(),
                tasks,
            })
        })
        .collect()
}

/// Projects one state payload and publishes it as the session's `state` event.
pub(crate) fn emit_state(
    app: &AppHandle,
    session: &Arc<SessionRuntime>,
    state: &Value,
) -> SessionRuntimeState {
    let projected = project_state(session, state);
    session.emit(app, json!({"type": "state", "state": projected}));
    projected
}

/// Session name the host reported, when it reported one.
///
/// The name is engine-authored title text, so it is cleaned through the one rule the session index
/// applies to a file's title slot: a translated marker envelope (`<标题>…</标题>`) is transport,
/// not part of the name, and a name that cleans to nothing is no name at all.
pub(crate) fn title_of(state: &Value) -> Option<String> {
    state
        .get("sessionName")
        .and_then(Value::as_str)
        .map(clean_title_text)
        .filter(|value| !value.is_empty())
}

pub(crate) fn model_of(state: &Value) -> (Option<String>, Option<String>) {
    let model = state.get("model");
    let provider = model
        .and_then(|value| value.get("provider"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let id = model
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    (provider, id)
}

#[cfg(test)]
mod tests;

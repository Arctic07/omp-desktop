//! The host process: one child for the whole application, the sessions it serves, and the lifecycle
//! around it. It is started lazily, kept for the life of the application and restarted when it dies;
//! the frontend sees it only through a command's answer, a `state` frame, or the `omp:runtime` events.

pub(crate) mod browser;
pub(crate) mod capabilities;
pub(crate) mod child_events;
pub(crate) mod lifecycle;
pub(crate) mod mcp_import;
pub(crate) mod omp_import;
pub(crate) mod ops;
pub(crate) mod plugin_data;
pub(crate) mod plugins;
pub(crate) mod process;
pub(crate) mod protocol;
pub(crate) mod replay;
pub(crate) mod routing;
pub(crate) mod session;
pub(crate) mod terminal;

pub(crate) use session::SessionRuntime;

use std::collections::{HashMap, VecDeque};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::{oneshot, Notify};

use crate::errors::{IpcError, IpcResult, ENGINE_SPAWN_FAILED, HOST_EXITED, HOST_NOT_READY};
use crate::models::agent::{
    EngineExitReason, EngineModel, ModelRoleModel, ModelRoleRow, ProcessRole, ProcessState,
    RuntimeEvent, RuntimeProcess,
};
use crate::services::paths::DataPaths;

use super::protocol::FrameLimits;
use super::{emit_runtime, EngineLog, MAX_PENDING_BYTES, PROTOCOL_VERSION};

/// Backoff between automatic restarts, indexed by the attempt that is about to run.
const RESTART_BACKOFF_MS: [u64; 3] = [0, 1_000, 3_000];
/// Automatic restarts allowed in one series before the host is left degraded.
const RESTART_MAX_ATTEMPTS: u32 = 3;
/// A host that stayed ready this long counts as healthy, so the next crash starts a fresh series
/// instead of inheriting the attempts of an hour-old failure.
const RESTART_STABLE_MS: u64 = 60_000;

/// How often a live host with open conversations is asked whether it is still answering.
const HEALTH_PROBE_INTERVAL_MS: u64 = 20_000;
/// How long one health probe may take before it counts as unanswered.
const HEALTH_PROBE_TIMEOUT_MS: u64 = 10_000;
/// Consecutive unanswered probes before the process is treated as wedged.
const HEALTH_PROBE_FAILURES: u32 = 3;

/// Taking a poisoned lock is not a reason to take the application down: every holder only mutates
/// short-lived state, so the inner value is still usable.
pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Lifecycle of the single host process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostStatus {
    /// No process: never started, shut down, or given up on.
    Stopped,
    /// A process exists but has not finished its handshake.
    Starting,
    /// The handshake completed; the host serves commands.
    Ready,
    /// Automatic restarts were exhausted.
    Degraded,
}

impl HostStatus {
    /// Stable machine token, for the one place the status leaves this process (`runtime_status`).
    ///
    /// The runtime status page needs the difference between "no host has been started" and "the
    /// host gave up": both render as a process entry that is not running, and only the second one
    /// explains why nothing the user tries next will work until they restart it.
    pub(crate) fn token(self) -> &'static str {
        match self {
            HostStatus::Stopped => "stopped",
            HostStatus::Starting => "starting",
            HostStatus::Ready => "ready",
            HostStatus::Degraded => "degraded",
        }
    }
}

/// One message from the stdout reader to the dispatcher.
pub(super) enum Inbound {
    /// One decoded frame, with the wire size it is charged against [`InboundBudget`] with.
    Frame(Value, usize),
    Malformed(String),
    Closed,
}

/// The byte budget of the inbound queue.
///
/// The queue itself is bounded by count (`MAX_PENDING_FRAMES`); this bounds it by bytes as well,
/// which the count cannot do on its own - one queued item is a frame already parsed, and a
/// reassembled frame may be tens of megabytes. The reader thread charges a frame's own wire size
/// (its physical line, or what a chunk sequence reassembled to) before it queues it; the dispatcher
/// returns it once the frame has been handled. Both ends are the same generation, so the budget is
/// dropped with them rather than shared across restarts.
///
/// What the ceiling is stated in is wire bytes: the parsed value behind one queued frame costs a
/// constant factor more than its text, so the queue's real footprint is `MAX_PENDING_BYTES` times
/// that factor, never a function of how many frames a host chose to send.
///
/// A frame larger than the whole budget is let through only while nothing else is queued: it has to
/// be able to pass at all (the host would otherwise be stuck behind a frame it is allowed to send),
/// and waiting for an empty queue is the strongest condition that cannot deadlock.
///
/// The budget is closed when the dispatcher stops - by its own exit, by a panic in a handler, or by
/// the task being aborted - because every one of those leaves bytes nobody will release again, and
/// the reader would wait for a release that cannot come for the life of the process.
pub(super) struct InboundBudget {
    held: Mutex<usize>,
    released: Condvar,
    closed: AtomicBool,
}

impl InboundBudget {
    pub(super) fn new() -> Self {
        Self {
            held: Mutex::new(0),
            released: Condvar::new(),
            closed: AtomicBool::new(false),
        }
    }

    /// Blocks until `bytes` fit in the budget, then charges them. Must be paired with
    /// [`InboundBudget::release`] once the frame has been handled. `false` means the dispatcher is
    /// gone and the caller has to stop reading: nothing will release these bytes again.
    pub(super) fn charge(&self, bytes: usize) -> bool {
        let mut held = self.lock();
        loop {
            if self.closed.load(Ordering::SeqCst) {
                return false;
            }
            if *held == 0 || held.saturating_add(bytes) <= MAX_PENDING_BYTES {
                *held = held.saturating_add(bytes);
                return true;
            }
            held = self
                .released
                .wait(held)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    /// Returns what one handled frame was charged.
    pub(super) fn release(&self, bytes: usize) {
        let mut held = self.lock();
        *held = held.saturating_sub(bytes);
        self.released.notify_one();
    }

    /// Ends every wait: called when the dispatcher stops, however it stops.
    pub(super) fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.released.notify_all();
    }

    fn lock(&self) -> MutexGuard<'_, usize> {
        // A poisoned lock is not a reason to take the application down: every holder only adds and
        // subtracts one number, so the inner value is still usable.
        self.held
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The conversations this process has open, and the snapshot every reader iterates.
///
/// The frame loop asks for the whole registry once per inbound frame (the delta flush pass), and a
/// conversation's own commands ask for one entry by id. Keeping the snapshot beside the map means
/// the per-frame read costs one lock and one reference count instead of one heap allocation plus
/// one clone per conversation: the snapshot is rebuilt only when the registry changes, which is a
/// handful of times per session rather than a handful of times per frame.
///
/// Both structures are mutated through this type's own methods only, under one lock, so the
/// snapshot cannot describe a registry that no longer exists.
struct SessionRegistry {
    by_id: HashMap<String, Arc<SessionRuntime>>,
    /// `None` once the map has changed, rebuilt by the next reader.
    snapshot: Option<Arc<Vec<Arc<SessionRuntime>>>>,
}

impl SessionRegistry {
    fn new() -> Self {
        Self {
            by_id: HashMap::new(),
            snapshot: None,
        }
    }

    fn insert(&mut self, session: Arc<SessionRuntime>) {
        self.snapshot = None;
        self.by_id.insert(session.id.clone(), session);
    }

    fn remove(&mut self, session_id: &str) {
        self.snapshot = None;
        self.by_id.remove(session_id);
    }

    fn get(&self, session_id: &str) -> Option<Arc<SessionRuntime>> {
        self.by_id.get(session_id).cloned()
    }

    fn len(&self) -> usize {
        self.by_id.len()
    }

    /// Every conversation, in the registry's own order (which is unspecified, exactly as the map
    /// this replaced was). The same `Arc` is handed back until the registry changes, so an
    /// iteration costs nothing to start.
    fn all(&mut self) -> Arc<Vec<Arc<SessionRuntime>>> {
        if let Some(snapshot) = self.snapshot.as_ref() {
            debug_assert_eq!(
                snapshot.len(),
                self.by_id.len(),
                "every registry change rebuilds the snapshot"
            );
            return Arc::clone(snapshot);
        }
        let snapshot = Arc::new(self.by_id.values().cloned().collect());
        self.snapshot = Some(Arc::clone(&snapshot));
        snapshot
    }

    /// Takes every conversation out, for a generation that is over.
    fn drain(&mut self) -> Vec<Arc<SessionRuntime>> {
        self.snapshot = None;
        self.by_id.drain().map(|(_, session)| session).collect()
    }
}

/// Ceiling on the commands this process will have in flight at once.
///
/// `pending` is the registry of what is waiting for an answer, and the stdin queue is what carries
/// the commands out; both are bounded by this, so a caller that keeps sending cannot grow either
/// one without end. A refusal here means the host is not draining what it is given: the ceiling is
/// far above any legitimate burst, and a command still unanswered after its timeout cannot be acted on.
pub(super) const MAX_IN_FLIGHT_COMMANDS: usize = 64;

/// Shutdown acknowledgements sent without a `pending` entry, bounded separately (only `host_shutdown`).
pub(super) const UNAWAITED_MAX: usize = 8;

/// The refusal for a command that cannot be sent because too many are already in flight.
pub(super) fn host_busy() -> IpcError {
    IpcError::new(
        crate::errors::HOST_BUSY,
        "The engine host is still busy with earlier commands. Try again in a moment.",
    )
}

/// State the stdio threads and the dispatcher both need.
pub(super) struct HostShared {
    /// Transport limits, refreshed from the host's `hello`.
    pub(super) limits: Mutex<FrameLimits>,
    pub(super) log: Arc<EngineLog>,
    /// Last non-empty stderr line, redacted; the only explanation a failed handshake can carry.
    pub(super) stderr_tail: Mutex<Option<String>>,
    /// When the stdout reader last decoded a frame; `watch_liveness` reads it (see that function).
    pub(super) last_frame_ms: AtomicU64,
}

/// What the host said about itself when it greeted.
#[derive(Debug, Clone, Default)]
pub(crate) struct HelloInfo {
    pub(crate) host_version: String,
    pub(crate) sdk_version: String,
    pub(crate) bun_version: String,
    pub(crate) target: String,
}

/// One command waiting for its response.
struct Pending {
    sender: oneshot::Sender<Value>,
    /// `session_prompt` may be acknowledged first and fail later under the same id, so its id is
    /// remembered past the acknowledgement.
    prompt: bool,
    session_id: Option<String>,
}

/// The conversations a restart has to rebuild.
struct SessionSnapshot {
    id: String,
    file: Option<String>,
    cwd: String,
    workspace_id: Option<i64>,
    streaming: bool,
}

pub(super) struct HostState {
    /// Incremented for every spawn. A dispatcher only mutates state that belongs to its own
    /// generation, so the reader of a killed process can never tear down its replacement.
    generation: u64,
    status: HostStatus,
    child: Option<Arc<Mutex<Child>>>,
    stdin: Option<std::sync::mpsc::SyncSender<Vec<u8>>>,
    pid: u32,
    shared: Arc<HostShared>,
    hello: Option<HelloInfo>,
    /// Set when the host reported a `host_fatal` frame; the handshake is failed with it and the
    /// process is never restarted automatically (contract §1.3).
    fatal: Option<IpcError>,
    /// Set when the host answered the handshake with a failure this process must not retry.
    no_retry: bool,
    ready: Option<IpcResult<()>>,
    pending: HashMap<String, Pending>,
    /// Prompt ids that were already acknowledged, so a late failure under the same id is routed
    /// to its session instead of being dropped as an orphan.
    prompt_late: HashMap<String, String>,
    /// The conversations this process has open, and the snapshot the frame loop iterates.
    sessions: SessionRegistry,
    /// Snapshot of the sessions the next spawn has to rebuild.
    restore_queue: Vec<SessionSnapshot>,
    /// Set while the exit of the current process was asked for; the reason is reported once.
    intent: Option<EngineExitReason>,
    /// Set while the application is quitting, which suppresses any restart.
    quitting: bool,
    /// Whether the exit of the current generation has already been reported on `omp:runtime`.
    exit_reported: bool,
    started_at_ms: u64,
    ready_since_ms: u64,
    attempts: u32,
    /// Frames the host sent that no branch recognizes. A rising count is the signal that the host
    /// is speaking a vocabulary this process does not know.
    unknown_frames: u64,
    /// Frames (or journal windows) this process knows are gone: a replay whose journal no longer
    /// covered the gap. The UI renders a session that lost a frame from a fresh state snapshot, so
    /// this is the only trace the loss leaves.
    dropped_frames: u64,
    /// Replays this process asked the host for. Each one is a hole that was repaired from the
    /// journal; a growing count on a quiet session is a stream that keeps arriving out of order.
    replay_attempts: u64,
    /// Ids of commands whose response this process does not wait for - the `host_shutdown`
    /// acknowledgement. Bounded: only a handful can be outstanding, and the oldest is dropped once
    /// the window is full.
    unawaited: Vec<String>,
}

impl HostState {
    /// True while a frame can be written. `Starting` counts: `hello_ok` is the frame that ends the
    /// handshake, and it has to be allowed through before the host is ready.
    fn can_call(&self) -> bool {
        matches!(self.status, HostStatus::Starting | HostStatus::Ready) && self.stdin.is_some()
    }
}

/// Child transcripts one screen may keep watched at once.
///
/// A tab is one entry; a reader with more subagent transcripts open than this is deeper than the
/// panel's strip ever gets, and the oldest watch is dropped rather than allowing an unbounded set.
const WATCHED_CHILDREN_MAX: usize = 32;

struct HostInner {
    app: AppHandle,
    paths: DataPaths,
    spawn_lock: tokio::sync::Mutex<()>,
    state: Mutex<HostState>,
    /// The projectors of the subagent transcripts this process draws (see `child_events`).
    ///
    /// Beside the state rather than inside it: a child's projector outlives a frame and is read
    /// without the registry's lock (`protocol.rs` projects a child's event and the flush pass reads
    /// the same map), and the one path that ends it - the host's own exit - says so explicitly.
    child_projections: child_events::ChildProjections,
    /**
     * The child transcripts a screen currently has open, in the order they were opened.
     *
     * A child's own events are per token and the heaviest stream this bridge carries; projecting
     * them for a channel nobody listens to (the ordinary case: a subagent runs without its tab
     * being opened) built rows and published them into the void. `child_watch` marks the ids a tab
     * is drawing (`state/subagent-view.ts` sends it on open and close), and `on_subagent_event`
     * projects nothing else. Owner: this runtime; bound: `WATCHED_CHILDREN_MAX`, oldest dropped;
     * released: with the watch-off the tab sends, and with the process.
     */
    watched_children: Mutex<VecDeque<String>>,
    /// Signalled when `hello`, `fatal` or `ready` changes.
    startup_notify: Notify,
    /// `(provider id, environment name)` of the user-defined providers, injected at spawn.
    custom_env: Mutex<Vec<(String, String)>>,
    request_seq: AtomicU64,
}

/// The error every implicit start reports while the host is degraded.
pub(super) fn degraded() -> IpcError {
    IpcError::new(
        HOST_NOT_READY,
        "The engine host gave up after repeated failures. Restart it and try again.",
    )
}

/// What the runtime status reports about the host.
pub(crate) struct HostSnapshot {
    pub(crate) status: HostStatus,
    pub(crate) pid: Option<u32>,
    pub(crate) protocol_version: u32,
    pub(crate) hello: Option<HelloInfo>,
    pub(crate) live_sessions: usize,
    /// Frames the host sent that nothing here recognizes.
    pub(crate) unknown_frames: u64,
    /// Frames this process knows were lost to a truncated journal.
    pub(crate) dropped_frames: u64,
    /// Replays asked of the host to repair a gap.
    pub(crate) replay_attempts: u64,
}

impl HostSnapshot {
    /// The single process entry the status page renders, or none while nothing runs.
    pub(crate) fn processes(&self) -> Vec<RuntimeProcess> {
        let Some(pid) = self.pid else {
            return Vec::new();
        };
        let state = match self.status {
            HostStatus::Starting => ProcessState::Starting,
            HostStatus::Ready => ProcessState::Ready,
            HostStatus::Stopped | HostStatus::Degraded => ProcessState::Exited,
        };
        vec![RuntimeProcess {
            workspace_id: None,
            role: ProcessRole::Host,
            pid,
            state,
            session_id: None,
            workspace_root: None,
        }]
    }
}

#[derive(Clone)]
pub(crate) struct HostRuntime {
    inner: Arc<HostInner>,
}

impl HostRuntime {
    pub(crate) fn new(app: AppHandle, paths: DataPaths) -> Self {
        let log = Arc::new(EngineLog::new(&paths.logs, process::LOG_KEY));
        Self {
            inner: Arc::new(HostInner {
                app,
                paths,
                spawn_lock: tokio::sync::Mutex::new(()),
                state: Mutex::new(HostState {
                    generation: 0,
                    status: HostStatus::Stopped,
                    child: None,
                    stdin: None,
                    pid: 0,
                    shared: Arc::new(HostShared {
                        limits: Mutex::new(FrameLimits::default()),
                        log,
                        stderr_tail: Mutex::new(None),
                        last_frame_ms: AtomicU64::new(0),
                    }),
                    hello: None,
                    fatal: None,
                    no_retry: false,
                    ready: None,
                    pending: HashMap::new(),
                    prompt_late: HashMap::new(),
                    sessions: SessionRegistry::new(),
                    restore_queue: Vec::new(),
                    intent: None,
                    quitting: false,
                    exit_reported: false,
                    started_at_ms: 0,
                    ready_since_ms: 0,
                    attempts: 0,
                    unknown_frames: 0,
                    dropped_frames: 0,
                    replay_attempts: 0,
                    unawaited: Vec::new(),
                }),
                startup_notify: Notify::new(),
                child_projections: child_events::ChildProjections::new(),
                watched_children: Mutex::new(VecDeque::new()),
                custom_env: Mutex::new(Vec::new()),
                request_seq: AtomicU64::new(1),
            }),
        }
    }

    pub(crate) fn paths(&self) -> &DataPaths {
        &self.inner.paths
    }

    pub(crate) fn app(&self) -> &AppHandle {
        &self.inner.app
    }

    /// Appends one redacted line to the host's log file.
    pub(crate) fn log(&self, message: &str) {
        let shared = lock(&self.inner.state).shared.clone();
        shared.log.line(message);
    }

    /// Replaces the user-defined provider list used for key injection. Called at start-up and
    /// after every change to the registry, so the next spawn sees the current set.
    pub(crate) fn set_custom_providers(&self, entries: Vec<(String, String)>) {
        *lock(&self.inner.custom_env) = entries;
    }

    pub(crate) fn session(&self, session_id: &str) -> Option<Arc<SessionRuntime>> {
        lock(&self.inner.state).sessions.get(session_id)
    }

    /// Every conversation, as one snapshot the frame loop may iterate: while the registry is
    /// unchanged this is one lock and one reference count, with no allocation and no clone per
    /// conversation (see [`SessionRegistry`]).
    pub(crate) fn sessions(&self) -> Arc<Vec<Arc<SessionRuntime>>> {
        lock(&self.inner.state).sessions.all()
    }

    /// The projectors of the subagent transcripts this process draws (see `child_events`).
    ///
    /// Deliberately not part of `sessions()`: a child is not a conversation of this process, and
    /// every path that treats a record as one iterates that registry and never this map.
    pub(crate) fn child_projections(&self) -> &child_events::ChildProjections {
        &self.inner.child_projections
    }

    /// Records whether a screen has this child's transcript open (see `watched_children`).
    pub(crate) fn watch_child(&self, child_id: &str, watched: bool) {
        let mut watched_ids = lock(&self.inner.watched_children);
        watched_ids.retain(|id| id != child_id);
        if !watched {
            return;
        }
        watched_ids.push_back(child_id.to_owned());
        while watched_ids.len() > WATCHED_CHILDREN_MAX {
            watched_ids.pop_front();
        }
    }

    /// Whether a screen is drawing this child's transcript right now.
    pub(crate) fn is_child_watched(&self, child_id: &str) -> bool {
        lock(&self.inner.watched_children)
            .iter()
            .any(|id| id == child_id)
    }

    pub(crate) fn is_ready(&self) -> bool {
        lock(&self.inner.state).status == HostStatus::Ready
    }

    pub(crate) fn snapshot(&self) -> HostSnapshot {
        let state = lock(&self.inner.state);
        let live = state.sessions.len();
        let running = matches!(state.status, HostStatus::Starting | HostStatus::Ready);
        HostSnapshot {
            status: state.status,
            pid: running.then_some(state.pid),
            protocol_version: if state.status == HostStatus::Ready {
                lock(&state.shared.limits).protocol_version
            } else {
                PROTOCOL_VERSION
            },
            hello: state.hello.clone(),
            live_sessions: live,
            unknown_frames: state.unknown_frames,
            dropped_frames: state.dropped_frames,
            replay_attempts: state.replay_attempts,
        }
    }

    // ---- the dispatcher's own entry points ----

    /// True while `generation` is still the live process.
    pub(super) fn is_current(&self, generation: u64) -> bool {
        lock(&self.inner.state).generation == generation
    }

    pub(super) fn note_hello(&self, generation: u64, hello: HelloInfo, limits: FrameLimits) {
        let mut state = lock(&self.inner.state);
        if state.generation != generation {
            return;
        }
        state.hello = Some(hello);
        *lock(&state.shared.limits) = limits;
    }

    pub(super) fn note_fatal(&self, generation: u64, error: IpcError) {
        {
            let mut state = lock(&self.inner.state);
            if state.generation != generation {
                return;
            }
            state.fatal = Some(error.clone());
            state.no_retry = true;
            state.intent = Some(EngineExitReason::StartupFailed);
            state.ready = Some(Err(error));
        }
        self.inner.startup_notify.notify_waiters();
    }

    /// The handshake completed: the host serves commands from here on.
    pub(super) fn mark_ready(&self, generation: u64) {
        let greeting = {
            let mut state = lock(&self.inner.state);
            if state.generation != generation {
                return;
            }
            state.status = HostStatus::Ready;
            state.ready = Some(Ok(()));
            // A host that completed its handshake is healthy again: a crash after this point starts
            // a fresh restart series rather than continuing whatever failed before this spawn.
            state.no_retry = false;
            state.ready_since_ms = crate::services::store::now_ms().max(1) as u64;
            state.hello.as_ref().map(|hello| {
                format!(
                    "hostVersion={} sdkVersion={} bunVersion={} target={}",
                    hello.host_version, hello.sdk_version, hello.bun_version, hello.target
                )
            })
        };
        if let Some(greeting) = greeting {
            // One line naming the build that is serving: which host is running is otherwise only
            // visible in the frames it sends.
            self.log(&format!("engine host ready ({greeting})"));
        }
        self.inner.startup_notify.notify_waiters();
        emit_runtime(
            &self.inner.app,
            RuntimeEvent::EngineReady { workspace_id: None },
        );
    }

    /// Takes the pending request registered under `id`, if it is still waiting.
    pub(super) fn take_pending(
        &self,
        id: &str,
    ) -> Option<(oneshot::Sender<Value>, bool, Option<String>)> {
        lock(&self.inner.state)
            .pending
            .remove(id)
            .map(|pending| (pending.sender, pending.prompt, pending.session_id))
    }

    /// True while `id` is a prompt this process already acknowledged.
    pub(super) fn is_late_prompt(&self, id: &str) -> Option<String> {
        lock(&self.inner.state).prompt_late.get(id).cloned()
    }

    pub(super) fn forget_prompt(&self, id: &str) {
        lock(&self.inner.state).prompt_late.remove(id);
    }

    pub(super) fn note_frame_seen(&self, unknown: bool) {
        let mut state = lock(&self.inner.state);
        if unknown {
            state.unknown_frames += 1;
        }
    }

    pub(super) fn note_frame_dropped(&self, count: u64) {
        lock(&self.inner.state).dropped_frames += count;
    }

    pub(super) fn note_replay_attempt(&self) {
        lock(&self.inner.state).replay_attempts += 1;
    }

    /// Mints the id of a command whose response this process will not wait for, and remembers it so
    /// the acknowledgement is recognized for what it is.
    ///
    /// A shutdown has to name its own request even though nothing here awaits the answer: a command
    /// without an `id` makes the host answer with `id: null`, and an unattributable response is
    /// exactly what this process must not read as the host speaking on its own.
    pub(super) fn unawaited_id(&self) -> String {
        let id = format!(
            "shutdown-{}",
            self.inner.request_seq.fetch_add(1, Ordering::Relaxed)
        );
        let mut state = lock(&self.inner.state);
        if state.unawaited.len() >= UNAWAITED_MAX {
            state.unawaited.remove(0);
        }
        state.unawaited.push(id.clone());
        id
    }

    /// True when `id` names the acknowledgement of such a command; the id goes with it.
    pub(super) fn take_unawaited(&self, id: &str) -> bool {
        let mut state = lock(&self.inner.state);
        match state.unawaited.iter().position(|known| known == id) {
            Some(index) => {
                state.unawaited.remove(index);
                true
            }
            None => false,
        }
    }
}

/// Unwraps `{ success, data?, error?, code? }` into the command payload.
///
/// The host's own `code` (`session_busy`, `stale_cursor`, ...) is passed through when it is a
/// plain machine token, so the frontend can branch on it without matching message text.
pub(crate) fn response_data(response: &Value) -> IpcResult<Value> {
    let success = response
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if success {
        return Ok(response.get("data").cloned().unwrap_or(Value::Null));
    }
    let message = response
        .get("error")
        .and_then(Value::as_str)
        .map(super::sanitize_message)
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "The engine host rejected the command.".to_owned());
    Err(IpcError::from_engine(
        response.get("code").and_then(Value::as_str),
        message,
    ))
}

/// The error every call reports while no host can serve it. This process never starts one on the
/// command path: a cold start is asked for explicitly, so a runtime that is down says so.
pub(super) fn not_running() -> IpcError {
    IpcError::new(
        HOST_NOT_READY,
        "The engine host is not running. Restart it and try again.",
    )
}

/// Encodes one outbound frame, refusing anything above the advertised physical limit.
pub(super) fn encode_frame(shared: &HostShared, value: &Value) -> IpcResult<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| {
        IpcError::new(
            ENGINE_SPAWN_FAILED,
            "The command payload could not be encoded.",
        )
    })?;
    if bytes.len() + 1 > lock(&shared.limits).max_frame_bytes {
        return Err(IpcError::new(
            crate::errors::FRAME_TOO_LARGE,
            "The command exceeds the engine frame limit.",
        ));
    }
    bytes.push(b'\n');
    Ok(bytes)
}

pub(super) fn emit_session_failure(app: &AppHandle, session_id: &str, message: &str) {
    super::emit_session(
        app,
        session_id,
        json!({
            "type": "error",
            "code": HOST_EXITED,
            "message": super::sanitize_message(message),
        }),
    );
}

/// Model rows as both `session_config` and `models_reload` report them.
pub(crate) fn parse_models(data: &Value) -> Vec<EngineModel> {
    array_field(data, "models")
        .map(|entries| entries.iter().filter_map(parse_model).collect())
        .unwrap_or_default()
}

/// One model row. A row without an id is not a model this process can address, so it is skipped
/// rather than carried as an empty entry; everything else a host omits means "not reported" and
/// takes the model's own zero, with one deliberate exception: the thinking-level list, where "not
/// reported" and "offers nothing" are the same fact to the picker.
fn parse_model(entry: &Value) -> Option<EngineModel> {
    let id = entry.get("id").and_then(Value::as_str)?.to_owned();
    // An unnamed model is still addressable by its id.
    let name = text_or(entry, "name", &id);
    Some(EngineModel {
        provider: entry
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        id,
        name,
        context_window: entry
            .get("contextWindow")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        max_tokens: entry
            .get("maxTokens")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        // The engine reports modalities as a list; the panel only asks whether images are in it.
        supports_images: entry
            .get("input")
            .and_then(Value::as_array)
            .map(|values| values.iter().any(|value| value.as_str() == Some("image")))
            .unwrap_or(false),
        reasoning: entry
            .get("reasoning")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        thinking_levels: string_array(entry, "thinkingLevels"),
    })
}

/// One role's candidate pool, as `model_role_candidates` reports it.
///
/// The rows are the catalogue's own shape - the host builds both from one mapping - so they are
/// parsed by the same function. The truncation flag is separate because it is a fact about the
/// pool rather than about any row: a shortened list has to be reported, not answered as if it were
/// the whole pool.
pub(crate) fn parse_role_candidates(data: &Value) -> (Vec<EngineModel>, bool) {
    let truncated = data.get("truncated").and_then(Value::as_bool);
    (parse_models(data), truncated.unwrap_or(false))
}

/// The engine's role table, as `model_roles` and `model_role_set` report it.
pub(crate) fn parse_roles(data: &Value) -> Vec<ModelRoleRow> {
    array_field(data, "roles")
        .map(|entries| entries.iter().filter_map(parse_role).collect())
        .unwrap_or_default()
}

/// One role row, projected field for field.
///
/// A row without an id is dropped: the panel addresses a role by its id, so there is nothing it
/// could do with such a row.
fn parse_role(entry: &Value) -> Option<ModelRoleRow> {
    let id = entry.get("id").and_then(Value::as_str)?.to_owned();
    // A role the host did not name keeps its id as its name rather than rendering as an empty row.
    let name = text_or(entry, "name", &id);
    Some(ModelRoleRow {
        id,
        name,
        tag: optional_text(entry, "tag"),
        section: entry
            .get("section")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        configured: entry
            .get("configured")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        value: optional_text(entry, "value"),
        source: entry
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        model: entry.get("model").and_then(parse_role_model),
        thinking_level: optional_text(entry, "thinkingLevel"),
        auto_selected: entry
            .get("autoSelected")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// The model a role resolves to, `None` for the `null` a role with no resolvable model sends.
fn parse_role_model(value: &Value) -> Option<ModelRoleModel> {
    let id = value.get("id").and_then(Value::as_str)?;
    Some(ModelRoleModel {
        provider: value
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        name: text_or(value, "name", id),
        id: id.to_owned(),
    })
}

/// One of the list-valued fields of a payload, `None` when the host sent none.
fn array_field<'a>(data: &'a Value, key: &str) -> Option<&'a [Value]> {
    data.get(key).and_then(Value::as_array).map(Vec::as_slice)
}

/// One of the list-valued fields, filtered down to the non-empty strings it holds.
///
/// Everything that is not a non-empty string is dropped, and an absent field or a field of another
/// type reads as the empty list. That default is the point of the field being a list rather than an
/// optional one: "the model offers no level" and "the host did not say" both leave the consumer
/// with nothing to offer, and a list that is sometimes `null` and sometimes missing would make the
/// frontend guess at a difference that has no meaning here.
fn string_array(entry: &Value, key: &str) -> Vec<String> {
    array_field(entry, key)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// A field that is genuinely absent when the host has nothing to say (an unset tag, an
/// unconfigured role): `null`, a missing key and an empty string all mean the same thing.
fn optional_text(entry: &Value, key: &str) -> Option<String> {
    entry
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// A label field, falling back to what it labels: an unnamed model is still addressable by its id,
/// and a role keeps its id as its name rather than rendering as an empty row.
fn text_or(entry: &Value, key: &str, fallback: &str) -> String {
    let text = optional_text(entry, key);
    text.unwrap_or_else(|| fallback.to_owned())
}

#[cfg(test)]
mod e2e;

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_session(id: &str) -> Arc<SessionRuntime> {
        Arc::new(SessionRuntime::new(
            id.to_owned(),
            "D:/ws".to_owned(),
            Some(1),
            None,
        ))
    }

    /// A state frame is stamped with the `seq` of the host frame it came from, and a frontend that
    /// reads only the fields it knew before sees the same object.
    #[test]
    fn emitted_frames_carry_the_frame_sequence() {
        let session = fake_session("s00000000000000ff");
        session.note_frame_seq(7);
        assert_eq!(session.last_frame_seq(), 7);
        // The injection itself is exercised through `emit`, which needs a Tauri handle; what
        // matters here is that the sequence belongs to the session and not to the process.
        let other = fake_session("s00000000000000fe");
        assert_eq!(other.last_frame_seq(), 0);
    }

    /// The queue's byte budget is what makes the inbound ceiling a memory ceiling: frames may be
    /// charged up to the limit, and the frame that would cross it waits until something is
    /// released.
    #[test]
    fn the_inbound_budget_stops_at_its_byte_ceiling() {
        let budget = Arc::new(InboundBudget::new());
        assert!(budget.charge(MAX_PENDING_BYTES));

        let waiting = Arc::clone(&budget);
        let waiter = std::thread::spawn(move || waiting.charge(1));
        assert!(!waiter.is_finished(), "the budget is full, so it waits");

        budget.release(MAX_PENDING_BYTES);
        assert!(waiter.join().expect("the waiting charge thread"));
        budget.release(1);
    }

    /// A frame larger than the whole budget has to be able to pass, or the host would be stuck
    /// behind one it is entitled to send: it is let through while the queue is empty, and never
    /// while anything else is queued.
    #[test]
    fn a_frame_larger_than_the_budget_passes_only_alone() {
        let budget = Arc::new(InboundBudget::new());
        assert!(budget.charge(1));

        let waiting = Arc::clone(&budget);
        let oversized = std::thread::spawn(move || waiting.charge(MAX_PENDING_BYTES * 2));
        assert!(!oversized.is_finished(), "a queued frame is ahead of it");

        budget.release(1);
        assert!(oversized.join().expect("the oversized charge thread"));
        budget.release(MAX_PENDING_BYTES * 2);
    }

    /// Closing the budget ends a wait that nothing else would end: the dispatcher stopping is not a
    /// release, and a reader waiting for one would be a thread left running for the life of the
    /// process.
    #[test]
    fn closing_the_budget_ends_a_wait() {
        let budget = Arc::new(InboundBudget::new());
        assert!(budget.charge(MAX_PENDING_BYTES));

        let waiting = Arc::clone(&budget);
        let waiter = std::thread::spawn(move || waiting.charge(1));
        assert!(!waiter.is_finished(), "nothing has been released");

        budget.close();
        assert!(
            !waiter.join().expect("the waiting charge thread"),
            "the charge reports that the dispatcher is gone"
        );
        assert!(!budget.charge(0), "and the budget stays closed");
    }

    /// The frame loop reads the registry once per inbound frame, so that read must not rebuild the
    /// list: the same snapshot comes back until a conversation is registered or removed, and the
    /// next one describes the registry that exists.
    #[test]
    fn the_session_snapshot_is_reused_until_the_registry_changes() {
        let mut registry = SessionRegistry::new();
        registry.insert(fake_session("s00000000000000ff"));
        let first = registry.all();
        assert_eq!(first.len(), 1);
        assert!(Arc::ptr_eq(&first, &registry.all()), "the snapshot is kept");

        registry.insert(fake_session("s00000000000000fe"));
        let grown = registry.all();
        assert!(!Arc::ptr_eq(&first, &grown), "a registration rebuilds it");
        assert_eq!(grown.len(), 2);

        registry.remove("s00000000000000ff");
        let shrunk = registry.all();
        assert_eq!(shrunk.len(), 1);
        assert_eq!(shrunk[0].id, "s00000000000000fe");

        assert_eq!(registry.len(), 1);
        assert!(registry.get("s00000000000000ff").is_none());
        assert!(registry.get("s00000000000000fe").is_some());

        let drained = registry.drain();
        assert_eq!(drained.len(), 1);
        assert_eq!(registry.len(), 0);
        assert!(
            registry.all().is_empty(),
            "and the emptied registry reads empty"
        );
    }

    /// The role table, exactly as the host builds it: a configured role with a selector that
    /// carries a level, an unconfigured role the engine resolved by itself, and one whose stored
    /// selector names a model this catalogue does not have.
    fn role_table_payload() -> Value {
        json!({
            "roles": [
                {
                    "id": "default",
                    "tag": "DEFAULT",
                    "name": "Default",
                    "section": "chat",
                    "configured": true,
                    "value": "anthropic/claude-sonnet-4-5:high",
                    "source": "global",
                    "model": {
                        "provider": "anthropic",
                        "id": "claude-sonnet-4-5",
                        "name": "Claude Sonnet 4.5",
                    },
                    "thinkingLevel": "high",
                    "autoSelected": false,
                },
                {
                    "id": "smol",
                    "tag": null,
                    "name": "Smol",
                    "section": "chat",
                    "configured": false,
                    "value": null,
                    "source": "default",
                    "model": {
                        "provider": "anthropic",
                        "id": "claude-haiku-4-5",
                        "name": "Claude Haiku 4.5",
                    },
                    "thinkingLevel": null,
                    "autoSelected": true,
                },
                {
                    "id": "memory",
                    "name": "Memory",
                    "section": "kind",
                    "configured": true,
                    "value": "gone/nothing",
                    "source": "project",
                    "model": null,
                    "autoSelected": false,
                },
            ],
        })
    }

    /// Every field of a role row is carried through, including the two that are easy to lose: a
    /// role with no resolvable model keeps its stored selector and stays renderable, and a role
    /// the engine picked for itself stays flagged as automatic.
    #[test]
    fn role_rows_keep_their_selector_and_their_resolved_model() {
        let roles = parse_roles(&role_table_payload());
        assert_eq!(roles.len(), 3);

        let configured = &roles[0];
        assert_eq!(configured.id, "default");
        assert_eq!(configured.tag.as_deref(), Some("DEFAULT"));
        assert_eq!(configured.name, "Default");
        assert_eq!(configured.section, "chat");
        assert!(configured.configured);
        assert_eq!(
            configured.value.as_deref(),
            Some("anthropic/claude-sonnet-4-5:high")
        );
        assert_eq!(configured.source, "global");
        assert_eq!(configured.thinking_level.as_deref(), Some("high"));
        assert!(!configured.auto_selected);
        let model = configured.model.as_ref().expect("a resolved model");
        assert_eq!(model.provider, "anthropic");
        assert_eq!(model.id, "claude-sonnet-4-5");
        assert_eq!(model.name, "Claude Sonnet 4.5");

        let automatic = &roles[1];
        assert_eq!(automatic.id, "smol");
        assert_eq!(automatic.thinking_level, None);
        assert!(automatic.auto_selected);
        assert!(automatic.value.is_none());

        // A selector the catalogue no longer resolves is reported as such, not as an empty model.
        let unresolved = &roles[2];
        assert_eq!(unresolved.id, "memory");
        assert_eq!(unresolved.value.as_deref(), Some("gone/nothing"));
        assert!(unresolved.model.is_none());
        assert!(unresolved.tag.is_none());
        assert_eq!(unresolved.source, "project");
    }

    /// A row that names no role is dropped rather than rendered as an empty entry, and a missing
    /// payload is an empty table instead of an error: the panel has a table to render either way.
    #[test]
    fn unusable_role_rows_are_dropped() {
        let roles = parse_roles(&json!({"roles": [{"name": "No id"}, {"id": "vision"}]}));
        assert_eq!(roles.len(), 1);
        assert_eq!(roles[0].id, "vision");
        // A role the host did not name is still addressable by its id.
        assert_eq!(roles[0].name, "vision");

        assert!(parse_roles(&json!({})).is_empty());
    }

    /// Candidate rows are the catalogue's own shape, and a shortened pool is reported as such:
    /// the panel must be able to tell "these are all of them" from "this is a prefix".
    #[test]
    fn candidate_rows_reuse_the_catalogue_shape_and_report_truncation() {
        let (models, truncated) = parse_role_candidates(&json!({
            "role": "smol",
            "models": [
                {
                    "provider": "anthropic",
                    "id": "claude-haiku-4-5",
                    "name": "Claude Haiku 4.5",
                    "contextWindow": 200000,
                    "maxTokens": 64000,
                    "input": ["text", "image"],
                    "reasoning": true,
                    "thinkingLevels": ["off", "", "low", "medium"],
                },
                {
                    "provider": "openai",
                    "id": "gpt-5-mini",
                    "contextWindow": 400000,
                    "maxTokens": 128000,
                    "input": ["text"],
                    "reasoning": false,
                },
            ],
            "truncated": true,
        }));
        assert!(truncated);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "claude-haiku-4-5");
        assert_eq!(models[0].context_window, 200_000);
        assert!(models[0].supports_images);
        assert!(models[0].reasoning);
        // The levels the model offers, with the blank entry the host could send dropped rather
        // than handed to the picker as an option with no label.
        assert_eq!(models[0].thinking_levels, vec!["off", "low", "medium"]);
        // The engine's rows always carry a name; the parser still tolerates a nameless row rather
        // than rendering an empty label, so the id stands in for it.
        assert_eq!(models[1].name, "gpt-5-mini");
        assert!(!models[1].supports_images);
        // A row that says nothing about levels - a model with no controllable effort surface, or
        // an older host - reads as an empty list rather than leaving the field to be guessed at.
        assert!(models[1].thinking_levels.is_empty());

        let (complete, truncated) = parse_role_candidates(&json!({"role": "smol", "models": []}));
        assert!(complete.is_empty());
        assert!(!truncated);
    }

    /// The session state's own list, which spells the levels of the current model with the
    /// automatic one in front, and the model rows' list are read by the same rule: what the host
    /// does not send is an empty list, because "offers nothing" and "not reported" leave the picker
    /// with exactly one option either way.
    #[test]
    fn session_thinking_levels_are_projected_and_default_to_empty() {
        let state = json!({
            "model": {"provider": "anthropic", "id": "claude-sonnet-4-5"},
            "thinkingLevel": "medium",
            "thinkingLevels": ["auto", "off", "low", "medium"],
        });
        let projected = session::project_state(&fake_session("s00000000000000ff"), &state);
        assert_eq!(projected.thinking_level.as_deref(), Some("medium"));
        assert_eq!(
            projected.thinking_levels,
            vec!["auto", "off", "low", "medium"]
        );

        // A state that never mentions the list is not an error and not a missing field: it is a
        // model nothing can be pinned on.
        let bare = session::project_state(&fake_session("s00000000000000fe"), &json!({}));
        assert!(bare.thinking_levels.is_empty());
    }
}

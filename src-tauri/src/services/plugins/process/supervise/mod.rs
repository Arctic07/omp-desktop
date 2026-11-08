//! The supervisor: one child process per installation, its handshake, its budgets, and its end.
//!
//! Everything here is about the *process*, never about what the plugin means: a worker is spawned
//! from an [`ProcessInstall`] snapshot, driven with the three calls the protocol has
//! (`worker_load`, `worker_call`, `worker_unload`), and answered on the one channel it may ask
//! through (`worker_invoke` -> `api.rs`). The rules that decide *whether* an installation may run
//! are one function away (`super::availability`), and the wire format is `frames.rs`.
//!
//! Five invariants shape the code:
//!
//! - **One child per installation, at most [`MAX_LIVE_PROCESSES`] live.** The key is
//!   `(install, scope)` - the engine handle plus the registry the installation lives in. Starting
//!   the seventeenth live installation stops the least-recently-used one first, and a stop is always
//!   `worker_unload` (5 s) and then a kill, never a kill alone (`rules.md#resource-bounds-and-release-points`).
//! - **A crash is a state, not an action.** An unexpected exit backs off 1 s, 2, 4, 8 and 16 s, and a
//!   process that crashes past that stays `crashed` until the reader restarts it by hand. A process
//!   that stayed alive for [`SURVIVAL_RESET`] earns the budget back, and a manifest may turn the
//!   restarts off entirely (`omp.desktop.autoRestart`). Nothing here disables a plugin, and nothing
//!   retries past the limit (plan §6.4).
//! - **A call is bounded.** `worker_load` 15 s, `worker_unload` 5 s, one `worker_call` 30 s. A call
//!   that runs past its budget is the plugin not answering: the process is stopped and stays
//!   `crashed` with the timeout token, rather than holding a request for as long as the plugin likes.
//! - **The handshake is checked.** The protocol number in `worker_hello` must equal
//!   [`WORKER_PROTOCOL`]; anything else stops the worker with `plugin.process.protocol_mismatch`.
//! - **Every container has a ceiling and a release point.** Pending calls (64), unanswered invokes
//!   (64), invokes per second (200), registered commands (32), the unknown-frame log (8 types), the
//!   table itself (one row per installation the plugin list reports). Each is stated where it is
//!   declared in `super` and released where its entry is settled, stopped or dropped.
//!
//! The supervisor is a process-level singleton in `AppState` (`services::state`): the table outlives
//! every page and every workspace switch, and the application's own exit path is what ends it
//! (`services::lib`'s `RunEvent::Exit`).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io::Read;
#[cfg(test)]
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::Emitter;

use crate::errors::{
    IpcError, IpcResult, INVALID_INPUT, PLUGIN_PROCESS_CRASHED, PLUGIN_PROCESS_PROTOCOL_MISMATCH,
    PLUGIN_PROCESS_UNAVAILABLE,
};
use crate::models::plugins::{PluginProcessRow, PluginProcessesView};
use crate::services::log;
use crate::services::plugins::audit;
use crate::services::plugins::prompt::PluginPrompts;
use crate::services::plugins::renderer;

use super::frames::{self, Inbound, Line, LineFramer};
mod capabilities;
use super::{
    backoff_delay, lock, ProcessInstall, ProcessState, Settlement, ACTIVATION_COMMAND_PREFIX,
    ACTIVATION_STARTUP, CALL_TIMEOUT, LOAD_TIMEOUT, MAX_LIVE_PROCESSES, MAX_PENDING_CALLS,
    PROTOCOL_MISMATCH_LOG, REASON_CRASHED, REASON_PROTOCOL_MISMATCH, REASON_TIMEOUT,
    SURVIVAL_RESET, UNLOAD_TIMEOUT, WORKER_PROTOCOL,
};

/// The event the whole table is pushed on (the frontend subscribes to it, `api/types.ts`).
pub(crate) const PROCESS_EVENT: &str = "plugin-process";

/// How long a stop waits for the worker's own exit after it has answered `worker_unload`.
///
/// The worker exits by itself once the answer is written (`host/src/plugin-worker/runtime.ts`), so
/// this is the grace between "it said goodbye" and "we make sure". A worker that does not leave is
/// killed - the answer is not a promise to exit.
const EXIT_GRACE: Duration = Duration::from_secs(1);

/// How long the reader's exit handler waits to observe the child's exit code before giving up.
const EXIT_CODE_WAIT: Duration = Duration::from_millis(500);

/// How much one read pulls from a pipe. Small enough that a line is assembled quickly, large enough
/// that a burst of frames costs few syscalls.
const READ_CHUNK: usize = 16 * 1024;

/// How many distinct unknown frame types one worker may have reported before the log stays quiet.
///
/// Owner: one worker process. Limit: this many distinct tokens. Release: the process ending. A
/// worker that narrates thousands of unknown frames is one line in this application's log per type,
/// never one per frame (`rules.md#resource-bounds-and-release-points`).
const UNKNOWN_FRAMES_LOGGED: usize = 8;

/// The installations the environment keeps when a worker is launched: the platform's own, and
/// nothing else.
///
/// This is the same list `host/src/plugin-worker/environment.ts` keeps on its side, and it is
/// repeated on purpose: the child's environment is *built* here (`env_clear` first), so the list is
/// a launch decision rather than a filter the far side happens to apply. `HOME` / `USERPROFILE` are
/// deliberately absent - nothing in a worker writes to a home directory, and leaving them out is
/// what makes that true for plugin code that would reach for `~` by accident.
const KEPT_ENVIRONMENT: [&str; 11] = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "windir",
    "ComSpec",
    "TEMP",
    "TMP",
    "TZ",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
];

/// The key one child is filed under: the engine handle and the registry it lives in.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Key {
    install: String,
    scope: String,
    /// The plugin's own id, carried for the audit line and the log: the handle a child is filed
    /// under is the engine's, while every event about a plugin names the plugin's own identity
    /// (plan D0).
    plugin_id: String,
}

impl Key {
    fn of(install: &ProcessInstall) -> Self {
        Self {
            install: install.install.clone(),
            scope: install.scope.clone(),
            plugin_id: install.plugin_id.clone(),
        }
    }
}

/// One child and everything needed to talk to it, taken out of the entry when it is stopped or has
/// died.
struct Worker {
    /// Matches the reader thread that serves this child; a stale reader's exit is ignored.
    generation: u64,
    link: Arc<dyn WorkerLink>,
    pending: Arc<Pending>,
}

impl Worker {
    fn next_id(&self, prefix: &str) -> String {
        format!(
            "{prefix}{}",
            self.pending.next_id.fetch_add(1, Ordering::SeqCst)
        )
    }
}

/// One installation's row in the supervisor's table.
struct Entry {
    install: ProcessInstall,
    state: ProcessState,
    /// How many automatic restarts this process has had since its last manual start.
    restarts: u32,
    pid: Option<u32>,
    reason: Option<String>,
    last_exit_at: Option<String>,
    last_used: Instant,
    worker: Option<Worker>,
    /// Serializes starts for this installation, so two callers wake one child rather than two.
    start: Arc<Mutex<()>>,
    /// Bumped by every transition that must make a scheduled restart stale (stop, upgrade, exit).
    epoch: u64,
    /// The activation event the load carries; replaced by each call that wakes the process.
    activation: String,
    /// Whether this published package has already had its `onStartup` attempt.
    ///
    /// `onStartup` fires once per package the list publishes, not once per list read: a process the
    /// live ceiling recycled is woken lazily by the call that needs it, and re-firing every settings
    /// read would recycle one live process per read instead. Reset when `sync` sees a new revision
    /// (an upgrade is a new package, and its own `onStartup` may differ).
    startup_fired: bool,
    /// The ids registered at run time (`command.register`), bounded by
    /// [`super::MAX_REGISTERED_COMMANDS`]; released on unregister, and whenever the child that owns
    /// them goes away (a stop, a recycle, a crash, an upgrade) — see [`Entry::take_worker`].
    commands: Arc<Mutex<BTreeSet<String>>>,
    /// Whether the process must not be retried (a timeout, a protocol mismatch, a spent budget).
    terminal: bool,
    /// When this process last became live, for the crash budget's own reset ([`SURVIVAL_RESET`]).
    ///
    /// `None` when nothing is running: a live row is the only one whose survival can forgive a past
    /// crash, and a process that never reached `running` never earned one.
    live_since: Option<Instant>,
    /// The last exit code, kept for the supervisor's own tests (the DTO has no field for it).
    #[cfg(test)]
    last_exit_code: Option<i32>,
}

impl Entry {
    /// Takes the child out of the entry, which ends the run-time registry it owned.
    ///
    /// The registry is the *process's*, not the installation's (`api::register_command`): a child
    /// that starts after a stop, a timeout or a crash runs `onLoad` again and registers the same
    /// ids. Keeping the previous child's ids refuses every one of them with "already registered by
    /// this process", which turns the restart - crash recovery included - into a startup failure
    /// whose author-visible symptom is a plugin that can never come back.
    fn take_worker(&mut self) -> Option<Worker> {
        lock(&self.commands).clear();
        self.worker.take()
    }

    fn new(install: ProcessInstall) -> Self {
        Self {
            install,
            state: ProcessState::Stopped,
            restarts: 0,
            pid: None,
            reason: None,
            last_exit_at: None,
            last_used: Instant::now(),
            worker: None,
            start: Arc::new(Mutex::new(())),
            epoch: 0,
            activation: ACTIVATION_STARTUP.to_owned(),
            startup_fired: false,
            commands: Arc::new(Mutex::new(BTreeSet::new())),
            terminal: false,
            live_since: None,
            #[cfg(test)]
            last_exit_code: None,
        }
    }
}

/// The one channel a worker's frames are settled through.
///
/// Owner: one child process. Bound / release: `hello` is one slot consumed by the start; `calls` has
/// at most [`MAX_PENDING_CALLS`] entries, each released by its answer, its timeout or the process
/// ending; `budget` is the invoke table; `unknown` is the bounded log dedupe.
struct Pending {
    /// The start's hello slot: `Some(hello)` when the worker introduced itself, `None` when it died
    /// first (so the start fails at once instead of waiting out the budget).
    hello: Mutex<Option<SyncSender<Option<Hello>>>>,
    calls: Mutex<BTreeMap<String, SyncSender<Settlement>>>,
    fatal: Mutex<Option<(String, String)>>,
    budget: Mutex<InvokeBudget>,
    unknown: Mutex<BTreeSet<String>>,
    next_id: AtomicU64,
}

impl Pending {
    fn new() -> Self {
        Self {
            hello: Mutex::new(None),
            calls: Mutex::new(BTreeMap::new()),
            fatal: Mutex::new(None),
            budget: Mutex::new(InvokeBudget::default()),
            unknown: Mutex::new(BTreeSet::new()),
            next_id: AtomicU64::new(0),
        }
    }

    fn fatal(&self) -> Option<(String, String)> {
        lock(&self.fatal).clone()
    }

    /// Whether an unknown frame type is new enough to be logged (bounded by
    /// [`UNKNOWN_FRAMES_LOGGED`]).
    fn first_unknown(&self, reason: &str) -> bool {
        let mut seen = lock(&self.unknown);
        if seen.contains(reason) {
            return false;
        }
        if seen.len() >= UNKNOWN_FRAMES_LOGGED {
            return false;
        }
        seen.insert(reason.to_owned());
        true
    }
}

/// The hello the start waits for.
#[derive(Debug, Clone)]
struct Hello {
    protocol: u32,
    entry: String,
}

/// One settlement the reader hands back.
type SettlementSender = SyncSender<Settlement>;

/// The two budgets a worker's invokes pass: unanswered calls and calls per rolling second.
///
/// Owner: one child. Limit: [`super::MAX_PENDING_INVOKES`] unanswered and
/// [`super::MAX_INVOKES_PER_SECOND`] per [`super::INVOKE_WINDOW`]. Release: every answered invoke
/// gives its slot back, and the window forgets timestamps as it advances.
#[derive(Default)]
struct InvokeBudget {
    pending: usize,
    accepted: VecDeque<Instant>,
}

impl InvokeBudget {
    /// Takes one invoke, or answers why it cannot be carried.
    fn take(&mut self, now: Instant) -> Result<(), &'static str> {
        if self.pending >= super::MAX_PENDING_INVOKES {
            return Err("too_many_requests");
        }
        while self
            .accepted
            .front()
            .is_some_and(|accepted| now.duration_since(*accepted) >= super::INVOKE_WINDOW)
        {
            self.accepted.pop_front();
        }
        if self.accepted.len() >= super::MAX_INVOKES_PER_SECOND {
            return Err("too_many_requests");
        }
        self.accepted.push_back(now);
        self.pending += 1;
        Ok(())
    }

    fn release(&mut self) {
        self.pending = self.pending.saturating_sub(1);
    }
}

/// One child's stdin and handle, as the protocol writes and ends it.
pub(super) trait WorkerLink: Send + Sync {
    /// Writes one encoded line; `false` means the pipe is gone (the reader will report the exit).
    fn send(&self, line: &str) -> bool;
    /// Ends the child, whatever it is doing.
    fn kill(&self);
    /// The exit code, when the child has already exited.
    fn try_wait(&self) -> Option<i32>;
}

/// The launch a supervisor uses: the shipped host artifact in production, a test's script otherwise.
#[derive(Debug, Clone)]
pub(super) enum Launch {
    /// `omp-host.exe --plugin-worker …`, located and verified through `services::host_bin`.
    Host,
    /// A test's own launcher: the host tree run through its runtime (`bun host/src/main.ts …`).
    #[cfg(test)]
    Script { program: PathBuf, script: PathBuf },
}

/// What a spawn produced: the child's pipes and the link that writes to them.
pub(super) struct Spawned {
    pub(super) link: Arc<dyn WorkerLink>,
    pub(super) stdout: Box<dyn Read + Send>,
    pub(super) stderr: Option<Box<dyn Read + Send>>,
    pub(super) pid: Option<u32>,
}

/// How a child is produced. One implementation launches the real worker; the supervisor's own tests
/// add an in-process one, which is what makes the caps, the backoff and the stop order testable
/// without seventeen processes.
pub(super) trait Spawner: Send + Sync {
    fn spawn(&self, install: &ProcessInstall) -> IpcResult<Spawned>;
}

/// The production spawner: the verified host artifact, launched in worker mode.
pub(super) struct HostSpawner {
    pub(super) launch: Launch,
}

impl Spawner for HostSpawner {
    fn spawn(&self, install: &ProcessInstall) -> IpcResult<Spawned> {
        let (program, mut args) = match &self.launch {
            Launch::Host => {
                let artifact = crate::services::host_bin::locate().map_err(|error| {
                    // The artifact is absent, unreadable or does not match its manifest: no worker
                    // can be started from it, and that is the installation being unavailable rather
                    // than the plugin having crashed.
                    IpcError::from_message(PLUGIN_PROCESS_UNAVAILABLE, error.message)
                })?;
                (artifact.program, artifact.args)
            }
            #[cfg(test)]
            Launch::Script { program, script } => (
                program.clone(),
                vec![std::ffi::OsString::from(
                    script.to_string_lossy().into_owned(),
                )],
            ),
        };
        // `OsString` throughout: a bundle's invocation carries a filesystem path, and a path is not
        // required to survive a trip through `String`.
        args.push(std::ffi::OsString::from("--plugin-worker"));
        args.push(std::ffi::OsString::from("--root"));
        args.push(install.root.clone().into_os_string());
        args.push(std::ffi::OsString::from("--install"));
        args.push(install.install.clone().into());
        args.push(std::ffi::OsString::from("--id"));
        args.push(install.plugin_id.clone().into());
        args.push(std::ffi::OsString::from("--scope"));
        args.push(install.scope.clone().into());

        let mut command = Command::new(&program);
        command.args(&args);
        // The child's whole world is its own package: `cwd` is the root it was launched with, which
        // is what makes a relative path in plugin code mean the file beside it.
        command.current_dir(&install.root);
        command.env_clear();
        for name in KEPT_ENVIRONMENT {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::services::runtime::host::process::hide_console(&mut command);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own process group, so the kill path can take the whole tree down (a plugin's own
            // children included).
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|_| {
            IpcError::new(
                PLUGIN_PROCESS_UNAVAILABLE,
                "The plugin process could not be started.",
            )
        })?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or_else(pid_lost)?;
        let stdout = child.stdout.take().ok_or_else(pid_lost)?;
        let stderr = child.stderr.take();
        Ok(Spawned {
            link: Arc::new(ChildLink {
                stdin: Mutex::new(stdin),
                child: Mutex::new(child),
            }),
            stdout: Box::new(stdout),
            stderr: stderr.map(|stream| Box::new(stream) as Box<dyn Read + Send>),
            pid: Some(pid),
        })
    }
}

fn pid_lost() -> IpcError {
    IpcError::new(
        PLUGIN_PROCESS_UNAVAILABLE,
        "The plugin process could not be given its pipes.",
    )
}

/// The real child, as the protocol writes to it.
struct ChildLink {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
}

impl WorkerLink for ChildLink {
    fn send(&self, line: &str) -> bool {
        use std::io::Write;
        let mut stdin = lock(&self.stdin);
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush())
            .is_ok()
    }

    fn kill(&self) {
        let mut child = lock(&self.child);
        let _ = child.kill();
    }

    fn try_wait(&self) -> Option<i32> {
        let mut child = lock(&self.child);
        match child.try_wait() {
            Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
            _ => None,
        }
    }
}

/// The supervisor's table and the operations over it.
pub(crate) struct PluginProcess {
    /// `None` in the supervisor's own tests: a call that needs the application is refused as
    /// `internal` there, and every gate that is a pure judgement still runs.
    app: Option<tauri::AppHandle>,
    spawner: Arc<dyn Spawner>,
    timeouts: Timeouts,
    /// The questions this application has open, read for one purpose: a call parked on the user's
    /// answer must not spend its own deadline (`call_blocking`). `None` in the supervisor's own
    /// tests, where no question can be asked anyway.
    prompts: Option<Arc<PluginPrompts>>,
    inner: Mutex<Inner>,
}

/// The three budgets a call runs against, injectable so a test can prove the timeout path without
/// waiting half a minute.
#[derive(Debug, Clone, Copy)]
pub(super) struct Timeouts {
    pub(super) load: Duration,
    pub(super) unload: Duration,
    pub(super) call: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            load: LOAD_TIMEOUT,
            unload: UNLOAD_TIMEOUT,
            call: CALL_TIMEOUT,
        }
    }
}

#[derive(Default)]
struct Inner {
    entries: BTreeMap<Key, Entry>,
    /// Set by [`PluginProcess::shutdown_all`]: no start is scheduled or honoured after it.
    shutdown: bool,
}

impl PluginProcess {
    /// The application's one supervisor.
    pub(crate) fn new(app: tauri::AppHandle, prompts: Arc<PluginPrompts>) -> Arc<Self> {
        Arc::new(Self {
            app: Some(app),
            spawner: Arc::new(HostSpawner {
                launch: Launch::Host,
            }),
            timeouts: Timeouts::default(),
            prompts: Some(prompts),
            inner: Mutex::new(Inner::default()),
        })
    }

    /// A supervisor with no application and a chosen launcher, for the tests in `tests.rs`.
    #[cfg(test)]
    pub(super) fn detached(spawner: Arc<dyn Spawner>, timeouts: Timeouts) -> Arc<Self> {
        Arc::new(Self {
            app: None,
            spawner,
            timeouts,
            prompts: None,
            inner: Mutex::new(Inner::default()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        lock(&self.inner)
    }

    // ---- the table ----

    /// Replaces the table's rows with the installations one plugin list reports, and stops what the
    /// new list no longer runs.
    ///
    /// Called from the one path every plugin list read passes through
    /// (`commands::plugin_pages::publish_pages`), which is where a disable, an uninstall and an
    /// upgrade become visible: an installation that is gone loses its row, one whose package changed
    /// (a new revision) is stopped and keeps its row at `stopped`, and one the engine no longer runs
    /// is stopped for the same reason. The stops themselves wait on a worker's unload, so they run
    /// off the caller's thread; the table is already consistent when this returns.
    pub(crate) fn sync(self: &Arc<Self>, installs: Vec<ProcessInstall>) {
        let mut stop: Vec<(Worker, Key)> = Vec::new();
        let mut changed = false;
        {
            let mut inner = self.lock();
            if inner.shutdown {
                return;
            }
            let wanted: BTreeMap<Key, ProcessInstall> = installs
                .into_iter()
                .map(|install| (Key::of(&install), install))
                .collect();
            let gone: Vec<Key> = inner
                .entries
                .keys()
                .filter(|key| !wanted.contains_key(*key))
                .cloned()
                .collect();
            for key in gone {
                if let Some(mut entry) = inner.entries.remove(&key) {
                    entry.epoch += 1;
                    if let Some(worker) = entry.take_worker() {
                        stop.push((worker, key));
                    }
                    changed = true;
                }
            }
            for (key, install) in wanted {
                match inner.entries.get_mut(&key) {
                    Some(entry) => {
                        let replaced = entry.install.revision != install.revision;
                        // A disabled plugin that is switched on again asks for its `onStartup`
                        // start once more: the previous attempt belonged to a package the user was
                        // not running, and the toggle is the user's own request to run it now. The
                        // reverse direction needs no reset (a disabled installation is not a
                        // candidate), but resetting both keeps one rule for one toggle.
                        let toggled = entry.install.enabled != install.enabled;
                        let disabled = !install.enabled;
                        entry.install = install;
                        if toggled {
                            entry.startup_fired = false;
                        }
                        if replaced {
                            // An upgrade is a different package: the answers the previous one gave
                            // (its registered commands, its crash budget) do not carry over, and the
                            // process that ran it must stop before the new one starts.
                            entry.epoch += 1;
                            entry.restarts = 0;
                            entry.terminal = false;
                            entry.reason = None;
                            // A new package has its own `onStartup` declaration: the previous one's
                            // attempt does not carry over, so this list's read may fire it again.
                            entry.startup_fired = false;
                            if let Some(worker) = entry.take_worker() {
                                stop.push((worker, key));
                            }
                            entry.state = ProcessState::Stopped;
                            changed = true;
                        } else if disabled && entry.state.is_live() {
                            entry.epoch += 1;
                            if let Some(worker) = entry.take_worker() {
                                stop.push((worker, key));
                            }
                            entry.state = ProcessState::Stopped;
                            entry.reason = None;
                            changed = true;
                        }
                    }
                    None => {
                        inner.entries.insert(key, Entry::new(install));
                        changed = true;
                    }
                }
            }
        }
        if !stop.is_empty() {
            self.stop_in_background(stop);
        }
        if changed {
            self.emit();
        }
    }

    /// Wakes every installation whose manifest declares `onStartup`, off the caller's thread.
    ///
    /// Called right after [`sync`](Self::sync) has recorded a plugin list: the list is the only
    /// moment this side learns that an installation exists, and `onStartup` is the event that says
    /// "be up as soon as the application is". The starts run on a thread of their own because each
    /// one waits on a worker's handshake (up to [`LOAD_TIMEOUT`]) and a settings read must neither
    /// wait for sixteen children to say hello nor fail because one of them did not.
    ///
    /// Three facts select an installation: a descriptor exists (which already means a `main` and a
    /// process this installation may run - `install_of` decides both), the engine runs it
    /// (`enabled`), and the manifest lists the event (`wants_startup`). A row already `starting` or
    /// `running` is what the event asked for and is left alone; a `crashed` row is the crash
    /// budget's answer, and only a manual restart may overrule it. Each package is attempted once
    /// (`startup_fired`): a process the live ceiling recycled is woken lazily by the call that needs
    /// it rather than by the next list read, which would otherwise recycle one process per read.
    pub(crate) fn start_on_startup(self: &Arc<Self>) {
        let keys: Vec<Key> = {
            let mut inner = self.lock();
            if inner.shutdown {
                return;
            }
            let mut keys = Vec::new();
            for (key, entry) in inner.entries.iter_mut() {
                if !entry.install.wants_startup() || entry.startup_fired {
                    continue;
                }
                entry.startup_fired = true;
                if entry.state == ProcessState::Stopped {
                    keys.push(key.clone());
                }
            }
            keys
        };
        if keys.is_empty() {
            return;
        }
        let process = Arc::clone(self);
        std::thread::spawn(move || {
            for key in keys {
                // The list can change between the scan and this start: a row that is gone, disabled
                // or no longer declaring the event must not be woken by a decision about an older
                // list, and a row another caller already started is left to that caller.
                let wanted = {
                    let inner = process.lock();
                    inner.entries.get(&key).is_some_and(|entry| {
                        entry.install.wants_startup()
                            && entry.state == ProcessState::Stopped
                            && entry.startup_fired
                    })
                };
                if !wanted {
                    continue;
                }
                if let Err(error) = process.start(&key) {
                    log::info(&format!(
                        "an onStartup plugin process could not be started: plugin={} code={}",
                        key.plugin_id, error.code
                    ));
                }
            }
        });
    }

    /// The whole table, in a stable order (by plugin id, then scope).
    pub(crate) fn snapshot(&self) -> PluginProcessesView {
        let inner = self.lock();
        let mut processes: Vec<PluginProcessRow> = inner
            .entries
            .values()
            .map(|entry| PluginProcessRow {
                plugin_id: entry.install.plugin_id.clone(),
                scope: entry.install.scope.clone(),
                state: entry.state.token(),
                restarts: entry.restarts,
                pid: entry.pid,
                reason: entry.reason.clone(),
                last_exit_at: entry.last_exit_at.clone(),
            })
            .collect();
        processes.sort_by(|left, right| {
            left.plugin_id
                .cmp(&right.plugin_id)
                .then_with(|| left.scope.cmp(&right.scope))
        });
        PluginProcessesView { processes }
    }

    /// Pushes the whole table to the window (`plugin-process`).
    fn emit(&self) {
        let Some(app) = self.app.as_ref() else {
            return;
        };
        if let Err(error) = app.emit(PROCESS_EVENT, self.snapshot()) {
            log::warn(&format!(
                "the plugin process table could not be delivered: {error}"
            ));
        }
    }
}

mod calls;
mod lifecycle;
mod reader;

/// The call wait's helpers, reachable from the supervision tests (`process/tests/wait.rs`): the
/// budget rule is proved against a channel rather than a child process.
#[cfg(test)]
pub(crate) use calls::{await_settlement, CallWait};

/// A refusal for "this plugin has no process this side can call".
fn unavailable() -> IpcError {
    IpcError::new(
        PLUGIN_PROCESS_UNAVAILABLE,
        "This plugin has no resident process to call.",
    )
}

/// One audit line, with the plugin's own identity and the scope it lives at.
fn audit_process(key: &Key, write: fn(&str, &str)) {
    write(&key.plugin_id, &key.scope);
}

impl Entry {
    /// The error a call against a terminally crashed process answers with.
    fn crashed_refusal(&self) -> IpcError {
        let code = match self.reason.as_deref() {
            Some(REASON_PROTOCOL_MISMATCH) => PLUGIN_PROCESS_PROTOCOL_MISMATCH,
            _ => PLUGIN_PROCESS_CRASHED,
        };
        IpcError::from_message(
            code,
            format!(
                "This plugin's process is stopped ({}). Restart it to try again.",
                self.reason.as_deref().unwrap_or(REASON_CRASHED)
            ),
        )
    }
}

/// The current instant as ISO-8601 UTC, which is what the page formats (`new Date(value)`).
///
/// Hand-rolled rather than a dependency: the crate has no date library, and a field the page cannot
/// parse would show as an unreadable stamp beside the row.
fn now_iso() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    iso8601(elapsed.as_secs(), elapsed.subsec_millis())
}

/// One instant as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
fn iso8601(seconds: u64, millis: u32) -> String {
    let days = (seconds / 86_400) as i64;
    let rem = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

/// Days since the Unix epoch as a civil date (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The instant a row carries is one the page can parse: an ISO-8601 UTC string, not a
    /// millisecond count a `new Date(...)` would print as garbage.
    #[test]
    fn an_exit_instant_is_iso_8601() {
        assert_eq!(iso8601(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(1_700_000_000, 250), "2023-11-14T22:13:20.250Z");
        assert_eq!(iso8601(1_767_225_600, 0), "2026-01-01T00:00:00.000Z");
    }

    /// The backoff doubles from 1 s, and runs out after five restarts; a manual restart is a fresh
    /// budget, so the sequence starts at 1 s again.
    #[test]
    fn the_backoff_doubles_and_then_stops() {
        let delays: Vec<u64> = (0..super::super::MAX_RESTARTS)
            .map(|restarts| backoff_delay(restarts).expect("a delay").as_millis() as u64)
            .collect();
        assert_eq!(delays, vec![1_000, 2_000, 4_000, 8_000, 16_000]);
        assert_eq!(
            backoff_delay(super::super::MAX_RESTARTS),
            None,
            "the budget is spent"
        );
        assert_eq!(backoff_delay(super::super::MAX_RESTARTS + 3), None);
        // A manual restart puts `restarts` back to zero, which is the same call:
        assert_eq!(backoff_delay(0).map(|delay| delay.as_millis()), Some(1_000));
        // The ceiling and the survival reset are the numbers the doc comments state: the fifth delay
        // is 16 s, so the cap is unreachable at this count - a build that raised it would still stop
        // at half a minute rather than multiply its way to an hour.
        assert_eq!(
            super::super::BACKOFF_MAX,
            std::time::Duration::from_secs(30)
        );
        assert_eq!(
            super::super::SURVIVAL_RESET,
            std::time::Duration::from_secs(60)
        );
        assert_eq!(
            super::super::BACKOFF_FIRST,
            std::time::Duration::from_secs(1)
        );
    }

    /// The reset threshold is the whole question: a process that stayed live long enough earned its
    /// budget back, and one that never became live earned nothing.
    #[test]
    fn only_a_process_that_stayed_live_earns_its_budget_back() {
        assert!(lifecycle::survived(Some(SURVIVAL_RESET)));
        assert!(lifecycle::survived(Some(
            SURVIVAL_RESET + std::time::Duration::from_secs(1)
        )));
        assert!(!lifecycle::survived(Some(
            SURVIVAL_RESET - std::time::Duration::from_millis(1)
        )));
        assert!(!lifecycle::survived(None));
    }

    /// A crash line carries the exit code in both forms a reader needs: the number the process chose,
    /// and - for the Windows hard errors, which are negative as an `i32` - the hex the platform's own
    /// tools print.
    #[test]
    fn an_exit_code_is_written_in_the_form_a_reader_can_use() {
        assert_eq!(lifecycle::exit_code_text(Some(0)), "0");
        assert_eq!(lifecycle::exit_code_text(Some(1)), "1");
        assert_eq!(
            lifecycle::exit_code_text(Some(-1073741819)),
            "-1073741819 (0xC0000005)"
        );
        assert_eq!(lifecycle::exit_code_text(None), "no exit code");
    }

    /// The live ceiling is sixteen: the seventeenth start stops one, not seventeen processes.
    #[test]
    fn the_live_ceiling_is_sixteen() {
        assert_eq!(MAX_LIVE_PROCESSES, 16);
        assert_eq!(super::super::MAX_LIVE_PROCESSES, 16);
    }
}

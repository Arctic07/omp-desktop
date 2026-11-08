//! Ending the host: the graceful and the abrupt exit, the restart series, and the rebuild of the
//! conversations a restart interrupted.
//!
//! Split out of the command path: these methods own the transitions between generations, which is
//! what makes them the only place that may report an exit, restart the process, or re-register the
//! sessions a crash left behind.

use std::future::Future;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::errors::{IpcError, IpcResult, HOST_EXITED};
use crate::models::agent::EngineExitReason;
use crate::services::log;

use super::super::{ui, SHUTDOWN_GRACE_MS};
use super::process;
use super::session::SessionRuntime;
use super::{
    encode_frame, lock, HostRuntime, HostStatus, SessionSnapshot, HEALTH_PROBE_FAILURES,
    HEALTH_PROBE_INTERVAL_MS, HEALTH_PROBE_TIMEOUT_MS, RESTART_BACKOFF_MS, RESTART_MAX_ATTEMPTS,
    RESTART_STABLE_MS,
};

/// The resident size a host may hold, and the point at which it is considered runaway.
///
/// 2.5 GiB, and the number is measured rather than chosen. The first value tried was 1.5 GiB, on the
/// strength of a host holding 848 MiB; minutes after the first start of this build the *same* rule
/// was observed waiting on a host at 1.2 GB - an ordinary heavy conversation on this machine, steady
/// there, not climbing (2026-10-28, 14:30, sampled at 20 s). A ceiling 25% above what a legitimate
/// session reaches is a ceiling that interrupts the reader's turn to save memory they had to spare.
/// 2.5 GiB is about twice the heaviest host measured, so ordinary use cannot reach it - and it is
/// still a hard bound at a third of what the machine has, which is what "runaway" means here.
/// Neither the engine nor the runtime offers a knob that would make this unnecessary (see this
/// module's header).
const RSS_LIMIT_BYTES: u64 = 2560 * 1024 * 1024;

/// How long the host may hold that size before it is treated as runaway.
///
/// A minute, sampled every [`SAMPLE_INTERVAL`]: long enough to outlast the engine's own idle-session
/// eviction (which is what a genuinely quiet host would return its memory through), short enough
/// that the reader is not left with a machine that is swapping for minutes. The window only runs
/// while no turn is in flight, so this is a minute of overage with nothing the kill would interrupt.
const RSS_SUSTAINED: Duration = Duration::from_secs(60);

/// How often the resident size is read. Reading it is one `GetProcessMemoryInfo`, so the cost is the
/// wake-up, not the query.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(10);

/// What one observation says to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Verdict {
    /// Nothing: under the limit, or not over it for long enough yet.
    Hold,
    /// Over the limit, but a turn is in flight: the ceiling yields, and the episode is worth one
    /// line (`removed:notes/implemented/architecture/2026-10-28-host-memory-ceiling.md`).
    Defer,
    /// The overage has lasted: take the process tree down.
    Kill,
}

/// The rule, as a state machine over samples.
///
/// Kept separate from the sampling so every branch is a test with explicit instants
/// (`removed:notes/implemented/architecture/2026-10-28-host-memory-ceiling.md` says why this is a watchdog
/// and not an environment variable).
#[derive(Debug, Default)]
pub(super) struct Watch {
    /// When the current run of over-limit samples began, if this host is over the limit.
    over_since: Option<Instant>,
    /// Set once a kill was ordered: one host generation gets one kill, never a second.
    killed: bool,
    /// Set once the current overage has been reported as deferred, so one episode writes one line.
    deferred: bool,
}

/// Whether one timed-out health probe counts against the host.
///
/// A frame read after the probe was written is the host still answering; a main thread in a
/// reported stall is this side unable to deliver the answer. Neither is evidence the host is gone,
/// and a probe that measures this side's backlog must never be the reason a healthy process is
/// killed (2026-11-03: three timeouts killed a host that had answered all three while the window
/// was stalled 42.6 s).
fn probe_counts(last_frame_ms: u64, before: u64, stalled: bool) -> bool {
    last_frame_ms <= before && !stalled
}

impl Watch {
    /// Feeds one sample in.
    ///
    /// `resident` is bytes, `now` the instant the sample was taken. A sample at the limit is not
    /// over it - the ceiling is inclusive, the way a byte budget is (`<=` is "fits").
    ///
    /// `busy` is whether any conversation has a turn in flight. Memory over the ceiling is not by
    /// itself evidence of a runaway while a turn is running - a turn is the one thing this watcher
    /// must not interrupt - so the window does not accumulate then and starts fresh once the turn
    /// ends, which is what keeps the guarantee "never mid-turn" true for the kill that follows.
    pub(super) fn observe(&mut self, resident: u64, busy: bool, now: Instant) -> Verdict {
        if resident <= RSS_LIMIT_BYTES {
            self.over_since = None;
            self.deferred = false;
            return Verdict::Hold;
        }
        if self.killed {
            return Verdict::Hold;
        }
        if busy {
            self.over_since = None;
            if self.deferred {
                return Verdict::Hold;
            }
            self.deferred = true;
            return Verdict::Defer;
        }
        match self.over_since {
            Some(since) if now.saturating_duration_since(since) >= RSS_SUSTAINED => {
                self.killed = true;
                Verdict::Kill
            }
            Some(_) => Verdict::Hold,
            None => {
                self.over_since = Some(now);
                Verdict::Hold
            }
        }
    }
}

impl HostRuntime {
    /// Ends the generation: reports the exit, tells every session, and restarts when the exit was
    /// not asked for.
    pub(super) async fn finalize(&self, generation: u64, code: Option<i32>) {
        let (sessions, reason, retry, shared) = {
            let mut state = lock(&self.inner.state);
            if state.generation != generation {
                // A replacement already took over; the corpse has nothing left to say.
                return;
            }
            let sessions: Vec<Arc<SessionRuntime>> = state.sessions.drain();
            let reason = state.intent.unwrap_or(EngineExitReason::Exit);
            let stable = state.ready_since_ms > 0
                && (crate::services::store::now_ms().max(1) as u64)
                    .saturating_sub(state.ready_since_ms)
                    >= RESTART_STABLE_MS;
            if stable {
                state.attempts = 0;
            }
            // An exit nobody asked for is a crash: it is the only case that is retried and the
            // only case that marks the conversations it interrupted.
            let retry = state.intent.is_none() && !state.no_retry && !state.quitting;
            if retry {
                state.restore_queue = sessions
                    .iter()
                    .map(|session| SessionSnapshot {
                        id: session.id.clone(),
                        file: session.file(),
                        cwd: session.cwd().to_owned(),
                        workspace_id: session.workspace_id(),
                        streaming: session.is_streaming(),
                    })
                    .collect();
            }
            let shared = state.shared.clone();
            state.status = if retry {
                HostStatus::Starting
            } else {
                HostStatus::Stopped
            };
            state.stdin = None;
            state.child = None;
            state.pid = 0;
            // The process this id named is gone: a demotion applied on its behalf from here on
            // would land on whatever process the system hands that id to next.
            crate::services::process_tuning::forget_host();
            state.pending.clear();
            state.prompt_late.clear();
            state.ready = Some(Err(IpcError::new(
                HOST_EXITED,
                "The engine host is no longer running.",
            )));
            (sessions, reason, retry, shared)
        };
        let detail = match lock(&shared.stderr_tail).clone() {
            Some(tail) => format!(": {tail}"),
            None => String::new(),
        };
        shared
            .log
            .line(&format!("engine host exited with code {code:?}{detail}"));
        self.report_exit(reason);
        self.announce_loss(&sessions, retry).await;
        // The children this process was drawing went with the host that ran them: every turn they
        // held has just been reported closed (`announce_loss`), and no frame can extend one any
        // more. Dropped after that report and not with the registry above, because a child's
        // projector is not a conversation - it is the delivery state of a channel nothing will
        // publish on again.
        self.child_projections().clear();
        self.inner.startup_notify.notify_waiters();
        if retry {
            // Detached on purpose: the restart series awaits a fresh handshake, which cannot be
            // part of the frame loop that is reporting this exit.
            let host = self.clone();
            tauri::async_runtime::spawn(async move { host.auto_restart().await });
        }
    }

    /// Tells every session the host died, and closes the turn it was running.
    async fn announce_loss(&self, sessions: &[Arc<SessionRuntime>], crashed: bool) {
        let code = if crashed {
            crate::errors::HOST_CRASHED
        } else {
            HOST_EXITED
        };
        // What is true at this moment: the conversations of a crashed host were interrupted, and
        // the rebuild that follows is what reloads them. Saying they "were rebuilt" would state an
        // outcome the restart series may still fail to reach - a degraded host rebuilds nothing -
        // and this message is the only account of the crash the user gets.
        let message = if crashed {
            "The engine host stopped unexpectedly. Its conversations were interrupted and will be \
             reloaded from disk."
        } else {
            "The engine host was shut down."
        };
        for session in sessions {
            // Every dialog of this conversation was the host asking a question, and the host is
            // gone: the cards have to come down rather than sit there waiting for an answer no one
            // can receive. Cancelling first also means the failure below is read as the reason the
            // cards closed, not as something that happened behind them.
            ui::cancel_all(self, &self.inner.app, session);
            let mut events = session.events.lock().await;
            events.report_error(&self.inner.app, session, code, message.to_owned());
            session.set_streaming(false);
            if crashed {
                session.set_interrupted(true);
            }
        }
        // The children this process was drawing hear the same thing, for the same reason: a screen
        // attached to one is drawing a turn that only this host could have ended, and the frames
        // that would have closed it are gone with the process. They are not this process's
        // conversations - no dialog belongs to one, and no row reads their interrupted bit - so the
        // report, which is what closes the turn and settles that screen, is all they are owed.
        for child in self.child_projections().all() {
            let mut events = child.events.lock().await;
            events.report_error(&self.inner.app, &child, code, message.to_owned());
        }
    }

    /// Asks a live host whether it is still answering, and kills the process tree once it has
    /// stopped, so the existing crash path can recover it.
    ///
    /// A host that is alive but wedged answers nothing: every command sent to it just times out, and
    /// the user sees a spinner that never ends. This watcher probes the process itself on a schedule -
    /// but only while a conversation is open, because a host with nothing to serve is idle by
    /// design and must not be mistaken for a wedged one. One unanswered probe is not enough either:
    /// the process may simply be busy inside a long turn, so the failure has to repeat before the
    /// host is treated as gone.
    ///
    /// Killing the tree is deliberate rather than a new recovery path: it makes the existing crash
    /// path run unchanged - the child-exit detector reports the exit with no intent recorded, so
    /// `finalize` drains the sessions, `announce_loss` marks them interrupted and the restart series
    /// rebuilds them. Nothing here invents an [`EngineExitReason`] or marks the host degraded by
    /// hand; it only stops a process that has already stopped answering.
    pub(super) async fn watch_liveness(self, generation: u64) {
        let mut failures: u32 = 0;
        loop {
            tokio::time::sleep(Duration::from_millis(HEALTH_PROBE_INTERVAL_MS)).await;
            if !self.is_current(generation) {
                return;
            }
            // No conversation open means nothing is waiting on this host, so a slow answer costs
            // nobody anything: reset the count and leave the process alone.
            let (sessions, shared) = {
                let state = lock(&self.inner.state);
                (state.sessions.len(), state.shared.clone())
            };
            if sessions == 0 {
                failures = 0;
                continue;
            }
            // A window that cannot run its own posted closure is not evidence about the host: the
            // probe would time out behind the same stall that froze the reader. The main-thread
            // watchdog owns that fact (`main_thread_watch::stalled`).
            if crate::services::main_thread_watch::stalled() {
                failures = 0;
                continue;
            }
            let before = shared.last_frame_ms.load(Ordering::Relaxed);
            match self
                .call(json!({"type": "host_health"}), HEALTH_PROBE_TIMEOUT_MS)
                .await
            {
                Ok(_) => failures = 0,
                // Gone or not running: the ordinary exit path owns that, and it reports the exit
                // itself - this watcher would only be a second account of the same fact.
                Err(error)
                    if error.code == crate::errors::HOST_EXITED
                        || error.code == crate::errors::HOST_CRASHED
                        || error.code == crate::errors::HOST_NOT_READY =>
                {
                    return;
                }
                // Every other failure is the host not answering a trivial frame: the probe timed
                // out, the queue would not take it, or the frame could not be written. Counting
                // them together is what keeps the watcher armed - a process whose inbound queue is
                // full is one that stopped draining it, which is the same wedged state this exists
                // to end.
                Err(_) => {
                    // A frame read while the probe was in flight is the host still talking: the
                    // dispatcher is behind, not the process. Killing it would interrupt the
                    // conversation to cure a backlog on this side (measured 2026-11-03: the reader
                    // thread kept receiving frames while the window's main thread was stalled
                    // 42.6 s, and three probe timeouts killed a host that had answered all three).
                    if !probe_counts(
                        shared.last_frame_ms.load(Ordering::Relaxed),
                        before,
                        crate::services::main_thread_watch::stalled(),
                    ) {
                        failures = 0;
                        continue;
                    }
                    failures += 1;
                    if failures < HEALTH_PROBE_FAILURES {
                        continue;
                    }
                    // Re-checked before killing: a restart may have replaced the generation while
                    // this probe was in flight, and the corpse must not be killed twice nor its
                    // replacement torn down by mistake. The state is read in one scoped lock, and
                    // the kill happens outside it - `kill_tree` waits on a child the state lock must
                    // not be held across.
                    let (child, pid, shared) = {
                        let state = lock(&self.inner.state);
                        if state.generation != generation {
                            return;
                        }
                        (state.child.clone(), state.pid, state.shared.clone())
                    };
                    shared.log.line(&format!(
                        "engine host unresponsive after {failures} health probes; killing the \
                         process tree"
                    ));
                    if let Some(child) = child {
                        process::kill_tree(&child, pid);
                    }
                    return;
                }
            }
        }
    }

    /// Stops the host from a synchronous exit hook: asks it to shut down, closes its stdin, and
    /// gives it the grace window before the tree is killed.
    ///
    /// Deliberately blocking: the application is on its way out, no asynchronous task is
    /// guaranteed to run again, and leaving the host behind would leave a process holding the
    /// session files. Closing the pipe is also the signal that makes a host which ignores
    /// `host_shutdown` exit on its own.
    pub(crate) fn shutdown_now(&self) {
        let (stdin, child, pid, shared) = {
            let mut state = lock(&self.inner.state);
            state.quitting = true;
            state.intent = Some(EngineExitReason::Exit);
            state.status = HostStatus::Stopped;
            (
                state.stdin.take(),
                state.child.take(),
                state.pid,
                state.shared.clone(),
            )
        };
        if let Some(stdin) = &stdin {
            let frame =
                json!({"type": "host_shutdown", "reason": "quit", "id": self.unawaited_id()});
            if let Ok(bytes) = encode_frame(&shared, &frame) {
                // Offered, never awaited: the exit path must not block on a queue the host has
                // stopped draining, and closing stdin below is the signal that actually ends it.
                let _ = stdin.try_send(bytes);
            }
        }
        drop(stdin);
        if let Some(child) = child {
            let deadline =
                std::time::Instant::now() + std::time::Duration::from_millis(SHUTDOWN_GRACE_MS);
            while std::time::Instant::now() < deadline {
                if process::try_reap(&child) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            if !process::try_reap(&child) {
                shared.log.line("host process tree killed (quit)");
                process::kill_tree(&child, pid);
            }
        }
        {
            let mut state = lock(&self.inner.state);
            state.pending.clear();
            state.prompt_late.clear();
            state.child = None;
            state.stdin = None;
            state.pid = 0;
        }
        // The host this process recorded is gone: a start that reads the file next time must not
        // find a pid that belonged to this run (`services::runtime::owner`).
        super::super::owner::forget(&self.inner.paths);
        self.report_exit(EngineExitReason::Exit);
    }

    /// One automatic restart series: backoff, then a fresh process and the rebuilt sessions.
    async fn auto_restart(self) {
        loop {
            let attempt = {
                let mut state = lock(&self.inner.state);
                if state.quitting {
                    return;
                }
                state.attempts += 1;
                state.attempts
            };
            if attempt > RESTART_MAX_ATTEMPTS {
                self.degrade(&format!(
                    "the host kept failing to restart ({RESTART_MAX_ATTEMPTS} attempts)"
                ));
                return;
            }
            let backoff =
                RESTART_BACKOFF_MS[(attempt as usize - 1).min(RESTART_BACKOFF_MS.len() - 1)];
            if backoff > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(backoff)).await;
            }
            if lock(&self.inner.state).quitting {
                return;
            }
            match self.start_boxed().await {
                Ok(()) => {
                    let queue = std::mem::take(&mut lock(&self.inner.state).restore_queue);
                    self.restore_sessions(queue).await;
                    return;
                }
                Err(error) => {
                    let fatal = lock(&self.inner.state).no_retry;
                    if fatal {
                        self.degrade(&format!("it cannot be restarted: {}", error.message));
                        return;
                    }
                }
            }
        }
    }

    /// The restart series is over: the host stays down until the user restarts it.
    ///
    /// The state is reported where it can be seen rather than only in a debug line: `runtime_status`
    /// carries the lifecycle token, so a degraded host is distinguishable from one that was never
    /// started, and the reason is written to the host's own log - the frames that would have
    /// explained it are exactly the ones that stopped arriving.
    fn degrade(&self, reason: &str) {
        {
            let mut state = lock(&self.inner.state);
            state.status = HostStatus::Degraded;
        }
        self.log(&format!("engine host degraded: {reason}"));
        log::warn(&format!("the engine host is degraded ({reason})"));
    }

    /// The start path behind a boxed future, for the one caller that recurses into it.
    ///
    /// The dispatcher task this path spawns reports exits, and reporting an exit can schedule
    /// another restart series - so the call graph is cyclic, and an opaque future cannot contain a
    /// call to itself. Erasing this one edge behind a box ends the cycle while the future stays
    /// `Send`.
    ///
    /// It calls [`HostRuntime::start`] and not `ensure_running`: a restart series is allowed to try
    /// again, which is precisely what the implicit path refuses once the host is degraded.
    fn start_boxed(&self) -> std::pin::Pin<Box<dyn Future<Output = IpcResult<()>> + Send + '_>> {
        Box::pin(self.start())
    }

    /// Graceful stop: ask the host to shut down, close its stdin, and kill the tree if it
    /// overstays the grace window.
    pub(super) async fn shutdown_with(&self, reason: EngineExitReason) {
        let (stdin, child, pid, shared) = {
            let mut state = lock(&self.inner.state);
            if state.status == HostStatus::Stopped && state.child.is_none() {
                return;
            }
            state.intent = Some(reason);
            state.status = HostStatus::Stopped;
            (
                state.stdin.take(),
                state.child.take(),
                state.pid,
                state.shared.clone(),
            )
        };
        if let Some(stdin) = &stdin {
            let frame =
                json!({"type": "host_shutdown", "reason": "desktop", "id": self.unawaited_id()});
            if let Ok(bytes) = encode_frame(&shared, &frame) {
                // Offered rather than sent, for the same reason the exit path offers it: a host
                // that is not draining its stdin must not be able to hold this call open.
                let _ = stdin.try_send(bytes);
            }
        }
        // Closing stdin is the host's own signal to leave: it is what makes a host that ignores
        // the frame exit anyway.
        drop(stdin);
        if let Some(child) = child {
            let deadline =
                std::time::Instant::now() + std::time::Duration::from_millis(SHUTDOWN_GRACE_MS);
            while std::time::Instant::now() < deadline {
                if process::try_reap(&child) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            if !process::try_reap(&child) {
                shared
                    .log
                    .line(&format!("host process tree killed ({reason:?})"));
                process::kill_tree(&child, pid);
            }
        }
        {
            let mut state = lock(&self.inner.state);
            state.pending.clear();
            state.prompt_late.clear();
            state.child = None;
            state.stdin = None;
            state.pid = 0;
            if !state.quitting {
                state.status = HostStatus::Stopped;
            }
        }
        super::super::owner::forget(&self.inner.paths);
        self.report_exit(reason);
        self.inner.startup_notify.notify_waiters();
    }

    /// Watches one host generation, killing its tree once the resident size has been over the
    /// ceiling long enough (`Watch`), and returning as soon as the generation is gone.
    ///
    /// A turn in flight holds the kill off: the overage is then not a window, and the ceiling only
    /// acts after the last turn ends and a fresh window has passed with the host still over
    /// (`removed:notes/implemented/architecture/2026-10-28-host-memory-ceiling.md`). The one line an episode
    /// writes is what keeps that deferral visible.
    pub(super) async fn watch_memory(self, generation: u64) {
        let mut rule = Watch::default();
        loop {
            tokio::time::sleep(SAMPLE_INTERVAL).await;
            if !self.is_current(generation) {
                return;
            }
            let Some((child, pid)) = ({
                let state = lock(&self.inner.state);
                state
                    .child
                    .clone()
                    .zip((state.pid != 0).then_some(state.pid))
            }) else {
                return;
            };
            let Some(resident) = resident_bytes(pid) else {
                // The pid is gone, or this process may not ask: the ordinary exit path owns that.
                return;
            };
            let busy = self.sessions().iter().any(|session| session.is_streaming());
            match rule.observe(resident, busy, Instant::now()) {
                Verdict::Hold => continue,
                Verdict::Defer => {
                    log::warn(&format!(
                        "engine host held {resident} bytes resident with a turn in flight; the \
                         ceiling waits for the turn to end"
                    ));
                    continue;
                }
                Verdict::Kill => {}
            }
            log::warn(&format!(
                "engine host held {resident} bytes resident for over {}s; killing its process tree so the host can be rebuilt",
                RSS_SUSTAINED.as_secs()
            ));
            process::kill_tree(child.as_ref(), pid);
            return;
        }
    }
}

/// One process's resident set, in bytes.
#[cfg(windows)]
fn resident_bytes(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE};
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    if pid == 0 {
        return None;
    }
    // SAFETY: the handle is closed on both paths; the call writes exactly one `PROCESS_MEMORY_COUNTERS`
    // into a live local and answers whether it did.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if handle.is_null() {
            return None;
        }
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let queried = GetProcessMemoryInfo(
            handle,
            &mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        );
        CloseHandle(handle);
        (queried != FALSE).then_some(counters.WorkingSetSize as u64)
    }
}

/// The same number where the kernel reports it as text.
#[cfg(not(windows))]
fn resident_bytes(pid: u32) -> Option<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let line = status
        .lines()
        .find(|line| line.starts_with("VmRSS:"))?
        .split_whitespace()
        .nth(1)?;
    line.parse::<u64>().ok().map(|kb| kb * 1024)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> Instant {
        // One origin for every case: `Instant` cannot be constructed, and the rule only ever reads
        // differences.
        let base = Instant::now();
        base + Duration::from_secs(seconds)
    }

    #[test]
    fn a_probe_timed_out_behind_a_stall_or_while_frames_arrived_is_not_evidence() {
        // The ordinary timeout: nothing was read and the window is healthy.
        assert!(probe_counts(100, 100, false));
        // A frame arrived after the probe was written: the host answered, this side was behind.
        assert!(!probe_counts(101, 100, false));
        // The window itself is stalled, so a probe cannot be answered by it.
        assert!(!probe_counts(100, 100, true));
        assert!(!probe_counts(101, 100, true));
    }

    #[test]
    fn a_host_under_the_limit_is_never_killed() {
        let mut rule = Watch::default();
        assert_eq!(rule.observe(RSS_LIMIT_BYTES, false, at(0)), Verdict::Hold);
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES - 1, true, at(60)),
            Verdict::Hold
        );
        assert_eq!(rule.observe(0, false, at(120)), Verdict::Hold);
    }

    #[test]
    fn a_host_over_the_limit_is_given_the_whole_window() {
        let mut rule = Watch::default();
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, false, at(0)),
            Verdict::Hold
        );
        // One second short of the window: still holding.
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, false, at(RSS_SUSTAINED.as_secs() - 1)),
            Verdict::Hold
        );
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, false, at(RSS_SUSTAINED.as_secs())),
            Verdict::Kill
        );
    }

    #[test]
    fn dropping_under_the_limit_restarts_the_window() {
        let mut rule = Watch::default();
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, false, at(0)),
            Verdict::Hold
        );
        // The host shed its idle sessions, which is what this wait exists for.
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES / 2, false, at(30)),
            Verdict::Hold
        );
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, false, at(59)),
            Verdict::Hold
        );
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, false, at(59 + RSS_SUSTAINED.as_secs())),
            Verdict::Kill,
            "the new run of samples has to last the window on its own"
        );
    }

    /// A running turn is never interrupted, however long the host stays over the ceiling: the
    /// episode is announced once and every later sample holds.
    #[test]
    fn a_turn_in_flight_holds_the_kill_off() {
        let mut rule = Watch::default();
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, true, at(0)),
            Verdict::Defer
        );
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, true, at(60)),
            Verdict::Hold
        );
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, true, at(3_600)),
            Verdict::Hold
        );
    }

    /// The window does not accumulate while a turn runs: the kill needs a full window of idle
    /// overage after the turn, so a turn that starts in the middle of a window restarts it.
    #[test]
    fn the_window_restarts_after_a_turn_ends() {
        let mut rule = Watch::default();
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, false, at(0)),
            Verdict::Hold
        );
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, true, at(30)),
            Verdict::Defer
        );
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, false, at(31)),
            Verdict::Hold
        );
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, false, at(90)),
            Verdict::Hold,
            "the fresh window is one second short"
        );
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, false, at(91)),
            Verdict::Kill
        );
    }

    #[test]
    fn one_generation_is_killed_once() {
        let mut rule = Watch::default();
        rule.observe(RSS_LIMIT_BYTES + 1, false, at(0));
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, false, at(61)),
            Verdict::Kill
        );
        assert_eq!(
            rule.observe(RSS_LIMIT_BYTES + 1, false, at(600)),
            Verdict::Hold,
            "the same host is not killed again while its death is being handled"
        );
    }
}

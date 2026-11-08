//! The supervisor's lifecycle: spawning, handshake, the live ceiling, the crash
//! bookkeeping and the backoff, and the graceful stop that ends a child.

use std::sync::mpsc::Receiver;

use super::reader::{drain_stderr, read_frames, ReaderContext};
use super::*;

impl PluginProcess {
    // ---- the lifecycle ----

    /// Ensures a live worker for one installation, spawning and handshaking when needed.
    pub(super) fn start(self: &Arc<Self>, key: &Key) -> IpcResult<()> {
        let (install, start_lock) = {
            let inner = self.lock();
            if inner.shutdown {
                return Err(IpcError::new(
                    PLUGIN_PROCESS_UNAVAILABLE,
                    "The application is shutting down.",
                ));
            }
            let Some(entry) = inner.entries.get(key) else {
                return Err(unavailable());
            };
            (entry.install.clone(), Arc::clone(&entry.start))
        };
        let _starting = lock(&start_lock);
        {
            let mut inner = self.lock();
            let Some(entry) = inner.entries.get_mut(key) else {
                return Err(unavailable());
            };
            if entry.state.is_live() {
                entry.last_used = Instant::now();
                return Ok(());
            }
            if !install.enabled {
                return Err(unavailable());
            }
            entry.state = ProcessState::Starting;
            entry.terminal = false;
            entry.pid = None;
        }
        // The live ceiling is applied before the spawn: the least recently used rule.
        self.make_room(key);

        let spawned = match self.spawner.spawn(&install) {
            Ok(spawned) => spawned,
            Err(error) => {
                self.abandon_start(key);
                return Err(error);
            }
        };
        let pending = Arc::new(Pending::new());
        let generation = {
            let mut inner = self.lock();
            let Some(entry) = inner.entries.get_mut(key) else {
                spawned.link.kill();
                return Err(unavailable());
            };
            entry.pid = spawned.pid;
            let worker = Worker {
                generation: entry.epoch.wrapping_add(1),
                link: Arc::clone(&spawned.link),
                pending: Arc::clone(&pending),
            };
            let generation = worker.generation;
            entry.worker = Some(worker);
            entry.last_used = Instant::now();
            generation
        };
        if let Some(stderr) = spawned.stderr {
            let plugin = install.plugin_id.clone();
            std::thread::spawn(move || drain_stderr(stderr, plugin));
        }
        let hello = self.spawn_reader(key, generation, spawned.stdout, &pending, &spawned.link);

        let answered = match hello {
            Some(hello) => hello,
            None => {
                // Either the worker died before it introduced itself (its exit handler has already
                // written the row) or nothing said hello inside the budget. Only the second is a
                // timeout, and only a live row is terminated: overwriting a crash reason with one
                // this side invented would hide the worker's own words.
                let already_crashed = {
                    let inner = self.lock();
                    inner
                        .entries
                        .get(key)
                        .is_some_and(|entry| entry.state == ProcessState::Crashed)
                };
                if !already_crashed {
                    self.terminate(key, generation, REASON_TIMEOUT);
                }
                return Err(IpcError::new(
                    PLUGIN_PROCESS_CRASHED,
                    "The plugin process did not start.",
                ));
            }
        };
        log::info(&format!(
            "a plugin process started: plugin={} scope={} pid={:?} entry={}",
            install.plugin_id, install.scope, spawned.pid, answered.entry
        ));
        if answered.protocol != WORKER_PROTOCOL {
            log::warn(&format!(
                "{PROTOCOL_MISMATCH_LOG}: plugin={} got={} expected={WORKER_PROTOCOL}",
                install.plugin_id, answered.protocol
            ));
            self.terminate(key, generation, REASON_PROTOCOL_MISMATCH);
            return Err(IpcError::new(
                PLUGIN_PROCESS_PROTOCOL_MISMATCH,
                "This plugin's process speaks a different protocol version.",
            ));
        }

        // The load frame carries the activation event and is answered under its own id; a refusal
        // here is a startup failure, not a crash to back off from.
        let id = format!("l{}", pending.next_id.fetch_add(1, Ordering::SeqCst));
        let activation = {
            let inner = self.lock();
            inner
                .entries
                .get(key)
                .map(|entry| entry.activation.clone())
                .unwrap_or_else(|| ACTIVATION_STARTUP.to_owned())
        };
        let (sender, receiver): (SettlementSender, Receiver<Settlement>) = mpsc::sync_channel(1);
        lock(&pending.calls).insert(id.clone(), sender);
        let loaded = match frames::encode(&frames::Outbound::Load {
            id: &id,
            activation: &activation,
        }) {
            Ok(line) => spawned.link.send(&line),
            Err(_) => false,
        };
        if !loaded {
            lock(&pending.calls).remove(&id);
            self.terminate(key, generation, REASON_CRASHED);
            return Err(IpcError::new(
                PLUGIN_PROCESS_CRASHED,
                "The plugin process stopped before it was loaded.",
            ));
        }
        match receiver.recv_timeout(self.timeouts.load) {
            Ok(settlement) if settlement.ok => {}
            Ok(settlement) => {
                let message = settlement
                    .message
                    .unwrap_or_else(|| "The plugin refused its own load.".to_owned());
                self.terminate(key, generation, REASON_CRASHED);
                return Err(IpcError::from_message(PLUGIN_PROCESS_CRASHED, message));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // The worker is gone; its exit handler owns the row and the retry.
                return Err(IpcError::new(
                    PLUGIN_PROCESS_CRASHED,
                    "The plugin process ended while it was loading.",
                ));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                lock(&pending.calls).remove(&id);
                self.terminate(key, generation, REASON_TIMEOUT);
                return Err(IpcError::new(
                    PLUGIN_PROCESS_CRASHED,
                    "The plugin process did not finish loading in time.",
                ));
            }
        }

        let started = {
            let mut inner = self.lock();
            match inner.entries.get_mut(key) {
                Some(entry)
                    if entry
                        .worker
                        .as_ref()
                        .is_some_and(|w| w.generation == generation) =>
                {
                    entry.state = ProcessState::Running;
                    // The pending retry (if any) is dropped here by construction: it only starts a
                    // process whose row is `crashed`, and this row is live.
                    entry.last_used = Instant::now();
                    // The clock the crash budget's reset is measured against: a process that stays
                    // live past `SURVIVAL_RESET` is a process that started fine.
                    entry.live_since = Some(Instant::now());
                    true
                }
                _ => false,
            }
        };
        if !started {
            return Err(IpcError::new(
                PLUGIN_PROCESS_CRASHED,
                "The plugin process ended while it was starting.",
            ));
        }
        audit::process_start(&install.plugin_id, &install.scope);
        self.emit();
        Ok(())
    }

    /// Waits for the hello, or answers `None` when the budget ran out or the process ended first.
    fn spawn_reader(
        self: &Arc<Self>,
        key: &Key,
        generation: u64,
        stdout: Box<dyn Read + Send>,
        pending: &Arc<Pending>,
        link: &Arc<dyn WorkerLink>,
    ) -> Option<Hello> {
        let (sender, receiver): (SyncSender<Option<Hello>>, Receiver<Option<Hello>>) =
            mpsc::sync_channel(1);
        *lock(&pending.hello) = Some(sender);
        let (install, commands) = {
            let inner = self.lock();
            let entry = inner.entries.get(key)?;
            (Arc::new(entry.install.clone()), Arc::clone(&entry.commands))
        };
        let context = Arc::new(ReaderContext {
            install,
            app: self.app.clone(),
            pending: Arc::clone(pending),
            link: Arc::clone(link),
            commands,
            weak: Arc::downgrade(self),
            key: key.clone(),
            generation,
        });
        std::thread::spawn(move || read_frames(stdout, &context));
        // `None` covers both the budget running out and the child dying first (its exit handler
        // sends `None` into this same slot), and the caller tells the two apart from the row.
        receiver
            .recv_timeout(self.timeouts.load)
            .unwrap_or_default()
    }

    /// The per-installation start lock failed before a worker existed: the row goes back to stopped.
    fn abandon_start(&self, key: &Key) {
        let mut inner = self.lock();
        if let Some(entry) = inner.entries.get_mut(key) {
            if entry.state == ProcessState::Starting && entry.worker.is_none() {
                entry.state = ProcessState::Stopped;
            }
        }
    }

    /// Stops one live worker because *it* failed: the row is `crashed` with the reason, no retry.
    ///
    /// Used for the three failures a retry cannot fix - a handshake timeout, a protocol mismatch and
    /// a call that ran past its budget. The worker is killed after the row has already been written,
    /// so the reader's own exit handler sees a `crashed` row it must not overwrite.
    pub(super) fn terminate(self: &Arc<Self>, key: &Key, generation: u64, reason: &'static str) {
        let worker = {
            let mut inner = self.lock();
            let Some(entry) = inner.entries.get_mut(key) else {
                return;
            };
            if !entry
                .worker
                .as_ref()
                .is_some_and(|worker| worker.generation == generation)
            {
                return;
            }
            entry.epoch += 1;
            entry.state = ProcessState::Crashed;
            entry.terminal = true;
            entry.reason = Some(reason.to_owned());
            entry.pid = None;
            entry.take_worker()
        };
        if reason == REASON_TIMEOUT {
            audit_process(key, audit::process_timeout);
        } else {
            audit_process(key, audit::process_crash);
        }
        if let Some(worker) = worker {
            // A crashed or timed-out child is not a subscriber and not a socket owner: the
            // capabilities it held are released here, before anything can publish to it again.
            self.release_capabilities(key);
            worker.link.kill();
        }
        self.emit();
    }

    /// Applies the live ceiling: stops the least recently used live installation when the next
    /// start would exceed [`MAX_LIVE_PROCESSES`].
    fn make_room(self: &Arc<Self>, key: &Key) {
        loop {
            let victim = {
                let inner = self.lock();
                let live: Vec<&Key> = inner
                    .entries
                    .iter()
                    .filter(|(candidate, entry)| entry.state.is_live() && *candidate != key)
                    .map(|(candidate, _)| candidate)
                    .collect();
                if live.len() < MAX_LIVE_PROCESSES {
                    return;
                }
                live.into_iter()
                    .min_by_key(|candidate| {
                        inner
                            .entries
                            .get(*candidate)
                            .map(|entry| entry.last_used)
                            .unwrap_or_else(Instant::now)
                    })
                    .cloned()
            };
            let Some(victim) = victim else {
                return;
            };
            let worker = {
                let mut inner = self.lock();
                let Some(entry) = inner.entries.get_mut(&victim) else {
                    return;
                };
                entry.epoch += 1;
                entry.state = ProcessState::Stopped;
                entry.reason = None;
                entry.pid = None;
                entry.take_worker()
            };
            if let Some(worker) = worker {
                log::info(&format!(
                    "a plugin process was recycled for the live ceiling: plugin={} scope={}",
                    victim.plugin_id, victim.scope
                ));
                self.release_capabilities(&victim);
                stop_worker(&worker, &victim, self.timeouts.unload);
            }
        }
    }

    /// Stops what a new plugin list no longer runs, off the caller's thread (each stop may wait on a
    /// worker's unload).
    pub(super) fn stop_in_background(self: &Arc<Self>, workers: Vec<(Worker, Key)>) {
        let weak = Arc::downgrade(self);
        let unload = self.timeouts.unload;
        std::thread::spawn(move || {
            for (worker, key) in workers {
                if let Some(me) = weak.upgrade() {
                    me.release_capabilities(&key);
                }
                stop_worker(&worker, &key, unload);
            }
            if let Some(me) = weak.upgrade() {
                me.emit();
            }
        });
    }

    /// The last exit code of one installation's process, for the supervisor's own tests (the DTO
    /// deliberately carries none: the page shows a time and a state, not a number whose meaning
    /// differs by platform).
    #[cfg(test)]
    pub(crate) fn last_exit_code(&self, install: &str, scope: &str) -> Option<Option<i32>> {
        let inner = self.lock();
        inner
            .entries
            .iter()
            .find(|(_, entry)| entry.install.install == install && entry.install.scope == scope)
            .map(|(_, entry)| entry.last_exit_code)
    }

    /// The row of one `(plugin_id, scope)` installation.
    pub(super) fn key_for_plugin(&self, plugin_id: &str, scope: &str) -> IpcResult<Key> {
        let inner = self.lock();
        inner
            .entries
            .iter()
            .find(|(_, entry)| entry.install.plugin_id == plugin_id && entry.install.scope == scope)
            .map(|(key, _)| key.clone())
            .ok_or_else(unavailable)
    }

    /// The exit handler: one worker ended, on its own or because it was killed.
    ///
    /// Three answers, and the difference is the point (plan §6.4): an expected stop keeps `stopped`;
    /// a process that never became live is `crashed` and not retried (a startup refusal is
    /// deterministic); a process that *was* live is `crashed` and retried with the backoff, until the
    /// budget is spent.
    pub(super) fn worker_exited(self: &Arc<Self>, key: &Key, generation: u64, code: Option<i32>) {
        let mut retry: Option<(Key, u64, Duration)> = None;
        let mut emit = false;
        let mut crashed = false;
        {
            let mut inner = self.lock();
            let Some(entry) = inner.entries.get_mut(key) else {
                return;
            };
            let Some(worker) = entry.take_worker() else {
                // Already handled (a terminate, a stop): only the exit instant is news.
                entry.last_exit_at = Some(now_iso());
                entry.pid = None;
                #[cfg(test)]
                {
                    entry.last_exit_code = code;
                }
                drop(inner);
                self.emit();
                return;
            };
            if worker.generation != generation {
                // A stale reader: this child was replaced, and its exit says nothing about the row.
                entry.worker = Some(worker);
                return;
            }
            let fatal = worker.pending.fatal();
            // A start parked on the hello channel learns the process is gone now rather than after
            // its whole budget: the row is written below, and the wait would only delay the answer.
            if let Some(sender) = lock(&worker.pending.hello).take() {
                let _ = sender.send(None);
            }
            // The same for every call in flight: dropping the senders is the release point that
            // answers them at once, instead of leaving each caller to sit out its budget and report
            // a timeout this side invented. A crash is not a slow plugin.
            lock(&worker.pending.calls).clear();
            // This child is gone, so the next one cannot carry its generation: `start` derives the
            // generation from the epoch, and a plain crash used to leave the counter where the dead
            // child left it - a late timeout from the dead child's caller then matched, and killed,
            // its healthy replacement.
            entry.epoch += 1;
            entry.pid = None;
            entry.last_exit_at = Some(now_iso());
            #[cfg(test)]
            {
                entry.last_exit_code = code;
            }
            // How long this process was live, which is what decides whether its crash is a *new*
            // event or one more of a burst: a plugin that worked for a minute did not fail to start.
            // Taken here rather than on the start path because this is the one place both outcomes
            // meet, and the field is the row's own memory of being alive.
            let alive = entry.live_since.take().map(|since| since.elapsed());
            match entry.state {
                ProcessState::Stopped => {}
                ProcessState::Starting => {
                    // Never became live: the worker refused to start (`worker_fatal`) or the entry
                    // could not be evaluated. The reason is its own code, not a crash class.
                    entry.state = ProcessState::Crashed;
                    entry.terminal = true;
                    entry.reason = Some(
                        fatal
                            .map(|(code, _)| code)
                            .unwrap_or_else(|| REASON_CRASHED.to_owned()),
                    );
                    emit = true;
                    crashed = true;
                }
                ProcessState::Running | ProcessState::Crashed => {
                    if entry.reason.is_none() || !entry.terminal {
                        entry.reason = Some(REASON_CRASHED.to_owned());
                    }
                    entry.state = ProcessState::Crashed;
                    // A process that stayed alive long enough for its crash to be its own earns the
                    // budget back: without this a plugin that dies once a day would spend its five
                    // restarts across a week and then stay down until the reader noticed.
                    if survived(alive) {
                        entry.restarts = 0;
                    }
                    // A manifest that turned the restarts off goes straight to `crashed`, exactly as
                    // a spent budget does: the row is where the reader sees it, and the manual
                    // restart still works.
                    if !entry.terminal && entry.install.auto_restart {
                        if let Some(delay) = backoff_delay(entry.restarts) {
                            entry.restarts += 1;
                            retry = Some((key.clone(), entry.epoch, delay));
                        } else {
                            entry.terminal = true;
                        }
                    } else {
                        entry.terminal = true;
                    }
                    emit = true;
                    crashed = true;
                }
            }
        }
        if crashed {
            audit_process(key, audit::process_crash);
            // One line per crash, with the exit code the process chose: it is the only fact a reader
            // can act on, and on Windows the interesting ones are the hard-error values, which are
            // negative as an `i32` and unreadable in decimal - so both forms are written.
            log::warn(&format!(
                "a plugin process exited unexpectedly: plugin={} scope={} exit={}",
                key.plugin_id,
                key.scope,
                exit_code_text(code)
            ));
        }
        if let Some((key, epoch, delay)) = retry {
            self.schedule_retry(key, epoch, delay);
        }
        if emit {
            self.emit();
        }
    }

    /// Waits out the backoff, then starts the row again if the table still wants it.
    fn schedule_retry(self: &Arc<Self>, key: Key, epoch: u64, delay: Duration) {
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            let Some(me) = weak.upgrade() else {
                return;
            };
            {
                let inner = me.lock();
                let Some(entry) = inner.entries.get(&key) else {
                    return;
                };
                // The application is leaving, or this row was stopped, upgraded, disabled, given a
                // manifest that forbids restarts, or already restarted by hand: this scheduled retry
                // is stale and is dropped here (its release point).
                if inner.shutdown
                    || entry.epoch != epoch
                    || entry.state != ProcessState::Crashed
                    || entry.terminal
                    || !entry.install.enabled
                    || !entry.install.auto_restart
                {
                    return;
                }
            }
            if let Err(error) = me.start(&key) {
                log::info(&format!(
                    "a plugin process could not be restarted: plugin={} code={}",
                    key.plugin_id, error.code
                ));
            }
        });
    }
}

/// Stops one worker the graceful way, answering whether it said goodbye.
///
/// Always `worker_unload` first and a kill only after the answer failed to arrive inside the budget
/// (plan §6.4). The worker exits by itself once it has answered; the brief wait after the answer is
/// what lets a healthy stop end without a kill at all.
pub(super) fn stop_worker(worker: &Worker, key: &Key, unload: Duration) -> bool {
    let id = worker.next_id("u");
    let (sender, receiver): (SettlementSender, Receiver<Settlement>) = mpsc::sync_channel(1);
    lock(&worker.pending.calls).insert(id.clone(), sender);
    let sent = match frames::encode(&frames::Outbound::Unload { id: &id }) {
        Ok(line) => worker.link.send(&line),
        Err(_) => false,
    };
    let answered = sent && receiver.recv_timeout(unload).is_ok();
    // A worker that answered is given a moment to leave by itself (it exits 0 after the answer);
    // one that did not answer, or did not leave, is killed. The unload attempt always comes first.
    if !answered || wait_exit(&worker.link, EXIT_GRACE).is_none() {
        worker.link.kill();
    }
    audit::process_stop(&key.plugin_id, &key.scope);
    log::info(&format!(
        "a plugin process stopped: plugin={} scope={} graceful={answered}",
        key.plugin_id, key.scope
    ));
    answered
}

/// Whether a process that was live for `alive` has earned its crash budget back.
///
/// The one rule the reset turns on, pulled out so it can be exercised without waiting a minute: a
/// process that never became live (`None`) never earned anything, and the threshold is the whole
/// question.
pub(super) fn survived(alive: Option<Duration>) -> bool {
    alive.is_some_and(|alive| alive >= SURVIVAL_RESET)
}

/// One process's exit code as a crash line writes it.
///
/// A Windows hard error arrives as a negative `i32` whose decimal form means nothing to a reader
/// (`-1073741819`); the same bits unsigned and in hex are what the platform's own tools print
/// (`0xC0000005`), so both are written. A signal death on the other platforms is `None`, which is
/// its own fact - "there was no code" is not "the code was zero".
pub(super) fn exit_code_text(code: Option<i32>) -> String {
    match code {
        Some(code) if code < 0 => format!("{code} (0x{:08X})", code as u32),
        Some(code) => code.to_string(),
        None => "no exit code".to_owned(),
    }
}

/// Polls for the child's exit for at most `limit`.
pub(super) fn wait_exit(link: &Arc<dyn WorkerLink>, limit: Duration) -> Option<i32> {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(code) = link.try_wait() {
            return Some(code);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

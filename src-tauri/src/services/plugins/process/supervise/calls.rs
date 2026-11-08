//! The call surface of the supervisor: the four commands the rest of the application
//! reaches a resident process through, and the one blocking call path they share.

use super::lifecycle::stop_worker;
use super::*;

impl PluginProcess {
    // ---- the calls the commands and the next stage make ----

    /// Runs one contributed command through its installation's process, waking it if needed.
    ///
    /// The command id has to be one the manifest contributes or one the plugin registered at run
    /// time - otherwise nothing is started for it, which is also what keeps an arbitrary id from
    /// waking a process. A process that ended in a way a retry cannot fix is refused with the code
    /// that names why (`PLUGIN_PROCESS_CRASHED` / `PLUGIN_PROCESS_PROTOCOL_MISMATCH`), never
    /// restarted silently.
    pub(crate) fn run_command(
        self: &Arc<Self>,
        plugin_id: &str,
        scope: &str,
        command_id: &str,
    ) -> IpcResult<Settlement> {
        let key = self.key_for_plugin(plugin_id, scope)?;
        {
            let mut inner = self.lock();
            let Some(entry) = inner.entries.get_mut(&key) else {
                return Err(unavailable());
            };
            let declared = entry
                .install
                .commands
                .iter()
                .any(|command| command.id == command_id);
            let registered = lock(&entry.commands).contains(command_id);
            if !declared && !registered {
                return Ok(Settlement::refused(
                    "not_found",
                    "The manifest does not contribute that command.",
                ));
            }
            if entry.state == ProcessState::Crashed && entry.terminal {
                return Err(entry.crashed_refusal());
            }
            entry.activation = format!("{ACTIVATION_COMMAND_PREFIX}{command_id}");
        }
        let params = serde_json::json!({ "commandId": command_id });
        let settlement = self.call_blocking(&key, "command.execute", &params)?;
        audit::command_run(plugin_id, scope);
        Ok(settlement)
    }

    /// One `renderer.call` from a slot component (plan §6.2, T3's half of the channel).
    ///
    /// It resolves lazily exactly as a command does - a slot may be drawn before the process was
    /// ever woken - and answers the worker's own settlement. The activation event is `onStartup`
    /// because a renderer call names a method rather than one of the closed activation events; the
    /// document that made it was loaded by the shell, which is what "the process is needed now"
    /// means here.
    ///
    /// The method is judged here, against the declaration the descriptor was published from
    /// (`renderer_call_methods`), and before anything is started: a word that is not a method name is
    /// `PLUGIN_ACTION_UNKNOWN`, one that was never whitelisted is `PLUGIN_ACTION_UNDECLARED`, and
    /// neither wakes a process. A refused or absent process is `PLUGIN_PROCESS_UNAVAILABLE` /
    /// `PLUGIN_PROCESS_CRASHED`, the same answers a command gets.
    pub(crate) fn call_renderer(
        self: &Arc<Self>,
        plugin_id: &str,
        scope: &str,
        method: &str,
        params: Value,
    ) -> Settlement {
        let key = match self.key_for_plugin(plugin_id, scope) {
            Ok(key) => key,
            Err(error) => return Settlement::refused(error.code.to_string(), error.message),
        };
        {
            let mut inner = self.lock();
            let Some(entry) = inner.entries.get_mut(&key) else {
                return Settlement::refused(
                    PLUGIN_PROCESS_UNAVAILABLE,
                    "This plugin has no resident process to call.",
                );
            };
            if entry.state == ProcessState::Crashed && entry.terminal {
                let error = entry.crashed_refusal();
                return Settlement::refused(error.code.to_string(), error.message);
            }
            if let Some(code) =
                renderer::method_refusal(&entry.install.renderer_call_methods, method)
            {
                return Settlement::refused(
                    code,
                    "This method is not one the plugin's renderer declared.",
                );
            }
            entry.activation = ACTIVATION_STARTUP.to_owned();
        }
        match self.call_blocking(
            &key,
            "renderer.call",
            &serde_json::json!({ "method": method, "params": params }),
        ) {
            Ok(settlement) => settlement,
            // A renderer slot has no error channel of its own: a process this side could not reach
            // is stated as a refusal in the same vocabulary a command's caller sees as an
            // `IpcError`, so the component reads one `code` either way.
            Err(error) => Settlement::refused(error.code.to_string(), error.message),
        }
    }

    /// Stops one installation's process, if it has one, and waits for the child to be gone.
    ///
    /// This is the write flows' half of the lifecycle: an uninstall, an upgrade or a source switch
    /// replaces the installation's directory, and a running worker holds it - its `cwd` is that
    /// directory, and on Windows the engine's own `rm` answers `EBUSY` while the child exists
    /// (2026-10-27: a source switch failed that way and left the plugin uninstalled). Stopping here
    /// is one graceful `worker_unload` plus the kill grace, exactly like `sync`'s stop of an
    /// installation that disappeared - but the caller does not have to wait for the next list read
    /// to get it. Nothing is an error about "no such process": stopping what is not running is what
    /// the caller wants too.
    pub(crate) fn stop_installation(
        self: &Arc<Self>,
        plugin_id: &str,
        scope: &str,
    ) -> IpcResult<()> {
        let taken = {
            let mut inner = self.lock();
            let Some((key, entry)) = inner.entries.iter_mut().find(|(_, entry)| {
                entry.install.plugin_id == plugin_id && entry.install.scope == scope
            }) else {
                // Nothing published under that identity: there is no child to stop, and asking to
                // stop what is not running is not a failure.
                return Ok(());
            };
            entry.epoch += 1;
            entry.state = ProcessState::Stopped;
            entry.pid = None;
            entry.reason = None;
            entry.take_worker().map(|worker| (worker, key.clone()))
        };
        if let Some((worker, key)) = taken {
            // The installation stops, so what its capabilities held goes with it
            // (`supervise::capabilities`): its bus subscriptions now, its sockets through the host.
            self.release_capabilities(&key);
            stop_worker(&worker, &key, self.timeouts.unload);
            self.emit();
        }
        Ok(())
    }

    /// Stops one installation's process and starts it again, resetting the crash budget.
    ///
    /// The only way out of `crashed` (plan §6.4): nothing retries past the limit and nothing disables
    /// the plugin, so this is the reader's explicit decision. The answer is the table as it stands
    /// after the attempt, whether the start succeeded or not - the row's reason says what happened.
    pub(crate) fn restart(
        self: &Arc<Self>,
        plugin_id: &str,
        scope: &str,
    ) -> IpcResult<PluginProcessesView> {
        let key = self.key_for_plugin(plugin_id, scope)?;
        let stopped = {
            let mut inner = self.lock();
            let Some(entry) = inner.entries.get_mut(&key) else {
                return Err(unavailable());
            };
            if !entry.install.enabled {
                return Err(unavailable());
            }
            entry.epoch += 1;
            entry.restarts = 0;
            entry.terminal = false;
            entry.reason = None;
            entry.activation = ACTIVATION_STARTUP.to_owned();
            entry.state = ProcessState::Stopped;
            entry.pid = None;
            entry.take_worker()
        };
        // Outside the lock: an unload waits on the worker, and the table must stay readable while
        // that happens.
        if let Some(worker) = stopped {
            self.release_capabilities(&key);
            stop_worker(&worker, &key, self.timeouts.unload);
        }
        if let Err(error) = self.start(&key) {
            log::info(&format!(
                "a plugin process could not be restarted: plugin={plugin_id} code={}",
                error.code
            ));
        }
        Ok(self.snapshot())
    }

    /// Wakes one installation for an activation event its manifest declares, and answers the table.
    ///
    /// This is the second half of `activationEvents` (plan §6.1): `onStartup` is read from a plugin
    /// list, `onCommand:<id>` from a command execution, and `onView:<entryId>` from the page that
    /// became visible - a page the shell drew knows it is visible, which is a fact only the frontend
    /// has, so it names the event and this side checks it against the declaration the row was
    /// published from. An event the package did not declare is `INVALID_INPUT` naming the event:
    /// acting on it would let a caller wake every resident plugin by asking, which is not what the
    /// manifest agreed to.
    ///
    /// A live process is kept: the same event is a no-op, and a *different* event after `running` is
    /// advisory text only - the load frame was answered under the event that woke it, and stopping
    /// the child to change a string would throw away the plugin's state for no gain. The next manual
    /// restart carries `onStartup` again, and the next command carries its own event. Only a stopped
    /// row is started, under the event it was woken by.
    ///
    /// A terminal `crashed` row is refused with the code that names why, exactly as a command is:
    /// the crash budget is the user's manual restart to overrule, not a page's activation.
    pub(crate) fn activate(
        self: &Arc<Self>,
        plugin_id: &str,
        scope: &str,
        event: &str,
    ) -> IpcResult<PluginProcessesView> {
        let key = self.key_for_plugin(plugin_id, scope)?;
        let live = {
            let mut inner = self.lock();
            let Some(entry) = inner.entries.get_mut(&key) else {
                return Err(unavailable());
            };
            if !entry.install.declares(event) {
                return Err(IpcError::from_message(
                    INVALID_INPUT,
                    format!("The plugin does not declare the activation event `{event}`."),
                ));
            }
            if entry.state == ProcessState::Crashed && entry.terminal {
                return Err(entry.crashed_refusal());
            }
            if entry.state.is_live() {
                // Advisory only: the running child is not restarted for a string (`sync` may have
                // changed nothing, and its loaded state is the plugin's).
                if entry.activation != event {
                    log::info(&format!(
                        "a plugin process is already running under another activation event: \
                         plugin={plugin_id} running={} asked={event}",
                        entry.activation
                    ));
                }
                entry.last_used = Instant::now();
                true
            } else {
                entry.activation = event.to_owned();
                false
            }
        };
        if !live {
            // A start that fails is a row state (`crashed` with its reason, or `stopped` for a
            // disabled installation), not a transport failure: the answer is the table, exactly as
            // a manual restart answers it.
            if let Err(error) = self.start(&key) {
                log::info(&format!(
                    "a plugin process could not be activated: plugin={plugin_id} event={event} \
                     code={}",
                    error.code
                ));
            }
        }
        Ok(self.snapshot())
    }

    /// Ends every child, for the application's exit path (`lib.rs`'s `RunEvent::Exit`).
    ///
    /// Each child is asked to unload and then killed if it does not leave, in parallel, and the whole
    /// stop is bounded by [`UNLOAD_TIMEOUT`] plus a moment - the exit path is not held up by a
    /// worker that is already broken. After this no start is scheduled or honoured.
    pub(crate) fn shutdown_all(self: &Arc<Self>) {
        let workers: Vec<(Worker, Key)> = {
            let mut inner = self.lock();
            inner.shutdown = true;
            let mut workers = Vec::new();
            for (key, entry) in inner.entries.iter_mut() {
                entry.epoch += 1;
                entry.state = ProcessState::Stopped;
                entry.pid = None;
                if let Some(worker) = entry.take_worker() {
                    workers.push((worker, key.clone()));
                }
            }
            workers
        };
        if workers.is_empty() {
            return;
        }
        let (done, finished): (mpsc::Sender<()>, Receiver<()>) = mpsc::channel();
        let mut threads = Vec::with_capacity(workers.len());
        for (worker, key) in workers {
            let done = done.clone();
            let unload = self.timeouts.unload;
            let releases = Arc::clone(self);
            threads.push(std::thread::spawn(move || {
                releases.release_capabilities(&key);
                stop_worker(&worker, &key, unload);
                let _ = done.send(());
            }));
        }
        drop(done);
        let deadline = Instant::now() + self.timeouts.unload + EXIT_GRACE;
        for _ in 0..threads.len() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if finished.recv_timeout(remaining).is_err() {
                break;
            }
        }
        self.emit();
    }

    // ---- the call path ----

    /// One call: wake the process if needed, write the frame, wait for its answer inside the budget.
    ///
    /// A refusal to *reach* the worker - no row, a disabled installation, a start that failed
    /// (crash, protocol mismatch, handshake timeout) - is an `Err`: it is this side's verdict about
    /// the process, not the plugin's answer about the call. Everything after the frame is written is
    /// a settlement, including the budgets running out.
    fn call_blocking(
        self: &Arc<Self>,
        key: &Key,
        method: &str,
        params: &Value,
    ) -> IpcResult<Settlement> {
        self.start(key)?;
        let worker = {
            let mut inner = self.lock();
            let Some(entry) = inner.entries.get_mut(key) else {
                return Err(unavailable());
            };
            entry.last_used = Instant::now();
            let Some(worker) = entry.worker.as_ref() else {
                return Ok(Settlement::refused(
                    PLUGIN_PROCESS_CRASHED,
                    "The plugin process is not running.",
                ));
            };
            Worker {
                generation: worker.generation,
                link: Arc::clone(&worker.link),
                pending: Arc::clone(&worker.pending),
            }
        };
        let id = worker.next_id("h");
        let (sender, receiver): (SettlementSender, Receiver<Settlement>) = mpsc::sync_channel(1);
        {
            let mut calls = lock(&worker.pending.calls);
            if calls.len() >= MAX_PENDING_CALLS {
                return Ok(Settlement::refused(
                    "too_many_requests",
                    "This plugin has as many calls in flight as this build allows.",
                ));
            }
            calls.insert(id.clone(), sender);
        }
        let frame = match frames::encode(&frames::Outbound::Call {
            id: &id,
            method,
            params,
        }) {
            Ok(line) => line,
            Err(_) => {
                lock(&worker.pending.calls).remove(&id);
                return Ok(Settlement::refused(
                    "too_large",
                    "The call is larger than the plugin worker frame ceiling.",
                ));
            }
        };
        if !worker.link.send(&frame) {
            lock(&worker.pending.calls).remove(&id);
            return Ok(Settlement::refused(
                PLUGIN_PROCESS_CRASHED,
                "The plugin process is gone.",
            ));
        }
        let wait = {
            let question = question_key(key);
            let question_open = || {
                self.prompts
                    .as_ref()
                    .is_some_and(|prompts| prompts.has_open(&question))
            };
            await_settlement(&receiver, self.timeouts.call, &question_open)
        };
        Ok(match wait {
            CallWait::Answered(settlement) => settlement,
            CallWait::Gone => {
                // The worker ended while the call was in flight: its exit handler writes the row and
                // schedules whatever retry the budget allows, so only the caller is answered here.
                lock(&worker.pending.calls).remove(&id);
                Settlement::refused(PLUGIN_PROCESS_CRASHED, "The plugin process ended.")
            }
            CallWait::Expired => {
                lock(&worker.pending.calls).remove(&id);
                // The process stopped answering: it is stopped rather than waited on, and the row
                // says which budget ran out (plan §6.4). No retry: a hung plugin is the reader's to
                // restart, exactly like a crash past the budget.
                self.terminate(key, worker.generation, REASON_TIMEOUT);
                Settlement::refused("timeout", "The plugin did not answer in time.")
            }
        })
    }
}

/// How one call's wait ended.
pub(crate) enum CallWait {
    /// The worker answered.
    Answered(Settlement),
    /// The worker's channel closed: the process ended while the call was in flight.
    Gone,
    /// The budget ran out with no answer and no open question.
    Expired,
}

/// The longest single slice a call wait blocks for.
///
/// The wait is sliced because two clocks are involved: the call's own budget (the plugin's time) and
/// a question the user is looking at (their time). A slice short enough to notice a question that
/// opened mid-wait keeps the second from being charged to the first.
const CALL_WAIT_SLICE: Duration = Duration::from_millis(250);

/// Waits for one call's settlement, spending the budget only while no question is open.
///
/// The deadline is the plugin's: a worker that stops answering is stopped. A worker parked on a
/// consent card is doing nothing wrong - it is waiting for a person - so the budget restarts while
/// `question_open()` answers true. That wait is itself bounded: the question expires on
/// `PROMPT_TIMEOUT` and is then denied, which lets the worker answer and this loop end.
pub(crate) fn await_settlement(
    receiver: &Receiver<Settlement>,
    budget: Duration,
    question_open: &dyn Fn() -> bool,
) -> CallWait {
    let mut remaining = budget;
    loop {
        let slice = remaining.min(CALL_WAIT_SLICE);
        let started = Instant::now();
        match receiver.recv_timeout(slice) {
            Ok(settlement) => return CallWait::Answered(settlement),
            Err(mpsc::RecvTimeoutError::Disconnected) => return CallWait::Gone,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if question_open() {
                    remaining = budget;
                    continue;
                }
                remaining = remaining.saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    return CallWait::Expired;
                }
            }
        }
    }
}

/// The key a question about one installation is filed under (`protocol::ask_user`), so the wait can
/// see whether this call is parked on one.
fn question_key(key: &Key) -> String {
    crate::services::plugins::pages::origin_key(&key.plugin_id, &key.scope)
}

//! The public surface of [`HostRuntime`]: the command path, the handshake, and the lifecycle.
//!
//! `super` holds the state these methods act on; this file holds the ways it changes - sending a
//! command and waiting for its `id`, starting the process and getting through the handshake within
//! its deadlines, ending it (gracefully, abruptly, or because the application is quitting), coming
//! back from a crash, and rebuilding the conversations that crash interrupted.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::errors::{
    IpcError, IpcResult, ENGINE_REQUEST_FAILED, ENGINE_SPAWN_FAILED, ENV_PIN_FAILED, HOST_EXITED,
    INVALID_INPUT, PROTOCOL_MISMATCH, TIMEOUT,
};
use crate::models::agent::{EngineExitReason, EngineModel, ModelRoleRow, RuntimeEvent};
use crate::services::host_bin;
use crate::services::log;

use super::super::owner;
use super::super::protocol::FrameLimits;
use super::super::{
    emit_runtime, EngineLog, COMMIT_MESSAGE_TIMEOUT_MS, CONNECT_TIMEOUT_MS, HELLO_TIMEOUT_MS,
    MAX_PENDING_FRAMES, MODELS_TIMEOUT_MS, PROTOCOL_VERSION, READY_TIMEOUT_MS,
};
use super::{
    degraded, emit_session_failure, encode_frame, host_busy, lock, not_running, parse_models,
    parse_role_candidates, parse_roles, process, protocol, response_data, session, HostRuntime,
    HostShared, HostState, HostStatus, Inbound, InboundBudget, Pending, SessionRuntime,
    SessionSnapshot, MAX_IN_FLIGHT_COMMANDS, UNAWAITED_MAX,
};

impl HostRuntime {
    /// Makes sure one host is running and past its handshake. Idempotent.
    ///
    /// This is the *implicit* start path - a warm-up, a conversation being opened, the model
    /// catalogue being read - and it refuses to start a host that is `Degraded`. Three failed
    /// restarts in a row, or an artifact that failed verification, are not things a side effect of
    /// reading a page can fix: reviving that host is an explicit `runtime_restart`, which goes
    /// through [`Self::start`] instead. The refusal is a structured error rather than a silent
    /// success, so the caller can tell the user what to do instead of leaving the page blank.
    ///
    /// The same refusal covers `no_retry`, which is set on the failures that are permanent by
    /// nature - a `host_fatal` frame, an artifact that disagreed with the environment, a protocol
    /// the host refused. Without it, every page action would locate and hash the artifact again and
    /// spawn a process that cannot possibly work; the latch is what keeps that from repeating until
    /// the user asks for a restart.
    pub(crate) async fn ensure_running(&self) -> IpcResult<()> {
        if self.is_ready() {
            return Ok(());
        }
        {
            let state = lock(&self.inner.state);
            if state.no_retry || state.status == HostStatus::Degraded {
                return Err(degraded());
            }
        }
        self.start().await
    }

    /// Starts a host process and drives it through the handshake.
    ///
    /// The artifact is located and hashed before every spawn - on a cold application, and after
    /// any crash - because a replaced or removed binary has to be refused rather than started.
    /// Unlike [`Self::ensure_running`] this path ignores the degraded state: it is what the user's
    /// restart and the automatic restart series use to come back.
    pub(crate) async fn start(&self) -> IpcResult<()> {
        if self.is_ready() {
            return Ok(());
        }
        let _guard = self.inner.spawn_lock.lock().await;
        if self.is_ready() {
            return Ok(());
        }
        self.clear_corpse();
        let paths = self.inner.paths.clone();
        let artifact = tauri::async_runtime::spawn_blocking(host_bin::locate)
            .await
            .map_err(|_| {
                IpcError::new(ENGINE_SPAWN_FAILED, "The host artifact check task failed.")
            })??;
        let custom_env = lock(&self.inner.custom_env).clone();
        let spawn_paths = paths.clone();
        let child = tauri::async_runtime::spawn_blocking(move || {
            process::spawn(&spawn_paths, &artifact, &custom_env)
        })
        .await
        .map_err(|_| IpcError::new(ENGINE_SPAWN_FAILED, "The host start task failed."))?
        .inspect_err(|error| {
            // The core process of this application could not be started at all: the card the user
            // sees says so, and this is the copy a report is read from - an artifact that does not
            // verify and a machine that refuses to execute it look identical on screen.
            log::error(&format!(
                "omp: the engine host could not be started ({}): {}",
                error.code, error.message
            ));
        })?;
        let generation = {
            let mut state = lock(&self.inner.state);
            state.generation += 1;
            state.generation
        };
        // Written before the handshake, so a run that dies during it still leaves a pid the next
        // start can judge: this is the host that is now running under this data root
        // (`services::runtime::owner`).
        owner::record(&paths, child.pid);
        let shared = {
            let mut state = lock(&self.inner.state);
            state.shared = Arc::new(HostShared {
                limits: Mutex::new(FrameLimits::default()),
                log: Arc::new(EngineLog::new(&paths.logs, process::LOG_KEY)),
                stderr_tail: Mutex::new(None),
                last_frame_ms: AtomicU64::new(0),
            });
            state.shared.clone()
        };
        // Bounded in both directions, and by construction: `pending` refuses a command above
        // `MAX_IN_FLIGHT_COMMANDS`, so at most that many frames can be waiting here at once, plus
        // the handful of un-awaited shutdown acknowledgements (`UNAWAITED_MAX`). A `try_send` in
        // `call_inner` is therefore a check that cannot fail on a full queue, and one that must
        // never block - it would block while holding the state lock the dispatcher needs.
        let (stdin_sender, stdin_receiver) =
            std::sync::mpsc::sync_channel::<Vec<u8>>(MAX_IN_FLIGHT_COMMANDS + UNAWAITED_MAX);
        // Bounded: the reader thread stops reading when the dispatcher falls behind, which is how
        // the host's own write is made to wait instead of this process buffering without limit.
        let (inbound_sender, inbound_receiver) =
            tokio::sync::mpsc::channel::<Inbound>(MAX_PENDING_FRAMES);
        // And bounded by bytes on top of that: a count of frames is not a memory ceiling, because
        // one frame may be a reassembled payload of tens of megabytes (`MAX_PENDING_BYTES`).
        let inbound_budget = Arc::new(InboundBudget::new());
        let child_handle = Arc::new(Mutex::new(child.child));
        {
            let mut state = lock(&self.inner.state);
            state.status = HostStatus::Starting;
            state.child = Some(child_handle.clone());
            state.stdin = Some(stdin_sender);
            state.pid = child.pid;
            state.hello = None;
            state.ready = None;
            state.fatal = None;
            state.intent = None;
            state.exit_reported = false;
            state.started_at_ms = crate::services::store::now_ms().max(1) as u64;
            state.ready_since_ms = 0;
        }
        if let Err(error) = process::start_worker_threads(
            stdin_receiver,
            child.stdin,
            child.stdout,
            child.stderr,
            shared,
            inbound_sender,
            Arc::clone(&inbound_budget),
        ) {
            process::kill_tree(&child_handle, child.pid);
            self.fail_startup(generation, error.clone());
            return Err(error);
        }
        let dispatcher = self.clone();
        tauri::async_runtime::spawn(async move {
            protocol::run(dispatcher, generation, inbound_receiver, inbound_budget).await;
        });
        self.await_hello(generation, HELLO_TIMEOUT_MS).await?;
        // The host holds the handshake open until it hears which protocol this side speaks.
        let response = self
            .call(
                json!({"type": "hello_ok", "protocol": PROTOCOL_VERSION}),
                HELLO_TIMEOUT_MS,
            )
            .await?;
        if let Err(error) = response_data(&response) {
            let error = self.interpret_handshake_failure(generation, error);
            self.fail_startup(generation, error.clone());
            return Err(error);
        }
        self.await_ready(generation, READY_TIMEOUT_MS).await?;
        // A host that is alive but wedged answers nothing, so every later command just times out
        // and the user watches a spinner that never ends. The watcher asks the process itself, on
        // its own schedule, whether it is still answering - and takes the ordinary crash path if it
        // has stopped (see `watch_liveness`).
        let host = self.clone();
        tauri::async_runtime::spawn(async move { host.watch_liveness(generation).await });
        // And the ceiling: the runtime offers no heap limit the host would honour, so its resident
        // size is sampled instead and a host that stays over it is rebuilt through the same crash
        // path (`lifecycle::watch_memory`).
        let guarded = self.clone();
        tauri::async_runtime::spawn(async move { guarded.watch_memory(generation).await });
        Ok(())
    }

    /// Restarts the host: a graceful shutdown, a fresh process, and the sessions rebuilt from
    /// their files.
    ///
    /// Running turns are not replayed - the host is a new process and the SDK offers no way to
    /// resume one - so the affected sessions come back marked `interrupted` (contract §3.2).
    pub(crate) async fn restart(&self) -> IpcResult<()> {
        let queue = self.snapshot_for_restore();
        self.shutdown_with(EngineExitReason::Restart).await;
        // Explicit, so it is allowed to revive a host the implicit path refuses to touch.
        self.start().await?;
        self.restore_sessions(queue).await;
        Ok(())
    }

    /// Host-level command: a response resolved by `id`.
    pub(crate) async fn call(&self, command: Value, timeout_ms: u64) -> IpcResult<Value> {
        self.call_inner(command, timeout_ms, false).await
    }

    /// Host-level command whose response is unwrapped into its `data` payload.
    pub(crate) async fn call_ok(&self, command: Value, timeout_ms: u64) -> IpcResult<Value> {
        response_data(&self.call(command, timeout_ms).await?)
    }

    /// Session-level command: `sessionId` is injected, so no caller can address the wrong
    /// conversation by omission.
    pub(crate) async fn call_session(
        &self,
        session_id: &str,
        command: Value,
        timeout_ms: u64,
    ) -> IpcResult<Value> {
        let mut object = match command {
            Value::Object(map) => map,
            _ => {
                return Err(IpcError::new(
                    INVALID_INPUT,
                    "Only object commands can be sent to the host.",
                ))
            }
        };
        object.insert("sessionId".to_owned(), json!(session_id));
        self.call_inner(Value::Object(object), timeout_ms, false)
            .await
    }

    pub(crate) async fn call_session_ok(
        &self,
        session_id: &str,
        command: Value,
        timeout_ms: u64,
    ) -> IpcResult<Value> {
        match self.call_session(session_id, command, timeout_ms).await {
            Ok(response) => response_data(&response),
            Err(error) => {
                // The host no longer holds this conversation - it was evicted, or it never came
                // back after a restart. Keeping the registration would make every later command
                // address a session that cannot answer.
                if error.code == crate::errors::SESSION_NOT_FOUND {
                    self.remove_session(session_id);
                }
                Err(error)
            }
        }
    }

    /// Sends a prompt, whose id stays reserved for a late failure with the same id.
    pub(crate) async fn call_prompt_session(
        &self,
        session_id: &str,
        command: Value,
        timeout_ms: u64,
    ) -> IpcResult<Value> {
        let mut object = match command {
            Value::Object(map) => map,
            _ => {
                return Err(IpcError::new(
                    INVALID_INPUT,
                    "Only object commands can be sent to the host.",
                ))
            }
        };
        object.insert("sessionId".to_owned(), json!(session_id));
        self.call_inner(Value::Object(object), timeout_ms, true)
            .await
    }

    /// The model catalogue the host currently holds, re-hydrated on request.
    ///
    /// A host that is not running yet is started here: the models page is the one place that needs
    /// a catalogue with no conversation open, and that is an explicit user action. A *degraded*
    /// host is not started - see [`Self::ensure_running`] - and the error it reports is returned
    /// as it is.
    pub(crate) async fn models(&self, refresh: bool) -> IpcResult<Vec<EngineModel>> {
        self.ensure_running().await?;
        self.catalogue(refresh).await
    }

    /// The catalogue of a host that is *already* serving, or `None` while none is.
    ///
    /// For a caller that must not start a process of its own: the readiness check and the read are
    /// one operation, so a host that dies in between cannot be revived by a read that only wanted
    /// to know what it currently offers. An error is reported as no catalogue rather than raised -
    /// the caller has a table to render either way.
    pub(crate) async fn models_if_ready(&self, refresh: bool) -> Option<Vec<EngineModel>> {
        if !self.is_ready() {
            return None;
        }
        self.catalogue(refresh).await.ok()
    }

    /// One commit message, drafted by the engine from the staged tree of `cwd`.
    ///
    /// A model call, and a blocking one: the engine reads `git diff --cached`, asks the model its
    /// own settings pick, and answers with a conventional message. A host that is not running is
    /// started here - the reader pressed a button in a panel they are looking at - and an engine
    /// refusal (nothing staged, no usable model) travels back as the host's own words.
    pub(crate) async fn commit_message(&self, cwd: &str) -> IpcResult<String> {
        self.ensure_running().await?;
        let data = self
            .call_ok(
                json!({"type": "commit_message", "cwd": cwd}),
                COMMIT_MESSAGE_TIMEOUT_MS,
            )
            .await?;
        Ok(data
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_owned())
    }

    /// One catalog read against the running host.
    async fn catalogue(&self, refresh: bool) -> IpcResult<Vec<EngineModel>> {
        let data = if refresh {
            self.call_ok(json!({"type": "models_reload"}), MODELS_TIMEOUT_MS)
                .await?
        } else {
            self.call_ok(json!({"type": "session_config"}), MODELS_TIMEOUT_MS)
                .await?
        };
        Ok(parse_models(&data))
    }

    /// The engine's role table: the model each role resolves to, and which of them this machine
    /// configured.
    ///
    /// A host that is not running yet is started here, exactly as for [`Self::models`]: the
    /// settings page is where roles are read and changed, and it only gets opened by an explicit
    /// user action. A *degraded* host is still not started - see [`Self::ensure_running`] - and the
    /// error it reports is returned as it is.
    pub(crate) async fn model_roles(&self) -> IpcResult<Vec<ModelRoleRow>> {
        self.ensure_running().await?;
        let command = json!({"type": "model_roles"});
        let data = self.call_ok(command, MODELS_TIMEOUT_MS).await?;
        Ok(parse_roles(&data))
    }

    /// The models one role may be assigned, in the engine's own order, and whether that pool was
    /// longer than the host's ceiling on it.
    pub(crate) async fn role_candidates(&self, role: &str) -> IpcResult<(Vec<EngineModel>, bool)> {
        let role = validate_role(role)?;
        self.ensure_running().await?;
        let command = json!({"type": "model_role_candidates", "role": role});
        let data = self.call_ok(command, MODELS_TIMEOUT_MS).await?;
        Ok(parse_role_candidates(&data))
    }

    /// Assigns a model to one role, or clears the assignment (`None`) so the engine picks for that
    /// role again.
    ///
    /// The answer is the table as it stands *after* the write, which is what the caller has to
    /// render: assigning changes the row's selector and the model behind it, and reading the table
    /// back to see that would be a second round trip that could also disagree with what was just
    /// written.
    ///
    /// The write lands in the engine's own global config file (`<agentDir>/config.yml`, the file the
    /// plan calls `settings.yml`) and never in a session file, which is why it is not one of the
    /// management commands §5.3 serializes against live turns: a turn that is already running keeps
    /// running, and only a later role lookup sees the new assignment.
    pub(crate) async fn set_model_role(
        &self,
        role: &str,
        selector: Option<&str>,
    ) -> IpcResult<Vec<ModelRoleRow>> {
        let role = validate_role(role)?;
        let selector = match selector {
            Some(selector) => validate_selector(selector)?,
            None => None,
        };
        self.ensure_running().await?;
        let command = json!({"type": "model_role_set", "role": role, "selector": selector});
        let data = self.call_ok(command, MODELS_TIMEOUT_MS).await?;
        Ok(parse_roles(&data))
    }

    /// Pushes one provider key into the *running* host, answering whether it now resolves it.
    ///
    /// The key is already in the OS credential store when this runs, so this path deliberately does
    /// **not** start a host: a spawn reads the keyring itself, and the only state a fresh process
    /// would need is one it already builds. The engine keeps the pushed key as an in-memory runtime
    /// override - never persisted, never written to `models.yml`, and ranked above the config key
    /// that file names - which is what makes a key saved after the host started take effect without
    /// a restart. A host that is not running, or one that dies between the readiness check and the
    /// frame, is reported as "not live" rather than raised: the stored key is what the next spawn
    /// uses, and the caller's answer has to distinguish those two states instead of failing a write
    /// that already landed.
    pub(crate) async fn provider_key_set(&self, provider_id: &str, api_key: &str) -> bool {
        let answer = self
            .push_provider_key(
                json!({"type": "provider_key_set", "providerId": provider_id, "apiKey": api_key}),
                provider_id,
            )
            .await;
        answer.is_some_and(|data| data.get("source").and_then(Value::as_str) == Some("runtime"))
    }

    /// Hands the running host a whole rotation pool, answering whether it now resolves one of them.
    ///
    /// The keys are already in the OS credential store when this runs, and the host installs them
    /// as in-memory credentials - never persisted to `models.yml` or the engine's database. The
    /// host answers with the auth source it resolves; `api_key` is the pool, `env` is the single
    /// key it also put back in the provider's variable.
    pub(crate) async fn provider_keys_set(&self, provider_id: &str, api_keys: &[String]) -> bool {
        let answer = self
            .push_provider_key(
                json!({
                    "type": "provider_keys_set",
                    "providerId": provider_id,
                    "apiKeys": api_keys,
                }),
                provider_id,
            )
            .await;
        // The host states whether the pool is installed; the source kind is only a fallback for an
        // older answer. A provider whose OAuth login outranks the pool still reports `live`, because
        // the rows are in place and the page's "after a restart" wording would be untrue.
        answer.is_some_and(|data| {
            data.get("live").and_then(Value::as_bool) == Some(true)
                || matches!(
                    data.get("source").and_then(Value::as_str),
                    Some("api_key") | Some("env") | Some("runtime") | Some("config")
                )
        })
    }

    /// Drops the running host's in-memory key for one provider, answering whether it is gone.
    ///
    /// "Gone" is any answer that no longer resolves the runtime override - including no source at
    /// all, which is what clearing the provider's last credential answers with.
    pub(crate) async fn provider_key_clear(&self, provider_id: &str) -> bool {
        let answer = self
            .push_provider_key(
                json!({"type": "provider_key_clear", "providerId": provider_id}),
                provider_id,
            )
            .await;
        answer.is_some_and(|data| data.get("source").and_then(Value::as_str) != Some("runtime"))
    }

    /// The one frame path the two key commands share.
    ///
    /// `None` means no running host took it (none ready, or the frame failed); `Some(data)` is the
    /// engine's own answer, where the source may itself be absent once nothing authenticates the
    /// provider any more. Conflating the two would report a landed clear as "restart required".
    async fn push_provider_key(&self, command: Value, provider_id: &str) -> Option<Value> {
        if !self.is_ready() {
            return None;
        }
        match self.call_ok(command, MODELS_TIMEOUT_MS).await {
            Ok(data) => Some(data),
            Err(error) => {
                // The provider id is not a secret and the key never reaches this message.
                self.log(&format!(
                    "pushing the key for {provider_id} failed: {}",
                    error.message
                ));
                None
            }
        }
    }

    async fn call_inner(&self, command: Value, timeout_ms: u64, prompt: bool) -> IpcResult<Value> {
        let mut object = match command {
            Value::Object(map) => map,
            _ => {
                return Err(IpcError::new(
                    INVALID_INPUT,
                    "Only object commands can be sent to the host.",
                ))
            }
        };
        let id = format!(
            "h{}",
            self.inner.request_seq.fetch_add(1, Ordering::Relaxed)
        );
        // The command's own name, so a timeout says which request the host never answered: the id
        // alone is what the late response carries, and a reader has no way to turn one into the
        // other after the pending entry is gone.
        let method = object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        object.insert("id".to_owned(), json!(id));
        let session_id = object
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let (sender, receiver) = oneshot::channel();
        {
            let mut state = lock(&self.inner.state);
            if !state.can_call() {
                return Err(not_running());
            }
            // The ceiling is on what is already waiting: a command answers or times out, so this
            // process cannot queue commands faster than the host drains them without end.
            if state.pending.len() >= MAX_IN_FLIGHT_COMMANDS {
                return Err(host_busy());
            }
            let stdin = state.stdin.clone().ok_or_else(not_running)?;
            if prompt {
                if let Some(session_id) = session_id.as_ref() {
                    remember_prompt(&mut state, &id, session_id);
                }
            }
            state.pending.insert(
                id.clone(),
                Pending {
                    sender,
                    prompt,
                    session_id: session_id.clone(),
                },
            );
            // `try_send`, never `send`: this holds the state lock the dispatcher needs, so a
            // blocking send would wedge the whole runtime on a queue that is full. The queue is
            // sized for the ceiling above (plus the un-awaited acknowledgements), so `Full` cannot
            // be reached from here - it is answered as the same refusal rather than unwrapped,
            // because a queue that is full is exactly the condition the ceiling describes.
            if let Err(error) =
                encode_frame(&state.shared, &Value::Object(object)).and_then(|bytes| {
                    match stdin.try_send(bytes) {
                        Ok(()) => Ok(()),
                        Err(std::sync::mpsc::TrySendError::Full(_)) => Err(host_busy()),
                        Err(std::sync::mpsc::TrySendError::Disconnected(_)) => Err(not_running()),
                    }
                })
            {
                state.pending.remove(&id);
                state.prompt_late.remove(&id);
                return Err(error);
            }
        }
        match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), receiver).await {
            Err(_) => {
                lock(&self.inner.state).pending.remove(&id);
                log::warn(&format!(
                    "the engine host did not answer `{method}` ({id}) within {timeout_ms} ms"
                ));
                Err(IpcError::new(
                    TIMEOUT,
                    "The engine host did not answer in time.",
                ))
            }
            Ok(Err(_)) => Err(IpcError::new(
                HOST_EXITED,
                "The engine host is no longer running.",
            )),
            Ok(Ok(response)) => Ok(response),
        }
    }

    /// Waits briefly for the child so the log and the exit notice can carry a real code.
    pub(super) async fn exit_code(&self) -> Option<i32> {
        for _ in 0..40 {
            let child = lock(&self.inner.state).child.clone();
            let child = child?;
            if let Ok(Some(status)) = lock(&child).try_wait() {
                return status.code();
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        None
    }

    /// Releases everything that belonged to the current generation.
    fn clear_corpse(&self) {
        let child = {
            let mut state = lock(&self.inner.state);
            if state.child.is_none() && state.status == HostStatus::Stopped {
                return;
            }
            let child = state.child.take();
            state.stdin = None;
            state.status = HostStatus::Stopped;
            child
        };
        if let Some(child) = child {
            let pid = { lock(&self.inner.state).pid };
            if !process::try_reap(&child) {
                process::kill_tree(&child, pid);
            }
        }
    }

    async fn await_hello(&self, generation: u64, timeout_ms: u64) -> IpcResult<()> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            let waiter = self.inner.startup_notify.notified();
            {
                let state = lock(&self.inner.state);
                if state.generation != generation {
                    return Err(not_running());
                }
                if let Some(error) = state.fatal.clone() {
                    return Err(error);
                }
                if state.hello.is_some() {
                    return Ok(());
                }
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() || tokio::time::timeout(remaining, waiter).await.is_err() {
                let error = IpcError::new(TIMEOUT, "The engine host did not start in time.");
                self.fail_startup(generation, error.clone());
                return Err(error);
            }
        }
    }

    async fn await_ready(&self, generation: u64, timeout_ms: u64) -> IpcResult<()> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            let waiter = self.inner.startup_notify.notified();
            {
                let state = lock(&self.inner.state);
                if state.generation != generation {
                    return Err(not_running());
                }
                if let Some(error) = state.fatal.clone() {
                    return Err(error);
                }
                if let Some(result) = state.ready.as_ref() {
                    return result.clone();
                }
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() || tokio::time::timeout(remaining, waiter).await.is_err() {
                let error = IpcError::new(TIMEOUT, "The engine host did not become ready in time.");
                self.fail_startup(generation, error.clone());
                return Err(error);
            }
        }
    }

    /// A failed start is never retried automatically: the artifact is wrong, the environment
    /// disagrees, or the host refused the protocol, and none of those get better by trying again.
    fn fail_startup(&self, generation: u64, error: IpcError) {
        let reason = match error.code.as_ref() {
            ENV_PIN_FAILED | PROTOCOL_MISMATCH => EngineExitReason::StartupFailed,
            TIMEOUT => EngineExitReason::StartupTimeout,
            _ => EngineExitReason::StartupFailed,
        };
        let child = {
            let mut state = lock(&self.inner.state);
            if state.generation != generation {
                return;
            }
            state.no_retry = true;
            state.status = HostStatus::Stopped;
            state.ready = Some(Err(error.clone()));
            state.intent = Some(reason);
            state.stdin = None;
            state.child.take()
        };
        if let Some(child) = child {
            let pid = { lock(&self.inner.state).pid };
            if !process::try_reap(&child) {
                process::kill_tree(&child, pid);
            }
        }
        {
            let mut state = lock(&self.inner.state);
            state.pending.clear();
        }
        self.report_exit(reason);
        self.inner.startup_notify.notify_waiters();
    }

    /// Runs the handshake failure through the host's own code, so a refusal to start reads the
    /// same wherever it is reported.
    fn interpret_handshake_failure(&self, generation: u64, error: IpcError) -> IpcError {
        let code = match error.code.as_ref() {
            ENGINE_REQUEST_FAILED => PROTOCOL_MISMATCH,
            other => other,
        };
        {
            let mut state = lock(&self.inner.state);
            if state.generation == generation {
                state.no_retry = true;
            }
        }
        IpcError::from_engine(Some(code), error.message)
    }

    /// Reports the exit of the current host on `omp:runtime`, exactly once per generation.
    pub(super) fn report_exit(&self, reason: EngineExitReason) {
        let claim = {
            let mut state = lock(&self.inner.state);
            let claim = !state.exit_reported;
            state.exit_reported = true;
            claim
        };
        if claim {
            emit_runtime(
                &self.inner.app,
                RuntimeEvent::EngineExit {
                    workspace_id: None,
                    reason,
                },
            );
        }
    }

    fn snapshot_for_restore(&self) -> Vec<SessionSnapshot> {
        lock(&self.inner.state)
            .sessions
            .all()
            .iter()
            .map(|session| SessionSnapshot {
                id: session.id.clone(),
                file: session.file(),
                cwd: session.cwd().to_owned(),
                workspace_id: session.workspace_id(),
                streaming: session.is_streaming(),
            })
            .collect()
    }

    /// Reopens the conversations a restart interrupted, from their session files.
    ///
    /// Nothing is replayed: the SDK has no way to resume a turn in a new process, so the sessions
    /// come back with `interrupted` set and the UI is told about the loss instead of discovering
    /// a silent gap.
    pub(super) async fn restore_sessions(&self, queue: Vec<SessionSnapshot>) {
        for snapshot in queue {
            let Some(file) = snapshot.file.clone() else {
                // A conversation that never wrote a file has nothing to rebuild from.
                emit_session_failure(
                    &self.inner.app,
                    &snapshot.id,
                    "The session could not be restored after the engine restarted.",
                );
                continue;
            };
            let command = json!({
                "type": "session_open",
                "sessionFile": file,
                "cwd": snapshot.cwd,
            });
            let response = match self.call_ok(command, CONNECT_TIMEOUT_MS).await {
                Ok(response) => response,
                Err(error) => {
                    emit_session_failure(&self.inner.app, &snapshot.id, &error.message);
                    continue;
                }
            };
            let session_id = response
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or(&snapshot.id)
                .to_owned();
            let session = Arc::new(SessionRuntime::new(
                session_id,
                snapshot.cwd.clone(),
                snapshot.workspace_id,
                Some(file),
            ));
            session.set_interrupted(snapshot.streaming);
            if let Some(state) = response.get("state") {
                session.set_streaming(
                    state
                        .get("isStreaming")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                );
                // The host rebuilt this conversation, so its event numbering starts over.
                session.set_expected_seq(
                    state
                        .get("seq")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        .saturating_add(1),
                );
                session::emit_state(&self.inner.app, &session, state);
            }
            lock(&self.inner.state).sessions.insert(session);
        }
    }

    /// Registers a session this process has opened.
    pub(crate) fn register_session(&self, session: Arc<SessionRuntime>) {
        lock(&self.inner.state).sessions.insert(session);
    }

    pub(crate) fn remove_session(&self, session_id: &str) {
        lock(&self.inner.state).sessions.remove(session_id);
    }
}

/// Ceiling on a role id, in chars. The engine's roles are short lowercase words; the bound exists
/// so a mistyped one cannot become an oversized frame on its way out.
const ROLE_MAX_CHARS: usize = 64;

/// Ceiling on a model selector, in chars: `provider/model-id` plus an optional `:level` suffix, so
/// the longest rows a catalogue realistically holds still fit.
const SELECTOR_MAX_CHARS: usize = 256;

/// The role id to address, or a refusal naming what is wrong with it.
///
/// Checked on this side of the pipe: the host refuses a role it does not know, but an id that is
/// blank, oversized or not a role id at all is this process's own input, and the user should hear
/// what is wrong with it without a failed round trip first. What is returned is what the host is
/// asked about, so a padded id never travels.
fn validate_role(role: &str) -> IpcResult<String> {
    let role = role.trim();
    if role.is_empty() {
        return Err(IpcError::new(INVALID_INPUT, "A model role is required."));
    }
    if role.chars().count() > ROLE_MAX_CHARS {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The model role name is too long.",
        ));
    }
    let shaped = role.chars().all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '.' | '_' | '-')
    });
    if !shaped {
        return Err(IpcError::new(
            INVALID_INPUT,
            "A model role name may only contain lowercase letters, digits, dots, underscores and dashes.",
        ));
    }
    Ok(role.to_owned())
}

/// The selector to store, or `None` for the blank one that means "clear this role and let the
/// engine pick again".
///
/// A selector has to name a model from the role's own candidate pool, which only the host can
/// judge, so that part of the check stays on the far side. What is checked here is what this
/// process can know on its own and what would otherwise reach the engine's settings file verbatim:
/// a trimmed, bounded string with no control characters in it.
fn validate_selector(selector: &str) -> IpcResult<Option<String>> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Ok(None);
    }
    if selector.chars().count() > SELECTOR_MAX_CHARS {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The model selector is too long.",
        ));
    }
    if selector.chars().any(char::is_control) {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The model selector contains control characters.",
        ));
    }
    Ok(Some(selector.to_owned()))
}

/// Remembers an acknowledged-prompt id, bounded so a long run cannot grow the map.
fn remember_prompt(state: &mut HostState, id: &str, session_id: &str) {
    const PROMPT_LATE_LIMIT: usize = 64;
    if state.prompt_late.len() >= PROMPT_LATE_LIMIT {
        state.prompt_late.clear();
    }
    state
        .prompt_late
        .insert(id.to_owned(), session_id.to_owned());
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::Path;

    use super::super::SessionRegistry;
    use super::*;

    /// A late prompt id is remembered per session and bounded.
    #[test]
    fn late_prompt_ids_stay_bounded() {
        let mut state = HostState {
            generation: 1,
            status: HostStatus::Ready,
            child: None,
            stdin: None,
            pid: 0,
            shared: Arc::new(HostShared {
                limits: Mutex::new(FrameLimits::default()),
                log: Arc::new(EngineLog::new(Path::new("."), "test")),
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
        };
        for index in 0..96 {
            remember_prompt(&mut state, &format!("h{index}"), "s1");
        }
        assert!(state.prompt_late.len() <= 64);
    }

    /// A role id is checked before any host is asked: blank, oversized and non-role ids are refused
    /// here, and the id that is accepted is the trimmed one - what this process validates is what
    /// it sends.
    #[test]
    fn role_ids_are_validated_before_they_are_sent() {
        assert_eq!(validate_role(" default ").expect("trimmed"), "default");
        assert_eq!(
            validate_role("kv-cache.v2_1").expect("dots"),
            "kv-cache.v2_1"
        );
        assert_eq!(
            validate_role(&"a".repeat(ROLE_MAX_CHARS)).expect("at the limit"),
            "a".repeat(ROLE_MAX_CHARS)
        );

        let too_long = "a".repeat(ROLE_MAX_CHARS + 1);
        for rejected in [
            "",
            "   ",
            // Role ids are lowercase machine tokens; anything else is a caller's mistake.
            "Default",
            "role!",
            "role id",
            "role/id",
            too_long.as_str(),
        ] {
            let error = validate_role(rejected).expect_err(rejected);
            assert_eq!(error.code, INVALID_INPUT);
        }
    }

    /// A blank selector is the "clear this role" request the contract defines, and a real one is
    /// trimmed before it is sent: what the engine's settings file receives is what was checked
    /// here, control characters included.
    #[test]
    fn a_blank_selector_clears_and_a_real_one_is_checked() {
        assert_eq!(validate_selector("").expect("blank"), None);
        assert_eq!(validate_selector(" \t ").expect("blank"), None);
        assert_eq!(
            validate_selector(" anthropic/claude-sonnet-4-5:high ").expect("trimmed"),
            Some("anthropic/claude-sonnet-4-5:high".to_owned())
        );
        assert!(validate_selector(&"m".repeat(SELECTOR_MAX_CHARS)).is_ok());

        let too_long = "m".repeat(SELECTOR_MAX_CHARS + 1);
        for rejected in [
            "anthropic/two\nlines",
            "anthropic/seven\u{7}",
            too_long.as_str(),
        ] {
            let error = validate_selector(rejected).expect_err(rejected);
            assert_eq!(error.code, INVALID_INPUT);
        }
    }
}

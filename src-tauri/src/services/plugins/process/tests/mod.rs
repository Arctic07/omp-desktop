//! The process supervisor's tests: the rules, the state machine, the caps, and one real worker.
//!
//! Two kinds of test live here, and the split is deliberate:
//!
//! - **The rules and the state machine** run against an in-process worker (`FakeSpawner`), which
//!   speaks the protocol over real pipes and is driven by the *same* reader, frame codec and settle
//!   path as the shipped one. That is what makes "the seventeenth installation recycles the
//!   sixteenth", "a crash is retried after 100 ms", "a call that hangs is killed with the timeout
//!   token" and "a protocol mismatch is refused, not retried" provable without seventeen processes
//!   and thirty-second waits. The budgets are injectable for the same reason (`Timeouts`).
//! - **One real worker** (`bun host/src/main.ts --plugin-worker …`, the host tree in this
//!   repository) proves the *contract* the fake only models: the hello, a `command.execute`
//!   round-trip, a `worker_invoke` refusal relayed verbatim, and `worker_unload` answered before the
//!   process leaves with its own exit code. It skips when `bun` is not on this machine, which is the
//!   one prerequisite the whole host build already has.
//!
//! Nothing here asserts a private detail: the fake records what the supervisor *sent* (so an order
//! can be stated), and everything else is read from the table and the answers the public methods
//! return.

use std::collections::BTreeMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::errors::{
    IpcResult, INVALID_INPUT, PLUGIN_ACTION_UNDECLARED, PLUGIN_ACTION_UNKNOWN,
    PLUGIN_PROCESS_PROTOCOL_MISMATCH, PLUGIN_PROCESS_UNAVAILABLE,
};
use crate::models::plugins::{
    recheck_desktop, EngineDesktopBlock, EngineDesktopProcess, EnginePluginProcessCommand,
    EnginePluginRow,
};
use crate::services::plugins::pages::PageGrants;

use super::supervise::{
    HostSpawner, Launch, PluginProcess, Spawned, Spawner, Timeouts, WorkerLink,
};
use super::*;

// ---- a fake worker that speaks the real protocol ----

/// What one fake process does, besides answering the frames the supervisor sends.
#[derive(Debug, Clone)]
struct FakeScript {
    /// The protocol number the hello advertises.
    protocol: u32,
    /// Whether it introduces itself at all (false is a worker that hangs before the handshake).
    hello: bool,
    /// Whether `worker_call` is answered (false is a worker that stops answering).
    answer_calls: bool,
    /// Whether the *first* spawn dies 100 ms after answering `worker_load` (a crash after running).
    crash_after_load: bool,
    /// Whether `worker_unload` is answered at all (false is a stop that has to be forced).
    answer_unload: bool,
}

impl Default for FakeScript {
    fn default() -> Self {
        Self {
            protocol: WORKER_PROTOCOL,
            hello: true,
            answer_calls: true,
            crash_after_load: false,
            answer_unload: true,
        }
    }
}

/// What one fake child did, as the test reads it: the frames written to it, in order, and how it
/// ended.
#[derive(Default)]
struct FakeRecord {
    events: Mutex<Vec<String>>,
    killed: AtomicBool,
    exited: AtomicBool,
    exit_code: AtomicI32,
    spawns: AtomicU32,
}

impl FakeRecord {
    fn events(&self) -> Vec<String> {
        lock(&self.events).clone()
    }

    /// The positions of two events, for the one order these tests state.
    fn positions(&self, first: &str, second: &str) -> (Option<usize>, Option<usize>) {
        let events = self.events();
        (
            events.iter().position(|event| event == first),
            events.iter().position(|event| event == second),
        )
    }

    fn spawns(&self) -> u32 {
        self.spawns.load(Ordering::SeqCst)
    }
}

/// The spawner the state-machine tests use: an in-process worker per installation.
struct FakeSpawner {
    script: FakeScript,
    records: Mutex<BTreeMap<String, Arc<FakeRecord>>>,
}

impl FakeSpawner {
    fn new(script: FakeScript) -> Arc<Self> {
        Arc::new(Self {
            script,
            records: Mutex::new(BTreeMap::new()),
        })
    }

    fn record(&self, install: &str) -> Arc<FakeRecord> {
        lock(&self.records)
            .entry(install.to_owned())
            .or_insert_with(|| Arc::new(FakeRecord::default()))
            .clone()
    }
}

/// One message to a fake worker.
enum ToWorker {
    Frame(String),
    Kill,
}

impl Spawner for FakeSpawner {
    fn spawn(&self, install: &ProcessInstall) -> IpcResult<Spawned> {
        let record = self.record(&install.install);
        record.spawns.fetch_add(1, Ordering::SeqCst);
        let (pipe_sender, pipe_receiver) = mpsc::channel::<Vec<u8>>();
        let (inbox_sender, inbox_receiver) = mpsc::channel::<ToWorker>();
        let link = Arc::new(FakeLink {
            record: Arc::clone(&record),
            inbox: Mutex::new(inbox_sender),
        });
        let attempt = record.spawns();
        let script = self.script.clone();
        let plugin_id = install.plugin_id.clone();
        let install_id = install.install.clone();
        let child = Arc::clone(&record);
        std::thread::spawn(move || {
            run_fake_worker(
                &script,
                &plugin_id,
                &install_id,
                attempt,
                pipe_sender,
                inbox_receiver,
                &child,
            )
        });
        Ok(Spawned {
            link,
            stdout: Box::new(PipeReader {
                receiver: pipe_receiver,
                buffer: Vec::new(),
                offset: 0,
            }),
            stderr: None,
            pid: Some(4242),
        })
    }
}

/// The fake child's stdin: records what was sent, and hands it to the child's thread.
struct FakeLink {
    record: Arc<FakeRecord>,
    inbox: Mutex<Sender<ToWorker>>,
}

impl WorkerLink for FakeLink {
    fn send(&self, line: &str) -> bool {
        let frame = serde_json::from_str::<Value>(line).ok();
        let kind = frame
            .as_ref()
            .and_then(|frame| frame["type"].as_str().map(str::to_owned))
            .unwrap_or_else(|| "?".to_owned());
        // The load frame carries the activation event, so the record keeps it: which event woke a
        // process is the fact the activate/command tests state. The shape is the worker protocol's
        // own - `activation: { event }` (`host/src/plugin-worker/runtime.ts`) - not a bare string.
        let event = match kind.as_str() {
            "worker_load" => format!(
                ":{}",
                frame
                    .as_ref()
                    .and_then(|frame| frame["activation"]["event"].as_str())
                    .unwrap_or_default()
            ),
            _ => String::new(),
        };
        lock(&self.record.events).push(format!("send:{kind}{event}"));
        lock(&self.inbox)
            .send(ToWorker::Frame(line.to_owned()))
            .is_ok()
    }

    fn kill(&self) {
        lock(&self.record.events).push("kill".to_owned());
        self.record.killed.store(true, Ordering::SeqCst);
        let _ = lock(&self.inbox).send(ToWorker::Kill);
    }

    fn try_wait(&self) -> Option<i32> {
        if self.record.exited.load(Ordering::SeqCst) {
            return Some(self.record.exit_code.load(Ordering::SeqCst));
        }
        None
    }
}

/// One fake worker's stdout, back-pressure free: whole lines queued, EOF when the child ends.
struct PipeReader {
    receiver: Receiver<Vec<u8>>,
    buffer: Vec<u8>,
    offset: usize,
}

impl Read for PipeReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.offset >= self.buffer.len() {
            match self.receiver.recv() {
                Ok(chunk) => {
                    self.buffer = chunk;
                    self.offset = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let available = self.buffer.len() - self.offset;
        let take = available.min(out.len());
        out[..take].copy_from_slice(&self.buffer[self.offset..self.offset + take]);
        self.offset += take;
        Ok(take)
    }
}

/// One fake child: introduce itself, then answer the three frames the protocol has.
fn run_fake_worker(
    script: &FakeScript,
    plugin_id: &str,
    install_id: &str,
    attempt: u32,
    pipe: Sender<Vec<u8>>,
    inbox: Receiver<ToWorker>,
    record: &FakeRecord,
) {
    let answer = |frame: Value| {
        let mut line = frame.to_string();
        line.push('\n');
        let _ = pipe.send(line.into_bytes());
    };
    if script.hello {
        answer(json!({
            "type": "worker_hello",
            "protocol": script.protocol,
            "pluginId": plugin_id,
            "installId": install_id,
            "entry": "main.js",
        }));
    }
    let mut exit = 1;
    while let Ok(message) = inbox.recv() {
        let text = match message {
            ToWorker::Kill => break,
            ToWorker::Frame(text) => text,
        };
        let Ok(frame) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let id = frame["id"].as_str().unwrap_or_default();
        match frame["type"].as_str().unwrap_or_default() {
            "worker_load" => {
                answer(json!({ "type": "worker_result", "id": id, "ok": true }));
                if script.crash_after_load && attempt == 1 {
                    // Late enough that the start has already been told the load succeeded: this is a
                    // crash *after* the process became live, which is the one that backs off.
                    std::thread::sleep(Duration::from_millis(120));
                    record.exit_code.store(9, Ordering::SeqCst);
                    record.exited.store(true, Ordering::SeqCst);
                    return;
                }
            }
            "worker_call" => {
                if !script.answer_calls {
                    continue;
                }
                let method = frame["method"].as_str().unwrap_or_default();
                answer(json!({
                    "type": "worker_result",
                    "id": id,
                    "ok": true,
                    "value": { "method": method, "params": frame["params"] },
                }));
            }
            "worker_unload" if script.answer_unload => {
                answer(json!({ "type": "worker_result", "id": id, "ok": true }));
                exit = 0;
                break;
            }
            _ => {}
        }
    }
    record.exit_code.store(exit, Ordering::SeqCst);
    record.exited.store(true, Ordering::SeqCst);
}

// ---- fixtures ----

fn quick() -> Timeouts {
    Timeouts {
        load: Duration::from_secs(3),
        unload: Duration::from_millis(300),
        call: Duration::from_millis(300),
    }
}

fn supervisor(spawner: Arc<FakeSpawner>) -> Arc<PluginProcess> {
    PluginProcess::detached(spawner, quick())
}

fn install(id: &str) -> ProcessInstall {
    ProcessInstall {
        install: format!("{id}@test-market"),
        plugin_id: id.to_owned(),
        name: id.to_owned(),
        scope: "user".to_owned(),
        root: std::env::temp_dir(),
        commands: vec![InstallCommand {
            id: "probe".to_owned(),
        }],
        activation_events: vec![ACTIVATION_STARTUP.to_owned()],
        renderer_call_methods: vec!["listSnippets".to_owned()],
        grants: PageGrants::default(),
        enabled: true,
        workspace: None,
        auto_restart: true,
        revision: "1.0.0\u{0}main.js".to_owned(),
    }
}

/// The same descriptor with a chosen activation list (`omp.desktop.activationEvents`).
fn install_with_events(id: &str, events: &[&str]) -> ProcessInstall {
    let mut install = install(id);
    install.activation_events = events.iter().map(|event| (*event).to_owned()).collect();
    install
}

/// One host row with a process block, as the list read hands it over.
fn row(id: &str, builtin: bool, permissions: &[&str]) -> EnginePluginRow {
    EnginePluginRow {
        id: id.to_owned(),
        name: id.to_owned(),
        scope: "user".to_owned(),
        enabled: true,
        version: Some("1.0.0".to_owned()),
        root_path: Some(std::env::temp_dir().to_string_lossy().into_owned()),
        builtin,
        desktop: Some(EngineDesktopBlock {
            valid: true,
            permissions: permissions.iter().map(|name| (*name).to_owned()).collect(),
            process: Some(EngineDesktopProcess {
                main: Some("main.js".to_owned()),
                activation_events: vec!["onStartup".to_owned()],
                auto_restart: true,
                commands: vec![EnginePluginProcessCommand {
                    id: "probe".to_owned(),
                    title: None,
                    keywords: Vec::new(),
                }],
                available: false,
                reason: None,
            }),
            ..EngineDesktopBlock::default()
        }),
        ..EnginePluginRow::default()
    }
}

/// Polls until `ready` or the deadline passes; the supervisor's edges are asynchronous by design.
fn wait_until(what: &str, ready: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if ready() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {what}");
}

mod activation;
mod lifecycle;
mod real_worker;
mod rules;
mod wait;

//! End-to-end tests against the real host artifact (`rules.md#verification-and-gates`: an engine or protocol change is
//! proven by running a real host, not by the shapes this crate can check on its own).
//!
//! This module is the harness, in three parts that keep one responsibility each: [`artifact`]
//! decides which file is the host and vouches for it, this file starts it exactly the way
//! [`process::spawn`] does and reads its stdout exactly the way the application reads it
//! (`protocol::read_line` + `protocol::FrameDecoder`), and [`tests`] holds the four scenarios.
//! A shape accepted here is therefore a shape the running application accepts, and a shape
//! refused here is refused there.
//!
//! The four scenarios - the handshake and a whole session, the protocol refusal, a vanished
//! launcher, and the kill path - are each a lifecycle claim rather than a piece of plumbing. All
//! four are `#[ignore]`d: they need `binaries/bundle/manifest.json` and the files it names to
//! have been built, and they start a real process rather than a data structure.
//!
//! A model turn (`session_prompt` → streamed deltas → `agent_end`) is deliberately absent: it
//! needs provider credentials, and a fabricated provider would only test the fabrication. That
//! path stays `BLOCKED-BY-ENV` rather than being faked here.

mod artifact;
mod tests;

use std::cell::Cell;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::services::paths::DataPaths;

use super::super::protocol::{read_line, Decoded, FrameDecoder, FrameLimits, LineRead};
use super::super::PROTOCOL_VERSION;
use super::lock;
use super::process::{self, HostChild};

/// Transport limits `hello` advertises, as the contract pins them (host `constants.ts`).
const ADVERTISED_MAX_FRAME_BYTES: u64 = 1_048_576;
const ADVERTISED_MAX_REASSEMBLED_BYTES: u64 = 67_108_864;

/// Deadlines. Generous on purpose - the host is a bundled runtime that has to boot before it can
/// answer - but every wait is bounded, so a host that hangs fails the test instead of the run.
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(60);
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
const EXIT_DEADLINE: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// The whole suite runs one host at a time: each test starts a bundled runtime, and the exit-code
/// assertions read more clearly when four of them are not competing for the machine.
static SERIAL: Mutex<()> = Mutex::new(());
/// Names one fixture directory per test, so a rerun never inherits the previous run's tree.
static FIXTURE_SEQ: AtomicU32 = AtomicU32::new(0);

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The data root one test owns: a private directory under the system temp directory, laid out the
/// way [`DataPaths`] lays it out.
///
/// Nothing here reads or writes the user's real application data: every location the host is
/// given derives from this root, and the host refuses to start when a pinned variable disagrees
/// with it.
struct Fixture {
    paths: DataPaths,
    /// The same root in the resolved form the host's own `realpath`-based checks produce, for
    /// containment assertions: a temp directory may be spelled with a short name, a resolved path
    /// may not.
    canonical_root: PathBuf,
    /// The directory the session under test is opened in.
    workspace: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let sequence = FIXTURE_SEQ.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("omp-e2e-{name}-{}-{sequence}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let paths = DataPaths::from_root(root);
        paths
            .ensure_host_dirs()
            .expect("the fixture data root must be creatable");
        let workspace = paths.data_root.join("workspace");
        std::fs::create_dir_all(&workspace).expect("the fixture workspace must be creatable");
        let canonical_root = std::fs::canonicalize(&paths.data_root)
            .expect("the fixture data root must be resolvable");
        Self {
            paths,
            canonical_root,
            workspace,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Best effort: a temporary directory left behind is not a failure, and the fixture name
        // carries the process id, so it can never be mistaken for a user directory.
        let _ = std::fs::remove_dir_all(&self.paths.data_root);
    }
}

/// What the stdout reader saw, so a failure can say what actually arrived.
#[derive(Default)]
struct StdoutRecord {
    lines: usize,
    frames: usize,
    overflows: usize,
    malformed: Vec<String>,
}

/// One message from the stdout reader to the test.
enum Inbound {
    Frame(Value),
    Closed,
}

/// Reads the host's stdout the way the application reads it: `read_line` for the physical framing,
/// then `FrameDecoder` for logical frames and `rpc_chunk` runs, under `hello`'s advertised limits.
fn start_stdout_reader(
    stdout: ChildStdout,
    record: Arc<Mutex<StdoutRecord>>,
    sender: Sender<Inbound>,
) {
    std::thread::Builder::new()
        .name("omp-e2e-stdout".to_owned())
        .spawn(move || {
            let mut reader = BufReader::with_capacity(64 * 1024, stdout);
            let mut decoder = FrameDecoder::new(FrameLimits::default());
            let mut buffer = Vec::with_capacity(16 * 1024);
            loop {
                let limit = decoder.limits().max_frame_bytes;
                match read_line(&mut reader, &mut buffer, limit) {
                    Ok(LineRead::Line) => {}
                    Ok(LineRead::Overflow) => {
                        let mut record = lock(&record);
                        record.lines += 1;
                        record.overflows += 1;
                        continue;
                    }
                    Ok(LineRead::Eof) | Err(_) => break,
                }
                while matches!(buffer.last().copied(), Some(b'\n') | Some(b'\r')) {
                    buffer.pop();
                }
                let decoded = decoder.push_line(&buffer);
                let mut record = lock(&record);
                record.lines += 1;
                match decoded {
                    Decoded::Frame(value, _) => {
                        record.frames += 1;
                        drop(record);
                        if sender.send(Inbound::Frame(value)).is_err() {
                            return;
                        }
                    }
                    Decoded::Malformed(reason) => record.malformed.push(reason),
                    Decoded::Skipped => {}
                }
            }
            let _ = sender.send(Inbound::Closed);
        })
        .expect("the e2e stdout reader thread must start");
}

/// Keeps the host's stderr for failure messages. It is diagnostics, never protocol.
fn start_stderr_reader(stderr: ChildStderr, lines: Arc<Mutex<Vec<String>>>) {
    const KEPT: usize = 40;
    std::thread::Builder::new()
        .name("omp-e2e-stderr".to_owned())
        .spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let mut lines = lock(&lines);
                if lines.len() < KEPT {
                    lines.push(line);
                }
            }
        })
        .expect("the e2e stderr reader thread must start");
}

/// One running host and the pipes around it.
struct Host {
    child: Mutex<Child>,
    pid: u32,
    stdin: Option<ChildStdin>,
    inbound: Receiver<Inbound>,
    stdout: Arc<Mutex<StdoutRecord>>,
    stderr: Arc<Mutex<Vec<String>>>,
    /// Frames the host published on its own account (a session's `state`, its command catalogue),
    /// kept rather than dropped: they are part of what the session produced.
    unsolicited: Vec<Value>,
    fixture: Fixture,
    request_seq: Cell<u32>,
}

impl Host {
    /// Locates the shipped artifact, verifies it against its manifest, and starts it with the
    /// pinned environment and the fixture's data root.
    fn start(fixture: Fixture) -> Self {
        let artifact = artifact::locate();
        let HostChild {
            child,
            stdin,
            stdout,
            stderr,
            pid,
        } = process::spawn(&fixture.paths, &artifact, &[]).unwrap_or_else(|error| {
            panic!("the host must start: [{}] {}", error.code, error.message)
        });
        let stdout_record = Arc::new(Mutex::new(StdoutRecord::default()));
        let stderr_lines = Arc::new(Mutex::new(Vec::new()));
        let (sender, inbound) = mpsc::channel();
        start_stdout_reader(stdout, stdout_record.clone(), sender);
        start_stderr_reader(stderr, stderr_lines.clone());
        Self {
            child: Mutex::new(child),
            pid,
            stdin: Some(stdin),
            inbound,
            stdout: stdout_record,
            stderr: stderr_lines,
            unsolicited: Vec::new(),
            fixture,
            request_seq: Cell::new(0),
        }
    }

    /// Request ids are the correlation the protocol answers by, so every command gets its own.
    fn id(&self) -> String {
        let next = self.request_seq.get() + 1;
        self.request_seq.set(next);
        format!("e2e-{next}")
    }

    /// Writes one frame as a single NDJSON line, exactly as the application's stdin writer does.
    fn send(&mut self, frame: Value) {
        let mut line = serde_json::to_string(&frame).expect("an e2e frame is JSON");
        line.push('\n');
        let written = {
            let stdin = self
                .stdin
                .as_mut()
                .expect("the harness still holds the host's stdin");
            stdin
                .write_all(line.as_bytes())
                .and_then(|()| stdin.flush())
        };
        if let Err(error) = written {
            panic!("writing to the host failed: {error}{}", self.diagnostics());
        }
    }

    /// The next decoded frame, or a failure that says what the host printed instead.
    fn frame(&self, deadline: Duration) -> Value {
        match self.inbound.recv_timeout(deadline) {
            Ok(Inbound::Frame(value)) => {
                assert!(
                    value.get("type").and_then(Value::as_str).is_some(),
                    "every decoded frame carries a type, got {value}"
                );
                value
            }
            Ok(Inbound::Closed) => panic!(
                "the host closed stdout while a frame was expected{}",
                self.diagnostics()
            ),
            Err(RecvTimeoutError::Timeout) => {
                panic!("no frame arrived within {deadline:?}{}", self.diagnostics())
            }
            Err(RecvTimeoutError::Disconnected) => panic!(
                "the stdout reader stopped while a frame was expected{}",
                self.diagnostics()
            ),
        }
    }

    /// Reads frames until one carries `kind`, accepting the frames a busy host may publish in the
    /// meantime (`is_publishable`) and failing on anything else.
    fn frame_of(&mut self, kind: &str, deadline: Duration) -> Value {
        loop {
            let value = self.frame(deadline);
            let described = value.get("type").and_then(Value::as_str).unwrap_or("?");
            if described == kind {
                return value;
            }
            assert!(
                is_publishable(described),
                "the host sent {value} where a {kind} frame was expected{}",
                self.diagnostics()
            );
            self.unsolicited.push(value);
        }
    }

    /// The next frame of `kind`, whether it was read forward or already buffered by a reply.
    ///
    /// A response can overtake the frames its command caused - `session_open` answers only after
    /// the session's state and command advertisement have been published - so a scenario that
    /// wants one of those has to look in what the reply collection already holds.
    fn take(&mut self, kind: &str) -> Value {
        if let Some(index) = self
            .unsolicited
            .iter()
            .position(|frame| frame.get("type").and_then(Value::as_str) == Some(kind))
        {
            return self.unsolicited.remove(index);
        }
        self.frame_of(kind, REQUEST_DEADLINE)
    }

    /// Sends one command and returns the response that carries its id.
    fn call(&mut self, mut frame: Value) -> Value {
        let id = self.id();
        frame
            .as_object_mut()
            .expect("an e2e command is a JSON object")
            .insert("id".to_owned(), json!(id));
        self.send(frame);
        loop {
            let value = self.frame(REQUEST_DEADLINE);
            let kind = value.get("type").and_then(Value::as_str).unwrap_or("?");
            if kind == "response" {
                assert_eq!(
                    value.get("id").and_then(Value::as_str),
                    Some(id.as_str()),
                    "a response answers the id that asked: {value}"
                );
                return value;
            }
            assert!(
                is_publishable(kind),
                "the host sent {value} while answering request {id}{}",
                self.diagnostics()
            );
            self.unsolicited.push(value);
        }
    }

    /// The `data` of a response that must have succeeded.
    fn ok(&mut self, frame: Value) -> Value {
        let described = frame
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("command")
            .to_owned();
        let response = self.call(frame);
        assert_eq!(
            response.get("success").and_then(Value::as_bool),
            Some(true),
            "{described} must succeed: {response}{}",
            self.diagnostics()
        );
        response.get("data").cloned().unwrap_or(Value::Null)
    }

    /// The handshake, in the order [`super::HostRuntime::start`] performs it: read `hello`, answer
    /// it with `hello_ok`, then take the two frames that answer it - the response and `ready`, in
    /// whichever order the host writes them (it publishes `ready` before it reads stdin).
    fn handshake(&mut self) -> Value {
        let hello = self.frame(HANDSHAKE_DEADLINE);
        assert_hello(&hello);

        let id = self.id();
        self.send(json!({"type": "hello_ok", "protocol": PROTOCOL_VERSION, "id": id}));
        let mut ready = None;
        let mut response = None;
        while ready.is_none() || response.is_none() {
            let value = self.frame(HANDSHAKE_DEADLINE);
            match value.get("type").and_then(Value::as_str) {
                Some("ready") => ready = Some(value),
                Some("response") => {
                    assert_eq!(
                        value.get("id").and_then(Value::as_str),
                        Some(id.as_str()),
                        "the answer to hello_ok carries its id: {value}"
                    );
                    response = Some(value);
                }
                _ => panic!(
                    "the host sent {value} during the handshake{}",
                    self.diagnostics()
                ),
            }
        }
        let response = response.expect("the handshake loop waited for the response");
        assert_eq!(
            response.get("success").and_then(Value::as_bool),
            Some(true),
            "hello_ok must be accepted: {response}"
        );
        assert_eq!(
            field(&response, &["data", "ready"]).as_bool(),
            Some(true),
            "the response must report the host ready: {response}"
        );
        ready.expect("the handshake loop waited for ready")
    }

    /// Asks the host to shut down and asserts the ending the application relies on: a
    /// `{closed:true}` answer, a `host_exit` frame, then exit code 0.
    fn shutdown(&mut self, reason: &str) {
        let data = self.ok(json!({"type": "host_shutdown", "reason": reason}));
        assert_eq!(
            field(&data, &["closed"]).as_bool(),
            Some(true),
            "host_shutdown must report the session table closed: {data}"
        );
        let exit = self.frame_of("host_exit", EXIT_DEADLINE);
        assert_eq!(
            field(&exit, &["code"]).as_u64(),
            Some(0),
            "a requested shutdown reports code 0: {exit}"
        );
        assert_eq!(
            field(&exit, &["reason"]).as_str(),
            Some(reason),
            "the exit frame carries the reason it was asked with: {exit}"
        );
        let status = self.expect_exit(EXIT_DEADLINE);
        assert_eq!(
            status.code(),
            Some(0),
            "a requested shutdown ends with exit code 0: {status:?}"
        );
    }

    /// Waits for the child to be reaped, which is also what makes `try_wait` report its status.
    fn expect_exit(&self, deadline: Duration) -> ExitStatus {
        let started = Instant::now();
        loop {
            {
                let mut child = lock(&self.child);
                match child.try_wait() {
                    Ok(Some(status)) => return status,
                    Ok(None) => {}
                    Err(error) => panic!("the host process could not be reaped: {error}"),
                }
            }
            assert!(
                started.elapsed() < deadline,
                "the host did not exit within {deadline:?}{}",
                self.diagnostics()
            );
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    /// Every stdout line the host wrote has to come back as a frame from the application's own
    /// decoder: no overflow, no malformed line, no line that decoded to nothing, and at least
    /// `minimum` frames - a count each test states from the exchange it drove, so a decoder that
    /// quietly stopped after the greeting cannot pass.
    fn assert_stdout_decoded(&self, minimum: usize) {
        let record = lock(&self.stdout);
        assert_eq!(
            record.overflows, 0,
            "no stdout line may exceed the advertised frame ceiling"
        );
        assert!(
            record.malformed.is_empty(),
            "every stdout line must decode, got {:?} out of {} lines",
            record.malformed,
            record.lines
        );
        assert_eq!(
            record.lines,
            record.frames + record.malformed.len(),
            "every stdout line must become exactly one frame"
        );
        assert!(
            record.frames >= minimum,
            "the exchange produced {} decoded frames, expected at least {minimum}",
            record.frames
        );
    }

    fn diagnostics(&self) -> String {
        let record = lock(&self.stdout);
        let stderr = lock(&self.stderr);
        let malformed = if record.malformed.is_empty() {
            "none".to_owned()
        } else {
            record.malformed.join(" | ")
        };
        let stderr = if stderr.is_empty() {
            "(silent)".to_owned()
        } else {
            stderr.join("\n    ")
        };
        format!(
            "\n  stdout: {} frames, {} lines, {} overflows, malformed: {malformed}\n  stderr:\n    {stderr}",
            record.frames, record.lines, record.overflows
        )
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        // A failing assertion must not leak a live host: close stdin, then take the tree down if
        // it is still there. The success paths have already reaped it, which is what the first
        // check sees.
        self.stdin = None;
        let running = {
            let mut child = lock(&self.child);
            matches!(child.try_wait(), Ok(None))
        };
        if running {
            process::kill_tree(&self.child, self.pid);
        }
    }
}

/// True for a frame the host publishes on its own schedule, which a command exchange has to
/// tolerate: session events (`state`, the command catalogue, `advisor_cost_changed`…), notices
/// and the `ready` announcement.
///
/// The three frames that only ever appear at their own moment are excluded - the greeting, the
/// ending, and a startup refusal. Seeing one of those where an answer was expected means the two
/// sides disagree about what is happening, and the test should say so. `ready` is deliberately
/// *not* among them: the host publishes it as soon as its boot finishes, so it legitimately
/// overtakes the `hello_ok` response (see [`Host::handshake`]).
fn is_publishable(kind: &str) -> bool {
    !matches!(kind, "hello" | "host_exit" | "host_fatal")
}

/// A field of a frame, with the whole frame in the failure message when it is missing.
fn field<'a>(frame: &'a Value, path: &[&str]) -> &'a Value {
    let mut current = frame;
    for key in path {
        current = current
            .get(*key)
            .unwrap_or_else(|| panic!("{key} is missing from {frame}"));
    }
    current
}

/// Everything `hello` promises the desktop side: the protocol this host speaks, and the transport
/// limits it will respect when it writes.
fn assert_hello(hello: &Value) {
    assert_eq!(
        field(hello, &["type"]).as_str(),
        Some("hello"),
        "the first frame on stdout is the greeting: {hello}"
    );
    assert_eq!(
        field(hello, &["protocol"]).as_u64(),
        Some(u64::from(PROTOCOL_VERSION)),
        "the host greets with the protocol this build speaks: {hello}"
    );
    assert_eq!(
        field(hello, &["limits", "maxFrameBytes"]).as_u64(),
        Some(ADVERTISED_MAX_FRAME_BYTES),
        "the advertised physical frame ceiling is the contract value: {hello}"
    );
    assert_eq!(
        field(hello, &["limits", "maxReassembledFrameBytes"]).as_u64(),
        Some(ADVERTISED_MAX_REASSEMBLED_BYTES),
        "the advertised reassembly ceiling is the contract value: {hello}"
    );
    for key in ["hostVersion", "sdkVersion"] {
        let value = field(hello, &[key]).as_str().unwrap_or_default();
        assert!(
            !value.is_empty(),
            "hello carries a {key} for the settings page: {hello}"
        );
    }
}

/// True while the operating system still lists `pid` in its process table.
///
/// `try_wait` proves the child was reaped; this proves nothing with that pid is left running. The
/// two together are what "the tree is gone" means.
fn process_table_has(pid: u32) -> bool {
    #[cfg(windows)]
    {
        // The PID column is quoted in CSV output, so the query's own filter and the quoted field
        // together cannot match anything else on the line.
        let output = Command::new("tasklist")
            .arg("/FI")
            .arg(format!("PID eq {pid}"))
            .arg("/NH")
            .arg("/FO")
            .arg("CSV")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .expect("tasklist must be runnable");
        String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
    }
    #[cfg(unix)]
    {
        // Signal 0 asks the kernel whether the process exists without touching it.
        Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        false
    }
}

/// Waits for the process table to lose `pid`, so a kill that is merely slow is not a failure.
fn wait_until_gone(pid: u32, deadline: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < deadline {
        if !process_table_has(pid) {
            return true;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    !process_table_has(pid)
}

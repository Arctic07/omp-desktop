//! Starting the host process: the environment it is pinned to, the stdio plumbing around it, and
//! the kill path that ends its tree.

use std::ffi::OsString;
use std::io::{BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::mpsc;

use crate::errors::{IpcError, IpcResult, ENGINE_SPAWN_FAILED};
use crate::services::credentials;
use crate::services::host_bin::HostArtifact;
use crate::services::log;
use crate::services::paths::DataPaths;

use super::super::protocol::{read_line, Decoded, FrameDecoder, LineRead};
use super::super::{MAX_FRAME_LIMIT, MAX_LOG_LINE_BYTES, MAX_REASSEMBLED_LIMIT};
use super::{lock, HostShared, Inbound, InboundBudget};

/// Log file stem. One host process owns one log.
pub(super) const LOG_KEY: &str = "host";

/// Environment variable carrying every provider whose keyring entry holds more than one key.
///
/// The payload is `{ "<provider>": { "env": "<variable>", "keys": ["…"] } }`. It exists because a
/// provider's own variable can only carry one value; the host reads it once at start-up, installs
/// the keys as in-memory credentials, and removes the variable so child tools never inherit it.
pub(super) const PROVIDER_KEYS_ENV: &str = "OMP_DESKTOP_PROVIDER_KEYS";

/// `CREATE_NO_WINDOW`: keeps a console window from flashing when the host runs without one.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Environment the host inherits before the pinned values are written over it.
///
/// Everything else is dropped: the host must never read a location or a credential from this
/// process's own environment. `HOME` and `USERPROFILE` are listed here only because the pinned
/// assignments below need a platform-appropriate base to exist first - both are overwritten.
pub(super) const ENV_PASSTHROUGH: &[&str] = &[
    "PATH",
    "SystemRoot",
    "TEMP",
    "TMP",
    "LANG",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "HOME",
    "USERPROFILE",
];

/// Windows toolchain locations, handed through unchanged. These are the one kind of variable the
/// whitelist was widened for (`rules.md#engine-integration-and-data-ownership`): a location that finds a **tool**.
///
/// `%LOCALAPPDATA%` is where a user-scope install puts itself and where its launcher looks for it:
/// a `bun` provided by Volta starts from `%LOCALAPPDATA%\Volta\...`, and because `HOME` and
/// `USERPROFILE` are pinned to the data root, a launcher that can only reach the profile through
/// them exits 126 instead of running the tool - which is what failed every engine-side npm/link
/// install on such a machine (plugins spec §14.1-1). `APPDATA` travels with it for the same reason:
/// on Windows the two are one pair in every toolchain.
///
/// Neither decides where this application's data lands. That is `--data-root` and the pinned
/// `PI_*` / `XDG_DATA_HOME` / `HOME` / `USERPROFILE` below, which the host derives and asserts
/// (`host/src/env.ts`); passing a toolchain variable changes no pinned value and cannot move one -
/// a toolchain location may point at the real user profile, engine data never may.
const ENV_TOOLCHAIN_WINDOWS: &[&str] = &["LOCALAPPDATA", "APPDATA"];

/// Package-manager install directories, handed through unchanged and for the same two reasons: the
/// engine's install and uninstall paths shell out to `bun` / `npm`, and a manager whose own root is
/// invisible cannot resolve the version it was asked to run.
///
/// `VOLTA_HOME` is the Volta root a launcher resolves its own binaries against, `BUN_INSTALL` is
/// `bun`'s install prefix, and `PNPM_HOME` / `NPM_CONFIG_PREFIX` are where pnpm and npm put the
/// binaries a shell later finds on `PATH`. `NVM_HOME` / `NVM_SYMLINK` are nvm-windows' node
/// directory and its symlink, which the shims need to resolve `node` / `npm` themselves;
/// `COREPACK_HOME`, `MISE_DATA_DIR` and `FNM_DIR` are the same kind of root for Corepack, mise and
/// fnm. Like the pair above they locate tools, not data: nothing here is read to resolve a location
/// under the data root, and no pinned key is one of them.
///
/// Every name in this group, in [`ENV_TOOLCHAIN_WINDOWS`] and in [`ENV_SYNTHESIZED_TOOLCHAIN`] is
/// listed by name - never by value - in the start-up line written from `toolchain_disclosure`, so
/// widening this whitelist leaves a record in the log instead of staying silent.
const ENV_PACKAGE_MANAGER_HOMES: &[&str] = &[
    "VOLTA_HOME",
    "BUN_INSTALL",
    "PNPM_HOME",
    "NPM_CONFIG_PREFIX",
    "NVM_HOME",
    "NVM_SYMLINK",
    "COREPACK_HOME",
    "MISE_DATA_DIR",
    "FNM_DIR",
];

/// Toolchain roots this process derives from its own profile when its environment does not carry
/// them, as `(variable, base variable, path under that base)`.
///
/// Handing through what the environment already has is not enough for every launcher: the one that
/// starts `bun` on a Volta machine resolves its root from `USERPROFILE`, not from `LOCALAPPDATA`
/// (measured on Windows: with only `USERPROFILE` pinned, `bun --version` exits 6, "Could not
/// determine LocalAppData directory"; adding `LOCALAPPDATA` does not help, `VOLTA_HOME` does). The
/// variable it *would* have read is therefore synthesized here - from this process's own profile,
/// which is not the pinned one - but only when that directory actually exists, so a machine without
/// Volta or without a `.bun` gets exactly the environment it got before.
///
/// A value is a path under the real user profile and never under the data root, and it is not read
/// to resolve a data location: `HOME` / `USERPROFILE` / `XDG_DATA_HOME` / `PI_*` stay pinned to the
/// data root below.
const ENV_SYNTHESIZED_TOOLCHAIN: &[(&str, &str, &str)] = &[
    ("VOLTA_HOME", "LOCALAPPDATA", "Volta"),
    ("BUN_INSTALL", "USERPROFILE", ".bun"),
];

/// The environment one host process is started with, plus the toolchain names it was given, split
/// by where they came from.
struct HostEnvironment {
    /// Every variable to set, in application order: like repeated `Command::env` calls, the last
    /// entry for a name is the one the child sees.
    entries: Vec<(String, OsString)>,
    /// The toolchain-locating variables taken from this process's environment, by name only. This
    /// is one half of what the start-up line discloses; a value stays out of it, because a value is
    /// a path under the real user profile.
    passed_through: Vec<&'static str>,
    /// The toolchain-locating variables built from a location this process can see under its own
    /// profile, by name only: the other half of the start-up line.
    synthesized: Vec<&'static str>,
}

/// Builds the child environment: the whitelist, then the toolchain roots this process has to derive
/// from its own profile, then the pinned data locations, then the provider credentials.
///
/// The order is deliberate - each layer may overwrite the one before it. A whitelisted variable is
/// only ever a base the pins overwrite (`HOME` / `USERPROFILE` are whitelisted exactly so the
/// pinned assignments have something to replace), and a provider key comes last because that is the
/// value the engine has to authenticate with.
///
/// Both reads of this process's environment are parameters so the filter can be tested without
/// reading the real environment or touching a real profile: production passes `std::env::var_os`
/// and `Path::is_dir`.
fn host_environment(
    paths: &DataPaths,
    provider_keys: credentials::ProviderKeys,
    mut lookup: impl FnMut(&str) -> Option<OsString>,
    mut exists: impl FnMut(&Path) -> bool,
) -> HostEnvironment {
    let mut entries: Vec<(String, OsString)> = Vec::new();
    let mut passed_through: Vec<&'static str> = Vec::new();
    let mut synthesized: Vec<&'static str> = Vec::new();
    // The flag marks the two toolchain groups: they are the part of the whitelist the start-up
    // line names.
    for (group, disclose) in [
        (ENV_PASSTHROUGH, false),
        (ENV_TOOLCHAIN_WINDOWS, true),
        (ENV_PACKAGE_MANAGER_HOMES, true),
    ] {
        for name in group {
            // A missing name is not set at all, and neither is an empty one: a toolchain reading an
            // empty `VOLTA_HOME` has a nonsense root, while an unset one lets it use its own.
            if let Some(value) = lookup(name) {
                if !value.is_empty() {
                    entries.push(((*name).to_owned(), value));
                    if disclose {
                        passed_through.push(name);
                    }
                }
            }
        }
    }
    // A launcher that cannot see the root it was installed under exits instead of running the
    // tool, so a root this process's profile has - and the environment did not carry - is filled
    // in here. The name is left alone when the profile has no such directory: the child then looks
    // exactly like it did before this rule existed.
    for (name, base, leaf) in ENV_SYNTHESIZED_TOOLCHAIN {
        if entries.iter().any(|(key, _)| key == name) {
            continue;
        }
        let Some(profile) = lookup(base).filter(|value| !value.is_empty()) else {
            continue;
        };
        let root = Path::new(&profile).join(leaf);
        if !exists(&root) {
            continue;
        }
        entries.push(((*name).to_owned(), root.into_os_string()));
        synthesized.push(name);
    }
    // Pinned data locations (contract §1.3): the host must never resolve these from `.env`, XDG or
    // platform defaults, and it refuses to start when they disagree with what it derives.
    entries.push((
        "PI_CODING_AGENT_DIR".to_owned(),
        paths.agent_dir.clone().into_os_string(),
    ));
    // The same directory under this application's own name: every variable this application
    // defines is `OMP_DESKTOP_`-prefixed, so its key for that directory is
    // `OMP_DESKTOP_CODING_AGENT_DIR`. The host pins and asserts both keys (`host/src/env.ts`),
    // and the engine's shell inherits whichever it resolves.
    entries.push((
        "OMP_DESKTOP_CODING_AGENT_DIR".to_owned(),
        paths.agent_dir.clone().into_os_string(),
    ));
    entries.push(("PI_CONFIG_DIR".to_owned(), OsString::from("omp-desktop")));
    entries.push((
        "OMP_WORKTREE_DIR".to_owned(),
        paths.worktrees.clone().into_os_string(),
    ));
    entries.push((
        "XDG_DATA_HOME".to_owned(),
        paths.host_xdg.clone().into_os_string(),
    ));
    entries.push(("HOME".to_owned(), paths.host_home.clone().into_os_string()));
    entries.push((
        "USERPROFILE".to_owned(),
        paths.host_home.clone().into_os_string(),
    ));
    // The payload is built before the single-key entries are consumed: it reads the whole split.
    let pool_payload = credentials::provider_keys_payload(&provider_keys);
    entries.extend(
        provider_keys
            .single
            .into_iter()
            .map(|(name, value)| (name, OsString::from(value))),
    );
    // Rotation pools cannot be expressed as one variable, so they travel as one JSON object: the
    // pools to install, every keyed provider's variable, and the built-in ids. The host deletes the
    // single-key variable for a pooled provider, so the pool is not shadowed by the environment tier.
    if let Some(payload) = pool_payload {
        entries.push((PROVIDER_KEYS_ENV.to_owned(), OsString::from(payload)));
    }
    HostEnvironment {
        entries,
        passed_through,
        synthesized,
    }
}

/// The start-up disclosure: the toolchain variables the child is given, by name and nothing else,
/// in the two groups a log reader has to be able to tell apart - what this process's environment
/// carried, and what was built from a location under this process's real profile.
///
/// One line per host start, written through the application log, because widening the whitelist -
/// and deriving a value at all - is a decision a log reader must be able to see after the fact.
/// Values stay out of it: each one is a path under the real user profile (`%LOCALAPPDATA%` carries
/// the user name), and the log file outlives the run that wrote it.
fn toolchain_disclosure(passed_through: &[&str], synthesized: &[&str]) -> String {
    if passed_through.is_empty() && synthesized.is_empty() {
        return "host environment: no toolchain variable was handed through or synthesized"
            .to_owned();
    }
    format!(
        "host environment: toolchain variables handed through from this process: {}; \
         synthesized from this process's profile: {}",
        names_or_none(passed_through),
        names_or_none(synthesized)
    )
}

/// One group of names for the line above, spelled `none` when the group is empty: the line keeps a
/// single shape, so both halves are readable even when only one has something to say.
fn names_or_none(names: &[&str]) -> String {
    if names.is_empty() {
        "none".to_owned()
    } else {
        names.join(", ")
    }
}

/// Keep one console child from putting a console window on screen.
///
/// This desktop is a windowed process, so a console child - `git`, `reg.exe`, `taskkill` - would
/// otherwise get a console of its own: with Windows Terminal set as the default terminal
/// application, that shows up as a terminal window titled with the child's path, which is a popup
/// the user never asked for. Every console child of this application is spawned through here.
#[cfg(windows)]
pub(crate) fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn hide_console(_command: &mut Command) {}

/// A spawned host process and its pipes, before the threads take them over.
pub(super) struct HostChild {
    pub(super) child: Child,
    pub(super) stdin: ChildStdin,
    pub(super) stdout: ChildStdout,
    pub(super) stderr: ChildStderr,
    pub(super) pid: u32,
}

/// Starts the verified host artifact with a pinned environment and `--data-root`.
///
/// Everything the host is allowed to know about this machine is written here: the whitelist above
/// (including the toolchain locations the start-up line names, and the toolchain roots derived from
/// what this process can see under its own profile), then the five locations the host asserts at
/// start-up, then the keys of the user-defined providers. The process gets its own directory as
/// `cwd`, because the host belongs to no workspace - a session names its own working directory in
/// `session_open`.
pub(super) fn spawn(
    paths: &DataPaths,
    artifact: &HostArtifact,
    custom_env: &[(String, String)],
) -> IpcResult<HostChild> {
    let mut command = Command::new(&artifact.program);
    // A compiled artifact carries its own settings; a bundle names its runtime flags and entry
    // here, and its own arguments must come before `--data-root`.
    command.args(&artifact.args);
    command.arg("--data-root").arg(&paths.data_root);
    command.current_dir(&paths.host_root);
    command.env_clear();
    let environment = host_environment(
        paths,
        credentials::provider_keys(custom_env),
        |name| std::env::var_os(name),
        |path| path.is_dir(),
    );
    // The disclosure a widened whitelist owes: names only, written before the child exists so that
    // a spawn that then fails still says what the host was about to be given.
    log::info(&toolchain_disclosure(
        &environment.passed_through,
        &environment.synthesized,
    ));
    command.envs(environment.entries);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so the kill path can take the whole tree down.
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| {
        IpcError::new(
            ENGINE_SPAWN_FAILED,
            "The engine host process could not be started.",
        )
    })?;
    let pid = child.id();
    // A host started while the reader is in another application is born demoted, instead of running
    // at normal priority until the next focus change (`services::process_tuning`).
    crate::services::process_tuning::adopt_host(pid);
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| IpcError::new(ENGINE_SPAWN_FAILED, "The host stdin pipe is unavailable."))?;
    let stdout = child.stdout.take().ok_or_else(|| {
        IpcError::new(ENGINE_SPAWN_FAILED, "The host stdout pipe is unavailable.")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        IpcError::new(ENGINE_SPAWN_FAILED, "The host stderr pipe is unavailable.")
    })?;
    Ok(HostChild {
        child,
        stdin,
        stdout,
        stderr,
        pid,
    })
}

/// Starts the stdin writer, the bounded stdout reader and the stderr collector.
///
/// Any failure here leaves a live child behind, so the caller kills the process tree.
///
/// The inbound queue is bounded, and the reader thread sends into it with `blocking_send`: when the
/// dispatcher falls behind, this thread stops reading and the host's own write blocks behind it,
/// which is the backpressure that keeps a fast host from filling this process's memory. The close
/// notice is the one message that must not wait - nothing will drain the queue after EOF - so it is
/// offered rather than sent.
pub(super) fn start_worker_threads(
    stdin_receiver: std::sync::mpsc::Receiver<Vec<u8>>,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
    shared: Arc<HostShared>,
    inbound: mpsc::Sender<Inbound>,
    budget: Arc<InboundBudget>,
) -> IpcResult<()> {
    let mut writer = stdin;
    std::thread::Builder::new()
        .name("omp-host-stdin".to_owned())
        .spawn(move || {
            // Dropping the receiver ends this thread, which drops stdin and lets the host exit.
            while let Ok(bytes) = stdin_receiver.recv() {
                if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        })
        .map_err(|_| IpcError::new(ENGINE_SPAWN_FAILED, "The host writer thread failed."))?;

    let reader_shared = shared.clone();
    std::thread::Builder::new()
        .name("omp-host-stdout".to_owned())
        .spawn(move || {
            let mut reader = BufReader::with_capacity(64 * 1024, stdout);
            let mut decoder = FrameDecoder::new(*lock(&reader_shared.limits));
            let mut buffer = Vec::with_capacity(16 * 1024);
            loop {
                // The decoder's limits are refreshed after every decoded frame, so this read
                // takes the currently advertised ceiling without touching the shared lock.
                let limit = decoder.limits().max_frame_bytes;
                match read_line(&mut reader, &mut buffer, limit) {
                    Ok(LineRead::Line) => {}
                    Ok(LineRead::Overflow) => {
                        // The oversized line is already drained, so the stream is still framed and
                        // this counts as exactly one rejected frame.
                        let reason = format!(
                            "a stdout line exceeded the {limit} byte frame limit and was discarded"
                        );
                        if inbound.blocking_send(Inbound::Malformed(reason)).is_err() {
                            break;
                        }
                        continue;
                    }
                    Ok(LineRead::Eof) | Err(_) => break,
                }
                while matches!(buffer.last().copied(), Some(b'\n') | Some(b'\r')) {
                    buffer.pop();
                }
                match decoder.push_line(&buffer) {
                    Decoded::Skipped => {}
                    Decoded::Malformed(reason) => {
                        if inbound.blocking_send(Inbound::Malformed(reason)).is_err() {
                            break;
                        }
                    }
                    Decoded::Frame(value, bytes) => {
                        // Stamped before the frame is queued: the liveness watcher asks whether
                        // the host said anything, and a frame waiting behind a slow dispatcher is
                        // still a host that answered.
                        reader_shared.last_frame_ms.store(
                            crate::services::store::now_ms().max(1) as u64,
                            std::sync::atomic::Ordering::Relaxed,
                        );
                        apply_advertised_limits(&value, &reader_shared);
                        let advertised = *lock(&reader_shared.limits);
                        if decoder.limits() != advertised {
                            decoder.set_limits(advertised);
                        }
                        // The queue is charged by bytes before the frame is handed over, so a host
                        // that speaks in full-size frames waits on the pipe instead of filling this
                        // process's memory. The dispatcher returns the charge once it has handled
                        // the frame, and closes the budget when it stops - which is the only other
                        // way this wait ends.
                        if !budget.charge(bytes) {
                            break;
                        }
                        if inbound.blocking_send(Inbound::Frame(value, bytes)).is_err() {
                            // Nothing is going to take this frame, so its charge goes back before
                            // this thread leaves.
                            budget.release(bytes);
                            break;
                        }
                    }
                }
            }
            // EOF: nothing will drain the queue from here on, so the close notice is offered
            // rather than sent - a full queue at this point must not leave the dispatcher waiting.
            let _ = inbound.try_send(Inbound::Closed);
        })
        .map_err(|_| IpcError::new(ENGINE_SPAWN_FAILED, "The host reader thread failed."))?;

    std::thread::Builder::new()
        .name("omp-host-stderr".to_owned())
        .spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buffer = Vec::with_capacity(4096);
            loop {
                match read_line(&mut reader, &mut buffer, MAX_LOG_LINE_BYTES) {
                    Ok(LineRead::Line) => {}
                    Ok(LineRead::Overflow) => {
                        // Host output is diagnostics only, so an oversized line is dropped with one
                        // note rather than retained.
                        shared.log.line(&format!(
                            "stderr line exceeded {MAX_LOG_LINE_BYTES} bytes and was discarded"
                        ));
                        continue;
                    }
                    Ok(LineRead::Eof) | Err(_) => break,
                }
                let text = String::from_utf8_lossy(&buffer);
                let trimmed = text.trim_end_matches(['\n', '\r']);
                if !trimmed.is_empty() {
                    note_stderr(&shared, trimmed);
                    shared.log.line(trimmed);
                }
            }
        })
        .map_err(|_| IpcError::new(ENGINE_SPAWN_FAILED, "The host log thread failed."))?;
    Ok(())
}

/// Keeps the last non-empty stderr line, redacted. A host that refuses to start explains itself
/// there, and that reason is the only useful thing a failed handshake can be reported with - it
/// is what turns "the host exited" into "the agent directory is not writable".
fn note_stderr(shared: &HostShared, line: &str) {
    let cleaned = line.trim();
    if cleaned.is_empty() {
        return;
    }
    let sanitized = super::super::sanitize_message(cleaned);
    *lock(&shared.stderr_tail) =
        Some(super::super::truncate_on_char_boundary(&sanitized, 240).to_owned());
}

/// The `hello` frame advertises the transport limits.
///
/// A missing `maxReassembledFrameBytes` falls back to the default rather than failing the
/// handshake (contract §8 F7), and either advertisement is clamped: an engine asking for
/// gigabytes must not become gigabytes of buffering for one line or one logical frame.
fn apply_advertised_limits(frame: &Value, shared: &HostShared) {
    if frame.get("type").and_then(Value::as_str) != Some("hello") {
        return;
    }
    let mut current = *lock(&shared.limits);
    let advertised = frame.get("limits");
    if let Some(value) = advertised
        .and_then(|limits| limits.get("maxFrameBytes"))
        .and_then(Value::as_u64)
    {
        current.max_frame_bytes = value.max(1).min(MAX_FRAME_LIMIT as u64) as usize;
    }
    if let Some(value) = advertised
        .and_then(|limits| limits.get("maxReassembledFrameBytes"))
        .and_then(Value::as_u64)
    {
        current.max_reassembled_bytes = (value.max(1) as usize).min(MAX_REASSEMBLED_LIMIT);
    }
    current.protocol_version = super::super::PROTOCOL_VERSION;
    *lock(&shared.limits) = current;
}

/// True once the child has been reaped (or is unreachable), so a caller can stop waiting.
pub(super) fn try_reap(child: &Mutex<Child>) -> bool {
    let mut child = lock(child);
    matches!(child.try_wait(), Ok(Some(_)) | Err(_))
}

/// Terminates the whole process tree, then the child itself.
pub(super) fn kill_tree(child: &Mutex<Child>, pid: u32) {
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut command);
        let _ = command.status();
    }
    #[cfg(unix)]
    {
        // The child runs in its own process group, whose id is the child pid.
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(format!("-{pid}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
    }
    let _ = lock(child).kill();
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use super::*;

    /// A stand-in for `std::env::var_os` over a fixed map: a test that read - or wrote - the real
    /// process environment would race every other test in the binary.
    fn lookup<'a>(
        environment: &'a HashMap<&'a str, &'a str>,
    ) -> impl FnMut(&str) -> Option<OsString> + 'a {
        move |name| environment.get(name).map(|value| OsString::from(*value))
    }

    /// A stand-in for `Path::is_dir` over a fixed set of directories, for the same reason: a
    /// synthesized root must not depend on what the machine running the tests has under its
    /// profile.
    fn directories(present: &[PathBuf]) -> impl FnMut(&Path) -> bool + '_ {
        move |path| present.iter().any(|directory| directory == path)
    }

    fn no_provider_keys() -> credentials::ProviderKeys {
        credentials::ProviderKeys {
            single: Vec::new(),
            multi: Vec::new(),
            env_names: Vec::new(),
            builtin_ids: Vec::new(),
        }
    }

    /// The entry the child would end up with under a name: `Command::envs` applies the entries in
    /// order, so the last one wins.
    fn effective(host: &HostEnvironment, name: &str) -> Option<OsString> {
        host.entries
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    }

    /// The data root every path below is derived from, as a literal so the assertions state the
    /// layout rather than repeat `DataPaths`.
    fn data_root() -> PathBuf {
        PathBuf::from(r"D:\Data\com.omp.desktop")
    }

    /// The whitelist is a filter, not a list of names to set: what this process does not have must
    /// not appear in the child at all, and neither must what it has as an empty value.
    #[test]
    fn only_present_non_empty_whitelisted_variables_reach_the_host() {
        let environment = HashMap::from([
            ("PATH", r"C:\Windows\System32"),
            ("LOCALAPPDATA", r"C:\Users\someone\AppData\Local"),
            ("APPDATA", r"C:\Users\someone\AppData\Roaming"),
            ("NVM_HOME", r"C:\Users\someone\AppData\Roaming\nvm"),
            ("COREPACK_HOME", r"C:\Users\someone\AppData\Local\Corepack"),
            ("BUN_INSTALL", ""),
        ]);
        let host = host_environment(
            &DataPaths::from_root(data_root()),
            no_provider_keys(),
            lookup(&environment),
            directories(&[]),
        );
        // Present and non-empty: carried, with the value unchanged.
        assert_eq!(
            effective(&host, "LOCALAPPDATA"),
            Some(OsString::from(r"C:\Users\someone\AppData\Local"))
        );
        assert_eq!(
            effective(&host, "PATH"),
            Some(OsString::from(r"C:\Windows\System32"))
        );
        assert_eq!(
            effective(&host, "NVM_HOME"),
            Some(OsString::from(r"C:\Users\someone\AppData\Roaming\nvm"))
        );
        assert_eq!(
            effective(&host, "COREPACK_HOME"),
            Some(OsString::from(r"C:\Users\someone\AppData\Local\Corepack"))
        );
        // Present but empty, and absent altogether: neither is set on the child.
        for name in [
            "BUN_INSTALL",
            "VOLTA_HOME",
            "PNPM_HOME",
            "NPM_CONFIG_PREFIX",
            "NVM_SYMLINK",
            "MISE_DATA_DIR",
            "FNM_DIR",
            "HTTPS_PROXY",
        ] {
            assert_eq!(effective(&host, name), None, "{name} must not be passed");
        }
        // Exactly the toolchain variables that were handed through are disclosed, in whitelist
        // order - a name that was not passed is not named either, and nothing was synthesized
        // because the profile in this environment holds no toolchain directory.
        assert_eq!(
            host.passed_through,
            ["LOCALAPPDATA", "APPDATA", "NVM_HOME", "COREPACK_HOME"]
        );
        assert!(host.synthesized.is_empty());
    }

    /// A rotation pool cannot ride the provider's own variable; it travels as one JSON object
    /// under `PROVIDER_KEYS_ENV`, beside the single-key variables that keep their old shape. The
    /// same object carries every keyed provider's variable as the allow-list a live frame is
    /// checked against.
    #[test]
    fn a_rotation_pool_travels_as_one_json_map() {
        let host = host_environment(
            &DataPaths::from_root(data_root()),
            credentials::ProviderKeys {
                single: vec![("ANTHROPIC_API_KEY".to_owned(), "one".to_owned())],
                multi: vec![credentials::ProviderKeySet {
                    provider: "edge".to_owned(),
                    env: "EDGE_KEY".to_owned(),
                    keys: vec!["k-one".to_owned(), "k-two".to_owned()],
                }],
                env_names: vec![
                    ("anthropic".to_owned(), "ANTHROPIC_API_KEY".to_owned()),
                    ("edge".to_owned(), "EDGE_KEY".to_owned()),
                ],
                builtin_ids: vec!["anthropic".to_owned(), "openai".to_owned()],
            },
            lookup(&HashMap::new()),
            directories(&[]),
        );
        assert_eq!(
            effective(&host, "ANTHROPIC_API_KEY"),
            Some(OsString::from("one"))
        );
        let raw = effective(&host, PROVIDER_KEYS_ENV).expect("pool variable");
        let parsed: Value = serde_json::from_str(raw.to_str().expect("utf-8")).expect("json");
        assert_eq!(parsed["pools"]["edge"]["env"], "EDGE_KEY");
        assert_eq!(
            parsed["pools"]["edge"]["keys"],
            serde_json::json!(["k-one", "k-two"])
        );
        assert_eq!(parsed["env"]["anthropic"], "ANTHROPIC_API_KEY");
        assert_eq!(parsed["env"]["edge"], "EDGE_KEY");
        assert_eq!(
            parsed["builtin"],
            serde_json::json!(["anthropic", "openai"])
        );
    }

    /// Pinning is the part of the environment that decides where the engine writes (contract
    /// §1.3). A whitelisted `HOME` / `USERPROFILE` must not survive it, and no toolchain variable -
    /// handed through or synthesized - may reposition a data location either.
    #[test]
    fn pinned_locations_override_the_whitelist_and_stay_under_the_data_root() {
        let root = data_root();
        let host_root = root.join("host");
        let environment = HashMap::from([
            ("HOME", r"C:\Users\someone"),
            ("USERPROFILE", r"C:\Users\someone"),
            ("LOCALAPPDATA", r"C:\Users\someone\AppData\Local"),
            ("VOLTA_HOME", r"C:\Users\someone\AppData\Local\Volta"),
        ]);
        // The profile this process can see holds a bun install, so `BUN_INSTALL` is synthesized
        // for the child just as it would be on a machine that has one - and the pinned keys below
        // keep their data-root values regardless.
        let present = [PathBuf::from(r"C:\Users\someone\.bun")];
        let provider_keys = credentials::ProviderKeys {
            single: vec![("ANTHROPIC_API_KEY".to_owned(), "stored-key".to_owned())],
            multi: Vec::new(),
            env_names: vec![("anthropic".to_owned(), "ANTHROPIC_API_KEY".to_owned())],
            builtin_ids: vec!["anthropic".to_owned()],
        };
        let host = host_environment(
            &DataPaths::from_root(root.clone()),
            provider_keys,
            lookup(&environment),
            directories(&present),
        );
        assert_eq!(
            effective(&host, "HOME"),
            Some(root.join("home").into_os_string())
        );
        assert_eq!(
            effective(&host, "USERPROFILE"),
            Some(root.join("home").into_os_string())
        );
        assert_eq!(
            effective(&host, "PI_CODING_AGENT_DIR"),
            Some(host_root.join("agent").into_os_string())
        );
        assert_eq!(
            effective(&host, "OMP_DESKTOP_CODING_AGENT_DIR"),
            Some(host_root.join("agent").into_os_string())
        );
        assert_eq!(
            effective(&host, "XDG_DATA_HOME"),
            Some(host_root.join("xdg").into_os_string())
        );
        assert_eq!(
            effective(&host, "OMP_WORKTREE_DIR"),
            Some(host_root.join("worktrees").into_os_string())
        );
        assert_eq!(
            effective(&host, "PI_CONFIG_DIR"),
            Some(OsString::from("omp-desktop"))
        );
        // The toolchain variables are carried unchanged - they locate a tool, not a data location,
        // and the pinned keys above keep their data-root values regardless of them.
        assert_eq!(
            effective(&host, "LOCALAPPDATA"),
            Some(OsString::from(r"C:\Users\someone\AppData\Local"))
        );
        assert_eq!(
            effective(&host, "VOLTA_HOME"),
            Some(OsString::from(r"C:\Users\someone\AppData\Local\Volta"))
        );
        // The synthesized root is the real profile's `.bun`, outside the data root: it locates the
        // tool, and nothing under it is ever read as a data location.
        assert_eq!(
            effective(&host, "BUN_INSTALL"),
            Some(OsString::from(r"C:\Users\someone\.bun"))
        );
        assert_eq!(
            effective(&host, "ANTHROPIC_API_KEY"),
            Some(OsString::from("stored-key"))
        );
    }

    /// What the environment already carries is the value the child gets: a root this process knows
    /// from its own profile never replaces one the environment handed over.
    #[test]
    fn the_environment_wins_over_a_profile_that_could_be_synthesized() {
        let environment = HashMap::from([
            ("LOCALAPPDATA", r"C:\Users\someone\AppData\Local"),
            ("VOLTA_HOME", r"D:\Volta"),
        ]);
        let present = [PathBuf::from(r"C:\Users\someone\AppData\Local\Volta")];
        let host = host_environment(
            &DataPaths::from_root(data_root()),
            no_provider_keys(),
            lookup(&environment),
            directories(&present),
        );
        assert_eq!(
            effective(&host, "VOLTA_HOME"),
            Some(OsString::from(r"D:\Volta"))
        );
        assert_eq!(host.passed_through, ["LOCALAPPDATA", "VOLTA_HOME"]);
        assert!(host.synthesized.is_empty());
    }

    /// A launcher that only knows `USERPROFILE` cannot see its own root once that variable is
    /// pinned, so the root this process can see under its real profile is filled in.
    #[test]
    fn a_toolchain_root_the_environment_lacks_is_synthesized_from_the_visible_profile() {
        let environment = HashMap::from([
            ("LOCALAPPDATA", r"C:\Users\someone\AppData\Local"),
            ("USERPROFILE", r"C:\Users\someone"),
        ]);
        let present = [
            PathBuf::from(r"C:\Users\someone\AppData\Local\Volta"),
            PathBuf::from(r"C:\Users\someone\.bun"),
        ];
        let host = host_environment(
            &DataPaths::from_root(data_root()),
            no_provider_keys(),
            lookup(&environment),
            directories(&present),
        );
        // Absolute, and the real profile's own root - not the pinned `USERPROFILE`, which is what
        // the child would otherwise resolve a manager against.
        assert_eq!(
            effective(&host, "VOLTA_HOME"),
            Some(OsString::from(r"C:\Users\someone\AppData\Local\Volta"))
        );
        assert_eq!(
            effective(&host, "BUN_INSTALL"),
            Some(OsString::from(r"C:\Users\someone\.bun"))
        );
        assert_eq!(host.synthesized, ["VOLTA_HOME", "BUN_INSTALL"]);
        // `USERPROFILE` is a whitelisted base, not a disclosed toolchain variable: it is carried,
        // but the start-up line does not name it.
        assert_eq!(host.passed_through, ["LOCALAPPDATA"]);
    }

    /// Synthesis is conditional on what this process can actually see: no base to look under, or no
    /// directory under it, and the child is left exactly as it was before the rule existed.
    #[test]
    fn a_toolchain_root_is_not_synthesized_without_a_visible_directory() {
        let both_roots = [
            PathBuf::from(r"C:\Users\someone\AppData\Local\Volta"),
            PathBuf::from(r"C:\Users\someone\.bun"),
        ];
        for (environment, visible) in [
            // The base variables are there, the directories under them are not.
            (
                HashMap::from([
                    ("LOCALAPPDATA", r"C:\Users\someone\AppData\Local"),
                    ("USERPROFILE", r"C:\Users\someone"),
                ]),
                false,
            ),
            // The directories are there, but this process has no profile to look them up under.
            (HashMap::<&str, &str>::new(), true),
        ] {
            let present: &[PathBuf] = if visible { &both_roots } else { &[] };
            let host = host_environment(
                &DataPaths::from_root(data_root()),
                no_provider_keys(),
                lookup(&environment),
                directories(present),
            );
            for name in ["VOLTA_HOME", "BUN_INSTALL"] {
                assert_eq!(effective(&host, name), None, "{name} must not be invented");
            }
            assert!(host.synthesized.is_empty());
        }
    }

    /// An empty value is not a root - the whitelist drops it - so the profile-derived one still
    /// fills the gap instead of leaving the launcher to read a nonsense path.
    #[test]
    fn an_empty_toolchain_value_is_replaced_by_the_visible_profile() {
        let environment = HashMap::from([
            ("LOCALAPPDATA", r"C:\Users\someone\AppData\Local"),
            ("VOLTA_HOME", ""),
        ]);
        let present = [PathBuf::from(r"C:\Users\someone\AppData\Local\Volta")];
        let host = host_environment(
            &DataPaths::from_root(data_root()),
            no_provider_keys(),
            lookup(&environment),
            directories(&present),
        );
        assert_eq!(
            effective(&host, "VOLTA_HOME"),
            Some(OsString::from(r"C:\Users\someone\AppData\Local\Volta"))
        );
        assert_eq!(host.passed_through, ["LOCALAPPDATA"]);
        assert_eq!(host.synthesized, ["VOLTA_HOME"]);
    }

    /// The disclosure line is the record of a widened whitelist and of a derived value: it names
    /// both groups and says nothing else about them.
    #[test]
    fn the_start_up_line_separates_handed_through_from_synthesized_names() {
        let environment = HashMap::from([
            ("LOCALAPPDATA", r"C:\Users\someone\AppData\Local"),
            ("USERPROFILE", r"C:\Users\someone"),
            ("BUN_INSTALL", r"C:\Users\someone\.bun"),
        ]);
        let present = [PathBuf::from(r"C:\Users\someone\AppData\Local\Volta")];
        let host = host_environment(
            &DataPaths::from_root(data_root()),
            no_provider_keys(),
            lookup(&environment),
            directories(&present),
        );
        let line = toolchain_disclosure(&host.passed_through, &host.synthesized);
        assert_eq!(
            line,
            "host environment: toolchain variables handed through from this process: \
             LOCALAPPDATA, BUN_INSTALL; synthesized from this process's profile: VOLTA_HOME"
        );
        for leaked in ["someone", "AppData", r"C:\", ".bun"] {
            assert!(!line.contains(leaked), "{leaked} is a value, not a name");
        }
        // A group with nothing to report is spelled out rather than left off, so the line keeps
        // one shape and both halves stay readable.
        assert_eq!(
            toolchain_disclosure(&["LOCALAPPDATA"], &[]),
            "host environment: toolchain variables handed through from this process: LOCALAPPDATA; \
             synthesized from this process's profile: none"
        );
        assert_eq!(
            toolchain_disclosure(&[], &["VOLTA_HOME"]),
            "host environment: toolchain variables handed through from this process: none; \
             synthesized from this process's profile: VOLTA_HOME"
        );
        assert_eq!(
            toolchain_disclosure(&[], &[]),
            "host environment: no toolchain variable was handed through or synthesized"
        );
    }
}

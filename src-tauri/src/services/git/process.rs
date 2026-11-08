//! The git process boundary: spawning one `git` with an empty stdin, reading its stdout under a
//! byte limit and giving up on it after a timeout.
//!
//! Every command in this module runs with an explicit working directory and an argument vector -
//! no shell is involved - and no command here ever writes to the repository. The limits live in
//! this one place, so a review, a stage and a commit are all bounded the same way.

use std::{
    ffi::OsStr,
    io::Read,
    path::Path,
    process::{Child, Command, ExitStatus, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use crate::services::log;
use crate::services::runtime::host::process::hide_console;

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

/// Ceiling on the stdout of one git command; beyond it the command reports `exceeded` instead of
/// accumulating more.
pub(super) const GIT_COMMAND_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
/// Time one git command gets before it is killed.
pub(super) const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// Ceiling on one file's patch, for the single-file reader and for what a batch keeps per file.
pub(super) const PATCH_LIMIT: usize = 200 * 1024;

/// Git processes spawned by this test binary: the review benchmark reports how many processes a
/// review costs. Counting is process-wide because a review spawns them from scoped threads.
#[cfg(test)]
pub(super) static GIT_PROCESSES: AtomicUsize = AtomicUsize::new(0);

#[cfg(test)]
pub(super) fn git_processes() -> usize {
    GIT_PROCESSES.load(Ordering::Relaxed)
}

#[cfg(test)]
pub(super) fn reset_git_processes() {
    GIT_PROCESSES.store(0, Ordering::Relaxed);
}

/// One command's captured stdout plus how it ended.
pub(super) struct LimitedOutput {
    pub(super) status: ExitStatus,
    pub(super) stdout: Vec<u8>,
    /// The command wrote more than the limit it was read under, so `stdout` holds only a prefix.
    pub(super) exceeded: bool,
}

/// Spawns one git process in `root` with an empty stdin. `stdout` is `Stdio::piped()` for the
/// commands whose output is read and `Stdio::null()` for the ones that only report an exit status;
/// `stderr` is piped for the commands whose failure has to be explained to the reader
/// ([`run_git_command`]) and discarded for the reads, whose answer is the output itself.
pub(super) fn spawn_git(
    root: &Path,
    command: &mut Command,
    stdout: Stdio,
    stderr: Stdio,
    error: &'static str,
) -> Result<Child, String> {
    #[cfg(test)]
    GIT_PROCESSES.fetch_add(1, Ordering::Relaxed);
    hide_console(command);
    // `git status` refreshes its stat cache by rewriting `.git/index` when it is allowed to take the
    // optional locks, and the workspace watch would see that write and answer it with a refresh -
    // a loop with no user-visible change behind it. `GIT_OPTIONAL_LOCKS=0` gives up only those
    // optional locks: a real write (`add`, `commit`) still takes the ones it needs.
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
        .map_err(|_| error.to_owned())
}

pub(super) fn wait_for_git(
    mut child: Child,
    timeout_message: &'static str,
) -> Result<ExitStatus, String> {
    let deadline = Instant::now() + GIT_COMMAND_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                // A command that had to be killed is not a routine "not a repository": it is the
                // signature of a hung git or a filesystem that stopped answering, and the panel
                // shows only that the row failed. One line per timed-out command, no more.
                log::warn(&format!("omp: a git command timed out: {timeout_message}"));
                return Err(timeout_message.to_owned());
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn(&format!(
                    "omp: git could not be waited on and was killed: {timeout_message}"
                ));
                return Err(timeout_message.to_owned());
            }
        }
    }
}

/// Reads `stdout` up to `limit` bytes while the process runs, draining the rest so it cannot block
/// on a full pipe. `exceeded` reports that the limit was passed.
fn read_bounded_stdout(mut stdout: impl Read, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let mut buffer = [0_u8; 8192];
    let mut exceeded = false;
    loop {
        let read = stdout.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        if remaining > 0 {
            bytes.extend_from_slice(&buffer[..read.min(remaining)]);
        }
        if read > remaining {
            exceeded = true;
        }
    }
    Ok((bytes, exceeded))
}

/// Waits for `child` while its stdout is read on a second thread, so a command that writes more
/// than a pipe buffer can still finish.
pub(super) fn collect_git_output(
    mut child: Child,
    limit: usize,
    error_message: &'static str,
) -> Result<LimitedOutput, String> {
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error_message.to_owned());
    };
    let reader = thread::spawn(move || read_bounded_stdout(stdout, limit));
    let status = match wait_for_git(child, error_message) {
        Ok(status) => status,
        Err(error) => {
            let _ = reader.join();
            return Err(error);
        }
    };
    let (stdout, exceeded) = reader
        .join()
        .map_err(|_| error_message.to_owned())?
        .map_err(|_| error_message.to_owned())?;
    Ok(LimitedOutput {
        status,
        stdout,
        exceeded,
    })
}

/// Runs one git command to completion. The output is capped at `GIT_COMMAND_OUTPUT_LIMIT`; a
/// command that writes past it is an error rather than a silently shortened result.
pub(super) fn run_git<T: AsRef<OsStr>>(root: &Path, args: &[T]) -> Result<Output, String> {
    let mut command = Command::new("git");
    for arg in args {
        command.arg(arg.as_ref());
    }
    let child = spawn_git(
        root,
        &mut command,
        Stdio::piped(),
        Stdio::null(),
        "Git is unavailable",
    )?;
    let result = collect_git_output(child, GIT_COMMAND_OUTPUT_LIMIT, "Git command failed")?;
    if result.exceeded {
        return Err("Git output is too large".to_owned());
    }
    Ok(Output {
        status: result.status,
        stdout: result.stdout,
        stderr: Vec::new(),
    })
}

/// Diffs one untracked file against the empty file, which is the only shape git offers for a path
/// the index does not know. The patch is capped at `PATCH_LIMIT`.
pub(super) fn run_git_patch(root: &Path, path: &str) -> Result<LimitedOutput, String> {
    let mut command = Command::new("git");
    command.args([
        "diff",
        "--no-index",
        "--binary",
        "--no-color",
        "--no-ext-diff",
        "--unified=3",
        "--",
    ]);
    #[cfg(target_os = "windows")]
    command.arg("NUL");
    #[cfg(not(target_os = "windows"))]
    command.arg("/dev/null");
    command.arg(path);

    let child = spawn_git(
        root,
        &mut command,
        Stdio::piped(),
        Stdio::null(),
        "Unable to read git changes",
    )?;
    collect_git_output(child, PATCH_LIMIT, "Unable to read git changes")
}

/// Which revision a side of the review is read from: the index, the worktree, or - for a path the
/// index does not know - the empty file, which is what makes an untracked file readable.
#[derive(Clone, Copy)]
pub(super) enum PatchSource {
    Cached,
    Worktree,
    NoIndex,
}

/// Reads one side of the review for every requested path at once: either the patches or, with
/// `numstat`, the per-file counts.
pub(super) fn run_git_patch_batch(
    root: &Path,
    source: PatchSource,
    paths: Option<&[String]>,
    numstat: bool,
) -> Result<LimitedOutput, String> {
    let mut command = Command::new("git");
    match source {
        PatchSource::Cached => {
            command.args(["diff", "--cached"]);
        }
        PatchSource::Worktree => {
            command.args(["diff"]);
        }
        PatchSource::NoIndex => return Err("Unable to read git changes".to_owned()),
    }
    if numstat {
        command.args([
            "--numstat",
            "-z",
            "--no-color",
            "--no-ext-diff",
            "--find-renames",
        ]);
    } else {
        command.args([
            "--binary",
            "--no-color",
            "--no-ext-diff",
            "--unified=3",
            "--find-renames",
        ]);
    }
    command.arg("--");
    if let Some(paths) = paths {
        for path in paths {
            command.arg(path);
        }
    }

    let child = spawn_git(
        root,
        &mut command,
        Stdio::piped(),
        Stdio::null(),
        "Unable to read git changes",
    )?;
    collect_git_output(
        child,
        GIT_COMMAND_OUTPUT_LIMIT,
        "Unable to read git changes",
    )
}

/// Ceiling on the stderr a failing command keeps as its own explanation.
pub(super) const GIT_DIAGNOSIS_LIMIT: usize = 2 * 1024;

/// One command that changes the repository, with git's own words about how it ended.
pub(super) struct DiagnosedOutput {
    pub(super) status: ExitStatus,
    /// What git wrote to stderr, bounded and not yet filtered: the caller decides which line is
    /// the one the reader needs.
    pub(super) diagnosis: String,
}

/// Runs one git command whose failure the panel has to explain, keeping the stderr it wrote.
///
/// A single sentence from this side ("Unable to stage workspace file") says only that something
/// went wrong: it names neither the file nor the reason, and a pathspec that no longer matches, a
/// permission error and a held index lock all read the same. git's own line names both, so it is
/// read alongside the exit status and handed to the caller.
pub(super) fn run_git_command(
    root: &Path,
    command: &mut Command,
    error: &'static str,
    timeout: &'static str,
) -> Result<DiagnosedOutput, String> {
    let mut child = spawn_git(root, command, Stdio::null(), Stdio::piped(), error)?;
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.to_owned());
    };
    let reader = thread::spawn(move || read_bounded_stdout(stderr, GIT_DIAGNOSIS_LIMIT));
    let status = match wait_for_git(child, timeout) {
        Ok(status) => status,
        Err(error) => {
            let _ = reader.join();
            return Err(error);
        }
    };
    let diagnosis = reader
        .join()
        .ok()
        .and_then(Result::ok)
        .map(|(bytes, _)| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    Ok(DiagnosedOutput { status, diagnosis })
}

/// [`run_git_command`] for a command that is just `git` and its arguments.
pub(super) fn run_git_diagnosed<T: AsRef<OsStr>>(
    root: &Path,
    args: &[T],
    error: &'static str,
    timeout: &'static str,
) -> Result<DiagnosedOutput, String> {
    let mut command = Command::new("git");
    for arg in args {
        command.arg(arg.as_ref());
    }
    run_git_command(root, &mut command, error, timeout)
}

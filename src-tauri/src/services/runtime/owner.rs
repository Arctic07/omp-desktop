//! The pid of the host this run started, and the one an earlier run left behind.
//!
//! The engine host is a child process, and every ordinary way it ends is covered already: the stdin
//! pipe closing makes it exit, `kill_tree` takes its process tree down, and a crash is seen by the
//! supervisor. None of those run when **this** process dies without warning - a hard kill, a power
//! loss, an abort - and the host it left is then a live process nobody owns: it still holds its
//! sessions, its engine and its file handles, and the next start has no way to tell it apart from a
//! process it did not start.
//!
//! So the pid is written where the next start can read it ([`record`]), removed when this run ends
//! the way it means to ([`forget`]), and checked once at start-up ([`sweep`]). The check is what makes
//! this safe: **a pid is not an identity** - Windows reuses them - so the recorded number is only
//! acted on when the process it names is running *our* host binary, resolved by path. A pid that is
//! gone, a pid whose executable is anything else (the reader's own `omp.exe`, another tool), and a
//! pid this process cannot query are all left alone, and the file is cleared either way so the next
//! start does not repeat the question.
//!
//! **Owner / bound / release.** One file, `<data_root>/owner.pid`, one line of digits: the host that
//! is currently running. It is rewritten on every spawn and removed on the paths that end one.

use std::path::{Path, PathBuf};

use crate::services::log;
use crate::services::paths::DataPaths;

/// The file, directly in the data root: the one directory every run of this installation can find
/// before it has read anything else.
const OWNER_FILE: &str = "owner.pid";

/// What a sweep found, for the one line it writes.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Swept {
    /// The pid of a host an earlier run left, killed by this one.
    pub(crate) killed: Option<u32>,
    /// A recorded pid this run left alone, and why.
    pub(crate) kept: Option<u32>,
}

/// Records the host this run just started.
///
/// A failure is a log line and nothing else: losing the file costs one orphan's worth of trouble in
/// a crash, while failing a start over it would cost the run.
pub(crate) fn record(paths: &DataPaths, pid: u32) {
    let file = owner_file(paths);
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(&file, pid.to_string()).is_err() {
        log::warn("host owner: the pid of the running host could not be recorded");
    }
}

/// Forgets it: this run is ending.
pub(crate) fn forget(paths: &DataPaths) {
    let _ = std::fs::remove_file(owner_file(paths));
}

/// Kills a host an earlier run left behind, if the pid still names one of ours.
///
/// `expected` is this build's host binary, resolved and verified by the caller
/// (`services::host_bin`): the recorded pid is only killed when it is running exactly that path.
pub(crate) fn sweep(paths: &DataPaths, expected: &Path) -> Swept {
    let file = owner_file(paths);
    let recorded = std::fs::read_to_string(&file)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok());
    let Some(pid) = recorded.filter(|pid| *pid > 0) else {
        // Nothing recorded, or a file this build cannot read: there is no process to judge, and a
        // file that says nothing is not worth keeping.
        let _ = std::fs::remove_file(&file);
        return Swept::default();
    };
    let swept = match decide(pid, executable_of(pid).as_deref(), expected) {
        Action::Forget => Swept::default(),
        Action::Keep(pid) => Swept {
            killed: None,
            kept: Some(pid),
        },
        Action::Kill(pid) => {
            kill(pid);
            Swept {
                killed: Some(pid),
                kept: None,
            }
        }
    };
    let _ = std::fs::remove_file(&file);
    swept
}

/// What the recorded pid deserves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    /// Nothing is running behind it, or it cannot be asked: leave it, and clear the file.
    Forget,
    /// It is running this build's host: take its process tree down.
    Kill(u32),
    /// It is running something else: leave it alone, and say so.
    Keep(u32),
}

/// The rule, with the two facts it needs as arguments.
///
/// Split out because both facts need the operating system: a test drives every branch of the decision
/// without spawning - or shooting - a process, and the manual check (the note for this change) covers
/// the real kill.
fn decide(pid: u32, running: Option<&Path>, expected: &Path) -> Action {
    let Some(running) = running else {
        // The pid is gone, or this process may not ask what it is running: nothing to do.
        return Action::Forget;
    };
    if same_executable(running, expected) {
        Action::Kill(pid)
    } else {
        Action::Keep(pid)
    }
}

/// Whether two paths name the same file, as far as this decision needs.
///
/// Compared after normalization (separators, case, the verbatim prefix) and *not* after resolving
/// links: the recorded path is the artifact this build verified, and the running image's path is
/// what the loader opened, which is the same file by the time either is a process.
fn same_executable(left: &Path, right: &Path) -> bool {
    crate::services::paths::normalize_for_compare(left)
        == crate::services::paths::normalize_for_compare(right)
}

/// The validated path of one running process, or `None` when it is gone or unreadable.
#[cfg(windows)]
fn executable_of(pid: u32) -> Option<PathBuf> {
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// Room for any path this platform allows, plus the terminator the call writes.
    const CAPACITY: usize = 32_768;

    let mut buffer = vec![0u16; CAPACITY];
    let mut length = CAPACITY as u32;
    // SAFETY: one handle, closed on both paths; the call writes at most `length` UTF-16 units into a
    // buffer of that size, and `length` is updated by it on success.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if handle.is_null() {
            return None;
        }
        let queried = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            buffer.as_mut_ptr(),
            &mut length,
        );
        CloseHandle(handle);
        if queried == FALSE || length == 0 {
            return None;
        }
        buffer.truncate(length as usize);
    }
    String::from_utf16(&buffer).ok().map(PathBuf::from)
}

/// The same question where a process's image is a file in `/proc`.
#[cfg(not(windows))]
fn executable_of(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

/// Terminates one process and its children, by pid.
///
/// The same tool the supervisor uses (`super::host::process::kill_tree`), and for the same reason: a host
/// has children of its own - language servers, MCP servers, a browser - and killing the parent alone
/// would leave them.
fn kill(pid: u32) {
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("taskkill");
        command
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            /// `CREATE_NO_WINDOW`: this desktop is a windowed process, and a console window flashed
            /// in front of the reader would be the only visible part of a silent recovery.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = command.status();
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .arg("-KILL")
            .arg(pid.to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
    }
}

/// The one line a sweep leaves behind, when it has something to say.
pub(crate) fn report(swept: Swept) {
    if let Some(pid) = swept.killed {
        log::info(&format!(
            "host owner: reclaimed host process {pid} an earlier run left behind"
        ));
    }
    if let Some(pid) = swept.kept {
        log::info(&format!(
            "host owner: process {pid} was recorded by an earlier run but is not this build's host; left alone"
        ));
    }
}

fn owner_file(paths: &DataPaths) -> PathBuf {
    paths.data_root.join(OWNER_FILE)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn root(tag: &str) -> (DataPaths, PathBuf) {
        let root = std::env::temp_dir().join(format!("omp-owner-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("data root");
        (DataPaths::from_root(root.clone()), root)
    }

    /// A pid no test process can hold: the sweep's own operating-system query answers "gone".
    const DEAD_PID: u32 = 4_000_000;

    #[test]
    fn a_recorded_pid_is_written_and_forgotten() {
        let (paths, root_dir) = root("record");
        assert!(!owner_file(&paths).exists(), "a fresh root has no owner");

        record(&paths, 4242);
        assert_eq!(
            fs::read_to_string(owner_file(&paths)).expect("the file"),
            "4242"
        );

        forget(&paths);
        assert!(!owner_file(&paths).exists(), "a clean exit leaves nothing");
        let _ = fs::remove_dir_all(&root_dir);
    }

    #[test]
    fn a_pid_that_is_not_running_is_left_alone_and_forgotten() {
        let (paths, root_dir) = root("gone");
        record(&paths, DEAD_PID);

        let swept = sweep(&paths, Path::new("D:/build/target/release/omp-host.exe"));

        assert_eq!(swept, Swept::default());
        assert!(!owner_file(&paths).exists(), "the stale file is cleared");
        let _ = fs::remove_dir_all(&root_dir);
    }

    #[test]
    fn a_foreign_executable_behind_the_pid_is_never_killed() {
        let build = Path::new("D:/build/target/release/omp-host.exe");
        // The pid is running, but it is the reader's own omp.exe - or an unrelated process whose pid
        // was reused. The recorded number alone is not an identity.
        assert_eq!(
            decide(1234, Some(Path::new("C:/Tools/omp.exe")), build),
            Action::Keep(1234)
        );
        // A different build's host is a different file too.
        assert_eq!(
            decide(
                1234,
                Some(Path::new("D:/other/target/release/omp-host.exe")),
                build
            ),
            Action::Keep(1234)
        );
    }

    #[test]
    fn a_pid_running_this_builds_host_is_reclaimed() {
        let build = Path::new("D:/build/target/release/omp-host.exe");
        assert_eq!(decide(77, Some(build), build), Action::Kill(77));
        // Case and separators are not part of the identity.
        assert_eq!(
            decide(
                77,
                Some(Path::new("d:/BUILD/target/release/omp-host.exe")),
                build
            ),
            Action::Kill(77)
        );
    }

    #[test]
    fn a_file_that_is_not_a_pid_is_cleared_without_a_kill() {
        let (paths, root_dir) = root("garbage");
        fs::write(owner_file(&paths), "not a pid").expect("a file");

        let swept = sweep(&paths, Path::new("D:/build/target/release/omp-host.exe"));

        assert_eq!(swept, Swept::default());
        assert!(!owner_file(&paths).exists());
        let _ = fs::remove_dir_all(&root_dir);
    }
}

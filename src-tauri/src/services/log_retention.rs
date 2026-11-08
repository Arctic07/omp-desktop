//! How long a log file lives.
//!
//! Two directories hold this application's evidence, and neither is needed for it to work:
//!
//! - `<data_root>/logs` - `app.log` (this application's own lines) and `host.log` (the engine
//!   host's stderr), each beside at most one rotation, plus whatever an earlier build left behind;
//! - `<data_root>/home/omp-desktop/logs` - the engine's own structured logs, one file per host
//!   process (`omp.<day>.<pid>.log`), written by the SDK and named by it.
//!
//! A file per run is the right shape for a report and the wrong shape for a directory: without a
//! bound, an install used every day keeps a file per restart forever, and the one file a reader
//! needs is buried in them. The rule here is the one the reference client uses (its
//! `logging/retention.ts`): **seven days**, applied by modification time - which is also what
//! catches a name that carries no date at all, like the `engine-*.log` files an earlier build wrote
//! into `logs/`. The engine directory gets a count bound on top, because its files are per process
//! rather than per day: twenty restarts on one afternoon must not leave twenty files behind for a
//! week.
//!
//! Nothing that a live process is still writing is removed. `app.log`/`host.log` are skipped by
//! name; an engine file is skipped while the pid in its name is running (the host this application
//! started, and any other engine process sharing the data root). On Windows a delete of a file a
//! process holds open would fail anyway, but an idle host can go a long time without a write - so
//! the liveness check is what makes the bound safe rather than merely lucky.

use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use crate::services::log;
use crate::services::paths::DataPaths;

/// How many days of logs are kept, matching the reference client's retention.
pub(crate) const LOG_RETENTION_DAYS: u64 = 7;

/// How many engine log files survive regardless of age: the newest ones, one per host process.
///
/// Twenty covers the restarts of a working day with room to spare, while an idle week of restarts
/// cannot grow the directory past what one incident report reads through.
const ENGINE_LOG_FILES_KEPT: usize = 20;

/// How often the bound is applied while the application runs. The start-up sweep is the one that
/// matters for a normal session; this is what keeps a window left open for a week from outgrowing
/// the rule without a restart.
const SWEEP_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// The files this run is writing and a sweep must never take: the pair `services::log` and
/// `runtime::EngineLog` append to.
const LIVE_APP_FILES: [&str; 2] = [log::APP_LOG_FILE, "host.log"];

/// What one sweep removed, for the one line it leaves in the log.
#[derive(Default, Clone, Copy)]
pub(crate) struct Swept {
    pub(crate) files: usize,
    pub(crate) bytes: u64,
}

impl Swept {
    fn add(&mut self, other: Self) {
        self.files += other.files;
        self.bytes = self.bytes.saturating_add(other.bytes);
    }
}

/// Applies the rule once, to both directories, and answers what it removed.
pub(crate) fn sweep(paths: &DataPaths) -> Swept {
    sweep_at(paths, SystemTime::now())
}

/// The sweep itself, against an explicit clock: a test reaches "eight days later" this way without
/// waiting or touching a file's timestamp.
fn sweep_at(paths: &DataPaths, now: SystemTime) -> Swept {
    let mut swept = sweep_app_directory(&paths.logs, now);
    swept.add(sweep_engine_directory(&paths.engine_logs(), now));
    swept
}

/// The start-up sweep plus the periodic one. Called once per process; the paths are cloned because
/// the task outlives the caller.
pub(crate) fn schedule(paths: DataPaths) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(SWEEP_INTERVAL).await;
            let paths = paths.clone();
            let swept = tauri::async_runtime::spawn_blocking(move || sweep(&paths))
                .await
                .unwrap_or_default();
            report(swept);
        }
    });
}

/// The one line a sweep leaves behind. Silence is the ordinary case: a directory already inside the
/// rule is not worth a record.
pub(crate) fn report(swept: Swept) {
    if swept.files == 0 {
        return;
    }
    log::info(&format!(
        "logs: removed {} file(s) past the {LOG_RETENTION_DAYS}-day window or the engine file bound ({} bytes)",
        swept.files, swept.bytes
    ));
}

/// `<data_root>/logs`: age only. `app.log` and `host.log` are this run's own files and are never
/// candidates, however old their timestamps look on a clock that moved backwards.
fn sweep_app_directory(dir: &Path, now: SystemTime) -> Swept {
    let mut swept = Swept::default();
    for entry in log_entries(dir) {
        if LIVE_APP_FILES.contains(&entry.name.as_str()) || !expired(entry.modified, now) {
            continue;
        }
        swept.add(entry.remove());
    }
    swept
}

/// The engine directory: age, then the count bound over what survives it.
///
/// A file whose process is still running is not a candidate for either rule - it is being written
/// now, and its name is the only handle its writer has.
fn sweep_engine_directory(dir: &Path, now: SystemTime) -> Swept {
    let mut swept = Swept::default();
    let mut survivors: Vec<Entry> = Vec::new();
    for entry in log_entries(dir) {
        if entry.pid.is_some_and(process_alive) {
            continue;
        }
        if expired(entry.modified, now) {
            swept.add(entry.remove());
        } else {
            survivors.push(entry);
        }
    }
    // Newest first: the bound takes from the oldest end, which is the end a report reads last.
    survivors.sort_by_key(|entry| std::cmp::Reverse(entry.modified));
    for entry in survivors.into_iter().skip(ENGINE_LOG_FILES_KEPT) {
        swept.add(entry.remove());
    }
    swept
}

/// One candidate: a plain, non-link file whose name says it is a log.
struct Entry {
    path: PathBuf,
    name: String,
    bytes: u64,
    modified: SystemTime,
    /// The process that wrote an engine log, when the name carries one.
    pid: Option<u32>,
}

impl Entry {
    /// Removes the file and counts it only when the removal succeeded: a file a process still holds,
    /// a directory that vanished between the read and the delete, and a read-only file all leave the
    /// answer honest.
    fn remove(self) -> Swept {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Swept {
                files: 1,
                bytes: self.bytes,
            },
            Err(_) => Swept::default(),
        }
    }
}

/// The log files directly inside `dir`.
///
/// Directories and links are left alone: a link inside a logs directory is not a file this
/// application wrote, and following it would reach outside the data root. Files whose names are not
/// logs are left alone too - the engine keeps its audit marker in the same directory, and a reader
/// who drops a note there should not lose it to a retention rule.
fn log_entries(dir: &Path) -> Vec<Entry> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_log_file(&name) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        found.push(Entry {
            pid: engine_pid(&name),
            path: entry.path(),
            bytes: metadata.len(),
            // A file whose time cannot be read is treated as written now: the sweep must not delete
            // evidence over a timestamp it could not read.
            modified: metadata.modified().unwrap_or_else(|_| SystemTime::now()),
            name,
        });
    }
    found
}

/// True when `modified` is older than [`LOG_RETENTION_DAYS`]. A timestamp in the future is not
/// older than anything.
fn expired(modified: SystemTime, now: SystemTime) -> bool {
    now.duration_since(modified)
        .is_ok_and(|age| age > Duration::from_secs(LOG_RETENTION_DAYS * 24 * 60 * 60))
}

/// Whether a name is a log this module may consider at all: `x.log` or `x.log.<n>`, and nothing
/// else. The rotation suffix is the only dotted tail accepted, so `omp.2026-10-22.1234.log` is a
/// log while `.omp.1234-audit.json` is not.
pub(crate) fn is_log_file(name: &str) -> bool {
    let stem = match name.rsplit_once('.') {
        Some((stem, tail))
            if !tail.is_empty() && tail.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            stem
        }
        _ => name,
    };
    stem.ends_with(".log") && stem.len() > ".log".len()
}

/// The pid in an engine log's name (`omp.<YYYY-MM-DD>.<pid>.log`, rollover suffix or not).
///
/// Anything else answers `None`, which is what keeps the live-process check from being applied to a
/// name that only happens to be a log.
pub(crate) fn engine_pid(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("omp.")?;
    // `<day>.<pid>.log` and `<day>.<pid>.log.<n>`; the rotator's suffix is the only one allowed.
    let (head, tail) = rest.split_once(".log")?;
    if !(tail.is_empty()
        || tail
            .strip_prefix('.')
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|byte| byte.is_ascii_digit())))
    {
        return None;
    }
    let (_, pid) = head.rsplit_once('.')?;
    pid.parse().ok()
}

/// Whether the process is running, so its log is not removed.
///
/// `OpenProcess` with query-only access fails for a pid that no process holds; a handle that opens
/// still has to answer `STILL_ACTIVE`, because a pid can be reused by a process that has already
/// exited.
#[cfg(windows)]
pub(crate) fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// `STILL_ACTIVE`, as `GetExitCodeProcess` reports a process that has not exited.
    const STILL_ACTIVE: u32 = 259;

    if pid == 0 {
        return false;
    }
    // SAFETY: both calls only read; the handle is closed on every path, and `code` is a live local
    // the API writes exactly one `u32` into.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let queried = GetExitCodeProcess(handle, &mut code) != FALSE;
        CloseHandle(handle);
        queried && code == STILL_ACTIVE
    }
}

#[cfg(not(windows))]
pub(crate) fn process_alive(pid: u32) -> bool {
    pid != 0 && Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(test)]
mod tests {
    use std::fs::{FileTimes, OpenOptions};

    use super::*;

    fn fresh_root(name: &str) -> (DataPaths, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("omp-log-retention-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("data root");
        let paths = DataPaths::from_root(root.clone());
        std::fs::create_dir_all(&paths.logs).expect("logs");
        std::fs::create_dir_all(paths.engine_logs()).expect("engine logs");
        (paths, root)
    }

    /// Writes `name` with a modification time `age` in the past.
    fn write_aged(path: &Path, bytes: &str, age: Duration) {
        std::fs::write(path, bytes).expect("a log file");
        let file = OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open the log");
        file.set_times(FileTimes::new().set_modified(SystemTime::now() - age))
            .expect("age the log");
    }

    /// A pid no test process can hold, so the liveness check always answers "gone".
    const DEAD_PID: u32 = 4_000_000;

    #[test]
    fn a_file_past_the_window_is_removed_and_a_fresh_one_stays() {
        let (paths, root) = fresh_root("age");
        write_aged(
            &paths
                .engine_logs()
                .join(format!("omp.2026-10-01.{DEAD_PID}.log")),
            "old",
            Duration::from_secs((LOG_RETENTION_DAYS + 1) * 24 * 60 * 60),
        );
        let fresh = paths
            .engine_logs()
            .join(format!("omp.2026-10-22.{DEAD_PID}.log"));
        write_aged(&fresh, "new", Duration::from_secs(60));

        let swept = sweep(&paths);

        assert_eq!(swept.files, 1);
        assert_eq!(swept.bytes, 3);
        assert!(fresh.exists(), "a file inside the window is kept");
        assert!(!paths
            .engine_logs()
            .join(format!("omp.2026-10-01.{DEAD_PID}.log"))
            .exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// This run's two files survive any timestamp: a clock that moved backwards must not make a
    /// sweep take the file the process is still appending to.
    #[test]
    fn the_running_files_are_never_taken() {
        let (paths, root) = fresh_root("live");
        let old = Duration::from_secs((LOG_RETENTION_DAYS + 1) * 24 * 60 * 60);
        for name in LIVE_APP_FILES {
            write_aged(&paths.logs.join(name), "live", old);
        }
        write_aged(&paths.logs.join("app.log.1"), "stale", old);

        let swept = sweep(&paths);

        assert_eq!(swept.files, 1, "only the rotation was removed");
        for name in LIVE_APP_FILES {
            assert!(paths.logs.join(name).exists(), "{name} is this run's file");
        }
        assert!(!paths.logs.join("app.log.1").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The engine directory is bounded by count as well: a day of restarts leaves the newest
    /// [`ENGINE_LOG_FILES_KEPT`] files, and the sweep says how many went.
    #[test]
    fn the_engine_directory_keeps_only_its_newest_files() {
        let (paths, root) = fresh_root("count");
        let total = ENGINE_LOG_FILES_KEPT + 5;
        for index in 0..total {
            // One file per index needs a distinct day: in reality the pid differs, and the rule here
            // is about the directory's contents, not about a live logger.
            write_aged(
                &paths
                    .engine_logs()
                    .join(format!("omp.2026-10-{:02}.{DEAD_PID}.log", index + 1)),
                "line",
                Duration::from_secs((index as u64) * 60),
            );
        }

        let swept = sweep(&paths);

        assert_eq!(swept.files, total - ENGINE_LOG_FILES_KEPT);
        let left = std::fs::read_dir(paths.engine_logs())
            .expect("engine logs")
            .count();
        assert_eq!(left, ENGINE_LOG_FILES_KEPT);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Files that are not logs, and directories, are not this module's to remove however old they
    /// are.
    #[test]
    fn only_log_files_are_candidates() {
        let (paths, root) = fresh_root("names");
        let old = Duration::from_secs((LOG_RETENTION_DAYS + 1) * 24 * 60 * 60);
        write_aged(&paths.logs.join("notes.txt"), "keep", old);
        write_aged(&paths.logs.join(".omp.1234-audit.json"), "keep", old);
        std::fs::create_dir_all(paths.logs.join("engine-archive")).expect("a directory");
        write_aged(&paths.logs.join("engine-probe.log"), "gone", old);
        write_aged(&paths.logs.join("host.log.1"), "gone", old);

        let swept = sweep(&paths);

        assert_eq!(swept.files, 2, "the two rotated logs");
        assert!(paths.logs.join("notes.txt").exists());
        assert!(paths.logs.join(".omp.1234-audit.json").exists());
        assert!(paths.logs.join("engine-archive").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The engine's name is read for the pid and nothing else: a name that does not carry one is
    /// still a log (it is aged out), just not one the liveness check can speak for.
    #[test]
    fn an_engine_name_carries_its_process() {
        assert_eq!(engine_pid("omp.2026-10-22.19924.log"), Some(19_924));
        assert_eq!(engine_pid("omp.2026-10-22.19924.log.3"), Some(19_924));
        assert_eq!(engine_pid("omp.2026-10-22.19924.log.10"), Some(19_924));
        assert_eq!(engine_pid("omp.2026-10-22.log"), None);
        assert_eq!(engine_pid("host.log"), None);
        assert_eq!(engine_pid("engine-probe.log"), None);
        assert_eq!(engine_pid(".omp.1234-audit.json"), None);
        assert!(is_log_file("host.log.1"));
        assert!(is_log_file("omp.2026-10-22.19924.log"));
        assert!(!is_log_file("notes.txt"));
        assert!(!is_log_file(".log"));
        assert!(!is_log_file("x.log.bak"));
    }
}

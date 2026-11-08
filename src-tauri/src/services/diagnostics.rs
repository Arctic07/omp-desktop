//! What the settings page needs to hand a log to someone else, or to get the disk back: where the
//! logs are, what they weigh, what the caches weigh, and how to clear either.
//!
//! Only this application's own data is touched here - `<data_root>/logs` and the cache
//! subdirectories of the WebView profile. The engine's data (`<data_root>/host`, `<data_root>/home`)
//! is read-only for this process: the host owns it, and a clear that reached into a running host's
//! sessions or agent directory could destroy the very state the user is trying to diagnose. The
//! attachment scratch directory is application-owned and still left alone, for a reason of its own
//! (see `cache_targets`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use crate::errors::{IpcError, IpcResult, INVALID_INPUT, STORE_UNAVAILABLE};
use crate::models::{ClearOutcome, LogFileInfo, LogFileSource, LogsOverview, OpenLogsResult};
use crate::services::log;
use crate::services::log_retention;
use crate::services::open_in_app;
use crate::services::paths::DataPaths;
use crate::services::runtime::truncate_on_char_boundary;

/// The WebView2 user data directory Tauri creates under the application data root. Everything the
/// page's runtime caches lives below this, and so does everything it must not lose.
const WEBVIEW_PROFILE_DIR: &str = "EBWebView";

/// The profile's pure caches, relative to it - the directories a page can lose without losing
/// anything the user set up.
///
/// The line is drawn at "rebuilt on the next load": `Local Storage`, `Session Storage`,
/// `IndexedDB` and `Network` hold the user's preferences and login state, `Cookies` holds the
/// sessions themselves, and `component_crx_cache` holds components WebView would have to download
/// again - so none of them is a cache this page may offer to clear, however much disk they take.
const WEBVIEW_CACHE_DIRS: &[&str] = &[
    "Default/Cache",
    "Default/Code Cache",
    "Default/GPUCache",
    "Default/DawnGraphiteCache",
    "Default/DawnWebGPUCache",
    "Default/Service Worker/CacheStorage",
    "GrShaderCache",
    "ShaderCache",
    "GraphiteDawnCache",
];

/// Ceiling on one directory's measurement. A cache can hold more entries than any row needs an
/// exact number for, and the walk is on the user's click - past this the answer is what the first
/// entries weigh.
///
/// Per directory rather than per command, deliberately: one shared budget would let the first cache
/// spend all of it and have every other cache reported as empty, which is a worse answer than a slow
/// one. One answer therefore walks each target at most once (nine for [`overview`]), off the async
/// runtime (`commands::diagnostics`).
const MAX_MEASURED_ENTRIES: usize = 200_000;

/// Ceiling on the message one page line carries. The record adds its own prefix, so this bounds the
/// page's part of the line: a page that logs a rendered payload or a response body must not be able
/// to grow the run's log with one call.
const MAX_FRONTEND_LINE_BYTES: usize = 2 * 1024;

/// How much of one run's log the page may spend, and how much it has.
///
/// The deduplication on the page's side stops a *repeating* failure; it does not stop a page that
/// fails in a new way on every frame, which would otherwise spend the run's whole budget (4 MiB) in
/// minutes and silence the lines this application writes about itself - the ones a report actually
/// needs - for the rest of the run. The share is a quarter of that budget, and a clear resets it
/// along with the file ([`clear_logs`]).
///
/// Owner: this module, one counter per process. Bound: `PAGE_LOG_LIMIT_BYTES` of written lines.
/// Release: none before the process ends, apart from that reset; the file itself is capped and
/// rotated on the next start (`services::log`).
static PAGE_LOG_WRITTEN: AtomicU64 = AtomicU64::new(0);
/// Set when the share is spent, so the one line that says so is written exactly once.
static PAGE_LOG_STOPPED: AtomicBool = AtomicBool::new(false);
const PAGE_LOG_LIMIT_BYTES: u64 = 1024 * 1024;

/// The log directories, every file in them, and what the caches weigh.
///
/// One list over both directories: a report is read from the application's own lines and the
/// engine's, and a reader should not have to know which process wrote a failure before finding the
/// file it is in. Each row carries its `source`, so the two can still be told apart.
pub(crate) fn overview(paths: &DataPaths) -> LogsOverview {
    let engine = paths.engine_logs();
    let mut files = log_files(&paths.logs, LogFileSource::App);
    files.extend(log_files(&engine, LogFileSource::Engine));
    // Name order, the one the page draws: the three names a reader knows (`app.log`, `host.log`,
    // `omp.<day>.<pid>.log`) group the way they are looked for.
    files.sort_by(|left, right| left.name.cmp(&right.name));
    LogsOverview {
        directory: paths.logs.to_string_lossy().into_owned(),
        engine_directory: engine.to_string_lossy().into_owned(),
        files,
        cache_bytes: cache_bytes(paths),
    }
}

/// Which directory a page asked to open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenScope {
    /// `<data_root>/logs`: the application's own file and the engine host's.
    App,
    /// `<data_root>/home/omp-desktop/logs`: the engine's per-process logs.
    Engine,
}

impl OpenScope {
    /// The scope a page named. A missing one is the application directory - the page's default and
    /// the answer an older page gets; anything else is refused rather than guessed.
    pub(crate) fn named(scope: Option<&str>) -> IpcResult<Self> {
        match scope {
            None | Some("app") => Ok(Self::App),
            Some("engine") => Ok(Self::Engine),
            Some(_) => Err(IpcError::new(INVALID_INPUT, "Unknown log directory.")),
        }
    }
}

/// Opens one log directory in this machine's file manager.
///
/// The directory is created first: the page offers this before anything has been logged - and
/// before the file manager could be handed a path that does not exist yet.
pub(crate) fn open_directory(paths: &DataPaths, scope: OpenScope) -> IpcResult<OpenLogsResult> {
    let dir = match scope {
        OpenScope::App => paths.logs.clone(),
        OpenScope::Engine => paths.engine_logs(),
    };
    std::fs::create_dir_all(&dir)
        .map_err(|_| IpcError::new(STORE_UNAVAILABLE, "Cannot create the log directory."))?;
    Ok(OpenLogsResult {
        path: dir.to_string_lossy().into_owned(),
        opened: open_in_app::open_directory(&dir),
    })
}

/// Empties both log directories, keeping the file this run is writing.
///
/// The run's own file is truncated by [`log::reset`] rather than removed: this process still holds
/// it open, so a delete would take the name away while the handle lived and the run's later lines
/// would go to a file nobody can find. A run that holds no file of its own - the log never opened,
/// or a failed write closed it - leaves the name to be deleted like any other; that is exactly what
/// `None` from [`log::reset`] says, and skipping the file without it would leave the largest log in
/// the directory behind on every clear.
///
/// The engine's directory goes with it, except for a file whose process is still running: that host
/// is writing into it right now, and its name is the only handle its writer has
/// (`log_retention::engine_pid`).
pub(crate) fn clear_logs(paths: &DataPaths) -> ClearOutcome {
    // The page's share goes with the file it was spent on: a clear that emptied the file but kept
    // the budget spent would leave page failures unrecorded for the rest of the run.
    PAGE_LOG_WRITTEN.store(0, Ordering::Relaxed);
    PAGE_LOG_STOPPED.store(false, Ordering::Relaxed);
    clear_logs_with(paths, log::reset())
}

/// The clear itself, over the answer [`log::reset`] gave about this run's own file.
///
/// Split from [`clear_logs`] because the sink is process-wide: "does this run still hold `app.log`"
/// is the one input a test cannot arrange through the global, and it is the difference between
/// keeping the file and deleting it.
fn clear_logs_with(paths: &DataPaths, held: Option<u64>) -> ClearOutcome {
    let engine = paths.engine_logs();
    let freed = held
        .unwrap_or(0)
        .saturating_add(remove_log_files(
            &paths.logs,
            held.is_some().then(|| paths.logs.join(log::APP_LOG_FILE)),
        ))
        .saturating_add(remove_log_files(&engine, None));
    let remaining = measure(&paths.logs).saturating_add(measure(&engine));
    log::info(&format!(
        "logs cleared: {freed} bytes freed, {remaining} bytes left"
    ));
    ClearOutcome {
        freed_bytes: freed,
        remaining_bytes: remaining,
        // Logs are this application's own files; the engine's own tree is not touched by a log clear.
        engine_freed_bytes: 0,
        engine_skipped_bytes: 0,
    }
}

/// Removes the log files in `logs`, keeping the one at `keep` when this run still appends to it, and
/// answers the bytes it freed.
///
/// Only names a log can carry are removed ([`log_retention::is_log_file`]): the engine keeps its
/// audit marker in its own directory, and a reader's note dropped beside the logs is not this
/// page's to delete. An engine file whose process is still running is left alone for the same reason
/// a sweep skips it - the writer would keep appending to a deleted name.
fn remove_log_files(logs: &Path, keep: Option<PathBuf>) -> u64 {
    // A logs directory that is itself a link was not made by this application - it only ever calls
    // `create_dir_all` - and every file below it is somewhere else, so nothing outside the data root
    // is this page's to delete.
    if is_link(logs) {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(logs) else {
        return 0;
    };
    let mut freed: u64 = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        // Directories and links are left alone: `DirEntry::file_type` does not follow a link, and a
        // name that is not a plain file was not written by this application.
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !log_retention::is_log_file(&name) {
            continue;
        }
        if log_retention::engine_pid(&name).is_some_and(log_retention::process_alive) {
            continue;
        }
        // Only a file this run is still appending to keeps its name.
        if keep.as_deref().is_some_and(|kept| kept == path) {
            continue;
        }
        // The size is read before the removal: what a file weighs cannot be asked of a file that is
        // gone.
        let bytes = entry.metadata().map_or(0, |metadata| metadata.len());
        if std::fs::remove_file(&path).is_ok() {
            freed = freed.saturating_add(bytes);
        }
    }
    freed
}

/// Empties the caches this application owns and can lose: the WebView profile's pure caches.
/// Nothing the user set up is in them, and nothing the user just pasted either (see
/// [`cache_targets`]).
pub(crate) fn clear_caches(
    paths: &DataPaths,
    index: Option<&crate::state::SessionIndexCache>,
) -> ClearOutcome {
    let targets = cache_targets(paths);
    // The projection is measured through the same whole (`cache_bytes`), so what the page reads
    // before the click is what the clear then tries to free.
    let before = cache_bytes(paths);
    for target in &targets {
        remove_contents(target);
    }
    // The session index is dropped rather than deleted: its connection is open in this process, and
    // Windows refuses to unlink a file under one. Emptying its tables is the same thing to the
    // reader - every row is derived, and the next list refills it.
    if let Some(index) = index {
        index.clear();
    }
    let remaining = cache_bytes(paths);
    // A file the runtime recreated while the clear ran can make what is left weigh more than what
    // was there; the answer is then that nothing was freed, not a wrapped-around number.
    let freed = before.saturating_sub(remaining);
    log::info(&format!(
        "caches cleared: {freed} bytes freed, {remaining} bytes left"
    ));
    ClearOutcome {
        freed_bytes: freed,
        remaining_bytes: remaining,
        // Filled in by the command that asked the engine's own process (see
        // `services::runtime::diagnostics`): the file side of this clear cannot know what the engine
        // reclaimed, and guessing would be the one thing a clear must not do.
        engine_freed_bytes: 0,
        engine_skipped_bytes: 0,
    }
}

/// Writes one line the page asked for, tagged with where it came from.
///
/// The caller is the page's own failure reporting (`frontendLogs.ts`): an uncaught error or an
/// unhandled rejection, already deduplicated and cut to size on that side. An empty message writes
/// nothing - a blank line in the log is noise that costs a syscall. Redaction is [`log`]'s own
/// (`sanitize_message`), so a page never has to wash a message before handing it over.
pub(crate) fn write_frontend_line(level: &str, message: &str) -> IpcResult<()> {
    // The level is judged first: a caller that named one this application does not know gets that
    // answer whatever else the call carries.
    if !matches!(level, "info" | "warn" | "error") {
        return Err(IpcError::new(INVALID_INPUT, "Unknown log level."));
    }
    let message = message.trim();
    if message.is_empty() {
        return Ok(());
    }
    let line = format!(
        "page: {}",
        truncate_on_char_boundary(message, MAX_FRONTEND_LINE_BYTES)
    );
    if page_share_spent(line.len() as u64) {
        return Ok(());
    }
    match level {
        "info" => log::info(&line),
        "warn" => log::warn(&line),
        _ => log::error(&line),
    }
    Ok(())
}

/// Whether one line of `bytes` still fits the page's share of this run's log, recording the attempt
/// either way.
///
/// The line that would cross the bound is dropped rather than written past it, so what the page puts
/// in the file never exceeds the share - while the counter keeps counting what the page asked for,
/// which is what a budget means.
///
/// A spent share is read before the counter moves, so the counter stops within one line of the
/// bound. Counting every refused line instead would let a page that never stops calling walk a `u64`
/// into a wrap-around, and a wrapped budget is a fresh budget.
fn page_share_spent(bytes: u64) -> bool {
    if PAGE_LOG_STOPPED.load(Ordering::Relaxed) {
        return true;
    }
    if PAGE_LOG_WRITTEN
        .fetch_add(bytes, Ordering::Relaxed)
        .saturating_add(bytes)
        > PAGE_LOG_LIMIT_BYTES
    {
        if !PAGE_LOG_STOPPED.swap(true, Ordering::Relaxed) {
            log::warn("the page's share of this run's log is spent; later page lines are dropped");
        }
        return true;
    }
    false
}

/// The files the user can be pointed at: this run's log, the log a previous run was rotated to, and
/// the host's log. Name-ordered, so the list reads the same way on every refresh.
///
/// Directories and links are left out: the row opens a file, and a link inside the logs directory is
/// not one this application wrote. Names a log cannot carry are left out too - the engine keeps its
/// audit marker in its own directory, and listing it would offer a row that neither the retention
/// rule nor a clear touches.
fn log_files(logs: &Path, source: LogFileSource) -> Vec<LogFileInfo> {
    let Ok(entries) = std::fs::read_dir(logs) else {
        return Vec::new();
    };
    let mut files: Vec<LogFileInfo> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter(|entry| log_retention::is_log_file(&entry.file_name().to_string_lossy()))
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            Some(LogFileInfo {
                name: entry.file_name().to_string_lossy().into_owned(),
                bytes: metadata.len(),
                // A file whose time cannot be read is listed as one written at the epoch rather
                // than dropped: its name and size are still the answer the row draws.
                modified_ms: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |since| since.as_millis() as u64),
                source,
            })
        })
        .collect();
    files.sort_by(|left, right| left.name.cmp(&right.name));
    files
}

/// Everything [`clear_caches`] may empty: the WebView profile's pure caches, and nothing else.
///
/// `scratch` is deliberately absent, although it is application-owned and can grow: it holds the
/// only copy of an attachment the user pasted, because the prompt that sends it carries the path
/// and the engine reads the file when the turn runs - so a clear that emptied it would break a
/// paste nobody had sent yet, and the bytes are not recoverable from anywhere. It is bounded and
/// reclaimed on its own terms instead (`attachments.rs`: 256 MiB, 2000 files, 30 days, swept once
/// at start-up).
///
/// A target that does not exist stays on the list: `measure` reads it as zero and `remove_contents`
/// finds nothing, so the list is the same in every state.
fn cache_targets(paths: &DataPaths) -> Vec<PathBuf> {
    // One profile belongs to this application: the page's own (`<data_root>/EBWebView`, what draws
    // the UI). Its nine cache directories are the whole of what a clear empties; the session index
    // is rebuilt by its own handle and is measured separately.
    let profile = paths.data_root.join(WEBVIEW_PROFILE_DIR);
    WEBVIEW_CACHE_DIRS
        .iter()
        .map(|dir| profile.join(dir))
        .collect()
}

/// The projection's files: the database and the two SQLite companions a live connection keeps.
///
/// They are not a directory to empty but a file to rebuild (`Projection::clear`), which is why they
/// are measured here and cleared by the caller that holds the handle - deleting the file under an
/// open connection is exactly what Windows refuses.
fn projection_files(paths: &DataPaths) -> [PathBuf; 3] {
    let database = paths.session_index_sqlite();
    let companion = |suffix: &str| {
        let mut name = database.file_name().unwrap_or_default().to_os_string();
        name.push(suffix);
        database.with_file_name(name)
    };
    let (wal, shm) = (companion("-wal"), companion("-shm"));
    [database, wal, shm]
}

/// What every clearable cache weighs together: the profile's cache directories and the projection
/// database.
fn cache_bytes(paths: &DataPaths) -> u64 {
    let directories: u64 = cache_targets(paths).iter().map(|dir| measure(dir)).sum();
    let files: u64 = projection_files(paths)
        .iter()
        .map(|file| {
            std::fs::metadata(file)
                .map(|metadata| metadata.len())
                .unwrap_or(0)
        })
        .sum();
    directories.saturating_add(files)
}

/// The bytes under `dir`.
///
/// The number is what a settings row shows, not a quota: a directory that cannot be read is
/// skipped rather than failing the whole answer, and the walk stops at [`MAX_MEASURED_ENTRIES`], so
/// a cache that outgrew it is reported as what the first entries weigh instead of holding the
/// click for a second.
///
/// Iterative rather than recursive: a cache directory holds whatever the runtime wrote into it, and
/// a list of paths cannot overflow the stack the way a chain of calls can.
fn measure(dir: &Path) -> u64 {
    let mut total = 0;
    let mut pending = vec![dir.to_path_buf()];
    let mut visited = 0usize;
    while let Some(next) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else {
            continue;
        };
        for entry in entries.flatten() {
            if visited >= MAX_MEASURED_ENTRIES {
                return total;
            }
            visited += 1;
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            // A link is neither counted nor followed: it has no bytes of its own, and following one
            // could walk a directory this application does not own.
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                total = total.saturating_add(entry.metadata().map_or(0, |metadata| metadata.len()));
            }
        }
    }
    total
}

/// Deletes what is inside `dir`, keeping `dir` itself.
///
/// The directory is the one thing worth keeping: the runtime recreates a cache directory on demand,
/// so removing it would only mean the next writer has to make it again. Every removal is
/// best-effort - on Windows a cache file the running WebView still holds open cannot be deleted -
/// and the caller reports what is left rather than failing the whole clear over one file.
fn remove_contents(dir: &Path) {
    // A target that is itself a link was not made by this application, and `read_dir` would follow
    // it: every file this would then remove is outside the data root.
    if is_link(dir) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => {
                let _ = std::fs::remove_dir_all(&path);
            }
            _ => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// Whether `path` is a link rather than a directory this application made.
///
/// On Windows this is a symlink or a junction - `std` reports both as symlinks. Both clears refuse
/// one: this application only ever creates real directories (`DataPaths::ensure_host_dirs`), so a
/// link at a path it owns was put there by something else, and everything below it is somewhere
/// else too.
fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A data root one test alone owns. `from_root` derives the whole layout from it, so no test
    /// touches a real application directory.
    fn fresh_root(name: &str) -> (DataPaths, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("omp-diagnostics-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("data root");
        (DataPaths::from_root(root.clone()), root)
    }

    /// The list holds the logs and nothing else: no directory, and the order is the one the page
    /// draws on every refresh.
    #[test]
    fn the_log_list_holds_the_files_and_nothing_else() {
        let (paths, root) = fresh_root("list");
        std::fs::create_dir_all(&paths.logs).expect("logs");
        std::fs::write(paths.logs.join("host.log"), "ccc").expect("host log");
        std::fs::write(paths.logs.join("app.log"), "a").expect("app log");
        std::fs::write(paths.logs.join("app.log.1"), "bb").expect("rotated log");
        std::fs::create_dir_all(paths.logs.join("nested")).expect("a directory in the logs");
        std::fs::write(paths.logs.join("notes.txt"), "a reader's note").expect("a note");

        let files = log_files(&paths.logs, LogFileSource::App);
        let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
        assert_eq!(names, ["app.log", "app.log.1", "host.log"]);
        assert_eq!(files[0].bytes, 1);
        assert_eq!(files[2].bytes, 3);
        assert!(files[0].modified_ms > 0, "a file just written has a time");
        assert!(
            files
                .iter()
                .all(|file| matches!(file.source, LogFileSource::App)),
            "the rows say which process wrote the file"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The overview is one table over both directories: the engine's per-process logs are listed
    /// beside this application's own, each row saying which writer it came from, and the engine
    /// directory is named so the page can open it.
    #[test]
    fn the_overview_lists_the_engine_logs_beside_the_application_logs() {
        let (paths, root) = fresh_root("overview");
        std::fs::create_dir_all(&paths.logs).expect("logs");
        std::fs::create_dir_all(paths.engine_logs()).expect("engine logs");
        std::fs::write(paths.logs.join("app.log"), "a").expect("app log");
        std::fs::write(paths.engine_logs().join("omp.2026-10-22.19924.log"), "bb")
            .expect("engine log");

        let overview = overview(&paths);

        let rows: Vec<(String, LogFileSource)> = overview
            .files
            .iter()
            .map(|file| (file.name.clone(), file.source))
            .collect();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .any(|(name, source)| name == "app.log" && matches!(source, LogFileSource::App)));
        assert!(rows
            .iter()
            .any(|(name, source)| name == "omp.2026-10-22.19924.log"
                && matches!(source, LogFileSource::Engine)));
        assert_eq!(
            PathBuf::from(&overview.engine_directory),
            paths.engine_logs()
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A clear empties the engine's directory too, but never the file of a process that is still
    /// running: this test's own pid stands in for the host that is writing into its log right now.
    #[test]
    fn a_clear_empties_the_engine_directory_but_keeps_a_running_writers_file() {
        let (paths, root) = fresh_root("clear-engine");
        let engine = paths.engine_logs();
        std::fs::create_dir_all(&engine).expect("engine logs");
        let live = engine.join(format!("omp.2026-10-22.{}.log", std::process::id()));
        let gone = engine.join("omp.2026-10-22.4000000.log");
        std::fs::write(&live, "live").expect("a running host's log");
        std::fs::write(&gone, "gone").expect("a finished host's log");

        let outcome = clear_logs_with(&paths, None);

        assert!(live.exists(), "a process still writing keeps its file");
        assert!(!gone.exists(), "a finished process's file is removed");
        assert_eq!(outcome.freed_bytes, 4);
        assert_eq!(outcome.remaining_bytes, 4, "only the live file is left");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The wire shape the page reads: both directory names in camelCase, and a row's `source` as the
    /// lowercase word the page compares against (`'engine'` / `'app'`, `api/diagnostics.ts`).
    #[test]
    fn the_overview_serializes_the_keys_the_page_reads() {
        let value = serde_json::to_value(LogsOverview {
            directory: r"C:\data\logs".to_owned(),
            engine_directory: r"C:\data\home\omp-desktop\logs".to_owned(),
            files: vec![LogFileInfo {
                name: "omp.2026-10-22.19924.log".to_owned(),
                bytes: 12,
                modified_ms: 1_700_000_000_000,
                source: LogFileSource::Engine,
            }],
            cache_bytes: 3,
        })
        .expect("the overview is serializable");

        assert_eq!(value["directory"], r"C:\data\logs");
        assert_eq!(value["engineDirectory"], r"C:\data\home\omp-desktop\logs");
        assert_eq!(value["cacheBytes"], 3);
        assert_eq!(value["files"][0]["source"], "engine");
        assert_eq!(value["files"][0]["modifiedMs"], 1_700_000_000_000_u64);
        assert_eq!(
            serde_json::to_value(LogFileSource::App).expect("a source"),
            "app"
        );
    }

    /// Only the two directory names are accepted, so a page cannot reach a third path through the
    /// open action.
    #[test]
    fn the_open_action_names_one_of_the_two_directories() {
        assert_eq!(OpenScope::named(None).expect("the default"), OpenScope::App);
        assert_eq!(
            OpenScope::named(Some("app")).expect("the application directory"),
            OpenScope::App
        );
        assert_eq!(
            OpenScope::named(Some("engine")).expect("the engine directory"),
            OpenScope::Engine
        );
        assert_eq!(
            OpenScope::named(Some("../home"))
                .expect_err("an invented scope")
                .code,
            INVALID_INPUT
        );
    }
    /// A clear takes the files of previous runs and leaves this run's own, whose bytes it frees by
    /// truncation.
    ///
    /// The answer `log::reset` gave is passed in rather than read from the process-wide sink: a test
    /// never initializes that sink, and "this run holds `app.log`" is exactly the input being
    /// exercised here.
    ///
    /// The fixture is why the same 19 bytes appear in both figures: `Some(19)` stands for a
    /// truncation that freed them, while the file on disk is still 19 bytes because nothing here
    /// truncated it. A real run has 0 bytes left in that file by the time the directory is measured.
    #[test]
    fn a_clear_keeps_the_file_this_run_holds_and_frees_the_rest() {
        let (paths, root) = fresh_root("clear-logs-held");
        std::fs::create_dir_all(&paths.logs).expect("logs");
        std::fs::write(paths.logs.join("host.log"), "0123456789").expect("host log");
        std::fs::write(paths.logs.join("app.log.1"), "01234").expect("rotated log");
        std::fs::write(paths.logs.join("app.log"), "0123456789012345678").expect("app log");

        let outcome = clear_logs_with(&paths, Some(19));

        assert!(!paths.logs.join("host.log").exists());
        assert!(!paths.logs.join("app.log.1").exists());
        assert_eq!(
            std::fs::metadata(paths.logs.join("app.log"))
                .expect("app log")
                .len(),
            19,
            "the file this run writes is kept"
        );
        assert_eq!(outcome.freed_bytes, 34, "the truncation and the two files");
        assert_eq!(
            outcome.remaining_bytes, 19,
            "what the directory still holds"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A run that holds no file of its own - a log that never opened, or one a failed write closed -
    /// leaves `app.log` to be deleted with the rest: keeping the name would make the largest log in
    /// the directory the one file a clear never removes.
    #[test]
    fn a_clear_takes_every_file_when_this_run_holds_none() {
        let (paths, root) = fresh_root("clear-logs-none");
        std::fs::create_dir_all(&paths.logs).expect("logs");
        std::fs::write(paths.logs.join("host.log"), "0123456789").expect("host log");
        std::fs::write(paths.logs.join("app.log.1"), "01234").expect("rotated log");
        std::fs::write(paths.logs.join("app.log"), "0123456789012345678").expect("app log");

        let outcome = clear_logs_with(&paths, None);

        assert!(
            !paths.logs.join("app.log").exists(),
            "nothing keeps the name"
        );
        assert!(!paths.logs.join("host.log").exists());
        assert!(!paths.logs.join("app.log.1").exists());
        assert_eq!(outcome.freed_bytes, 34);
        assert_eq!(outcome.remaining_bytes, 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The caches are emptied and the directories themselves stay; local storage and the attachment
    /// scratch are not caches this page may empty and are not touched.
    #[test]
    fn clearing_caches_empties_the_pure_caches_and_keeps_the_user_data() {
        let (paths, root) = fresh_root("clear-caches");
        let profile = paths.data_root.join(WEBVIEW_PROFILE_DIR);
        let pasted = paths.scratch.join("s1").join("pasted");
        std::fs::create_dir_all(&pasted).expect("scratch");
        std::fs::write(pasted.join("a.txt"), "0123456789").expect("a pasted file");
        std::fs::create_dir_all(profile.join("Default/Cache")).expect("cache");
        std::fs::write(profile.join("Default/Cache/x"), "01234").expect("a cache file");
        std::fs::create_dir_all(profile.join("Default/GPUCache")).expect("gpu cache");
        std::fs::write(profile.join("Default/GPUCache/y"), "0123456").expect("a cache file");
        let storage = profile.join("Default/Local Storage/leveldb");
        std::fs::create_dir_all(&storage).expect("local storage");
        std::fs::write(storage.join("z"), "0123456789").expect("user data");

        let outcome = clear_caches(&paths, None);

        assert!(
            pasted.join("a.txt").exists(),
            "a paste nobody sent yet is not a cache"
        );
        assert!(
            std::fs::read_dir(profile.join("Default/Cache"))
                .expect("cache")
                .next()
                .is_none(),
            "the cache is empty"
        );
        assert!(
            std::fs::read_dir(profile.join("Default/GPUCache"))
                .expect("gpu cache")
                .next()
                .is_none(),
            "the gpu cache is empty"
        );
        assert!(storage.join("z").exists(), "local storage is user data");
        assert!(outcome.freed_bytes > 0);
        assert_eq!(outcome.remaining_bytes, 0, "no cache is left to count");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A level the page made up is refused, an empty message is not an error, and a message longer
    /// than the ceiling is cut where the characters are - never through one.
    #[test]
    fn a_frontend_line_carries_a_known_level_and_a_bounded_message() {
        let error = write_frontend_line("verbose", "hello").expect_err("an unknown level");
        assert_eq!(error.code, INVALID_INPUT);
        // The process-wide sink is not initialized here, so these lines are dropped - which is the
        // contract: a page may log before the file exists, and nothing fails.
        assert!(
            write_frontend_line("info", "   \n  ").is_ok(),
            "nothing to write"
        );
        assert!(write_frontend_line("warn", "a page warning").is_ok());

        let long = "a".repeat(MAX_FRONTEND_LINE_BYTES) + "tail";
        assert_eq!(
            truncate_on_char_boundary(&long, MAX_FRONTEND_LINE_BYTES).len(),
            MAX_FRONTEND_LINE_BYTES
        );

        // Three bytes per character: a cut at seven cannot land on one, so it backs up to six.
        let multibyte = "中文中文";
        let cut = truncate_on_char_boundary(multibyte, 7);
        assert_eq!(cut, "中文");
        assert!(multibyte.is_char_boundary(cut.len()));
        assert_eq!(truncate_on_char_boundary("short", 64), "short");
    }

    /// A target that is itself a link is refused rather than followed: everything below it is
    /// somewhere else, and a clear may not reach outside the data root.
    ///
    /// Unix only: creating a link on Windows needs a privilege a test cannot assume.
    #[cfg(unix)]
    #[test]
    fn a_clear_refuses_a_target_that_is_itself_a_link() {
        let (paths, root) = fresh_root("link");
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).expect("outside");
        std::fs::write(outside.join("keep.txt"), "user data").expect("a file outside");
        let cache = paths
            .data_root
            .join(WEBVIEW_PROFILE_DIR)
            .join("Default/Cache");
        std::fs::create_dir_all(cache.parent().expect("a profile directory")).expect("profile");
        std::os::unix::fs::symlink(&outside, &cache).expect("a link where a cache belongs");

        let outcome = clear_caches(&paths);

        assert!(
            outside.join("keep.txt").exists(),
            "the link was not followed"
        );
        assert_eq!(outcome.freed_bytes, 0, "nothing below the link was freed");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The page's share of the run is finite: once it is spent, later page lines are dropped rather
    /// than eating the budget this application's own lines need - and the page is still answered
    /// `Ok`, because a failure to log is not a failure it could act on.
    ///
    /// The counters are process-wide, so this test leaves them spent; every other assertion about
    /// `write_frontend_line` here is about the answer it gives, not about what the file received.
    #[test]
    fn a_page_cannot_spend_the_whole_run() {
        let filler = "x".repeat(MAX_FRONTEND_LINE_BYTES);
        let calls = PAGE_LOG_LIMIT_BYTES as usize / MAX_FRONTEND_LINE_BYTES + 2;
        for _ in 0..calls {
            assert!(write_frontend_line("info", &filler).is_ok());
        }

        assert!(
            PAGE_LOG_STOPPED.load(Ordering::Relaxed),
            "the share is spent after {} calls",
            calls
        );
        assert!(
            write_frontend_line("error", "after the share").is_ok(),
            "a dropped page line is not an error the page handles"
        );
        assert!(
            write_frontend_line("verbose", "still an unknown level").is_err(),
            "the level is judged before the share"
        );
    }
}

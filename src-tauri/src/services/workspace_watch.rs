//! The workspace file watch: one recursive watch on the workspace the work panel is showing, and
//! the coalesced `omp:workspace-changed` event that tells the panel to refresh itself.
//!
//! Without it the panel refreshes only when it is mounted, when the user clicks, and at the end of a
//! turn, so a file changed by anything else - the engine's own tools, an editor, a `git fetch` in a
//! terminal - stays invisible until something else makes the panel look again. The OS notification
//! is turned into one event per quiet interval, so a burst of writes (a checkout, a build, an
//! install) costs the panel one refresh instead of hundreds.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::{recommended_watcher, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::services::presence::MAIN_WINDOW;

/// The event the work panel listens on. Emitted to the main window only: the watch belongs to the
/// window that shows the panel.
pub(crate) const WORKSPACE_CHANGED_EVENT: &str = "omp:workspace-changed";

/// How many distinct paths one report carries. A checkout or a build can touch thousands of files,
/// and the panel only has to know that something changed; `truncated` says the list is a summary.
const PATH_LIMIT: usize = 64;

/// How long the events have to stop before the batch is reported. A save that writes a temporary
/// file and renames it, or an editor that touches a file several times, is one refresh.
const QUIET: Duration = Duration::from_millis(300);

/// The ceiling on one burst: a writer that never goes quiet (a log file, a build loop) would
/// otherwise hold the debounce open forever and the panel would never hear anything.
const MAX_DELAY: Duration = Duration::from_millis(1500);

/// How many event batches may wait between the watcher's thread and the coalescing thread. The
/// consumer drains without blocking, so a full channel means the summary is behind the writer -
/// dropping the batch is right, because the batch it would have joined is already scheduled.
const CHANNEL_CAPACITY: usize = 256;

/// Path components whose changes are never the panel's business: dependency and build output that a
/// tool rewrites wholesale, and tool caches. Following them would turn every install or build into a
/// storm of events about files the file tree does not even show.
const IGNORED_COMPONENTS: &[&str] = &[
    "node_modules",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".turbo",
    ".cache",
    ".mypy_cache",
    ".pytest_cache",
    ".gradle",
    ".idea",
    ".vs",
];

/// Git's object store, which every fetch rewrites and which says nothing about the working tree. The
/// rest of `.git` stays watched on purpose: an external `add`, `commit` or `checkout` moves the
/// index, `HEAD` and the refs, and that is exactly what the review panel has to see.
const GIT_DIR: &str = ".git";
const GIT_OBJECTS: &str = "objects";

/// What travels from the watcher to the coalescing thread: one batch of changed paths, or the end of
/// the watch. The stop travels as a message rather than as the channel disconnecting, because the
/// backends do not promise that dropping a watcher drops its handler - and with it the sender -
/// before the drop returns, and a thread waiting for a disconnect would then be joined forever.
enum Message {
    Changed(Vec<String>),
    Stop,
}

/// What the panel is told. The root travels with the event because the panel may already be showing
/// another workspace by the time it arrives, and a report about the wrong one must be ignorable.
#[derive(Clone, Serialize)]
pub(crate) struct WorkspaceChanged {
    /// The watched root, as the shell named it.
    root: String,
    /// Changed paths relative to that root, `/`-separated, at most [`PATH_LIMIT`] of them.
    paths: Vec<String>,
    /// The paths are only a prefix of what was seen: the panel should treat the workspace as wholly
    /// changed rather than reading the list as the complete set.
    truncated: bool,
}

/// The process's one workspace watch.
///
/// Owner: the process, held by `state::AppState`. Bound: one watched root at a time, and one
/// bounded channel between the watcher's thread and the coalescing thread. Release: the next
/// [`WorkspaceWatch::set`] drops the previous watch - stopping the OS watch and joining its thread -
/// and the process exiting is the other release point (`stop` on the exit path).
pub(crate) struct WorkspaceWatch {
    app: AppHandle,
    active: Mutex<Option<Active>>,
}

/// One live watch: the root it was started for, the OS watcher, the channel's own end of the line,
/// and the thread that turns the watcher's events into the coalesced report.
struct Active {
    root: PathBuf,
    watcher: Option<RecommendedWatcher>,
    sender: SyncSender<Message>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Active {
    fn drop(&mut self) {
        // Stop the OS watch first, then tell the coalescing thread to end: the watcher is dropped
        // before the message so it stops producing, and the message is what wakes a thread that
        // would otherwise sit in `recv_timeout` until the next quiet interval. The send blocks only
        // while the channel is full, and the thread it waits on is the one draining it.
        self.watcher.take();
        let _ = self.sender.send(Message::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Active {
    /// Starts the OS watch and its coalescing thread, reporting each batch through `emit`.
    ///
    /// `emit` is the one thing that differs between a real watch and a test: the application hands
    /// it the window's own event, while a test hands it a channel, which is what lets the whole
    /// path — filter, relative paths, coalescing — be exercised on a real file system without a
    /// window to emit to.
    fn start(
        root: PathBuf,
        emit: impl Fn(WorkspaceChanged) + Send + 'static,
    ) -> Result<Self, String> {
        let (sender, receiver) = sync_channel::<Message>(CHANNEL_CAPACITY);
        let watched = root.clone();
        let events = sender.clone();
        let mut watcher = recommended_watcher(move |result: Result<Event, notify::Error>| {
            // A backend error is not something the panel can act on, and the watch itself stays
            // up: the next successful event still refreshes it.
            let Ok(event) = result else {
                return;
            };
            // The Linux backend reports reads as well as writes, and the panel's own reads - a
            // file opened for preview, a directory listed for the tree - would then look like
            // changes and refresh it forever. Access is the kind that describes a read; a write
            // arrives as a modification as well as a close-for-write, so nothing is lost here.
            // The Windows and macOS backends never report access events, where this is a no-op.
            if event.kind.is_access() {
                return;
            }
            let paths = relative_paths(&watched, &event.paths);
            if paths.is_empty() {
                return;
            }
            // A full channel means the coalescing thread is behind, and the batch it is already
            // holding covers these paths; `try_send` is what keeps the watcher's own thread from
            // blocking on the panel.
            let _ = events.try_send(Message::Changed(paths));
        })
        .map_err(|error| watch_failure("the file watcher could not be created", error))?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|error| watch_failure("the workspace could not be watched", error))?;
        let emit_root = root.to_string_lossy().into_owned();
        let thread = thread::Builder::new()
            .name("omp-workspace-watch".to_owned())
            .spawn(move || coalesce(emit_root, receiver, emit))
            .map_err(|error| {
                watch_failure("the workspace watch thread could not be started", error)
            })?;
        Ok(Self {
            root,
            watcher: Some(watcher),
            sender,
            thread: Some(thread),
        })
    }
}

impl WorkspaceWatch {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self {
            app,
            active: Mutex::new(None),
        }
    }

    /// Watches `root`, or stops watching when it is `None`.
    ///
    /// A root that is already the watched one is a no-op: the shell names the workspace it is
    /// showing on every switch, and re-naming the same root must not tear down and rebuild the OS
    /// watch. Anything else drops the previous watch first (see [`Active`]), so there is never a
    /// second watch or a second thread.
    pub(crate) fn set(&self, root: Option<PathBuf>) -> Result<(), String> {
        let root = root.map(|path| normalize_event_path(&path));
        let mut active = self.lock();
        if let (Some(current), Some(next)) = (active.as_ref(), root.as_ref()) {
            if current.root == *next {
                return Ok(());
            }
        }
        // Dropping the previous watch is what stops it: its `Drop` ends the OS watch and joins the
        // coalescing thread before this line returns.
        *active = None;
        let Some(root) = root else {
            return Ok(());
        };
        let app = self.app.clone();
        *active = Some(Active::start(root, move |change| {
            report_to_window(&app, change)
        })?);
        Ok(())
    }

    /// Ends the watch. Called on the exit path; the process going away is the other release point.
    pub(crate) fn stop(&self) {
        *self.lock() = None;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Active>> {
        // A poisoned lock is not a reason to leave an OS watch and its thread behind: the guard is
        // only ever held across short state swaps that cannot panic.
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Turns the watcher's batches into one report per quiet interval.
///
/// Runs on its own thread for the life of one watch, and returns when the watch is ended or the
/// channel disconnects, reporting whatever it had accumulated first.
fn coalesce(root: String, receiver: Receiver<Message>, emit: impl Fn(WorkspaceChanged)) {
    let mut pending: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut truncated = false;
    let mut burst_start: Option<Instant> = None;
    loop {
        // The wait is the shorter of "quiet since the last event" and "the burst's ceiling": a
        // writer that never pauses reaches the ceiling and gets one report per ceiling interval,
        // while an idle watch just waits out the quiet interval.
        let wait = match burst_start {
            Some(start) => MAX_DELAY.saturating_sub(start.elapsed()).min(QUIET),
            None => QUIET,
        };
        match receiver.recv_timeout(wait) {
            Ok(Message::Changed(paths)) => {
                burst_start.get_or_insert_with(Instant::now);
                for path in paths {
                    if seen.contains(&path) {
                        continue;
                    }
                    if pending.len() >= PATH_LIMIT {
                        truncated = true;
                        continue;
                    }
                    seen.insert(path.clone());
                    pending.push(path);
                }
            }
            Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => {
                report(&emit, &root, pending, truncated);
                return;
            }
            Err(RecvTimeoutError::Timeout) => {
                if burst_start.is_some() {
                    report(&emit, &root, std::mem::take(&mut pending), truncated);
                    seen.clear();
                    truncated = false;
                    burst_start = None;
                }
            }
        }
    }
}

/// Reports one batch. An empty batch is not a change.
fn report(emit: &impl Fn(WorkspaceChanged), root: &str, paths: Vec<String>, truncated: bool) {
    if paths.is_empty() {
        return;
    }
    emit(WorkspaceChanged {
        root: root.to_owned(),
        paths,
        truncated,
    });
}

/// Hands one batch to the window the panel lives in.
///
/// The only caller is the watch the application started, and a delivery failure is a log line: the
/// window is gone or the event could not be built, and neither is something the watch can act on.
fn report_to_window(app: &AppHandle, change: WorkspaceChanged) {
    if let Err(error) = app.emit_to(MAIN_WINDOW, WORKSPACE_CHANGED_EVENT, change) {
        crate::services::log::info(&format!(
            "omp: a workspace change could not be delivered to this application: {error}"
        ));
    }
}

/// The paths of one event the panel should hear about, relative to the watched root and separated
/// by `/`. A path outside the root, the root itself, and anything under an ignored directory is
/// dropped here, so nothing downstream has to know about them.
fn relative_paths(root: &Path, paths: &[PathBuf]) -> Vec<String> {
    let mut relative = Vec::with_capacity(paths.len());
    for path in paths {
        let normalized = normalize_event_path(path);
        let Ok(inside) = normalized.strip_prefix(root) else {
            continue;
        };
        if inside.as_os_str().is_empty() || ignored(inside) {
            continue;
        }
        let joined = inside
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if !joined.is_empty() {
            relative.push(joined);
        }
    }
    relative
}

/// Whether a root-relative path is one the watch never reports: a dependency, build or cache
/// directory anywhere on the way down, or git's object store. Everything else - including the rest
/// of `.git` - is a change the panel wants.
fn ignored(inside: &Path) -> bool {
    let mut previous_was_git = false;
    for component in inside.components() {
        let Some(name) = component.as_os_str().to_str() else {
            previous_was_git = false;
            continue;
        };
        if IGNORED_COMPONENTS.contains(&name) {
            return true;
        }
        if previous_was_git && name == GIT_OBJECTS {
            return true;
        }
        previous_was_git = name == GIT_DIR;
    }
    false
}

/// Strips the Windows verbatim prefix (`\\?\`, `//?/`) and unifies the drive letter's case, so an
/// event path and the watched root spell the same directory the same way and `strip_prefix` can
/// compare them. `std::fs::canonicalize` adds that prefix and the backends do not, and the stored
/// workspace roots are normalized the same way (`services::workspaces`). A no-op elsewhere.
fn normalize_event_path(path: &Path) -> PathBuf {
    if !cfg!(windows) {
        return path.to_path_buf();
    }
    let mut text = path.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        text = format!(r"\\{rest}");
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        text = rest.to_owned();
    } else if let Some(rest) = text.strip_prefix("//?/UNC/") {
        text = format!("//{rest}");
    } else if let Some(rest) = text.strip_prefix("//?/") {
        text = rest.to_owned();
    }
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_lowercase() && bytes[1] == b':' {
        // Only the first byte changes; the rest of the path may be non-ASCII.
        let letter = text[..1].to_ascii_uppercase();
        text.replace_range(..1, &letter);
    }
    PathBuf::from(text)
}

/// A watch failure the caller can be told about: the backend's own message names the path it failed
/// on, which belongs in the log rather than in an IPC answer (`rules.md#tauri-ipc-and-permissions`).
fn watch_failure(context: &str, error: impl std::fmt::Display) -> String {
    crate::services::log::warn(&format!("omp: {context}: {error}"));
    format!("{context}.")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What one event carrying `paths` would report for `root`, as the watcher's handler computes
    /// it. The paths are relative here so the case reads the same on every platform; the watched
    /// root is what the shell names, which is what the panel compares against.
    fn changed(root: &str, paths: &[&str]) -> Vec<String> {
        let paths: Vec<PathBuf> = paths.iter().map(|path| PathBuf::from(*path)).collect();
        relative_paths(Path::new(root), &paths)
    }

    #[test]
    fn a_path_is_reported_relative_to_the_root_and_slash_separated() {
        assert_eq!(
            changed("repo", &["repo/src/main.rs", "repo/README.md"]),
            vec!["src/main.rs".to_owned(), "README.md".to_owned()]
        );
        // A path outside the watched root and the root itself are not changes to report.
        assert_eq!(
            changed("repo", &["elsewhere/src/main.rs", "repo"]),
            Vec::<String>::new()
        );
    }

    #[test]
    fn dependency_build_and_cache_directories_never_reach_the_report() {
        for path in [
            "repo/node_modules/left-pad/index.js",
            "repo/src/target/debug/app.exe",
            "repo/.venv/lib/python3/site.py",
            "repo/.mypy_cache/3.12/x.json",
            "repo/.git/objects/ab/cdef0123",
            "repo/.git/objects",
        ] {
            assert_eq!(changed("repo", &[path]), Vec::<String>::new(), "{path}");
        }
    }

    #[test]
    fn the_rest_of_git_still_reaches_the_report() {
        assert_eq!(
            changed("repo", &["repo/.git/HEAD", "repo/.git/index"]),
            vec![".git/HEAD".to_owned(), ".git/index".to_owned()]
        );
    }

    /// The Windows backends hand back whatever spelling the OS used, while the watched root is the
    /// one the store holds; both have to collapse to the same directory before they are compared.
    #[cfg(windows)]
    #[test]
    fn verbatim_and_lower_case_paths_are_spelled_like_the_root() {
        assert_eq!(
            changed(
                r"D:\repo",
                &[r"\\?\D:\repo\src\main.rs", r"\\?\d:\repo\src\main.rs"]
            ),
            vec!["src/main.rs".to_owned(), "src/main.rs".to_owned()]
        );
    }

    /// The watch end to end, on a real file system: a write reaches the report as a root-relative
    /// path, and a write inside an ignored directory never reaches it at all.
    ///
    /// Ignored by default: it waits on the operating system's own notification and on the quiet
    /// interval, so it measures time where every other case here is a pure function. Run it with
    /// `cargo test --lib -- --ignored workspace_watch`.
    #[test]
    #[ignore]
    fn a_write_is_reported_and_an_ignored_directory_is_not() {
        use std::fs;

        let root = std::env::temp_dir().join(format!("omp-watch-probe-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("the probe root is created");

        let (sender, receiver) = std::sync::mpsc::channel::<WorkspaceChanged>();
        let watch = Active::start(root.clone(), move |change| {
            let _ = sender.send(change);
        })
        .expect("the watch starts");

        fs::write(root.join("kept.txt"), "one").expect("the file is written");
        let first = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("the write is reported");
        assert_eq!(first.paths, vec!["kept.txt".to_owned()]);
        assert!(!first.truncated);

        // Whatever else the platform raises for that one write - Windows reports a create and a
        // modify separately - it is about this file and about nothing else.
        while let Ok(extra) = receiver.recv_timeout(QUIET * 2) {
            assert_eq!(extra.paths, vec!["kept.txt".to_owned()]);
        }

        let ignored = root.join("node_modules");
        fs::create_dir_all(&ignored).expect("the ignored directory is created");
        fs::write(ignored.join("dependency.js"), "two").expect("the ignored file is written");
        assert!(
            receiver.recv_timeout(QUIET * 4).is_err(),
            "a write under an ignored directory must not be reported"
        );

        drop(watch);
        let _ = fs::remove_dir_all(&root);
    }
}

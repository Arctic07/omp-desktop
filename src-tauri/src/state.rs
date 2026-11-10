use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::errors::IpcResult;
use crate::models::agent::SessionSummary;
use crate::services::log;
use crate::services::open_in_app::OpenInApp;
use crate::services::paths::DataPaths;
use crate::services::plugins::builtin::BuiltinSync;
use crate::services::plugins::gates::{DeleteBudget, FsRoots, SessionGrants};
use crate::services::plugins::pages::PluginPage;
use crate::services::plugins::pages::PluginPages;
use crate::services::plugins::panels::PluginPanels;
use crate::services::plugins::prompt::PluginPrompts;
use crate::services::presence::Presence;
use crate::services::runtime::{session, HostRuntime};
use crate::services::session_index::Projection;
use crate::services::store::Store;
use crate::services::tasks::TaskRegistry;
use crate::services::terminal::TerminalService;
use crate::services::workspace_watch::WorkspaceWatch;

/// Ceiling on cached session summaries. A scan only keeps the files it saw, so the map tracks the
/// engine's own session directory; the ceiling is the backstop for a directory large enough to
/// outgrow it.
const SESSION_CACHE_LIMIT: usize = 4096;

/// Session summaries kept between sidebar scans, keyed by the absolute path the scan walks.
///
/// Deriving a summary reads up to 84 KiB per session file, and the sidebar rescans every time the
/// workspace list is refreshed. A file whose size and modification time are unchanged cannot have
/// a different summary, so the parsed result is reused instead of read back; the engine appends to
/// a live session, which changes both.
///
/// The same answers are persisted in the projection database beside the application's own store
/// (`services::session_index::Projection`), so a scan that starts a new process does not begin from
/// nothing: the first list after a restart is stat calls rather than 84 KiB per conversation. The
/// memory map stays in front of it, and a database that will not open degrades to exactly the
/// behaviour this cache had before it existed.
pub(crate) struct SessionIndexCache {
    entries: Mutex<HashMap<PathBuf, SessionIndexEntry>>,
    projection: Option<Projection>,
}

struct SessionIndexEntry {
    len: u64,
    mtime_ms: i64,
    summary: SessionSummary,
}

impl SessionIndexCache {
    /// A cache with no persisted backing: what the tests use. Production always goes through
    /// [`Self::open`], which falls back to the same memory-only cache when the projection cannot be
    /// opened, so this constructor has no caller outside a test build.
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            projection: None,
        }
    }

    /// A cache backed by the projection database at `db`, or a memory-only cache when that database
    /// cannot be opened - a cache is never a reason to fail a start.
    pub(crate) fn open(db: &std::path::Path) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            projection: Projection::open(db),
        }
    }

    /// Truncates the projection's write-ahead log and compacts the file when it is large.
    ///
    /// `None` when this process has no projection at all (a database that would not open, which is
    /// the memory-only cache the tests use too): there is no file to hold to anything.
    pub(crate) fn maintain(&self, file: &std::path::Path) -> Option<crate::services::sqlite::Done> {
        self.projection
            .as_ref()
            .map(|projection| projection.maintain(file))
    }

    /// The summary recorded for `path`, when the file still has that exact size and modification
    /// time; `None` means the caller has to read the file again.
    pub(crate) fn reuse(&self, path: &Path, len: u64, mtime_ms: i64) -> Option<SessionSummary> {
        {
            let entries = self.lock();
            if let Some(entry) = entries.get(path) {
                if entry.len == len && entry.mtime_ms == mtime_ms {
                    return Some(entry.summary.clone());
                }
            }
        }
        // A miss in this process is not a miss on disk: the last run's derivation answers instead,
        // and the answer is put back where the scan will look for it next.
        let summary = self
            .projection
            .as_ref()?
            .cached_summary(path, len, mtime_ms)?;
        self.store_memory(path, len, mtime_ms, summary.clone());
        Some(summary)
    }

    pub(crate) fn store(&self, path: &Path, len: u64, mtime_ms: i64, summary: SessionSummary) {
        if let Some(projection) = self.projection.as_ref() {
            projection.store_summary(path, len, mtime_ms, &summary);
        }
        self.store_memory(path, len, mtime_ms, summary);
    }

    /// Drops every file the finished scan did not see, so a session that was deleted or archived
    /// stops answering from the cache.
    pub(crate) fn retain_seen(&self, seen: &HashSet<PathBuf>) {
        self.lock().retain(|path, _| seen.contains(path));
        if let Some(projection) = self.projection.as_ref() {
            projection.retain(seen);
        }
    }

    /// One page of a transcript's messages, assembled from the persisted byte index instead of a
    /// pass over the whole file; `None` when the projection cannot answer it faithfully, which is
    /// the caller's signal to read the file the way it always has.
    pub(crate) fn page(
        &self,
        path: &Path,
        cursor: Option<&str>,
        limit: usize,
    ) -> Option<crate::services::session_index::Page> {
        self.projection.as_ref()?.page(path, cursor, limit)
    }

    /// Drops everything the projection derived, so the settings page's clear frees the same bytes it
    /// reported. A process without one has nothing to drop.
    pub(crate) fn clear(&self) {
        if let Some(projection) = self.projection.as_ref() {
            projection.clear();
        }
    }

    /// Indexes one transcript's message text, for the scan that just read it. A process without a
    /// projection indexes nothing, and that is the whole of the difference.
    pub(crate) fn index_messages(&self, path: &Path, len: u64, mtime_ms: i64) {
        if let Some(projection) = self.projection.as_ref() {
            projection.index_messages(path, len, mtime_ms);
        }
    }

    /// The conversations that mention `query`, best first - the projection's own search, or nothing
    /// when this process is running without one.
    pub(crate) fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> Vec<crate::services::session_index::SearchRow> {
        match self.projection.as_ref() {
            Some(projection) => projection.search(query, limit),
            None => Vec::new(),
        }
    }

    fn store_memory(&self, path: &Path, len: u64, mtime_ms: i64, summary: SessionSummary) {
        let mut entries = self.lock();
        if entries.len() >= SESSION_CACHE_LIMIT && !entries.contains_key(path) {
            // The oldest file goes first: it is the least likely to be read again, and dropping a
            // live entry only costs one re-read.
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.mtime_ms)
                .map(|(path, _)| path.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            path.to_path_buf(),
            SessionIndexEntry {
                len,
                mtime_ms,
                summary,
            },
        );
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, SessionIndexEntry>> {
        // A poisoned lock is not a reason to take the application down: every holder only mutates
        // short-lived cache state, so the inner value is still usable.
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Application-wide state: owned paths, the local store, the engine host and the session
/// index cache.
pub(crate) struct AppState {
    pub(crate) paths: DataPaths,
    pub(crate) store: Store,
    pub(crate) runtime: HostRuntime,
    /// Reused by every sidebar scan; see [`SessionIndexCache`].
    pub(crate) session_index: Arc<SessionIndexCache>,
    /// The applications this machine can open a workspace with, and their icons; the
    /// resolution lives here because it belongs to the process, not to one window.
    pub(crate) open_in_app: Arc<OpenInApp>,
    /// The shells behind the terminal tabs. A pty and its child belong to the process - the
    /// window that opened the tab only draws it - so they are owned here and ended on exit.
    pub(crate) terminal: Arc<TerminalService>,
    /// The built-in browser's pages (`services::browser`): one guest webview per conversation tab,
    /// owned here for the process's life and released when a tab or conversation closes. `None`
    /// when this machine has no main window to host a guest in.
    pub(crate) browser: Option<Arc<crate::services::browser::BrowserService>>,
    /// The residency decision: whether a close request hides the window, and whether a tray exists
    /// to return to (see `services::presence`).
    pub(crate) presence: Arc<Presence>,
    /// What each installed plugin's `omp.desktop` block declares, as the custom protocol serves it:
    /// one origin per installation, replaced by every plugin list the desktop reads. Owner/bound/
    /// release are stated by the service itself (`services::plugins::pages`).
    pub(crate) pages: Arc<PluginPages>,
    /// The plugin windows this process has open, so a plugin that stops running closes them.
    pub(crate) panels: Arc<PluginPanels>,
    /// The resident plugin processes (`omp.desktop.main`, plan §6.4): one child per installation,
    /// at most sixteen live, each with its own handshake, budgets and crash budget. Owner/bound/
    /// release are stated by the service itself (`services::plugins::process`).
    pub(crate) plugin_process: Arc<crate::services::plugins::process::PluginProcess>,
    /// The answers the user gave a plugin page for the rest of this process (spec §6.3-4: session
    /// authorization is memory-only, and the process ending is what ends it). Owner/bound/release
    /// are stated by the service itself (`services::plugins::gates`).
    pub(crate) session_grants: Arc<SessionGrants>,
    /// The questions a plugin page's bridge call has open and is waiting on. Owner/bound/release are
    /// stated by the service itself (`services::plugins::prompt`).
    pub(crate) prompts: Arc<PluginPrompts>,
    /// The deletes each installation has made lately, so a series of them is answered as a series.
    /// Owner/bound/release are stated by the service itself (`services::plugins::gates`).
    pub(crate) delete_budget: Arc<DeleteBudget>,
    /// The plugin bus (`omp.desktop` API 0.2.0): one topic table and the subscribers on it, per
    /// installation. Owner/bound/release are stated by the service itself
    /// (`services::plugins::bus`).
    pub(crate) plugin_bus: Arc<crate::services::plugins::bus::PluginBus>,
    /// The sockets each installation holds, so the eight-socket ceiling and the id ownership are
    /// this side's (`services::plugins::sockets`).
    pub(crate) plugin_sockets: Arc<crate::services::plugins::sockets::PluginSockets>,
    /// What each installation has spent on `agent.complete`: the minute's calls and the in-flight
    /// pairs (`services::plugins::agent_budget`).
    pub(crate) plugin_agent_budget: Arc<crate::services::plugins::agent_budget::AgentBudget>,
    /// The long operations this process has in flight, and how to ask one of them to stop
    /// (`rules.md#tauri-ipc-and-permissions`). Owner/bound/release are stated by the service itself (`services::tasks`).
    pub(crate) tasks: Arc<TaskRegistry>,
    /// The workspace the shell is showing, when it has told this process which one that is: the first
    /// root a plugin page's file gates resolve against (spec §6.3). One slot, because one window is
    /// what the shell shows at a time; `None` until the shell says, which leaves the gates with the
    /// installation's own package.
    pub(crate) plugin_workspace: Mutex<Option<PathBuf>>,
    /// Whether the built-in plugin catalogue has been seeded, and which bundle version this
    /// process has already brought the engine in step with. Owner/bound/release are stated by the
    /// service itself (`services::plugins::builtin`).
    pub(crate) builtin_sync: Arc<BuiltinSync>,
    /// The workspace the work panel is showing, watched so the panel can refresh itself when
    /// something else changes a file in it. Owner/bound/release are stated by the service itself
    /// (`services::workspace_watch`).
    pub(crate) workspace_watch: Arc<WorkspaceWatch>,
    /// The application's own update check (`services::updater`): one fixed feed, one announced
    /// update, and the state every surface reads. Owner/bound/release are stated by the service.
    pub(crate) updater: Arc<crate::services::updater::UpdaterService>,
}

/// `(provider id, environment name)` for every stored custom provider.
fn custom_env_entries(store: &Store) -> Vec<(String, String)> {
    match store.list_custom_providers_blocking() {
        Ok(rows) => rows
            .iter()
            .map(|row| {
                (
                    row.id.clone(),
                    crate::services::custom_providers::key_env(&row.id),
                )
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

impl AppState {
    /// The workspace the shell is showing, when it has told this process which one that is.
    pub(crate) fn plugin_workspace(&self) -> Option<PathBuf> {
        self.plugin_workspace
            .lock()
            .ok()
            .and_then(|held| held.clone())
    }

    /// Replaces it. The shell is the only caller, and it names the workspace it is showing.
    pub(crate) fn set_plugin_workspace(&self, root: Option<PathBuf>) {
        if let Ok(mut held) = self.plugin_workspace.lock() {
            *held = root;
        }
    }

    /// The roots one plugin page's file gates resolve against (spec §6.3): the workspace the page
    /// belongs to - its own window's, when it is a panel, and the shell's current one otherwise - and
    /// the installation's own package.
    pub(crate) fn plugin_roots(&self, caller_label: &str, page: &PluginPage) -> FsRoots {
        FsRoots {
            workspace: self
                .panels
                .workspace_of(caller_label)
                .or_else(|| self.plugin_workspace()),
            plugin: page.root.clone(),
        }
    }

    pub(crate) fn new(app: &tauri::AppHandle) -> IpcResult<Self> {
        let paths = DataPaths::resolve(app)?;
        paths.ensure_host_dirs()?;
        // Everything below can fail in a way the window is not the right place to hear about (a
        // file that cannot be reclaimed, the host refusing its first start), so the log is up
        // before any of it runs. The panic hook writes to the same file: a fatal error during
        // startup has no UI yet to report itself through.
        log::init(&paths.logs);
        log::panic_hook();
        // The fault this process cannot unwind out of: an access violation, an abort, a stack
        // overflow. Installed with the log open, so its record lands in the same file as the panic
        // hook's (see `services::crash` for the two cases it deliberately does not cover).
        crate::services::crash::install(&paths.logs);
        // The first line of every run, and the other half of the one the exit path writes: a file
        // whose last record is not `run ended` is a run that never got to say goodbye, which is what
        // a hard crash, a kill or a power loss looks like from this side. The pid and the build
        // identity are what make the other evidence usable: a dump names its process, and a
        // `module+0xoffset` frame resolves against the build whose PDB was kept beside it.
        log::info(&format!(
            "omp: run started (app {}, protocol {}, pid {}, build {} {})",
            env!("CARGO_PKG_VERSION"),
            crate::services::runtime::PROTOCOL_VERSION,
            std::process::id(),
            env!("OMP_BUILD_SHA"),
            log::iso_utc(env!("OMP_BUILD_TIME").parse().unwrap_or(0))
        ));
        // Copies a conversation no longer needs are reclaimed before the window opens. `scratch` is
        // app-owned, this is its only owner, and one bounded walk of it is cheaper than letting it
        // grow forever.
        let sweep = crate::services::attachments::collect_scratch(&paths.scratch);
        if sweep.files > 0 {
            log::info(&format!(
                "omp: reclaimed {} stale attachment copies ({} bytes)",
                sweep.files, sweep.bytes
            ));
        }
        // Logs outlive the run that wrote them, so the rule that bounds them is applied before the
        // host exists: a day of restarts leaves a file each, and without this an install used daily
        // keeps every one of them forever. Seven days, by modification time, in both directories
        // (`services::log_retention`).
        crate::services::log_retention::report(crate::services::log_retention::sweep(&paths));
        // A run that was killed mid-import left a staging directory or a partial download under
        // `plugin-imports`; this is the one place they are swept, before any import of this process
        // exists, so every name carrying the staging prefix is a leftover rather than a concurrent
        // import's work (`services::plugins::package::sweep_staging`). One bounded read of one
        // directory's direct children, which is why it belongs on the start-up path beside the
        // scratch reclaim above.
        let staging = crate::services::plugins::package::sweep_staging(&paths.plugin_imports);
        if staging > 0 {
            log::info(&format!(
                "omp: reclaimed {staging} stale plugin staging entries"
            ));
        }
        // The scratch root is read before the paths move into the runtime below.
        let open_in_app = Arc::new(OpenInApp::new(paths.scratch.clone()));
        // The questions plugin calls raise are created here because two owners read them: the bridge
        // (which asks and waits) and the process supervisor (which must not charge a wait for the
        // user's answer to the plugin's call budget).
        let prompts = Arc::new(PluginPrompts::new());
        let store = Store::open(&paths.app_sqlite)?;
        // The close hook reads the residency decision on the main thread and cannot wait for a
        // store read there, so the recorded choice is loaded here, before the window exists.
        let presence = Arc::new(Presence::load(&store));
        let runtime = HostRuntime::new(app.clone(), paths.clone());
        // The retention rule runs again while this process lives: a window left open for a week
        // otherwise keeps every file the rule would have removed, because the start-up sweep is the
        // only one it ever sees. One task for the life of the process (`services::log_retention`).
        crate::services::log_retention::schedule(paths.clone());
        // The engine's own caches - old native builds and its scratch copies - used to be reclaimed
        // only when the reader pressed "clear cache". This is the pass nobody has to press: once
        // shortly after start, then every six hours, with a week-long "in use" window
        // (`services::runtime::reclaim`).
        crate::services::runtime::reclaim::schedule(runtime.clone(), paths.clone());
        // The host is spawned with the keys of the user-defined providers, so the runtime needs
        // their environment names before the first spawn.
        runtime.set_custom_providers(custom_env_entries(&store));
        // An older run may have left `models.yml` describing the registry as it was then (most
        // often `auth: none` for a provider whose key arrived afterwards). Converging here means
        // the engine reads a truthful file at every start, without user action.
        if let Err(error) =
            crate::services::custom_providers::sync_models_yml_blocking(&store, &paths.agent_dir)
        {
            log::warn(&format!(
                "omp: the custom provider file could not be synchronized: {}",
                error.message
            ));
        }
        // The shell opens a session the moment the user clicks one, and that click waits for the
        // host to start. Starting it here puts that wait alongside the window and the webview
        // coming up instead of in front of the first click.
        //
        // Deliberately after the block above and never before it: a spawn reads `models.yml` and
        // the custom provider environment, so both have to be settled first. The task runs in the
        // background because `new` runs inside `setup`, where blocking for a cold start would put
        // the wait in front of the window instead of behind it.
        let warm_paths = paths.clone();
        let warm_runtime = runtime.clone();
        tauri::async_runtime::spawn(async move {
            // Before anything starts the engine: a run that died without warning may have left a
            // host behind, and it still holds this data root's sessions. The pid file is written on
            // every spawn and cleared on every clean exit, and what it names is only killed when it
            // is running this build's own host binary (`services::runtime::owner`).
            let sweep_paths = warm_paths.clone();
            let swept = tauri::async_runtime::spawn_blocking(move || {
                let artifact = crate::services::host_bin::locate().ok()?;
                Some(crate::services::runtime::owner::sweep(
                    &sweep_paths,
                    &artifact.program,
                ))
            })
            .await
            .ok()
            .flatten();
            if let Some(swept) = swept {
                crate::services::runtime::owner::report(swept);
            }
            // A failure is reported but never fatal: the click that needs the host reports its own.
            if let Err(error) = session::warm(&warm_runtime).await {
                log::warn(&format!(
                    "omp: the engine host could not be started ahead of time: {}",
                    error.message
                ));
            }
        });
        let terminal = Arc::new(TerminalService::new());
        let browser = match crate::services::browser::BrowserService::new(app, &paths) {
            Ok(service) => Some(Arc::new(service)),
            Err(error) => {
                log::warn(&format!(
                    "omp: the built-in browser is unavailable: code={} message={}",
                    error.code, error.message
                ));
                None
            }
        };
        let app_handle = app.clone();
        terminal.set_exit_emitter(Arc::new(move |summary, code| {
            let terminal = crate::models::TerminalSummaryDto {
                id: summary.id,
                shell: summary.shell,
                cwd: summary.cwd,
                owner_session_id: summary.owner_session_id,
                owner_session_file: summary.owner_session_file,
                workspace_key: summary.workspace_key,
            };
            let _ = tauri::Emitter::emit(
                &app_handle,
                "omp:terminal",
                crate::models::TerminalUiEvent::Exit { terminal, code },
            );
        }));
        // The projection is opened before the paths are moved into the state below: the cache owns
        // its own handle to the file and needs nothing from them afterwards.
        let session_index = Arc::new(SessionIndexCache::open(&paths.session_index_sqlite()));
        let updater = Arc::new(crate::services::updater::UpdaterService::new());
        // Both databases are opened in WAL mode and only ever checkpointed when SQLite chooses to,
        // which leaves a log beside each and free pages inside each - measured at 4.7 MB of `-wal`
        // beside `sessions-index.sqlite` alone. The pass runs once, a minute in, when the start-up
        // work is behind it (`services::sqlite`). Errors are log lines: a database that will not
        // compact is one that still works.
        crate::services::sqlite::schedule(
            store.clone(),
            Arc::clone(&session_index),
            paths.app_sqlite.clone(),
            paths.session_index_sqlite(),
        );
        Ok(Self {
            paths,
            store,
            runtime,
            session_index,
            open_in_app,
            terminal,
            browser,
            presence,
            pages: Arc::new(PluginPages::new()),
            panels: Arc::new(PluginPanels::new()),
            session_grants: Arc::new(SessionGrants::new()),
            prompts: Arc::clone(&prompts),
            plugin_process: crate::services::plugins::process::PluginProcess::new(
                app.clone(),
                Arc::clone(&prompts),
            ),
            delete_budget: Arc::new(DeleteBudget::new()),
            plugin_bus: Arc::new(crate::services::plugins::bus::PluginBus::default()),
            plugin_sockets: Arc::new(crate::services::plugins::sockets::PluginSockets::default()),
            plugin_agent_budget: Arc::new(
                crate::services::plugins::agent_budget::AgentBudget::default(),
            ),
            tasks: Arc::new(TaskRegistry::new()),
            plugin_workspace: Mutex::new(None),
            builtin_sync: Arc::new(BuiltinSync::new()),
            workspace_watch: Arc::new(WorkspaceWatch::new(app.clone())),
            updater,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(id: &str) -> SessionSummary {
        SessionSummary {
            id: id.to_owned(),
            title: String::new(),
            cwd: "D:/workspace".to_owned(),
            status: crate::models::agent::SessionColdStatus::Unknown,
            updated_at: 0,
            file_path: format!("D:/agent/sessions/-workspace-/{id}.jsonl"),
            compressed: false,
            pinned: false,
            archived: false,
            blank: false,
        }
    }

    #[test]
    fn a_summary_is_reused_only_while_the_file_is_unchanged() {
        let cache = SessionIndexCache::new();
        let path = Path::new("D:/agent/sessions/-workspace-/a.jsonl");
        cache.store(path, 100, 1_000, summary("a"));

        assert_eq!(
            cache.reuse(path, 100, 1_000),
            Some(summary("a")),
            "same size and time"
        );
        assert_eq!(cache.reuse(path, 101, 1_000), None, "appended to");
        assert_eq!(cache.reuse(path, 100, 1_001), None, "touched");
        assert_eq!(
            cache.reuse(
                Path::new("D:/agent/sessions/-workspace-/b.jsonl"),
                100,
                1_000
            ),
            None,
            "a file this cache never stored"
        );
    }

    #[test]
    fn a_finished_scan_drops_the_paths_it_did_not_see() {
        let cache = SessionIndexCache::new();
        let kept = Path::new("D:/agent/sessions/-workspace-/kept.jsonl");
        let gone = Path::new("D:/agent/sessions/-workspace-/gone.jsonl");
        cache.store(kept, 1, 1, summary("kept"));
        cache.store(gone, 1, 1, summary("gone"));

        let seen: HashSet<PathBuf> = std::iter::once(kept.to_path_buf()).collect();
        cache.retain_seen(&seen);

        assert!(cache.reuse(kept, 1, 1).is_some());
        assert_eq!(cache.reuse(gone, 1, 1), None);
    }

    #[test]
    fn the_cache_stays_within_its_ceiling() {
        let cache = SessionIndexCache::new();
        for index in 0..SESSION_CACHE_LIMIT + 1 {
            let path = PathBuf::from(format!("D:/agent/sessions/-workspace-/{index}.jsonl"));
            cache.store(&path, 1, index as i64, summary(&format!("s{index}")));
        }
        assert_eq!(cache.lock().len(), SESSION_CACHE_LIMIT);
    }
}

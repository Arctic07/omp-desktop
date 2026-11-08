//! The local `app.sqlite` store: the authoritative registry of workspaces.
//!
//! Concurrency: `rusqlite::Connection` is `Send` but not `Sync`, so the process keeps one
//! connection behind a mutex and serializes statements itself. WAL lets readers proceed while the
//! writer commits. Statements run on a blocking thread, because waiting on the busy timeout or an
//! fsync must never park an async runtime worker, and the lock is released before the future
//! resumes so no guard is ever held across an await point.

mod builtin_suppression;
mod custom_providers;
mod preferences;
mod projects;
// Visible to the crate because a module that owns a table tests its statements against this DDL
// rather than against a copy of it (`services::plugins::grants`).
pub(crate) mod schema;
mod session_flags;
mod session_reads;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, Error};

use crate::errors::{
    IpcError, IpcResult, STORE_BACKUP_FAILED, STORE_MIGRATION_FAILED, STORE_UNAVAILABLE,
    STORE_VERSION_TOO_NEW,
};
use crate::models::agent::{SessionColdStatus, SessionReadMark};
use crate::models::plugins::PluginGrantRow;
use crate::models::store::{CustomProviderRow, ProjectRow};
use crate::services::log;
use crate::services::plugins::grants;

pub(crate) use schema::SCHEMA_VERSION;
pub(crate) use session_flags::SessionFlags;

/// How long a statement waits for the database lock before SQLite reports `SQLITE_BUSY`.
///
/// `pub(crate)` because the maintenance pass over this connection drops the wait to zero and then
/// restores it (`services::sqlite::compact`); the value it restores is this one.
pub(crate) const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// How many pre-migration copies the start-up sweep keeps (`prune_backups`).
///
/// Two, not one: the newest is the copy the version gate's own migration may still be restored
/// from, and the one before it covers a migration that succeeded but whose result a later start
/// refuses - at which point the newest copy is a file of the version that cannot be opened.
const BACKUP_KEEP: usize = 2;

/// Unix milliseconds. Every timestamp written to the store comes from here, so row ordering stays
/// comparable with the engine's own millisecond timestamps.
pub(crate) fn now_ms() -> i64 {
    let Ok(elapsed) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        // A clock set before the epoch cannot be salvaged; 0 keeps ordering deterministic.
        return 0;
    };
    // Saturate rather than wrap: a wrapped value would sort as the oldest row forever.
    i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
}

/// Handle to the local store. Clones share one connection; SQLite serializes the statements.
#[derive(Clone)]
pub(crate) struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl Store {
    /// Opens the store at `path`, creating and initializing the file when it does not exist yet.
    ///
    /// A file older than this build is copied aside before the migration touches it, and a
    /// migration that fails has that copy put back: the pre-migration copy is a precondition of
    /// the upgrade, not a convenience (`rules.md#startup-upgrade-and-downgrade`). A start that cannot get there is
    /// refused - the caller reports it and leaves - rather than run against a half-known file.
    pub(crate) fn open(path: &Path) -> IpcResult<Self> {
        let mut conn = Connection::open(path).map_err(|_| {
            IpcError::new(STORE_UNAVAILABLE, "The local store could not be opened.")
        })?;
        configure(&conn)?;
        let version = read_version(&conn)?;
        if version > SCHEMA_VERSION {
            // Fail-closed: a file written by a newer build is refused rather than read through
            // DDL this build does not know about. The message names the file and the way back,
            // because this one surfaces in the start-up dialog rather than in the UI.
            return Err(IpcError::from_message(
                STORE_VERSION_TOO_NEW,
                format!(
                    "This local data was created by a newer version of OMP Desktop and cannot be \
                     opened by this one. Data file: {}. Install the newer version again (or \
                     restore a backup from the same directory) and start it once.",
                    path.display()
                ),
            ));
        }
        // A version 0 file is one this start just created (v1 is the first released schema):
        // there is nothing to copy aside, and the migration below builds it from nothing.
        if version > 0 && version < SCHEMA_VERSION {
            back_up(&conn, path, version)?;
        }
        if let Err(error) = migrate(&mut conn, version) {
            // Nothing this session wrote may survive: close the connection first (its `-wal`
            // belongs to the file being replaced), then put the copy back.
            drop(conn);
            let backup = backup_path(path, version);
            let restored = roll_back(path, version);
            log::warn(&format!(
                "omp: store migration v{version} -> v{SCHEMA_VERSION} failed ({}); {}",
                error.message,
                if restored {
                    "the pre-migration copy was restored"
                } else {
                    "the pre-migration copy could not be restored"
                }
            ));
            return Err(IpcError::from_message(
                STORE_MIGRATION_FAILED,
                format!(
                    "The local data could not be upgraded ({}). {} Pre-upgrade copy: {}.",
                    error.message,
                    if restored {
                        "The previous copy was restored, so nothing was changed."
                    } else {
                        "The previous copy could not be restored; it is kept beside the data file."
                    },
                    backup.display()
                ),
            ));
        }
        // A start that got here either migrated the file or found it current; either way the
        // copies beyond the kept count are past anyone's way back.
        prune_backups(path);
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub(crate) async fn list_projects(&self) -> IpcResult<Vec<ProjectRow>> {
        self.run(projects::list).await
    }

    pub(crate) async fn get_project(&self, id: i64) -> IpcResult<ProjectRow> {
        self.run(move |conn| projects::get(conn, id)).await
    }

    /// Upserts by `root_key`, so adding the same directory twice cannot create a second row. An
    /// existing row keeps its id, `pinned`, `sort_order` and user-edited name; `name` is used as
    /// given only for a row that has none yet.
    pub(crate) async fn upsert_project(
        &self,
        root_key: &str,
        root_path: &str,
        name: &str,
        now_ms: i64,
    ) -> IpcResult<ProjectRow> {
        let root_key = root_key.to_owned();
        let root_path = root_path.to_owned();
        let name = name.to_owned();
        self.run(move |conn| projects::upsert(conn, &root_key, &root_path, &name, now_ms))
            .await
    }

    pub(crate) async fn rename_project(&self, id: i64, name: &str) -> IpcResult<ProjectRow> {
        let name = name.to_owned();
        self.run(move |conn| projects::rename(conn, id, &name))
            .await
    }

    pub(crate) async fn touch_project(&self, id: i64, now_ms: i64) -> IpcResult<()> {
        self.run(move |conn| projects::touch(conn, id, now_ms))
            .await
    }

    /// Soft delete: the row is only hidden from lists, nothing on disk is touched.
    pub(crate) async fn remove_project(&self, id: i64, now_ms: i64) -> IpcResult<()> {
        self.run(move |conn| projects::remove(conn, id, now_ms))
            .await
    }

    /// Rewrites the manual order of the workspace registry: the position of each named workspace
    /// is its index in `ids`. See [`projects::reorder`] for what an unnamed row falls back to.
    pub(crate) async fn reorder_projects(&self, ids: &[i64]) -> IpcResult<()> {
        let ids = ids.to_vec();
        self.run(move |conn| projects::reorder(conn, &ids)).await
    }

    /// Preferences are a key/value table: the value is opaque JSON so a new preference never
    /// needs a schema change.
    pub(crate) async fn set_preference(
        &self,
        key: &str,
        value_json: &str,
        now_ms: i64,
    ) -> IpcResult<()> {
        let key = key.to_owned();
        let value_json = value_json.to_owned();
        self.run(move |conn| preferences::set(conn, &key, &value_json, now_ms))
            .await
    }

    /// One preference, as it was last written; `None` when nothing has written it.
    pub(crate) async fn get_preference(&self, key: &str) -> IpcResult<Option<String>> {
        let key = key.to_owned();
        self.run(move |conn| preferences::get(conn, &key)).await
    }

    pub(crate) async fn list_custom_providers(&self) -> IpcResult<Vec<CustomProviderRow>> {
        self.run(custom_providers::list).await
    }

    /// Blocking variant for the start-up path, which runs before the app serves any command and
    /// therefore has no async context to spawn onto.
    pub(crate) fn list_custom_providers_blocking(&self) -> IpcResult<Vec<CustomProviderRow>> {
        let guard = lock(&self.conn)?;
        custom_providers::list(&guard)
    }

    /// Blocking variant for the start-up path, which runs before the app serves any command and
    /// therefore has no async context to spawn onto.
    pub(crate) fn get_preference_blocking(&self, key: &str) -> IpcResult<Option<String>> {
        let guard = lock(&self.conn)?;
        preferences::get(&guard, key)
    }

    pub(crate) async fn upsert_custom_provider(&self, row: CustomProviderRow) -> IpcResult<()> {
        self.run(move |conn| custom_providers::upsert(conn, &row, now_ms()))
            .await
    }

    pub(crate) async fn remove_custom_provider(&self, id: &str) -> IpcResult<()> {
        let id = id.to_owned();
        self.run(move |conn| custom_providers::remove(conn, &id))
            .await
    }

    /// The cold statuses the user has already read, newest first. Bounded by
    /// `session_reads::SESSION_READ_LIMIT`, so one call is the whole table.
    pub(crate) async fn session_read_marks(&self) -> IpcResult<Vec<SessionReadMark>> {
        self.run(session_reads::list).await
    }

    /// Records one session's cold status as read. Re-reading the same session after another
    /// failure overwrites the row: one mark per session, holding the newest status seen.
    pub(crate) async fn set_session_read_mark(
        &self,
        session_id: &str,
        status: SessionColdStatus,
    ) -> IpcResult<()> {
        let session_id = session_id.to_owned();
        self.run(move |conn| session_reads::set(conn, &session_id, status, now_ms()))
            .await
    }

    /// Forgets one session's mark, for the conversation that is being deleted.
    pub(crate) async fn forget_session_read_mark(&self, session_id: &str) -> IpcResult<()> {
        let session_id = session_id.to_owned();
        self.run(move |conn| session_reads::remove(conn, &session_id))
            .await
    }

    /// Every conversation that carries a pinned or archived flag, as a map keyed by session id.
    ///
    /// One call answers a whole list read: the rows are the conversations the user has decided
    /// something about, so the map is at most as large as those decisions.
    pub(crate) async fn session_flags(&self) -> IpcResult<HashMap<String, SessionFlags>> {
        self.run(session_flags::map).await
    }

    /// Keeps one conversation's row at the top of its workspace's list (`true`) or stops doing so.
    pub(crate) async fn set_session_pinned(&self, session_id: &str, pinned: bool) -> IpcResult<()> {
        let session_id = session_id.to_owned();
        self.run(move |conn| session_flags::set_pinned(conn, &session_id, pinned, now_ms()))
            .await
    }

    /// Puts one conversation away (`true`) or brings it back into the list.
    pub(crate) async fn set_session_archived(
        &self,
        session_id: &str,
        archived: bool,
    ) -> IpcResult<()> {
        let session_id = session_id.to_owned();
        self.run(move |conn| session_flags::set_archived(conn, &session_id, archived, now_ms()))
            .await
    }

    /// Forgets both flags of one conversation, for the session that is being deleted.
    pub(crate) async fn forget_session_flags(&self, session_id: &str) -> IpcResult<()> {
        let session_id = session_id.to_owned();
        self.run(move |conn| session_flags::remove(conn, &session_id))
            .await
    }

    /// Every plugin installation the workspace named by `project_key` can see has been confirmed,
    /// newest first: the rows it was confirmed for, and the user-scope rows every workspace shares.
    ///
    /// The table is this application's own bookkeeping (`services::plugins::grants`): the engine
    /// reports what a plugin *can* do, never that somebody agreed to it. One row is one
    /// installation - the plugin id, the scope it was confirmed at, and the workspace a project
    /// scope belongs to - because the same id can be installed at both scopes, and a project-scope
    /// copy exists once per workspace, so an answer about one says nothing about the other.
    ///
    /// `project_key` is the registry key of the workspace the caller addresses, or `None` when it
    /// named none this registry holds: the user-scope rows are then the whole answer, and no
    /// project-scope row can stand in for an installation of a workspace nobody named.
    pub(crate) async fn plugin_grants(
        &self,
        project_key: Option<&str>,
    ) -> IpcResult<Vec<PluginGrantRow>> {
        let project_key = project_key.map(str::to_owned);
        self.run(move |conn| grants::list(conn, project_key.as_deref()))
            .await
    }

    /// Records or forgets the confirmation of one installation. Granting twice is the same answer
    /// given twice, so it stamps the row instead of failing on it.
    ///
    /// `project_key` names the installation together with the scope: the registry key of the
    /// workspace a project-scope copy lives in, or the empty string for the user scope, which is
    /// one installation in every workspace. A project scope cannot be recorded without one - the
    /// caller resolves it, and refuses the write when it cannot
    /// (`services::plugins::consent::grant_key`).
    pub(crate) async fn set_plugin_grant(
        &self,
        plugin_id: &str,
        scope: &str,
        project_key: &str,
        granted: bool,
    ) -> IpcResult<()> {
        let plugin_id = plugin_id.to_owned();
        let scope = scope.to_owned();
        let project_key = project_key.to_owned();
        self.run(move |conn| {
            if granted {
                grants::grant(conn, &plugin_id, &scope, &project_key, now_ms())
            } else {
                grants::revoke(conn, &plugin_id, &scope, &project_key)
            }
        })
        .await
    }

    /// Forgets every confirmation of one plugin id that the workspace named by `project_key` can
    /// see: every user-scope row, which speaks about one installation in every workspace, and the
    /// project-scope rows of that workspace.
    ///
    /// Called when the plugin is uninstalled: a grant for something that is no longer installed is
    /// a leftover, and on a later install of the same id it would admit code the user was never
    /// shown. Another workspace's project-scope installation is a different installation that the
    /// uninstall did not touch, so its own answer is left alone - and with no workspace named,
    /// nothing a project scope could be attributed to is touched either.
    pub(crate) async fn forget_plugin_grants(
        &self,
        plugin_id: &str,
        project_key: Option<&str>,
    ) -> IpcResult<()> {
        let plugin_id = plugin_id.to_owned();
        let project_key = project_key.map(str::to_owned);
        self.run(move |conn| grants::revoke_all(conn, &plugin_id, project_key.as_deref()))
            .await
    }

    /// Forgets one installation's confirmation only: the named scope, and for a project scope the
    /// workspace it belongs to. An uninstall that names a scope is an answer about that
    /// installation, and the other scope's copy of the same id is still installed.
    pub(crate) async fn forget_plugin_installation_grant(
        &self,
        plugin_id: &str,
        scope: &str,
        project_key: Option<&str>,
    ) -> IpcResult<()> {
        let plugin_id = plugin_id.to_owned();
        let scope = scope.to_owned();
        let project_key = project_key.map(str::to_owned);
        self.run(move |conn| {
            grants::revoke_installation(conn, &plugin_id, &scope, project_key.as_deref())
        })
        .await
    }

    /// Whether the user has confirmed that the plugin named `plugin_id` may run code at `scope`
    /// **and** `project_key`.
    ///
    /// The gate reads this before it lets a code plugin be enabled, so the answer is the row's
    /// existence and nothing else: a grant holds no state that could expire. The installation is
    /// the key, so a confirmation of another scope, or of the same scope in another workspace, is
    /// not an answer about this one - and neither is a workspace the caller named none for, which
    /// is answered by the shared user-scope row at most.
    pub(crate) async fn plugin_granted(
        &self,
        plugin_id: &str,
        scope: &str,
        project_key: Option<&str>,
    ) -> IpcResult<bool> {
        let plugin_id = plugin_id.to_owned();
        let scope = scope.to_owned();
        let project_key = project_key.map(str::to_owned);
        self.run(move |conn| grants::is_granted(conn, &plugin_id, &scope, project_key.as_deref()))
            .await
    }

    /// Every built-in installation id the user has removed, so a later start does not seed it back.
    ///
    /// The record is this application's own fact (`services::store::builtin_suppression`): the engine
    /// only knows what is installed right now, and nothing in a plugin directory can say that the
    /// copy this application shipped was removed by the user rather than never installed. The seed
    /// reads this before it plans anything (`services::plugins::builtin`), and the restore command
    /// clears the row it names before it seeds the installation again.
    pub(crate) async fn builtin_suppressed_ids(&self) -> IpcResult<Vec<String>> {
        self.run(builtin_suppression::list).await
    }

    /// Records or forgets one built-in removal: `true` when the user removes the installation,
    /// `false` when the restore command puts it back.
    ///
    /// Writing the same answer twice is not a failure, because the row states a fact rather than a
    /// transition - and both directions are safe to call for a state that already holds.
    pub(crate) async fn set_builtin_suppressed(
        &self,
        plugin_id: &str,
        suppressed: bool,
    ) -> IpcResult<()> {
        let plugin_id = plugin_id.to_owned();
        self.run(move |conn| builtin_suppression::set(conn, &plugin_id, suppressed, now_ms()))
            .await
    }

    /// The registry key of one workspace, when the registry still holds it.
    ///
    /// This is the identity a project-scope consent record is keyed by
    /// (`services::plugins::grants`), so it is read from the registry rather than derived from
    /// anything the caller sent. `None` covers both a workspace this process was never told about
    /// and one that was removed: the caller decides what it can still do without an identity, and
    /// a key that stands for no workspace is not one it may substitute.
    pub(crate) async fn project_root_key(&self, id: i64) -> IpcResult<Option<String>> {
        self.run(move |conn| projects::root_key(conn, id)).await
    }

    /// Truncates the store's write-ahead log and compacts the file when it is large
    /// (`services::sqlite`).
    ///
    /// Synchronous on purpose: the caller is the maintenance pass, which is already on a blocking
    /// thread and has nothing to answer. Taking the same mutex `run` takes is what keeps a statement
    /// from interleaving, and a failure answers `None` rather than an error - a store that will not
    /// compact is a store that still works.
    pub(crate) fn maintain(&self, file: &Path) -> Option<crate::services::sqlite::Done> {
        let conn = lock(&self.conn).ok()?;
        Some(crate::services::sqlite::compact(
            &conn,
            file,
            crate::services::sqlite::VACUUM_THRESHOLD_BYTES,
        ))
    }

    /// Runs `work` against the shared connection on a blocking thread.
    ///
    /// The lock is taken inside the closure, so a statement can never overlap with another and the
    /// guard is dropped before the join handle resolves.
    async fn run<T, F>(&self, work: F) -> IpcResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> IpcResult<T> + Send + 'static,
    {
        let conn = Arc::clone(&self.conn);
        tauri::async_runtime::spawn_blocking(move || {
            let guard = lock(&conn)?;
            work(&guard)
        })
        .await
        .map_err(|_| IpcError::new(STORE_UNAVAILABLE, "The local store task failed."))?
    }
}

/// A poisoned mutex means a statement panicked while holding the connection, so the file state is
/// unknown: fail every later call with the same stable code instead of guessing at a recovery.
fn lock(conn: &Mutex<Connection>) -> IpcResult<MutexGuard<'_, Connection>> {
    conn.lock()
        .map_err(|_| IpcError::new(STORE_UNAVAILABLE, "The local store is unavailable."))
}

/// PRAGMAs that must hold for every statement this process runs.
fn configure(conn: &Connection) -> IpcResult<()> {
    // WAL: readers never block the writer, and a killed process leaves a file SQLite can recover
    // without a rebuild. Must be set outside a transaction, where it cannot change.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(configure_error)?;
    // NORMAL is the durable choice under WAL: a crash can lose the newest commits but never
    // corrupts the database, and it avoids an fsync per commit.
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(configure_error)?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(configure_error)?;
    conn.busy_timeout(BUSY_TIMEOUT).map_err(configure_error)?;
    Ok(())
}

/// The version the file carries, as the gate, the migration steps and the backup name read it.
fn read_version(conn: &Connection) -> IpcResult<i64> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| {
            IpcError::new(
                STORE_UNAVAILABLE,
                "The local store schema version could not be read.",
            )
        })
}

/// Applies every step between `from` and [`SCHEMA_VERSION`] in one transaction.
///
/// `from` is the version `open` read before it took the pre-migration copy, and the caller
/// guarantees `from < SCHEMA_VERSION`; the gates on newer and on current files live there, so
/// this function only walks the steps. Each step is idempotent, so a crash before the version
/// bump simply replays it.
fn migrate(conn: &mut Connection, from: i64) -> IpcResult<()> {
    let tx = conn.transaction().map_err(schema_error)?;
    if from < 1 {
        schema::apply_v1(&tx).map_err(schema_error)?;
    }
    if from < 2 {
        schema::apply_v2(&tx).map_err(schema_error)?;
    }
    if from < 3 {
        schema::apply_v3(&tx).map_err(schema_error)?;
    }
    if from < 4 {
        schema::apply_v4(&tx).map_err(schema_error)?;
    }
    if from < 5 {
        schema::apply_v5(&tx).map_err(schema_error)?;
    }
    if from < 6 {
        schema::apply_v6(&tx).map_err(schema_error)?;
    }
    if from < 7 {
        schema::apply_v7(&tx).map_err(schema_error)?;
    }
    if from < 8 {
        schema::apply_v8(&tx).map_err(schema_error)?;
    }
    if from < 9 {
        schema::apply_v9(&tx).map_err(schema_error)?;
    }
    if from < 10 {
        schema::apply_v10(&tx).map_err(schema_error)?;
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(schema_error)?;
    tx.commit().map_err(schema_error)
}

/// Copies the store aside before a migration touches it, named by the version it came from.
///
/// `VACUUM INTO` is the copy: it writes a consistent snapshot through the connection, where
/// copying the file alone could miss committed pages still living in the write-ahead log. A copy
/// that cannot be written stops the start - a migration that runs without one has no way back
/// from a wrong step.
fn back_up(conn: &Connection, path: &Path, version: i64) -> IpcResult<()> {
    let target = backup_path(path, version);
    if target.exists() {
        // Only an earlier attempt at this same source version can own this name; replacing it
        // keeps one name per source version.
        std::fs::remove_file(&target).map_err(|_| {
            IpcError::from_message(
                STORE_BACKUP_FAILED,
                format!(
                    "The local data could not be copied before upgrading, so nothing was changed. \
                     Data file: {}. Existing copy it could not replace: {}.",
                    path.display(),
                    target.display()
                ),
            )
        })?;
    }
    let target_text = target.to_string_lossy().into_owned();
    conn.execute("VACUUM INTO ?1", params![target_text])
        .map_err(|_| {
            IpcError::from_message(
                STORE_BACKUP_FAILED,
                format!(
                    "The local data could not be copied before upgrading, so nothing was changed. \
                     Data file: {}. Check free disk space and permissions, then start again.",
                    path.display()
                ),
            )
        })?;
    log::info(&format!(
        "omp: store copied aside before upgrading (v{version}): {}",
        target.display()
    ));
    Ok(())
}

/// Puts the pre-migration copy back after a failed migration.
///
/// The connection that ran the migration is already closed when this runs: its `-wal`/`-shm`
/// files belong to the file being replaced, and leaving them behind would have SQLite replay the
/// failed migration's pages onto the restored copy. Returns whether the copy is in place;
/// a failure is logged by the caller and the copy is left where it is.
fn roll_back(path: &Path, version: i64) -> bool {
    let backup = backup_path(path, version);
    if !backup.exists() {
        return false;
    }
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(sidecar(path, suffix));
    }
    if path.exists() && std::fs::remove_file(path).is_err() {
        return false;
    }
    std::fs::rename(&backup, path).is_ok()
}

/// The pre-migration copy of one store file, named by the version it came from.
fn backup_path(path: &Path, version: i64) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|value| value.to_os_string())
        .unwrap_or_default();
    name.push(format!(".bak.{version}"));
    path.with_file_name(name)
}

/// One store file's SQLite sidecar (`-wal` or `-shm`).
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// Keeps the newest [`BACKUP_KEEP`] pre-migration copies and removes the rest; best-effort.
fn prune_backups(path: &Path) {
    let (Some(dir), Some(stem)) = (
        path.parent(),
        path.file_name().and_then(|name| name.to_str()),
    ) else {
        return;
    };
    let prefix = format!("{stem}.bak.");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut copies: Vec<(SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(&prefix) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(UNIX_EPOCH);
        copies.push((modified, entry.path()));
    }
    if copies.len() <= BACKUP_KEEP {
        return;
    }
    copies.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    for (_, old) in copies.into_iter().skip(BACKUP_KEEP) {
        if std::fs::remove_file(&old).is_ok() {
            log::info(&format!(
                "omp: removed an old store copy: {}",
                old.display()
            ));
        }
    }
}

/// A PRAGMA failure means the file cannot serve as our database: a read-only medium, a foreign
/// format, or a lock held by another process past the busy timeout.
fn configure_error(_: Error) -> IpcError {
    IpcError::new(
        STORE_UNAVAILABLE,
        "The local store could not be configured.",
    )
}

fn schema_error(_: Error) -> IpcError {
    IpcError::new(
        STORE_UNAVAILABLE,
        "The local store schema could not be initialized.",
    )
}

/// A directory of its own for one test's store file. Tests inside one process run in parallel, so
/// the name carries the case as well as the process id, and nothing a previous run left behind is
/// ever reused.
#[cfg(test)]
fn fresh_store_dir(suffix: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("omp-store-{suffix}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("store directory");
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two workspaces, named by the string their registry row carries: a project-scope record is
    /// keyed by that string, which is what `projects.root_key` holds.
    const DEMO: &str = "C:/project/demo";
    const OTHER: &str = "C:/project/other";

    /// The grant API over a real file, which is the shape the commands call: the scope and the
    /// workspace are part of the question, the same installation asked about from another workspace
    /// is a different answer, and both ways a record is released - one installation's row, or the
    /// rows one workspace can see - are the ones a withdrawal and an uninstall use.
    #[test]
    fn grants_are_recorded_and_released_per_installation_and_workspace() {
        let dir = fresh_store_dir("grants");
        let path = dir.join("app.sqlite");
        let store = Store::open(&path).expect("a fresh store");

        tauri::async_runtime::block_on(async {
            store
                .set_plugin_grant("hello@official", "user", "", true)
                .await
                .expect("recorded");
            assert!(store
                .plugin_granted("hello@official", "user", Some(DEMO))
                .await
                .expect("read"));
            assert!(
                store
                    .plugin_granted("hello@official", "user", None)
                    .await
                    .expect("read"),
                "the shared row answers for a caller that named no workspace too"
            );
            assert!(
                !store
                    .plugin_granted("hello@official", "project", Some(DEMO))
                    .await
                    .expect("read"),
                "the other installation is a different question"
            );

            store
                .set_plugin_grant("hello@official", "project", DEMO, true)
                .await
                .expect("recorded");
            store
                .set_plugin_grant("hello@official", "project", OTHER, true)
                .await
                .expect("recorded");
            assert!(store
                .plugin_granted("hello@official", "project", Some(OTHER))
                .await
                .expect("read"));
            assert!(
                !store
                    .plugin_granted("hello@official", "project", None)
                    .await
                    .expect("read"),
                "a workspace nobody named has no project-scope answer"
            );

            let rows = store.plugin_grants(Some(DEMO)).await.expect("listed");
            assert_eq!(rows.len(), 2, "the shared row and this workspace's own");

            store
                .set_plugin_grant("hello@official", "project", DEMO, false)
                .await
                .expect("withdrawn");
            assert!(!store
                .plugin_granted("hello@official", "project", Some(DEMO))
                .await
                .expect("read"));
            assert!(
                store
                    .plugin_granted("hello@official", "project", Some(OTHER))
                    .await
                    .expect("read"),
                "another workspace's copy is left alone"
            );

            store
                .forget_plugin_grants("hello@official", Some(DEMO))
                .await
                .expect("forgotten");
            assert!(store
                .plugin_grants(Some(DEMO))
                .await
                .expect("listed")
                .is_empty());
            assert_eq!(
                store
                    .plugin_grants(Some(OTHER))
                    .await
                    .expect("listed")
                    .len(),
                1,
                "and the row it could not attribute stays where it is"
            );
        });

        // Close the connection before the directory goes: Windows keeps a file locked while it is
        // open.
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The identity a project-scope record is keyed by comes from the registry and nowhere else:
    /// a workspace the registry does not hold - and one it soft-removed - has no key to answer
    /// with, which is what makes the caller refuse the write instead of substituting one.
    #[test]
    fn a_workspace_key_comes_from_the_registry_or_not_at_all() {
        let dir = fresh_store_dir("workspace-key");
        let path = dir.join("app.sqlite");
        let store = Store::open(&path).expect("a fresh store");

        tauri::async_runtime::block_on(async {
            let project = store
                .upsert_project(DEMO, DEMO, "demo", 1)
                .await
                .expect("registered");
            assert_eq!(
                store
                    .project_root_key(project.id)
                    .await
                    .expect("read")
                    .as_deref(),
                Some(DEMO)
            );
            assert_eq!(
                store
                    .project_root_key(project.id + 1)
                    .await
                    .expect("an id no row carries"),
                None
            );

            store.remove_project(project.id, 2).await.expect("removed");
            assert_eq!(
                store.project_root_key(project.id).await.expect("read"),
                None,
                "a removed workspace is not one the registry answers for"
            );
        });

        // Close the connection before the directory goes: Windows keeps a file locked while it is
        // open.
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

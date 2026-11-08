//! Schema definition and version history.
//!
//! v1 created the workspace registry. v2 only adds tables (preferences, custom providers), so an
//! existing v1 file upgrades in place with no rewrite of existing rows. v3 adds the app's own
//! bookkeeping about engine sessions (`session_reads`) and v4 adds the plugin consent grants
//! (`plugin_grants`); both are additive in the same way: a step only ever creates objects, so an
//! older file keeps every row it has and gains the new table. v5 and v6 are the steps that rewrite
//! a table: v5 replaced a shape that could not say which installation an answer was about, and v6
//! one that could not say which workspace a project-scope answer belonged to. Why that is, and what
//! happens to the rows each step cannot carry over, is stated where the step is.
//! v7 adds the built-in suppressions (`builtin_suppressed`), additive like v2-v4: it records the one
//! fact this application keeps about a plugin it shipped itself - that the user removed it - so a
//! later start does not seed it back and the user can restore it. Why that is a record of its own
//! rather than a state of the installation is stated where the step is.
//! v8 adds the session flags (`session_flags`), additive as well: whether the user pinned a
//! conversation to the top of its workspace's list, and whether they put it away. Both are this
//! application's own facts about an engine session, so neither can live in the transcript.
//! v9 collapses the consent grants onto the plugin's own identity: `plugin_grants.plugin_id` holds
//! the plugin id rather than the engine's `name@marketplace` install handle (plan §4.4), so a
//! confirmation survives the plugin being reinstalled from another marketplace. It is a rewrite of
//! values under the same key, and the reason the install handle had to go is stated at the step.
//! v10 adds the baseline of the manual workspace order (`projects.sort_order_at`): the moment the
//! row was placed, so a workspace opened afterwards sorts by activity again instead of staying
//! frozen in the arrangement. Additive, with a default that makes every existing row "opened since
//! it was placed" - which is the recency order those files already read by.
//! `SCHEMA_VERSION` and the DDL move together, and `super::migrate` refuses a file written by a
//! newer build instead of reading it through DDL this build does not know.

use rusqlite::{params, Connection};

/// Highest schema version this build understands.
pub(crate) const SCHEMA_VERSION: i64 = 10;

/// Version recorded for the v1 objects.
const V1: i64 = 1;

/// Version recorded for the v2 objects.
const V2: i64 = 2;

/// Version recorded for the v3 objects.
const V3: i64 = 3;

/// Version recorded for the v4 objects.
const V4: i64 = 4;

/// Version recorded for the v5 objects.
const V5: i64 = 5;

/// Version recorded for the v6 objects.
const V6: i64 = 6;

/// Version recorded for the v7 objects.
const V7: i64 = 7;

/// Version recorded for the v8 objects.
const V8: i64 = 8;

/// Version recorded for the v9 objects.
const V9: i64 = 9;

/// Version recorded for the v10 column.
const V10: i64 = 10;

/// Every v1 object. `IF NOT EXISTS` keeps a partially created file recoverable: if the process died
/// between the DDL and the `user_version` bump, the next start replays the same statements.
const V1_DDL: &str = "
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  app_version TEXT   NOT NULL,
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  root_key       TEXT NOT NULL UNIQUE,
  root_path      TEXT NOT NULL,
  name           TEXT NOT NULL,
  pinned         INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  missing_at     INTEGER,
  removed_at     INTEGER,
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);
";

/// Creates the v1 objects and records the applied version.
///
/// The caller wraps this and the `user_version` bump in one transaction, so a crash leaves the file
/// either empty or fully v1. `INSERT OR IGNORE` makes a replay of an already recorded v1 a no-op.
pub(crate) fn apply_v1(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(V1_DDL)?;
    record(conn, V1)
}

/// Every v2 object: additive only, so a v1 file keeps its rows and gains these tables.
const V2_DDL: &str = "
CREATE TABLE IF NOT EXISTS preferences (
  key        TEXT PRIMARY KEY,
  value_json TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_providers (
  id          TEXT PRIMARY KEY,
  name        TEXT    NOT NULL,
  base_url    TEXT    NOT NULL,
  api         TEXT    NOT NULL,
  models_json TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
";

/// Creates the v2 objects and records the applied version.
pub(crate) fn apply_v2(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(V2_DDL)?;
    record(conn, V2)
}

/// Every v3 object: which cold status of a session this app has already shown the user. The engine
/// owns a session's status and its files; this table only remembers that the status was read, so
/// the mark survives a restart instead of being re-derived on every launch.
const V3_DDL: &str = "
CREATE TABLE IF NOT EXISTS session_reads (
  session_id TEXT PRIMARY KEY,
  status     TEXT    NOT NULL,
  seen_at    INTEGER NOT NULL
);
";

/// Creates the v3 objects and records the applied version.
pub(crate) fn apply_v3(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(V3_DDL)?;
    record(conn, V3)
}

/// Every v4 object: the plugins the user has confirmed may run code inside the agent process. The
/// engine owns what a plugin can do; whether somebody agreed to run it is this application's own
/// fact, and keeping it here is what makes the answer outlive the process instead of being asked
/// again on every launch.
const V4_DDL: &str = "
CREATE TABLE IF NOT EXISTS plugin_grants (
  plugin_id  TEXT PRIMARY KEY,
  granted_at TEXT NOT NULL
);
";

/// Creates the v4 objects and records the applied version.
pub(crate) fn apply_v4(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(V4_DDL)?;
    record(conn, V4)
}

/// Every v5 object: the same consent grants, keyed by the installation the answer is about.
///
/// The v4 table held one row per plugin id, which is wider than any answer the user can give: the
/// same id can be installed at both scopes, a confirmation given for one is not a confirmation of
/// the other, and the enable gate could only ask "was this plugin confirmed anywhere". v5 replaces
/// it with one row per `(plugin_id, scope)` pair, which is the widest an answer can honestly be.
///
/// Owner: [`crate::services::plugins::grants`], written by the grant command and read by the enable
/// gate and the install quarantine. Upper bound: the host's plugin list times its two scopes - a
/// row only exists for an installation the workspace could see when it was confirmed. Released by
/// an uninstall (every scope of the id) and by a withdrawal (the scope that was withdrawn), so the
/// table cannot outlive the installations it speaks about.
///
/// v6 keys the same rows by the workspace as well, because a project-scope installation is one per
/// workspace; the shape below is what this step built, and what replaced it is stated there.
///
/// The v4 rows are not carried over: they record an answer that names no scope, and the scope is
/// what the answer is about. Copying one onto a scope this layer would have to guess is the one
/// thing a consent record must not do - it either confirms an installation the user never saw or
/// keeps a confirmation nobody can attribute. The record is dropped, and the gate asks again: an
/// unconfirmed plugin that runs code cannot be enabled, and a later install of one is switched off
/// before the list is answered.
const V5_DDL: &str = "
-- One row per installation: plugin_id + scope is the key, granted_at is when the answer was given.
DROP TABLE IF EXISTS plugin_grants;
CREATE TABLE IF NOT EXISTS plugin_grants (
  plugin_id  TEXT NOT NULL,
  scope      TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, scope)
);
";

/// Creates the v5 objects and records the applied version.
///
/// The `DROP` is idempotent, and the whole migration runs in one transaction (`super::migrate`),
/// so a crash before the version bump replays this step over a table that is already empty.
pub(crate) fn apply_v5(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(V5_DDL)?;
    record(conn, V5)
}

/// Every v6 object: the same consent grants, keyed by the installation *and the workspace* the
/// answer is about.
///
/// A project-scope installation is one per workspace: the engine installs it into the directory the
/// command addressed, so two workspaces can hold the same plugin id at the same scope and the two
/// copies are two installations, each needing its own answer. The v5 key said only
/// `(plugin_id, scope)`, which could not tell them apart: a confirmation given for the copy in one
/// project read as a confirmation of the copy in every other project, and a withdrawal in the first
/// removed the answer the others were judged by. v6 adds the workspace to the key, which is the
/// widest an answer can be.
///
/// `project_key` is the registry key of the workspace the answer was given in (`projects.root_key`,
/// unique, resolved from the `workspace_id` the command named). The user scope needs no workspace:
/// it is one installation in every workspace, and the empty string is its key. A project-scope
/// answer that cannot be attributed to a registered workspace is refused, never stored under a
/// value that stands for no project.
///
/// Owner: [`crate::services::plugins::grants`], written by the grant command and read by the enable
/// gate, the install quarantine and the page. Upper bound: the installed plugins times their two
/// scopes times the workspaces the user has confirmed plugins in - a row only exists for an
/// installation one workspace could see when it was confirmed. Released by an uninstall and by a
/// withdrawal, each of which forgets the rows the addressed workspace can see, so the table cannot
/// outlive the installations it speaks about. Removing a workspace from the registry releases
/// nothing, on purpose: `root_key` is the workspace directory itself and re-adding that directory
/// revives the same registry row, which is what makes its rows still the answer about installations
/// it may hold - so the bound counts the workspaces that have been confirmed in, not only those the
/// registry lists right now.
///
/// The v5 project-scope rows are not carried over, for the reason v5 itself gave for the v4 rows: a
/// v5 project row records an answer that names no workspace, and the workspace is what the answer
/// is about. The file holds no column that could say which project the user confirmed in - the
/// installation's directory is not in the row, and a workspace's `root_key` is not derivable from
/// the plugin id. Copying the row onto one registered workspace would confirm an installation the
/// user never saw in that workspace; copying it onto every workspace would confirm installations
/// nobody confirmed. Both are guesses about consent, so the rows are dropped, and the gate asks
/// again: an unconfirmed plugin that runs code cannot be enabled, and a later install of one is
/// switched off before the list is answered. The v5 *user* rows are carried over instead, under the
/// empty key that is the user scope's own: they answer about one installation that is the same in
/// every workspace, so carrying them guesses nothing.
const V6_DDL: &str = "
-- One row per installation and workspace: plugin_id + scope + project_key is the key, granted_at is
-- when the answer was given. The user scope's key is the empty string: it is one installation in
-- every workspace.
CREATE TABLE IF NOT EXISTS plugin_grants_v6 (
  plugin_id   TEXT NOT NULL,
  scope       TEXT NOT NULL,
  project_key TEXT NOT NULL,
  granted_at  TEXT NOT NULL,
  PRIMARY KEY (plugin_id, scope, project_key)
);
INSERT OR REPLACE INTO plugin_grants_v6 (plugin_id, scope, project_key, granted_at)
  SELECT plugin_id, scope, '', granted_at FROM plugin_grants WHERE scope = 'user';
DROP TABLE IF EXISTS plugin_grants;
ALTER TABLE plugin_grants_v6 RENAME TO plugin_grants;
";

/// Creates the v6 objects and records the applied version.
///
/// The key is what changed and SQLite cannot alter a primary key in place, so the table is rebuilt:
/// create it under a temporary name, copy across what the step carries, drop the old one, rename.
///
/// The rebuild runs only while the table is still the v5 shape. It cannot be an `IF NOT EXISTS`
/// batch like the steps before it, because the table it reads is also the one it writes: a second
/// run over its own result would copy the user rows again and then drop every project-scope row it
/// finds, including the ones the first run legitimately kept. Testing for the `project_key` column
/// makes a replay over an already rebuilt table the no-op it has to be - and a replay after a
/// rollback, which is what a crash before the version bump leaves, still finds the v5 shape and
/// rebuilds it.
pub(crate) fn apply_v6(conn: &Connection) -> rusqlite::Result<()> {
    if grants_are_unkeyed(conn)? {
        conn.execute_batch(V6_DDL)?;
    }
    record(conn, V6)
}

/// Whether the grants table is still the v5 shape, i.e. has no `project_key` column. An absent
/// table answers `true`: there is nothing to rebuild, and the rebuild's copy is then the statement
/// that reports the missing table rather than this check silently skipping a file the schema no
/// longer matches.
fn grants_are_unkeyed(conn: &Connection) -> rusqlite::Result<bool> {
    let mut statement = conn.prepare("PRAGMA table_info(plugin_grants)")?;
    let mut columns = statement.query([])?;
    while let Some(column) = columns.next()? {
        if column.get::<_, String>(1)? == "project_key" {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Every v7 object: the built-in plugins the user has removed, remembered so a later start does not
/// put them back.
///
/// A plugin this application ships with is seeded through the engine like any other install, so
/// without a record of the removal the next start would find it missing and install it again - the
/// user's "uninstall" would undo itself on every launch. The record is this application's own fact,
/// not the engine's: the engine only knows what is installed right now, and nothing in a plugin
/// directory can say "the user removed the copy we shipped". One row is one such removal, keyed by
/// the installation id the engine derives for the bundled package (`name@marketplace`), holding the
/// moment it was written.
///
/// Owner: [`crate::services::plugins::builtin`], written by an uninstall of a *verified* built-in
/// installation and read by the seed (`sync_bundle`) before it plans anything. Upper bound: the
/// number of built-in definitions this build ships - a row only exists for an installation this
/// application itself seeded and the user then removed. Released by the restore command, which
/// clears the row before seeding the installation again, so the table cannot outlive the removal it
/// speaks about.
const V7_DDL: &str = "
CREATE TABLE IF NOT EXISTS builtin_suppressed (
  plugin_id     TEXT PRIMARY KEY,
  suppressed_at INTEGER NOT NULL
);
";

/// Creates the v7 objects and records the applied version.
///
/// Additive like the steps before v5: a file of any earlier version keeps every row it has and gains
/// this table, and `IF NOT EXISTS` makes a replay after a crash before the version bump the no-op it
/// has to be.
pub(crate) fn apply_v7(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(V7_DDL)?;
    record(conn, V7)
}

/// Every v8 object: what the user decided about one conversation's place in its workspace's list.
///
/// Pinning and putting away are both this application's facts, not the engine's: a session file
/// holds the transcript and the engine's own bookkeeping, and neither a title nor a header has a
/// slot for "the reader wants this row first" or "the reader is done with it". The row is the
/// session id the rail routes by (`session_index::host_session_id`) - the same id the read marks
/// and the tabs are keyed on - with the moment each flag was set, or `NULL` for a flag that is
/// off. A row exists only while at least one flag is on, so the table is bounded by the number of
/// conversations the user has pinned or put away right now.
///
/// Owner: [`crate::services::store::session_flags`], written by the two setters behind
/// `session_set_pinned` / `session_set_archived` and read by `session_list` before it answers.
/// Released by clearing both flags (the row is deleted) and by a conversation's own delete, so
/// the table cannot outlive the decisions it holds.
const V8_DDL: &str = "
CREATE TABLE IF NOT EXISTS session_flags (
  session_id  TEXT PRIMARY KEY,
  pinned_at   INTEGER,
  archived_at INTEGER
);
";

/// Creates the v8 objects and records the applied version.
///
/// Additive like v2-v4 and v7: a file of any earlier version keeps every row it has and gains this
/// table, and `IF NOT EXISTS` makes a replay after a crash before the version bump the no-op it has
/// to be.
pub(crate) fn apply_v8(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(V8_DDL)?;
    record(conn, V8)
}

/// Every v9 object: the same consent grants, keyed by the plugin's own identity instead of the
/// engine's installation handle.
///
/// A marketplace installation is recorded by the engine as `name@marketplace`, and that handle is
/// what v6's rows were written under. The handle is not the identity a confirmation is about
/// (plan D0, §4.4): the same plugin reinstalled from another marketplace is the same plugin, and a
/// swap of source would otherwise drop the user's answer and ask again - or, worse, keep an answer
/// that can no longer be found and leave code running unconfirmed. So the rows are rewritten onto
/// the plugin id, and the plugin id is the handle's name segment.
///
/// The shape of the table does not change (still `(plugin_id, scope, project_key)`), so the step is
/// a rewrite of values rather than a rebuild forced by a key change: the table is created beside the
/// old one, every row is copied across under its collapsed id, and the old table is dropped. The
/// copy is `INSERT OR IGNORE` so the rebuild is replay-safe, and a collapse can bring two rows onto
/// one key (`name@market-a` and `name@name-import`, which the engine really does record as two
/// installations) - the row that survives is the one with the greatest `granted_at`, i.e. the most
/// recent answer the user gave, which is the same "newest wins" rule the upsert of a repeated
/// confirmation applies. `ORDER BY granted_at DESC` is the chronological order: every timestamp this
/// build writes is a millisecond count of the same width, which is why the store's own reads order
/// the column as text too.
///
/// An id whose first character is `@` is an npm scope, not a segment separator (`@scope/pkg` is one
/// name and one plugin), so `instr(plugin_id, '@') > 1` is the whole test: such a row is the plugin's
/// own id already and is carried unchanged. A scoped package installed from a *marketplace* is
/// spelled `@scope/pkg@marketplace`, and the test leaves it alone for the same reason - the plan's
/// rule states exactly this collapse, and a row it does not collapse loses only its match: the gate
/// asks again instead of confirming something the user never saw, which is the fail-closed answer.
///
/// Carry strategy: `carry`. Every row keeps its `(scope, project_key)` and its timestamp, and the id
/// it lands under is derived from the id it held - the one transformation a handle-to-identity
/// change can make without a guess. Nothing is dropped, so no re-ask entry point is needed.
const V9_DDL: &str = "
CREATE TABLE IF NOT EXISTS plugin_grants_v9 (
  plugin_id   TEXT NOT NULL,
  scope       TEXT NOT NULL,
  project_key TEXT NOT NULL,
  granted_at  TEXT NOT NULL,
  PRIMARY KEY (plugin_id, scope, project_key)
);
INSERT OR IGNORE INTO plugin_grants_v9 (plugin_id, scope, project_key, granted_at)
  SELECT CASE WHEN instr(plugin_id, '@') > 1
              THEN substr(plugin_id, 1, instr(plugin_id, '@') - 1)
              ELSE plugin_id
         END,
         scope, project_key, granted_at
    FROM plugin_grants
   ORDER BY granted_at DESC;
DROP TABLE IF EXISTS plugin_grants;
ALTER TABLE plugin_grants_v9 RENAME TO plugin_grants;
";

/// Rewrites the consent grants onto the plugin's own identity and records the applied version.
///
/// The step needs no shape test to be idempotent: collapsing an id that carries no segment
/// separator leaves it as it is, and every row is copied before the old table goes - which is the
/// same rebuild v6 performs, minus the branch, because here the test would have to be "does any id
/// still look like a handle", and a plugin installed from a marketplace legitimately is one at
/// `@scope/pkg@marketplace`. Replaying the collapse over its own result copies the same rows onto
/// the same keys and drops nothing; the version gate is what keeps it from running twice.
pub(crate) fn apply_v9(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(V9_DDL)?;
    record(conn, V9)
}

/// Every v10 column: when a workspace was placed in the manual order.
///
/// The arrangement is `sort_order`; this is the baseline that keeps activity alive in it. A row
/// whose `last_opened_at` is newer than its `sort_order_at` has been opened since it was placed and
/// sorts by recency again (`LIST_SQL`), exactly as a conversation written after it was placed does.
/// The default 0 makes every existing row "opened since it was placed", so a v9 file keeps the
/// recency order it already read by until the reader drags something.
///
/// `ADD COLUMN` cannot say `IF NOT EXISTS`, so the step asks the table whether the column is there
/// before adding it: a replay after a crash between the DDL and the version bump is then the no-op
/// every step has to be.
const V10_DDL: &str = "ALTER TABLE projects ADD COLUMN sort_order_at INTEGER NOT NULL DEFAULT 0";

pub(crate) fn apply_v10(conn: &Connection) -> rusqlite::Result<()> {
    if !has_column(conn, "projects", "sort_order_at")? {
        conn.execute_batch(V10_DDL)?;
    }
    record(conn, V10)
}

/// Whether `table` already carries `column`, the shape check an `ADD COLUMN` step needs.
fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut statement = conn.prepare(&format!(
        "SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"
    ))?;
    statement.exists(params![column])
}

/// `INSERT OR IGNORE` makes a replay of an already recorded version a no-op, which is what a
/// crash between the DDL and the version bump leaves behind.
fn record(conn: &Connection, version: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations (version, app_version, applied_at) \
         VALUES (?1, ?2, ?3)",
        params![version, env!("CARGO_PKG_VERSION"), super::now_ms()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::time::{Duration, SystemTime};

    use crate::services::store::{fresh_store_dir, lock, Store};

    /// v2 is what installations carried before the read marks existed, so the upgrade has to keep
    /// its rows rather than start over - the projects in the file are the user's workspace list -
    /// and a file that already reached the newest version has to open again without another step.
    #[test]
    fn an_existing_v2_file_upgrades_in_place_and_keeps_its_rows() {
        let dir = fresh_store_dir("upgrade");
        let path = dir.join("app.sqlite");
        {
            let conn = Connection::open(&path).expect("store file");
            // The v2 build's own DDL, stamped with the version it would have written.
            apply_v1(&conn).expect("v1 objects");
            apply_v2(&conn).expect("v2 objects");
            conn.pragma_update(None, "user_version", V2)
                .expect("v2 version");
            conn.execute(
                "INSERT INTO projects (root_key, root_path, name, created_at, last_opened_at) \
                 VALUES ('c:/project/demo', 'C:/project/demo', 'demo', 1, 2)",
                params![],
            )
            .expect("project row");
            conn.execute(
                "INSERT INTO preferences (key, value_json, updated_at) \
                 VALUES ('thinking_level', '\"high\"', 3)",
                params![],
            )
            .expect("preference row");
        }

        let store = Store::open(&path).expect("upgrade to v3");
        {
            let conn = lock(&store.conn).expect("lock");
            assert_eq!(version(&conn), SCHEMA_VERSION);
            assert_eq!(rows(&conn, "projects"), 1);
            assert_eq!(rows(&conn, "preferences"), 1);
            assert_eq!(rows(&conn, "session_reads"), 0);
            assert_eq!(rows(&conn, "plugin_grants"), 0);
            assert_eq!(
                conn.query_row("SELECT name FROM projects", params![], |row| {
                    row.get::<_, String>(0)
                })
                .expect("kept row"),
                "demo"
            );
            // v10's baseline defaults to 0, which reads every existing row as "opened since it was
            // placed": the file keeps the recency order it already had.
            assert_eq!(
                conn.query_row("SELECT sort_order_at FROM projects", params![], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("v10 column"),
                0
            );
        }

        // The same file now takes the other branch of the gate: nothing is replayed, nothing moves.
        drop(store);
        let reopened = Store::open(&path).expect("reopen");
        {
            let conn = lock(&reopened.conn).expect("lock");
            assert_eq!(version(&conn), SCHEMA_VERSION);
            assert_eq!(rows(&conn, "projects"), 1);
        }
        // Close the connection first: Windows keeps a file locked while it is open.
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v4 is the shape the grants table had before it was keyed by the installation, and its rows
    /// name no scope. The step therefore rewrites the table rather than carrying those rows: the
    /// workspace list and every other table survive, the one record that cannot say what it is about
    /// is dropped instead of guessed at, and the rebuilt table holds one row per installation.
    #[test]
    fn a_v4_grant_table_is_rebuilt_without_its_scope_less_rows() {
        let dir = fresh_store_dir("grants-upgrade");
        let path = dir.join("app.sqlite");
        {
            let conn = Connection::open(&path).expect("store file");
            // The v4 build's own DDL, stamped with the version it would have written.
            apply_v1(&conn).expect("v1 objects");
            apply_v2(&conn).expect("v2 objects");
            apply_v3(&conn).expect("v3 objects");
            apply_v4(&conn).expect("v4 objects");
            conn.pragma_update(None, "user_version", V4)
                .expect("v4 version");
            conn.execute(
                "INSERT INTO projects (root_key, root_path, name, created_at, last_opened_at) \
                 VALUES ('c:/project/demo', 'C:/project/demo', 'demo', 1, 2)",
                params![],
            )
            .expect("project row");
            conn.execute(
                "INSERT INTO plugin_grants (plugin_id, granted_at) VALUES ('hello@official', '1')",
                params![],
            )
            .expect("v4 grant row");
        }

        let store = Store::open(&path).expect("upgrade to v6");
        {
            let conn = lock(&store.conn).expect("lock");
            assert_eq!(version(&conn), SCHEMA_VERSION);
            assert_eq!(rows(&conn, "projects"), 1, "every other row survives");
            assert_eq!(
                rows(&conn, "plugin_grants"),
                0,
                "an answer that names no scope is not carried over onto a guess"
            );

            // The rebuilt key is the installation and the workspace: the same id is confirmed once
            // per installation, two workspaces' project-scope copies are two rows, and a second
            // confirmation of one installation replaces its row rather than adding one.
            for (scope, project_key) in [("user", ""), ("project", "c:/project/demo")] {
                conn.execute(
                    "INSERT INTO plugin_grants (plugin_id, scope, project_key, granted_at) \
                     VALUES (?1, ?2, ?3, ?4)",
                    params!["hello@official", scope, project_key, "2"],
                )
                .expect("one row per installation");
            }
            assert_eq!(rows(&conn, "plugin_grants"), 2);
            conn.execute(
                "INSERT INTO plugin_grants (plugin_id, scope, project_key, granted_at) \
                 VALUES (?1, ?2, ?3, ?4)",
                params!["hello@official", "user", "", "3"],
            )
            .expect_err("the installation is the key");
            conn.execute(
                "INSERT INTO plugin_grants (plugin_id, scope, project_key, granted_at) \
                 VALUES (?1, ?2, ?3, ?4)",
                params!["hello@official", "project", "c:/project/other", "4"],
            )
            .expect("another workspace holds its own installation");
            assert_eq!(rows(&conn, "plugin_grants"), 3);
        }

        // The same file now takes the other branch of the gate: nothing is replayed, nothing moves.
        drop(store);
        let reopened = Store::open(&path).expect("reopen");
        {
            let conn = lock(&reopened.conn).expect("lock");
            assert_eq!(version(&conn), SCHEMA_VERSION);
            assert_eq!(
                rows(&conn, "plugin_grants"),
                3,
                "the rows it does hold survive"
            );
        }
        // Close the connection first: Windows keeps a file locked while it is open.
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v5 is the shape the grants table had before the workspace was part of the key: a user-scope
    /// answer is about one installation that is the same in every workspace, so the step carries
    /// those rows over under the empty key, while a project-scope row names no workspace at all -
    /// the step drops it instead of guessing which project confirmed it. The rebuild is replay-safe,
    /// which is the property this test pins down: running it again over its own result, with a
    /// project-scope row for a real workspace in the table, changes nothing.
    #[test]
    fn a_v5_grant_table_keeps_its_user_rows_and_drops_its_project_rows() {
        let dir = fresh_store_dir("grants-workspace-upgrade");
        let path = dir.join("app.sqlite");
        {
            let conn = Connection::open(&path).expect("store file");
            // The v5 build's own DDL, stamped with the version it would have written.
            apply_v1(&conn).expect("v1 objects");
            apply_v2(&conn).expect("v2 objects");
            apply_v3(&conn).expect("v3 objects");
            apply_v4(&conn).expect("v4 objects");
            apply_v5(&conn).expect("v5 objects");
            conn.pragma_update(None, "user_version", V5)
                .expect("v5 version");
            conn.execute(
                "INSERT INTO projects (root_key, root_path, name, created_at, last_opened_at) \
                 VALUES ('C:/project/demo', 'C:/project/demo', 'demo', 1, 2)",
                params![],
            )
            .expect("project row");
            for (id, scope) in [
                ("hello@official", "user"),
                ("hello@official", "project"),
                ("other", "project"),
            ] {
                conn.execute(
                    "INSERT INTO plugin_grants (plugin_id, scope, granted_at) VALUES (?1, ?2, '1')",
                    params![id, scope],
                )
                .expect("v5 grant row");
            }
        }

        let store = Store::open(&path).expect("upgrade to v6");
        {
            let conn = lock(&store.conn).expect("lock");
            assert_eq!(version(&conn), SCHEMA_VERSION);
            assert_eq!(rows(&conn, "projects"), 1, "every other row survives");
            assert_eq!(
                grants(&conn),
                vec![("hello".to_owned(), "user".to_owned(), String::new())],
                "the shared user row is carried over under the user scope's own key, and the rows \
                 that name no workspace are not carried over at all"
            );

            // The replay: the step finds the v5 shape gone and leaves what the table holds alone -
            // including a project-scope row, which a plain rebuild would read as one of the rows it
            // drops.
            conn.execute(
                "INSERT INTO plugin_grants (plugin_id, scope, project_key, granted_at) \
                 VALUES ('hello@official', 'project', 'C:/project/demo', '2')",
                params![],
            )
            .expect("a row of the rebuilt shape");
            apply_v6(&conn).expect("replayed");
            assert_eq!(rows(&conn, "plugin_grants"), 2, "a replay drops nothing");
        }

        // The same file now takes the other branch of the gate: nothing is replayed, nothing moves.
        drop(store);
        let reopened = Store::open(&path).expect("reopen");
        {
            let conn = lock(&reopened.conn).expect("lock");
            assert_eq!(version(&conn), SCHEMA_VERSION);
            assert_eq!(rows(&conn, "plugin_grants"), 2);
        }
        // Close the connection first: Windows keeps a file locked while it is open.
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v6 is the shape a file has before the built-in suppressions existed. The step only adds a
    /// table, so the whole file has to survive it: the workspace list and every grant row are still
    /// there afterwards, and the new table is empty because nothing has been removed yet.
    #[test]
    fn a_v6_file_gains_the_suppression_table_and_keeps_its_rows() {
        let dir = fresh_store_dir("suppression-upgrade");
        let path = dir.join("app.sqlite");
        {
            let conn = Connection::open(&path).expect("store file");
            // The v6 build's own DDL, stamped with the version it would have written.
            apply_v1(&conn).expect("v1 objects");
            apply_v2(&conn).expect("v2 objects");
            apply_v3(&conn).expect("v3 objects");
            apply_v4(&conn).expect("v4 objects");
            apply_v5(&conn).expect("v5 objects");
            apply_v6(&conn).expect("v6 objects");
            conn.pragma_update(None, "user_version", V6)
                .expect("v6 version");
            conn.execute(
                "INSERT INTO projects (root_key, root_path, name, created_at, last_opened_at) \
                 VALUES ('C:/project/demo', 'C:/project/demo', 'demo', 1, 2)",
                params![],
            )
            .expect("project row");
            conn.execute(
                "INSERT INTO plugin_grants (plugin_id, scope, project_key, granted_at) \
                 VALUES ('hello@official', 'user', '', '1')",
                params![],
            )
            .expect("v6 grant row");
        }

        let store = Store::open(&path).expect("upgrade to v7");
        {
            let conn = lock(&store.conn).expect("lock");
            assert_eq!(version(&conn), SCHEMA_VERSION);
            assert_eq!(rows(&conn, "projects"), 1, "every other row survives");
            assert_eq!(
                grants(&conn),
                vec![("hello".to_owned(), "user".to_owned(), String::new())],
                "the grant rows are untouched by a step that only adds a table"
            );
            assert_eq!(
                rows(&conn, "builtin_suppressed"),
                0,
                "the new table is created empty: nothing has been removed yet"
            );
        }

        // The same file now takes the other branch of the gate: nothing is replayed, nothing moves.
        drop(store);
        let reopened = Store::open(&path).expect("reopen");
        {
            let conn = lock(&reopened.conn).expect("lock");
            assert_eq!(version(&conn), SCHEMA_VERSION);
            assert_eq!(rows(&conn, "builtin_suppressed"), 0);
        }
        // Close the connection first: Windows keeps a file locked while it is open.
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v8 is the shape a file has before the consent grants moved onto the plugin's own identity:
    /// the rows name the engine's installation handle, and v9 collapses them onto the name segment
    /// the desktop keys by (plan §4.4). Four ids are the whole of the rule - two handles that a
    /// marketplace install produces, one bare name, and one npm scope - and the collapse can bring
    /// two rows onto one key, which keeps the most recent answer instead of either of them at random.
    #[test]
    fn a_v8_grant_table_collapses_install_handles_onto_plugin_ids() {
        let dir = fresh_store_dir("grant-identity-upgrade");
        let path = dir.join("app.sqlite");
        {
            let conn = Connection::open(&path).expect("store file");
            // The v8 build's own DDL, stamped with the version it would have written.
            apply_v1(&conn).expect("v1 objects");
            apply_v2(&conn).expect("v2 objects");
            apply_v3(&conn).expect("v3 objects");
            apply_v4(&conn).expect("v4 objects");
            apply_v5(&conn).expect("v5 objects");
            apply_v6(&conn).expect("v6 objects");
            apply_v7(&conn).expect("v7 objects");
            apply_v8(&conn).expect("v8 objects");
            conn.pragma_update(None, "user_version", V8)
                .expect("v8 version");
            conn.execute(
                "INSERT INTO projects (root_key, root_path, name, created_at, last_opened_at) \
                 VALUES ('C:/project/demo', 'C:/project/demo', 'demo', 1, 2)",
                params![],
            )
            .expect("project row");
            // Four shapes, and the two handles that collide once collapsed. The bare name sits in
            // another workspace so the collision is the one under test, not an accident of the
            // fixture.
            for (id, scope, project_key, granted_at) in [
                ("demo-plugin@market-a", "user", "", "10"),
                ("demo-plugin@demo-plugin-import", "user", "", "30"),
                ("demo-plugin", "user", "C:/project/demo", "20"),
                ("@scope/pkg", "user", "", "40"),
            ] {
                conn.execute(
                    "INSERT INTO plugin_grants (plugin_id, scope, project_key, granted_at) \
                     VALUES (?1, ?2, ?3, ?4)",
                    params![id, scope, project_key, granted_at],
                )
                .expect("v8 grant row");
            }
        }

        let store = Store::open(&path).expect("upgrade to v9");
        {
            let conn = lock(&store.conn).expect("lock");
            assert_eq!(version(&conn), SCHEMA_VERSION);
            assert_eq!(rows(&conn, "projects"), 1, "every other row survives");
            assert_eq!(
                grants(&conn),
                vec![
                    // The npm scope is one name, and the leading `@` is not a separator - it also
                    // sorts before the letters, which is the key order the helper reads in.
                    ("@scope/pkg".to_owned(), "user".to_owned(), String::new()),
                    // The collision: two handles, one plugin id, and the most recent answer wins.
                    ("demo-plugin".to_owned(), "user".to_owned(), String::new()),
                    (
                        "demo-plugin".to_owned(),
                        "user".to_owned(),
                        "C:/project/demo".to_owned()
                    ),
                ],
                "handles collapse onto the plugin id; a scope is left alone"
            );
            assert_eq!(
                conn.query_row(
                    "SELECT granted_at FROM plugin_grants WHERE plugin_id = 'demo-plugin' \
                     AND scope = 'user' AND project_key = ''",
                    params![],
                    |row| row.get::<_, String>(0),
                )
                .expect("the surviving row"),
                "30",
                "the greatest granted_at survives a key collision"
            );

            // A replay over its own result changes nothing: every id already is its plugin id, and
            // the rows the table holds survive the rebuild.
            apply_v9(&conn).expect("replayed");
            assert_eq!(rows(&conn, "plugin_grants"), 3, "a replay drops nothing");
            assert_eq!(
                grants(&conn)
                    .into_iter()
                    .filter(|(id, scope, key)| id == "demo-plugin"
                        && scope == "user"
                        && key.is_empty())
                    .count(),
                1,
                "the collision is still one row"
            );
        }

        // The same file now takes the other branch of the gate: nothing is replayed, nothing moves.
        drop(store);
        let reopened = Store::open(&path).expect("reopen");
        {
            let conn = lock(&reopened.conn).expect("lock");
            assert_eq!(version(&conn), SCHEMA_VERSION);
            assert_eq!(rows(&conn, "plugin_grants"), 3);
        }
        // Close the connection first: Windows keeps a file locked while it is open.
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A migrating start leaves the pre-migration copy beside the file, named by the version it
    /// came from and readable as that version; a later start keeps only the newest copies, and a
    /// fresh file is never copied aside.
    #[test]
    fn a_migrating_start_leaves_a_readable_copy_of_the_previous_version() {
        let dir = fresh_store_dir("backup");
        let path = dir.join("app.sqlite");
        {
            let conn = Connection::open(&path).expect("store file");
            // The v5 build's own DDL, stamped with the version it would have written.
            apply_v1(&conn).expect("v1 objects");
            apply_v2(&conn).expect("v2 objects");
            apply_v3(&conn).expect("v3 objects");
            apply_v4(&conn).expect("v4 objects");
            apply_v5(&conn).expect("v5 objects");
            conn.pragma_update(None, "user_version", V5)
                .expect("v5 version");
            conn.execute(
                "INSERT INTO projects (root_key, root_path, name, created_at, last_opened_at) \
                 VALUES ('c:/project/demo', 'C:/project/demo', 'demo', 1, 2)",
                params![],
            )
            .expect("project row");
        }

        let store = Store::open(&path).expect("upgrade to v6");
        {
            let conn = lock(&store.conn).expect("lock");
            assert_eq!(version(&conn), SCHEMA_VERSION);
            assert_eq!(rows(&conn, "projects"), 1);
        }
        drop(store);

        // The copy is the file as it stood before the migration: same version, same rows.
        let backup = dir.join("app.sqlite.bak.5");
        assert!(backup.exists(), "the pre-migration copy is beside the file");
        {
            let copied = Connection::open(&backup).expect("open the copy");
            assert_eq!(version(&copied), V5);
            assert_eq!(rows(&copied, "projects"), 1);
        }

        // Copies beyond the kept count go on the next successful start; the newest copy survives,
        // because that is the one the version gate may still be restored from.
        let aged = SystemTime::now() - Duration::from_secs(3_600);
        for old in [1, 2, 3] {
            let stale = dir.join(format!("app.sqlite.bak.{old}"));
            std::fs::write(&stale, b"an old copy").expect("old copy");
            age_file(&stale, aged);
        }
        let reopened = Store::open(&path).expect("reopen");
        drop(reopened);
        let kept: Vec<String> = std::fs::read_dir(&dir)
            .expect("list")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("app.sqlite.bak."))
            .collect();
        assert_eq!(kept.len(), 2, "only the newest copies are kept: {kept:?}");
        assert!(kept.contains(&"app.sqlite.bak.5".to_owned()));

        // A start that creates its own file copies nothing aside: v0 has no contents to lose.
        let fresh = Store::open(&dir.join("fresh.sqlite")).expect("fresh store");
        drop(fresh);
        assert!(!dir.join("fresh.sqlite.bak.0").exists());

        // Close the connections first: Windows keeps a file locked while it is open.
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Backdates one file so the sweep's newest-first ordering is deterministic.
    fn age_file(path: &std::path::Path, when: SystemTime) {
        let file = std::fs::File::options()
            .write(true)
            .open(path)
            .expect("open");
        file.set_times(std::fs::FileTimes::new().set_modified(when))
            .expect("set mtime");
    }

    fn version(conn: &Connection) -> i64 {
        conn.pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version")
    }

    fn rows(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), params![], |row| {
            row.get(0)
        })
        .expect("row count")
    }

    /// Every grant row, in the table's own key order: what a step carried over is read from the
    /// table rather than counted, because which row survived is the point. The order is the whole
    /// primary key, so a test that compares rows cannot depend on how SQLite happened to return
    /// two rows of one plugin id.
    fn grants(conn: &Connection) -> Vec<(String, String, String)> {
        let mut statement = conn
            .prepare(
                "SELECT plugin_id, scope, project_key FROM plugin_grants \
                 ORDER BY plugin_id, scope, project_key",
            )
            .expect("statement");
        let grants = statement
            .query_map(params![], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query");
        let mut rows = Vec::new();
        for row in grants {
            rows.push(row.expect("row"));
        }
        rows
    }
}

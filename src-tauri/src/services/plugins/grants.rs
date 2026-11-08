//! The consent grants this application remembers: which plugin installations the user has confirmed
//! may run code inside the agent process.
//!
//! The record is this application's own fact - the engine has no notion of "the user agreed", it
//! only reports what a plugin *can* do - and it outlives the process, so a plugin confirmed once is
//! not confirmed again on every launch. What a grant means is decided in [`super::consent`]; this
//! module is the table behind it: one row per *installation*, keyed by the host's plugin id, the
//! scope that installation lives at and the workspace a project scope belongs to, holding when the
//! answer was given.
//!
//! The workspace is part of the key because a project-scope installation is one per workspace: the
//! engine installs it into the directory the command addressed, so two workspaces can hold the same
//! plugin id at the same scope, and a confirmation given for the copy in one is no answer about the
//! copy in the other. A user-scope installation is one installation in every workspace, needs no
//! workspace to name it, and is keyed by the empty string. Which rows one workspace can see follows
//! from that and is stated once, on the statements below: a user-scope row is visible to every
//! workspace, a project-scope row only to the workspace it was recorded for. The table's own upper
//! bound, and what releases a row, are stated where the v6 schema is (`services::store::schema`).
//!
//! The statements follow the rest of the store: a failed `INSERT`/`SELECT` means the file, and the
//! caller cannot act on the SQLite detail, so it is reported with the stable store code.

use rusqlite::{params, Connection};

use crate::errors::{IpcError, IpcResult, STORE_UNAVAILABLE};
use crate::models::plugins::PluginGrantRow;

/// Every grant one workspace can see, newest first - the order the page lists them in, and a stable
/// one for two rows recorded inside the same millisecond.
///
/// `?1` is the workspace's registry key (`services::store::projects::root_key`), or NULL for a
/// caller that named no workspace this registry holds. A comparison with NULL is never true, so the
/// project half of the table is simply not visible then, while the user rows - keyed by the empty
/// string and speaking about the installation every workspace shares - are still the answer.
///
/// The order is over the stored text, which is the numeric order because every millisecond
/// timestamp this build writes has the same width; the id and the scope break a tie inside one
/// millisecond, so the list is a function of the table alone.
const LIST_SQL: &str = "SELECT plugin_id, scope, granted_at FROM plugin_grants \
     WHERE scope = 'user' OR project_key = ?1 \
     ORDER BY granted_at DESC, plugin_id ASC, scope ASC";

/// Whether the installation named by `(plugin_id, scope, project_key)` is one of them.
///
/// The same visibility rule as [`LIST_SQL`], for the one question the enable gate asks: the row has
/// to be the installation's own - `?3` is the workspace a project scope belongs to, and a caller
/// that named no workspace cannot be answered by a project-scope row - while a user-scope row is
/// keyed by the empty string and is the same answer in every workspace.
const IS_GRANTED_SQL: &str = "SELECT EXISTS(SELECT 1 FROM plugin_grants \
     WHERE plugin_id = ?1 AND scope = ?2 AND (scope = 'user' OR project_key = ?3))";

/// Every grant one workspace can see.
///
/// One row is an installation and a timestamp, so the whole view is one call: there is nothing here
/// to page, and the table only ever holds installations that were actually confirmed.
pub(crate) fn list(conn: &Connection, project_key: Option<&str>) -> IpcResult<Vec<PluginGrantRow>> {
    let mut statement = conn.prepare(LIST_SQL).map_err(|_| read_failed())?;
    let rows = statement
        .query_map(params![project_key], |row| {
            Ok(PluginGrantRow {
                plugin_id: row.get::<_, String>(0)?,
                scope: row.get::<_, String>(1)?,
                granted_at: row.get::<_, String>(2)?,
            })
        })
        .map_err(|_| read_failed())?;
    let mut grants = Vec::new();
    for row in rows {
        grants.push(row.map_err(|_| read_failed())?);
    }
    Ok(grants)
}

/// Records one installation's grant, replacing the timestamp of a grant that was already there.
///
/// Confirming the same installation twice is the same answer given twice, so it must not fail and
/// must not leave two rows: the upsert keeps the newest moment the user agreed. The upsert's target
/// is the whole key, so this can only ever answer for the installation the caller named -
/// `project_key` is that installation's workspace, and the caller has already refused the write
/// when it had none to name.
pub(crate) fn grant(
    conn: &Connection,
    plugin_id: &str,
    scope: &str,
    project_key: &str,
    now_ms: i64,
) -> IpcResult<()> {
    conn.execute(
        "INSERT INTO plugin_grants (plugin_id, scope, project_key, granted_at) \
         VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(plugin_id, scope, project_key) DO UPDATE SET granted_at = excluded.granted_at",
        params![plugin_id, scope, project_key, now_ms.to_string()],
    )
    .map_err(|_| write_failed())?;
    Ok(())
}

/// Forgets one installation's grant.
///
/// Called when the user withdraws their confirmation for that scope, and safe to call for an
/// installation that was never granted: forgetting an answer that was not given is not a failure.
/// The other scope of the same id, and the same scope in another workspace, are different rows and
/// are left alone.
pub(crate) fn revoke(
    conn: &Connection,
    plugin_id: &str,
    scope: &str,
    project_key: &str,
) -> IpcResult<()> {
    conn.execute(
        "DELETE FROM plugin_grants WHERE plugin_id = ?1 AND scope = ?2 AND project_key = ?3",
        params![plugin_id, scope, project_key],
    )
    .map_err(|_| write_failed())?;
    Ok(())
}

/// Forgets the grant of exactly one installation: the scope the caller named, and for a project
/// scope the workspace it belongs to.
///
/// The uninstall path names a scope because the two registries hold two installations of the same
/// id. Forgetting both when one was removed is how a still-installed, still-confirmed user copy
/// silently lost its confirmation (and was then quarantined by the next install). A scope this
/// function does not word (`None`/an engine token this build does not know) is answered by the
/// wider `revoke_all`, which is the conservative choice: the caller said it removed something and
/// did not say what.
pub(crate) fn revoke_installation(
    conn: &Connection,
    plugin_id: &str,
    scope: &str,
    project_key: Option<&str>,
) -> IpcResult<()> {
    match scope {
        "user" => {
            conn.execute(
                "DELETE FROM plugin_grants WHERE plugin_id = ?1 AND scope = 'user'",
                params![plugin_id],
            )
            .map_err(|_| write_failed())?;
            Ok(())
        }
        "project" => {
            // A project installation without its workspace key is not attributable. Deleting
            // nothing is the fail-closed answer; deleting every project row would forget another
            // workspace's confirmation.
            let Some(project_key) = project_key else {
                return Ok(());
            };
            conn.execute(
                "DELETE FROM plugin_grants WHERE plugin_id = ?1 AND scope = 'project' AND project_key = ?2",
                params![plugin_id, project_key],
            )
            .map_err(|_| write_failed())?;
            Ok(())
        }
        _ => revoke_all(conn, plugin_id, project_key),
    }
}

/// Forgets every grant of one plugin id that the workspace named by `project_key` can see: its user
/// rows, and its project-scope rows.
///
/// Called when the plugin is uninstalled: what is gone is gone, and a confirmation left behind for
/// an installation that no longer exists would silently admit a later install of the same id at
/// that scope. Another workspace's project-scope copy is a different installation that the uninstall
/// did not touch, so its own answer stays; with no workspace named, `?2` is NULL and only the shared
/// user rows go, because a project-scope row is not something a caller with no workspace can
/// attribute. Forgetting rows that were never there is not a failure.
pub(crate) fn revoke_all(
    conn: &Connection,
    plugin_id: &str,
    project_key: Option<&str>,
) -> IpcResult<()> {
    conn.execute(
        "DELETE FROM plugin_grants WHERE plugin_id = ?1 AND (scope = 'user' OR project_key = ?2)",
        params![plugin_id, project_key],
    )
    .map_err(|_| write_failed())?;
    Ok(())
}

/// Whether the user has confirmed that this plugin may run code at `scope` in `project_key`.
///
/// The gate reads this before it lets a code plugin be enabled, so the answer is the row's
/// existence and nothing else: a grant holds no state that could expire. A grant of the same plugin
/// at the other scope, or of the same scope in another workspace, is a different installation and
/// not an answer to this question.
pub(crate) fn is_granted(
    conn: &Connection,
    plugin_id: &str,
    scope: &str,
    project_key: Option<&str>,
) -> IpcResult<bool> {
    conn.query_row(
        IS_GRANTED_SQL,
        params![plugin_id, scope, project_key],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|_| read_failed())
}

/// A failed read: the grant table is the only place this answer lives, so there is nothing to fall
/// back to and nothing the caller can do about the SQLite detail.
fn read_failed() -> IpcError {
    IpcError::new(STORE_UNAVAILABLE, "The plugin grants could not be read.")
}

/// The same failure on the write path: the grant is not recorded, so the gate keeps whatever
/// answer it had.
fn write_failed() -> IpcError {
    IpcError::new(STORE_UNAVAILABLE, "The plugin grant could not be stored.")
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;
    use crate::services::store::schema;

    /// Two workspaces, named by the string their registry row carries: `projects.root_key` is the
    /// canonical directory path, which is what a project-scope grant is stored under.
    const DEMO: &str = "C:/project/demo";
    const OTHER: &str = "C:/project/other";

    /// The key a user-scope grant is stored under: the user scope is one installation in every
    /// workspace, so it names none of them.
    const SHARED: &str = "";

    /// A connection holding the grant table, built by the store's own steps in the store's own order.
    ///
    /// The steps record themselves in `schema_migrations`, which v1 creates, so assembling this by
    /// hand would be a fixture that cannot even run the real DDL path - and a copy of the DDL that
    /// could drift from it. Running v1, then v5, then v6 is the order `services::store::migrate`
    /// applies for a real file, minus the file: v5 builds the table and v6 is the step that gives it
    /// the shape these statements are written against.
    fn connection() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory store");
        schema::apply_v1(&conn).expect("v1 objects");
        schema::apply_v5(&conn).expect("v5 objects");
        schema::apply_v6(&conn).expect("the grant table, keyed by installation and workspace");
        conn
    }

    /// One row per installation, whatever the user answered and how often: the same plugin
    /// confirmed at both scopes is two rows, granting one twice keeps a single row with the newest
    /// moment, and withdrawing forgets exactly the installation it names.
    #[test]
    fn a_grant_is_one_row_per_installation_and_can_be_withdrawn() {
        let conn = connection();
        assert!(!is_granted(&conn, "hello@official", "user", Some(DEMO)).expect("no grant yet"));
        assert!(list(&conn, Some(DEMO)).expect("empty table").is_empty());

        grant(&conn, "hello@official", "user", SHARED, 1_000).expect("first answer");
        assert!(is_granted(&conn, "hello@official", "user", Some(DEMO)).expect("granted"));
        assert!(
            !is_granted(&conn, "hello@official", "project", Some(DEMO)).expect("the other scope"),
            "an answer about one installation is not an answer about the other"
        );

        grant(&conn, "hello@official", "user", SHARED, 2_000).expect("the same answer again");
        let grants = list(&conn, Some(DEMO)).expect("one row");
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].plugin_id, "hello@official");
        assert_eq!(grants[0].scope, "user");
        assert_eq!(grants[0].granted_at, "2000");

        grant(&conn, "hello@official", "project", DEMO, 1_500).expect("the same id, other scope");
        grant(&conn, "other", "user", SHARED, 1_200).expect("a second plugin");
        let rows: Vec<(String, String)> = list(&conn, Some(DEMO))
            .expect("three rows")
            .into_iter()
            .map(|row| (row.plugin_id, row.scope))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("hello@official".to_owned(), "user".to_owned()),
                ("hello@official".to_owned(), "project".to_owned()),
                ("other".to_owned(), "user".to_owned()),
            ],
            "newest first, with the key breaking a tie inside one millisecond"
        );

        revoke(&conn, "hello@official", "user", SHARED).expect("withdrawn");
        assert!(
            !is_granted(&conn, "hello@official", "user", Some(DEMO)).expect("no longer granted")
        );
        assert!(
            is_granted(&conn, "hello@official", "project", Some(DEMO))
                .expect("the other scope stays"),
            "withdrawing one installation leaves the other alone"
        );
        // Withdrawing again is not an error: nothing was left to forget.
        revoke(&conn, "hello@official", "user", SHARED).expect("idempotent");
    }

    /// The workspace is part of the key for a project-scope installation: the same id at the same
    /// scope in two workspaces is two installations with two answers, so a confirmation of one is
    /// never read as a confirmation of the other, and withdrawing in one leaves the other's answer
    /// where it is. A caller that named no workspace is answered by neither - a project-scope row
    /// cannot stand in for a workspace nobody named.
    #[test]
    fn a_project_grant_belongs_to_one_workspace() {
        let conn = connection();
        grant(&conn, "hello@official", "project", DEMO, 1).expect("confirmed in one workspace");

        assert!(is_granted(&conn, "hello@official", "project", Some(DEMO))
            .expect("the workspace it was given in"));
        assert!(
            !is_granted(&conn, "hello@official", "project", Some(OTHER))
                .expect("the copy in the other workspace"),
            "a confirmation given in one project is not a confirmation of the copy in another"
        );
        assert!(
            !is_granted(&conn, "hello@official", "project", None)
                .expect("a caller that named no workspace"),
            "a workspace nobody named has no project-scope answer"
        );

        assert_eq!(list(&conn, Some(DEMO)).expect("its own view").len(), 1);
        assert!(list(&conn, Some(OTHER)).expect("another view").is_empty());
        assert!(list(&conn, None).expect("no workspace").is_empty());

        grant(&conn, "hello@official", "project", OTHER, 2).expect("confirmed there as well");
        assert_eq!(
            list(&conn, Some(OTHER)).expect("its own view").len(),
            1,
            "the two workspaces hold a row each"
        );

        revoke(&conn, "hello@official", "project", DEMO).expect("withdrawn in one workspace");
        assert!(!is_granted(&conn, "hello@official", "project", Some(DEMO)).expect("gone here"));
        assert!(
            is_granted(&conn, "hello@official", "project", Some(OTHER)).expect("still there"),
            "withdrawing in one workspace leaves another workspace's confirmation alone"
        );
        assert_eq!(list(&conn, Some(OTHER)).expect("one row left").len(), 1);
    }

    /// A user-scope installation is the same one in every workspace, so its row is the answer there
    /// is everywhere - including to a caller that named no workspace - and one row covers all of
    /// them: withdrawing it from any of them withdraws the shared answer.
    #[test]
    fn a_user_grant_is_one_installation_in_every_workspace() {
        let conn = connection();
        grant(&conn, "hello@official", "user", SHARED, 1).expect("the shared answer");

        for key in [Some(DEMO), Some(OTHER), None] {
            assert!(
                is_granted(&conn, "hello@official", "user", key).expect("granted"),
                "the user-scope installation is the same one everywhere"
            );
            assert_eq!(list(&conn, key).expect("listed").len(), 1);
        }

        revoke(&conn, "hello@official", "user", SHARED).expect("withdrawn");
        for key in [Some(DEMO), Some(OTHER), None] {
            assert!(!is_granted(&conn, "hello@official", "user", key).expect("gone"));
            assert!(list(&conn, key).expect("listed").is_empty());
        }
    }

    /// Uninstalling forgets one workspace's view of an id and nothing else: the shared user row goes
    /// with it, another workspace's project-scope copy of the same id keeps its own answer, and the
    /// record of another plugin - and of no installation at all - is untouched. A call that names no
    /// workspace forgets the shared rows only, because that is all it can attribute.
    #[test]
    fn uninstalling_forgets_the_rows_one_workspace_can_see() {
        let conn = connection();
        grant(&conn, "hello@official", "user", SHARED, 1).expect("user grant");
        grant(&conn, "hello@official", "project", DEMO, 2).expect("project grant here");
        grant(&conn, "hello@official", "project", OTHER, 3).expect("project grant elsewhere");
        grant(&conn, "other", "user", SHARED, 4).expect("another plugin");

        revoke_all(&conn, "hello@official", Some(DEMO)).expect("forgotten");
        assert!(!is_granted(&conn, "hello@official", "user", None).expect("user"));
        assert!(!is_granted(&conn, "hello@official", "project", Some(DEMO)).expect("project"));
        assert!(
            is_granted(&conn, "hello@official", "project", Some(OTHER)).expect("the other copy"),
            "an uninstall in one workspace does not speak for an installation in another"
        );
        assert!(is_granted(&conn, "other", "user", None).expect("another plugin stays"));

        let remaining = list(&conn, Some(OTHER)).expect("two rows left");
        assert_eq!(remaining.len(), 2);

        // An id the table never held is not a failure: there is nothing left to forget.
        revoke_all(&conn, "never-installed", Some(DEMO)).expect("idempotent");
        assert_eq!(list(&conn, Some(OTHER)).expect("two rows left").len(), 2);

        grant(&conn, "hello@official", "user", SHARED, 5).expect("the shared answer again");
        revoke_all(&conn, "hello@official", None).expect("forgotten with no workspace named");
        assert!(
            !is_granted(&conn, "hello@official", "user", None).expect("the shared row went"),
            "a caller with no workspace still forgets the rows that need none"
        );
        assert!(
            is_granted(&conn, "hello@official", "project", Some(OTHER)).expect("the other copy"),
            "and leaves the rows it cannot attribute where they are"
        );
    }

    /// An uninstall that names one installation forgets exactly that installation's confirmation.
    ///
    /// The user-scope copy and the project-scope copy of one id are two installations. Removing one
    /// must not take the other's confirmation with it (the remaining copy would then read as
    /// unconfirmed while still enabled, and the next install would quarantine it).
    #[test]
    fn uninstalling_one_installation_keeps_the_other_scopes_grant() {
        let conn = connection();
        grant(&conn, "hello@official", "user", SHARED, 1).expect("user grant");
        grant(&conn, "hello@official", "project", DEMO, 2).expect("project grant here");
        grant(&conn, "hello@official", "project", OTHER, 3).expect("project grant elsewhere");

        revoke_installation(&conn, "hello@official", "project", Some(DEMO)).expect("project gone");
        assert!(
            is_granted(&conn, "hello@official", "user", None).expect("the user copy"),
            "removing the project copy leaves the user-scope confirmation"
        );
        assert!(
            is_granted(&conn, "hello@official", "project", Some(OTHER)).expect("the other copy"),
            "and leaves another workspace's project confirmation"
        );

        revoke_installation(&conn, "hello@official", "user", None).expect("user gone");
        assert!(
            !is_granted(&conn, "hello@official", "user", None).expect("the user copy is gone"),
            "removing the user copy forgets the shared row"
        );
        assert!(
            is_granted(&conn, "hello@official", "project", Some(OTHER)).expect("the other copy"),
            "and still leaves the project copy alone"
        );

        // A project installation without its workspace is not attributable: nothing is deleted.
        grant(&conn, "hello@official", "project", DEMO, 4).expect("project grant here again");
        revoke_installation(&conn, "hello@official", "project", None).expect("unattributable");
        assert!(
            is_granted(&conn, "hello@official", "project", Some(DEMO)).expect("still there"),
            "an uninstall that names no workspace cannot say which project copy it removed"
        );
    }

    /// A scope is part of the key: a missing scope is a different installation, not a shorter
    /// spelling of one that exists.
    #[test]
    fn an_unknown_scope_is_not_a_grant() {
        let conn = connection();
        grant(&conn, "hello@official", "user", SHARED, 1).expect("user grant");
        assert!(
            !is_granted(&conn, "hello@official", "workspace", Some(DEMO)).expect("unknown scope")
        );
        assert_eq!(list(&conn, Some(DEMO)).expect("one row").len(), 1);
    }
}

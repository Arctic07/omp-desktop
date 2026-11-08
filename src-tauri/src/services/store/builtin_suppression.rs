//! The built-in plugins the user has removed, remembered so a later start does not seed them back.
//!
//! A plugin this application ships with is installed by the seed through the engine like any other
//! install, so the removal of one is not visible in anything the engine holds: the next start would
//! find the installation missing and put it back. This table is the fact that keeps the user's
//! removal from undoing itself - one row per built-in installation the user removed, holding the
//! moment it was written.
//!
//! Owner: [`crate::services::plugins::builtin`], written by an uninstall of a *verified* built-in
//! installation and read by the seed before it plans anything. Upper bound: the number of built-in
//! definitions this build ships - a row only exists for an installation this application itself
//! seeded and the user then removed. Released by the restore command, which clears the row before
//! seeding the installation again. The table's own schema and its bounds are stated once, where v7
//! is (`services::store::schema`).
//!
//! The statements follow the rest of the store: a failed `INSERT`/`DELETE`/`SELECT` means the file,
//! and the caller cannot act on the SQLite detail, so it is reported with the stable store code.

use rusqlite::{params, Connection};

use crate::errors::{IpcError, IpcResult, STORE_UNAVAILABLE};

/// Every suppressed installation id, in a stable order.
///
/// The order is over the stored text, which makes the list a function of the table alone: a caller
/// that only needs "is this one suppressed" reads it from here as well, and the ordering is what
/// keeps the answer from depending on the order rows happened to be written in.
const LIST_SQL: &str = "SELECT plugin_id FROM builtin_suppressed ORDER BY plugin_id ASC";

/// Records one removal, replacing the moment of a row that was already there.
///
/// Suppressing the same installation twice is the same fact written twice, so it must not fail and
/// must not leave two rows: `INSERT OR REPLACE` keeps the newest moment the user removed it.
const SUPPRESS_SQL: &str = "INSERT OR REPLACE INTO builtin_suppressed (plugin_id, suppressed_at) \
     VALUES (?1, ?2)";

/// Forgets one removal, which is what the restore command does before it seeds the installation
/// again.
const RESTORE_SQL: &str = "DELETE FROM builtin_suppressed WHERE plugin_id = ?1";

/// Every built-in installation id the user has removed.
pub(crate) fn list(conn: &Connection) -> IpcResult<Vec<String>> {
    let mut statement = conn.prepare(LIST_SQL).map_err(|_| read_failed())?;
    let rows = statement
        .query_map(params![], |row| row.get::<_, String>(0))
        .map_err(|_| read_failed())?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(|_| read_failed())?);
    }
    Ok(ids)
}

/// Records or forgets one removal: `true` writes the row, `false` deletes it.
///
/// Both directions are safe to call for a state that already holds - suppressing twice writes the
/// same row again, and restoring an installation that was never suppressed forgets a row that was
/// not there - because neither is a failure: the caller is stating what the user asked for, not a
/// transition the table has to witness.
pub(crate) fn set(
    conn: &Connection,
    plugin_id: &str,
    suppressed: bool,
    now_ms: i64,
) -> IpcResult<()> {
    if suppressed {
        conn.execute(SUPPRESS_SQL, params![plugin_id, now_ms])
            .map_err(|_| write_failed())?;
    } else {
        conn.execute(RESTORE_SQL, params![plugin_id])
            .map_err(|_| write_failed())?;
    }
    Ok(())
}

/// A failed read: the suppression table is the only place this answer lives, so there is nothing to
/// fall back to and nothing the caller can do about the SQLite detail.
fn read_failed() -> IpcError {
    IpcError::new(
        STORE_UNAVAILABLE,
        "The built-in suppression record could not be read.",
    )
}

/// The same failure on the write path: the removal is not recorded, so the seed keeps whatever
/// answer it had.
fn write_failed() -> IpcError {
    IpcError::new(
        STORE_UNAVAILABLE,
        "The built-in suppression record could not be stored.",
    )
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;
    use crate::services::store::schema;

    /// A connection holding the suppression table, built by the store's own steps in the store's
    /// own order.
    ///
    /// The steps record themselves in `schema_migrations`, which v1 creates, so assembling this by
    /// hand would be a fixture that cannot even run the real DDL path - and a copy of the DDL that
    /// could drift from it. v1 is what the record table needs, and v7 is the step that gives the
    /// suppression table the shape these statements are written against.
    fn connection() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory store");
        schema::apply_v1(&conn).expect("v1 objects");
        schema::apply_v7(&conn).expect("the suppression table");
        conn
    }

    /// One row per removed installation, whatever the user does and how often: suppressing twice is
    /// the same fact written twice and keeps a single row, and restoring forgets exactly the
    /// installation it names.
    #[test]
    fn a_suppression_is_one_row_per_installation_and_can_be_restored() {
        let conn = connection();
        assert!(list(&conn).expect("empty table").is_empty());

        set(&conn, "omp.terminal@omp-desktop-builtin", true, 1_000).expect("removed");
        assert_eq!(
            list(&conn).expect("one row"),
            vec!["omp.terminal@omp-desktop-builtin".to_owned()]
        );

        // The same removal again: not an error, and not a second row.
        set(&conn, "omp.terminal@omp-desktop-builtin", true, 2_000).expect("the same fact again");
        assert_eq!(list(&conn).expect("still one row").len(), 1);

        set(&conn, "omp.terminal@omp-desktop-builtin", false, 3_000).expect("restored");
        assert!(list(&conn).expect("gone").is_empty());
        // Restoring again is not an error: nothing was left to forget.
        set(&conn, "omp.terminal@omp-desktop-builtin", false, 4_000).expect("idempotent");
    }

    /// The list is a function of the table alone: two removals are answered in a stable id order
    /// rather than in the order they happened to be written.
    #[test]
    fn the_list_is_ordered_by_id() {
        let conn = connection();
        set(&conn, "zeta@marketplace", true, 2).expect("removed");
        set(&conn, "alpha@marketplace", true, 1).expect("removed");
        assert_eq!(
            list(&conn).expect("two rows"),
            vec![
                "alpha@marketplace".to_owned(),
                "zeta@marketplace".to_owned()
            ]
        );

        // Forgetting one leaves the other exactly where it was.
        set(&conn, "alpha@marketplace", false, 3).expect("restored");
        assert_eq!(
            list(&conn).expect("one row left"),
            vec!["zeta@marketplace".to_owned()]
        );
    }
}

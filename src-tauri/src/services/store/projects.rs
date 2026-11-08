//! Queries for the `projects` table, the workspace registry.
//!
//! Rows are never deleted: `remove` stamps `removed_at` so ids stay stable for anything that
//! recorded one, and every read hides soft-removed rows. A removed root that is registered again is
//! revived by `upsert` with its original id, `pinned` and `sort_order`.

use rusqlite::{params, Connection, Error, OptionalExtension, Row};

use crate::errors::{IpcError, IpcResult, STORE_UNAVAILABLE, WORKSPACE_NOT_FOUND};
use crate::models::store::ProjectRow;

/// Pinned workspaces first, then the rows opened since they were placed (newest first), then the
/// reader's manual order.
///
/// `sort_order_at` is the baseline: a row's `last_opened_at` newer than it has been opened since it
/// was placed, so the activity the rail is built on still reorders the list; a row that has not
/// been touched keeps the place the reader dragged it to.
const LIST_SQL: &str = "SELECT id, root_key, root_path, name, pinned, last_opened_at \
     FROM projects WHERE removed_at IS NULL \
     ORDER BY pinned DESC, \
              (last_opened_at > sort_order_at) DESC, \
              CASE WHEN last_opened_at > sort_order_at THEN last_opened_at ELSE 0 END DESC, \
              sort_order ASC, \
              last_opened_at DESC, \
              id ASC";

const GET_SQL: &str = "SELECT id, root_key, root_path, name, pinned, last_opened_at \
     FROM projects WHERE id = ?1 AND removed_at IS NULL";

const BY_ROOT_KEY_SQL: &str = "SELECT id, root_key, root_path, name, pinned, last_opened_at \
     FROM projects WHERE root_key = ?1";

/// The registry key of one workspace, by id.
///
/// One column, because that is all a caller keying a record by the workspace needs, and the same
/// `removed_at IS NULL` rule the rest of this module reads rows under: a workspace the registry no
/// longer shows is one it no longer answers for.
const ROOT_KEY_SQL: &str = "SELECT root_key FROM projects WHERE id = ?1 AND removed_at IS NULL";

/// Registers `root_key` or refreshes the existing registration.
///
/// `root_path` and `last_opened_at` always take the caller's values and `removed_at` is cleared, so
/// re-adding a removed workspace is visible again. The stored `name` is kept unless it is still
/// empty, because a name the user typed must outlive every later re-add.
const UPSERT_SQL: &str = "INSERT INTO projects \
     (root_key, root_path, name, pinned, sort_order, missing_at, removed_at, created_at, last_opened_at) \
     VALUES (?1, ?2, ?3, 0, 0, NULL, NULL, ?4, ?4) \
     ON CONFLICT(root_key) DO UPDATE SET \
     root_path = excluded.root_path, \
     removed_at = NULL, \
     last_opened_at = excluded.last_opened_at, \
     name = CASE WHEN projects.name = '' THEN excluded.name ELSE projects.name END";

const RENAME_SQL: &str = "UPDATE projects SET name = ?2 WHERE id = ?1 AND removed_at IS NULL";

const TOUCH_SQL: &str =
    "UPDATE projects SET last_opened_at = ?2 WHERE id = ?1 AND removed_at IS NULL";

/// `COALESCE` keeps the timestamp of the first removal, so a repeated call cannot reorder history.
const REMOVE_SQL: &str = "UPDATE projects SET removed_at = COALESCE(removed_at, ?2) WHERE id = ?1";

/// The manual order, written by [`reorder`]: a workspace's position is its index in the caller's
/// list, and `sort_order_at` takes the row's own last-open time as the baseline activity is
/// measured against. A row the caller does not name keeps both values.
const REORDER_SQL: &str = "UPDATE projects SET sort_order = ?2, sort_order_at = last_opened_at \
     WHERE id = ?1 AND removed_at IS NULL";

pub(crate) fn list(conn: &Connection) -> IpcResult<Vec<ProjectRow>> {
    let mut stmt = conn.prepare(LIST_SQL).map_err(store_error)?;
    let rows = stmt.query_map([], read_row).map_err(store_error)?;
    rows.collect::<rusqlite::Result<Vec<ProjectRow>>>()
        .map_err(store_error)
}

pub(crate) fn get(conn: &Connection, id: i64) -> IpcResult<ProjectRow> {
    conn.query_row(GET_SQL, params![id], read_row)
        .map_err(single_row_error)
}

/// The registry key of one workspace, when the registry still holds it.
///
/// `None` is the answer for an id it does not hold and for one it soft-removed, and it is a fact
/// rather than a failure: the caller decides what it can still do for a workspace it has no key
/// for. Nothing is substituted for a key nobody has - a record keyed by a value that stands for no
/// workspace would be a record about no installation.
pub(crate) fn root_key(conn: &Connection, id: i64) -> IpcResult<Option<String>> {
    conn.query_row(ROOT_KEY_SQL, params![id], |row| row.get(0))
        .optional()
        .map_err(store_error)
}

pub(crate) fn upsert(
    conn: &Connection,
    root_key: &str,
    root_path: &str,
    name: &str,
    now_ms: i64,
) -> IpcResult<ProjectRow> {
    conn.execute(UPSERT_SQL, params![root_key, root_path, name, now_ms])
        .map_err(store_error)?;
    conn.query_row(BY_ROOT_KEY_SQL, params![root_key], read_row)
        .map_err(single_row_error)
}

pub(crate) fn rename(conn: &Connection, id: i64, name: &str) -> IpcResult<ProjectRow> {
    // `execute` reports the matched row count, not a value change: renaming to the current name and
    // renaming an unknown id are distinguishable.
    if conn
        .execute(RENAME_SQL, params![id, name])
        .map_err(store_error)?
        == 0
    {
        return Err(not_registered());
    }
    get(conn, id)
}

pub(crate) fn touch(conn: &Connection, id: i64, now_ms: i64) -> IpcResult<()> {
    if conn
        .execute(TOUCH_SQL, params![id, now_ms])
        .map_err(store_error)?
        == 0
    {
        return Err(not_registered());
    }
    Ok(())
}

pub(crate) fn remove(conn: &Connection, id: i64, now_ms: i64) -> IpcResult<()> {
    if conn
        .execute(REMOVE_SQL, params![id, now_ms])
        .map_err(store_error)?
        == 0
    {
        return Err(not_registered());
    }
    Ok(())
}

/// Writes the manual order of the registry: the position of each named workspace is its index in
/// `ids`.
///
/// One transaction, because a half-written order would interleave two arrangements. `LIST_SQL`
/// reads `pinned DESC, sort_order ASC, last_opened_at DESC`, so a named row stands where the caller
/// put it, and a row the caller did not name (a workspace added after the order was written) falls
/// back to the recency tie-break - which is where a newly added workspace has always appeared.
pub(crate) fn reorder(conn: &Connection, ids: &[i64]) -> IpcResult<()> {
    let tx = conn.unchecked_transaction().map_err(store_error)?;
    {
        let mut statement = tx.prepare(REORDER_SQL).map_err(store_error)?;
        for (index, id) in ids.iter().enumerate() {
            statement
                .execute(params![id, index as i64])
                .map_err(store_error)?;
        }
    }
    tx.commit().map_err(store_error)
}

fn read_row(row: &Row<'_>) -> rusqlite::Result<ProjectRow> {
    Ok(ProjectRow {
        id: row.get("id")?,
        root_key: row.get("root_key")?,
        root_path: row.get("root_path")?,
        name: row.get("name")?,
        pinned: row.get::<_, i64>("pinned")? != 0,
        last_opened_at: row.get("last_opened_at")?,
    })
}

/// One message for every statement failure: the causes are a damaged file or a schema this build
/// does not know, and neither leaves the caller with anything actionable to show.
fn store_error(_: Error) -> IpcError {
    IpcError::new(
        STORE_UNAVAILABLE,
        "The workspace registry could not complete the request.",
    )
}

fn single_row_error(err: Error) -> IpcError {
    match err {
        Error::QueryReturnedNoRows => not_registered(),
        other => store_error(other),
    }
}

fn not_registered() -> IpcError {
    IpcError::new(
        WORKSPACE_NOT_FOUND,
        "The workspace is no longer registered.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::services::store::{fresh_store_dir, lock, Store};

    fn fresh(suffix: &str) -> (Store, std::path::PathBuf) {
        let dir = fresh_store_dir(suffix);
        let store = Store::open(&dir.join("app.sqlite")).expect("store");
        (store, dir)
    }

    fn names(store: &Store) -> Vec<String> {
        let conn = lock(&store.conn).expect("lock");
        list(&conn)
            .expect("list")
            .into_iter()
            .map(|row| row.name)
            .collect()
    }

    /// Registers `names` in order, each one opened a millisecond later than the last, starting at
    /// `opened_at`.
    fn add(store: &Store, names: &[&str], opened_at: i64) -> Vec<i64> {
        let conn = lock(&store.conn).expect("lock");
        names
            .iter()
            .enumerate()
            .map(|(index, name)| {
                upsert(
                    &conn,
                    name,
                    &format!("D:/{name}"),
                    name,
                    opened_at + index as i64,
                )
                .expect("upsert")
                .id
            })
            .collect()
    }

    #[test]
    fn a_written_order_replaces_recency_and_leaves_later_rows_to_it() {
        let (store, dir) = fresh("projects-reorder");
        let ids = add(&store, &["a", "b", "c"], 1_000);
        assert_eq!(names(&store), ["c", "b", "a"], "recency until rearranged");

        {
            let conn = lock(&store.conn).expect("lock");
            reorder(&conn, &[ids[0], ids[2], ids[1]]).expect("reorder");
        }
        assert_eq!(names(&store), ["a", "c", "b"]);

        // A workspace added afterwards was never named by the order, so the recency tie-break
        // decides - the newest row first, which is where adding a workspace has always put it.
        add(&store, &["d"], 2_000);
        assert_eq!(names(&store), ["d", "a", "c", "b"]);

        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_workspace_opened_after_it_was_placed_sorts_by_activity_again() {
        let (store, dir) = fresh("projects-reorder-activity");
        let ids = add(&store, &["a", "b", "c"], 1_000);
        {
            let conn = lock(&store.conn).expect("lock");
            reorder(&conn, &[ids[0], ids[2], ids[1]]).expect("reorder");
        }
        assert_eq!(names(&store), ["a", "c", "b"], "the arrangement holds");

        // Opening `b` writes its last-open time, which is now newer than the baseline the
        // arrangement recorded: the activity the rail is built on reorders it to the top, and the
        // rows nobody opened since keep the place they were dragged to.
        {
            let conn = lock(&store.conn).expect("lock");
            touch(&conn, ids[1], 3_000).expect("touch");
        }
        assert_eq!(names(&store), ["b", "a", "c"]);

        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

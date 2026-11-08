//! The cold status of a session the user has already read.
//!
//! A session's status is the engine's own fact, written into its session file; whether the user
//! has *seen* that status is this app's fact and nothing else's. It used to live only in the
//! renderer's memory, which is why every restart turned a session the user had already opened
//! back into an unread mark. Storing it in the app's own database is what makes the mark outlive
//! the process, and the row holds nothing but (session id, status): the engine's data directory
//! stays the only writer of session files.

use rusqlite::{params, Connection};

use crate::errors::{IpcError, IpcResult, STORE_UNAVAILABLE};
use crate::models::agent::{SessionColdStatus, SessionReadMark};

/// Rows kept in `session_reads`.
///
/// The rows are the app's own bookkeeping about sessions that may no longer exist, so the table is
/// bounded by row count and nothing else. Pruning against the engine's directory scan instead
/// would couple every mark write to a scan that runs per workspace.
pub(crate) const SESSION_READ_LIMIT: usize = 8000;

/// Newest first, because the caller renders one mark per session row and a session the user read
/// most recently is the one the window is most likely to hold.
const LIST_SQL: &str =
    "SELECT session_id, status, seen_at FROM session_reads ORDER BY seen_at DESC LIMIT ?1";

/// Every recorded mark, newest first.
///
/// At most `SESSION_READ_LIMIT` rows come back, so the caller can take the whole table in one call:
/// one mark is a session id and a status, not a payload worth paging.
pub(crate) fn list(conn: &Connection) -> IpcResult<Vec<SessionReadMark>> {
    let mut statement = conn.prepare(LIST_SQL).map_err(|_| read_failed())?;
    let rows = statement
        .query_map(params![SESSION_READ_LIMIT as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|_| read_failed())?;
    let mut marks = Vec::new();
    for row in rows {
        let (session_id, status, seen_at) = row.map_err(|_| read_failed())?;
        // Text outside the vocabulary is a status some other build wrote. Such a row draws no
        // mark at all, so falling back to `unknown` keeps one unreadable row from failing the
        // whole list - and the next write for that session replaces it anyway.
        marks.push(SessionReadMark {
            session_id,
            status: SessionColdStatus::from_wire(&status).unwrap_or(SessionColdStatus::Unknown),
            seen_at,
        });
    }
    Ok(marks)
}

/// Records one session's status as read, replacing whatever the row held.
///
/// The upsert and the prune share one transaction: a crash between them would leave the table over
/// its cap until the next write, and the cap is the only thing keeping this table bounded.
pub(crate) fn set(
    conn: &Connection,
    session_id: &str,
    status: SessionColdStatus,
    now_ms: i64,
) -> IpcResult<()> {
    let tx = conn.unchecked_transaction().map_err(|_| write_failed())?;
    tx.execute(
        "INSERT INTO session_reads (session_id, status, seen_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT(session_id) DO UPDATE SET status = excluded.status, \
         seen_at = excluded.seen_at",
        params![session_id, status.wire(), now_ms],
    )
    .map_err(|_| write_failed())?;
    // Only the newest rows survive. Every `seen_at` comes from the same clock, so a tie at the
    // window's edge is the one case where which of two rows is dropped is arbitrary.
    tx.execute(
        "DELETE FROM session_reads WHERE session_id NOT IN \
         (SELECT session_id FROM session_reads ORDER BY seen_at DESC LIMIT ?1)",
        params![SESSION_READ_LIMIT as i64],
    )
    .map_err(|_| write_failed())?;
    tx.commit().map_err(|_| write_failed())
}

/// Forgets one session's mark.
///
/// Called when the conversation itself is deleted: the mark is this app's record of a session that
/// no longer exists, and leaving it would keep a row for a file nothing can open - and would draw a
/// stale "read" verdict if a future session ever reused the id.
pub(crate) fn remove(conn: &Connection, session_id: &str) -> IpcResult<()> {
    conn.execute(
        "DELETE FROM session_reads WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|_| write_failed())?;
    Ok(())
}

/// A failed statement means the file, and the caller cannot act on the SQLite detail: the app has
/// nowhere else to keep the marks.
fn read_failed() -> IpcError {
    IpcError::new(
        STORE_UNAVAILABLE,
        "The session read marks could not be read.",
    )
}

/// The same failure on the write path: the mark is not recorded, and the session keeps whatever
/// mark it had.
fn write_failed() -> IpcError {
    IpcError::new(
        STORE_UNAVAILABLE,
        "The session read mark could not be stored.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    use crate::services::store::{fresh_store_dir, lock, Store};

    /// A store of its own, opened through the real entry point, so the tests also cover the v3 DDL
    /// and the version gate a running app goes through. The directory comes back for cleanup.
    fn fresh(suffix: &str) -> (Store, std::path::PathBuf) {
        let dir = fresh_store_dir(suffix);
        let store = Store::open(&dir.join("app.sqlite")).expect("store");
        (store, dir)
    }

    fn marks(store: &Store) -> Vec<SessionReadMark> {
        let conn = lock(&store.conn).expect("lock");
        list(&conn).expect("list")
    }

    fn set_mark(store: &Store, session_id: &str, status: SessionColdStatus, now_ms: i64) {
        let conn = lock(&store.conn).expect("lock");
        set(&conn, session_id, status, now_ms).expect("set");
    }

    /// Writes text straight into the table, the way a future build with a wider vocabulary would
    /// have left it behind.
    fn seed(store: &Store, session_id: &str, status: &str, seen_at: i64) {
        let conn = lock(&store.conn).expect("lock");
        conn.execute(
            "INSERT INTO session_reads (session_id, status, seen_at) VALUES (?1, ?2, ?3)",
            params![session_id, status, seen_at],
        )
        .expect("seed row");
    }

    #[test]
    fn a_mark_round_trips_and_an_overwrite_replaces_the_status_it_held() {
        let (store, dir) = fresh("roundtrip");
        assert!(marks(&store).is_empty(), "a fresh store has no marks");

        set_mark(&store, "s0001", SessionColdStatus::Aborted, 10);
        assert_eq!(
            marks(&store),
            vec![SessionReadMark {
                session_id: "s0001".to_owned(),
                status: SessionColdStatus::Aborted,
                seen_at: 10,
            }]
        );

        // The user reads the same session again after another failed turn: the newer status has
        // to replace the old one, and the session must not gain a second row.
        set_mark(&store, "s0001", SessionColdStatus::Complete, 20);
        set_mark(&store, "s0002", SessionColdStatus::Pending, 30);
        assert_eq!(
            marks(&store),
            vec![
                SessionReadMark {
                    session_id: "s0002".to_owned(),
                    status: SessionColdStatus::Pending,
                    seen_at: 30,
                },
                SessionReadMark {
                    session_id: "s0001".to_owned(),
                    status: SessionColdStatus::Complete,
                    seen_at: 20,
                },
            ]
        );
        // Close the connection first: Windows keeps a file locked while it is open.
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_row_outside_the_vocabulary_reads_as_unknown_instead_of_failing_the_list() {
        let (store, dir) = fresh("vocabulary");
        seed(&store, "s0001", "aborted", 10);
        seed(&store, "s0002", "exploded", 20);

        let marks = marks(&store);
        assert_eq!(
            marks,
            vec![
                SessionReadMark {
                    session_id: "s0002".to_owned(),
                    status: SessionColdStatus::Unknown,
                    seen_at: 20,
                },
                SessionReadMark {
                    session_id: "s0001".to_owned(),
                    status: SessionColdStatus::Aborted,
                    seen_at: 10,
                },
            ]
        );
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The cap is the table's whole lifecycle: nothing else ever deletes a row.
    #[test]
    fn the_table_keeps_the_newest_marks_and_prunes_the_rest() {
        const EXTRA: usize = 5;
        let (store, dir) = fresh("cap");
        {
            let conn = lock(&store.conn).expect("lock");
            let tx = conn.unchecked_transaction().expect("transaction");
            for index in 1..=SESSION_READ_LIMIT + EXTRA {
                tx.execute(
                    "INSERT INTO session_reads (session_id, status, seen_at) VALUES (?1, ?2, ?3)",
                    params![format!("s{index:05}"), "complete", index as i64],
                )
                .expect("row");
            }
            tx.commit().expect("commit");
        }

        let newest = SESSION_READ_LIMIT + EXTRA + 1;
        set_mark(&store, "s-newest", SessionColdStatus::Error, newest as i64);

        let marks = marks(&store);
        assert_eq!(marks.len(), SESSION_READ_LIMIT);
        assert_eq!(marks[0].session_id, "s-newest");
        assert_eq!(marks[1].session_id, format!("s{:05}", newest - 1));
        // One write past the cap drops exactly the oldest row: the window slid by one, it did not
        // throw the table away.
        assert_eq!(
            marks[SESSION_READ_LIMIT - 1].session_id,
            format!("s{:05}", EXTRA + 2)
        );
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A deleted conversation takes its mark with it, and only its own.
    ///
    /// The mark is this app's record of a session the engine wrote; deleting a conversation removes
    /// the file, so a mark left behind would describe a row that can never be opened again - and
    /// hold one of the table's `SESSION_READ_LIMIT` slots for it.
    #[test]
    fn removing_one_mark_leaves_every_other_row_where_it_was() {
        let (store, dir) = fresh("remove");
        set_mark(&store, "s0001", SessionColdStatus::Aborted, 10);
        set_mark(&store, "s0002", SessionColdStatus::Complete, 20);
        set_mark(&store, "s0003", SessionColdStatus::Pending, 30);

        {
            let conn = lock(&store.conn).expect("lock");
            remove(&conn, "s0002").expect("remove");
            // Removing what is not there is not a failure: the caller asked for the row to be gone.
            remove(&conn, "s-never-seen").expect("remove missing");
        }

        assert_eq!(
            marks(&store)
                .into_iter()
                .map(|mark| mark.session_id)
                .collect::<Vec<_>>(),
            vec!["s0003".to_owned(), "s0001".to_owned()]
        );
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

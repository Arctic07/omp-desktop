//! The two decisions the user makes about a conversation's place in its workspace's list.
//!
//! *Pinned* is "keep this row above the rest"; *archived* is "I am done with this one" - it leaves
//! the list the rail draws until the reader asks for the archived rows. Neither is the engine's
//! fact: a session file holds a transcript and the engine's own bookkeeping, and nothing in it has
//! a slot for either decision. They live here, keyed by the id the rail routes the conversation by
//! (`session_index::host_session_id`), the same one the read marks and the open tabs use.
//!
//! One row is one conversation with at least one flag on; clearing the last flag deletes the row,
//! so the table never grows past the number of conversations the user is holding at the top or has
//! put away. The stored moment (`pinned_at`, `archived_at`) is when the flag was set, which is what
//! tells a restart when the decision was made; nothing sorts by it today.

use std::collections::HashMap;

use rusqlite::{params, Connection};

use crate::errors::{IpcError, IpcResult, STORE_UNAVAILABLE};

/// The flags one conversation carries, as the store holds them. The id is the map's key, so it is
/// not repeated on the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SessionFlags {
    pub(crate) pinned: bool,
    pub(crate) archived: bool,
}

/// Every conversation that carries a flag, as a map keyed by session id: the list command merges
/// this into the rows it read from disk, and a row it does not name carries neither flag.
pub(crate) fn map(conn: &Connection) -> IpcResult<HashMap<String, SessionFlags>> {
    let mut statement = conn
        .prepare("SELECT session_id, pinned_at, archived_at FROM session_flags")
        .map_err(|_| read_failed())?;
    let rows = statement
        .query_map(params![], |row| {
            Ok((
                row.get::<_, String>(0)?,
                SessionFlags {
                    pinned: row.get::<_, Option<i64>>(1)?.is_some(),
                    archived: row.get::<_, Option<i64>>(2)?.is_some(),
                },
            ))
        })
        .map_err(|_| read_failed())?;
    let mut flags = HashMap::new();
    for row in rows {
        let (session_id, flag) = row.map_err(|_| read_failed())?;
        flags.insert(session_id, flag);
    }
    Ok(flags)
}

/// Sets or clears the pin of one conversation, leaving its archived flag alone.
///
/// The insert and the update share one transaction with the prune: the row only exists while a flag
/// is on, and a crash between the update and the prune would leave an empty row behind - harmless
/// to read, but the bound on this table is the flags themselves.
pub(crate) fn set_pinned(
    conn: &Connection,
    session_id: &str,
    pinned: bool,
    now_ms: i64,
) -> IpcResult<()> {
    write(conn, session_id, "pinned_at", pinned, now_ms)
}

/// Sets or clears the archived flag of one conversation, leaving its pin alone.
pub(crate) fn set_archived(
    conn: &Connection,
    session_id: &str,
    archived: bool,
    now_ms: i64,
) -> IpcResult<()> {
    write(conn, session_id, "archived_at", archived, now_ms)
}

/// Forgets both flags of one conversation, for the session that is being deleted.
pub(crate) fn remove(conn: &Connection, session_id: &str) -> IpcResult<()> {
    conn.execute(
        "DELETE FROM session_flags WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|_| write_failed())?;
    Ok(())
}

/// The one write both setters run: the column is chosen here from the two callers above, so the
/// statement is written once. `column` is never caller-supplied.
fn write(
    conn: &Connection,
    session_id: &str,
    column: &'static str,
    on: bool,
    now_ms: i64,
) -> IpcResult<()> {
    let tx = conn.unchecked_transaction().map_err(|_| write_failed())?;
    // A row that does not exist yet is created with both columns NULL, then the one flag is set:
    // the other flag's existing value is what the second statement leaves untouched.
    tx.execute(
        "INSERT OR IGNORE INTO session_flags (session_id) VALUES (?1)",
        params![session_id],
    )
    .map_err(|_| write_failed())?;
    tx.execute(
        &format!("UPDATE session_flags SET {column} = ?2 WHERE session_id = ?1"),
        params![session_id, on.then_some(now_ms)],
    )
    .map_err(|_| write_failed())?;
    tx.execute(
        "DELETE FROM session_flags WHERE pinned_at IS NULL AND archived_at IS NULL",
        params![],
    )
    .map_err(|_| write_failed())?;
    tx.commit().map_err(|_| write_failed())
}

/// A failed read means the file, and the caller cannot act on the SQLite detail: the row then
/// carries neither flag, which is what a store holding no decision says.
fn read_failed() -> IpcError {
    IpcError::new(STORE_UNAVAILABLE, "The session flags could not be read.")
}

/// The same failure on the write path: the decision is not recorded, and the row keeps the flags it
/// had.
fn write_failed() -> IpcError {
    IpcError::new(STORE_UNAVAILABLE, "The session flag could not be stored.")
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::services::store::{fresh_store_dir, lock, Store};

    /// A store of its own, opened through the real entry point, so the tests also cover the v8 DDL
    /// and the version gate a running app goes through. The directory comes back for cleanup.
    fn fresh(suffix: &str) -> (Store, std::path::PathBuf) {
        let dir = fresh_store_dir(suffix);
        let store = Store::open(&dir.join("app.sqlite")).expect("store");
        (store, dir)
    }

    fn flags(store: &Store) -> HashMap<String, SessionFlags> {
        let conn = lock(&store.conn).expect("lock");
        map(&conn).expect("list")
    }

    fn write_flag(store: &Store, session_id: &str, pinned: Option<bool>, archived: Option<bool>) {
        let conn = lock(&store.conn).expect("lock");
        if let Some(on) = pinned {
            set_pinned(&conn, session_id, on, 10).expect("pin");
        }
        if let Some(on) = archived {
            set_archived(&conn, session_id, on, 20).expect("archive");
        }
    }

    #[test]
    fn both_flags_round_trip_and_stay_independent_of_each_other() {
        let (store, dir) = fresh("flags-roundtrip");
        assert!(flags(&store).is_empty(), "a fresh store holds no flags");

        write_flag(&store, "s0001", Some(true), None);
        assert_eq!(
            flags(&store).get("s0001"),
            Some(&SessionFlags {
                pinned: true,
                archived: false,
            })
        );

        // Archiving a pinned conversation keeps the pin: the two decisions are about different
        // things, and the row is one conversation rather than one row per flag.
        write_flag(&store, "s0001", None, Some(true));
        assert_eq!(
            flags(&store).get("s0001"),
            Some(&SessionFlags {
                pinned: true,
                archived: true,
            })
        );

        // Clearing one flag leaves the other, and clearing the last one takes the row with it.
        write_flag(&store, "s0001", Some(false), None);
        assert_eq!(
            flags(&store).get("s0001"),
            Some(&SessionFlags {
                pinned: false,
                archived: true,
            })
        );
        write_flag(&store, "s0001", None, Some(false));
        assert!(flags(&store).is_empty(), "no flag on means no row");

        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_a_conversation_forgets_its_flags() {
        let (store, dir) = fresh("flags-delete");
        write_flag(&store, "s0001", Some(true), Some(true));
        {
            let conn = lock(&store.conn).expect("lock");
            remove(&conn, "s0001").expect("forget");
        }
        assert!(flags(&store).is_empty());

        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

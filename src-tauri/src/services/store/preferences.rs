//! Key/value preferences, stored as opaque JSON so a new preference never needs DDL.

use rusqlite::{params, Connection};

use crate::errors::{IpcError, IpcResult, STORE_UNAVAILABLE};

/// Reads one preference, `None` when it was never written.
pub(super) fn get(conn: &Connection, key: &str) -> IpcResult<Option<String>> {
    conn.query_row(
        "SELECT value_json FROM preferences WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        _ => Err(IpcError::new(
            STORE_UNAVAILABLE,
            "The preference could not be read.",
        )),
    })
}

/// Writes one preference. Timestamps come from the caller so ordering stays comparable with the
/// engine's own millisecond timestamps.
pub(super) fn set(conn: &Connection, key: &str, value_json: &str, now_ms: i64) -> IpcResult<()> {
    conn.execute(
        "INSERT INTO preferences (key, value_json, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, \
         updated_at = excluded.updated_at",
        params![key, value_json, now_ms],
    )
    .map(|_| ())
    .map_err(|_| IpcError::new(STORE_UNAVAILABLE, "The preference could not be stored."))
}

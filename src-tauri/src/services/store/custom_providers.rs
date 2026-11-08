//! User-defined providers (`models.yml` entries this application generates).

use rusqlite::{params, Connection};

use crate::errors::{IpcError, IpcResult, STORE_UNAVAILABLE};
use crate::models::store::CustomProviderRow;

/// Every stored provider, ordered by id so the settings list is stable.
pub(super) fn list(conn: &Connection) -> IpcResult<Vec<CustomProviderRow>> {
    let mut statement = conn
        .prepare(
            "SELECT id, name, base_url, api, models_json FROM custom_providers ORDER BY id ASC",
        )
        .map_err(read_failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok(CustomProviderRow {
                id: row.get(0)?,
                name: row.get(1)?,
                base_url: row.get(2)?,
                api: row.get(3)?,
                models_json: row.get(4)?,
            })
        })
        .map_err(read_failed)?;
    rows.collect::<rusqlite::Result<Vec<CustomProviderRow>>>()
        .map_err(read_failed)
}

/// Inserts or replaces one provider, keeping the original `created_at`.
pub(super) fn upsert(conn: &Connection, row: &CustomProviderRow, now_ms: i64) -> IpcResult<()> {
    conn.execute(
        "INSERT INTO custom_providers (id, name, base_url, api, models_json, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) \
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, \
         api = excluded.api, models_json = excluded.models_json, updated_at = excluded.updated_at",
        params![
            row.id,
            row.name,
            row.base_url,
            row.api,
            row.models_json,
            now_ms
        ],
    )
    .map(|_| ())
    .map_err(|_| {
        IpcError::new(
            STORE_UNAVAILABLE,
            "The custom provider could not be stored.",
        )
    })
}

/// Hard delete: the record and its generated `models.yml` entry go away together.
pub(super) fn remove(conn: &Connection, id: &str) -> IpcResult<()> {
    conn.execute("DELETE FROM custom_providers WHERE id = ?1", params![id])
        .map(|_| ())
        .map_err(|_| {
            IpcError::new(
                STORE_UNAVAILABLE,
                "The custom provider could not be removed.",
            )
        })
}

fn read_failed(_: rusqlite::Error) -> IpcError {
    IpcError::new(STORE_UNAVAILABLE, "The custom providers could not be read.")
}

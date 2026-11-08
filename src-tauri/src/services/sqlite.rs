//! The two databases this application owns, held to a size a reader can explain.
//!
//! Both are opened in WAL mode (`services::store::mod`'s `configure`,
//! `services::session_index::projection`'s `open_database`), which is what makes them safe to write
//! from two places and recoverable after a kill - and what leaves two files nobody looks at: the
//! `-wal` beside each, which SQLite truncates only when it chooses to checkpoint, and the free pages
//! inside each, which a deleted conversation leaves behind. Measured on this machine: a 4.7 MB
//! `sessions-index.sqlite-wal` sitting beside a 16 MB file, and the same for `app.sqlite`.
//!
//! Two pragmas fix that, and the rule below is when each is allowed:
//!
//! - **`PRAGMA wal_checkpoint(TRUNCATE)`** returns the log to zero bytes. It is cheap, it loses
//!   nothing, and it runs once per start.
//! - **`VACUUM`** rewrites the file, so it costs a full read and write of it - which is why it is
//!   gated on [`VACUUM_THRESHOLD_BYTES`]. Below the gate the free pages are not worth the pass;
//!   above it, the file is more than this application's metadata has any business weighing.
//!
//! **No write is in flight while either runs**: the pass holds the same connection mutex every
//! statement holds (SQLite serializes them, `services::store::mod`), so a statement from any other
//! caller waits rather than interleaving - that is the whole of "idle window", and it is why no
//! separate activity flag exists to get out of step. Failure is a log line: a database that will not
//! compact is a database that still works, and a start must never fail over maintenance.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::Connection;

use crate::services::log;
use crate::services::store::Store;
use crate::state::SessionIndexCache;

/// How large a database has to be before compacting it is worth a full rewrite.
///
/// 32 MiB: the projection measured 11 MiB for 224 MB of transcripts (224 MB ≈ 3.4 s of parsing), so a
/// file at this size is holding several installations' worth of history and at least as much in free
/// pages. Below it the rewrite would cost more than it returns, and `wal_checkpoint` already returns
/// the log.
pub(crate) const VACUUM_THRESHOLD_BYTES: u64 = 32 * 1024 * 1024;

/// How long after start the pass runs.
///
/// The start-up path is already the busiest moment this process has - the store's migration, the
/// session scan and the host's first start all read the same disk - and a maintenance pass is the
/// one piece of work that may wait for them. A minute is past the first scan and well before a
/// reader would close a window they just opened.
const START_DELAY: Duration = Duration::from_secs(60);

/// What one pass did to one file.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Done {
    pub(crate) checkpointed: bool,
    pub(crate) vacuumed: bool,
}

impl Done {
    fn did_nothing(&self) -> bool {
        !self.checkpointed && !self.vacuumed
    }
}

/// One pass over one open connection: truncate its log, then compact the file if it is over
/// `threshold`.
///
/// `file` is measured, not opened: the connection already owns it, and opening it again would let
/// this module report a size from a different file than the one it compacted.
pub(crate) fn compact(conn: &Connection, file: &Path, threshold: u64) -> Done {
    // The pass runs under the same connection mutex every statement needs, so waiting for the
    // database here freezes the whole caller: measured on this machine, a `TRUNCATE` checkpoint
    // with one reader holding a transaction burns the full busy timeout (5.5 s) and then compacts
    // nothing. Zero means "answer now or skip", which is the trade this pass is supposed to make -
    // a database that is busy is one that still works. The caller's own timeout is restored after.
    let checkpointed = conn
        .busy_timeout(Duration::ZERO)
        .and_then(|()| {
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                row.get::<_, i64>(0)
            })
        })
        .map(|busy| busy == 0)
        .unwrap_or(false);
    let _ = conn.busy_timeout(crate::services::store::BUSY_TIMEOUT);
    let large = std::fs::metadata(file).is_ok_and(|metadata| metadata.len() > threshold);
    let vacuumed = large && conn.execute_batch("VACUUM").is_ok();
    Done {
        checkpointed,
        vacuumed,
    }
}

/// Runs the pass once for both files, after the start-up work has settled.
///
/// Called once per process from the start-up path (`state::AppState::new`).
pub(crate) fn schedule(
    store: Store,
    index: Arc<SessionIndexCache>,
    app_sqlite: PathBuf,
    index_sqlite: PathBuf,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(START_DELAY).await;
        let pass = move || {
            let done = store.maintain(&app_sqlite);
            report("app.sqlite", &app_sqlite, done);
            let done = index.maintain(&index_sqlite);
            report("sessions-index.sqlite", &index_sqlite, done);
        };
        // The work blocks (VACUUM rewrites the file), so it runs off the async workers.
        if tauri::async_runtime::spawn_blocking(pass).await.is_err() {
            log::warn("sqlite: the maintenance pass could not run");
        }
    });
}

/// The one line a pass leaves behind, and only when it changed something.
fn report(label: &str, file: &Path, done: Option<Done>) {
    let Some(done) = done else {
        return;
    };
    if done.did_nothing() {
        return;
    }
    let bytes = std::fs::metadata(file)
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    log::info(&format!(
        "sqlite: {label} {} ({} bytes{})",
        if done.vacuumed {
            "checkpointed and compacted"
        } else {
            "checkpointed"
        },
        bytes,
        if done.vacuumed { " after VACUUM" } else { "" }
    ));
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    /// A database file of this process's own, in WAL mode, with rows that are then deleted: free
    /// pages and a non-empty log, which is exactly the state the pass exists for.
    fn database(tag: &str) -> (PathBuf, Connection) {
        let root = std::env::temp_dir().join(format!("omp-sqlite-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("a directory");
        let file = root.join("db.sqlite");
        let conn = Connection::open(&file).expect("a database");
        conn.pragma_update(None, "journal_mode", "WAL")
            .expect("wal");
        conn.execute_batch(
            "CREATE TABLE rows (id INTEGER PRIMARY KEY, body BLOB);
             INSERT INTO rows (body) VALUES (randomblob(4096));",
        )
        .expect("a table");
        (file, conn)
    }

    fn wal_bytes(file: &Path) -> u64 {
        fs::metadata(format!("{}-wal", file.display()))
            .map(|metadata| metadata.len())
            .unwrap_or_default()
    }

    #[test]
    fn a_checkpoint_returns_the_log_to_zero() {
        let (file, conn) = database("checkpoint");
        assert!(wal_bytes(&file) > 0, "the log holds the commit");

        let done = compact(&conn, &file, VACUUM_THRESHOLD_BYTES);

        assert!(done.checkpointed);
        assert_eq!(wal_bytes(&file), 0, "the log was truncated");
        assert!(!done.vacuumed, "well under the threshold");
        drop(conn);
        let _ = fs::remove_dir_all(file.parent().expect("a root"));
    }

    #[test]
    fn a_file_under_the_threshold_is_left_alone() {
        let (file, conn) = database("small");
        let done = compact(&conn, &file, VACUUM_THRESHOLD_BYTES);
        assert!(!done.vacuumed);
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM rows", [], |row| row.get(0))
            .expect("the rows are still there");
        assert_eq!(rows, 1);
        drop(conn);
        let _ = fs::remove_dir_all(file.parent().expect("a root"));
    }

    #[test]
    fn a_file_over_the_threshold_is_compacted_once() {
        let (file, conn) = database("large");
        // The threshold is the gate, so a pass that has to compact passes zero: the file is not empty.
        let done = compact(&conn, &file, 0);
        assert!(done.vacuumed);
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM rows", [], |row| row.get(0))
            .expect("the rows survived the rewrite");
        assert_eq!(rows, 1, "VACUUM keeps every row");
        drop(conn);
        let _ = fs::remove_dir_all(file.parent().expect("a root"));
    }

    #[test]
    fn a_pass_that_cannot_compact_answers_instead_of_failing() {
        let (file, conn) = database("busy");
        // VACUUM cannot run inside a transaction, which is what a write in flight looks like from
        // SQLite's side: the pass answers "did not compact" rather than taking the start down.
        conn.execute_batch("BEGIN; INSERT INTO rows (body) VALUES (randomblob(16));")
            .expect("an open transaction");

        let done = compact(&conn, &file, 0);

        assert!(!done.vacuumed, "a write in flight refuses the rewrite");
        conn.execute_batch("ROLLBACK").expect("rollback");
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM rows", [], |row| row.get(0))
            .expect("the rows are still there");
        assert_eq!(rows, 1);
        drop(conn);
        let _ = fs::remove_dir_all(file.parent().expect("a root"));
    }

    /// The regression this covers: a maintenance pass that waits for a busy database freezes
    /// whoever holds the connection mutex - the whole application, for the length of the busy
    /// timeout - and then reports a checkpoint it did not perform. The pass must give up instead.
    #[test]
    fn a_busy_database_is_skipped_instead_of_waited_for() {
        let root = std::env::temp_dir().join(format!("omp-sqlite-busy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("workspace");
        let file = root.join("busy.sqlite");

        let reader = Connection::open(&file).expect("open");
        reader
            .pragma_update(None, "journal_mode", "WAL")
            .expect("wal");
        reader
            .execute_batch("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1);")
            .expect("schema");
        // A read transaction open across the pass is what a running query looks like from SQLite's
        // side, and it is what made `TRUNCATE` wait.
        reader
            .execute_batch("BEGIN; SELECT count(*) FROM t;")
            .expect("reader");

        let pass = Connection::open(&file).expect("open pass");
        let started = std::time::Instant::now();
        let done = compact(&pass, &file, u64::MAX);
        let elapsed = started.elapsed();

        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "the pass waited {elapsed:?}"
        );
        assert!(!done.checkpointed, "a busy checkpoint is not a checkpoint");

        reader.execute_batch("COMMIT").ok();
        let _ = fs::remove_dir_all(&root);
    }
}

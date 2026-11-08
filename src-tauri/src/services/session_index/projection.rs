//! A persisted projection of the engine's session store, kept beside the memory cache so a scan
//! does not begin from nothing after a restart.
//!
//! **The engine's files stay the truth.** This module opens them for reading and writes nothing
//! into the engine's tree: what it persists is a copy of a *derived* result - the summary a scan
//! worked out for a file at a given size and modification time, and the byte span of each message
//! entry inside it - so those derivations survive a restart and a page of history can be assembled
//! without streaming the whole transcript again. Deleting this database loses nothing but the work
//! that produced it; every row is refilled by the next scan.
//!
//! Two facts make the projection safe to trust:
//!
//! - A summary belongs to one exact file state. Rows are keyed by the plain path and only answer
//!   while the file still has the recorded size and modification time, which is the same rule the
//!   memory cache applies. A file the engine rewrote, appended to, or replaced answers `None` and
//!   is read again.
//! - A span index belongs to one exact file state too, and its resume point is proven rather than
//!   assumed: appending is only used when the file grew past the recorded index *and* the head
//!   bytes still hash to what was recorded. Anything else rebuilds the file's rows from byte 0, so
//!   a rewind that truncated the transcript or a rewrite that republished it cannot leave spans
//!   pointing into someone else's bytes.
//!
//! Every read path here is a *fast path*: a miss, an unreadable file, a page whose cursor no longer
//! matches the transcript, or a database that will not open all answer `None`, and the caller falls
//! back to the engine's own reader. Correctness never depends on this file existing.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::models::agent::SessionSummary;
use crate::services::paths::normalize_for_compare;
use crate::services::sqlite::Done;

pub(super) mod search;

/// Version of the projection's own shape. The file is a cache, so a version this build does not
/// know is *dropped* rather than migrated: rebuilding is one scan, and carrying migration code for
/// a derived file would be a second schema to keep correct for no gain.
const SCHEMA_VERSION: i64 = 2;

/// Bytes at the front of a transcript whose hash proves a resumed index still points into the same
/// file. The engine's title slot and header sit here, and it is small enough that checking it costs
/// one read whatever the transcript weighs.
const HEAD_PROBE_BYTES: u64 = 4 * 1024;

/// Ceiling on one line's bytes while indexing. A transcript line is one entry; the engine's largest
/// are megabytes (a tool result carrying a page dump), and a file whose line reaches this bound is
/// left unindexed rather than held in memory - the caller reads it the old way.
const MAX_LINE_BYTES: u64 = 64 * 1024 * 1024;

#[cfg(test)]
// Span reads performed on the calling test thread: the fast path should not need one when the
// index pass it just did already walked the page's window. Counting per thread keeps tests that
// run in parallel out of each other's numbers (the scan's own window counter does the same).
thread_local! {
    static SPAN_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn span_reads() -> usize {
    SPAN_READS.with(std::cell::Cell::get)
}

#[cfg(test)]
fn reset_span_reads() {
    SPAN_READS.with(|count| count.set(0));
}

/// Ceiling on the bytes one page's rows are read from. A page is at most a few hundred rows and a
/// row is typically kilobytes; a page that would read more than this is answered by the engine's
/// reader instead, so the bound is on this module's own memory, not on what a conversation may hold.
const MAX_PAGE_BYTES: u64 = 16 * 1024 * 1024;

/// The projection's tables. `summary_cache` mirrors what the in-memory cache holds; `message_span`
/// and `span_state` are the byte index of one transcript's message entries.
const DDL: &str = "
CREATE TABLE IF NOT EXISTS summary_cache (
  file     TEXT PRIMARY KEY,
  len      INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  summary  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS span_state (
  file        TEXT PRIMARY KEY,
  len         INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  head_hash   TEXT NOT NULL,
  indexed_len INTEGER NOT NULL,
  messages    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message_span (
  file       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  byte_start INTEGER NOT NULL,
  byte_len   INTEGER NOT NULL,
  PRIMARY KEY (file, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS message_text (
  file TEXT    NOT NULL,
  seq  INTEGER NOT NULL,
  role TEXT    NOT NULL,
  text TEXT    NOT NULL,
  UNIQUE (file, seq)
);
CREATE INDEX IF NOT EXISTS idx_message_text_file ON message_text(file);
-- The content of the index is the table above, so only the index itself is stored here: a match is
-- answered from the trigrams, and the row it names is read back for the file, the message and the
-- snippet. Triggers keep the two in step, so no write path has to remember to.
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  text,
  content='message_text',
  content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS message_text_inserted AFTER INSERT ON message_text BEGIN
  INSERT INTO message_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS message_text_removed AFTER DELETE ON message_text BEGIN
  INSERT INTO message_fts(message_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
";

/// One page of a transcript, in the same shape the host's own cold read produces.
pub(crate) struct Page {
    /// The message objects a reader is handed, oldest first: `entry.message` for a `message` entry,
    /// and the entry itself with `role: "custom"` for a `custom_message`.
    pub(crate) messages: Vec<Value>,
    pub(crate) total: i64,
    pub(crate) next_cursor: Option<String>,
}

/// One conversation a content search matched, with the summary that names it: what a result row
/// needs to be drawn and to be opened.
pub(crate) struct SearchRow {
    pub(crate) summary: SessionSummary,
    pub(crate) hit: search::Hit,
}

/// The projection database, or `None` at the call sites that could not open it.
pub(crate) struct Projection {
    conn: Mutex<Connection>,
}

impl Projection {
    /// Opens (and when needed creates) the projection at `db`.
    ///
    /// A file written by another schema version is deleted and recreated: it holds only derived
    /// rows, and a version this build cannot read is worth less than the scan that refills it.
    pub(crate) fn open(db: &Path) -> Option<Self> {
        let conn = open_database(db)?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .ok()?;
        if version != SCHEMA_VERSION {
            // A cache of another shape: drop its objects rather than migrate them.
            let dropped = conn
                .execute_batch(
                    "DROP TRIGGER IF EXISTS message_text_inserted;
                     DROP TRIGGER IF EXISTS message_text_removed;
                     DROP TABLE IF EXISTS message_fts;
                     DROP TABLE IF EXISTS message_text;
                     DROP TABLE IF EXISTS summary_cache;
                     DROP TABLE IF EXISTS span_state;
                     DROP TABLE IF EXISTS message_span;",
                )
                .is_ok();
            if !dropped {
                return None;
            }
            conn.execute_batch(DDL).ok()?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .ok()?;
        } else {
            conn.execute_batch(DDL).ok()?;
        }
        Some(Self {
            conn: Mutex::new(conn),
        })
    }

    /// The summary recorded for `path`, while the file still has that exact size and modification
    /// time. `None` means the caller has to read the file again.
    pub(crate) fn cached_summary(
        &self,
        path: &Path,
        len: u64,
        mtime_ms: i64,
    ) -> Option<SessionSummary> {
        let key = key(path);
        let conn = self.lock();
        let recorded: Option<(i64, i64, String)> = conn
            .query_row(
                "SELECT len, mtime_ms, summary FROM summary_cache WHERE file = ?1",
                params![key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .ok()?;
        let (recorded_len, recorded_mtime, summary) = recorded?;
        if recorded_len as u64 != len || recorded_mtime != mtime_ms {
            return None;
        }
        serde_json::from_str(&summary).ok()
    }

    /// Records one summary for the file state it was derived from.
    pub(crate) fn store_summary(
        &self,
        path: &Path,
        len: u64,
        mtime_ms: i64,
        summary: &SessionSummary,
    ) {
        let Ok(encoded) = serde_json::to_string(summary) else {
            return;
        };
        let key = key(path);
        let conn = self.lock();
        let _ = conn.execute(
            "INSERT INTO summary_cache (file, len, mtime_ms, summary) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(file) DO UPDATE SET len = ?2, mtime_ms = ?3, summary = ?4",
            params![key, len as i64, mtime_ms, encoded],
        );
    }

    /// Drops every row whose file the finished scan did not see **and** that is no longer on disk.
    ///
    /// The existence half is what makes this safe for a projection wider than one scan: a subagent's
    /// transcript lives in a subdirectory, so it is never among a scan's candidates, and pruning by
    /// the scan's own set alone would throw away the spans the paging path had just built. A file
    /// that is merely unlisted stays - it is a cache entry, and the next read of it proves whether
    /// it is still the same file.
    pub(crate) fn retain(&self, seen: &HashSet<PathBuf>) {
        let kept: HashSet<String> = seen.iter().map(|path| key(path)).collect();
        let conn = self.lock();
        let Ok(mut statement) = conn.prepare("SELECT file FROM summary_cache") else {
            return;
        };
        let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) else {
            return;
        };
        let stale: Vec<String> = rows
            .filter_map(Result::ok)
            .filter(|file| !kept.contains(file) && !Path::new(file).exists())
            .collect();
        drop(statement);
        for file in stale {
            let _ = conn.execute("DELETE FROM summary_cache WHERE file = ?1", params![file]);
            let _ = conn.execute("DELETE FROM span_state WHERE file = ?1", params![file]);
            let _ = conn.execute("DELETE FROM message_span WHERE file = ?1", params![file]);
            let _ = conn.execute("DELETE FROM message_text WHERE file = ?1", params![file]);
        }
    }

    /// One page of a transcript's messages, oldest first, or `None` when this module cannot answer
    /// it faithfully - a file that is gone, a line it could not read, a cursor issued against a
    /// different transcript size.
    ///
    /// The page is `messages[offset .. min(offset + limit, total)]` and the cursor carries the
    /// offset it reached together with `total`, exactly as the host's own reader builds them.
    pub(crate) fn page(&self, path: &Path, cursor: Option<&str>, limit: usize) -> Option<Page> {
        if limit == 0 {
            return None;
        }
        let metadata = std::fs::metadata(path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        let observed = (metadata.len(), mtime_ms(&metadata));
        let position = match cursor {
            None => None,
            Some(text) => Some(decode_cursor(text)?),
        };
        // The offset is all the capture needs; the total the cursor also carries is checked after
        // the walk, once the transcript's own count is known.
        let start = position.map_or(0, |(offset, _)| offset);
        let (total, captured) = self.sync(path, observed.0, observed.1, (start, limit))?;
        if let Some((_, issued_at)) = position {
            if issued_at != total {
                return None;
            }
        }
        if start < 0 || start > total {
            return None;
        }
        let mut messages = Vec::with_capacity(limit.min(total.saturating_sub(start) as usize));
        match captured {
            // The index pass already held these lines: a transcript read for the first time costs
            // one pass, not a pass and then a second read of the same bytes.
            Some(lines) => {
                for line in lines {
                    messages.push(message_value(&line)?);
                }
            }
            None => {
                let mut budget = MAX_PAGE_BYTES;
                let mut file = File::open(path).ok()?;
                for (byte_start, byte_len) in self.spans(path, start, limit)? {
                    if byte_len as u64 > budget {
                        return None;
                    }
                    budget -= byte_len as u64;
                    let mut buffer = vec![0u8; byte_len as usize];
                    file.seek(SeekFrom::Start(byte_start)).ok()?;
                    file.read_exact(&mut buffer).ok()?;
                    messages.push(message_value(&buffer)?);
                }
            }
        }
        // The spans were read one at a time, and a transcript the engine rewrote while they were
        // being read would hand back bytes from two different files. One stat after the read is
        // what rules that out: any write moves the size or the modification time, and a page that
        // cannot prove it read one file is not answered from here.
        let after = std::fs::metadata(path).ok()?;
        if (after.len(), mtime_ms(&after)) != observed {
            return None;
        }
        let end = start + messages.len() as i64;
        Some(Page {
            messages,
            total,
            next_cursor: (end < total).then(|| encode_cursor(end, total)),
        })
    }

    /// Brings the byte and text index for one transcript up to date, and forgets the answer.
    ///
    /// Called by the scan for every file whose summary it had to derive, which is exactly the set
    /// whose index cannot be current: a file the cache answered for was not read, so it was not
    /// changed either, so its index is already right. Indexing here rather than inside `search`
    /// keeps a query a query - the pass over a transcript costs the file, and a field that is being
    /// typed into cannot pay for one.
    pub(crate) fn index_messages(&self, path: &Path, len: u64, mtime_ms: i64) {
        // A window of nothing: this pass is for the index, not for a page.
        let _ = self.sync(path, len, mtime_ms, (0, 0));
    }

    /// Drops every row this projection holds, and compacts the file.
    ///
    /// What the settings page's own clear does: the file is a cache of derivations, and a reader
    /// asking to free what the application has cached means this as much as the WebView profiles.
    /// Rows go rather than the file, because this process holds the connection open - on Windows a
    /// file under an open handle cannot be unlinked - and `VACUUM` is what makes the space come back
    /// instead of sitting in the free list.
    ///
    /// The triggers on `message_text` keep the search index in step, so a clear is not a rebuild
    /// anyone has to remember afterwards: the next list re-indexes and the next search answers from
    /// the new rows.
    pub(crate) fn clear(&self) {
        let conn = self.lock();
        let cleared = conn.execute_batch(
            "DELETE FROM message_text;
             DELETE FROM message_span;
             DELETE FROM span_state;
             DELETE FROM summary_cache;",
        );
        if cleared.is_err() {
            // A clear that could not run leaves the rows alone: answering "freed" over a database
            // still holding them would be a lie the next measurement would not repeat.
            return;
        }
        // Off the statement path: `VACUUM` rewrites the file and refuses to run inside a
        // transaction, which `execute_batch` would have opened for the statements above.
        let _ = conn.execute_batch("VACUUM");
    }

    /// The conversations that mention `query`, best first, at most `limit` of them.
    ///
    /// A hit whose summary this projection never recorded is left out: without the session's own id
    /// and path the row cannot be opened, and a result that does nothing is worse than one fewer.
    pub(crate) fn search(&self, query: &str, limit: usize) -> Vec<SearchRow> {
        let hits = {
            let conn = self.lock();
            search::search(&conn, query, limit)
        };
        hits.into_iter()
            .filter_map(|hit| {
                let summary = self.summary_of(&hit.file)?;
                Some(SearchRow { summary, hit })
            })
            .collect()
    }

    /// The summary recorded for one indexed file, if the projection still holds one.
    ///
    /// No file state is checked here, unlike [`Self::cached_summary`]: this answer names what a
    /// search found - a title, a time, a path - and a summary one write out of date is still those
    /// things, where a page built from it would not be.
    fn summary_of(&self, file: &str) -> Option<SessionSummary> {
        let conn = self.lock();
        let encoded: Option<String> = conn
            .query_row(
                "SELECT summary FROM summary_cache WHERE file = ?1",
                params![file],
                |row| row.get(0),
            )
            .optional()
            .ok()?;
        serde_json::from_str(&encoded?).ok()
    }

    /// Brings the byte index for `path` up to the file state `len`/`modified_ms` describe, and answers
    /// how many message entries the transcript holds - plus, when this call had to walk the file and
    /// the walk covered the window `cursor` names, the lines that window needs.
    ///
    /// Returning them keeps a first read to one pass: an index built from scratch parses every line
    /// anyway, so the page it was asked about is held as it goes instead of read back afterwards.
    fn sync(
        &self,
        path: &Path,
        len: u64,
        modified_ms: i64,
        requested: (i64, usize),
    ) -> Option<(i64, Option<Vec<Vec<u8>>>)> {
        let key = key(path);
        let recorded: Option<(i64, i64, String, i64, i64)> = {
            let conn = self.lock();
            conn.query_row(
                "SELECT len, mtime_ms, head_hash, indexed_len, messages FROM span_state WHERE file = ?1",
                params![key],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .ok()?
        };

        // The file state this index was built for is the one in front of us, **and the index read
        // that whole state**: nothing to do.
        //
        // `indexed_len` is the bytes the pass actually walked; `len` is the file's size when it
        // finished. The two part company when the engine appended while the pass ran - a line the
        // scanner had already passed, or the final answer being written at the turn's end - and the
        // row then described a file it had not read to the end. Answering from it reported a total
        // that stopped before that row, which cut a reopened conversation exactly where the engine
        // was writing: the reader's last tool call, and no answer under it (2026-11-04).
        if let Some((recorded_len, recorded_mtime, _, indexed_len, messages)) = &recorded {
            if *recorded_len as u64 == len
                && *recorded_mtime == modified_ms
                && *indexed_len == *recorded_len
            {
                return Some((*messages, None));
            }
        }

        // Append only when the growth is the engine writing after the index, proven by the head
        // bytes: a rewrite that republished the file would have moved them.
        let resume = match &recorded {
            Some((_, _, hash, indexed_len, messages)) => {
                let indexed = *indexed_len;
                (indexed >= 0 && (indexed as u64) < len && head_matches(path, indexed as u64, hash))
                    .then_some((indexed as u64, *messages))
            }
            None => None,
        };

        let mut conn = self.lock();
        let transaction = conn.transaction().ok()?;
        let (start, first_seq) = match resume {
            Some((indexed, messages)) => (indexed, messages),
            None => {
                transaction
                    .execute("DELETE FROM message_span WHERE file = ?1", params![key])
                    .ok()?;
                // The searchable text of the old shape goes with the spans: a rewrite is a
                // different conversation, and rows left behind would answer for words the file no
                // longer says.
                transaction
                    .execute("DELETE FROM message_text WHERE file = ?1", params![key])
                    .ok()?;
                (0, 0)
            }
        };
        let mut reader = BufReader::with_capacity(64 * 1024, File::open(path).ok()?);
        if start > 0 {
            reader.seek(SeekFrom::Start(start)).ok()?;
        }
        let mut offset = start;
        let mut seq = first_seq;
        let mut buffer = Vec::new();
        // The window the caller asked for, held as the walk passes it.
        let (window_from, window_cap) = requested;
        let mut window: Vec<Vec<u8>> = Vec::with_capacity(window_cap);
        let mut captured_bytes: u64 = 0;
        {
            let mut insert = transaction
                .prepare(
                    "INSERT OR REPLACE INTO message_span (file, seq, byte_start, byte_len)
                     VALUES (?1, ?2, ?3, ?4)",
                )
                .ok()?;
            let mut insert_text = transaction
                .prepare(
                    "INSERT OR REPLACE INTO message_text (file, seq, role, text)
                     VALUES (?1, ?2, ?3, ?4)",
                )
                .ok()?;
            loop {
                buffer.clear();
                let read = reader.read_until(b'\n', &mut buffer).ok()?;
                if read == 0 {
                    break;
                }
                if buffer.last() != Some(&b'\n') {
                    // A trailing line still being written: not consumed, so the next sync starts
                    // here instead of indexing half an entry.
                    break;
                }
                let line_len = read as u64;
                if line_len > MAX_LINE_BYTES {
                    return None;
                }
                if let Line::Message { role, text } = classify(&buffer) {
                    if seq >= window_from && window.len() < window_cap {
                        captured_bytes = captured_bytes.saturating_add(line_len);
                        if captured_bytes > MAX_PAGE_BYTES {
                            return None;
                        }
                        window.push(buffer.clone());
                    }
                    insert
                        .execute(params![key, seq, offset as i64, line_len as i64])
                        .ok()?;
                    // The words are indexed as the walk passes them: one read of the transcript
                    // fills both the page index and the search index.
                    if !text.is_empty() {
                        insert_text.execute(params![key, seq, role, text]).ok()?;
                    }
                    seq += 1;
                }
                offset += line_len;
            }
        }
        let hash = head_hash(path, offset)?;
        // The state recorded is the file as it is *now*, not as it was when the read started: a
        // transcript the engine kept appending to while it was indexed ends up with a recorded size
        // at or past the bytes covered here, which is exactly what makes the next sync a resume.
        let after = std::fs::metadata(path).ok()?;
        transaction
            .execute(
                "INSERT INTO span_state (file, len, mtime_ms, head_hash, indexed_len, messages)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(file) DO UPDATE SET
                   len = ?2, mtime_ms = ?3, head_hash = ?4, indexed_len = ?5, messages = ?6",
                params![
                    key,
                    after.len() as i64,
                    mtime_ms(&after),
                    hash,
                    offset as i64,
                    seq
                ],
            )
            .ok()?;
        transaction.commit().ok()?;
        // Only a pass that walked the whole window can answer for it. Two ways it cannot: the walk
        // resumed past the window's first message (nothing before it was read), or the transcript
        // ended before the window was filled - which is fine, that is the last page. Either way the
        // page comes from the spans instead when the counts disagree.
        let expected = (seq - window_from).clamp(0, window_cap as i64);
        let covered = first_seq <= window_from && window.len() as i64 == expected;
        Some((seq, covered.then_some(window)))
    }

    /// The byte spans of `limit` message entries starting at `start`.
    fn spans(&self, path: &Path, start: i64, limit: usize) -> Option<Vec<(u64, u64)>> {
        #[cfg(test)]
        SPAN_READS.with(|count| count.set(count.get() + 1));
        let key = key(path);
        let conn = self.lock();
        let mut statement = conn
            .prepare(
                "SELECT byte_start, byte_len FROM message_span
                 WHERE file = ?1 AND seq >= ?2 ORDER BY seq LIMIT ?3",
            )
            .ok()?;
        let rows = statement
            .query_map(params![key, start, limit as i64], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })
            .ok()?;
        let mut spans = Vec::with_capacity(limit);
        for row in rows {
            let (byte_start, byte_len) = row.ok()?;
            if byte_start < 0 || byte_len <= 0 {
                return None;
            }
            spans.push((byte_start as u64, byte_len as u64));
        }
        Some(spans)
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        // A poisoned lock is not a reason to take the application down: every holder only reads or
        // writes short-lived cache state, so the inner value is still usable.
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Truncates this database's write-ahead log, and compacts the file below when it is large
    /// (`services::sqlite`).
    ///
    /// Holding the lock is what keeps a statement from interleaving: the pass runs as one caller of
    /// the same mutex every scan and every page read takes.
    pub(crate) fn maintain(&self, file: &Path) -> Done {
        let conn = self.lock();
        crate::services::sqlite::compact(
            &conn,
            file,
            crate::services::sqlite::VACUUM_THRESHOLD_BYTES,
        )
    }
}

/// Opens the database with the pragmas a cache wants: WAL so a reader never blocks the writer, and
/// a busy timeout so a second window's scan waits instead of failing.
fn open_database(db: &Path) -> Option<Connection> {
    if let Some(parent) = db.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }
    let conn = Connection::open(db).ok()?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).ok()?;
    conn.pragma_update(None, "journal_mode", "WAL").ok()?;
    conn.pragma_update(None, "synchronous", "NORMAL").ok()?;
    Some(conn)
}

/// The one spelling rows are keyed by: the same normalization the scan compares workspaces with, so
/// two spellings of one file cannot become two rows.
fn key(path: &Path) -> String {
    normalize_for_compare(path)
}

/// One line of a transcript, read only for the fields that decide whether it is a message.
///
/// Unknown fields are skipped by the parser rather than materialized: a tool result carries
/// megabytes, and indexing a transcript must not build them in memory to learn that it is a
/// `message` entry.
#[derive(Deserialize)]
struct RoleProbe {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    display: Option<bool>,
    /// Whether the entry carries a message payload at all, and who said it. `null` reads as absent
    /// here; the engine never writes one, and a line that did would be counted as conversation by
    /// the host and skipped here - which costs that one file its fast path, never the reader's rows.
    #[serde(default)]
    message: Option<MessageRole>,
}

#[derive(Deserialize, Default)]
struct MessageRole {
    #[serde(default)]
    role: String,
}

/// The payload of one line, read only for the words a search may find. A tool result's megabytes,
/// an image's base64, a thinking block: parsed and dropped rather than kept, because nothing below
/// indexes them.
#[derive(Deserialize, Default)]
struct TextProbe {
    #[serde(default)]
    message: Option<TextMessage>,
    /// A `custom_message` carries its blocks at the entry's own level: it is the engine's entry
    /// outside a turn, not a message object.
    #[serde(default)]
    content: Option<Vec<TextBlock>>,
}

#[derive(Deserialize, Default)]
struct TextMessage {
    #[serde(default)]
    content: Option<Vec<TextBlock>>,
}

#[derive(Deserialize, Default)]
struct TextBlock {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

/// What one transcript line contributes to the index.
enum Line {
    /// Not conversation: bookkeeping, a compaction marker, an entry the reader never sees.
    NotMessage,
    /// A message a reader is shown. `text` is what a search may find in it - empty when the entry
    /// says nothing searchable (a tool result) or when its role is one the index leaves out.
    Message { role: String, text: String },
}

/// Roles whose words are indexed. A tool result is what a command printed rather than what the
/// conversation said, and the engine's own instructions are not the reader's words at all; both
/// would drown a search without answering it.
fn indexes_text(role: &str) -> bool {
    matches!(role, "user" | "assistant" | "custom")
}

/// The line's contribution, by the same message rule the host applies to the entries it streams
/// (`host/src/history.ts::entryMessage`).
fn classify(line: &[u8]) -> Line {
    let Ok(probe) = serde_json::from_slice::<RoleProbe>(line) else {
        return Line::NotMessage;
    };
    let role = match probe.kind.as_str() {
        "message" => match probe.message {
            Some(message) => message.role,
            None => return Line::NotMessage,
        },
        "custom_message" if probe.display != Some(false) => "custom".to_owned(),
        _ => return Line::NotMessage,
    };
    let text = if indexes_text(&role) {
        text_of(line).unwrap_or_default()
    } else {
        String::new()
    };
    Line::Message { role, text }
}

/// The words one entry holds: its `text` blocks joined, capped, and `None` when it has none.
fn text_of(line: &[u8]) -> Option<String> {
    let probe: TextProbe = serde_json::from_slice(line).ok()?;
    let blocks = probe
        .message
        .and_then(|message| message.content)
        .or(probe.content)?;
    let mut text = String::new();
    for block in blocks {
        if block.kind != "text" {
            continue;
        }
        let Some(words) = block.text else { continue };
        if words.trim().is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&words);
    }
    (!text.is_empty()).then(|| search::capped(&text))
}

/// The message object one indexed line carries, in the shape the host's cold read produces.
fn message_value(line: &[u8]) -> Option<Value> {
    let entry: Value = serde_json::from_slice(line).ok()?;
    match entry.get("type").and_then(Value::as_str)? {
        // The engine's own message object, verbatim: what every reader on this side speaks.
        "message" => entry.get("message").cloned(),
        // An entry the engine wrote outside a turn (`custom_message`) is conversation too, and gets
        // the role the wire vocabulary has for it - the same projection the host applies.
        "custom_message" => {
            let Value::Object(mut object) = entry else {
                return None;
            };
            object.insert("role".to_owned(), Value::String("custom".to_owned()));
            Some(Value::Object(object))
        }
        _ => None,
    }
}

/// Cursor spelling shared with the host: the number of messages already delivered and the size of
/// the transcript that count was taken against.
fn encode_cursor(offset: i64, total: i64) -> String {
    format!("c{offset}@{total}")
}

fn decode_cursor(text: &str) -> Option<(i64, i64)> {
    let rest = text.strip_prefix('c')?;
    let (offset, total) = rest.split_once('@')?;
    let offset = offset.parse::<i64>().ok()?;
    let total = total.parse::<i64>().ok()?;
    (offset >= 0 && total >= 0).then_some((offset, total))
}

/// SHA-256 of the file's first [`HEAD_PROBE_BYTES`] bytes (or of its first `limit` bytes, when the
/// indexed region is shorter), as hex.
fn head_hash(path: &Path, indexed: u64) -> Option<String> {
    let probe = indexed.min(HEAD_PROBE_BYTES);
    let mut file = File::open(path).ok()?;
    let mut buffer = vec![0u8; probe as usize];
    file.read_exact(&mut buffer).ok()?;
    Some(hex(&Sha256::digest(&buffer)))
}

/// Whether the file's head still hashes to `recorded`, which is what proves an index built for an
/// earlier state of this file can be resumed instead of rebuilt.
fn head_matches(path: &Path, indexed: u64, recorded: &str) -> bool {
    head_hash(path, indexed).is_some_and(|hash| hash == recorded)
}

fn hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(char::from_digit((byte >> 4) as u32, 16).unwrap_or('0'));
        text.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap_or('0'));
    }
    text
}

/// Unix milliseconds from one file's metadata, the unit the memory cache is keyed by.
fn mtime_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;

//! Tests for the projection: what it answers, and what it refuses to answer.
//!
//! The comparison against a cold read of a real store lives at the end - it is the one test that
//! says the projection reproduces the engine's own transcript reading rather than merely something
//! self-consistent.

use super::*;

/// One directory per test, removed when the test's guard drops.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        // A counter under the process id: two tests that pick the same tag never share a
        // directory, and a rerun after a crash still starts from an empty one.
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "omp-projection-{tag}-{}-{serial}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("temp dir");
        Self(base)
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A transcript with the shape the engine writes: a title slot, a header, then entries.
fn transcript(entries: &[String]) -> String {
    let mut text = String::from(
        r#"{"title":""}
{"type":"session","id":"01a1778d-a7dd-7000-82b2-a807770e33aa","version":"1","cwd":"C:\\w"}
"#,
    );
    for entry in entries {
        text.push_str(entry);
        text.push('\n');
    }
    text
}

/// One human message entry, as the engine writes it.
fn message(role: &str, text: &str) -> String {
    format!(
        r#"{{"type":"message","id":"e-{role}-{text}","message":{{"role":"{role}","content":[{{"type":"text","text":"{text}"}}],"timestamp":"2026-09-22T10:00:00.000Z"}}}}"#
    )
}

/// A tool result entry, which is conversation but carries no human text.
fn tool_result(text: &str) -> String {
    format!(
        r#"{{"type":"message","id":"e-tool-{text}","message":{{"role":"toolResult","toolCallId":"c1","content":[{{"type":"text","text":"{text}"}}],"timestamp":"2026-09-22T10:00:01.000Z"}}}}"#
    )
}

/// Bookkeeping the engine appends around a turn: never a message.
fn session_exit() -> String {
    r#"{"type":"custom","customType":"session_exit","data":{},"id":"e-exit"}"#.to_owned()
}

fn custom_message(display: bool, text: &str) -> String {
    format!(
        r#"{{"type":"custom_message","customType":"skill","display":{display},"content":[{{"type":"text","text":"{text}"}}],"id":"e-custom-{text}"}}"#
    )
}

/// A projection in a temp directory, with the transcript written beside it.
fn setup(tag: &str, body: &str) -> (TempDir, Projection, PathBuf) {
    let dir = TempDir::new(tag);
    let file = dir.join("s.jsonl");
    std::fs::write(&file, body).expect("transcript");
    let projection = Projection::open(&dir.join("index.sqlite")).expect("projection");
    (dir, projection, file)
}

fn texts(page: &Page) -> Vec<String> {
    page.messages
        .iter()
        .map(|message| {
            message
                .get("content")
                .and_then(Value::as_array)
                .and_then(|blocks| blocks.first())
                .and_then(|block| block.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        })
        .collect()
}

#[test]
fn pages_carry_the_same_rows_a_cold_read_does() {
    let body = transcript(&[
        message("user", "one"),
        session_exit(),
        message("assistant", "two"),
        tool_result("three"),
    ]);
    let (_dir, projection, file) = setup("rows", &body);
    let page = projection.page(&file, None, 10).expect("page");
    assert_eq!(page.total, 3, "bookkeeping is not conversation");
    assert_eq!(texts(&page), vec!["one", "two", "three"]);
    assert!(page.next_cursor.is_none(), "one page holds the transcript");
}

#[test]
fn the_first_page_comes_out_of_the_index_pass_itself() {
    let body = transcript(&[
        message("user", "one"),
        message("assistant", "two"),
        message("user", "three"),
    ]);
    let (_dir, projection, file) = setup("onespass", &body);

    // The index is built by this very call and the walk passes the page's window, so nothing
    // is read a second time.
    reset_span_reads();
    let first = projection.page(&file, None, 2).expect("page");
    assert_eq!(texts(&first), vec!["one", "two"]);
    assert_eq!(span_reads(), 0, "the first page is held, not re-read");

    // A later page of a transcript already indexed comes from the spans.
    let second = projection
        .page(&file, first.next_cursor.as_deref(), 2)
        .expect("page");
    assert_eq!(texts(&second), vec!["three"]);
    assert_eq!(span_reads(), 1, "only this page reads the file again");
}

#[test]
fn a_cursor_walks_the_transcript_and_a_moved_one_is_refused() {
    let body = transcript(&[
        message("user", "one"),
        message("assistant", "two"),
        message("user", "three"),
    ]);
    let (_dir, projection, file) = setup("cursor", &body);
    let first = projection.page(&file, None, 2).expect("page");
    assert_eq!(texts(&first), vec!["one", "two"]);
    assert_eq!(first.next_cursor.as_deref(), Some("c2@3"));

    let second = projection
        .page(&file, first.next_cursor.as_deref(), 2)
        .expect("page");
    assert_eq!(texts(&second), vec!["three"]);
    assert!(second.next_cursor.is_none());

    // A transcript that grew since the cursor was issued answers with the file, not with rows
    // taken from a size the reader never saw.
    let mut longer = body.clone();
    longer.push_str(&message("user", "four"));
    longer.push('\n');
    std::fs::write(&file, longer).expect("transcript");
    assert!(projection
        .page(&file, first.next_cursor.as_deref(), 2)
        .is_none());
}

#[test]
fn an_appended_transcript_resumes_instead_of_reindexing() {
    let mut body = transcript(&[message("user", "one")]);
    let (dir, projection, file) = setup("append", &body);
    assert_eq!(projection.page(&file, None, 10).expect("page").total, 1);

    body.push_str(&message("assistant", "two"));
    body.push('\n');
    std::fs::write(&file, &body).expect("transcript");
    let page = projection.page(&file, None, 10).expect("page");
    assert_eq!(texts(&page), vec!["one", "two"]);
    assert_eq!(page.total, 2);

    // Resuming is what the state row records: the index covers the whole file, and its head
    // hash still names this file.
    let conn = Connection::open(dir.join("index.sqlite")).expect("db");
    let (indexed, messages): (i64, i64) = conn
        .query_row("SELECT indexed_len, messages FROM span_state", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .expect("state row");
    assert_eq!(indexed, body.len() as i64);
    assert_eq!(messages, 2);
}

#[test]
fn an_index_that_stopped_before_the_file_ends_is_not_trusted() {
    let mut body = transcript(&[message("user", "one"), message("assistant", "two")]);
    let (dir, projection, file) = setup("grew-during-pass", &body);
    assert_eq!(projection.page(&file, None, 10).expect("page").total, 2);

    // The engine appended the answer while the index pass was running: the pass stat'ed the file
    // after that write (`len`, `mtime_ms`) but indexed only the lines before it. That is the state
    // that used to answer for the whole file, cutting a reopened conversation at the row the engine
    // was writing - the reader's "the answer is gone" (2026-11-04).
    body.push_str(&message("assistant", "three"));
    body.push('\n');
    std::fs::write(&file, &body).expect("transcript");
    let metadata = std::fs::metadata(&file).expect("stat");
    let conn = Connection::open(dir.join("index.sqlite")).expect("db");
    conn.execute(
        "UPDATE span_state SET len = ?1, mtime_ms = ?2",
        params![metadata.len() as i64, mtime_ms(&metadata)],
    )
    .expect("state");

    let page = projection.page(&file, None, 10).expect("page");
    assert_eq!(
        page.total, 3,
        "the file's own rows, not the count the index stopped at"
    );
    assert_eq!(texts(&page), vec!["one", "two", "three"]);
}

#[test]
fn a_rewritten_transcript_is_reindexed_from_the_start() {
    let (dir, projection, file) = setup(
        "rewrite",
        &transcript(&[message("user", "one"), message("assistant", "two")]),
    );
    assert_eq!(projection.page(&file, None, 10).expect("page").total, 2);

    // A rewind: the same file, shorter, holding a different second row. The head bytes moved
    // with the rewrite, which is what refuses the resume.
    let rewritten = transcript(&[message("user", "one"), message("assistant", "different")]);
    std::fs::write(&file, &rewritten).expect("transcript");
    let page = projection.page(&file, None, 10).expect("page");
    assert_eq!(texts(&page), vec!["one", "different"]);
    assert_eq!(page.total, 2);

    let conn = Connection::open(dir.join("index.sqlite")).expect("db");
    let spans: i64 = conn
        .query_row("SELECT COUNT(*) FROM message_span", [], |row| row.get(0))
        .expect("count");
    assert_eq!(spans, 2, "the old rows are gone rather than left behind");
}

#[test]
fn a_hidden_custom_message_stays_out_of_the_page() {
    let body = transcript(&[
        message("user", "one"),
        custom_message(false, "context"),
        custom_message(true, "shown"),
    ]);
    let (_dir, projection, file) = setup("custom", &body);
    let page = projection.page(&file, None, 10).expect("page");
    assert_eq!(page.total, 2);
    assert_eq!(texts(&page), vec!["one", "shown"]);
    assert_eq!(
        page.messages[1].get("role").and_then(Value::as_str),
        Some("custom"),
        "a custom entry is projected with the role the wire uses"
    );
}

#[test]
fn summaries_only_answer_for_the_file_state_they_were_derived_from() {
    let dir = TempDir::new("summary");
    let file = dir.join("s.jsonl");
    std::fs::write(&file, "{}").expect("transcript");
    let projection = Projection::open(&dir.join("index.sqlite")).expect("projection");
    let summary = SessionSummary {
        id: "h1".to_owned(),
        title: "T".to_owned(),
        cwd: "C:\\w".to_owned(),
        status: crate::models::agent::SessionColdStatus::Complete,
        updated_at: 1_700_000_000_000,
        file_path: file.to_string_lossy().into_owned(),
        compressed: false,
        pinned: false,
        archived: false,
        blank: false,
    };
    projection.store_summary(&file, 2, 111, &summary);
    assert_eq!(projection.cached_summary(&file, 2, 111), Some(summary));
    assert_eq!(projection.cached_summary(&file, 2, 222), None);
    assert_eq!(projection.cached_summary(&file, 3, 111), None);
}

#[test]
fn a_stale_database_of_another_version_is_dropped() {
    let dir = TempDir::new("version");
    let db = dir.join("index.sqlite");
    {
        let conn = Connection::open(&db).expect("db");
        conn.execute_batch("CREATE TABLE summary_cache (file TEXT PRIMARY KEY);")
            .expect("old shape");
        conn.pragma_update(None, "user_version", 99)
            .expect("version");
    }
    let projection = Projection::open(&db).expect("projection");
    assert!(projection
        .cached_summary(Path::new("C:/w/s.jsonl"), 1, 1)
        .is_none());
    let conn = Connection::open(&db).expect("db");
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("version");
    assert_eq!(version, SCHEMA_VERSION);
}

#[test]
fn files_a_scan_no_longer_sees_are_forgotten() {
    let (dir, projection, file) = setup("retain", &transcript(&[message("user", "one")]));
    let summary = SessionSummary {
        id: "h1".to_owned(),
        title: "T".to_owned(),
        cwd: "C:\\w".to_owned(),
        status: crate::models::agent::SessionColdStatus::Complete,
        updated_at: 1,
        file_path: file.to_string_lossy().into_owned(),
        compressed: false,
        pinned: false,
        archived: false,
        blank: false,
    };
    projection.store_summary(&file, 1, 1, &summary);
    assert!(projection.page(&file, None, 10).is_some());

    // A file that is merely unlisted stays: a subagent transcript is never a scan candidate.
    projection.retain(&HashSet::new());
    assert_eq!(
        projection.cached_summary(&file, 1, 1),
        Some(summary.clone())
    );

    // The file going away is what forgets it.
    std::fs::remove_file(&file).expect("remove");
    projection.retain(&HashSet::new());

    assert!(projection.cached_summary(&file, 1, 1).is_none());
    let conn = Connection::open(dir.join("index.sqlite")).expect("db");
    let spans: i64 = conn
        .query_row("SELECT COUNT(*) FROM message_span", [], |row| row.get(0))
        .expect("count");
    assert_eq!(spans, 0);
}

#[test]
fn a_directory_is_not_a_transcript() {
    let dir = TempDir::new("directory");
    let projection = Projection::open(&dir.join("index.sqlite")).expect("projection");
    assert!(projection.page(&dir.0, None, 10).is_none());
    assert!(projection
        .page(&dir.join("absent.jsonl"), None, 10)
        .is_none());
}

/// Every transcript of a real store, paged through the projection and compared row by row
/// against an independent cold read of the same file.
///
/// The reference here is written from the host's rule rather than sharing code with the module:
/// it parses each line in full and applies `entryMessage` itself, which is what makes this a
/// comparison instead of a tautology. It is ignored by default because it reads a real data
/// root:
///
/// ```text
///   cargo test --lib -- --ignored --nocapture pages_reproduce_a_cold_read_on_a_real_store
/// ```
#[test]
#[ignore = "reads a real data root: set OMP_DESKTOP_SESSION_INDEX_ROOT"]
fn pages_reproduce_a_cold_read_on_a_real_store() {
    let root = std::env::var("OMP_DESKTOP_SESSION_INDEX_ROOT")
        .expect("OMP_DESKTOP_SESSION_INDEX_ROOT names the real `host/sessions` directory");
    let root = PathBuf::from(root);
    let dir = TempDir::new("real");
    let projection = Projection::open(&dir.join("index.sqlite")).expect("projection");
    // Every comparison runs against a frozen copy: a transcript this application is writing to
    // right now would otherwise be read once by the reference and again by the projection, and
    // the one row appended between them would be blamed on the code under test.
    let snapshot = dir.join("snapshot.jsonl");
    let mut checked = 0usize;
    for entry in std::fs::read_dir(&root).expect("session store") {
        let path = entry.expect("entry").path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let bytes = std::fs::read(&path).expect("transcript");
        std::fs::write(&snapshot, &bytes).expect("snapshot");
        let expected = cold_rows(&snapshot);
        let mut walked: Vec<Value> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = projection
                .page(&snapshot, cursor.as_deref(), 64)
                .unwrap_or_else(|| panic!("the projection answers {} ", path.display()));
            assert_eq!(
                page.total,
                expected.len() as i64,
                "the count matches a cold read: {}",
                path.display()
            );
            walked.extend(page.messages);
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(
            walked,
            expected,
            "the rows match a cold read, in order: {}",
            path.display()
        );
        checked += 1;
    }
    println!("{checked} transcripts paged through the projection and compared");
    assert!(
        checked > 0,
        "the store has to hold transcripts: {}",
        root.display()
    );
}

/// The rows one transcript holds, by the host's own rule, read straight from the file.
fn cold_rows(path: &Path) -> Vec<Value> {
    let text = std::fs::read_to_string(path).expect("transcript");
    let mut rows = Vec::new();
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match entry.get("type").and_then(Value::as_str) {
            Some("message") => {
                if let Some(message) = entry.get("message") {
                    rows.push(message.clone());
                }
            }
            Some("custom_message") => {
                if entry.get("display").and_then(Value::as_bool) != Some(false) {
                    let mut value = entry.clone();
                    value["role"] = Value::String("custom".to_owned());
                    rows.push(value);
                }
            }
            _ => {}
        }
    }
    rows
}

/* ------------------------------------------------------------------ searching */

/// One indexed transcript with the summary a hit needs to be addressable, and the projection that
/// holds both.
fn indexed(tag: &str, name: &str, body: &str) -> (TempDir, Projection, PathBuf) {
    let dir = TempDir::new(tag);
    let file = dir.join(name);
    std::fs::write(&file, body).expect("transcript");
    let projection = Projection::open(&dir.join("index.sqlite")).expect("projection");
    let summary = SessionSummary {
        id: format!("host-{name}"),
        title: format!("title of {name}"),
        cwd: "C:\\w".to_owned(),
        status: crate::models::agent::SessionColdStatus::Complete,
        updated_at: 1_700_000_000_000,
        file_path: file.to_string_lossy().into_owned(),
        compressed: false,
        pinned: false,
        archived: false,
        blank: false,
    };
    // The summary is recorded through the cache's own write, keyed the way a scan keys it.
    let (len, mtime) = (
        body.len() as u64,
        super::mtime_ms(&std::fs::metadata(&file).expect("stat")),
    );
    projection.store_summary(&file, len, mtime, &summary);
    // What a scan does for a file it had to read: the words go into the search index.
    projection.index_messages(&file, len, mtime);
    (dir, projection, file)
}

/// The plain text of a snippet, marks stripped, for assertions that do not care where the match is.
fn plain(snippet: &str) -> String {
    snippet
        .chars()
        .filter(|character| {
            *character != super::search::MARK_START && *character != super::search::MARK_END
        })
        .collect()
}

#[test]
fn a_search_answers_with_the_conversations_that_say_the_words() {
    let (_dir, projection, _first) = indexed(
        "search-one",
        "a.jsonl",
        &transcript(&[
            message("user", "please deploy the staging build"),
            message("assistant", "deployed to staging"),
        ]),
    );
    let (_other, _same_projection, _second) = indexed(
        "search-two",
        "b.jsonl",
        &transcript(&[message("user", "nothing about it here")]),
    );

    let hits = projection.search("deploy", 10);
    assert_eq!(hits.len(), 1, "only the conversation that says it answers");
    let hit = &hits[0];
    assert_eq!(hit.summary.title, "title of a.jsonl");
    assert_eq!(hit.hit.matches, 2, "both lines mention it");
    assert_eq!(hit.hit.snippets.len(), 2);
    assert_eq!(
        hit.hit.snippets[0].role, "assistant",
        "newest matched line first"
    );
    assert!(
        hit.hit.snippets[0].text.contains(super::search::MARK_START),
        "a snippet marks the match: {:?}",
        hit.hit.snippets[0].text
    );
    assert!(plain(&hit.hit.snippets[0].text).contains("deployed"));
}

#[test]
fn a_two_character_query_still_answers() {
    // A two-character Chinese word is the ordinary case, and a trigram index cannot answer it.
    let (_dir, projection, _file) = indexed(
        "search-cjk",
        "c.jsonl",
        &transcript(&[
            message("user", "数据库连接超时"),
            message("assistant", "连接池已扩大"),
        ]),
    );
    let hits = projection.search("连接", 10);
    assert_eq!(hits.len(), 1, "the fallback path answers short queries");
    assert_eq!(hits[0].hit.matches, 2);
    assert!(plain(&hits[0].hit.snippets[0].text).contains("连接"));
}

#[test]
fn every_term_has_to_appear() {
    let (_dir, projection, _file) = indexed(
        "search-and",
        "d.jsonl",
        &transcript(&[
            message("user", "the deploy failed on staging"),
            message("user", "the deploy passed on staging"),
            message("user", "unrelated line about deploys"),
        ]),
    );
    let hits = projection.search("deploy staging", 10);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].hit.matches, 2, "only the lines holding both terms");
    assert!(projection.search("deploy nowhere", 10).is_empty());
}

#[test]
fn tool_output_and_bookkeeping_are_not_searchable() {
    let (_dir, projection, _file) = indexed(
        "search-noise",
        "e.jsonl",
        &transcript(&[
            message("user", "run the tests"),
            tool_result("cargo test: deploy helper panicked"),
            session_exit(),
        ]),
    );
    assert!(
        projection.search("panicked", 10).is_empty(),
        "a tool result is what a command printed, not what the conversation said"
    );
    assert_eq!(projection.search("tests", 10).len(), 1);
}

#[test]
fn a_rewrite_drops_the_words_it_removed() {
    let (dir, projection, file) = indexed(
        "search-rewrite",
        "f.jsonl",
        &transcript(&[
            message("user", "keep this"),
            message("assistant", "remove this phrase"),
        ]),
    );
    assert_eq!(projection.search("phrase", 10).len(), 1);

    // A rewind: the same file re-published without the second line.
    let body = transcript(&[message("user", "keep this")]);
    std::fs::write(&file, &body).expect("transcript");
    let summary = SessionSummary {
        id: "host-f.jsonl".to_owned(),
        title: "title of f.jsonl".to_owned(),
        cwd: "C:\\w".to_owned(),
        status: crate::models::agent::SessionColdStatus::Complete,
        updated_at: 1_700_000_001_000,
        file_path: file.to_string_lossy().into_owned(),
        compressed: false,
        pinned: false,
        archived: false,
        blank: false,
    };
    let (len, mtime) = (
        body.len() as u64,
        super::mtime_ms(&std::fs::metadata(&file).expect("stat")),
    );
    projection.store_summary(&file, len, mtime, &summary);
    projection.index_messages(&file, len, mtime);

    assert!(
        projection.search("phrase", 10).is_empty(),
        "the words the transcript no longer says are gone from the index"
    );
    assert_eq!(projection.search("keep", 10).len(), 1);
    let _ = dir;
}

#[test]
fn a_query_that_names_nothing_answers_nothing() {
    let (_dir, projection, _file) = indexed(
        "search-empty",
        "g.jsonl",
        &transcript(&[message("user", "hello")]),
    );
    assert!(projection.search("", 10).is_empty());
    assert!(projection.search("   ", 10).is_empty());
    assert!(
        projection.search("hello", 0).is_empty(),
        "a zero limit asks for nothing"
    );
    assert!(projection.search("absentword", 10).is_empty());
}

#[test]
fn clearing_the_projection_drops_every_derived_row() {
    let (dir, projection, file) = indexed(
        "clear",
        "h.jsonl",
        &transcript(&[message("user", "please deploy the staging build")]),
    );
    assert_eq!(projection.search("deploy", 10).len(), 1);
    assert!(projection.page(&file, None, 10).is_some());

    projection.clear();

    assert!(
        projection.search("deploy", 10).is_empty(),
        "the words are gone"
    );
    assert!(
        projection.cached_summary(&file, 1, 1).is_none(),
        "the summaries are gone"
    );
    // The engine's file is untouched, which is the whole difference between a cache and the truth.
    assert!(std::fs::read_to_string(&file)
        .expect("transcript")
        .contains("deploy"));
    // And the next read re-derives it: a clear costs one pass, never a repair.
    assert_eq!(projection.page(&file, None, 10).expect("page").total, 1);
    let _ = dir;
}

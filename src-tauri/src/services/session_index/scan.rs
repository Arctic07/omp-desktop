//! The scan over the engine's session store: which files become candidate sessions, what the cache
//! already knows about them, and in which order the summaries are reported.
//!
//! A session is a transcript written *directly* into the store. The subdirectories beside those
//! files are a session's own subagents, which the header lists and the sidebar never does: they are
//! read by [`super::children`] and this scan does not enter them. Usage accounting is the one walk
//! that does descend into them, and it is the host's own (`host/src/store.ts`), not this module's.
//!
//! The file format itself - how a summary is derived from one session file - belongs to
//! [`super`]; this module only decides which files are looked at and reuses what does not need to
//! be read again.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::models::agent::SessionSummary;
use crate::state::SessionIndexCache;

use super::{archived_summary, classify, read_summary, session_id_from_name, FileKind, RowKind};

/// Directory entries examined by a single scan, so a store filled with unrelated files cannot stall
/// it. The bound is twice the candidate bound on purpose: a session that spawned subagents has a
/// directory of its own beside its transcript, so the store's top level holds about two entries per
/// session.
const ENTRY_LIMIT: usize = 4096;
/// Candidate session files inspected by a single scan.
const CANDIDATE_LIMIT: usize = 2000;

/// Scans the session store - the files written directly into `sessions_root` - and returns the
/// sessions that belong to `workspace_root`, newest first; unreadable or malformed files are simply
/// skipped.
///
/// Summaries are cached per file: a candidate whose size and modification time are unchanged is
/// reused instead of read back, and every path this scan did not see is dropped from the cache.
pub(crate) fn list_sessions(
    sessions_root: &Path,
    workspace_root: &str,
    cache: &SessionIndexCache,
) -> Vec<SessionSummary> {
    let mut sessions: Vec<SessionSummary> = Vec::new();
    let row = RowKind::Workspace { workspace_root };
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut archives: Vec<PathBuf> = Vec::new();
    // A rotated copy (`<name>.jsonl.<stamp>.bak`) is the same conversation as the transcript it was
    // taken from, so it is never a row of its own: the engine moves a transcript aside while it
    // publishes the rewrite over it, and only a publish that never finished leaves the copy behind.
    // Listing both would draw one conversation twice, under two ids the reader's clicks, marks and
    // panel state cannot tell apart - and while the transcript is momentarily absent (that same
    // publish) the copy would take the row's place under an id that is about to disappear again.
    // So a copy answers only for a conversation whose transcript this scan did not read at all,
    // which is the crash the conversation still has to be recoverable from.
    let mut backups: Vec<(PathBuf, SessionSummary)> = Vec::new();
    // An archive keeps its header compressed, so the workspace it belongs to can only be proven by
    // the transcript of the same session - the same engine id in the file name, written into the
    // same store by the same engine.
    let mut proven: HashSet<String> = HashSet::new();
    for (path, kind) in collect_candidates(sessions_root, CANDIDATE_LIMIT, ENTRY_LIMIT) {
        seen.insert(path.clone());
        match read_summary(&path, kind, row, cache) {
            Some(summary) => match kind {
                FileKind::Transcript => {
                    if let Some(id) = engine_id(&path) {
                        proven.insert(id);
                    }
                    sessions.push(summary);
                }
                FileKind::Backup => backups.push((path, summary)),
                FileKind::Archived => sessions.push(summary),
            },
            None if kind == FileKind::Archived => archives.push(path),
            None => {}
        }
    }
    for (path, summary) in backups {
        // The engine id is the same on both names: `session_id_from_name` reads the part before
        // `.jsonl`, and a rotated copy keeps it.
        if engine_id(&path).is_some_and(|id| proven.contains(&id)) {
            continue;
        }
        sessions.push(summary);
    }
    for path in archives {
        // A sibling of *any* session says nothing about an archive's workspace - the store holds
        // them all - so only the transcript of its own session may prove it. Without one the
        // archive stays unlisted rather than being attributed to whichever workspace happens to be
        // scanned.
        if engine_id(&path).is_some_and(|id| proven.contains(&id)) {
            if let Some(summary) = archived_summary(&path, workspace_root, cache) {
                sessions.push(summary);
            }
        }
    }
    cache.retain_seen(&seen);

    sessions.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    sessions
}

/// The engine's own id for a candidate, as its file name carries it; `None` for a name the engine
/// did not write.
fn engine_id(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    session_id_from_name(name)
}

/// Collects up to `budget` session files from one directory - the store, for a scan, or one
/// session's child directory, for its subagents - ignoring directories, symlinks and unrelated
/// files; the caller counts the result against its own budget. `entry_limit` bounds the directory
/// entries examined, so a pathological directory cannot stall the caller.
pub(super) fn collect_candidates(
    directory: &Path,
    budget: usize,
    entry_limit: usize,
) -> Vec<(PathBuf, FileKind)> {
    let mut files = Vec::new();
    let reader = match std::fs::read_dir(directory) {
        Ok(reader) => reader,
        Err(_) => return files,
    };
    for (scanned, entry) in reader.flatten().enumerate() {
        if files.len() >= budget || scanned >= entry_limit {
            break;
        }
        if !matches!(entry.file_type(), Ok(file_type) if file_type.is_file()) {
            continue;
        }
        let path = entry.path();
        let name = match path.file_name().and_then(|name| name.to_str()) {
            Some(name) => name,
            None => continue,
        };
        if let Some(kind) = classify(name) {
            files.push((path, kind));
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::agent::SessionColdStatus::{Complete, Pending, Unknown};
    use crate::services::paths::normalize_for_compare;
    use crate::services::session_index::fixtures::{
        escaped_path, flat_sessions, forked_session_file, fresh_store, gzip_stub, large_transcript,
        message, message_with_times, scan, session_file, session_with_children, set_mtime,
        summary_of, transcript_sample, HUMAN_ENTRY,
    };
    use crate::services::session_index::{
        host_session_id, reset_window_reads, window_reads, SessionIndexCache,
    };

    /// The session ids the fixtures name their files with, so a test can say which session it
    /// means without quoting a uuid four times.
    const DEMO: &str = "01a0c9e3-41e8-7000-bc90-195f85789cf1";
    const DEMO_NEWER: &str = "01a0c9e4-1111-7000-bc90-195f85789cf2";
    const OTHER: &str = "01a0c980-5639-7000-85ec-88844ad421d2";

    fn file_name(id: &str, suffix: &str) -> String {
        format!("2026-09-22T16-11-49-097Z_{id}.jsonl{suffix}")
    }

    /// The store the current host writes: every workspace's sessions flat in one directory, so the
    /// only thing that says which workspace a file belongs to is the `cwd` in its own header.
    /// Before this was read as a store, the scan looked at subdirectories only and answered `[]`
    /// for exactly this layout.
    #[test]
    fn flat_sessions_are_attributed_by_their_own_headers() {
        let mine = file_name(DEMO, "");
        let newer = file_name(DEMO_NEWER, "");
        let theirs = file_name(OTHER, "");
        let root = flat_sessions(
            "flat",
            &[
                (
                    &mine,
                    session_file(DEMO, "C:/project/demo", "", &[HUMAN_ENTRY.to_owned()]),
                ),
                (
                    &newer,
                    // The same working directory as the engine records it, separators and all:
                    // one workspace, two header spellings.
                    session_file(
                        DEMO_NEWER,
                        &escaped_path(r"C:\project\demo"),
                        "engine title",
                        &[message("assistant", Some("stop"))],
                    ),
                ),
                (
                    &theirs,
                    session_file(OTHER, "C:/project/other", "elsewhere", &[]),
                ),
            ],
        );
        set_mtime(&root.join(&mine), 1_000_000);
        set_mtime(&root.join(&newer), 2_000_000);
        set_mtime(&root.join(&theirs), 3_000_000);

        let sessions = scan(&root, "C:/project/demo");
        assert_eq!(
            sessions.len(),
            2,
            "only the two sessions that name this workspace: {sessions:?}"
        );
        assert_eq!(
            sessions
                .iter()
                .map(|summary| summary.file_path.rsplit(['/', '\\']).next().unwrap())
                .collect::<Vec<_>>(),
            vec![newer.as_str(), mine.as_str()],
            "newest first, across the workspaces mixed into one store"
        );
        let listed = summary_of(&sessions, &mine);
        // The whole first line of the prompt, not a slice of its words: the derivation reads the
        // prompt as a label now (see `session_title` for the rules themselves).
        assert_eq!(
            listed.title,
            "please refactor the session index projection now"
        );
        assert_eq!(listed.cwd, "C:/project/demo");
        assert_eq!(listed.status, Pending);
        assert!(!listed.compressed, "a transcript is not a compressed file");
        let listed_newer = summary_of(&sessions, &newer);
        assert_eq!(listed_newer.title, "engine title");
        assert_eq!(
            listed_newer.cwd, r"C:\project\demo",
            "the same working directory, spelled the way the engine recorded it"
        );
        assert_eq!(listed_newer.status, Complete);
        for summary in &sessions {
            assert_eq!(
                summary.id,
                host_session_id(Path::new(&summary.file_path)),
                "the id the host routes the file by, not the engine's own from the header: {summary:?}"
            );
        }
        // The same scan for the other workspace lists its own session and no other, which is what
        // makes the store's flatness harmless.
        let others = scan(&root, "C:/project/other");
        assert_eq!(others.len(), 1);
        assert_eq!(summary_of(&others, &theirs).title, "elsewhere");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A session's subagents are written into a directory named after its own transcript, beside
    /// it, and they name the same workspace in their headers - so nothing but the walk decides
    /// whether they show up. They must not: the sidebar lists the conversations of a workspace,
    /// and every subagent of one is a section of its own header instead.
    #[test]
    fn a_sessions_subagents_are_not_sessions_of_the_store() {
        let parent = file_name(DEMO, "");
        let child_id = "01a0d99c-c9bd-7000-bbfd-dd1389cd0f75";
        let root = session_with_children(
            "subagents",
            &parent,
            session_file(DEMO, "C:/project/demo", "parent", &[]),
            &[
                (
                    "FrontendScout.jsonl",
                    session_file(child_id, "C:/project/demo", "", &[HUMAN_ENTRY.to_owned()]),
                ),
                // The subagent's own notes and the tombstone a removed one leaves behind: files
                // beside the transcript, and neither is a session.
                ("FrontendScout.md", b"# notes".to_vec()),
                ("FrontendScout.jsonl.tombstone", b"{}".to_vec()),
            ],
        );

        let sessions = scan(&root, "C:/project/demo");
        assert_eq!(
            sessions.len(),
            1,
            "the conversation, not its subagents: {sessions:?}"
        );
        assert_eq!(summary_of(&sessions, &parent).title, "parent");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A store with no sessions in it, and one that is not there at all: the answer is the same
    /// empty listing rather than a failure.
    #[test]
    fn a_store_without_sessions_lists_nothing() {
        let root = fresh_store("empty");
        assert!(scan(&root, "C:/project/demo").is_empty());
        assert!(scan(&root.join("gone"), "C:/project/demo").is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// In the flat store the sessions of every workspace sit side by side, so a sibling of any
    /// session says nothing about an archive's workspace. Only the transcript of the *same*
    /// session - the same engine id in the file name - may prove it, and an archive without one
    /// stays unlisted.
    #[test]
    fn an_archive_in_the_flat_store_needs_its_own_transcript() {
        let transcript = file_name(DEMO, "");
        let its_archive = file_name(DEMO, ".gz");
        let orphan = file_name(OTHER, ".gz");
        let stranger = file_name("01a0c970-2222-7000-86a4-a9172d05209e", "");
        let stranger_archive = file_name("01a0c970-2222-7000-86a4-a9172d05209e", ".gz");
        let root = flat_sessions(
            "flat-archive",
            &[
                (&transcript, transcript_sample("C:/project/demo", DEMO)),
                (&its_archive, gzip_stub()),
                (&orphan, gzip_stub()),
                (
                    &stranger,
                    session_file(
                        "01a0c970-2222-7000-86a4-a9172d05209e",
                        "C:/project/other",
                        "elsewhere",
                        &[],
                    ),
                ),
                (&stranger_archive, gzip_stub()),
            ],
        );

        // The archive of a session is what an older file leaves behind, so the transcript is the
        // newer of the two and the listing order is a fact of the test rather than of the clock.
        set_mtime(&root.join(&transcript), 2_000_000);
        set_mtime(&root.join(&its_archive), 1_000_000);

        let sessions = scan(&root, "C:/project/demo");
        let listed: Vec<&str> = sessions
            .iter()
            .map(|summary| summary.file_path.rsplit(['/', '\\']).next().unwrap())
            .collect();
        assert_eq!(
            listed,
            vec![transcript.as_str(), its_archive.as_str()],
            "the transcript and the archive of the same session, and nothing else: {sessions:?}"
        );
        assert!(
            !listed.contains(&orphan.as_str()),
            "no transcript, no proof"
        );
        assert!(
            !listed.contains(&stranger_archive.as_str()),
            "a transcript of another workspace proves nothing about this one"
        );
        let archived = summary_of(&sessions, &its_archive);
        assert!(
            archived.compressed,
            "the row says it is a compressed file, not a live transcript"
        );
        assert_eq!(
            archived.id,
            host_session_id(&root.join(&its_archive)),
            "the id the host routes the archive's file by"
        );
        // An archive's header stays compressed and unreadable, so what the row says about it is
        // what an archive can prove: the workspace its transcript proved, no title of its own, and
        // no cold status - the only one of these the file itself cannot state.
        assert_eq!(archived.cwd, "C:/project/demo");
        assert_eq!(archived.title, "");
        assert_eq!(archived.status, Unknown);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A rotated copy is the transcript the engine moved aside while it published a rewrite, not a
    /// conversation of its own. Listing it beside the transcript draws one conversation twice,
    /// under two ids the reader's clicks, marks and panel state cannot tell apart (and, while the
    /// transcript is momentarily absent, it would take the row's place under an id that vanishes
    /// again on the next read).
    #[test]
    fn a_rotated_copy_is_not_a_second_row_beside_its_transcript() {
        let transcript = file_name(DEMO, "");
        let rotated = format!("{transcript}.01a1773000000000.bak");
        let root = flat_sessions(
            "rotated-copy",
            &[
                (
                    &transcript,
                    session_file(DEMO, "C:/project/demo", "kept", &[HUMAN_ENTRY.to_owned()]),
                ),
                (
                    &rotated,
                    session_file(DEMO, "C:/project/demo", "kept", &[HUMAN_ENTRY.to_owned()]),
                ),
            ],
        );

        let sessions = scan(&root, "C:/project/demo");
        let listed: Vec<&str> = sessions
            .iter()
            .map(|summary| summary.file_path.rsplit(['/', '\\']).next().unwrap())
            .collect();
        assert_eq!(
            listed,
            vec![transcript.as_str()],
            "the conversation once, under the transcript's own row: {sessions:?}"
        );
        assert_eq!(
            sessions[0].id,
            host_session_id(&root.join(&transcript)),
            "and under the id its transcript is routed by"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The one case a rotated copy *is* the row: the publish that moved the transcript aside never
    /// finished, so the copy is the only readable form of that conversation left. Losing it would
    /// lose the conversation.
    #[test]
    fn a_rotated_copy_answers_for_a_transcript_that_is_gone() {
        let transcript = file_name(DEMO, "");
        let rotated = format!("{transcript}.01a1773000000000.bak");
        let root = flat_sessions(
            "rotated-orphan",
            &[(
                &rotated,
                session_file(
                    DEMO,
                    "C:/project/demo",
                    "recovered",
                    &[HUMAN_ENTRY.to_owned()],
                ),
            )],
        );

        let sessions = scan(&root, "C:/project/demo");
        assert_eq!(
            sessions.len(),
            1,
            "the recovery row, not an empty store: {sessions:?}"
        );
        let recovered = summary_of(&sessions, &rotated);
        assert_eq!(recovered.title, "recovered");
        assert_eq!(
            recovered.id,
            host_session_id(&root.join(&rotated)),
            "the id the host mints when it is asked to open that file"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A blank slot means the engine wrote no title at all, so the label comes from the first
    /// prompt the user actually typed; an engine-written title always wins, and a session without
    /// any human prompt stays empty. The derivation rules themselves are covered by
    /// `session_title`'s own tests - this one proves the scan wires them in.
    #[test]
    fn blank_title_slot_falls_back_to_the_first_human_prompt() {
        let prompt_labeled = file_name("01a0bcf1-1e76-7000-aeae-aefed618164f", "");
        let engine_labeled = file_name("01a0bcf1-9cdf-7000-acb4-160f23eeb512", "");
        let silent = file_name("01a0bd72-d313-7000-a729-e4d1f1c51248", "");
        let root = flat_sessions(
            "fallback",
            &[
                (
                    &prompt_labeled,
                    session_file(
                        "01a0bcf1-1e76-7000-aeae-aefed618164f",
                        "D:/workspace",
                        "",
                        &[HUMAN_ENTRY.to_owned()],
                    ),
                ),
                (
                    &engine_labeled,
                    session_file(
                        "01a0bcf1-9cdf-7000-acb4-160f23eeb512",
                        "D:/workspace",
                        "engine title",
                        &[HUMAN_ENTRY.to_owned()],
                    ),
                ),
                (
                    &silent,
                    session_file(
                        "01a0bd72-d313-7000-a729-e4d1f1c51248",
                        "D:/workspace",
                        "",
                        &[],
                    ),
                ),
            ],
        );

        let sessions = scan(&root, "D:/workspace");
        assert_eq!(sessions.len(), 3);
        assert_eq!(
            summary_of(&sessions, &prompt_labeled).title,
            "please refactor the session index projection now"
        );
        assert_eq!(summary_of(&sessions, &engine_labeled).title, "engine title");
        assert_eq!(summary_of(&sessions, &silent).title, "");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The point of the cache: the second scan of an unchanged directory answers from it, field
    /// for field, without reading a single head or tail window.
    #[test]
    fn a_second_scan_reuses_every_summary_without_reading_windows() {
        let root = flat_sessions(
            "warm",
            &[
                (
                    "2026-09-20T03-51-53-718Z_01a0bcf1-1e76-7000-aeae-aefed618164f.jsonl",
                    session_file(
                        "01a0bcf1-1e76-7000-aeae-aefed618164f",
                        "D:/workspace",
                        "engine title",
                        &[message("assistant", Some("stop"))],
                    ),
                ),
                (
                    "2026-09-20T03-52-26-079Z_01a0bcf1-9cdf-7000-acb4-160f23eeb512.jsonl",
                    session_file(
                        "01a0bcf1-9cdf-7000-acb4-160f23eeb512",
                        "D:/workspace",
                        "",
                        &[HUMAN_ENTRY.to_owned()],
                    ),
                ),
            ],
        );
        let cache = SessionIndexCache::new();

        reset_window_reads();
        let cold = list_sessions(&root, "D:/workspace", &cache);
        let cold_reads = window_reads();

        reset_window_reads();
        let warm = list_sessions(&root, "D:/workspace", &cache);
        let warm_reads = window_reads();

        assert_eq!(cold.len(), 2);
        assert_eq!(cold, warm, "the cached scan reports the same sessions");
        assert!(cold_reads >= 4, "the cold scan reads windows: {cold_reads}");
        assert_eq!(warm_reads, 0, "the warm scan reads no window");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The same reuse, across a process boundary: a cache opened on the projection database a
    /// previous run wrote answers every row without reading a window. This is what the first list
    /// after a restart costs - stats, not 84 KiB per conversation.
    #[test]
    fn a_scan_after_a_restart_reads_no_window_either() {
        let root = flat_sessions(
            "projected",
            &[
                (
                    "2026-09-20T03-51-53-718Z_01a0bcf1-1e76-7000-aeae-aefed618164f.jsonl",
                    session_file(
                        "01a0bcf1-1e76-7000-aeae-aefed618164f",
                        "D:/workspace",
                        "engine title",
                        &[message("assistant", Some("stop"))],
                    ),
                ),
                (
                    "2026-09-20T03-52-26-079Z_01a0bcf1-9cdf-7000-acb4-160f23eeb512.jsonl",
                    session_file(
                        "01a0bcf1-9cdf-7000-acb4-160f23eeb512",
                        "D:/workspace",
                        "",
                        &[HUMAN_ENTRY.to_owned()],
                    ),
                ),
            ],
        );
        let database = root.join("index.sqlite");

        // The first run: a cold scan that fills the projection.
        let first = list_sessions(&root, "D:/workspace", &SessionIndexCache::open(&database));
        assert_eq!(first.len(), 2);

        // The second: a new process, nothing in memory, the same database.
        reset_window_reads();
        let second = list_sessions(&root, "D:/workspace", &SessionIndexCache::open(&database));
        let reads = window_reads();

        assert_eq!(second, first, "a restarted scan reports the same sessions");
        assert_eq!(reads, 0, "and reads no window to do it: {reads}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A row the projection still holds is not trusted after the file moved: the scan reads the
    /// transcript again and answers with what is there now.
    #[test]
    fn a_rewritten_transcript_is_read_again_after_a_restart() {
        let root = flat_sessions(
            "projected-stale",
            &[(
                "2026-09-20T03-51-53-718Z_01a0bcf1-1e76-7000-aeae-aefed618164f.jsonl",
                session_file(
                    "01a0bcf1-1e76-7000-aeae-aefed618164f",
                    "D:/workspace",
                    "engine title",
                    &[message("assistant", Some("stop"))],
                ),
            )],
        );
        let database = root.join("index.sqlite");
        let first = list_sessions(&root, "D:/workspace", &SessionIndexCache::open(&database));
        assert_eq!(first.len(), 1);

        // The engine retitles the session and appends a turn: same path, new file state.
        std::fs::write(
            root.join("2026-09-20T03-51-53-718Z_01a0bcf1-1e76-7000-aeae-aefed618164f.jsonl"),
            session_file(
                "01a0bcf1-1e76-7000-aeae-aefed618164f",
                "D:/workspace",
                "a new title",
                &[message("assistant", Some("stop"))],
            ),
        )
        .expect("rewrite");

        let second = list_sessions(&root, "D:/workspace", &SessionIndexCache::open(&database));
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].title, "a new title");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// What a first list costs when the projection also indexes every transcript's words, and what
    /// the second one costs. Ignored by default because it reads a real data root:
    ///
    /// ```text
    ///   OMP_DESKTOP_SESSION_INDEX_ROOT=<data>/host/sessions \
    ///   OMP_DESKTOP_SESSION_INDEX_WORKSPACE=<workspace> \
    ///   cargo test --lib -- --ignored --nocapture a_cold_scan_indexes_the_store_once
    /// ```
    #[test]
    #[ignore = "reads a real data root: set OMP_DESKTOP_SESSION_INDEX_ROOT and OMP_DESKTOP_SESSION_INDEX_WORKSPACE"]
    fn a_cold_scan_indexes_the_store_once() {
        let root = std::env::var("OMP_DESKTOP_SESSION_INDEX_ROOT")
            .expect("OMP_DESKTOP_SESSION_INDEX_ROOT names the real `host/sessions` directory");
        let workspace = std::env::var("OMP_DESKTOP_SESSION_INDEX_WORKSPACE")
            .expect("OMP_DESKTOP_SESSION_INDEX_WORKSPACE names the workspace to scan");
        let database = std::path::PathBuf::from(&root).join("bench-index.sqlite");
        let _ = std::fs::remove_file(&database);

        let cold = SessionIndexCache::open(&database);
        let started = std::time::Instant::now();
        let first = list_sessions(Path::new(&root), &workspace, &cold);
        let cold_ms = started.elapsed().as_millis();

        let warm = SessionIndexCache::open(&database);
        let started = std::time::Instant::now();
        let second = list_sessions(Path::new(&root), &workspace, &warm);
        let warm_ms = started.elapsed().as_millis();

        let bytes = std::fs::metadata(&database)
            .map(|meta| meta.len())
            .unwrap_or(0);
        // A search over what the scan just indexed: the second half of the same claim, on real data.
        let hits = warm.search("the", 10);
        println!(
            "{} sessions: cold {cold_ms} ms (index + summaries), warm {warm_ms} ms, index {} KiB, \
             search \"the\" -> {} conversations / {} lines",
            first.len(),
            bytes / 1024,
            hits.len(),
            hits.iter().map(|hit| hit.hit.matches).sum::<i64>()
        );
        assert_eq!(
            first.len(),
            second.len(),
            "a warm scan lists the same sessions"
        );
        let _ = std::fs::remove_file(&database);
    }

    /// A session that belongs to another workspace is walked and dropped. Nothing caches it for
    /// this workspace, so it costs its attribution probe on every scan - which is why the scan
    /// settles attribution from the smallest window instead of the full head.
    #[test]
    fn another_workspaces_session_is_never_attributed() {
        let root = flat_sessions(
            "stranger",
            &[(
                "2026-09-20T03-53-00-000Z_01a0bcf1-aaaa-7000-acb4-160f23eeb513.jsonl",
                session_file(
                    "01a0bcf1-aaaa-7000-acb4-160f23eeb513",
                    "D:/other",
                    "elsewhere",
                    &[message("assistant", Some("stop"))],
                ),
            )],
        );
        let cache = SessionIndexCache::new();

        reset_window_reads();
        let cold = list_sessions(&root, "D:/workspace", &cache);
        let cold_reads = window_reads();

        reset_window_reads();
        let warm = list_sessions(&root, "D:/workspace", &cache);
        let warm_reads = window_reads();

        assert!(cold.is_empty());
        assert!(warm.is_empty());
        assert_eq!(cold_reads, 1, "one probe settles the attribution");
        assert_eq!(warm_reads, 1, "an unattributable file is not cached");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A conversation *copied* from another one keeps its messages' own times, so the transcript
    /// cannot say when the copy was made - the header can, and that is what puts the conversation a
    /// reader just branched at the top of the list instead of among conversations from days ago.
    #[test]
    fn a_copied_conversation_is_dated_by_its_own_header() {
        /// The moment the copy is made, as the engine writes it into the header it creates.
        const FORK_ISO: &str = "2026-09-28T12:00:00.000Z";
        /// The copy's own message, older than the conversation it was taken from: its ordering may
        /// not come from its messages at all. Messages carry their stamps as Unix ms numbers
        /// (`2026-09-19T00:00:00Z`), which is the shape the engine writes into a transcript.
        const OLD_MESSAGE_MS: &str = "1789776000000";
        /// The conversation the copy was taken from: newer messages than the copy holds, and older
        /// than the moment the copy was made.
        const HELD_MESSAGE_MS: &str = "1790214945867";
        let copy_name = "2026-09-28T12-00-00-000Z_01a0e900-aaaa-7000-acb4-160f23eeb513.jsonl";
        let held_name = "2026-09-20T03-51-53-718Z_01a0bcf2-1e76-7000-aeae-aefed618164f.jsonl";
        let root = flat_sessions(
            "copied",
            &[
                (
                    copy_name,
                    forked_session_file(
                        "01a0e900-aaaa-7000-acb4-160f23eeb513",
                        "C:/project/demo",
                        "branch of an older conversation",
                        FORK_ISO,
                        &[message_with_times(
                            "assistant",
                            Some("stop"),
                            Some(OLD_MESSAGE_MS),
                            Some(OLD_MESSAGE_MS),
                        )],
                    ),
                ),
                (
                    held_name,
                    session_file(
                        "01a0bcf2-1e76-7000-aeae-aefed618164f",
                        "C:/project/demo",
                        "the conversation it was copied from",
                        &[message_with_times(
                            "assistant",
                            Some("stop"),
                            Some(HELD_MESSAGE_MS),
                            Some(HELD_MESSAGE_MS),
                        )],
                    ),
                ),
            ],
        );
        let sessions = scan(&root, "C:/project/demo");
        assert_eq!(sessions.len(), 2);
        let copy = summary_of(&sessions, copy_name);
        assert_eq!(
            copy.updated_at,
            crate::services::runtime::history::iso_to_ms(FORK_ISO),
            "the copy's own header, not the older messages it carries: {sessions:?}"
        );
        let listed: Vec<&str> = sessions
            .iter()
            .map(|summary| summary.file_path.rsplit(['/', '\\']).next().unwrap())
            .collect();
        assert_eq!(
            listed,
            vec![copy_name, held_name],
            "so a conversation branched now is listed first, whatever its messages date"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A turn the engine appends changes the file's size, which is what takes a summary out of the
    /// cache: the next scan has to see the new status rather than the remembered one.
    #[test]
    fn an_appended_turn_is_read_again() {
        let file_name = "2026-09-20T03-51-53-718Z_01a0bcf2-1e76-7000-aeae-aefed618164f.jsonl";
        let root = flat_sessions(
            "changed",
            &[(
                file_name,
                session_file(
                    "01a0bcf2-1e76-7000-aeae-aefed618164f",
                    "D:/workspace",
                    "engine title",
                    &[message("assistant", Some("stop"))],
                ),
            )],
        );
        let cache = SessionIndexCache::new();
        let before = list_sessions(&root, "D:/workspace", &cache);
        assert_eq!(before[0].status, Complete);

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(root.join(file_name))
            .expect("append to the session file");
        {
            use std::io::Write;
            file.write_all(format!("{}\n", message("user", None)).as_bytes())
                .expect("append a turn");
        }
        drop(file);

        let after = list_sessions(&root, "D:/workspace", &cache);
        assert_eq!(after[0].status, Pending);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A row is timed by the newest message in its transcript, not by its file. Opening a
    /// conversation appends entries of the engine's own (`session_exit` and friends), so a session
    /// the user has not written in for hours would otherwise read "just now" the moment it was
    /// clicked - the row would say when it was opened rather than when it was last written.
    ///
    /// Both files below carry the modification time of the same open, and the two transcripts
    /// differ in one thing: one holds a message of its own. That message is what its row has to be
    /// timed and ordered by; the transcript that holds none keeps the file, the only fact it has.
    #[test]
    fn a_session_is_timed_by_its_newest_message_not_by_its_file() {
        const LAST_MESSAGE_MS: u64 = 1_790_214_945_867;
        const OPENED_LATER_MS: u64 = 1_790_214_966_815;
        let stamp = LAST_MESSAGE_MS.to_string();
        let written = file_name(DEMO, "");
        let silent = file_name(OTHER, "");
        let root = flat_sessions(
            "message-time",
            &[
                (
                    &written,
                    session_file(
                        DEMO,
                        "C:/project/demo",
                        "engine title",
                        &[
                            message_with_times(
                                "assistant",
                                Some("stop"),
                                Some(stamp.as_str()),
                                Some(stamp.as_str()),
                            ),
                            format!(
                                "{{\"type\":\"custom\",\"customType\":\"session_exit\",\"data\":\
                                 {{\"reason\":\"dispose\",\"kind\":\"normal\"}},\
                                 \"timestamp\":{OPENED_LATER_MS}}}"
                            ),
                        ],
                    ),
                ),
                (
                    &silent,
                    session_file(OTHER, "C:/project/demo", "silent", &[]),
                ),
            ],
        );
        set_mtime(&root.join(&written), OPENED_LATER_MS);
        set_mtime(&root.join(&silent), OPENED_LATER_MS);

        let sessions = scan(&root, "C:/project/demo");
        assert_eq!(sessions.len(), 2);
        let row = summary_of(&sessions, &written);
        assert_eq!(
            row.updated_at, LAST_MESSAGE_MS as i64,
            "the message's own stamp, not the file the engine appended to after it: {sessions:?}"
        );
        assert_eq!(row.status, Complete);
        assert_eq!(
            summary_of(&sessions, &silent).updated_at,
            OPENED_LATER_MS as i64,
            "nothing in this transcript dates the session, so the file still does"
        );
        let listed: Vec<&str> = sessions
            .iter()
            .map(|summary| summary.file_path.rsplit(['/', '\\']).next().unwrap())
            .collect();
        assert_eq!(
            listed,
            vec![silent.as_str(), written.as_str()],
            "and those times are what the rows are ordered by: the session that was only opened \
             stays behind the one that holds the message"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Read-only acceptance against a real data root: the store a running application writes has
    /// to list the sessions of the workspace being scanned, and every listed id has to be the one
    /// the host routes that file by. Nothing is written into the store.
    ///
    /// ```text
    /// OMP_DESKTOP_SESSION_INDEX_ROOT=<data root>/host/sessions \
    /// OMP_DESKTOP_SESSION_INDEX_WORKSPACE=<workspace root> \
    /// OMP_DESKTOP_SESSION_INDEX_EXPECT=<file name fragment> \
    ///   cargo test --lib -- --ignored --nocapture lists_a_real_session_store
    /// ```
    #[test]
    #[ignore = "reads a real data root: set OMP_DESKTOP_SESSION_INDEX_ROOT and OMP_DESKTOP_SESSION_INDEX_WORKSPACE"]
    fn lists_a_real_session_store() {
        let root = std::env::var("OMP_DESKTOP_SESSION_INDEX_ROOT")
            .expect("OMP_DESKTOP_SESSION_INDEX_ROOT names the real `host/sessions` directory");
        let workspace = std::env::var("OMP_DESKTOP_SESSION_INDEX_WORKSPACE")
            .expect("OMP_DESKTOP_SESSION_INDEX_WORKSPACE names the workspace to scan");
        let sessions = list_sessions(Path::new(&root), &workspace, &SessionIndexCache::new());

        assert!(
            !sessions.is_empty(),
            "the store has to list the sessions of {workspace}: {root}"
        );
        println!("{} sessions in {root} for {workspace}:", sessions.len());
        for summary in &sessions {
            let file = Path::new(&summary.file_path);
            println!(
                "  {}  {:?}  cwd={}  title={:?}  {}",
                summary.id, summary.status, summary.cwd, summary.title, summary.file_path
            );
            assert!(
                normalize_for_compare(Path::new(&summary.cwd))
                    == normalize_for_compare(Path::new(&workspace)),
                "a listed session has to name the workspace being scanned: {summary:?}"
            );
            assert_eq!(
                file.parent().map(Path::to_path_buf),
                Some(PathBuf::from(&root)),
                "the store under acceptance is flat: {summary:?}"
            );
            assert_eq!(
                summary.id,
                host_session_id(file),
                "the id the host answers a `session_open` for this file with: {summary:?}"
            );
        }
        if let Ok(expected) = std::env::var("OMP_DESKTOP_SESSION_INDEX_EXPECT") {
            assert!(
                sessions
                    .iter()
                    .any(|summary| summary.file_path.contains(&expected)),
                "the session at {expected} is not in the listing: {sessions:?}"
            );
        }
    }

    /// Benchmark: 600 sessions of ~49 KiB in one store, scanned cold and warm.
    ///
    /// `cargo test -- --ignored --nocapture cold_and_warm_scans_of_a_large_index`
    #[test]
    #[ignore = "benchmark: writes ~30 MiB of session files into the temp directory"]
    fn cold_and_warm_scans_of_a_large_index() {
        use std::time::Instant;

        let root = std::env::temp_dir().join(format!("omp-index-bench-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("session store");
        for index in 0..600 {
            let id = format!("01a0bcf1-{index:04}");
            let name = format!("2026-09-20T03-51-53-718Z_{id}-7000-aeae-aefed618164f.jsonl");
            std::fs::write(root.join(name), large_transcript(&id, "D:/workspace"))
                .expect("session file");
        }
        let cache = SessionIndexCache::new();

        reset_window_reads();
        let started = Instant::now();
        let cold = list_sessions(&root, "D:/workspace", &cache);
        let cold_ms = started.elapsed().as_millis();
        let cold_reads = window_reads();

        reset_window_reads();
        let started = Instant::now();
        let warm = list_sessions(&root, "D:/workspace", &cache);
        let warm_ms = started.elapsed().as_millis();
        let warm_reads = window_reads();

        println!(
            "600 sessions: cold {cold_ms} ms ({cold_reads} window reads), \
             warm {warm_ms} ms ({warm_reads} window reads), {} summaries",
            cold.len()
        );
        assert_eq!(cold.len(), 600);
        assert_eq!(cold, warm);
        assert_eq!(warm_reads, 0);
        let _ = std::fs::remove_dir_all(&root);
    }
}

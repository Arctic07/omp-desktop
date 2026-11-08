//! The subagents of one conversation.
//!
//! The engine keeps a spawned subagent's transcript where the conversation that spawned it is
//! known: a directory named after that conversation's own transcript file, beside it. So
//! `<sessions>/<session>.jsonl` has `<sessions>/<session>/<ChildName>.jsonl` next to it for every
//! subagent it spawned, and a conversation's children are the transcripts of that one directory.
//! They are sessions in their own right - they open, stream and answer like any other - but they
//! are not rows of a workspace: [`super::scan`] never enters those directories, and this module is
//! the only reader that does.

use std::path::{Path, PathBuf};

use crate::errors::{IpcError, IpcResult, INVALID_INPUT, INVALID_SESSION_PATH, SESSION_NOT_FOUND};
use crate::models::agent::{SessionChild, SessionChildren, SessionColdStatus};
use crate::services::paths::{is_within, plain_path};
use crate::state::SessionIndexCache;

use super::scan::collect_candidates;
use super::tail::{child_status, read_tail};
use super::{classify, read_summary, session_stem, FileKind, RowKind};

/// Child transcripts one answer keeps: the newest ones, because they are the ones a reader is
/// watching. The engine spawns a handful per conversation, so a directory this large is one
/// nothing in this application wrote - and the answer says it left children out (`truncated`)
/// rather than hiding the child that just started behind whichever files the walk reached first.
const CHILD_LIMIT: usize = 100;
/// Candidates one read examines, and the directory entries it walks to find them: every candidate
/// reached is read, because the answer keeps the newest children and which those are is only known
/// once each of them has been timed. The bound is what keeps a pathological child directory - one
/// nothing in this application wrote - from paying for an unbounded read.
const CHILD_SCAN_LIMIT: usize = 4096;

/// The subagent transcripts of the conversation whose transcript is `session_file`, oldest first.
///
/// `session_file` is checked the way a session path is checked before it is handed to the host
/// (`session::validate_session_file`): a path with a line break in it, one that is not absolute,
/// and one that resolves outside the session store are all refused, the last of them under the
/// `invalid_session_path` code the frontend already handles. What this read adds is the `.jsonl`
/// rule, because the child directory is derived from the file's name: a name without the session
/// suffix names no directory.
///
/// A conversation that spawned no subagent - and one whose transcript the engine has not written
/// yet - answers with an empty list: the caller asked which subagents there are, and "none" is an
/// answer rather than a failure. A conversation with more children than one answer keeps is
/// answered with its newest `CHILD_LIMIT` children and `truncated` set, so the caller can say the
/// roster it holds is partial - the oldest children are the ones left out, never the newest.
///
/// Each row's status is the child's own ending rather than the reading a listed session's tail
/// gets, which is the one place the two readers of the same file format differ: see
/// [`child_row_status`].
pub(crate) fn children_of(
    sessions_dir: &Path,
    session_file: &str,
    cache: &SessionIndexCache,
) -> IpcResult<SessionChildren> {
    let directory = match child_directory(sessions_dir, session_file)? {
        Some(directory) => directory,
        // No directory is the state of every conversation that never spawned a subagent.
        None => {
            return Ok(SessionChildren {
                children: Vec::new(),
                truncated: false,
            })
        }
    };
    let mut children: Vec<SessionChild> = Vec::new();
    for (path, kind) in collect_candidates(&directory, CHILD_SCAN_LIMIT, CHILD_SCAN_LIMIT) {
        // A child directory holds the subagent's own notes (`<ChildName>.md`) and the tombstones of
        // subagents that were removed; only a live transcript is a subagent to open.
        if kind != FileKind::Transcript {
            continue;
        }
        // Read as a subagent row: its presence in its parent's own directory is the attribution a
        // listed row would otherwise have to prove with the workspace in its header.
        if let Some(summary) = read_summary(&path, kind, RowKind::Subagent, cache) {
            let status = child_row_status(&path, summary.status);
            children.push(SessionChild {
                id: summary.id,
                title: summary.title,
                file_path: summary.file_path,
                updated_at: summary.updated_at,
                status,
            });
        }
    }
    // Oldest first - the order the subagents were spawned in, and the order a reader watches them
    // finish in. Children written in the same millisecond fall back to their ids, so the order is a
    // fact of the files rather than of the walk that found them.
    children.sort_by(|left, right| {
        left.updated_at
            .cmp(&right.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    // Over the bound it is the oldest children that go, not whichever the walk reached last: a
    // child that just started is the one a reader is waiting for, while the ones that settled first
    // have been scrolled past. The dropped count is what the answer admits to.
    let dropped = children.len().saturating_sub(CHILD_LIMIT);
    children.drain(..dropped);
    Ok(SessionChildren {
        children,
        truncated: dropped > 0,
    })
}

/// The status one child row states: the child's own ending, and the yardstick is its own.
///
/// A subagent is not a listed session, and its row must not be classed by the rule one of those
/// keeps - [`child_status`] states why the two differ. Two facts make the difference, and neither
/// is in the window a summary is derived from:
///
/// 1. **The result the child yielded**, which the engine writes *beside* the transcript rather than
///    into it: a child that handed its result over is complete, whatever its tail's newest message
///    says. That is read from the directory entry alone ([`result_written`]) and decides the row
///    before the transcript is opened at all.
/// 2. **The ending the child's own tail records** ([`child_status`]): its session's exit, or the
///    stop reason of its newest assistant turn.
///
/// The tail is read a second time here rather than taught to the reader that already read it
/// ([`read_summary`] and `tail_facts`), because that reader's verdict is the one a *listed* session
/// has to keep: an unanswered `user`/`toolResult` tail means the agent owes a reply there, and a
/// flag threaded through it would put the two rules back in one function. The second read is the
/// same bounded window the summary paid for (`read_tail`), and only a child with no result artifact
/// pays it at all. A transcript that cannot be opened leaves the summary's own verdict standing,
/// which is a fact this read already has rather than one invented here.
fn child_row_status(transcript: &Path, from_tail: SessionColdStatus) -> SessionColdStatus {
    if result_written(transcript) {
        return SessionColdStatus::Complete;
    }
    let tail = super::open_settled(transcript).and_then(|mut file| read_tail(&mut file).ok());
    tail.map_or(from_tail, |tail| child_status(&tail))
}

/// Whether the engine wrote this child's result: the `<ChildName>.json` beside a transcript whose
/// subagent yielded - the payload the parent's `task` call received, and the file the engine
/// leaves where its transcript ends when the child hands a result over. Of the two artifacts a
/// yielded child gets, the `.json` is the one asked about: the `.md` beside it carries the same
/// result in readable form, and the engine's own record of the yield is the payload itself rather
/// than a rendering of it.
///
/// Only the directory entry is read. Its metadata says whether a result is there, while its bytes
/// belong to whoever wants the result - never to a roster deciding how a child ended.
fn result_written(transcript: &Path) -> bool {
    std::fs::metadata(transcript.with_extension("json"))
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

/// The directory a conversation's subagents are written into: the session file's own name without
/// its `.jsonl` suffix, beside that file. `None` when the conversation has none, which is the
/// state of every conversation that never spawned a subagent - the engine creates the directory
/// with the first one.
fn child_directory(sessions_dir: &Path, session_file: &str) -> IpcResult<Option<PathBuf>> {
    if session_file.contains(['\n', '\r']) {
        return Err(IpcError::new(INVALID_INPUT, "The session path is invalid."));
    }
    let candidate = Path::new(session_file);
    if !candidate.is_absolute() {
        return Err(IpcError::new(INVALID_INPUT, "The session path is invalid."));
    }
    let name = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| classify(name) == Some(FileKind::Transcript))
        .ok_or_else(|| {
            IpcError::new(
                INVALID_INPUT,
                "A session file has to be a `.jsonl` transcript.",
            )
        })?;
    // `canonicalize` is what makes the containment check mean anything: a path that only looks
    // like it is inside the store - spelled with `..`, or reached through a junction - is resolved
    // first. The transcript itself may not exist yet, which is when its *directory* is the part
    // that has to be inside the store.
    let parent = match std::fs::canonicalize(candidate) {
        Ok(resolved) => resolved.parent().map(Path::to_path_buf),
        Err(_) => candidate
            .parent()
            .and_then(|parent| std::fs::canonicalize(parent).ok()),
    }
    .ok_or_else(|| {
        IpcError::new(
            SESSION_NOT_FOUND,
            "The session file is no longer available.",
        )
    })?;
    if !is_within(sessions_dir, &parent) {
        return Err(IpcError::new(
            INVALID_SESSION_PATH,
            "The session file is outside the engine data directory.",
        ));
    }
    // Spelled plain rather than verbatim: the paths this application hands to the frontend are
    // plain - a row's own `filePath` is, and the frontend matches on that text - while
    // `canonicalize` answers with the `\\?\` form the filesystem uses.
    let directory = PathBuf::from(plain_path(&parent.to_string_lossy())).join(session_stem(name));
    match std::fs::canonicalize(&directory) {
        // A child directory that resolves out of the store is not one this read walks: the engine
        // writes it inside the store, so a link out of it is not the engine's own layout.
        Ok(resolved) if !is_within(sessions_dir, &resolved) => Err(IpcError::new(
            INVALID_SESSION_PATH,
            "The session file is outside the engine data directory.",
        )),
        Ok(_) => Ok(Some(directory)),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::agent::SessionColdStatus::{Aborted, Complete, Error, Pending};
    use crate::services::paths::normalize_for_compare;
    use crate::services::session_index::fixtures::{
        flat_sessions, message_with_times, session_file, session_with_children, summary_of,
    };
    use crate::services::session_index::{host_session_id, list_sessions};

    /// The ids the engine writes into the transcripts' headers - which are not the ids the frontend
    /// addresses a session by, see [`host_session_id`].
    const PARENT_ID: &str = "01a0d99b-fa1f-7000-8f30-80c98313fc49";
    const FRONTEND_ID: &str = "01a0d99c-c9bd-7000-bbfd-dd1389cd0f75";
    const BACKEND_ID: &str = "01a0d99d-1111-7000-8b64-6e1c2dd0f0a0";
    /// The working directory the parent and both children name: a child runs where its parent does,
    /// and this read asks the store nothing about workspaces anyway.
    const CWD: &str = "C:/project/demo";
    /// When each child's newest message was written, in Unix milliseconds.
    const FRONTEND_MS: u64 = 1_790_214_900_000;
    const BACKEND_MS: u64 = 1_790_214_945_867;

    fn parent_name() -> String {
        format!("2026-09-25T17-27-53-119Z_{PARENT_ID}.jsonl")
    }

    /// The store's canonical directory, which is what the command hands the service - the same
    /// form `DataPaths::canonical_dir` produces.
    fn store(root: &Path) -> PathBuf {
        std::fs::canonicalize(root).expect("session store")
    }

    /// The layout a live store has: the parent's transcript at the top, and in the directory beside
    /// it the two subagents the engine spawned, with the names it gave them, one of their notes and
    /// one former subagent's tombstone.
    #[test]
    fn children_are_read_from_the_parents_own_directory() {
        let parent = parent_name();
        let frontend_stamp = FRONTEND_MS.to_string();
        let backend_stamp = BACKEND_MS.to_string();
        let root = session_with_children(
            "children",
            parent.as_str(),
            session_file(PARENT_ID, CWD, "parent", &[]),
            &[
                (
                    "FrontendScout.jsonl",
                    session_file(
                        FRONTEND_ID,
                        CWD,
                        "",
                        &[message_with_times(
                            "assistant",
                            Some("stop"),
                            Some(frontend_stamp.as_str()),
                            Some(frontend_stamp.as_str()),
                        )],
                    ),
                ),
                (
                    "BackendScout.jsonl",
                    session_file(
                        BACKEND_ID,
                        CWD,
                        "backend sweep",
                        &[message_with_times(
                            "user",
                            None,
                            Some(backend_stamp.as_str()),
                            None,
                        )],
                    ),
                ),
                ("FrontendScout.md", b"# notes".to_vec()),
                ("BackendScout.jsonl.tombstone", b"{}".to_vec()),
            ],
        );
        // The rows name a child the way the store spells it - canonical and plain, like every
        // listed row - so the expectation is built from that same root. `temp_dir()` is the shell's
        // own spelling of it, and on Windows that can be the 8.3 short name (`ADMINI~1`) while
        // every canonical answer says `user`; an expectation built from the raw fixture
        // root would then disagree with the row over a name for the same directory.
        let canonical_root = store(&root);
        let directory = canonical_root.join(session_stem(&parent));

        let answer = children_of(
            &canonical_root,
            // Deliberately the fixture's own spelling, not the canonical one: the store is what
            // names the rows, so a file path spelled either way has to resolve to the same child.
            &root.join(&parent).to_string_lossy(),
            &SessionIndexCache::new(),
        )
        .expect("children");

        assert!(!answer.truncated, "both children fit in one answer");
        assert_eq!(
            answer
                .children
                .iter()
                .map(|child| child.title.as_str())
                .collect::<Vec<_>>(),
            vec!["FrontendScout", "backend sweep"],
            "the file name where the engine wrote no title, the title it wrote where there is one, \
             and neither the notes nor the tombstone: {:?}",
            answer.children
        );
        // Oldest first: the subagent that finished before the other one even replied.
        let frontend = &answer.children[0];
        assert_eq!(
            frontend.id,
            host_session_id(&directory.join("FrontendScout.jsonl"))
        );
        assert_eq!(frontend.updated_at, FRONTEND_MS as i64);
        assert_eq!(frontend.status, Complete);
        assert_eq!(
            normalize_for_compare(Path::new(&frontend.file_path)),
            normalize_for_compare(&directory.join("FrontendScout.jsonl")),
            "a plain path, spelled the way the rows are: {frontend:?}"
        );
        let backend = &answer.children[1];
        assert_eq!(
            backend.id,
            host_session_id(&directory.join("BackendScout.jsonl"))
        );
        assert_eq!(backend.updated_at, BACKEND_MS as i64);
        assert_eq!(
            backend.status, Pending,
            "a child whose last turn is the user's is still working"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A conversation that never spawned a subagent has no directory beside its transcript, and one
    /// the engine has not written a file for yet has nothing beside it either: neither is a
    /// failure, and both answer with no children.
    #[test]
    fn a_conversation_without_a_child_directory_has_no_children() {
        let parent = parent_name();
        let root = flat_sessions(
            "no-children",
            &[(parent.as_str(), session_file(PARENT_ID, CWD, "parent", &[]))],
        );
        let sessions_dir = store(&root);

        let written = root.join(&parent).to_string_lossy().into_owned();
        let silent =
            children_of(&sessions_dir, &written, &SessionIndexCache::new()).expect("children");
        assert!(silent.children.is_empty());
        assert!(!silent.truncated, "nothing to leave out");

        let unwritten = root
            .join(format!("2026-09-26T09-00-00-000Z_{PARENT_ID}.jsonl"))
            .to_string_lossy()
            .into_owned();
        let pending =
            children_of(&sessions_dir, &unwritten, &SessionIndexCache::new()).expect("children");
        assert!(pending.children.is_empty());
        assert!(!pending.truncated, "nothing to leave out");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A conversation with more children than one answer keeps: the read still reads all of them,
    /// and the ones it drops are the *oldest* - a child that just started is what a reader is
    /// waiting for - which the answer admits to instead of presenting the part as the whole.
    #[test]
    fn only_the_newest_children_survive_the_read_bound() {
        const START_MS: u64 = 1_790_214_900_000;
        const OVER: usize = 3;
        let parent = parent_name();
        let names: Vec<String> = (0..CHILD_LIMIT + OVER)
            .map(|index| format!("Scout{index:03}.jsonl"))
            .collect();
        // One second apart, oldest first, so the walk's own order and the roster's order are
        // different things and only the stamps can produce the contract's order.
        let bodies: Vec<Vec<u8>> = (0..CHILD_LIMIT + OVER)
            .map(|index| {
                let stamp = (START_MS + index as u64 * 1000).to_string();
                session_file(
                    &format!("01a0d99c-{index:04}-7000-bbfd-dd1389cd0f75"),
                    CWD,
                    "",
                    &[message_with_times(
                        "assistant",
                        Some("stop"),
                        Some(stamp.as_str()),
                        Some(stamp.as_str()),
                    )],
                )
            })
            .collect();
        let files: Vec<(&str, Vec<u8>)> = names.iter().map(String::as_str).zip(bodies).collect();
        let root = session_with_children(
            "child-bound",
            parent.as_str(),
            session_file(PARENT_ID, CWD, "parent", &[]),
            &files,
        );
        let directory = root.join(session_stem(&parent));
        let transcript = root.join(&parent).to_string_lossy().into_owned();

        let answer =
            children_of(&store(&root), &transcript, &SessionIndexCache::new()).expect("children");
        assert_eq!(
            answer.children.len(),
            CHILD_LIMIT,
            "one answer keeps {CHILD_LIMIT} children"
        );
        assert!(answer.truncated, "and says it left some out: {answer:?}");
        assert_eq!(
            answer.children[0].title,
            format!("Scout{OVER:03}"),
            "the oldest children are the ones dropped"
        );
        assert_eq!(
            answer.children[CHILD_LIMIT - 1].updated_at,
            (START_MS + (CHILD_LIMIT + OVER - 1) as u64 * 1000) as i64,
            "the child that started last is still in the answer"
        );
        assert!(
            answer
                .children
                .windows(2)
                .all(|pair| pair[0].updated_at < pair[1].updated_at),
            "and the whole answer is in the contract's order: {answer:?}"
        );

        // The bound is what an answer keeps, not what it drops: the same directory one answer's
        // worth of children below it is answered in full and says so.
        for index in 0..OVER {
            std::fs::remove_file(directory.join(format!("Scout{index:03}.jsonl")))
                .expect("drop the oldest children");
        }
        let whole =
            children_of(&store(&root), &transcript, &SessionIndexCache::new()).expect("children");
        assert_eq!(whole.children.len(), CHILD_LIMIT);
        assert!(
            !whole.truncated,
            "a directory that fits in one answer is not truncated"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The store is the whole of what this read may touch: a session file outside it is the error
    /// the frontend already handles, and a caller that names something which is not a session
    /// transcript at all is told so rather than being handed a listing.
    #[test]
    fn a_session_file_outside_the_store_is_refused() {
        let root = flat_sessions("outside", &[]);
        let sessions_dir = store(&root);
        let cache = SessionIndexCache::new();

        let outside = std::env::temp_dir().join(format!(
            "omp-index-children-outside-{}.jsonl",
            std::process::id()
        ));
        for (path, expected) in [
            (outside.to_string_lossy().into_owned(), INVALID_SESSION_PATH),
            (parent_name(), INVALID_INPUT),
            (
                root.join("notes.txt").to_string_lossy().into_owned(),
                INVALID_INPUT,
            ),
        ] {
            let error = children_of(&sessions_dir, &path, &cache).expect_err(&path);
            assert_eq!(error.code, expected, "{path}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The statuses the fixture below reports, by the title a row is known by.
    fn status_of(answer: &SessionChildren, title: &str) -> SessionColdStatus {
        answer
            .children
            .iter()
            .find(|child| child.title == title)
            .unwrap_or_else(|| panic!("{title} is not in {answer:?}"))
            .status
    }

    /// A subagent that handed its result over. The engine writes `<ChildName>.json` beside the
    /// transcript, and the transcript's newest message is a tool result - the last thing the child
    /// wrote before yielding - which is the tail that read as `pending` while the child was done:
    /// the yield is the ending, and it is a fact of the child's directory rather than of its window.
    #[test]
    fn a_child_that_yielded_its_result_is_complete() {
        let parent = parent_name();
        let stamp = BACKEND_MS.to_string();
        let root = session_with_children(
            "child-yielded",
            parent.as_str(),
            session_file(PARENT_ID, CWD, "parent", &[]),
            &[
                (
                    "BackendScout.jsonl",
                    session_file(
                        BACKEND_ID,
                        CWD,
                        "",
                        &[
                            message_with_times(
                                "assistant",
                                Some("toolUse"),
                                Some(stamp.as_str()),
                                Some(stamp.as_str()),
                            ),
                            message_with_times("toolResult", None, Some(stamp.as_str()), None),
                        ],
                    ),
                ),
                // The two artifacts a yielded child gets: the payload the parent's call received,
                // and the same result in readable form.
                (
                    "BackendScout.json",
                    br#"{"architecture":"one service"}"#.to_vec(),
                ),
                (
                    "BackendScout.md",
                    br#"{"architecture":"one service"}"#.to_vec(),
                ),
            ],
        );
        let directory = root.join(session_stem(&parent));
        let cache = SessionIndexCache::new();

        let answer = children_of(&store(&root), &root.join(&parent).to_string_lossy(), &cache)
            .expect("children");
        assert_eq!(answer.children.len(), 1, "{answer:?}");
        assert_eq!(
            status_of(&answer, "BackendScout"),
            Complete,
            "the engine wrote the child's result, so the child yielded: {answer:?}"
        );
        // The same file read as a listed row keeps the other reading - an unanswered tool result is
        // a reply still owed - which is the rule this module did not touch.
        let as_a_listed_row = read_summary(
            &directory.join("BackendScout.jsonl"),
            FileKind::Transcript,
            RowKind::Subagent,
            &cache,
        )
        .expect("summary");
        assert_eq!(
            as_a_listed_row.status, Pending,
            "one file, two readers: only a child's row takes its result artifact as an ending"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A subagent that was stopped. No result was handed over, and the ending is one only the
    /// child's own tail states: the aborted turn the stop wrote, or - when the session was disposed
    /// (a host that died with its children is the same shape) - the engine's own `session_exit`,
    /// which no listed row's tail ends on. Both shapes are here because both are real, and the
    /// second one's newest *message* is a tool result that a listed row would read as a reply still
    /// owed. The marker is written in the spelling the engine uses - a `custom` entry whose kind
    /// lives in `customType` - so a reader that only matched a top-level `type` of `session_exit`
    /// fails here rather than in the field.
    #[test]
    fn a_child_that_was_stopped_is_aborted() {
        let parent = parent_name();
        let stamp = BACKEND_MS.to_string();
        let root = session_with_children(
            "child-stopped",
            parent.as_str(),
            session_file(PARENT_ID, CWD, "parent", &[]),
            &[
                (
                    "FrontendScout.jsonl",
                    session_file(
                        FRONTEND_ID,
                        CWD,
                        "",
                        &[
                            message_with_times("user", None, Some(stamp.as_str()), None),
                            message_with_times(
                                "assistant",
                                Some("aborted"),
                                Some(stamp.as_str()),
                                Some(stamp.as_str()),
                            ),
                        ],
                    ),
                ),
                (
                    "BackendScout.jsonl",
                    session_file(
                        BACKEND_ID,
                        CWD,
                        "",
                        &[
                            message_with_times(
                                "assistant",
                                Some("toolUse"),
                                Some(stamp.as_str()),
                                Some(stamp.as_str()),
                            ),
                            message_with_times("toolResult", None, Some(stamp.as_str()), None),
                            "{\"type\":\"custom\",\"customType\":\"session_exit\",\"data\":\
                             {\"reason\":\"uncaught_exception\",\"kind\":\"fatal\"}}"
                                .to_owned(),
                        ],
                    ),
                ),
                // What the engine leaves where a result would have gone: the notes file at no
                // bytes, and the tombstone of the transcript it released.
                ("FrontendScout.md", Vec::new()),
                ("FrontendScout.jsonl.tombstone", Vec::new()),
                ("BackendScout.md", Vec::new()),
                ("BackendScout.jsonl.tombstone", Vec::new()),
            ],
        );

        let answer = children_of(
            &store(&root),
            &root.join(&parent).to_string_lossy(),
            &SessionIndexCache::new(),
        )
        .expect("children");
        assert_eq!(answer.children.len(), 2, "{answer:?}");
        assert_eq!(
            status_of(&answer, "FrontendScout"),
            Aborted,
            "the stop's own turn ended the child: {answer:?}"
        );
        assert_eq!(
            status_of(&answer, "BackendScout"),
            Aborted,
            "the session's exit did, on a tail whose newest message is an answered tool call: \
             {answer:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A child whose newest turn errored: a turn that failed hands nothing over, so no result
    /// artifact was written and the transcript's own ending is the only fact the row has to state.
    #[test]
    fn a_child_whose_turn_errored_is_an_error() {
        let parent = parent_name();
        let stamp = BACKEND_MS.to_string();
        let root = session_with_children(
            "child-error",
            parent.as_str(),
            session_file(PARENT_ID, CWD, "parent", &[]),
            &[
                (
                    "BackendScout.jsonl",
                    session_file(
                        BACKEND_ID,
                        CWD,
                        "",
                        &[
                            message_with_times("user", None, Some(stamp.as_str()), None),
                            message_with_times(
                                "assistant",
                                Some("error"),
                                Some(stamp.as_str()),
                                Some(stamp.as_str()),
                            ),
                        ],
                    ),
                ),
                ("BackendScout.md", Vec::new()),
                ("BackendScout.jsonl.tombstone", Vec::new()),
            ],
        );

        let answer = children_of(
            &store(&root),
            &root.join(&parent).to_string_lossy(),
            &SessionIndexCache::new(),
        )
        .expect("children");
        assert_eq!(
            status_of(&answer, "BackendScout"),
            Error,
            "an errored turn is a failure, not an owed reply: {answer:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A child that is still working - the case the roster is watched for. Its result is not
    /// written yet and its tail holds no ending, so an unanswered tool result stays what it is for
    /// a listed session too: work the child still owes.
    #[test]
    fn a_child_that_is_still_working_reads_as_pending() {
        let parent = parent_name();
        let stamp = BACKEND_MS.to_string();
        let root = session_with_children(
            "child-working",
            parent.as_str(),
            session_file(PARENT_ID, CWD, "parent", &[]),
            &[(
                "BackendScout.jsonl",
                session_file(
                    BACKEND_ID,
                    CWD,
                    "",
                    &[
                        message_with_times(
                            "assistant",
                            Some("toolUse"),
                            Some(stamp.as_str()),
                            Some(stamp.as_str()),
                        ),
                        message_with_times("toolResult", None, Some(stamp.as_str()), None),
                    ],
                ),
            )],
        );

        let answer = children_of(
            &store(&root),
            &root.join(&parent).to_string_lossy(),
            &SessionIndexCache::new(),
        )
        .expect("children");
        assert_eq!(
            status_of(&answer, "BackendScout"),
            Pending,
            "no result, no ending: the child is still in its turn: {answer:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The line the child's rule had to hold: a listed session's tail is still read by the rule it
    /// was read by. One store, one fixture, read both ways - the parent's newest message is a tool
    /// result, so the listing says the conversation owes a reply, while the child beside it, whose
    /// tail looks the same, is complete because the engine wrote its result.
    #[test]
    fn a_listed_row_keeps_the_reading_of_the_tail_it_had() {
        let parent = parent_name();
        let stamp = BACKEND_MS.to_string();
        let turn = |stop_reason: Option<&str>, role: &str| {
            message_with_times(
                role,
                stop_reason,
                Some(stamp.as_str()),
                Some(stamp.as_str()),
            )
        };
        let root = session_with_children(
            "listed-unchanged",
            parent.as_str(),
            session_file(
                PARENT_ID,
                CWD,
                "parent",
                &[
                    turn(Some("toolUse"), "assistant"),
                    message_with_times("toolResult", None, Some(stamp.as_str()), None),
                ],
            ),
            &[
                (
                    "BackendScout.jsonl",
                    session_file(
                        BACKEND_ID,
                        CWD,
                        "",
                        &[
                            turn(Some("toolUse"), "assistant"),
                            message_with_times("toolResult", None, Some(stamp.as_str()), None),
                        ],
                    ),
                ),
                ("BackendScout.json", br#"{"findings":[]}"#.to_vec()),
            ],
        );
        let cache = SessionIndexCache::new();
        let sessions_dir = store(&root);

        let rows = list_sessions(&sessions_dir, CWD, &cache);
        assert_eq!(
            rows.len(),
            1,
            "a child's directory is not a workspace row: {rows:?}"
        );
        let listed = summary_of(&rows, &parent);
        assert_eq!(listed.cwd, CWD);
        assert_eq!(
            listed.status, Pending,
            "a listed session whose newest message is a tool result still owes a reply"
        );

        let answer = children_of(&sessions_dir, &root.join(&parent).to_string_lossy(), &cache)
            .expect("children");
        assert_eq!(
            status_of(&answer, "BackendScout"),
            Complete,
            "the same tail, read as the child it belongs to: {answer:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}

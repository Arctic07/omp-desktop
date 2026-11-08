//! One-shot history read: the whole transcript of a session, walked page by page.
//!
//! The frontend pages nothing itself: it asks for one conversation's transcript and this walk
//! fetches every page from the host, reporting progress as it goes. The rows and their order are
//! exactly what the paged path produced, because both normalize with `normalize_messages`.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::errors::{IpcError, IpcResult, ENGINE_PROTOCOL, HISTORY_TOO_LARGE};
use crate::models::agent::{ChatMessage, HistoryChunk, HistoryProgress, SessionHistory};
use crate::services::runtime::history::{
    normalize_messages, normalize_subagent_messages, preview_boundary,
};
use crate::services::runtime::host::HostRuntime;
use crate::services::runtime::session::{require_session, validate_session_file};
use crate::services::runtime::CONNECT_TIMEOUT_MS;
use crate::state::SessionIndexCache;

/// Page size asked of the host. The plan's §13.4 C page size is 256, and the host's own ceiling is
/// `JUMP_PAGE_MESSAGES * 8` = 1600 (`host/src/history.ts`), so this never reaches it: one page is
/// a few hundred rows, and one large page costs fewer round trips than many small ones.
pub(crate) const HISTORY_PAGE_LIMIT: u64 = 256;
/// Stop for a cursor that never ends. A transcript this long is a broken host rather than a
/// conversation, and the walk has to fail instead of looping and growing without bound.
const HISTORY_PAGE_CAP: u32 = 4096;
/// Ceiling on the bytes of messages one walk accumulates.
///
/// The page ceiling above bounds the walk in rows and this bounds it in bytes, which the row count
/// cannot do on its own: one row's text is clamped (`MAX_TEXT_CHARS`) but a walk may still hold a
/// million of them. A transcript this large cannot be rendered in one call either, so it is refused
/// with a message that says so rather than truncated - a shortened transcript that does not admit to
/// being shortened is the one outcome this walk must never produce.
const HISTORY_BYTES_LIMIT: usize = 128 * 1024 * 1024;

/// One host page in the shape the walk needs: the raw transcript entries, and the total as the host
/// reported it (`None` when the page said nothing about it).
///
/// The entries stay raw until the walk is over. A tool call and its result are two entries, and a
/// page boundary can fall between them: normalizing each page on its own would make the call a
/// permanently running row on page N and an orphan result row on page N+1, both under the same
/// `toolCallId`. Normalizing the concatenated stream is what pairs them the way the whole
/// conversation does.
struct HistoryPage {
    entries: Vec<Value>,
    total: Option<i64>,
    next_cursor: Option<String>,
}

/// Which conversation one page of the walk belongs to.
///
/// The two are exclusive, mirroring the host's own rule (`host/src/sessions.ts::history`): a
/// `sessionId` is a session this process registered - a conversation the user opened - while a
/// `sessionFile` is a transcript the caller only knows the path of. A subagent is never opened as a
/// session of its own (the desktop attaches to its channel instead), so the file is the only
/// address it has, and a page frame carrying both would send the host down the registered-session
/// branch, where a subagent does not exist.
#[derive(Debug, Clone)]
enum HistoryTarget {
    Session(String),
    File(String),
}

/// The `session_history_page` command for one page, addressed one way or the other.
fn page_command(target: &HistoryTarget, cursor: Option<&str>) -> Value {
    let mut command = match target {
        HistoryTarget::Session(session_id) => json!({
            "type": "session_history_page",
            "sessionId": session_id,
            "limit": HISTORY_PAGE_LIMIT,
        }),
        HistoryTarget::File(session_file) => json!({
            "type": "session_history_page",
            "sessionFile": session_file,
            "limit": HISTORY_PAGE_LIMIT,
        }),
    };
    if let Some(cursor) = cursor {
        command["cursor"] = json!(cursor);
    }
    command
}

/// Reads one page and normalizes it. A page holds at most `HISTORY_PAGE_LIMIT` entries, so the
/// normalization stays a small batch and does not need a thread of its own.
///
/// A file-addressed read of a transcript **nothing holds open** is answered from the persisted
/// projection first (`state::SessionIndexCache::page`): its message entries were given byte spans by
/// the last scan, so a page costs the page rather than one more pass over the whole transcript. The
/// engine's own reader remains the answer for every case the projection cannot prove - a file
/// outside its index, a line it could not read, a cursor issued against another transcript size -
/// and for every conversation this process holds open, whose rows are the active branch and not
/// what a file happens to contain.
async fn fetch_page(
    host: &HostRuntime,
    target: &HistoryTarget,
    cursor: Option<String>,
    projection: Option<&Arc<SessionIndexCache>>,
) -> IpcResult<HistoryPage> {
    if let (HistoryTarget::File(file), Some(projection)) = (target, projection) {
        if host
            .session(&crate::services::session_index::host_session_id(Path::new(
                file,
            )))
            .is_none()
        {
            let path = PathBuf::from(file);
            let projected = projection.clone();
            let wanted = cursor.clone();
            let page = tauri::async_runtime::spawn_blocking(move || {
                projected.page(&path, wanted.as_deref(), HISTORY_PAGE_LIMIT as usize)
            })
            .await
            .ok()
            .flatten();
            if let Some(page) = page {
                return Ok(HistoryPage {
                    entries: page.messages,
                    total: Some(page.total),
                    next_cursor: page.next_cursor,
                });
            }
        }
    }
    let command = page_command(target, cursor.as_deref());
    let data = match target {
        // A registered session goes out through its own registration, which is also what keeps
        // `session_not_found` answering the way callers expect for a conversation that was closed.
        HistoryTarget::Session(session_id) => {
            host.call_session_ok(session_id, command, CONNECT_TIMEOUT_MS)
                .await?
        }
        // A file-addressed read has no registration to go through, and it must not have one: the
        // top-level call sends the frame without a `sessionId`, which is the whole point of the
        // branch (`session_delete` addresses the host the same way).
        HistoryTarget::File(_) => host.call_ok(command, CONNECT_TIMEOUT_MS).await?,
    };
    let entries = data
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(HistoryPage {
        entries,
        total: data.get("totalMessages").and_then(Value::as_i64),
        next_cursor: data
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
    })
}

/// Walks the host's pages, reporting progress after each one and stopping where the host stops
/// handing out cursors.
///
/// `on_report` receives a [`HistoryChunk::Rows`] for every page whose rows are final (see
/// `history.rs::preview_boundary`) and a [`HistoryChunk::Progress`] after every page. Rows are only
/// reported when `stream_rows` is set: a caller painting a conversation as it arrives passes
/// `true`, and one that only wants the answer passes `false` and receives the rows once, in
/// [`SessionHistory`].
///
/// Paging is generic over where a page comes from, so these rules - the page ceiling, the total the
/// pages report, the cursor that ends the walk, the failure that ends it - are exercised without a
/// host process.
async fn walk_pages<F, Fut>(
    mut fetch: F,
    mut on_report: impl FnMut(HistoryChunk) + Send,
    stream_rows: bool,
    bytes_limit: usize,
    normalize: fn(&[Value]) -> Vec<ChatMessage>,
) -> IpcResult<SessionHistory>
where
    F: FnMut(Option<String>) -> Fut + Send,
    Fut: Future<Output = IpcResult<HistoryPage>> + Send,
{
    // Rows already reported to the caller. The walk may start over once, and this is reset with
    // the rows the frontend is told to drop.
    let mut reported = 0usize;
    // A snapshot cursor is bound to the transcript length it was issued against. A turn that writes
    // while the walk runs therefore makes the next page `stale_cursor`, and the walk starts over
    // once from the first page rather than losing the whole conversation to one refused page. The
    // host's contract delegates this policy to the caller.
    'walk: for attempt in 0..2 {
        let mut entries: Vec<Value> = Vec::new();
        let mut accumulated_bytes: usize = 0;
        let mut cursor: Option<String> = None;
        let mut total: Option<i64> = None;
        for _ in 0..HISTORY_PAGE_CAP {
            let page = match fetch(cursor.take()).await {
                Ok(page) => page,
                Err(error) if error.code == "stale_cursor" && attempt == 0 => {
                    // Anything already painted came from a transcript that no longer exists as
                    // that prefix: the reader is told to replace it, not to append to it.
                    if stream_rows && reported > 0 {
                        on_report(HistoryChunk::Rows {
                            messages: Vec::new(),
                            loaded: 0,
                            total: 0,
                            reset: true,
                        });
                    }
                    reported = 0;
                    on_report(HistoryChunk::Progress(HistoryProgress {
                        loaded: 0,
                        total: 0,
                    }));
                    continue 'walk;
                }
                Err(error) => return Err(error),
            };
            // What the page will cost the caller is what it weighs on the wire, so the budget counts
            // the entries as they are sent rather than guessing at them from their row count. The encode
            // cannot fail for this DTO - plain JSON values - and a page that somehow could not be
            // measured is counted as over the ceiling rather than as free: a page this walk cannot
            // measure is one it cannot hold to a ceiling.
            let page_bytes = serde_json::to_vec(&page.entries)
                .map(|encoded| encoded.len())
                .unwrap_or(usize::MAX);
            accumulated_bytes = accumulated_bytes.saturating_add(page_bytes);
            if accumulated_bytes > bytes_limit {
                return Err(IpcError::new(
                HISTORY_TOO_LARGE,
                "This conversation is too large to open in one call. Its transcript cannot be loaded whole.",
            ));
            }
            entries.extend(page.entries);
            if let Some(reported_total) = page.total {
                total = Some(reported_total);
            }
            if stream_rows {
                // Only the prefix whose rows can no longer change is reported: the last assistant
                // entry may still be waiting for tool results on the next page.
                let boundary = preview_boundary(&entries);
                if boundary > 0 {
                    let rows = normalize(&entries[..boundary]);
                    if rows.len() > reported {
                        on_report(HistoryChunk::Rows {
                            messages: rows[reported..].to_vec(),
                            loaded: entries.len() as i64,
                            total: total.unwrap_or(0),
                            reset: false,
                        });
                        reported = rows.len();
                    }
                }
            }
            on_report(HistoryChunk::Progress(HistoryProgress {
                loaded: entries.len() as i64,
                // No page has reported a total yet: the caller renders "opening" rather than a count.
                total: total.unwrap_or(0),
            }));
            let Some(next) = page.next_cursor else {
                let messages = normalize(&entries);
                if stream_rows && messages.len() > reported {
                    on_report(HistoryChunk::Rows {
                        messages: messages[reported..].to_vec(),
                        loaded: entries.len() as i64,
                        total: total.unwrap_or(0),
                        reset: false,
                    });
                }
                return Ok(SessionHistory {
                    // The host never named a total, so there is none to report: `0` is what the
                    // frontend renders "opening" for, rather than a count this process invented.
                    total_messages: total.unwrap_or(0),
                    // One normalization over the whole stream: a call and its result are paired even
                    // when the host's page boundary fell between them. The mapping is the caller's
                    // choice because a subagent's transcript keeps its opening assignment where a
                    // conversation's does not (see `normalize_subagent_messages`).
                    messages,
                });
            };
            cursor = Some(next);
        }
        return Err(IpcError::new(
            ENGINE_PROTOCOL,
            "The engine host did not end the history walk.",
        ));
    }
    // The first attempt is the only one that can be asked to start over; a second stale cursor is
    // the host changing the transcript under every attempt, which is a failure rather than a retry.
    Err(IpcError::new(
        "stale_cursor",
        "The transcript kept changing while it was being read.",
    ))
}

/// The whole transcript of one session, page by page, normalized exactly as the paged path
/// normalized each page.
///
/// `session_file` names a transcript to read instead of a session opened here - a subagent's, which
/// is why `require_session` is skipped for it: the id a subagent is stored under was never
/// registered with this process, and the gate exists to keep a *command* from addressing a
/// conversation that is gone, not to decide which files may be read. That decision stays where it
/// has always been: the file has to be inside the engine's session directory
/// (`session::validate_session_file`).
///
/// A host error is returned as it arrived - `session_busy` and `stale_cursor` included - and
/// nothing here retries: the caller owns the retry budget and the wait that goes with it.
///
/// `task_prompt` picks the mapping: a subagent's transcript keeps the assignment it opened with
/// (`normalize_subagent_messages`), every other read hides the engine-authored user messages
/// (`normalize_messages`). It is the caller's fact, not something inferred from the file: a
/// conversation is read by file too, and the two are otherwise indistinguishable here.
///
/// `stream_rows` asks for the rows as they become final, one page at a time (see [`walk_pages`]) -
/// what a surface painting the conversation as it opens passes. The answer carries every row either
/// way.
pub(crate) async fn history(
    host: &HostRuntime,
    session_id: &str,
    session_file: Option<&str>,
    task_prompt: bool,
    stream_rows: bool,
    projection: Option<Arc<SessionIndexCache>>,
    on_report: impl FnMut(HistoryChunk) + Send,
) -> IpcResult<SessionHistory> {
    let target = match session_file {
        Some(path) => HistoryTarget::File(validate_session_file(host, path)?),
        None => {
            require_session(host, session_id)?;
            HistoryTarget::Session(session_id.to_owned())
        }
    };
    let host = host.clone();
    let normalize = if task_prompt {
        normalize_subagent_messages
    } else {
        normalize_messages
    };
    walk_pages(
        |cursor| {
            let host = host.clone();
            let target = target.clone();
            let projection = projection.clone();
            async move { fetch_page(&host, &target, cursor, projection.as_ref()).await }
        },
        on_report,
        stream_rows,
        HISTORY_BYTES_LIMIT,
        normalize,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// One page as the host answers it, built from the raw entry objects.
    fn page(
        entries: &[String],
        total: Option<i64>,
        next_cursor: Option<&str>,
    ) -> IpcResult<HistoryPage> {
        let parsed: Vec<Value> = entries
            .iter()
            .map(|entry| serde_json::from_str(entry).expect("entry"))
            .collect();
        Ok(HistoryPage {
            entries: parsed,
            total,
            next_cursor: next_cursor.map(str::to_owned),
        })
    }

    /// One human entry as the host hands it back: the message object itself, already unwrapped
    /// from its transcript envelope (`host/src/history.ts` pushes `entry.message`, and
    /// `normalize_messages` reads `role`/`content`/`timestamp` off the object it is given).
    fn user(index: i64) -> String {
        format!(
            r#"{{"role":"user","content":[{{"type":"text","text":"m{index}"}}],"timestamp":"2026-09-22T10:00:00.000Z"}}"#
        )
    }

    /// A call and its result split across the host's page boundary are one row, not two.
    ///
    /// The boundary is an artefact of paging: the conversation has the call and its result next to
    /// each other. Normalizing each page on its own made the first page's call permanently
    /// `running` and the second page's result an orphan with the same id.
    #[test]
    fn a_tool_call_and_its_result_are_paired_across_a_page_boundary() {
        let call = r#"{"role":"assistant","content":[{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"a"}}],"timestamp":"2026-09-22T10:00:00.000Z"}"#.to_owned();
        let result = r#"{"role":"toolResult","toolCallId":"call-1","toolName":"read","content":[{"type":"text","text":"ok"}],"isError":false,"timestamp":"2026-09-22T10:00:01.000Z"}"#.to_owned();
        let pages: Mutex<Vec<Vec<String>>> = Mutex::new(vec![vec![call], vec![result]]);
        let history = tauri::async_runtime::block_on(walk_pages(
            move |cursor| {
                let mut pages = pages.lock().expect("pages");
                let (entries, next) = if cursor.is_none() {
                    (pages.remove(0), Some("c1".to_owned()))
                } else {
                    (pages.remove(0), None)
                };
                async move { page(&entries, Some(2), next.as_deref()) }
            },
            |_| {},
            false,
            HISTORY_BYTES_LIMIT,
            normalize_messages,
        ))
        .expect("walk");
        let tools: Vec<Value> = history
            .messages
            .iter()
            .filter_map(|message| serde_json::to_value(message).ok())
            .filter(|row| row["kind"] == "tool")
            .collect();
        assert_eq!(tools.len(), 1, "one call, one tool row");
        assert_eq!(tools[0]["state"], "success");
        assert_eq!(tools[0]["resultText"], "ok");
    }

    #[test]
    fn the_walk_collects_every_page_in_order() {
        let pages: Mutex<Vec<Vec<String>>> =
            Mutex::new(vec![vec![user(1)], vec![user(2), user(3)]]);
        let mut chunks: Vec<HistoryChunk> = Vec::new();
        let history = tauri::async_runtime::block_on(walk_pages(
            move |cursor| {
                let mut pages = pages.lock().expect("pages");
                let (entries, next) = if cursor.is_none() {
                    (pages.remove(0), Some("c1".to_owned()))
                } else {
                    (pages.remove(0), None)
                };
                async move { page(&entries, Some(3), next.as_deref()) }
            },
            |report| chunks.push(report),
            true,
            HISTORY_BYTES_LIMIT,
            normalize_messages,
        ))
        .expect("walk");
        assert_eq!(history.messages.len(), 3);
        assert_eq!(history.total_messages, 3);
        let mut progress: Vec<HistoryProgress> = Vec::new();
        let mut painted: Vec<ChatMessage> = Vec::new();
        for chunk in chunks {
            match chunk {
                HistoryChunk::Progress(report) => progress.push(report),
                HistoryChunk::Rows { messages, .. } => painted.extend(messages),
            }
        }
        assert_eq!(progress.len(), 2);
        assert_eq!(progress[1].loaded, 3);
        // What a streaming caller painted is exactly what the answer carries.
        assert_eq!(painted.len(), history.messages.len());
    }

    /// The rows a walk streams can never be a call the transcript is still going to complete.
    ///
    /// A host page can end between a call and its result. The walk therefore holds back the last
    /// assistant entry (and what follows it) until the next page brings that result, so a reader
    /// painting the stream never sees a call stuck on `running` that the answer then contradicts.
    #[test]
    fn streamed_rows_hold_back_a_call_its_result_can_still_complete() {
        let call = r#"{"role":"assistant","content":[{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"a"}}],"timestamp":"2026-09-22T10:00:00.000Z"}"#.to_owned();
        let result = r#"{"role":"toolResult","toolCallId":"call-1","toolName":"read","content":[{"type":"text","text":"ok"}],"isError":false,"timestamp":"2026-09-22T10:00:01.000Z"}"#.to_owned();
        let pages: Mutex<Vec<Vec<String>>> = Mutex::new(vec![vec![user(1), call], vec![result]]);
        let mut painted: Vec<ChatMessage> = Vec::new();
        let history = tauri::async_runtime::block_on(walk_pages(
            move |cursor| {
                let mut pages = pages.lock().expect("pages");
                let (entries, next) = if cursor.is_none() {
                    (pages.remove(0), Some("c1".to_owned()))
                } else {
                    (pages.remove(0), None)
                };
                async move { page(&entries, Some(3), next.as_deref()) }
            },
            |report| {
                if let HistoryChunk::Rows { messages, .. } = report {
                    painted.extend(messages);
                }
            },
            true,
            HISTORY_BYTES_LIMIT,
            normalize_messages,
        ))
        .expect("walk");
        let tools: Vec<Value> = painted
            .iter()
            .filter_map(|message| serde_json::to_value(message).ok())
            .filter(|row| row["kind"] == "tool")
            .collect();
        assert_eq!(tools.len(), 1, "the call is painted once, not as two rows");
        assert_eq!(tools[0]["state"], "success");
        assert_eq!(painted.len(), history.messages.len());
    }

    /// A walk that starts over must tell the reader to drop what it painted, not append to it.
    #[test]
    fn a_restarted_walk_resets_the_rows_it_streamed() {
        let mut calls = 0;
        let mut resets = 0;
        let mut painted = 0usize;
        tauri::async_runtime::block_on(walk_pages(
            |_cursor| {
                calls += 1;
                async move {
                    match calls {
                        1 => page(&[user(1)], Some(2), Some("c1")),
                        2 => Err(IpcError::from_engine(
                            Some("stale_cursor"),
                            "The transcript changed since this cursor was issued.".to_owned(),
                        )),
                        _ => page(&[user(2)], Some(2), None),
                    }
                }
            },
            |report| {
                if let HistoryChunk::Rows {
                    messages, reset, ..
                } = report
                {
                    if reset {
                        resets += 1;
                        painted = 0;
                    } else {
                        painted += messages.len();
                    }
                }
            },
            true,
            HISTORY_BYTES_LIMIT,
            normalize_messages,
        ))
        .expect("the second attempt answers");
        assert_eq!(resets, 1, "the reader was told to drop the first attempt");
        assert_eq!(painted, 1, "only the transcript that exists was painted");
    }

    /// A cursor made stale by a turn that wrote while the walk ran starts the walk over once.
    #[test]
    fn a_stale_cursor_is_retried_from_the_first_page() {
        let mut calls = 0;
        let history = tauri::async_runtime::block_on(walk_pages(
            |_cursor| {
                calls += 1;
                async move {
                    match calls {
                        1 => page(&[user(1)], Some(2), Some("c1")),
                        2 => Err(IpcError::from_engine(
                            Some("stale_cursor"),
                            "The transcript changed since this cursor was issued.".to_owned(),
                        )),
                        _ => page(&[user(2)], Some(2), None),
                    }
                }
            },
            |_| {},
            false,
            HISTORY_BYTES_LIMIT,
            normalize_messages,
        ))
        .expect("the second attempt answers");
        assert_eq!(
            calls, 3,
            "page one, the refused second page, and page one again"
        );
        assert_eq!(history.messages.len(), 1);
    }

    /// A host that keeps handing out cursors is a broken host, not an endless conversation.
    #[test]
    fn an_endless_cursor_ends_the_walk_with_a_protocol_error() {
        let error = tauri::async_runtime::block_on(walk_pages(
            |_| async { page(&[user(1)], None, Some("again")) },
            |_| {},
            false,
            HISTORY_BYTES_LIMIT,
            normalize_messages,
        ))
        .expect_err("endless cursor");
        assert_eq!(error.code, ENGINE_PROTOCOL);
    }

    /// A refusal is passed through untouched, so the caller can retry on its own schedule.
    #[test]
    fn a_busy_host_is_reported_as_such() {
        let error = tauri::async_runtime::block_on(walk_pages(
            |_| async {
                Err(IpcError::from_engine(
                    Some("session_busy"),
                    "The session is busy.".to_owned(),
                ))
            },
            |_| {},
            false,
            HISTORY_BYTES_LIMIT,
            normalize_messages,
        ))
        .expect_err("busy");
        assert_eq!(error.code, "session_busy");
    }

    /// A transcript that outgrows the byte ceiling is refused rather than shortened: a history
    /// missing its tail, returned as if it were the whole conversation, is the one outcome this
    /// walk must never produce.
    #[test]
    fn a_transcript_past_the_byte_ceiling_is_refused_not_shortened() {
        let one_page = serde_json::to_string(&page(&[user(1)], None, None).expect("page").entries)
            .expect("encode")
            .len();
        let error = tauri::async_runtime::block_on(walk_pages(
            |_| async { page(&[user(1)], None, Some("more")) },
            |_| {},
            false,
            one_page,
            normalize_messages,
        ))
        .expect_err("over the ceiling");
        assert_eq!(error.code, HISTORY_TOO_LARGE);
        assert!(
            !error.message.is_empty(),
            "the refusal says what could not be loaded"
        );

        // The same single page is inside a ceiling that fits it, so the walk finishes and answers
        // with the whole conversation rather than refusing everything.
        let history = tauri::async_runtime::block_on(walk_pages(
            |_| async { page(&[user(1)], None, None) },
            |_| {},
            false,
            one_page,
            normalize_messages,
        ))
        .expect("walk");
        assert_eq!(history.messages.len(), 1);
    }

    /// The regression this covers: reading the history of a transcript that is not an open session.
    ///
    /// The two addresses are exclusive in the frame because the host dispatches on which one it
    /// finds (`host/src/sessions.ts::history`): a `sessionId` is looked up in its live registry -
    /// where a subagent never is, so it answers `session_not_found` - while a `sessionFile` is
    /// resolved from disk. A page that carried both, which is what sending a file-addressed read
    /// through the session-level call would produce (that call injects the id), would therefore fail
    /// every time: the attached child view would open empty.
    #[test]
    fn a_page_is_addressed_by_id_or_by_file_never_both() {
        let registered = page_command(
            &HistoryTarget::Session("s00000000000000ff".to_owned()),
            None,
        );
        assert_eq!(registered["sessionId"], "s00000000000000ff");
        assert!(registered.get("sessionFile").is_none());
        assert_eq!(registered["limit"], HISTORY_PAGE_LIMIT);
        assert!(
            registered.get("cursor").is_none(),
            "the first page has no cursor"
        );

        let child = page_command(
            &HistoryTarget::File("D:/store/sessions/parent/a7f3c1.jsonl".to_owned()),
            Some("c1"),
        );
        assert_eq!(
            child["sessionFile"],
            "D:/store/sessions/parent/a7f3c1.jsonl"
        );
        assert!(
            child.get("sessionId").is_none(),
            "a file-addressed page carries no id for the host to look up"
        );
        assert_eq!(child["cursor"], "c1");
        assert_eq!(child["limit"], HISTORY_PAGE_LIMIT);
        // Both spellings name the same command: only the address differs.
        assert_eq!(registered["type"], child["type"]);
    }
}

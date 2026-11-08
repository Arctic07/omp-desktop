use tauri::State;

use crate::errors::{IpcError, INVALID_INPUT, STORE_UNAVAILABLE};
use crate::models::agent::{
    AbortOutcome, ChatAttachmentRef, ForceStopOutcome, HistoryChunk, SessionBranch,
    SessionBranchFrom, SessionBranchPoints, SessionChildren, SessionColdStatus, SessionHistory,
    SessionOrderEntry, SessionReadMark, SessionRewind, SessionSearchHit, SessionSearchSnippet,
    SessionSummary, SessionView, StopJobOutcome, UiResponse,
};
use crate::services::log;
use crate::services::paths::normalize_for_compare;
use crate::services::runtime::{history_read, session};
use crate::services::session_index;
use crate::services::store;
use crate::state::AppState;

#[tauri::command]
pub(crate) async fn session_list(
    state: State<'_, AppState>,
    workspace_id: i64,
) -> Result<Vec<SessionSummary>, IpcError> {
    let project = state.store.get_project(workspace_id).await?;
    // The flags are the user's decisions about rows (`store::session_flags`), and the scan is a
    // read of what is on disk: neither knows about the other, so the list command is where the two
    // meet. One read answers every row of this workspace.
    let flags = state.store.session_flags().await?;
    let sessions_root = state.paths.host_sessions.clone();
    let cache = state.session_index.clone();
    let root_path = project.root_path;
    let mut sessions = tauri::async_runtime::spawn_blocking(move || {
        session_index::list_sessions(&sessions_root, &root_path, &cache)
    })
    .await
    .map_err(|_| IpcError::new(STORE_UNAVAILABLE, "The session index task failed."))?;
    for row in &mut sessions {
        if let Some(flag) = flags.get(&row.id) {
            row.pinned = flag.pinned;
            row.archived = flag.archived;
        }
    }
    Ok(sessions)
}

/// Conversations whose own words mention `query`, best first.
///
/// The read is the projection's (`services::session_index::Projection::search`): text the index pass
/// stored while it walked each transcript, so a search costs the index rather than the store. Three
/// things the projection cannot know are settled here:
///
/// - **Which workspace a hit belongs to.** A transcript's header names a working directory and the
///   registry names roots; the two are compared the way every other root comparison in this crate
///   is (`normalize_for_compare`), and a hit that matches no registered root is answered without a
///   `workspaceId` rather than being attributed to whichever workspace happened to be active.
/// - **Which conversations the reader put away.** Archived rows are the user's decision
///   (`store::session_flags`) and the rail hides them, so a search that offered them would conflict
///   with the list the reader is looking at.
/// - **Order.** The projection ranks by how often a conversation says the thing; the rows are shown
///   newest first, which is the order the rail itself is in.
#[tauri::command]
pub(crate) async fn session_search(
    state: State<'_, AppState>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<SessionSearchHit>, IpcError> {
    /// Rows one search may answer. A field asks for a handful; anything beyond this is a list to
    /// scroll, which is what the rail is for.
    const MAX_HITS: u32 = 50;
    let limit = limit.unwrap_or(20).clamp(1, MAX_HITS) as usize;
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let cache = std::sync::Arc::clone(&state.session_index);
    let rows = tauri::async_runtime::spawn_blocking(move || cache.search(&query, limit))
        .await
        .map_err(|_| IpcError::new(STORE_UNAVAILABLE, "The search task failed."))?;
    let projects = state.store.list_projects().await?;
    let flags = state.store.session_flags().await?;
    let mut hits: Vec<SessionSearchHit> = rows
        .into_iter()
        .filter(|row| {
            // Archived conversations are hidden, for the same reason the rail hides them.
            !flags.get(&row.summary.id).is_some_and(|flag| flag.archived)
        })
        .map(|row| {
            let cwd_key = normalize_for_compare(std::path::Path::new(&row.summary.cwd));
            let workspace_id = projects
                .iter()
                .find(|project| {
                    normalize_for_compare(std::path::Path::new(&project.root_path)) == cwd_key
                })
                .map(|project| project.id);
            SessionSearchHit {
                session_id: row.summary.id,
                file_path: row.summary.file_path,
                title: row.summary.title,
                cwd: row.summary.cwd,
                workspace_id,
                updated_at: row.summary.updated_at,
                match_count: row.hit.matches,
                snippets: row
                    .hit
                    .snippets
                    .into_iter()
                    .map(|snippet| SessionSearchSnippet {
                        seq: snippet.seq,
                        role: snippet.role,
                        text: snippet.text,
                    })
                    .collect(),
            }
        })
        .collect();
    hits.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    Ok(hits)
}

/// The subagents of one conversation, for the header's own list: the engine writes each subagent's
/// transcript into a directory named after the session that spawned it, so this read is the
/// directory beside the session file the caller names.
///
/// `session_id` is how the caller names the conversation it is asking about; the read follows the
/// file, and the two are not checked against each other - a header may well be listing a
/// conversation's subagents while a child of it is the session on screen.
#[tauri::command]
pub(crate) async fn session_children(
    state: State<'_, AppState>,
    session_id: String,
    session_file: String,
) -> Result<SessionChildren, IpcError> {
    let sessions_dir = state.paths.canonical_dir(&state.paths.host_sessions);
    let cache = state.session_index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        session_index::children_of(&sessions_dir, &session_file, &cache)
    })
    .await
    .map_err(|_| {
        IpcError::from_message(
            STORE_UNAVAILABLE,
            format!("Listing the subagents of session {session_id} failed."),
        )
    })?
}

#[tauri::command]
pub(crate) async fn session_open(
    state: State<'_, AppState>,
    workspace_id: i64,
    session_file: Option<String>,
) -> Result<SessionView, IpcError> {
    session::open(&state.runtime, &state.store, workspace_id, session_file).await
}

/// Detaches the UI from the session. The engine keeps serving it - including a turn that is
/// still running - so switching back rejoins the same stream.
///
/// `drop_file` is for the conversation the workspace opened for an empty composer: it holds
/// nothing, so letting it go takes its file with it rather than leaving a row nothing can open.
/// A caller that has not established that must leave it false - a transcript is never discarded
/// by a screen moving on - and the host checks the claim against the file anyway, keeping a
/// transcript that holds a message (`host/src/session-files.ts`).
#[tauri::command]
pub(crate) async fn session_close(
    state: State<'_, AppState>,
    session_id: String,
    drop_file: Option<bool>,
) -> Result<(), IpcError> {
    session::close(&state.runtime, &session_id, drop_file.unwrap_or(false)).await
}

/// Deletes one conversation: the host removes its transcript and the artifacts of its subagents
/// from the engine's session directory, and this app drops the rows it kept about it.
///
/// `session_file` is what the host deletes - most conversations a user removes were never opened
/// here, so the command names the file the row stands for; `session_id` is the id this app's own
/// rows are keyed by. The service checks the two against each other before anything is removed.
///
/// A conversation that is still working is refused (`session_busy`): the caller stops it first,
/// which is what the desktop's confirmation says it will do.
#[tauri::command]
pub(crate) async fn session_delete(
    state: State<'_, AppState>,
    session_id: String,
    session_file: String,
) -> Result<(), IpcError> {
    session::delete(&state.runtime, &state.store, &session_id, &session_file).await
}

/// Tells the bridge whether the reader has one conversation on screen.
///
/// A conversation on screen streams at the display cadence; one the reader has left is coalesced
/// over a wider window, so several parallel conversations no longer cost the webview an event per
/// frame each. The answer says whether the conversation is still open here - `false` means the host
/// no longer holds it (an eviction, a restart), which is what a warm record checks on return.
#[tauri::command]
pub(crate) fn session_watch(state: State<'_, AppState>, session_id: String, watched: bool) -> bool {
    session::watch(&state.runtime, &session_id, watched)
}

/// Tells the bridge whether a screen has one subagent's transcript open.
///
/// A child's own events are projected only for a tab that is drawing them (`state/subagent-view.ts`
/// sends this on open and close). Nothing else changes: the parent's roster still reports the
/// child, and opening the tab later reads the transcript from disk and follows it from there.
#[tauri::command]
pub(crate) fn child_watch(state: State<'_, AppState>, session_id: String, watched: bool) {
    state.runtime.watch_child(&session_id, watched);
}

/// Reads the whole transcript of a session in one call: the host walks the engine's pages and
/// reports how far it is through them on `on_chunk`, so a conversation open costs one IPC round
/// trip instead of one per page.
///
/// `session_file` is for a transcript that is not a session this process has open: a subagent is
/// never opened as one (the desktop attaches to its channel instead), so it has no id the host
/// would resolve - the file it is stored in is the only address it has. The two are exclusive, and
/// the service enforces that.
///
/// `include_task_prompt` is the caller saying the transcript is a subagent's, whose opening user
/// message is the assignment its `task` call handed it: the ordinary mapping hides engine-authored
/// user messages, and that one is exactly what a reader opening the child's conversation came to
/// read (`history::normalize_subagent_messages`).
///
/// `stream_rows` asks for the rows on the channel as they become final, one bounded page at a time,
/// so a surface that paints the conversation as it opens does not have to wait for the whole
/// transcript to be one payload. The answer carries every row either way.
#[tauri::command]
pub(crate) async fn session_history(
    state: State<'_, AppState>,
    session_id: String,
    session_file: Option<String>,
    include_task_prompt: Option<bool>,
    stream_rows: Option<bool>,
    on_chunk: tauri::ipc::Channel<HistoryChunk>,
) -> Result<SessionHistory, IpcError> {
    let mut lost = false;
    history_read::history(
        &state.runtime,
        &session_id,
        session_file.as_deref(),
        include_task_prompt.unwrap_or(false),
        stream_rows.unwrap_or(false),
        Some(std::sync::Arc::clone(&state.session_index)),
        |chunk| {
            // A closed channel means the frontend is gone, not that the read has to stop: the
            // session is being read for whatever asks next, so the walk finishes and only the
            // reporting stops.
            if on_chunk.send(chunk).is_err() && !lost {
                lost = true;
                log::warn("omp: the history channel is closed; the read goes on");
            }
        },
    )
    .await
}

/// Sends one user message. `streaming_behavior` is `"steer"` when the message has to be
/// injected into the turn the engine is running; while a turn is running, `None` is rejected,
/// because the caller must state what should happen to the message the user just sent.
#[tauri::command]
pub(crate) async fn session_prompt(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    attachments: Vec<ChatAttachmentRef>,
    streaming_behavior: Option<String>,
) -> Result<(), IpcError> {
    if session_id.trim().is_empty() {
        return Err(IpcError::new(INVALID_INPUT, "A session id is required."));
    }
    session::prompt(
        &state.runtime,
        &session_id,
        text,
        attachments,
        streaming_behavior,
    )
    .await
}

#[tauri::command]
pub(crate) async fn session_abort(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<AbortOutcome, IpcError> {
    session::abort(&state.runtime, &session_id).await
}

/// The last resort behind `session_abort`: stops a conversation whose ordinary stop was not enough,
/// and reports what the host had to take down to do it.
///
/// The caller reaches for this only after a plain stop left the session reading busy, so the answer
/// names the transcript the host left behind and the counts a stop reports - the screen can then say
/// the conversation was reset rather than pretending the turn quietly ended.
#[tauri::command]
pub(crate) async fn session_force_stop(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<ForceStopOutcome, IpcError> {
    session::force_stop(&state.runtime, &session_id).await
}

/// One background job's own stop: the roster row the user pressed, rather than every job of the
/// conversation.
///
/// The id is the one the state frame published, and the host refuses an id belonging to another
/// conversation - which is why this is a command rather than something the screen could decide.
/// `stopped:false` is an answer, not a failure: the job had already settled.
#[tauri::command]
pub(crate) async fn session_stop_job(
    state: State<'_, AppState>,
    session_id: String,
    job_id: String,
) -> Result<StopJobOutcome, IpcError> {
    session::stop_job(&state.runtime, &session_id, &job_id).await
}

#[tauri::command]
pub(crate) async fn session_set_model(
    state: State<'_, AppState>,
    session_id: String,
    provider: String,
    model_id: String,
) -> Result<(), IpcError> {
    session::set_model(&state.runtime, &session_id, provider, model_id).await
}

#[tauri::command]
pub(crate) async fn session_set_thinking(
    state: State<'_, AppState>,
    session_id: String,
    level: String,
) -> Result<(), IpcError> {
    session::set_thinking(&state.runtime, &session_id, level).await
}

#[tauri::command]
pub(crate) async fn session_rename(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> Result<(), IpcError> {
    session::rename(&state.runtime, &session_id, name).await
}

#[tauri::command]
pub(crate) async fn session_ui_respond(
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
    response: UiResponse,
) -> Result<(), IpcError> {
    session::ui_respond(&state.runtime, &session_id, request_id, response).await
}

/// The messages this conversation can be branched from, oldest first: the rows the branch picker
/// draws. Read through the engine's own branch, so a message on a path this session already left is
/// not offered as a point to continue from.
#[tauri::command]
pub(crate) async fn session_branch_points(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionBranchPoints, IpcError> {
    session::branch_points(&state.runtime, &session_id).await
}

/// Branches one conversation at a user message: the engine rewrites the open session onto a new
/// file continuing from before that message, and this process follows it to the new identity.
///
/// The answer names the new session and carries the message's own text and inline images, which the
/// surface offers back as a draft - the point of branching is to say it differently, and retyping it
/// is not that. The conversation that was left keeps its transcript and comes back as an ordinary
/// row of the session list.
#[tauri::command]
pub(crate) async fn session_branch(
    state: State<'_, AppState>,
    session_id: String,
    entry_id: String,
) -> Result<SessionBranch, IpcError> {
    session::branch(&state.runtime, &session_id, &entry_id).await
}

/// Takes a conversation back to just before one of its user messages, in place.
///
/// The conversation keeps its id, its file and its row: only its active branch ends earlier, and
/// the message's own text comes back for the composer. The row is addressed either by its entry id
/// (a transcript read) or by the engine's message timestamp (a row the live stream wrote), which
/// the host resolves.
#[tauri::command]
pub(crate) async fn session_rewind(
    state: State<'_, AppState>,
    session_id: String,
    entry_id: Option<String>,
    at: Option<i64>,
) -> Result<SessionRewind, IpcError> {
    session::rewind(&state.runtime, &session_id, entry_id.as_deref(), at).await
}

/// Starts a conversation of its own that continues from an entry inside this one.
///
/// This is what a reader asks for when the point they picked is a turn's output rather than a
/// message of their own to rewrite: the conversation they were reading keeps every message it had,
/// and a second conversation appears, ending where they pointed — nothing is re-sent, so no draft
/// comes back with it.
#[tauri::command]
pub(crate) async fn session_branch_from(
    state: State<'_, AppState>,
    session_id: String,
    entry_id: String,
) -> Result<SessionBranchFrom, IpcError> {
    session::branch_from(&state.runtime, &session_id, &entry_id).await
}

/// Longest session id this app stores. Real ids are the host's `s<16 hex>`, so the bound is only
/// there to keep a hostile or buggy caller from filling the table with something enormous.
const SESSION_ID_LIMIT_CHARS: usize = 128;

/// The cold statuses the user has already read, newest first. The engine writes a session's status
/// (and only it writes session files); which of those statuses have been seen is this app's own
/// fact, so it is kept in the app's store and survives a restart.
#[tauri::command]
pub(crate) async fn session_read_marks(
    state: State<'_, AppState>,
) -> Result<Vec<SessionReadMark>, IpcError> {
    state.store.session_read_marks().await
}

/// Records one session's cold status as read, so the row's mark stays spent after a restart. The
/// status is the engine's vocabulary, so an unknown word is refused here instead of being stored
/// as a row nothing can read.
#[tauri::command]
pub(crate) async fn session_mark_read(
    state: State<'_, AppState>,
    session_id: String,
    status: String,
) -> Result<(), IpcError> {
    let session_id = validate_session_id(&session_id)?;
    let status = SessionColdStatus::from_wire(status.trim()).ok_or_else(|| {
        IpcError::new(
            INVALID_INPUT,
            "The session status is not one this app knows.",
        )
    })?;
    state.store.set_session_read_mark(&session_id, status).await
}

/// Pins one conversation to the top of its workspace's list, or unpins it.
///
/// The decision is this app's own - a session file has no slot for it - so it is stored in the app
/// store and merged into the next `session_list`. The id is the one the rail routes the row by;
/// the caller does not name a workspace because the row already has one, and the flag follows the
/// conversation rather than the list it happens to be read in.
#[tauri::command]
pub(crate) async fn session_set_pinned(
    state: State<'_, AppState>,
    session_id: String,
    pinned: bool,
) -> Result<(), IpcError> {
    let session_id = validate_session_id(&session_id)?;
    state.store.set_session_pinned(&session_id, pinned).await
}

/// Puts one conversation away (`archived: true`) or brings it back into the list.
///
/// Like the pin, this is a decision about a row, not about the engine's file: the transcript stays
/// where it is, the conversation stays open if it was, and the list command is what lets the rail
/// leave the row out until the reader asks for the archived ones.
#[tauri::command]
pub(crate) async fn session_set_archived(
    state: State<'_, AppState>,
    session_id: String,
    archived: bool,
) -> Result<(), IpcError> {
    let session_id = validate_session_id(&session_id)?;
    state
        .store
        .set_session_archived(&session_id, archived)
        .await
}

/// How many conversations one arrangement may name: the rows of one workspace's list, and a bound
/// on what a webview can ask the store to write.
const SESSION_ORDER_LIMIT: usize = 5000;

/// The preference key one workspace's manual conversation order lives under.
///
/// The order is a preference rather than a per-session flag: it says how a list is arranged, not
/// something about one conversation, and a row the list no longer holds is simply absent from it.
/// Keyed by the registry id, which is stable for the workspace's life (`projects` revives the same
/// row when a removed root is registered again).
fn session_order_key(workspace_id: i64) -> String {
    format!("rail.session_order.{workspace_id}")
}

/// The conversations of one workspace, in the order the reader dragged them into.
///
/// A workspace that was never rearranged has no stored order and answers empty: the rail then draws
/// the list by recency, which is the order it has always had. A stored value this build cannot read
/// answers the same way - the arrangement is a preference, and losing it costs the reader nothing
/// but a drag.
#[tauri::command]
pub(crate) async fn session_order_get(
    state: State<'_, AppState>,
    workspace_id: i64,
) -> Result<Vec<SessionOrderEntry>, IpcError> {
    let stored = state
        .store
        .get_preference(&session_order_key(workspace_id))
        .await?;
    Ok(stored
        .as_deref()
        .and_then(|value| serde_json::from_str::<Vec<SessionOrderEntry>>(value).ok())
        .unwrap_or_default())
}

/// Records the order the reader dragged one workspace's conversations into.
///
/// The list is the whole arrangement, not the row that moved: an order that named only the moved
/// row could not say where it moved to, and each entry carries the row's own last-write time so a
/// conversation written afterwards sorts by recency again instead of staying frozen in place. The
/// workspace has to be registered - an order stored under an id nobody can name would be a
/// preference about no list - and every id is validated like any other session id, because the
/// stored value is read back into the rail's rows.
#[tauri::command]
pub(crate) async fn session_order_set(
    state: State<'_, AppState>,
    workspace_id: i64,
    entries: Vec<SessionOrderEntry>,
) -> Result<(), IpcError> {
    if entries.len() > SESSION_ORDER_LIMIT {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The conversation order is too long.",
        ));
    }
    let mut placed = Vec::with_capacity(entries.len());
    for entry in entries {
        placed.push(SessionOrderEntry {
            id: validate_session_id(&entry.id)?,
            at: entry.at,
        });
    }
    state.store.get_project(workspace_id).await?;
    let value = serde_json::to_string(&placed).map_err(|_| {
        IpcError::new(
            STORE_UNAVAILABLE,
            "The conversation order could not be stored.",
        )
    })?;
    state
        .store
        .set_preference(&session_order_key(workspace_id), &value, store::now_ms())
        .await
}

/// Stored ids are used as a primary key and rendered back to a list, so a blank or control-laden
/// id is refused rather than trimmed into a row of its own.
fn validate_session_id(value: &str) -> Result<String, IpcError> {
    let id = value.trim();
    if id.is_empty() {
        return Err(IpcError::new(INVALID_INPUT, "A session id is required."));
    }
    if id.chars().count() > SESSION_ID_LIMIT_CHARS || id.chars().any(char::is_control) {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The session id is too long or contains control characters.",
        ));
    }
    Ok(id.to_owned())
}

//! The session-facing side of the host: opening conversations, sending turns, and reading state.
//!
//! Nothing here holds a process. One host serves every conversation, a command names the
//! conversation it belongs to (`sessionId`), and opening a conversation never interrupts another
//! one - which is what makes two sessions stream side by side.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::errors::{
    IpcError, IpcResult, BRANCH_CANCELLED, ENGINE_PROTOCOL, FRAME_TOO_LARGE, INVALID_INPUT,
    INVALID_SESSION_PATH, PROMPT_TOO_LARGE, SESSION_NOT_FOUND, WORKSPACE_NOT_FOUND,
};
use crate::models::agent::{
    AbortOutcome, ChatAttachmentRef, ForceStopOutcome, SessionBranch, SessionBranchFrom,
    SessionBranchPoints, SessionRewind, SessionView, StopJobOutcome, UiResponse,
};
use crate::services::attachment_mentions::mention_line;
use crate::services::paths::{is_within, plain_path};
use crate::services::runtime::host::response_data;
use crate::services::runtime::host::session::{self, SessionRuntime};
use crate::services::runtime::host::HostRuntime;
use crate::services::runtime::{approval, ui, CONNECT_TIMEOUT_MS, PROMPT_LIMIT_BYTES};
use crate::services::session_index;
use crate::services::store::Store;

const ATTACHMENT_LIMIT_BYTES: u64 = 32 * 1024 * 1024;
const RENAME_LIMIT_CHARS: usize = 200;
/// Selectors this command accepts. `auto` is the user-facing word for "let the engine decide";
/// the engine's own enum spells that `inherit` (it has no `auto`), so the two differ by design.
const THINKING_LEVELS: &[&str] = &[
    "auto", "inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max",
];
/// Streaming behaviours the host accepts for a message that arrives mid-turn.
const STREAMING_BEHAVIORS: &[&str] = &["steer", "followUp", "aside"];

/// Maps a user-facing selector onto the engine's enum. The engine rejects `auto`, and a rejected
/// level is never remembered, so the translation has to happen here - the frontend and the stored
/// preference keep speaking `auto`.
fn engine_thinking_level(level: &str) -> IpcResult<&str> {
    match level {
        "auto" => Ok("inherit"),
        other if THINKING_LEVELS.contains(&other) => Ok(other),
        _ => Err(IpcError::new(INVALID_INPUT, "Unknown thinking level.")),
    }
}

/// The session this command belongs to, or the error every session command reports for a
/// conversation that is no longer open.
pub(crate) fn require_session(
    host: &HostRuntime,
    session_id: &str,
) -> IpcResult<Arc<SessionRuntime>> {
    host.session(session_id)
        .ok_or_else(|| IpcError::new(SESSION_NOT_FOUND, "This session is no longer open."))
}

/// Makes sure the one host is running and past its handshake. Idempotent.
///
/// The workspace argument the frontend sends is accepted and ignored: one host serves every
/// workspace, and a conversation's working directory comes from `session_open`, not from a
/// preheated process.
pub(crate) async fn warm(host: &HostRuntime) -> IpcResult<()> {
    host.ensure_running().await?;
    approval::converge(host).await;
    Ok(())
}

/// Opens one conversation, or re-attaches to the session the host already serves.
///
/// A conversation that is already open may well be mid-turn, and that turn belongs to the user:
/// re-attaching therefore only reads the state back and never interrupts the running one.
pub(crate) async fn open(
    host: &HostRuntime,
    store: &Store,
    workspace_id: i64,
    session_file: Option<String>,
) -> IpcResult<SessionView> {
    let project = store.get_project(workspace_id).await?;
    let root = PathBuf::from(&project.root_path);
    if !root.is_dir() {
        return Err(IpcError::new(
            WORKSPACE_NOT_FOUND,
            "The workspace directory is not available.",
        ));
    }
    let session_file = session_file
        .map(|path| validate_session_file(host, &path))
        .transpose()?;
    host.ensure_running().await?;
    let mut command = json!({
        "type": "session_open",
        "cwd": project.root_path,
        "workspaceId": workspace_id,
    });
    if let Some(file) = session_file.as_deref() {
        command["sessionFile"] = json!(file);
    }
    let data = host.call_ok(command, CONNECT_TIMEOUT_MS).await?;
    let session_id = data
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| IpcError::new(ENGINE_PROTOCOL, "The host did not report a session id."))?
        .to_owned();
    let state = data.get("state").cloned().unwrap_or(Value::Null);
    let (session, newly_registered) = match host.session(&session_id) {
        Some(session) => (session, false),
        None => {
            let session = Arc::new(SessionRuntime::new(
                session_id.clone(),
                project.root_path.clone(),
                Some(workspace_id),
                session_file.clone(),
            ));
            host.register_session(session.clone());
            (session, true)
        }
    };
    // The host answers with the file it actually opened, which is what every later lookup
    // compares against - and which has to reach the frontend in the same spelling the session
    // index read off disk.
    if let Some(file) = data.get("sessionFile").and_then(Value::as_str) {
        session.set_file(Some(plain_path(file)));
    }
    // Read once, used twice: the session runtime carries it for the event side, and the view
    // answers with it, because the frontend restores the running turn's row from this fact alone.
    let streaming = state
        .get("isStreaming")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    session.set_streaming(streaming);
    // `session_open` is the resync point for a conversation this process has just started
    // tracking - a new conversation, or one the host rebuilt - and the state it answers with says
    // where that conversation's event numbering stands.
    //
    // A conversation this process already tracks in the same host generation is normally *not*
    // re-anchored: the host keeps counting where it was, so lowering the cursor here would make
    // every frame between the anchor and the live stream look like a loss, and the journal would be
    // projected onto the frontend a second time.
    //
    // The one exception is a host that started counting over: if the host had dropped this
    // conversation and rebuilt it (its LRU eviction), the numbering restarts from 1 while this
    // process still holds the old cursor, and every frame of the rebuilt session's opening would
    // read as a duplicate and be dropped. An anchor *below* the cursor is that case and nothing
    // else - a live frame only ever raises the cursor - so the direction is safe to act on.
    let anchor = state
        .get("seq")
        .and_then(Value::as_u64)
        .map(|seq| seq.saturating_add(1));
    if let Some(anchor) = anchor {
        if newly_registered || anchor < session.expected_seq() {
            session.set_expected_seq(anchor);
        }
    }
    // Emitted *and* answered with: the frame reaches whoever is already listening, and the same
    // snapshot rides the response for the caller that could not be listening yet.
    let projected = session::emit_state(host.app(), &session, &state);

    let (model_provider, model_id) = session::model_of(&state);
    Ok(SessionView {
        session_id,
        workspace_id,
        workspace_root: project.root_path,
        session_file: session.file(),
        title: session::title_of(&state),
        model_provider,
        model_id,
        thinking_level: state
            .get("thinkingLevel")
            .and_then(Value::as_str)
            .map(str::to_owned),
        streaming,
        state: projected,
    })
}

/// Closes one conversation. Idempotent: closing what is not open is not an error.
///
/// The session file is never touched - a conversation closed here stays on disk and can be opened
/// again (see `rules.md#engine-integration-and-data-ownership`: eviction and close never delete a
/// transcript) - unless the caller asks for a draft's file to go with `drop_file`, which only a caller
/// that established the conversation holds nothing may ask for. The host checks that claim against
/// the file and keeps a transcript that holds a message (`host/src/session-files.ts`).
pub(crate) async fn close(host: &HostRuntime, session_id: &str, drop_file: bool) -> IpcResult<()> {
    let Some(session) = host.session(session_id) else {
        return Ok(());
    };
    ui::cancel_all(host, host.app(), &session);
    let mut command = json!({"type": "session_close"});
    if drop_file {
        command["dropFile"] = json!(true);
    }
    if let Err(error) = host
        .call_session_ok(session_id, command, CONNECT_TIMEOUT_MS)
        .await
    {
        // The conversation is gone from this side either way; only the reason is worth a line.
        host.log(&format!(
            "closing session {session_id} failed: {}",
            error.message
        ));
    }
    host.remove_session(session_id);
    Ok(())
}

/// Records whether the reader has one conversation on screen.
///
/// Nothing reaches the engine: this only sets the cadence the bridge delivers that conversation's
/// streamed text at (`events.rs::delivery_window_ms`). It answers whether the conversation is still
/// open here, so a screen returning to one it kept warm learns in the same round trip that the host
/// no longer holds it and can reopen it instead of reading a stream that will never arrive.
pub(crate) fn watch(host: &HostRuntime, session_id: &str, watched: bool) -> bool {
    match host.session(session_id) {
        Some(session) => {
            session.set_watched(watched);
            true
        }
        None => false,
    }
}

/// Deletes one conversation: the host takes its files away, and this app forgets what it kept.
///
/// The pair `(session_id, session_file)` is checked against the host's own derivation instead of
/// being trusted: the id is what this app keys its own rows by (the read marks), the file is what
/// the host deletes, and a caller that mixed two conversations up must not be able to delete a row
/// the user never pointed at.
///
/// The host refuses (`session_busy`) while that conversation is still working, which is the one
/// failure worth reporting rather than retrying: the caller's own stop is what ends that work.
pub(crate) async fn delete(
    host: &HostRuntime,
    store: &Store,
    session_id: &str,
    session_file: &str,
) -> IpcResult<()> {
    if session_id.trim().is_empty() {
        return Err(IpcError::new(INVALID_INPUT, "A session id is required."));
    }
    let file = validate_session_file(host, session_file)?;
    if session_index::host_session_id(Path::new(&file)) != session_id {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The session id and the session file do not belong together.",
        ));
    }
    host.call_ok(
        json!({"type": "session_delete", "sessionFile": file}),
        CONNECT_TIMEOUT_MS,
    )
    .await?;
    after_delete(host, store, session_id).await;
    Ok(())
}

/// What this app forgets once one conversation's files are gone.
///
/// One function for two callers because it is one fact: the desktop's own delete and a plugin's
/// `session.delete` end at the same host frame (`host/src/dispatch.ts`), so the state they leave
/// behind has to be the same one - the registration the host no longer holds, the read mark, and the
/// pin or archive of a file that no longer exists. A plugin's delete is not a lesser delete.
pub(crate) async fn after_delete(host: &HostRuntime, store: &Store, session_id: &str) {
    // The host no longer holds it: keeping the registration would make every later command address
    // a conversation that cannot answer (`call_session_ok` would drop it on the first one anyway).
    host.remove_session(session_id);
    // A mark that could not be dropped is not worth failing a delete that already happened: the row
    // is gone from the list either way, and the id names a file that no longer exists.
    if let Err(error) = store.forget_session_read_mark(session_id).await {
        host.log(&format!(
            "forgetting the read mark of session {session_id} failed: {}",
            error.message
        ));
    }
    // The same for the row's flags: a pin or an archive of a file that no longer exists would be
    // merged into nothing on every later list read, and would draw a stale "pinned" verdict if a
    // future session ever reused the id.
    if let Err(error) = store.forget_session_flags(session_id).await {
        host.log(&format!(
            "forgetting the flags of session {session_id} failed: {}",
            error.message
        ));
    }
}

/// Stops and hands back every conversation of one workspace that is still open here.
///
/// Removing a workspace is not a way to stop work quietly - the desktop's confirmation says the
/// running conversations are stopped - but leaving them open would keep a removed workspace's turns
/// running under a list that no longer shows them, with the host holding their files for it.
///
/// Best-effort per conversation: a stop the engine ignored (or a close that failed) is logged and
/// the removal goes on. What is left behind is at worst a session of a workspace nothing lists,
/// which the host's own eviction takes care of - and the workspace is what the user asked to remove.
/// Answers how many conversations it acted on, for the caller's log line.
pub(crate) async fn release_workspace(host: &HostRuntime, session_ids: &[String]) -> usize {
    let mut released = 0;
    for session_id in session_ids {
        if host.session(session_id).is_none() {
            continue;
        }
        if let Err(error) = abort(host, session_id).await {
            host.log(&format!(
                "stopping session {session_id} before its workspace was removed failed: {}",
                error.message
            ));
        }
        if let Err(error) = close(host, session_id, false).await {
            host.log(&format!(
                "closing session {session_id} before its workspace was removed failed: {}",
                error.message
            ));
        }
        released += 1;
    }
    if released > 0 {
        host.log(&format!(
            "released {released} session(s) with their workspace"
        ));
    }
    released
}

/// Sends one user message to a conversation.
///
/// Whether a message may be sent during a running turn is the host's call: it knows whether the
/// session is streaming, and it answers `session_busy` for a plain prompt while one is
/// (`streamingBehavior` carries the user's decision instead).
pub(crate) async fn prompt(
    host: &HostRuntime,
    session_id: &str,
    text: String,
    attachments: Vec<ChatAttachmentRef>,
    streaming_behavior: Option<String>,
) -> IpcResult<()> {
    let session = require_session(host, session_id)?;
    let behavior = match streaming_behavior.as_deref() {
        None => None,
        Some(value) if STREAMING_BEHAVIORS.contains(&value) => Some(value),
        Some(_) => {
            return Err(IpcError::new(
                INVALID_INPUT,
                "The streaming behaviour must be \"steer\", \"followUp\" or \"aside\".",
            ))
        }
    };
    if text.trim().is_empty() && attachments.is_empty() {
        return Err(IpcError::new(INVALID_INPUT, "The prompt is empty."));
    }
    let message = build_prompt(text, &attachments)?;
    // A new user turn supersedes the turn the host lost, so the mark goes with it.
    session.set_interrupted(false);
    let mut command = json!({"type": "session_prompt", "message": message});
    if let Some(behavior) = behavior {
        command["streamingBehavior"] = json!(behavior);
    }
    let response = host
        .call_prompt_session(session_id, command, CONNECT_TIMEOUT_MS)
        .await
        .map_err(prompt_frame_error)?;
    response_data(&response).map_err(prompt_frame_error)?;
    Ok(())
}

/// The prompt refusal this layer can word better than the frame it came from.
///
/// The engine's ceiling is on the *physical* frame, and a prompt is JSON-encoded on its way out:
/// escaping can push a message that fit `PROMPT_LIMIT_BYTES` past the frame limit - newline- and
/// quote-dense text most of all. The caller asked to send a prompt, so that refusal is answered as
/// the prompt being too large, which names the thing the composer can act on; every other failure
/// travels unchanged.
fn prompt_frame_error(error: IpcError) -> IpcError {
    if error.code == FRAME_TOO_LARGE {
        return IpcError::new(
            PROMPT_TOO_LARGE,
            "The prompt is too large to send as a single command.",
        );
    }
    error
}

pub(crate) async fn abort(host: &HostRuntime, session_id: &str) -> IpcResult<AbortOutcome> {
    require_session(host, session_id)?;
    let command = json!({"type": "session_abort"});
    let data = host
        .call_session_ok(session_id, command, CONNECT_TIMEOUT_MS)
        .await?;
    Ok(project_abort_outcome(&data))
}

/// The last resort behind [`abort`]: asks the host to stop a conversation whose ordinary stop was
/// not enough, and reports what it had to take down.
///
/// The caller reaches for this only after a plain stop left the session reading busy, so the answer
/// carries the transcript the host left behind (`sessionFile`) and the same counts a stop reports -
/// the screen can then say the process was reset rather than a turn that quietly ended.
pub(crate) async fn force_stop(
    host: &HostRuntime,
    session_id: &str,
) -> IpcResult<ForceStopOutcome> {
    require_session(host, session_id)?;
    let command = json!({"type": "session_force_stop"});
    let data = host
        .call_session_ok(session_id, command, CONNECT_TIMEOUT_MS)
        .await?;
    Ok(project_force_stop_outcome(&data))
}

/// One background job's own stop, for the roster the composer draws.
///
/// The job id comes from the state frame the host published, so this is the same work the whole
/// session's stop cancels, narrowed to the one row the user pressed. `stopped:false` is an answer
/// rather than an error - the job had settled, or it belongs to another conversation and the host
/// refused to touch it - and a host that predates the command answers `{}`, which reads the same
/// way: nothing was stopped by this call.
pub(crate) async fn stop_job(
    host: &HostRuntime,
    session_id: &str,
    job_id: &str,
) -> IpcResult<StopJobOutcome> {
    require_session(host, session_id)?;
    let command = json!({"type": "session_stop_job", "jobId": job_id});
    let data = host
        .call_session_ok(session_id, command, CONNECT_TIMEOUT_MS)
        .await?;
    Ok(StopJobOutcome {
        stopped: data
            .get("stopped")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// What a session stop actually stopped, read off the host's answer.
///
/// A host that predates the payload answers `{}`, and every field then reads its honest default:
/// the stop was not confirmed, nothing was counted cancelled, and nothing is named still busy. Only
/// strings are accepted in `remaining`, because it is a list of stable tokens the frontend
/// localizes and any other shape is one this build cannot word.
fn project_abort_outcome(data: &Value) -> AbortOutcome {
    AbortOutcome {
        aborted: data
            .get("aborted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        cancelled_subagents: cancelled_count(data, "cancelledSubagents"),
        cancelled_jobs: cancelled_count(data, "cancelledJobs"),
        remaining: strings(data, "remaining"),
        restored: strings(data, "restored"),
    }
}

/// The non-empty strings of one field of a stop answer.
///
/// Absent (a host that predates the field) and a list of other shapes both read as the fields this
/// build can word: a token or a withdrawn prompt is text, and anything else is dropped rather than
/// rendered as its JSON.
fn strings(data: &Value, field: &str) -> Vec<String> {
    data.get(field)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// What a forced stop did, read off the host's answer under the same tolerant rule as a stop: an
/// older host answers `{}`, and `sessionFile` is taken only when the host named a non-empty one.
fn project_force_stop_outcome(data: &Value) -> ForceStopOutcome {
    ForceStopOutcome {
        forced: data.get("forced").and_then(Value::as_bool).unwrap_or(false),
        cancelled_subagents: cancelled_count(data, "cancelledSubagents"),
        cancelled_jobs: cancelled_count(data, "cancelledJobs"),
        restored: strings(data, "restored"),
        session_file: data
            .get("sessionFile")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
    }
}

/// One cancellation count off a stop answer: absent (an older host) and zero read the same, which
/// is the only honest reading of a count nothing reported.
fn cancelled_count(data: &Value, field: &str) -> usize {
    data.get(field)
        .and_then(Value::as_u64)
        .map_or(0, |count| count as usize)
}

pub(crate) async fn set_model(
    host: &HostRuntime,
    session_id: &str,
    provider: String,
    model_id: String,
) -> IpcResult<()> {
    let session = require_session(host, session_id)?;
    if provider.trim().is_empty() || model_id.trim().is_empty() {
        return Err(IpcError::new(
            INVALID_INPUT,
            "A provider and a model id are required.",
        ));
    }
    let command = json!({"type": "session_set_model", "provider": provider, "modelId": model_id});
    let data = host
        .call_session_ok(session_id, command, CONNECT_TIMEOUT_MS)
        .await?;
    // The answer carries the session's state, so no second round trip is needed to publish it.
    if let Some(state) = data.get("state") {
        session::emit_state(host.app(), &session, state);
    }
    Ok(())
}

pub(crate) async fn set_thinking(
    host: &HostRuntime,
    session_id: &str,
    level: String,
) -> IpcResult<()> {
    let session = require_session(host, session_id)?;
    let level = engine_thinking_level(&level)?;
    let command = json!({"type": "session_set_thinking", "level": level});
    let data = host
        .call_session_ok(session_id, command, CONNECT_TIMEOUT_MS)
        .await?;
    if let Some(state) = data.get("state") {
        session::emit_state(host.app(), &session, state);
    }
    Ok(())
}

pub(crate) async fn rename(host: &HostRuntime, session_id: &str, name: String) -> IpcResult<()> {
    require_session(host, session_id)?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > RENAME_LIMIT_CHARS {
        return Err(IpcError::new(
            INVALID_INPUT,
            "A session name between 1 and 200 characters is required.",
        ));
    }
    let command = json!({"type": "session_set_name", "name": name});
    host.call_session_ok(session_id, command, CONNECT_TIMEOUT_MS)
        .await?;
    Ok(())
}

pub(crate) async fn ui_respond(
    host: &HostRuntime,
    session_id: &str,
    request_id: String,
    response: UiResponse,
) -> IpcResult<()> {
    let session = require_session(host, session_id)?;
    ui::respond(host, &session, &request_id, &response).await
}

/// The messages one conversation can branch from, newest last.
///
/// A read, not a gate: it is asked while the conversation is being looked at, and a running turn
/// does not change where its user messages are.
pub(crate) async fn branch_points(
    host: &HostRuntime,
    session_id: &str,
) -> IpcResult<SessionBranchPoints> {
    require_session(host, session_id)?;
    let command = json!({"type": "session_branch_points"});
    let data = host
        .call_session_ok(session_id, command, CONNECT_TIMEOUT_MS)
        .await?;
    serde_json::from_value(data).map_err(|_| {
        IpcError::new(
            ENGINE_PROTOCOL,
            "The host reported branch points in a shape this app does not know.",
        )
    })
}

/// Branches one conversation at a user message: the engine rewrites the open session onto a new
/// file, and this process follows it there.
///
/// The id is the digest of the session's file, so a branch renames the conversation as far as this
/// side is concerned: the old registration is dropped (it names a file the host no longer serves
/// as a live session) and the new one is registered with the identity the host answered, anchored
/// to the state the answer carried so the frames after it continue the same stream. The old
/// transcript is untouched on disk and comes back as an ordinary row of the session list.
pub(crate) async fn branch(
    host: &HostRuntime,
    session_id: &str,
    entry_id: &str,
) -> IpcResult<SessionBranch> {
    if entry_id.trim().is_empty() {
        return Err(IpcError::new(INVALID_INPUT, "A branch point is required."));
    }
    follow_branch(
        host,
        session_id,
        json!({"type": "session_branch", "entryId": entry_id}),
        "The branch was cancelled before the conversation was rewritten.",
    )
    .await
}

/// Takes a conversation back to just before one of its user messages, in place.
///
/// The rewrite stays on the conversation's own file: the engine moves its active branch to end
/// before the message, and the entries after it stay in the file as an off-branch sibling. So this
/// process's registration, its id, its title and its row in the list are all unchanged, and there
/// is nothing to re-register or re-open. The answer carries the message's own text for the
/// composer.
///
/// The row is addressed either by its entry id (a transcript read) or by the engine's message
/// timestamp (a row the live stream wrote), which the host resolves.
///
/// A rewind is not a file restore: what the engine moves is the conversation, and a working tree is
/// not part of it (`docs/tree.md` upstream). The surface says so where the reader confirms it.
pub(crate) async fn rewind(
    host: &HostRuntime,
    session_id: &str,
    entry_id: Option<&str>,
    at: Option<i64>,
) -> IpcResult<SessionRewind> {
    let mut command = json!({"type": "session_rewind"});
    if let Some(entry_id) = entry_id.filter(|value| !value.trim().is_empty()) {
        command["entryId"] = json!(entry_id);
    }
    if let Some(at) = at {
        command["at"] = json!(at);
    }
    if command.get("entryId").is_none() && command.get("at").is_none() {
        return Err(IpcError::new(
            INVALID_INPUT,
            "A message to rewind to is required.",
        ));
    }
    require_session(host, session_id)?;
    let data = host
        .call_session_ok(session_id, command, CONNECT_TIMEOUT_MS)
        .await?;
    if data.get("cancelled").and_then(Value::as_bool) == Some(true) {
        return Err(IpcError::new(
            BRANCH_CANCELLED,
            "The rewind was cancelled before the conversation was rewritten.",
        ));
    }
    // An in-place rewrite answers with the conversation it was asked about. A different id would
    // mean the host moved the session, which is the branch this command no longer asks for - and
    // following it here would leave the registration pointing at nothing.
    let answered_id = nonempty_string(&data, "sessionId")?;
    if answered_id != session_id {
        return Err(IpcError::new(
            ENGINE_PROTOCOL,
            "The host moved a rewound conversation onto another session.",
        ));
    }
    let text = data
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Ok(SessionRewind {
        session_id: answered_id,
        text,
    })
}

/// Sends one branch-shaped command and follows the conversation onto the file it names.
///
/// The id is the digest of the session's file, so a branch renames the conversation as far as this
/// side is concerned: the old registration is dropped (it names a file the host no longer serves
/// as a live session) and the new one is registered with the identity the host answered, anchored
/// to the state the answer carried so the frames after it continue the same stream. The old
/// transcript is untouched on disk and comes back as an ordinary row of the session list.
async fn follow_branch(
    host: &HostRuntime,
    session_id: &str,
    command: Value,
    cancelled: &'static str,
) -> IpcResult<SessionBranch> {
    let session = require_session(host, session_id)?;
    let data = host
        .call_session_ok(session_id, command, CONNECT_TIMEOUT_MS)
        .await?;
    if data.get("cancelled").and_then(Value::as_bool) == Some(true) {
        return Err(IpcError::new(BRANCH_CANCELLED, cancelled));
    }
    let new_id = nonempty_string(&data, "sessionId")?;
    let new_file = nonempty_string(&data, "sessionFile")?;
    let previous_file = nonempty_string(&data, "previousSessionFile")?;
    let text = data
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if new_id == session_id {
        return Err(IpcError::new(
            ENGINE_PROTOCOL,
            "The host branched a session onto its own file.",
        ));
    }

    // The conversation moved: this process's old registration names a file no longer served as a
    // live session, and every later command for it would be addressed to nothing.
    host.remove_session(session_id);
    let branched = Arc::new(SessionRuntime::new(
        new_id.clone(),
        session.cwd().to_owned(),
        session.workspace_id(),
        Some(new_file.clone()),
    ));
    // The turn is over by construction: the host refuses a branch while one runs. The branch
    // itself is the only thing that produced frames so far, and they were addressed to the file
    // this process had not registered yet, so the state below is where the reading starts.
    if let Some(state) = data.get("state") {
        if let Some(seq) = state.get("seq").and_then(Value::as_u64) {
            branched.set_expected_seq(seq.saturating_add(1));
            session::emit_state(host.app(), &branched, state);
        }
    }
    host.register_session(branched);

    Ok(SessionBranch {
        session_id: new_id,
        session_file: new_file,
        previous_session_file: previous_file,
        text,
    })
}

/// Starts a conversation of its own that continues from an entry inside this one.
///
/// The engine moves the leaf onto that entry and forks the session into a file of its own, so the
/// conversation the user was reading keeps every message it had and a second conversation appears,
/// ending where they pointed. The session's address changes with its file, which is why this
/// re-registers the way a branch does.
pub(crate) async fn branch_from(
    host: &HostRuntime,
    session_id: &str,
    entry_id: &str,
) -> IpcResult<SessionBranchFrom> {
    let session = require_session(host, session_id)?;
    if entry_id.trim().is_empty() {
        return Err(IpcError::new(
            INVALID_INPUT,
            "A point to continue from is required.",
        ));
    }
    let command = json!({"type": "session_branch_from", "entryId": entry_id});
    let data = host
        .call_session_ok(session_id, command, CONNECT_TIMEOUT_MS)
        .await?;
    if data.get("cancelled").and_then(Value::as_bool) == Some(true) {
        return Err(IpcError::new(
            BRANCH_CANCELLED,
            "The branch was cancelled before the conversation was copied.",
        ));
    }
    let new_id = nonempty_string(&data, "sessionId")?;
    let new_file = nonempty_string(&data, "sessionFile")?;
    let previous_file = nonempty_string(&data, "previousSessionFile")?;
    if new_id == session_id {
        return Err(IpcError::new(
            ENGINE_PROTOCOL,
            "The host branched a session onto its own file.",
        ));
    }

    // The conversation moved: this process's old registration names a file no longer served as a
    // live session, and every later command for it would be addressed to nothing.
    host.remove_session(session_id);
    let branched = Arc::new(SessionRuntime::new(
        new_id.clone(),
        session.cwd().to_owned(),
        session.workspace_id(),
        Some(new_file.clone()),
    ));
    if let Some(state) = data.get("state") {
        if let Some(seq) = state.get("seq").and_then(Value::as_u64) {
            branched.set_expected_seq(seq.saturating_add(1));
            session::emit_state(host.app(), &branched, state);
        }
    }
    host.register_session(branched);

    Ok(SessionBranchFrom {
        session_id: new_id,
        session_file: new_file,
        previous_session_file: previous_file,
    })
}

/// One non-empty string field of a host answer, or the protocol failure that says it was missing.
fn nonempty_string(data: &Value, field: &str) -> IpcResult<String> {
    data.get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            IpcError::from_message(
                ENGINE_PROTOCOL,
                format!("The host did not report the branch's {field}."),
            )
        })
}

/// Attachments are passed by reference: the engine reads a file mention from the path this message
/// carries, and a tool that edits it writes that same path — so the reference names the file the
/// user attached, wherever it lives, and never a copy of it. The scratch copies a paste produces
/// are ordinary files to this check.
///
/// The renderer's paths are still re-validated here: a reference must be an absolute path to a
/// file that exists and is small enough to read into a model's context. What this command cannot
/// attest is provenance — a path arrives from the renderer exactly as `import_composer_files`
/// receives it — so the boundary it keeps is about shape and budget, not about which files the
/// user was shown.
fn build_prompt(text: String, attachments: &[ChatAttachmentRef]) -> IpcResult<String> {
    let mut message = text;
    for attachment in attachments {
        if attachment.path.contains(['\n', '\r']) {
            return Err(IpcError::new(
                INVALID_INPUT,
                "An attachment path contains a line break.",
            ));
        }
        let path = PathBuf::from(&attachment.path);
        if !path.is_absolute() {
            return Err(IpcError::new(
                INVALID_INPUT,
                "An attachment path must be absolute.",
            ));
        }
        let metadata = std::fs::metadata(&path).map_err(|_| {
            IpcError::new(INVALID_INPUT, "An attachment file is no longer available.")
        })?;
        if !metadata.is_file() || metadata.len() > ATTACHMENT_LIMIT_BYTES {
            return Err(IpcError::new(
                INVALID_INPUT,
                "An attachment must be a file smaller than 32 MiB.",
            ));
        }
        message.push('\n');
        // The mention is written by the rule that reads it back (`services/attachment_mentions.rs`):
        // a path containing a space is quoted exactly the way the engine's own file selector quotes
        // one, so the mention survives tokenization instead of ending at the first space, and a
        // conversation read recovers the path this line names.
        message.push_str(&mention_line(&attachment.path));
    }
    if message.len() > PROMPT_LIMIT_BYTES {
        return Err(IpcError::new(
            PROMPT_TOO_LARGE,
            "The prompt is too large to send as a single command.",
        ));
    }
    Ok(message)
}

/// Session files are addressed by absolute path; anything outside the host's own session
/// directory is rejected here as well as on the other side of the pipe.
///
/// A file that does not exist yet is the "a new conversation at this path" case, so only its
/// directory has to be inside the store and its extension has to be a session file.
///
/// The frame path shares this gate: a forwarded child event names a subagent's transcript, and only
/// a file inside the engine's session directory can be addressed by one
/// (`host/protocol.rs::on_subagent_event`).
pub(super) fn validate_session_file(host: &HostRuntime, path: &str) -> IpcResult<String> {
    if path.contains(['\n', '\r']) {
        return Err(IpcError::new(INVALID_INPUT, "The session path is invalid."));
    }
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Err(IpcError::new(INVALID_INPUT, "The session path is invalid."));
    }
    // Both sides are canonicalized: `fs::canonicalize` hands back a verbatim path on Windows
    // (and resolves junctions wherever the data root lives), while the session directory comes
    // from the application data root in its plain form.
    let sessions_dir = host.paths().canonical_dir(&host.paths().host_sessions);
    match std::fs::canonicalize(candidate) {
        Ok(canonical) => {
            if !is_within(&sessions_dir, &canonical) {
                return Err(IpcError::new(
                    INVALID_SESSION_PATH,
                    "The session file is outside the engine data directory.",
                ));
            }
            Ok(plain_path(&canonical.to_string_lossy()))
        }
        Err(_) => {
            let parent = candidate
                .parent()
                .ok_or_else(|| IpcError::new(INVALID_INPUT, "The session path is invalid."))?;
            let parent = std::fs::canonicalize(parent).map_err(|_| {
                IpcError::new(
                    SESSION_NOT_FOUND,
                    "The session file is no longer available.",
                )
            })?;
            if !is_within(&sessions_dir, &parent) {
                return Err(IpcError::new(
                    INVALID_SESSION_PATH,
                    "The session file is outside the engine data directory.",
                ));
            }
            if candidate.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                return Err(IpcError::new(
                    INVALID_INPUT,
                    "A session file has to be a `.jsonl` transcript.",
                ));
            }
            Ok(plain_path(path))
        }
    }
}

#[cfg(test)]
mod thinking_level_tests {
    use super::*;

    /// The engine's enum has no `auto`; sending the literal word made it reject the level, and a
    /// rejected level never reached the conversation.
    #[test]
    fn auto_is_sent_as_the_engines_word_for_it() {
        assert_eq!(engine_thinking_level("auto").expect("auto"), "inherit");
        assert_eq!(
            engine_thinking_level("inherit").expect("inherit"),
            "inherit"
        );
        for level in ["off", "minimal", "low", "medium", "high", "xhigh", "max"] {
            assert_eq!(engine_thinking_level(level).expect(level), level);
        }
        assert_eq!(
            engine_thinking_level("bogus").expect_err("bogus").code,
            INVALID_INPUT
        );
    }
}

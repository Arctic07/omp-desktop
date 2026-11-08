//! The agent working in the terminal the user has open: the host's `terminal_request` frames, and
//! the answer that carries what the shell printed back to the tool that asked.
//!
//! This is the lane where the **host is the requester** rather than the answerer: one request in,
//! one answer out, both bounded, and the answer is sent whatever happened. It exists because the
//! capability belongs to this process, while the agent that wants it runs inside the host.
//!
//! **No page is involved**: a terminal is a pty, which is a file-like object this process already
//! holds (`services::terminal`), so the whole round trip is host → this handler → host. The page
//! sees the result the way it sees anything else in a shell: the pty echoes what was typed and the
//! output streams to it as usual.
//!
//! Four actions: `list`, `read`, `write`, and `create`. The last starts a background shell through
//! the same terminal service as the panel, without attaching a UI stream; its ring remains readable
//! by the creating agent and ownership cleanup ends it with the session or workspace.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::errors::{IpcError, IpcResult, INVALID_INPUT, TERMINAL_FAILED, TERMINAL_NOT_FOUND};
use crate::models::{TerminalSummaryDto, TerminalUiEvent};
use crate::services::runtime::host::protocol;
use crate::services::runtime::host::HostRuntime;
use crate::services::terminal;
use crate::state::AppState;

/// How long the host is given to take an answer for one request.
///
/// The application answers out of its own memory - there is no page to wait for and no process to
/// spawn - so this bounds a desktop that is gone rather than slow work. It is deliberately the same
/// number as the tool's own wait (`host/src/tools.ts`): one request is settled within one budget
/// end to end, and a deadline here that outlived the tool's would log a delivery nobody is waiting
/// for.
const ANSWER_TIMEOUT_MS: u64 = 20_000;

/// What one `read` answers with when the caller names no size: a screenful and change.
const DEFAULT_READ_BYTES: usize = 16 * 1024;

/// Handles one `terminal_request` frame.
///
/// The frame is read here and the work is handed to a task of its own: **this handler returns before
/// the answer is delivered**, because the answer is a frame the host sends back and only the inbound
/// loop can receive it (`host/protocol.rs::run` - "nothing in this loop may await a round trip").
/// Awaiting the delivery here is a deadlock: the loop is parked in this handler, the answer sits
/// unread in the pipe, the tool's own 20 s deadline expires, and the health probe that runs on the
/// same loop decides the host is wedged and kills the process tree. That is exactly the shape of
/// the "engine host unresponsive after 3 health probes" reports, so the delivery lives in the task.
///
/// The action is read first and answered with a refusal of its own if it is not recognized, because
/// a request the tool did not mean to send is a fact worth reporting rather than a silent no-op.
pub(super) fn on_terminal_request(host: &HostRuntime, frame: &Value) {
    let Some(session) = protocol::session_of(host, frame) else {
        return;
    };
    let request_id = frame
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let app = host.app().clone();
    let runtime = host.clone();
    let session_id = session.id.clone();
    let task_session_id = session_id.clone();
    let request = frame.clone();
    tauri::async_runtime::spawn(async move {
        let settled = Arc::new(AtomicBool::new(false));
        let task_settled = Arc::clone(&settled);
        let work_app = app.clone();
        let work = tauri::async_runtime::spawn_blocking(move || {
            let outcome = match work_app.try_state::<AppState>() {
                Some(state) => handle(&work_app, &state, &task_session_id, &request),
                None => Err(IpcError::new(
                    TERMINAL_FAILED,
                    "This application has no terminal to work in.",
                )),
            };
            if task_settled.load(Ordering::SeqCst) {
                cleanup_late_create(&work_app, &request, &outcome);
            }
            outcome
        });
        let answer = match tokio::time::timeout(
            Duration::from_millis(ANSWER_TIMEOUT_MS.saturating_sub(250)),
            work,
        )
        .await
        {
            Ok(Ok(outcome)) => {
                if settled.swap(true, Ordering::SeqCst) {
                    runtime.log(&format!(
                        "late terminal response discarded requestId={request_id}"
                    ));
                    return;
                }
                answer_frame(&request_id, &outcome)
            }
            Ok(Err(_)) => {
                if settled.swap(true, Ordering::SeqCst) {
                    return;
                }
                answer_frame(
                    &request_id,
                    &Err(IpcError::new(TERMINAL_FAILED, "Terminal task failed.")),
                )
            }
            Err(_) => {
                if settled.swap(true, Ordering::SeqCst) {
                    return;
                }
                runtime.log(&format!(
                    "terminal request timed out requestId={request_id}"
                ));
                answer_frame(
                    &request_id,
                    &Err(IpcError::new(
                        "TERMINAL_TIMEOUT",
                        "The terminal request timed out.",
                    )),
                )
            }
        };
        deliver(&runtime, &session_id, answer).await;
    });
}

async fn deliver(host: &HostRuntime, session_id: &str, answer: Value) {
    if let Err(error) = host
        .call_session_ok(session_id, answer, ANSWER_TIMEOUT_MS)
        .await
    {
        host.log(&format!(
            "terminal response delivery failed code={} message={}",
            error.code, error.message
        ));
    }
}

/// One request, answered from the terminal service.
///
/// Pure of the host and the wire: it reads the frame's own fields, calls the service, and answers
/// the value the tool resolves with.
fn summary_json(session: terminal::TerminalSummary) -> Value {
    json!({ "id": session.id, "shell": session.shell, "label": session.label, "cwd": session.cwd, "ownerSessionId": session.owner_session_id, "ownerSessionFile": session.owner_session_file, "workspaceKey": session.workspace_key })
}

fn validate_owner_session_file(state: &AppState, file: &str) -> IpcResult<String> {
    if file.len() > 4096 {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The terminal owner session is invalid.",
        ));
    }
    let path = std::path::Path::new(file);
    if !path.is_absolute() {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The terminal owner session is invalid.",
        ));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| IpcError::new(INVALID_INPUT, "The terminal owner session is invalid."))?;
    let root = state.paths.canonical_dir(&state.paths.host_sessions);
    if !crate::services::paths::is_within(&root, &canonical) || canonical == root {
        return Err(IpcError::new(
            INVALID_INPUT,
            "The terminal owner session is invalid.",
        ));
    }
    Ok(crate::services::paths::plain_path(
        &canonical.to_string_lossy(),
    ))
}

fn cleanup_late_create(app: &tauri::AppHandle, frame: &Value, outcome: &IpcResult<Value>) {
    if frame.get("action").and_then(Value::as_str) != Some("create") {
        return;
    }
    let Some(id) = outcome
        .as_ref()
        .ok()
        .and_then(|value| value.get("terminal"))
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
    else {
        return;
    };
    if let Some(state) = app.try_state::<AppState>() {
        let service = state.terminal.clone();
        let id = id.to_owned();
        let _ = service.close(&id);
    }
}

fn handle(
    app: &tauri::AppHandle,
    state: &AppState,
    owner_session_id: &str,
    frame: &Value,
) -> IpcResult<Value> {
    let owner_session_file = frame
        .get("ownerSessionFile")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            IpcError::new(
                INVALID_INPUT,
                "A terminal request needs its owner session file.",
            )
        })?;
    let owner_session_file = validate_owner_session_file(state, owner_session_file)?;
    match frame
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "list" => {
            let cwd = frame
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if cwd.is_empty() {
                return Err(IpcError::new(
                    INVALID_INPUT,
                    "A list request has to name the directory to look in.",
                ));
            }
            // A read is a read: it reports what this conversation has and starts nothing. Creating a
            // shell here used to make "what is open?" a question that changed the answer, and the
            // page could not tell the shell it had just started from one the agent started.
            let summaries: Vec<_> = state.terminal.list(cwd, &owner_session_file);
            Ok(json!({ "terminals": summaries.into_iter().map(summary_json).collect::<Vec<_>>() }))
        }
        "read" => {
            let id = named_terminal(frame)?;
            let limit = frame
                .get("limit")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(DEFAULT_READ_BYTES);
            let text = state.terminal.read(&id, limit).map_err(terminal_error)?;
            Ok(json!({ "terminal": id, "text": text }))
        }
        "write" => {
            let id = named_terminal(frame)?;
            let input = frame
                .get("input")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let mut bytes = input.as_bytes().to_vec();
            // A shell is driven by what a keyboard sends, and the key that runs a line is the
            // carriage return: the pty's own line discipline is what turns it into a newline.
            if frame.get("submit").and_then(Value::as_bool).unwrap_or(true) {
                bytes.push(b'\r');
            }
            state.terminal.write(&id, &bytes).map_err(terminal_error)?;
            Ok(json!({ "terminal": id, "bytes": bytes.len() }))
        }
        "create" => {
            let cwd = frame
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if cwd.is_empty() {
                return Err(IpcError::new(
                    INVALID_INPUT,
                    "A create request has to name the working directory.",
                ));
            }
            let (workspace_key, _) = crate::services::workspaces::canonicalize_workspace(cwd)
                .map_err(|error| IpcError::from_message(INVALID_INPUT, error.message))?;
            let show = terminal_ui_requested(frame);
            let cols = dimension(frame, "cols")?;
            let rows = dimension(frame, "rows")?;
            let sink: Arc<dyn Fn(crate::models::TerminalFrame) -> bool + Send + Sync + 'static> =
                Arc::new(|_| true);
            // A conversation may own several terminals, so `create` adds one unless there is a shell
            // of this conversation that nobody is drawing — the one an earlier `create` started and
            // left in the background. Reusing *that* is what keeps a repeated "open a terminal" from
            // piling up invisible shells; a tab the reader is watching is never taken over.
            let (opened, reused) = state
                .terminal
                .open_for_agent(
                    cwd,
                    owner_session_id,
                    &owner_session_file,
                    &workspace_key,
                    cols,
                    rows,
                    sink,
                )
                .map_err(terminal_error)?;
            if show {
                let summary = TerminalSummaryDto {
                    id: opened.id.clone(),
                    shell: opened.shell.clone(),
                    cwd: opened.cwd.clone(),
                    owner_session_id: opened.owner_session_id.clone(),
                    owner_session_file: opened.owner_session_file.clone(),
                    workspace_key: opened.workspace_key.clone(),
                };
                let _ = app.emit("omp:terminal", TerminalUiEvent::Open { terminal: summary });
            }
            let mut answer = json!({
                "terminal": {
                    "id": opened.id,
                    "shell": opened.shell,
                    "cwd": opened.cwd,
                    "ownerSessionId": opened.owner_session_id,
                    "ownerSessionFile": opened.owner_session_file,
                    "workspaceKey": opened.workspace_key,
                }
            });
            if reused {
                answer["reused"] = json!(true);
            }
            Ok(answer)
        }
        other => Err(IpcError::from_message(
            INVALID_INPUT,
            format!("`{other}` is not an action this terminal takes."),
        )),
    }
}

fn terminal_ui_requested(frame: &Value) -> bool {
    frame
        .get("show")
        .or_else(|| frame.get("openUi"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn dimension(frame: &Value, name: &str) -> IpcResult<u16> {
    let Some(value) = frame.get(name) else {
        return Ok(if name == "rows" { 24 } else { 80 });
    };
    let Some(value) = value.as_u64() else {
        return Err(IpcError::from_message(
            INVALID_INPUT,
            format!("`{name}` must be an integer between 2 and 1000."),
        ));
    };
    if !(terminal::MIN_DIMENSION as u64..=terminal::MAX_DIMENSION as u64).contains(&value) {
        return Err(IpcError::from_message(
            INVALID_INPUT,
            format!("`{name}` must be an integer between 2 and 1000."),
        ));
    }
    Ok(value as u16)
}

/// The terminal one request names, or the refusal a request without one earns.
fn named_terminal(frame: &Value) -> IpcResult<String> {
    let id = frame
        .get("terminal")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if id.is_empty() {
        return Err(IpcError::new(
            INVALID_INPUT,
            "This request has to name the terminal it is about.",
        ));
    }
    Ok(id.to_owned())
}

/// The refusal one service failure earns: a terminal that is gone is a different thing to fix than
/// a pty that would not take the write.
fn terminal_error(message: String) -> IpcError {
    let code = if terminal::is_unknown_session(&message) {
        TERMINAL_NOT_FOUND
    } else {
        TERMINAL_FAILED
    };
    IpcError::from_message(code, message)
}

/// The answer one request gets: `ok` with what the action produced, or the refusal's code and
/// message.
///
/// Pure, so the two branches can be read (and tested) without a session, a window or a pty.
fn answer_frame(request_id: &str, outcome: &IpcResult<Value>) -> Value {
    let mut frame = json!({
        "type": "session_terminal_response",
        "requestId": request_id,
    });
    match outcome {
        Ok(result) => {
            frame["ok"] = json!(true);
            frame["result"] = result.clone();
        }
        Err(error) => {
            frame["ok"] = json!(false);
            frame["code"] = json!(error.code);
            frame["message"] = json!(error.message);
        }
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listed_terminal_is_answered_with_its_own_facts() {
        let frame = answer_frame(
            "terminal-1",
            &Ok(
                json!({ "terminals": [{ "id": "terminal-3", "shell": "PowerShell", "cwd": "D:\\p" }] }),
            ),
        );
        assert_eq!(frame["type"], "session_terminal_response");
        assert_eq!(frame["requestId"], "terminal-1");
        assert_eq!(frame["ok"], true);
        assert_eq!(frame["result"]["terminals"][0]["id"], "terminal-3");
        assert!(frame.get("code").is_none(), "an answer carries no refusal");
    }

    #[test]
    fn a_missing_terminal_is_answered_with_its_own_code() {
        let frame = answer_frame(
            "terminal-2",
            &Err(terminal_error("That terminal is not open.".to_owned())),
        );
        assert_eq!(frame["ok"], false);
        assert_eq!(frame["code"], TERMINAL_NOT_FOUND);
        assert_eq!(frame["message"], "That terminal is not open.");
    }

    #[test]
    fn a_pty_that_refused_is_answered_with_the_other_code() {
        let frame = answer_frame(
            "terminal-3",
            &Err(terminal_error(
                "The terminal could not be written to.".to_owned(),
            )),
        );
        assert_eq!(frame["code"], TERMINAL_FAILED);
    }

    #[test]
    fn every_outcome_answers_the_same_request_id() {
        // The id is echoed rather than invented: the host matches answers by it, so a lane that
        // renamed it would leave the tool waiting.
        for outcome in [
            Ok(json!({ "terminals": [] })),
            Err(IpcError::new(INVALID_INPUT, "no")),
            Err(IpcError::new(TERMINAL_NOT_FOUND, "gone")),
        ] {
            assert_eq!(
                answer_frame("terminal-4", &outcome)["requestId"],
                "terminal-4"
            );
        }
    }

    #[test]
    fn create_dimensions_use_service_defaults_and_reject_out_of_range_values() {
        assert_eq!(dimension(&json!({}), "cols").expect("default cols"), 80);
        assert_eq!(dimension(&json!({}), "rows").expect("default rows"), 24);
        assert_eq!(
            dimension(&json!({ "cols": 2 }), "cols").expect("minimum"),
            2
        );
        assert_eq!(
            dimension(&json!({ "rows": 1000 }), "rows").expect("maximum"),
            1000
        );
        for value in [1, 1001] {
            assert_eq!(
                dimension(&json!({ "cols": value }), "cols")
                    .expect_err("out of range")
                    .code,
                INVALID_INPUT
            );
        }
        assert_eq!(
            dimension(&json!({ "rows": 2.5 }), "rows")
                .expect_err("non-integer")
                .code,
            INVALID_INPUT
        );
    }

    #[test]
    fn a_request_without_a_terminal_is_refused_before_the_service_is_reached() {
        // Both `read` and `write` address one terminal by id, so a request that names none is
        // answered here rather than handed to the service as an empty id.
        for frame in [
            json!({ "action": "read" }),
            json!({ "action": "write", "terminal": "  " }),
            json!({ "action": "read", "terminal": 3 }),
        ] {
            let refusal = named_terminal(&frame).expect_err("no terminal named");
            assert_eq!(refusal.code, INVALID_INPUT);
        }
        assert_eq!(
            named_terminal(&json!({ "terminal": " terminal-3 " })).expect("a terminal"),
            "terminal-3"
        );
    }
}

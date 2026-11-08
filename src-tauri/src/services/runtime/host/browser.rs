//! The agent's browser lane: the host's `browser_request` frames, and the answer that carries what
//! the page did back to the tool that asked.
//!
//! This is the host-as-requester half of the protocol, the same shape as `terminal_request`: the
//! browser belongs to this process (`services::browser`), while the `Browser` and `BrowserPreview`
//! tools run inside the host. The frame names an action and its params; the application resolves
//! the page of the *routed session* - never the page the reader happens to be looking at - and
//! answers with `session_browser_response`.
//!
//! The answer is always sent, whatever happened: a refused address is as much an answer as a
//! snapshot, and a host left waiting would hold a tool call open until its own timeout. The work
//! runs in its own task because the inbound loop must not await a frame only that loop can receive.

use serde_json::{json, Value};
use tauri::Manager;

use crate::errors::{IpcError, IpcResult, BROWSER_UNAVAILABLE, INVALID_INPUT};
use crate::services::runtime::host::protocol;
use crate::services::runtime::host::HostRuntime;
use crate::state::AppState;

/// How long one browser request may take before its answer is owed anyway.
///
/// The largest action is a DevTools round trip bounded at 30 s (`services::browser::cdp`), plus the
/// page's own answer; this leaves room for both and stays below the tool's wait.
const ANSWER_TIMEOUT_MS: u64 = 65_000;

/// Handles one `browser_request` frame.
pub(super) fn on_browser_request(host: &HostRuntime, frame: &Value) {
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
    let request = frame.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = match app.try_state::<AppState>() {
            Some(state) => handle(&state, &session_id, &request).await,
            None => Err(IpcError::new(
                BROWSER_UNAVAILABLE,
                "This application has no browser to show a page in.",
            )),
        };
        let answer = answer_frame(&request_id, &outcome);
        if let Err(error) = runtime
            .call_session_ok(&session_id, answer, ANSWER_TIMEOUT_MS)
            .await
        {
            crate::services::log::info(&format!(
                "the answer to a browser request could not be delivered: code={} message={}",
                error.code, error.message
            ));
        }
    });
}

async fn handle(state: &AppState, owner: &str, frame: &Value) -> IpcResult<Value> {
    let service = state.browser.as_ref().ok_or_else(|| {
        IpcError::new(
            BROWSER_UNAVAILABLE,
            "The built-in browser is unavailable in this window.",
        )
    })?;
    let action = frame
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let cwd = frame
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty());
    match action.as_str() {
        "navigate" => {
            let url = field(frame, "url");
            let path = field(frame, "path");
            let state = service
                .navigate(owner, None, cwd, url.as_deref(), path.as_deref())
                .await?;
            Ok(json!({ "state": state }))
        }
        "preview" => {
            let path = field(frame, "path").ok_or_else(|| {
                IpcError::new(INVALID_INPUT, "BrowserPreview: `path` is required.")
            })?;
            let resolved = service.preview_path(owner, cwd, &path)?;
            let resolved = resolved.to_string_lossy().into_owned();
            let opened = service
                .open_tab(owner, cwd, None, Some(&resolved), true)
                .await?;
            Ok(json!({ "tabId": opened.tab_id, "state": opened.state }))
        }
        "snapshot" => service.snapshot(owner),
        "screenshot" => {
            let full_page = frame
                .get("fullPage")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            service.screenshot(owner, full_page)
        }
        "click" => {
            let uid = field(frame, "uid")
                .ok_or_else(|| IpcError::new(INVALID_INPUT, "The `click` action needs a `uid`."))?;
            service.click(owner, &uid)?;
            Ok(json!({ "ok": true }))
        }
        "fill" => {
            let uid = field(frame, "uid")
                .ok_or_else(|| IpcError::new(INVALID_INPUT, "The `fill` action needs a `uid`."))?;
            let text = frame
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            service.fill(owner, &uid, &text)?;
            Ok(json!({ "ok": true }))
        }
        "evaluate" => {
            let expression = field(frame, "expression").ok_or_else(|| {
                IpcError::new(
                    INVALID_INPUT,
                    "The `evaluate` action needs an `expression`.",
                )
            })?;
            let value = service.evaluate(owner, &expression)?;
            Ok(json!({ "value": value }))
        }
        "console" => {
            let limit = frame
                .get("limit")
                .and_then(Value::as_u64)
                .map(|limit| limit as usize);
            service.console(owner, limit)
        }
        "cdp" => {
            let method = field(frame, "method").ok_or_else(|| {
                IpcError::new(INVALID_INPUT, "The `cdp` action needs a `method`.")
            })?;
            let params = frame.get("params");
            let result = service.cdp(owner, &method, params)?;
            Ok(json!({ "result": result }))
        }
        other => Err(IpcError::from_message(
            INVALID_INPUT,
            format!("`{other}` is not an action this browser offers."),
        )),
    }
}

fn field(frame: &Value, name: &str) -> Option<String> {
    frame
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// The answer one request gets: `ok` with what the action produced, or the refusal's code and
/// message.
fn answer_frame(request_id: &str, outcome: &IpcResult<Value>) -> Value {
    let mut frame = json!({
        "type": "session_browser_response",
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
    fn a_snapshot_is_answered_with_its_result() {
        let frame = answer_frame("browser-1", &Ok(json!({ "tree": "- e1 Generic" })));
        assert_eq!(frame["type"], "session_browser_response");
        assert_eq!(frame["requestId"], "browser-1");
        assert_eq!(frame["ok"], true);
        assert_eq!(frame["result"]["tree"], "- e1 Generic");
    }

    #[test]
    fn a_refusal_is_answered_with_its_code() {
        let frame = answer_frame(
            "browser-2",
            &Err(IpcError::new(
                BROWSER_UNAVAILABLE,
                "No Browser page is connected.",
            )),
        );
        assert_eq!(frame["ok"], false);
        assert_eq!(frame["code"], BROWSER_UNAVAILABLE);
        assert_eq!(frame["message"], "No Browser page is connected.");
    }
}

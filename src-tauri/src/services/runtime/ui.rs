//! UI requests: the dialogs the host asks the user to answer, and the exactly-one-answer gate
//! around them.
//!
//! Every method the host documents is dispositioned here. A method this process does not render
//! is still dispositioned rather than ignored, so the census can show what was not forwarded.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::errors::{IpcError, IpcResult, INVALID_INPUT};
use crate::models::agent::{
    UiAskOption, UiAskQuestion, UiFormBlock, UiFormChoice, UiFormField, UiFormOption,
    UiFormSection, UiFormSpan, UiFormText, UiRequest, UiResponse,
};

use super::host::session::SessionRuntime;
use super::host::HostRuntime;
use super::{emit_session, sanitize_message, CONNECT_TIMEOUT_MS};

/// What one `extension_ui_request` was dispositioned as. Every method the host documents
/// maps onto exactly one variant, so the frame census can count the requests this process does
/// not forward instead of losing them between the parse and the event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UiDisposition {
    /// A dialog was emitted and awaits the user's answer.
    Delivered,
    /// The host cancelled a dialog it had opened.
    Cancelled,
    /// An informational projection of `notify`.
    Notice,
    /// `open_url`: the address was handed to the machine's own browser (`services::system_open`).
    Opened,
    /// A documented read-only projection with no answer to send: `setStatus`, `setWidget`,
    /// `set_editor_text` and `setTitle`. This process renders none of them yet.
    Projected,
    /// A method this process does not know.
    Unsupported,
    /// A request carrying no id cannot be answered.
    MissingId,
}

/// Projects an `extension_ui_request` frame into a session event.
///
/// Read-only projections (`setStatus`, `setWidget`, `set_editor_text`, `setTitle`) carry
/// no user answer and are not rendered yet; `open_url` is handed to the machine's own browser
/// (`services::system_open`), and keeps the old notice for a scheme with no browser here.
/// Those methods still report their disposition, so the caller can count what it did not forward.
pub(crate) fn handle_request(
    host: &HostRuntime,
    app: &AppHandle,
    session: &Arc<SessionRuntime>,
    frame: &Value,
) -> UiDisposition {
    let method = frame
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let id = frame
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if id.is_empty() {
        host.log(&format!(
            "extension_ui_request::{method} without id was ignored"
        ));
        return UiDisposition::MissingId;
    }
    let timeout_ms = frame.get("timeout").and_then(Value::as_u64);
    let title = text(frame, "title");
    let message = text(frame, "message");
    let placeholder = text(frame, "placeholder");

    let request = match method {
        "confirm" => UiRequest::Confirm {
            id: id.clone(),
            title,
            message,
            timeout_ms,
        },
        "select" => {
            let options: Vec<String> = frame
                .get("options")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .map(|value| value.as_str().unwrap_or_default().to_owned())
                        .collect()
                })
                .unwrap_or_default();
            let option_descriptions = descriptions(frame, options.len());
            UiRequest::Select {
                id: id.clone(),
                title,
                message,
                options,
                option_descriptions,
                timeout_ms,
            }
        }
        "input" => UiRequest::Input {
            id: id.clone(),
            title,
            message,
            placeholder,
            // The engine's own hint that this answer is a credential; only `true` travels on the
            // wire (host/src/ui.ts forwards it for `dialogOptions.secret`).
            secret: frame.get("secret").and_then(Value::as_bool) == Some(true),
            timeout_ms,
        },
        "editor" => UiRequest::Editor {
            id: id.clone(),
            title,
            message,
            placeholder,
            timeout_ms,
        },
        "ask" => UiRequest::Ask {
            id: id.clone(),
            questions: ask_questions(frame),
            timeout_ms,
        },
        "form" => UiRequest::Form {
            id: id.clone(),
            sections: form_sections(frame),
            fields: form_fields(frame),
            timeout_ms,
        },
        "cancel" => {
            // The host names the request it voids in `targetId` and gives the frame an id of its
            // own (`ui-cancel-<id>`); an engine-shaped frame carries the request id itself. Reading
            // the wrong one would leave the dialog open, so the target wins when it is there.
            let target = frame
                .get("targetId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(&id)
                .to_owned();
            // Only a request this process still holds is answered: the removal is the same
            // one-answer gate `respond` and `expire` use, so a repeated cancel frame cannot
            // produce a second response for one id.
            if session.take_ui_request(&target).is_some() {
                // The host ignores an id it already resolved, so answering costs nothing and
                // keeps a request it still believes is outstanding from being left open.
                send_response(host, session, cancelled_frame(&target));
            }
            session.emit(app, json!({"type": "ui_cancelled", "requestId": target}));
            return UiDisposition::Cancelled;
        }
        "notify" => {
            session.emit(
                app,
                json!({
                    "type": "notice",
                    "level": "info",
                    "message": sanitize_message(&message),
                }),
            );
            return UiDisposition::Notice;
        }
        "open_url" => {
            // The engine asked for an address to be opened for the user - its login flow is the
            // sender. The machine's own browser is the only destination this build has, so the
            // address is handed there directly. Anything else keeps the projection it had: there is
            // no browser here for a scheme this application does not serve, and the line still
            // tells the user what was asked for.
            let url = sanitize_message(&text(frame, "url"));
            if crate::services::system_open::open_web_address(&url).is_ok() {
                return UiDisposition::Opened;
            }
            session.emit(
                app,
                json!({
                    "type": "notice",
                    "level": "info",
                    "message": url,
                }),
            );
            return UiDisposition::Notice;
        }
        "setStatus" | "setWidget" | "set_editor_text" | "setTitle" => {
            return UiDisposition::Projected
        }
        _ => {
            host.log(&format!("unhandled extension_ui_request method: {method}"));
            return UiDisposition::Unsupported;
        }
    };

    session.remember_ui_request(&id, method);
    session.emit(app, json!({"type": "ui_request", "request": request}));

    // A request with a timeout is answered by the host itself once it expires,
    // so the dialog must be closed on the same schedule.
    if let Some(ms) = timeout_ms {
        let app = app.clone();
        let host = host.clone();
        let session = session.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            // `expire` tells the host the request ran out and reports whether this process still
            // owned the id, so the local dialog closes exactly when the host closed it.
            if expire(&host, &session, &id) {
                emit_session(
                    &app,
                    &session.id,
                    json!({"type": "ui_cancelled", "requestId": id}),
                );
            }
        });
    }
    UiDisposition::Delivered
}

/// Ceilings on one ask payload. The frame comes from this project's own host, but a dialog is an
/// unbounded shape on the wire: a question set larger than any reader would answer is refused here
/// rather than shipped to the window.
const ASK_QUESTIONS_MAX: usize = 16;
const ASK_OPTIONS_MAX: usize = 32;

/// The same ceilings for an `ask` form, which is a document rather than a question list. The host
/// already bounds what it forwards (`host/src/ui-form.ts`); this is the second pass, for the same
/// reason the ask questions have one - the window must not be handed a document of any size.
const FORM_SECTIONS_MAX: usize = 64;
const FORM_BLOCKS_MAX: usize = 256;
const FORM_FIELDS_MAX: usize = 64;
const FORM_OPTIONS_MAX: usize = 64;
const FORM_ROWS_MAX: usize = 64;
const FORM_CELLS_MAX: usize = 64;
const FORM_LIST_ITEMS_MAX: usize = 64;
/// Characters this process forwards for one span, label or context line. Matches
/// `host/src/ui-form.ts::FORM_TEXT_MAX`, so a string the host already cut arrives unchanged.
const FORM_TEXT_MAX: usize = 4_000;

/// One frame string, sanitized and bounded: every span of a form is engine-composed text.
///
/// The host already bounds each string (`host/src/ui-form.ts::bound`); this repeats the bound
/// because this process does not compose the frame, and `sanitize_message` alone can leave a string
/// as long as it found it.
fn form_text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(sanitize_message)
        .map(|text| {
            // Cut on a character boundary: `String::truncate` panics mid-character.
            match text.char_indices().nth(FORM_TEXT_MAX) {
                Some((cut, _)) => format!("{}…", &text[..cut]),
                None => text,
            }
        })
        .unwrap_or_default()
}

/// The spans of one text run, in order.
fn form_spans(value: Option<&Value>) -> Vec<UiFormSpan> {
    value
        .and_then(Value::as_array)
        .map(|spans| {
            spans
                .iter()
                .map(|span| UiFormSpan {
                    text: form_text(span.get("text")),
                    style: span.get("style").and_then(Value::as_str).map(str::to_owned),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// One form field, by its `kind`. A field without a name is dropped: the answer addresses controls
/// by name, so an unnamed one could never be answered.
fn form_field(value: &Value) -> Option<UiFormField> {
    let name = value.get("name").and_then(Value::as_str)?.to_owned();
    if name.is_empty() {
        return None;
    }
    if value.get("kind").and_then(Value::as_str) == Some("text") {
        return Some(UiFormField::Text(UiFormText {
            name,
            kind: form_text(value.get("type")),
            multiline: value
                .get("multiline")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            label: form_spans(value.get("label")),
            value: form_text(value.get("value")),
            placeholder: form_text(value.get("placeholder")),
            required: value
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            min: value.get("min").and_then(Value::as_f64),
            max: value.get("max").and_then(Value::as_f64),
            pattern: value
                .get("pattern")
                .and_then(Value::as_str)
                .map(sanitize_message),
            min_length: value.get("minLength").and_then(Value::as_u64),
            max_length: value.get("maxLength").and_then(Value::as_u64),
            rows: value
                .get("rows")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .min(FORM_ROWS_MAX as u64),
        }));
    }
    let options: Vec<UiFormOption> = value
        .get("options")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .take(FORM_OPTIONS_MAX)
                .map(|option| UiFormOption {
                    value: form_text(option.get("value")),
                    label: form_text(option.get("label")),
                    checked: option
                        .get("checked")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    disabled: option
                        .get("disabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default();
    if options.is_empty() {
        return None;
    }
    Some(UiFormField::Choice(UiFormChoice {
        name,
        multi: value.get("multi").and_then(Value::as_bool).unwrap_or(false),
        select: value
            .get("select")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        other: value.get("other").and_then(Value::as_bool).unwrap_or(false),
        label: form_spans(value.get("label")),
        options,
        required: value
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }))
}

/// The named fields of the whole form, in document order: what an answer has to address.
fn form_fields(frame: &Value) -> Vec<UiFormField> {
    frame
        .get("fields")
        .and_then(Value::as_array)
        .map(|fields| {
            fields
                .iter()
                .take(FORM_FIELDS_MAX)
                .filter_map(form_field)
                .collect()
        })
        .unwrap_or_default()
}

/// One renderable unit of a section, by its `kind`.
fn form_block(value: &Value) -> Option<UiFormBlock> {
    match value.get("kind").and_then(Value::as_str)? {
        "text" => Some(UiFormBlock::Text {
            spans: form_spans(value.get("spans")),
            heading: value
                .get("heading")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        "list" => Some(UiFormBlock::List {
            items: value
                .get("items")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .take(FORM_LIST_ITEMS_MAX)
                        .map(|item| form_spans(Some(item)))
                        .collect()
                })
                .unwrap_or_default(),
            ordered: value
                .get("ordered")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        "pre" => Some(UiFormBlock::Pre {
            text: form_text(value.get("text")),
        }),
        "table" => Some(UiFormBlock::Table {
            rows: value
                .get("rows")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .take(FORM_ROWS_MAX)
                        .map(|row| {
                            row.as_array()
                                .map(|cells| {
                                    cells
                                        .iter()
                                        .take(FORM_CELLS_MAX)
                                        .map(|cell| form_spans(Some(cell)))
                                        .collect()
                                })
                                .unwrap_or_default()
                        })
                        .collect()
                })
                .unwrap_or_default(),
            header_rows: value
                .get("headerRows")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(FORM_ROWS_MAX as u64),
        }),
        "image" => {
            let src = form_text(value.get("src"));
            // Only a source the window loads itself travels as a picture; anything else is the
            // text the host already substituted, and a picture with no address has nothing to draw.
            let drawable = src.starts_with("http://")
                || src.starts_with("https://")
                || src.starts_with("data:");
            if drawable {
                Some(UiFormBlock::Image {
                    src,
                    alt: form_text(value.get("alt")),
                })
            } else {
                None
            }
        }
        "svg" => Some(UiFormBlock::Svg {
            markup: form_text(value.get("markup")),
            alt: form_text(value.get("alt")),
        }),
        "field" => value
            .get("field")
            .and_then(form_field)
            .map(|field| UiFormBlock::Field { field }),
        _ => None,
    }
}

/// The form's sections, in document order.
fn form_sections(frame: &Value) -> Vec<UiFormSection> {
    frame
        .get("sections")
        .and_then(Value::as_array)
        .map(|sections| {
            sections
                .iter()
                .take(FORM_SECTIONS_MAX)
                .map(|section| UiFormSection {
                    title: form_spans(section.get("title")),
                    blocks: section
                        .get("blocks")
                        .and_then(Value::as_array)
                        .map(|blocks| {
                            blocks
                                .iter()
                                .take(FORM_BLOCKS_MAX)
                                .filter_map(form_block)
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The questions of an `ask` frame, field for field, bounded and sanitized.
///
/// Labels and descriptions are shown as the engine wrote them, so they go through the same
/// sanitizer every other piece of engine text does; a question without an id or without options is
/// dropped, because the result type the engine validates against is built from them.
fn ask_questions(frame: &Value) -> Vec<UiAskQuestion> {
    let rows = frame.get("questions").and_then(Value::as_array);
    let Some(rows) = rows else {
        return Vec::new();
    };
    rows.iter()
        .take(ASK_QUESTIONS_MAX)
        .filter_map(|row| {
            let id = row.get("id").and_then(Value::as_str)?.to_owned();
            let options: Vec<UiAskOption> = row
                .get("options")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .take(ASK_OPTIONS_MAX)
                        .filter_map(|option| {
                            let label = option.get("label").and_then(Value::as_str)?;
                            Some(UiAskOption {
                                label: sanitize_message(label),
                                description: option
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .map(sanitize_message),
                                preview: option
                                    .get("preview")
                                    .and_then(Value::as_str)
                                    .map(sanitize_message),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            if options.is_empty() {
                return None;
            }
            Some(UiAskQuestion {
                id,
                question: sanitize_message(&text(row, "question")),
                header: row
                    .get("header")
                    .and_then(Value::as_str)
                    .map(sanitize_message),
                options,
                multi: row.get("multi").and_then(Value::as_bool).unwrap_or(false),
                recommended: row.get("recommended").and_then(Value::as_i64),
            })
        })
        .collect()
}

/// Answers a UI request. The response shape is validated against the method that asked, and
/// unknown request ids are forwarded anyway because the host ignores them.
///
/// The order matters: the id is peeked rather than taken while the answer is checked, and only a
/// shape that passes consumes it. Taking it first made one malformed answer burn the id, after
/// which the reply, the timeout and the host's cancel all found nothing - the card could neither
/// be retried nor ever close.
pub(crate) async fn respond(
    host: &HostRuntime,
    session: &Arc<SessionRuntime>,
    request_id: &str,
    response: &UiResponse,
) -> IpcResult<()> {
    if request_id.is_empty() {
        return Err(IpcError::new(INVALID_INPUT, "A UI request id is required."));
    }
    let method = session.ui_request_method(request_id);
    match method.as_deref() {
        Some(method) => response
            .validate(method)
            .map_err(|reason| IpcError::from_message(INVALID_INPUT, reason.to_owned()))?,
        None => validate_shape(response)?,
    }
    // The shape is valid, so this is the answer that settles the request: taking the id here is
    // what keeps one request to one answer. A request the timeout or the host's cancel already
    // answered is simply not there any more - those paths sent their own response.
    let _ = session.take_ui_request(request_id);
    let mut frame = json!({"type": "session_ui_response", "requestId": request_id});
    let mut payload = serde_json::Map::new();
    if response.cancelled == Some(true) {
        payload.insert("cancelled".to_owned(), json!(true));
    } else if let Some(confirmed) = response.confirmed {
        payload.insert("confirmed".to_owned(), json!(confirmed));
    } else if let Some(kind) = response.kind.as_deref() {
        payload.insert("kind".to_owned(), json!(kind));
        if let Some(results) = &response.results {
            payload.insert(
                "results".to_owned(),
                serde_json::to_value(results).map_err(|_| {
                    IpcError::new(INVALID_INPUT, "The ask answers could not be serialized.")
                })?,
            );
        }
    } else if let Some(answers) = &response.answers {
        // A form is answered by its controls, so the payload is the per-field list and nothing else:
        // `kind` and `results` belong to the question-list shape the tool no longer asks in.
        payload.insert(
            "answers".to_owned(),
            serde_json::to_value(answers).map_err(|_| {
                IpcError::new(INVALID_INPUT, "The form answers could not be serialized.")
            })?,
        );
    } else if let Some(value) = response.value.as_deref() {
        payload.insert("value".to_owned(), json!(value));
    }
    frame["response"] = Value::Object(payload);
    host.call_session_ok(&session.id, frame, CONNECT_TIMEOUT_MS)
        .await
        .map(|_| ())
}

/// Closes one dialog from this side because its timeout elapsed.
///
/// Removing the id is the single gate that guarantees one id is answered once: whichever of the
/// user's reply, this expiry or the host's own cancel removes it first is the one that answers.
pub(crate) fn expire(host: &HostRuntime, session: &Arc<SessionRuntime>, request_id: &str) -> bool {
    if session.take_ui_request(request_id).is_none() {
        return false;
    }
    send_response(host, session, timed_out_frame(request_id));
    true
}

/// The host voided a request (`extension_ui_cancel`): the dialog it describes has to close.
pub(crate) fn cancel_request(
    host: &HostRuntime,
    app: &AppHandle,
    session: &Arc<SessionRuntime>,
    request_id: &str,
) {
    if session.take_ui_request(request_id).is_some() {
        send_response(host, session, cancelled_frame(request_id));
    }
    session.emit(
        app,
        json!({"type": "ui_cancelled", "requestId": request_id}),
    );
}

/// Closes every open dialog of a session (close, restart, host exit).
pub(crate) fn cancel_all(host: &HostRuntime, app: &AppHandle, session: &Arc<SessionRuntime>) {
    let ids = session.drain_ui_requests();
    if ids.is_empty() {
        return;
    }
    for request_id in ids {
        // At a host exit the pipe is already gone and the host disposed its own pending requests,
        // so a failed send is the expected case rather than an error to report.
        send_response(host, session, cancelled_frame(&request_id));
        session.emit(
            app,
            json!({"type": "ui_cancelled", "requestId": request_id}),
        );
    }
}

/// Best-effort answer for a request the host is still waiting on.
///
/// The send is spawned because the disposition path is synchronous, and a lost answer is not an
/// error: the host resolves the request with its own default when nothing arrives.
fn send_response(host: &HostRuntime, session: &Arc<SessionRuntime>, frame: Value) {
    let host = host.clone();
    let session = session.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = host
            .call_session(&session.id, frame, CONNECT_TIMEOUT_MS)
            .await
        {
            host.log(&format!("closing a UI request failed: {}", error.message));
        }
    });
}

fn cancelled_frame(request_id: &str) -> Value {
    json!({
        "type": "session_ui_response",
        "requestId": request_id,
        "response": {"cancelled": true},
    })
}

fn timed_out_frame(request_id: &str) -> Value {
    json!({
        "type": "session_ui_response",
        "requestId": request_id,
        "response": {"cancelled": true, "timedOut": true},
    })
}

fn validate_shape(response: &UiResponse) -> IpcResult<()> {
    let shapes = [
        response.value.is_some(),
        response.confirmed.is_some(),
        response.cancelled == Some(true),
        response.kind.is_some(),
        response.answers.is_some(),
    ];
    if shapes.iter().filter(|present| **present).count() == 1 {
        return Ok(());
    }
    Err(IpcError::new(
        INVALID_INPUT,
        "A UI response must carry exactly one of `value`, `confirmed`, `cancelled`, `kind` or `answers`.",
    ))
}

fn text(frame: &Value, key: &str) -> String {
    frame
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// Option descriptions, padded to the number of options so the frontend can zip the two lists.
fn descriptions(frame: &Value, count: usize) -> Vec<String> {
    let mut described: Vec<String> = frame
        .get("optionDetails")
        .and_then(Value::as_array)
        .map(|details| {
            details
                .iter()
                .map(|detail| {
                    detail
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned()
                })
                .collect()
        })
        .unwrap_or_default();
    described.resize(count, String::new());
    described
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_id_is_still_shape_checked() {
        let response = UiResponse::default();
        assert_eq!(
            validate_shape(&response).expect_err("no shape").code,
            INVALID_INPUT
        );
    }

    #[test]
    fn descriptions_are_padded_to_the_option_count() {
        let frame = json!({
            "options": ["a", "b"],
            "optionDetails": [{"description": "first"}],
        });
        assert_eq!(
            descriptions(&frame, 2),
            vec!["first".to_owned(), String::new()]
        );
    }
}

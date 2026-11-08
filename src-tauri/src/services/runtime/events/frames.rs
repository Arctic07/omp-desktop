//! The free helpers the projector's frames are built from.
//!
//! Split out of [`super`] when the projector outgrew one file (`rules.md#single-file-line-limit`). The `EventState` impl
//! that reads the engine's frames into rows stays in [`super`], and the helpers the readers outside
//! this module name - the roster reason, the skill prompt and the subagent frame - are re-exported
//! from [`super`], so every caller still names them through `events`.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::AppHandle;

use super::super::host::session::SessionRuntime;
use super::super::usage::{model_identity, token_usage};
use crate::models::agent::{ChatImage, ToolDetails};
use crate::services::store;

/// What of one field's own record a message's stream never delivered.
///
/// The whole of it when nothing arrived, and the part past what did when the stream was cut short.
/// A stream that is not a prefix of the record is a message the engine rewrote after streaming it:
/// nothing is owed, because the row already holds the words the reader watched arrive.
pub(super) fn missing_tail(record: &str, streamed: &str) -> String {
    if record.is_empty() || record == streamed {
        return String::new();
    }
    if streamed.is_empty() {
        return record.to_owned();
    }
    record
        .strip_prefix(streamed)
        .map(str::to_owned)
        .unwrap_or_default()
}

/// The message-level stop reason a child's roster status stands for.
///
/// Two vocabularies meet here. The roster speaks the run's exit status (`completed` / `failed` /
/// `aborted`, `task/executor.ts`), and the projector derives the frame it publishes from the reason
/// a *message* stopped (`finish_turn` reads `stop` / `aborted` / `error`). Translation rather than
/// pass-through, because `failed` is not a reason any message carries: handed over as it is, the
/// `_` arm of that match would read the run as completed, which is the one outcome a failed child
/// must never be reported as.
pub(crate) fn roster_stop_reason(status: &str) -> &'static str {
    match status {
        "aborted" => "aborted",
        "failed" => "error",
        _ => "stop",
    }
}

/// The engine's type tag for the custom message a user-invoked `/skill:<name>` is delivered as
/// (`pi-tui/chat/messages.ts`, `SKILL_PROMPT_MESSAGE_TYPE`), and the attribution it carries.
///
/// Read here rather than imported: this side does not link the engine, and the tag is part of the
/// engine's stored session format, which a host reads by name.
const SKILL_PROMPT_MESSAGE_TYPE: &str = "skill-prompt";

/// True for the custom message behind a `/skill:<name>` invocation.
///
/// The engine delivers a skill as a `custom` message whose content is the expanded SKILL.md: the
/// model has to read the body, so the body is what the engine puts there. Nothing draws it. What
/// the user wrote is the invocation - `/skill:<name> args` - and the engine keeps exactly that in
/// `details.prompt`, which is the row's text when a transcript is read back.
pub(crate) fn is_user_skill_prompt(message: &Value) -> bool {
    message.get("role").and_then(Value::as_str) == Some("custom")
        && message.get("customType").and_then(Value::as_str) == Some(SKILL_PROMPT_MESSAGE_TYPE)
        && message.get("attribution").and_then(Value::as_str) == Some("user")
        && message.get("display").and_then(Value::as_bool) != Some(false)
}

/// The invocation a skill prompt stands for, in the engine's own fallback order
/// (`pi-tui/chat/skill-title-input.ts`): the draft as submitted, then the name and arguments.
pub(crate) fn skill_prompt_text(message: &Value) -> Option<String> {
    let details = message.get("details");
    let field = |key: &str| {
        details
            .and_then(|details| details.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    if let Some(prompt) = field("prompt") {
        return Some(prompt.to_owned());
    }
    let name = field("name");
    let args = field("args");
    match (name, args) {
        (Some(name), Some(args)) => Some(format!("/skill:{name} {args}")),
        (Some(name), None) => Some(format!("/skill:{name}")),
        (None, Some(args)) => Some(args.to_owned()),
        (None, None) => None,
    }
}

/// Whether one engine message is part of the conversation the reader sees.
///
/// The event stream announces more than the transcript draws: `toolResult` messages repeat what the
/// tool frames already reported, `developer` messages are injected context, and a `user` message the
/// engine authored for the agent (an IRC steer, an automatic continuation) is not the reader's own
/// prompt. Drawing them opens empty assistant rows (which still count as "this turn answered") and
/// lets an agent steer claim the row of a prompt the reader queued. The stored transcript applies
/// the same rule (`history.rs`), so live and reopened conversations agree.
pub(crate) fn message_is_drawn(event: &Value) -> bool {
    let Some(message) = event.get("message") else {
        return false;
    };
    match message.get("role").and_then(Value::as_str) {
        Some("user") => {
            message.get("attribution").and_then(Value::as_str) != Some("agent")
                && message.get("synthetic").and_then(Value::as_bool) != Some(true)
        }
        Some("assistant") => true,
        // A custom message is a delivery or a skill invocation. `display: false` is the engine
        // saying it is context for the model rather than conversation.
        Some("custom") => message.get("display").and_then(Value::as_bool) != Some(false),
        // A rule check the harness fired on a call: the one developer message that is drawn, because
        // it explains a refusal the reader watched happen (`super::super::reminder_text`).
        Some("developer") => super::super::reminder_text(message).is_some(),
        _ => false,
    }
}

/// Whether one `agent_end` frame closes the turn the reader is watching.
///
/// A run the agent resumes by itself — a retry, a compaction continuation, a stop-time reminder —
/// reports `isTerminal: false`, and closing there would end a row the turn is still filling.
///
/// `awaitingAsyncWork` is the exception: the agent finished its turn and only a background job's
/// result can resume the session, which the engine reads as idle itself (its own TUI sets the status
/// line to idle on exactly this frame). The wake is not guaranteed — a cancelled or suppressed job
/// never delivers one — so keeping the turn open left 「运行中」 with a growing clock under a finished
/// answer for hours (2026-10-30: 30 min of output ended, 150 min later still running). The stall
/// watchdog will not reclaim that shape either, because it has pending async work. The job's own
/// result opens a new turn (`agent_start` → `ensure_turn`) if it ever arrives.
pub(super) fn ends_turn(event: &Value) -> bool {
    // A superseded end: the host stamped the engine's own reading of the moment, and it says a run
    // was already streaming (the engine defers an end until its prompt unwinds, so a post-turn
    // continuation can be live before the frame is delivered — `agent-session.ts`). The engine's
    // TUI refuses the same frame for the same reason. Closing here would take down the row of the
    // run that is still going, and that run's own ending would then open an empty turn.
    if event.get("sessionStreaming").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    if event.get("isTerminal").and_then(Value::as_bool) != Some(false) {
        return true;
    }
    event.get("awaitingAsyncWork").and_then(Value::as_bool) == Some(true)
}

pub(super) fn message_role(event: &Value) -> &'static str {
    let message = event.get("message");
    match message
        .and_then(|message| message.get("role"))
        .and_then(Value::as_str)
    {
        Some("user") => "user",
        // A rule check is its own row, drawn as an annotation rather than as a step of an answer.
        Some("developer") => "reminder",
        // A skill invocation is the user's own turn: the engine announces it as a custom message,
        // and the row it opens belongs where the draft was typed rather than among the answers.
        _ if message.is_some_and(is_user_skill_prompt) => "user",
        _ => "assistant",
    }
}

/// The notice frame for one `notice` event, with the event's own `code` when it has one.
///
/// The code is what the page's suppression list is keyed by, and what keeps two notices apart once
/// they are only `level` + text: a notice this repository's host writes (`engine_recap`) carries its
/// own, and dropping it here would file every such line under "no code". The engine's own notices
/// carry none, so a frame built from one is the two-field line it always was.
pub(super) fn notice_frame(event: &Value) -> Value {
    let mut notice = json!({
        "type": "notice",
        "level": normalise_level(event.get("level").and_then(Value::as_str)),
        "message": super::super::sanitize_message(
            event.get("message").and_then(Value::as_str).unwrap_or_default()
        ),
    });
    if let Some(code) = event
        .get("code")
        .and_then(Value::as_str)
        .filter(|code| !code.is_empty())
    {
        notice["code"] = json!(code);
    }
    notice
}

/// The reminder one engine message carries, when it is a rule check the reader should see.
///
/// The live projection emits it as one whole frame: the engine appends these messages finished, so
/// there is no stream to fold and nothing to announce before its words exist.
pub(super) fn reminder_frame(message_id: &str, at: i64, text: &str) -> Value {
    json!({"type": "reminder", "messageId": message_id, "at": at, "text": text})
}

/// The identity one engine message is known by across the frames that carry it.
///
/// The engine gives a message an `id` on some paths only; every message carries the `timestamp` it
/// was created with. Both are the engine's own reading of the same message, so either can pair the
/// separate frames that describe it - `message_start`, its updates, `message_end`, and the copy the
/// run's `agent_end` carries. The row id the frontend holds cannot serve here: it is minted on this
/// side (from the wire id or a counter) and appears in no frame the engine writes.
pub(super) fn message_key(message: &Value) -> Option<String> {
    if let Some(id) = message
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        return Some(format!("id:{id}"));
    }
    super::super::history::message_timestamp(message).map(|at| format!("at:{at}"))
}

/// The messages of one finished engine run whose row never received them.
///
/// `agent_end` carries the run's own messages, and it is the frame that states the turn is over.
/// Every other frame a message produces can be lost before it reaches the projector - the host's
/// outbound pipe, a session swapped under a turn, a killed and rebuilt engine process - and that loss
/// is silent on this side: there is no hole to notice, only a row that never appeared (the frontend
/// draws no row for an answer with nothing in it). So the run's own record is read at its end and
/// whatever its stream never closed is delivered from here.
///
/// Only messages that are a row with something to show are owed: a step that only called tools draws
/// nothing of its own (the feed folds its call into the run's calls), a tool result and an injected
/// developer message are not conversation, and `display: false` is the engine saying the same about
/// a custom entry. `finished` holds the messages this turn already closed, so a message a later run
/// of a continuing turn repeats is not drawn twice.
pub(super) fn unclosed_messages<'a>(
    messages: &'a [Value],
    finished: &HashSet<String>,
) -> Vec<&'a Value> {
    messages
        .iter()
        .filter(|message| {
            owes_a_row(message) && message_key(message).is_some_and(|key| !finished.contains(&key))
        })
        .collect()
}

/// Whether one engine message is a row a reader sees, and therefore one whose absence is a hole.
fn owes_a_row(message: &Value) -> bool {
    // A user-invoked skill is the reader's own message: its row is the echo written before the
    // turn and claimed by the opening frame, so the run owes nothing for it. Read as a delivery it
    // is a `custom` entry with the expanded SKILL.md as its words, which is what the run's own
    // record would then draw as an answer (2026-10-31, user report).
    if is_user_skill_prompt(message) {
        return false;
    }
    let shown = match message.get("role").and_then(Value::as_str) {
        Some("assistant") => true,
        Some("custom") => message.get("display").and_then(Value::as_bool) != Some(false),
        _ => false,
    };
    shown && carries_something(message)
}

/// Whether a message has anything a row would draw.
///
/// Words and reasoning are the two the frontend reads; an error line and a picture are the other
/// two it draws on a row of its own. Emptiness is judged the way the feed judges it - trimmed - so a
/// message of whitespace alone is not "owed": the frontend elides that row whatever arrives for it,
/// and delivering one would leave a blank stretch of transcript where nothing belongs.
fn carries_something(message: &Value) -> bool {
    if message
        .get("errorMessage")
        .and_then(Value::as_str)
        .is_some_and(|error| !error.trim().is_empty())
    {
        return true;
    }
    let content = message.get("content");
    if !super::super::content_text(content).trim().is_empty() {
        return true;
    }
    if !super::super::history::thinking_text(content)
        .trim()
        .is_empty()
    {
        return true;
    }
    content.and_then(Value::as_array).is_some_and(|parts| {
        parts
            .iter()
            .any(|part| part.get("type").and_then(Value::as_str) == Some("image"))
    })
}

/// One delta frame: the text a message gained, or its thinking, either of which may be nothing.
///
/// The streaming path and the path a whole injected message takes both deliver through this one
/// frame, so a row filled by either looks exactly like a row filled by the other - and the shape of
/// a delta is written down once.
pub(super) fn delta_frame(message_id: &str, text: String, thinking: String) -> Value {
    json!({
        "type": "delta",
        "messageId": message_id,
        "textDelta": if text.is_empty() { Value::Null } else { Value::String(text) },
        "thinkingDelta": if thinking.is_empty() { Value::Null } else { Value::String(thinking) },
    })
}

/// One `subagent` frame: the live roster of a session's children, merged and published.
///
/// A frame carries one half of one child - `kind` says which half - and the row is the merge of the
/// halves, so this publishes only what a frame actually changed: the engine already coalesces its
/// progress frames, and a snapshot that repeats itself would be the same fact sent twice. The whole
/// row travels rather than a patch, because the frontend replaces its own copy of it.
pub(crate) fn on_subagent(
    app: &AppHandle,
    session: &Arc<SessionRuntime>,
    kind: &str,
    payload: &Value,
) {
    let Some(row) = session.merge_subagent(kind, payload, store::now_ms()) else {
        return;
    };
    session.emit(app, json!({"type": "subagent_updated", "subagent": row}));
}

pub(super) fn text_field(event: &Value, key: &str) -> String {
    event
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// Adds a tool result's structured half to a frame, when the call reported one.
///
/// The field is additive: a frame that has nothing structured to say does not carry an empty
/// `details`, so a frontend built before the field keeps reading exactly the frame it knows.
pub(super) fn attach_details(payload: &mut Value, details: Option<ToolDetails>) {
    let Some(details) = details.and_then(|details| serde_json::to_value(details).ok()) else {
        return;
    };
    if let Some(object) = payload.as_object_mut() {
        object.insert("details".to_owned(), details);
    }
}

/// Adds a tool result's or message's pictures to a frame, when there are any.
///
/// The same additive rule as `attach_details`: an empty list is not a fact worth a field, so a
/// frame with no pictures to show carries no `images` and a frontend built before the field keeps
/// reading exactly the frame it knows. A picture the engine sent is bounded before it gets here
/// (`content_images`), so what this inserts is already the size the projection decided on.
pub(super) fn attach_images(payload: &mut Value, images: Vec<ChatImage>) {
    if images.is_empty() {
        return;
    }
    let Ok(images) = serde_json::to_value(images) else {
        return;
    };
    if let Some(object) = payload.as_object_mut() {
        object.insert("images".to_owned(), images);
    }
}

/// Adds what an answer's own record says about why it stopped, when it says anything.
///
/// Two facts, both read off the message the engine closed rather than off the turn: a message can
/// end in the middle of a turn (`toolUse` on a step that called a tool, `stop` on one that finished
/// it), and the one the reader needs is the ending that did *not* finish the turn — an abort, or a
/// failure. The live path used to learn both only by reading the transcript back from disk
/// (`history.rs`), so a stopped turn drew an empty answer and a failed one drew nothing at all.
///
/// Added only when the engine said something, so a normal completion keeps exactly the frame it
/// always had — the field is additive, and a frontend built before it reads what it knew.
pub(super) fn attach_ending(payload: &mut Value, message: Option<&Value>) {
    let Some(message) = message else {
        return;
    };
    if let Some(stop_reason) = message
        .get("stopReason")
        .and_then(Value::as_str)
        .filter(|reason| !reason.is_empty())
    {
        payload["stopReason"] = json!(stop_reason);
    }
    // The engine's own words for a stop it did not finish (`Request was aborted`,
    // `Interrupted by user`, a provider's sentence). Carried with the row for the same reason as
    // the stop reason: it is the only account of the failure the live path would otherwise lose.
    if let Some(error) = message
        .get("errorMessage")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        payload["error"] = json!(super::super::sanitize_message(error));
    }
}

pub(super) fn normalise_level(level: Option<&str>) -> &'static str {
    match level {
        Some("warning") | Some("warn") => "warning",
        Some("error") => "error",
        _ => "info",
    }
}

/// The frames that complete one message's row, in the order the frontend must receive them.
///
/// One body for the row itself, because the two ways a row can be completed - a message ending on
/// its own frame and a message the end of the run had to deliver - have to leave the screen in the
/// same state. The words go out as the `delta` the streaming path uses (so the row fills exactly as
/// a streamed one fills), then the closing frame carries the usage, the model and the ending; the
/// pair is built here rather than emitted from the projector so the frames can be read in a test
/// without a window to send them to.
///
/// `text` and `thinking` are what the message's record still owes the UI (see
/// [`super::EventState::message_end_repair`]); the closing frame additionally carries the message's
/// **whole** words (`text`/`thinking` fields), and the frontend replaces the row with them. That is
/// what makes the row independent of the delta accounting: a stream cut short, a listener that was
/// not attached for part of it, or an answer whose words only exists in the engine's record all end
/// on the same complete row as a stream that arrived in full. The fields are additive and null when
/// the message is empty, so a reader that ignores them sees exactly the frame it saw before.
///
/// `started_at` is the host clock's first observation of the stream, absent for a message this side
/// never saw start; the frontend reads a missing start as "this step's window is unknown" and counts
/// the turn's wall clock instead of inventing a decode rate.
pub(super) fn close_frames(
    message_id: &str,
    started_at: Option<i64>,
    ended_at: i64,
    text: String,
    thinking: String,
    message: Option<&Value>,
) -> Vec<Value> {
    let mut frames: Vec<Value> = Vec::with_capacity(2);
    if !text.is_empty() || !thinking.is_empty() {
        frames.push(delta_frame(message_id, text, thinking));
    }
    let content = message.and_then(|message| message.get("content"));
    let full_text = super::super::content_text(content);
    let full_thinking = super::super::history::thinking_text(content);
    let (model_provider, model_id) = model_identity(message);
    let mut payload = json!({
        "type": "message_finished",
        "messageId": message_id,
        "startedAt": started_at,
        "endedAt": ended_at,
        "usage": token_usage(message),
        "modelProvider": model_provider,
        "modelId": model_id,
        // What the row is, whatever its stream carried. Null rather than empty keeps "this message
        // has no words" out of a field the frontend replaces with (an empty answer's row is elided
        // either way, and a thinking-only step must not lose its reasoning to an empty text).
        "text": if full_text.is_empty() { Value::Null } else { Value::String(full_text) },
        "thinking": if full_thinking.is_empty() { Value::Null } else { Value::String(full_thinking) },
    });
    // Why this answer stopped, in the same frame that closes its row. The turn's own
    // `turn_finished` states it too, but a turn can end with no message at all (a stop that landed
    // before the first step), and the row is what a reader looks at: without this field the live row
    // only learns "aborted" when the conversation is reopened and the transcript read back
    // (`history.rs`), which is exactly the difference the reader reported - a stop that looked like
    // nothing happened.
    attach_ending(&mut payload, message);
    // An answer that is a picture rather than a sentence (an engine-generated image, a delivery that
    // carries a screenshot) says so here, in the same frame that closes the row. Added only when the
    // message carried images, so a frontend built before the field reads exactly the frame it knows.
    attach_images(
        &mut payload,
        super::super::content_images(message.and_then(|message| message.get("content"))),
    );
    frames.push(payload);
    frames
}

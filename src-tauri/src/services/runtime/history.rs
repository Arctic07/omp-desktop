use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::models::agent::{ChatImage, ChatMessage, ToolDetails};
use crate::services::attachment_mentions::read_prompt;
use crate::services::attachments;

use super::events::{is_user_skill_prompt, skill_prompt_text};
use super::usage::{model_identity, token_usage};
use super::{
    clamp_text, content_images, content_text, content_words, sanitize_message, tool_details,
};

/// One `toolResult` entry as the walk pairs it: what the call reported, and the entry that reported
/// it.
///
/// The results are read first and the messages after, because a call part and its result are two
/// entries: the row a call part becomes is completed from here, and the fields travel together
/// because a call has exactly one result and one place to end.
struct ToolResultEntry {
    is_error: bool,
    text: String,
    details: Option<ToolDetails>,
    entry_id: Option<String>,
    images: Vec<ChatImage>,
}

/// History messages -> render messages. A tool call becomes its own card, paired with the
/// `toolResult` that carries the same `toolCallId`; unmatched results stay as orphan cards
/// so nothing is dropped from a page that starts mid-turn.
///
/// A page stores what the engine wrote down, so only the engine's own facts travel with a row:
/// usage and model identity come from the entry, and the call intent from the call part the engine
/// recorded it on (`intent_text`) - which is the same field the live `tool_execution_start` frame
/// carries, so a row reads the same after a reload. The host-clock times exist only while the turn
/// is live and stay unknown rather than being invented here.
pub(crate) fn normalize_messages(entries: &[Value]) -> Vec<ChatMessage> {
    normalize(entries, false)
}

/// The same mapping for a **subagent's** transcript, whose opening message is the assignment.
///
/// The parent's `task` call writes what the child was asked as a user message attributed to the
/// agent — the same shape an IRC steer or an automatic continuation has, and the reason the
/// ordinary mapping hides it. For the child itself that message is not the engine talking to
/// itself, it is the whole of its brief: a reader who opened the child's conversation from the
/// task card came to read it, so the leading one is kept and every later injected message is
/// still hidden (2026-10-21, user report: the tab opened on the child's first answer instead of
/// on what it was asked).
pub(crate) fn normalize_subagent_messages(entries: &[Value]) -> Vec<ChatMessage> {
    normalize(entries, true)
}

fn normalize(entries: &[Value], include_task_prompt: bool) -> Vec<ChatMessage> {
    let mut results: HashMap<String, ToolResultEntry> = HashMap::new();
    for entry in entries {
        if role_of(entry) != "toolResult" {
            continue;
        }
        let Some(tool_call_id) = entry.get("toolCallId").and_then(Value::as_str) else {
            continue;
        };
        results.insert(
            tool_call_id.to_owned(),
            ToolResultEntry {
                is_error: entry
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                text: content_text(entry.get("content")),
                details: tool_details(entry.get("details")),
                entry_id: entry_entry_id(entry),
                images: content_images(entry.get("content")),
            },
        );
    }

    let mut messages = Vec::with_capacity(entries.len());
    let mut emitted_tools: HashSet<String> = HashSet::new();
    // Whether no user message has been read yet: the child's brief is the *first* one, whatever
    // the engine wrote in front of it (a `custom_message`, a header), so the flag follows the
    // messages rather than the entry index.
    let mut leading_user = true;
    for entry in entries {
        match role_of(entry) {
            "user" => {
                let leading = leading_user;
                leading_user = false;
                // A message the engine injected for the agent - an IRC steer, an automatic
                // continuation - is persisted as a user message, but the live path never draws it as
                // the reader's own prompt. `attribution: "user"` and an absent attribution are the
                // reader's own words; `synthetic` marks the engine's. The exception is a subagent's
                // **own opening message**: the parent's `task` call writes the assignment attributed
                // to the agent, and a reader who opened the child's conversation came to read that —
                // so a transcript read for that tab keeps the leading one, and only it (2026-10-21).
                let injected = entry.get("attribution").and_then(Value::as_str) == Some("agent")
                    || entry.get("synthetic").and_then(Value::as_bool) == Some(true);
                if injected && !(include_task_prompt && leading) {
                    continue;
                }
                // The files the prompt carried are named by the lines the host appended to it
                // (`services/attachment_mentions.rs`), so they are read back here and the lines come
                // out of the words: a reopened conversation shows the message the reader wrote, with
                // the files it carried - not the paths it was sent with. The read happens before the
                // words are bounded, because the lines that name the files stand at the end.
                let raw = content_words(entry.get("content"));
                let prompt = read_prompt(&raw);
                messages.push(ChatMessage::User {
                    id: message_id(entry),
                    at: timestamp_of(entry),
                    text: clamp_text(prompt.words.to_owned()),
                    attachments: prompt
                        .paths
                        .iter()
                        .map(|path| attachments::reference_for_path(path))
                        .collect(),
                    entry_id: entry
                        .get("entryId")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned),
                });
            }
            "assistant" => {
                // The brief always precedes the child's first answer; a transcript that opens on an
                // answer has no brief left to keep.
                leading_user = false;
                let (model_provider, model_id) = model_identity(Some(entry));
                let entry_id = entry_entry_id(entry);
                messages.push(ChatMessage::Assistant {
                    id: message_id(entry),
                    at: timestamp_of(entry),
                    entry_id: entry_id.clone(),
                    text: content_text(entry.get("content")),
                    thinking: thinking_text(entry.get("content")),
                    error: entry
                        .get("errorMessage")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(sanitize_message),
                    stop_reason: entry
                        .get("stopReason")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        // Redacted the way its sibling `error` is, and bounded on top: it is a line
                        // the engine wrote, so neither field is taken on trust.
                        .map(|value| clamp_text(sanitize_message(value))),
                    // The engine's own latency readings, in the shape the live path uses: `startedAt`
                    // is the first token and `endedAt` the end of the answer, which together are the
                    // decode window a tok/s rate is measured over. Both come from the entry's stamps -
                    // `timestamp` plus the `ttft` it measured, and `completedAt` (or `timestamp` plus
                    // `duration` for a record that carries no completion). Reading only `timestamp`
                    // here left a turn read back with no decode window at all; reading it as the window
                    // would include the wait for the first token, which is not decode time.
                    started_at: first_token_at(entry),
                    ended_at: completion_at(entry),
                    usage: token_usage(Some(entry)),
                    model_provider,
                    model_id,
                    // Read the way the live path reads them, so an answer that arrived as a picture
                    // is a picture again after the conversation is reopened.
                    images: content_images(entry.get("content")),
                });
                for (tool_call_id, name, arguments, intent) in tool_calls(entry) {
                    let state = match results.get(&tool_call_id) {
                        Some(result) if result.is_error => "error",
                        Some(_) => "success",
                        None => "running",
                    };
                    messages.push(ChatMessage::Tool {
                        id: tool_call_id.clone(),
                        at: timestamp_of(entry),
                        tool_call_id: tool_call_id.clone(),
                        // The row ends where the call did: its result's entry when this page holds
                        // it, and the entry that made the call otherwise.
                        entry_id: results
                            .get(&tool_call_id)
                            .and_then(|result| result.entry_id.clone())
                            .or_else(|| entry_id.clone()),
                        name,
                        state: state.to_owned(),
                        args_text: super::stringify(arguments.as_ref()),
                        result_text: results
                            .get(&tool_call_id)
                            .map(|result| result.text.clone())
                            .unwrap_or_default(),
                        started_at: None,
                        ended_at: None,
                        intent,
                        details: results
                            .get(&tool_call_id)
                            .and_then(|result| result.details.clone()),
                        // The pictures the result carried, which a reopened conversation draws the
                        // same way the live frame did.
                        images: results
                            .get(&tool_call_id)
                            .map(|result| result.images.clone())
                            .unwrap_or_default(),
                    });
                    emitted_tools.insert(tool_call_id);
                }
            }
            "developer" => messages.extend(super::reminder_message(entry)),
            // A user-invoked skill is stored the same way, and it is the one `custom` entry that
            // belongs to the user rather than to the engine: its content is the expanded SKILL.md
            // the model read, and what the user wrote is the invocation. Reopening a conversation
            // must show the row they typed, not a wall of skill instructions.
            "custom" if is_user_skill_prompt(entry) => {
                messages.push(ChatMessage::User {
                    id: message_id(entry),
                    at: timestamp_of(entry),
                    text: clamp_text(skill_prompt_text(entry).unwrap_or_default()),
                    // The invocation names a skill, not a file: there is nothing to attach, and
                    // the engine's own row carries no attachment either.
                    attachments: Vec::new(),
                    // The row is a `custom_message` entry, not a message: the engine branches only
                    // from a user message, so this row has no point to continue from and says so by
                    // carrying no entry id.
                    entry_id: None,
                });
            }
            // A message the engine injected from outside the turn - the answer a background job or a
            // subagent hands back, a peer's aside, an advisor card - is stored as a `custom` entry,
            // and the live path renders it as the assistant row its own `message_start` opened. Read
            // the same way here, or a reopened conversation would be missing every delivery the live
            // one showed. `display: false` is the engine saying the entry is context for the model
            // rather than conversation, and that is the one thing it has to stay out of.
            "custom" if entry.get("display").and_then(Value::as_bool) != Some(false) => {
                let (model_provider, model_id) = model_identity(Some(entry));
                messages.push(ChatMessage::Assistant {
                    id: message_id(entry),
                    at: timestamp_of(entry),
                    // A `custom_message` entry is not a message entry, so the host's pairing gives
                    // it no id: a row it produced offers no rewind of its own.
                    entry_id: None,
                    text: content_text(entry.get("content")),
                    thinking: String::new(),
                    // A delivery is not a model answer: it has no stop reason of its own and no
                    // failure to report, and both fields stay empty rather than being read off an
                    // entry that never carried them.
                    error: None,
                    stop_reason: None,
                    // The engine's own latency readings, in the shape the live path uses: `startedAt`
                    // is the first token and `endedAt` the end of the answer, which together are the
                    // decode window a tok/s rate is measured over. Both come from the entry's stamps -
                    // `timestamp` plus the `ttft` it measured, and `completedAt` (or `timestamp` plus
                    // `duration` for a record that carries no completion). Reading only `timestamp`
                    // here left a turn read back with no decode window at all; reading it as the window
                    // would include the wait for the first token, which is not decode time.
                    started_at: first_token_at(entry),
                    ended_at: completion_at(entry),
                    usage: token_usage(Some(entry)),
                    model_provider,
                    model_id,
                    // A delivery is rendered as the assistant row its own `message_start` opened, so
                    // it carries pictures by the same rule: what the live path attached to that row
                    // is what the reopened one draws.
                    images: content_images(entry.get("content")),
                });
            }
            "toolResult" => {
                let tool_call_id = entry
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if emitted_tools.contains(&tool_call_id) {
                    continue;
                }
                let is_error = entry
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                messages.push(ChatMessage::Tool {
                    id: tool_call_id.clone(),
                    at: timestamp_of(entry),
                    tool_call_id,
                    entry_id: entry_entry_id(entry),
                    name: entry
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    state: if is_error { "error" } else { "success" }.to_owned(),
                    args_text: String::new(),
                    result_text: content_text(entry.get("content")),
                    started_at: None,
                    ended_at: None,
                    // The call itself is on an earlier page: the arguments and the intent both live
                    // on the call part, and a result is not evidence of either. The row still draws
                    // its title and what it reported rather than claiming words the page never had.
                    intent: None,
                    details: tool_details(entry.get("details")),
                    // A result read on its own still carries its pictures: the page that holds the
                    // call is not what made them.
                    images: content_images(entry.get("content")),
                });
            }
            _ => {}
        }
    }
    messages
}

pub(crate) fn role_of(entry: &Value) -> &str {
    entry
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// How many of `entries` are final as a transcript prefix.
///
/// A paged read that reports rows while it walks must never report a row it will later have to
/// change. The one thing that can change is a **tool call**: its result is a separate entry that
/// follows the assistant message which made the call, and a host page can end between the two. The
/// call would then be drawn `running` forever. So the transcript's last assistant entry - and the
/// entries written after it - is held back until the next page (or the end of the walk) brings the
/// result; everything before that entry is already written down, and its rows are final.
///
/// A transcript with no assistant entry has nothing that can still be completed, so all of it is
/// final. Held-back entries are never lost: the caller reports them on the page that follows.
pub(crate) fn preview_boundary(entries: &[Value]) -> usize {
    for index in (0..entries.len()).rev() {
        if role_of(&entries[index]) == "assistant" {
            return index;
        }
    }
    entries.len()
}

pub(super) fn thinking_text(content: Option<&Value>) -> String {
    let Some(Value::Array(parts)) = content else {
        return String::new();
    };
    let mut text = String::new();
    for part in parts {
        if part.get("type").and_then(Value::as_str) != Some("thinking") {
            continue;
        }
        let chunk = part
            .get("thinking")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if chunk.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(chunk);
    }
    clamp_text(text)
}

/// A call's identity, name, arguments and stated intent, as the engine stored them on the part.
///
/// The intent is the one field of the four that is not visible in the arguments: it is the line the
/// engine recorded for the call (`ToolCallContent.intent`, and the same value the live
/// `tool_execution_start` carries), and for the tools whose arguments name nothing a presentation
/// knows it is the row's only words. Reading it here is what keeps a reopened conversation's tool
/// rows reading as they did while the turn ran.
fn tool_calls(entry: &Value) -> Vec<(String, String, Option<Value>, Option<String>)> {
    let Some(Value::Array(parts)) = entry.get("content") else {
        return Vec::new();
    };
    parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("toolCall"))
        .filter_map(|part| {
            let id = part.get("id").and_then(Value::as_str)?.to_owned();
            let name = part
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            Some((
                id,
                name,
                part.get("arguments").cloned(),
                super::intent_text(part.get("intent")),
            ))
        })
        .collect()
}

/// Messages carry no id of their own, so the identity is derived from their content:
/// stable across page walks and reloads, unique per message.
/// The session entry a history message was written as, when the host paired one with it.
///
/// The host stamps the pairing onto the message object it read (`host/src/sessions.ts`,
/// `#withEntryIds`), so this is the same id the entry-addressed commands speak - the one a rewind
/// names.
fn entry_entry_id(entry: &Value) -> Option<String> {
    entry
        .get("entryId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(crate) fn message_id(entry: &Value) -> String {
    hash_id(&entry.to_string())
}

fn hash_id(seed: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    seed.hash(&mut hasher);
    format!("m{:016x}", hasher.finish())
}

/// History messages carry `timestamp` as Unix milliseconds; transcripts read from disk
/// carry it as an ISO-8601 string, so both shapes are accepted. Unknown shapes yield 0
/// rather than a fabricated time.
pub(crate) fn timestamp_of(entry: &Value) -> i64 {
    message_timestamp(entry).unwrap_or_default()
}

/// The engine's own stamp under one key of a message, in Unix milliseconds. History carries it
/// as a number, transcripts as an ISO-8601 string, and a message without one yields `None` - a
/// local clock is never substituted.
pub(crate) fn message_stamp(entry: &Value, key: &str) -> Option<i64> {
    match entry.get(key) {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value as i64)),
        Some(Value::String(text)) => {
            let millis = iso_to_ms(text);
            (millis != 0).then_some(millis)
        }
        _ => None,
    }
}

/// The engine's own `timestamp` for a message.
pub(crate) fn message_timestamp(entry: &Value) -> Option<i64> {
    message_stamp(entry, "timestamp")
}
/// The engine's own reading of when the answer's **first token** arrived: the start of writing plus
/// the `ttft` it measured, which is where a decode window opens. An entry without a usable `ttft`
/// says the start of writing and nothing more.
fn first_token_at(entry: &Value) -> Option<i64> {
    let start = message_stamp(entry, "timestamp")?;
    match message_millis(entry, "ttft") {
        Some(ttft) => Some(start.saturating_add(ttft)),
        None => Some(start),
    }
}

/// The engine's own reading of when the answer finished: `completedAt`, or the start of writing
/// plus the `duration` it measured when the record carries no completion stamp.
fn completion_at(entry: &Value) -> Option<i64> {
    if let Some(done) = message_stamp(entry, "completedAt") {
        return Some(done);
    }
    let start = message_stamp(entry, "timestamp")?;
    message_millis(entry, "duration").map(|duration| start.saturating_add(duration))
}

/// A non-negative millisecond reading (`ttft`, `duration`): the engine writes these as a float, and
/// a negative or non-finite one is not a time.
fn message_millis(entry: &Value, key: &str) -> Option<i64> {
    let value = entry.get(key)?.as_f64()?;
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    Some(value.round() as i64)
}

/// Parses the engine's ISO-8601 timestamps (`2026-09-16T09:51:32.047Z`) into Unix ms.
/// Unknown shapes yield 0 rather than a fabricated time.
pub(crate) fn iso_to_ms(text: &str) -> i64 {
    let bytes = text.as_bytes();
    if bytes.len() < 19
        || bytes[4] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return 0;
    }
    let year = digits(&bytes[0..4]);
    let month = digits(&bytes[5..7]);
    let day = digits(&bytes[8..10]);
    let hour = digits(&bytes[11..13]);
    let minute = digits(&bytes[14..16]);
    let second = digits(&bytes[17..19]);
    let millis = if bytes.len() >= 23 && bytes[19] == b'.' {
        digits(&bytes[20..23])
    } else {
        0
    };
    let days = days_from_civil(year, month, day);
    ((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000) + millis
}

fn digits(bytes: &[u8]) -> i64 {
    let mut value = 0;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            return 0;
        }
        value = value * 10 + i64::from(byte - b'0');
    }
    value
}

/// Howard Hinnant's civil-date conversion (days since 1970-01-01).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::services::runtime::MAX_TEXT_CHARS;

    /// §7.1: the live entry reports the engine's timestamp, never a local clock, and reports
    /// nothing when the engine did not provide one.
    #[test]
    fn message_timestamps_come_from_the_engine_only() {
        assert_eq!(
            message_timestamp(&json!({"timestamp": 1_789_627_445_383i64})),
            Some(1_789_627_445_383)
        );
        assert_eq!(
            message_timestamp(&json!({"timestamp": "2026-09-16T09:51:32.047Z"})),
            Some(1_789_552_292_047)
        );
        assert_eq!(message_timestamp(&json!({"role": "assistant"})), None);
        assert_eq!(message_timestamp(&json!({"timestamp": "not a time"})), None);
        assert_eq!(message_timestamp(&json!({"timestamp": null})), None);
    }

    /// A history row carries the engine's own accounting, identity and stamps, and nothing this
    /// host could only have known while the turn was live. An assistant entry is stamped twice -
    /// `timestamp` when it began writing, `completedAt` when it finished - and the row carries
    /// both; the fixture has no completion (a turn that never finished), so the end stays unknown
    /// while the start is still the engine's own.
    #[test]
    fn history_rows_carry_engine_usage_and_model_only() {
        let messages = normalize_messages(&[json!({
            "role": "assistant",
            "provider": "anthropic",
            "model": "claude-sonnet-4-5",
            "timestamp": 1_789_627_445_448i64,
            "content": [
                {"type": "text", "text": "done"},
                {"type": "toolCall", "id": "call_1", "name": "read", "arguments": {"path": "rules.md"}},
            ],
            "usage": {
                "input": 18_273,
                "output": 107,
                "cacheRead": 625,
                "cacheWrite": 0,
                "cost": {"input": 0.25, "output": 0.5, "cacheRead": 0.125, "cacheWrite": 0.125},
            },
        })]);

        match &messages[0] {
            ChatMessage::Assistant {
                usage,
                model_provider,
                model_id,
                started_at,
                ended_at,
                ..
            } => {
                assert_eq!(model_provider.as_deref(), Some("anthropic"));
                assert_eq!(model_id.as_deref(), Some("claude-sonnet-4-5"));
                assert_eq!(*started_at, Some(1_789_627_445_448));
                assert!(ended_at.is_none());
                match usage {
                    Some(usage) => {
                        assert_eq!(usage.input, 18_273);
                        assert_eq!(usage.output, 107);
                        assert_eq!(usage.cache_read, 625);
                        assert_eq!(usage.cache_write, 0);
                        assert_eq!(usage.cost_usd, 1.0);
                    }
                    None => panic!("the entry reports usage"),
                }
            }
            other => panic!("expected an assistant message, got {other:?}"),
        }

        match &messages[1] {
            ChatMessage::Tool {
                started_at,
                ended_at,
                intent,
                ..
            } => {
                assert!(started_at.is_none());
                assert!(ended_at.is_none());
                // The part states no intent, and none is invented for a call that never had one.
                assert!(intent.is_none());
            }
            other => panic!("expected a tool card, got {other:?}"),
        }
    }

    /// The regression this covers: a reopened conversation reported every turn as 0s, and - once the
    /// turn's own duration was fixed - its tok/s rate was still wrong, dividing by the whole answer
    /// with the wait for the first token in it, where the rate is defined over the decode that
    /// follows. The engine records both readings (`ttft` and `completedAt`, or `timestamp` plus
    /// `duration` when a record carries no completion), and the row carries them in the shape the
    /// live path uses: `startedAt` is the first token, `endedAt` the end of the answer.
    #[test]
    fn an_assistant_row_read_back_states_when_its_turn_finished() {
        let messages = normalize_messages(&[
            json!({
                "role": "user",
                "timestamp": 1_790_653_546_890i64,
                "content": [{"type": "text", "text": "hi"}],
            }),
            json!({
                "role": "assistant",
                "provider": "my",
                "model": "gpt-6-luna",
                "timestamp": 1_790_653_546_990i64,
                "ttft": 4_601.475f64,
                "duration": 5_057.82f64,
                "completedAt": 1_790_653_552_079i64,
                "content": [{"type": "text", "text": "hello"}],
            }),
        ]);

        match &messages[1] {
            ChatMessage::Assistant {
                started_at,
                ended_at,
                ..
            } => {
                // The window opens at the first token (the entry's `timestamp` plus the `ttft` it
                // measured) and closes at the completion: under half a second of decode, not the
                // five the turn spent before its first token arrived.
                assert_eq!(*started_at, Some(1_790_653_551_591));
                assert_eq!(*ended_at, Some(1_790_653_552_079));
                assert_eq!(ended_at.unwrap() - started_at.unwrap(), 488);
            }
            other => panic!("expected an assistant message, got {other:?}"),
        }
    }
    /// The regression this covers: `Todo` / `hub` / `Task` rows came back from a reopened
    /// conversation as bare titles with nothing beside them, while the same rows read normally
    /// while the turn ran. The words on those rows are the engine's intent, which it records on
    /// the call it belongs to (`ToolCallContent.intent`) - the same value the live
    /// `tool_execution_start` frame carries - and their arguments name nothing the row's
    /// presentation knows, so that one line is the whole row.
    #[test]
    fn a_recorded_call_reads_with_the_words_the_live_frame_sent() {
        let messages = normalize_messages(&[
            json!({
                "role": "assistant",
                "timestamp": 1_789_855_503_916i64,
                "content": [
                    {"type": "text", "text": "waiting"},
                    {
                        "type": "toolCall",
                        "id": "call_hub",
                        "name": "hub",
                        "arguments": {"i": "继续等待后端架构报告", "op": "wait", "timeout": 120},
                        "intent": "继续等待后端架构报告",
                    },
                    {
                        "type": "toolCall",
                        "id": "call_todo",
                        "name": "todo",
                        "arguments": {"i": "记录前后端架构勘察进度", "op": "init", "items": ["检查前端"]},
                        "intent": "记录前后端架构勘察进度",
                    },
                    {
                        "type": "toolCall",
                        "id": "call_read",
                        "name": "read",
                        "arguments": {"path": "rules.md"},
                    },
                ],
            }),
            json!({
                "role": "toolResult",
                "toolCallId": "call_hub",
                "toolName": "hub",
                "isError": false,
                "content": [{"type": "text", "text": "## Still Running (2)"}],
                "details": {"op": "wait", "jobs": [{"name": "BackendSurvey", "state": "running"}]},
            }),
        ]);

        let hub = serde_json::to_value(&messages[1]).expect("serialize");
        assert_eq!(hub["name"], "hub");
        assert_eq!(hub["intent"], "继续等待后端架构报告");
        assert_eq!(hub["state"], "success");
        assert_eq!(hub["resultText"], "## Still Running (2)");
        // What a `hub` result reports - the jobs it tracks, its meta - is not a row's business:
        // nothing else in the payload is projected, so a row draws these words and its result
        // text (`tool_details` takes a diff, a path and a subagent roster, and none of the three
        // is here).
        assert!(hub.get("details").is_none(), "{hub}");

        let todo = serde_json::to_value(&messages[2]).expect("serialize");
        assert_eq!(todo["intent"], "记录前后端架构勘察进度");
        assert_eq!(todo["state"], "running");

        // A call the engine recorded without an intent keeps the arguments a row can still read;
        // the missing field stays missing rather than becoming an empty string.
        let read = serde_json::to_value(&messages[3]).expect("serialize");
        assert!(read["intent"].is_null(), "{read}");
        assert!(
            read["argsText"]
                .as_str()
                .expect("arguments text")
                .contains("rules.md"),
            "{read}"
        );
    }

    /// A page that starts mid-turn holds the result of a call whose own message is on an earlier
    /// page. The row still draws what it reported; the arguments and the intent live on the call
    /// part, and neither is invented from a result.
    #[test]
    fn an_orphan_result_draws_what_it_reported_and_claims_nothing_else() {
        let messages = normalize_messages(&[json!({
            "role": "toolResult",
            "toolCallId": "call_read",
            "toolName": "read",
            "isError": false,
            "content": [{"type": "text", "text": "# Rules\n"}],
            "details": {"resolvedPath": r"C:\project\Omp-Desktop\rules.md"},
        })]);

        assert_eq!(messages.len(), 1);
        let row = serde_json::to_value(&messages[0]).expect("serialize");
        assert_eq!(row["name"], "read");
        assert_eq!(row["resultText"], "# Rules\n");
        assert_eq!(row["details"]["path"], r"C:\project\Omp-Desktop\rules.md");
        assert_eq!(row["argsText"], "");
        assert!(row["intent"].is_null(), "{row}");
    }

    /// A message without usage or model identity keeps those fields empty instead of
    /// fabricating a zero usage or an empty-string model.
    #[test]
    fn a_plain_history_row_reports_no_usage_and_no_model() {
        let messages = normalize_messages(&[json!({
            "role": "assistant",
            "content": "answer",
            "timestamp": 2i64,
        })]);
        match &messages[0] {
            ChatMessage::Assistant {
                usage,
                model_provider,
                model_id,
                ..
            } => {
                assert!(usage.is_none());
                assert!(model_provider.is_none());
                assert!(model_id.is_none());
            }
            other => panic!("expected an assistant message, got {other:?}"),
        }
    }

    /// The engine's own ending travels with the row it belongs to, under the name the frontend
    /// reads (`stopReason`), and a row whose turn ended normally states no reason at all - the
    /// field is additive, so "no reason" is the field's absence rather than a null.
    #[test]
    fn history_rows_state_the_engine_stop_reason() {
        let messages = normalize_messages(&[
            json!({
                "role": "assistant",
                "content": [{"type": "text", "text": "cut short"}],
                "stopReason": "aborted",
                "errorMessage": "Interrupted by user",
            }),
            json!({
                "role": "assistant",
                "content": [{"type": "text", "text": "plain"}],
                "stopReason": "",
            }),
        ]);

        let aborted = serde_json::to_value(&messages[0]).expect("serialize");
        assert_eq!(aborted["stopReason"], "aborted");
        assert_eq!(aborted["error"], "Interrupted by user");

        let plain = serde_json::to_value(&messages[1]).expect("serialize");
        assert!(plain.get("stopReason").is_none());
    }

    /// The stop reason travels with a history row, and it is engine text like the failure beside it:
    /// a reason that quotes a path must not put that path on the wire. The regression this covers:
    /// it was copied raw while its sibling `error` went through `sanitize_message`.
    ///
    /// The path is a home path rather than a drive path because that is the redaction the sanitizer
    /// applies on every platform - `is_drive_path` is Windows-only, the `/Users/`-style rule is not -
    /// so the assertion holds wherever the suite runs, not only where it was written.
    #[test]
    fn the_stop_reason_is_redacted_like_the_failure_beside_it() {
        let messages = normalize_messages(&[json!({
            "role": "assistant",
            "content": [{"type": "text", "text": "cut short"}],
            "stopReason": "aborted while reading /Users/user/.omp/agent.db",
        })]);
        let row = serde_json::to_value(&messages[0]).expect("serialize");
        let reason = row["stopReason"].as_str().expect("a reason");
        assert!(reason.contains("<path>"), "{reason}");
        assert!(!reason.contains("/Users/"), "{reason}");

        // A reason longer than a rendered field does not travel at the length it arrived in, and the
        // cut is written into the value: the sanitizer bounds what it rewrites, and `clamp_text`
        // bounds the reason itself, which is where the marker comes from.
        let long = normalize_messages(&[json!({
            "role": "assistant",
            "content": [{"type": "text", "text": "plain"}],
            "stopReason": "x".repeat(MAX_TEXT_CHARS + 1),
        })]);
        let row = serde_json::to_value(&long[0]).expect("serialize");
        let reason = row["stopReason"].as_str().expect("a reason");
        assert!(
            reason.ends_with("…(truncated)"),
            "a reason that was cut says so: {}",
            reason.len()
        );
        assert!(
            reason.chars().count() <= MAX_TEXT_CHARS + "\n…(truncated)".chars().count(),
            "and it is not longer than the bound it was cut to"
        );
    }

    /// A message the engine injected from outside the turn - the answer a background job or a
    /// subagent hands back, a peer's aside - is stored as a `custom` entry, and the live path draws
    /// it as the assistant row its own `message_start` opened. It reads the same way here: a
    /// reopened conversation must show the same deliveries the live one did. `display: false` is the
    /// engine saying the entry is context for the model rather than conversation, and that half
    /// stays out of the transcript.
    #[test]
    fn a_delivered_custom_message_reads_like_the_row_the_live_path_draws() {
        let messages = normalize_messages(&[
            json!({
                "role": "custom",
                "customType": "async-result",
                "content": "Job 3 finished: 2 files changed.",
                "display": true,
                "timestamp": 1_789_627_445_383i64,
            }),
            json!({
                "role": "custom",
                "customType": "checkpoint-active-reminder",
                "content": "A checkpoint is active.",
                "display": false,
            }),
        ]);
        assert_eq!(messages.len(), 1, "an engine-internal entry is not a row");
        let row = serde_json::to_value(&messages[0]).expect("serialize");
        assert_eq!(row["kind"], "assistant");
        assert_eq!(row["text"], "Job 3 finished: 2 files changed.");
        assert_eq!(row["at"], 1_789_627_445_383i64);
        // A delivery is not a model answer: it states no reason for stopping and reports no failure
        // (`stopReason` is additive and therefore absent, `error` is a plain nullable field).
        assert!(row.get("stopReason").is_none());
        assert!(row["error"].is_null());
    }

    /// The regression this covers: a user-invoked skill is stored as the same `custom` entry as a
    /// delivery, and reopening the conversation drew the expanded SKILL.md as an assistant answer.
    /// What the user wrote is the invocation, and that is the row a reopen has to show.
    #[test]
    fn a_skill_invocation_reads_back_as_the_users_own_row() {
        let messages = normalize_messages(&[json!({
            "role": "custom",
            "customType": "skill-prompt",
            "attribution": "user",
            "content": "# Deploy\nRun the script in scripts/.",
            "display": true,
            "details": {"name": "deploy", "args": "--now", "prompt": "/skill:deploy --now"},
            "timestamp": 1_789_627_445_383i64,
        })]);
        assert_eq!(messages.len(), 1);
        let row = serde_json::to_value(&messages[0]).expect("serialize");
        assert_eq!(row["kind"], "user");
        assert_eq!(row["text"], "/skill:deploy --now");
        assert_eq!(row["at"], 1_789_627_445_383i64);
        assert!(
            !row["text"]
                .as_str()
                .expect("text")
                .contains("Run the script"),
            "the skill body is the model's context, not the conversation"
        );
    }

    /// A user-role message the engine injected for the agent is not the reader's own prompt.
    ///
    /// IRC steers and automatic continuations are persisted as `user` with `attribution: "agent"` or
    /// `synthetic: true`; the live path never opens a reader row for them. Drawing them after a
    /// reload showed a sentence (the engine's steer template) the reader never typed.
    #[test]
    fn an_agent_injected_user_message_is_not_drawn_as_the_users_prompt() {
        let messages = normalize_messages(&[
            json!({
                "role": "user",
                "attribution": "agent",
                "steering": true,
                "content": [{"type": "text", "text": "<steer from parent>continue</steer>"}],
                "timestamp": 1_790_000_000_000i64,
            }),
            json!({
                "role": "user",
                "synthetic": true,
                "content": [{"type": "text", "text": "continue"}],
                "timestamp": 1_790_000_001_000i64,
            }),
            json!({
                "role": "user",
                "content": [{"type": "text", "text": "run the tests"}],
                "timestamp": 1_790_000_002_000i64,
            }),
        ]);
        assert_eq!(messages.len(), 1, "only the reader's own prompt is a row");
        let row = serde_json::to_value(&messages[0]).expect("serialize");
        assert_eq!(row["text"], "run the tests");
    }

    /// A subagent's transcript opens with its assignment, and that message is a row.
    ///
    /// The parent's `task` call writes what the child was asked as a user message attributed to the
    /// agent - the same shape a steer has, which is why the ordinary mapping hides it. Read as the
    /// child's own conversation, that sentence is the whole of its brief: the tab opening on the
    /// child's first answer is the regression this covers (2026-10-21, user report).
    #[test]
    fn a_subagent_transcript_keeps_the_assignment_it_opened_with() {
        let entries = [
            json!({
                "role": "user",
                "attribution": "agent",
                "content": [{"type": "text", "text": "Complete assignment thoroughly: # Target the repo"}],
                "timestamp": 1_790_000_000_000i64,
            }),
            json!({
                "role": "assistant",
                "content": [{"type": "text", "text": "I'll start by exploring."}],
                "timestamp": 1_790_000_001_000i64,
            }),
            json!({
                "role": "user",
                "attribution": "agent",
                "steering": true,
                "content": [{"type": "text", "text": "<steer from parent>hurry</steer>"}],
                "timestamp": 1_790_000_002_000i64,
            }),
        ];
        let messages = normalize_subagent_messages(&entries);
        assert_eq!(
            messages.len(),
            2,
            "the brief and the answer; the steer stays out"
        );
        let opening = serde_json::to_value(&messages[0]).expect("serialize");
        assert_eq!(opening["kind"], "user");
        assert_eq!(
            opening["text"],
            "Complete assignment thoroughly: # Target the repo"
        );

        // The same file read as a conversation keeps hiding it, so the two paths differ only where
        // the reader asked them to.
        let conversation = normalize_messages(&entries);
        assert_eq!(conversation.len(), 1);
    }

    /// The regression this covers: a prompt that carried a file read back from the transcript as its
    /// own words *plus* the `@<path>` line the host appended, so a reopened conversation showed a
    /// raw path where the reader had put a file. The files are named by those lines and nothing else
    /// in the transcript records them, so the read takes them back out of the words and answers with
    /// the attachments the row draws - and the composer's placeholders stay in the words, because
    /// they are where the files sit in the sentence.
    #[test]
    fn a_prompt_reads_back_with_the_files_it_carried() {
        let (path, word) = if cfg!(windows) {
            (r"C:\scratch\image.png", "看这张图")
        } else {
            ("/scratch/image.png", "看这张图")
        };
        let messages = normalize_messages(&[json!({
            "role": "user",
            "timestamp": 1_790_653_546_890i64,
            "content": [{"type": "text", "text": format!("\u{e000}{word}\n@{path}")}],
        })]);
        let row = serde_json::to_value(&messages[0]).expect("serialize");
        assert_eq!(row["text"], format!("\u{e000}{word}"));
        assert_eq!(row["attachments"][0]["path"], path);
        assert_eq!(row["attachments"][0]["name"], "image.png");
        // The file is not there, so its size is unknown rather than invented: nothing draws it.
        assert_eq!(row["attachments"][0]["bytes"], 0);

        // A prompt with no file keeps its own text exactly, and names nothing.
        let plain = normalize_messages(&[json!({
            "role": "user",
            "content": [{"type": "text", "text": "只是文字"}],
        })]);
        let row = serde_json::to_value(&plain[0]).expect("serialize");
        assert_eq!(row["text"], "只是文字");
        assert_eq!(row["attachments"].as_array().map(Vec::len), Some(0));
    }
}

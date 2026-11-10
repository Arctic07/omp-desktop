/**
 * The projector's own tests.
 *
 * A submodule rather than an inline block: `rules.md#single-file-line-limit` bounds a file at 1000 lines, and the
 * projection it exercises - the engine's frames read into the rows the feed draws - is the part
 * that keeps growing. Same split as `models/agent/tests.rs`.
 */
use serde_json::json;

use super::compaction::compaction_end_notice;
use super::*;
use crate::services::runtime::events::frames::{attach_ending, ends_turn, notice_frame};
use crate::services::runtime::DELTA_FLUSH_BYTES;

/// The message the engine stores for a user-invoked `/skill:<name>`: the expanded SKILL.md is
/// its content, because that is what the model has to read.
fn skill_prompt_message() -> Value {
    json!({
        "role": "custom",
        "customType": "skill-prompt",
        "attribution": "user",
        "display": true,
        "content": [{"type": "text", "text": "# Deploy\nRun the script in scripts/."}],
        "details": {"name": "deploy", "args": "--now", "prompt": "/skill:deploy --now"},
    })
}

/// The regression this covers: a skill invocation was read as a delivery, so the row the feed
/// opened for it carried the whole expanded SKILL.md instead of the draft the user typed. It is
/// the user's own turn, and the row it opens is the user's row.
#[test]
fn a_skill_invocation_opens_the_users_row() {
    let event = json!({"message": skill_prompt_message()});
    assert_eq!(message_role(&event), "user");

    let other_delivery = json!({"message": {"role": "custom", "display": true, "content": "hi"}});
    assert_eq!(message_role(&other_delivery), "assistant");
}

/// One developer message is drawn: the rule check that fired on a call. It explains a refusal the
/// reader watched happen, and every other injected developer message stays out (`reminder_text`).
#[test]
fn only_the_rule_check_among_developer_messages_is_drawn() {
    let rule_check = json!({
        "role": "developer",
        "content": [{
            "type": "text",
            "text": "<system-reminder reason=\"rule_violation\" rule=\"ts-no-any\" path=\"builtin-defaults:ts-no-any.md\">\nUser-defined rule matched tool-call arguments.\n</system-reminder>",
        }],
    });
    let event = json!({"message": rule_check});
    assert!(message_is_drawn(&event));
    assert_eq!(message_role(&event), "reminder");
    // The text travels whole: the reading of the tag belongs to the side that draws it.
    let text = crate::services::runtime::reminder_text(&rule_check).unwrap_or_default();
    assert!(text.starts_with("<system-reminder"));
    assert!(text.contains("ts-no-any"));

    for message in [
        // The eval runtime's own registry: the eval call's row already says everything it says.
        json!({"role": "developer", "content": [{"type": "text", "text": "<system-reminder>\nEval runtime state is host-retained.\n</system-reminder>"}]}),
        // A todo nudge: the panel is the list it is about.
        json!({"role": "developer", "content": "<system-reminder>\n3 todo items still open.\n</system-reminder>"}),
        // A reminder the model wrote about itself is prose, not an injected check.
        json!({"role": "developer", "content": "the engine wrote <system-reminder reason=\"rule_violation\">x</system-reminder>"}),
        json!({"role": "developer", "content": "context"}),
    ] {
        assert!(
            !message_is_drawn(&json!({"message": message})),
            "{message} is injected context"
        );
    }
}

/// Only the rows the transcript draws are announced: tool results repeat the tool frames, developer
/// messages are injected context, and an agent-authored user message is not the reader's prompt.
#[test]
fn only_conversation_messages_open_rows() {
    for message in [
        json!({"role": "user", "content": "go"}),
        json!({"role": "assistant", "content": "an answer"}),
        skill_prompt_message(),
        json!({"role": "custom", "display": true, "content": "a delivery"}),
    ] {
        assert!(
            message_is_drawn(&json!({"message": message})),
            "{message} is conversation"
        );
    }
    for message in [
        json!({"role": "toolResult", "toolCallId": "c1", "content": []}),
        json!({"role": "developer", "content": "context"}),
        json!({"role": "user", "attribution": "agent", "steering": true, "content": "steer"}),
        json!({"role": "user", "synthetic": true, "content": "continue"}),
        json!({"role": "custom", "display": false, "content": "context"}),
    ] {
        assert!(
            !message_is_drawn(&json!({"message": message})),
            "{message} is not conversation"
        );
    }
}

/// Nothing of the skill body is owed to that row: the invocation's own text is already there,
/// and the body is the model's context rather than the conversation's.
#[test]
fn a_skill_invocation_owes_no_body_text() {
    let mut state = EventState::new("session-1".to_owned());
    let message = skill_prompt_message();
    assert_eq!(
        state.message_end_repair(Some(&message), &[]),
        (String::new(), String::new())
    );

    let delivery = json!({"role": "custom", "display": true, "content": "a delivery"});
    assert_eq!(
        state.message_end_repair(Some(&delivery), &[]),
        ("a delivery".to_owned(), String::new())
    );
}

/// The regression this covers (2026-10-31): a `/skill:` turn redrew the expanded SKILL.md as an
/// assistant answer the moment its run ended.
///
/// The engine keeps an invocation as a `custom` entry, so the run's own record holds it like a
/// delivery, and `message_end` closes it as the user's row without recording it as closed (that row
/// is the reader's echo, written before the turn). The repair at `agent_end` then reads it as a
/// message nothing ever delivered and draws it - body and all - as the row the live path never
/// opened. Nothing of it is ever owed: its row already exists, whatever its own frames carried.
#[test]
fn a_skill_invocation_is_never_owed_a_row() {
    let mut message = skill_prompt_message();
    message["id"] = json!("entry-1");
    message["timestamp"] = json!(1_793_465_376_852i64);
    let run = [message];
    let owed: Vec<&Value> = unclosed_messages(&run, &std::collections::HashSet::new());
    assert!(owed.is_empty(), "{owed:?}");

    // A delivery in the same run is still owed: the exception is the invocation alone.
    let delivery =
        json!({"role": "custom", "display": true, "id": "entry-2", "content": "Job 3 finished."});
    let run = [run[0].clone(), delivery];
    let owed: Vec<&Value> = unclosed_messages(&run, &std::collections::HashSet::new());
    assert_eq!(owed.len(), 1, "{owed:?}");
    assert_eq!(owed[0]["id"], "entry-2");
}

/// An answer whose deltas never reached the UI is restored from the message the engine closed:
/// the host sheds queued increments under backpressure, so a message can end with nothing on
/// screen for it, and the frontend draws no row for an answer with nothing in it.
#[test]
fn an_answer_whose_deltas_were_lost_is_restored_when_the_message_ends() {
    let mut state = EventState::new("session-1".to_owned());
    let message = json!({
        "role": "assistant",
        "content": [
            {"type": "thinking", "thinking": "weighing it up"},
            {"type": "text", "text": "the answer"},
        ],
        "stopReason": "stop",
    });
    assert_eq!(
        state.message_end_repair(Some(&message), &["m1"]),
        ("the answer".to_owned(), "weighing it up".to_owned())
    );
    // The record is spent with the message: a message that reuses the id inherits nothing of this
    // one's stream, so its own words are owed whole rather than as a tail of them.
    assert_eq!(
        state.message_end_repair(Some(&message), &["m1"]),
        ("the answer".to_owned(), "weighing it up".to_owned())
    );
}

/// A stream that was cut short is completed with the part it never delivered, and nothing more:
/// the row already holds what did arrive.
#[test]
fn a_cut_short_stream_owes_only_its_tail() {
    let mut state = EventState::new("session-1".to_owned());
    state
        .streamed
        .entry("m1".to_owned())
        .or_default()
        .record(DeltaKind::Text, "the ans");
    let message = json!({"role": "assistant", "content": [{"type": "text", "text": "the answer"}]});
    assert_eq!(
        state.message_end_repair(Some(&message), &["m1"]),
        ("wer".to_owned(), String::new())
    );
}

/// A message the engine rewrote after streaming it owes nothing: its record no longer starts with
/// what the reader watched arrive, and appending it would show the answer twice.
#[test]
fn a_rewritten_message_owes_nothing() {
    let mut state = EventState::new("session-1".to_owned());
    state
        .streamed
        .entry("m1".to_owned())
        .or_default()
        .record(DeltaKind::Text, "the ans");
    let message = json!({"role": "assistant", "content": [{"type": "text", "text": "The answer"}]});
    assert_eq!(
        state.message_end_repair(Some(&message), &["m1"]),
        (String::new(), String::new())
    );
}

/// A delivery whose words did stream is not owed them a second time.
#[test]
fn a_delivery_that_streamed_owes_nothing() {
    let mut state = EventState::new("session-1".to_owned());
    state
        .streamed
        .entry("m1".to_owned())
        .or_default()
        .record(DeltaKind::Text, "a delivery");
    let message = json!({"role": "custom", "display": true, "content": "a delivery"});
    assert_eq!(
        state.message_end_repair(Some(&message), &["m1"]),
        (String::new(), String::new())
    );
}

/// The invocation is named the way the engine names it when a transcript is read back: the
/// draft as submitted first, then the name and arguments.
#[test]
fn the_invocation_reads_back_from_the_details() {
    let details = |value: Value| json!({"role": "custom", "details": value});
    assert_eq!(
        skill_prompt_text(&details(json!({"prompt": " /skill:deploy --now "}))),
        Some("/skill:deploy --now".to_owned())
    );
    assert_eq!(
        skill_prompt_text(&details(json!({"name": "deploy", "args": "--now"}))),
        Some("/skill:deploy --now".to_owned())
    );
    assert_eq!(
        skill_prompt_text(&details(json!({"name": "deploy"}))),
        Some("/skill:deploy".to_owned())
    );
    assert_eq!(skill_prompt_text(&details(json!({}))), None);
}

/// Drives the accumulation and delivery decision without a Tauri app: what matters here
/// is how often a burst crosses the boundary, not how the payload is written.
struct Burst {
    state: EventState,
    deliveries: usize,
    delivered_text: String,
}

impl Burst {
    fn new() -> Self {
        let state = EventState::new("session-1".to_owned());
        Self {
            state,
            deliveries: 0,
            delivered_text: String::new(),
        }
    }

    fn push(&mut self, now_ms: i64, delta: &str) {
        self.state.deltas.push("m1", DeltaKind::Text, delta);
        if self
            .state
            .should_deliver(DELTA_FLUSH_MS as i64, false, now_ms)
        {
            self.take(now_ms);
        }
    }

    fn take(&mut self, now_ms: i64) {
        self.deliveries += 1;
        for (_, buffer) in self.state.deltas.take(now_ms) {
            self.delivered_text.push_str(&buffer.text);
        }
    }
}

/// The blocker this covers: one delivery per token. A 100 ms burst of one token per
/// millisecond may cross the boundary at most once per window (plus the first one).
#[test]
fn a_token_burst_is_delivered_at_most_once_per_window() {
    let mut burst = Burst::new();
    let start = 1_000i64;
    for step in 0..=100i64 {
        burst.push(start + step, "tok");
    }
    let windows = 100 / DELTA_FLUSH_MS as usize;
    assert!(
        burst.deliveries <= windows + 1,
        "expected at most {} deliveries, saw {}",
        windows + 1,
        burst.deliveries
    );
    assert!(
        burst.deliveries >= 1,
        "the burst must be delivered at some point"
    );

    // Nothing may be lost: what was not delivered is still buffered.
    let buffered: usize = burst
        .state
        .deltas
        .buffers
        .values()
        .map(|buffer| buffer.text.len())
        .sum();
    assert_eq!(burst.delivered_text.len() + buffered, 101 * 3);
}

/// Within a window nothing is delivered; once it elapsed, the buffer is due.
#[test]
fn a_delta_inside_the_window_is_not_delivered_yet() {
    let mut state = EventState::new("session-1".to_owned());
    state.deltas.push("m1", DeltaKind::Text, "first");
    // The very first delta has no predecessor, so it is due immediately.
    assert!(state.should_deliver(DELTA_FLUSH_MS as i64, false, 1_000));
    state.deltas.take(1_000);
    assert!(!state.should_deliver(DELTA_FLUSH_MS as i64, false, 1_000));

    state.deltas.push("m2", DeltaKind::Text, "second");
    let window = DELTA_FLUSH_MS as i64;
    assert!(!state.should_deliver(DELTA_FLUSH_MS as i64, false, 1_000 + window - 1));
    assert!(state.should_deliver(DELTA_FLUSH_MS as i64, false, 1_000 + window));
}

/// A conversation nobody is looking at is delivered on the wider background window: its text is
/// still complete, just less often, so several parallel turns do not each cost a frame.
#[test]
fn a_background_conversation_is_delivered_on_the_wider_window() {
    let mut state = EventState::new("session-1".to_owned());
    state.deltas.push("m1", DeltaKind::Text, "first");
    state.deltas.take(1_000);
    state.deltas.push("m1", DeltaKind::Text, "second");
    let window = BACKGROUND_DELTA_FLUSH_MS as i64;
    assert!(!state.should_deliver(window, false, 1_000 + DELTA_FLUSH_MS as i64));
    assert!(state.should_deliver(window, false, 1_000 + window));
    // The window is a cadence, not a loss: the buffer holds everything since the last delivery.
    let batches = state.deltas.take(1_000 + window);
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].1.text, "second");
}

/// The watch flag is what chooses that window; a session starts on the display cadence and a
/// conversation the reader left drops to the background one.
#[test]
fn the_watch_flag_chooses_the_delivery_cadence() {
    let session = SessionRuntime::new("session-1".to_owned(), "cwd".to_owned(), Some(1), None);
    assert_eq!(delivery_window_ms(&session), DELTA_FLUSH_MS as i64);
    session.set_watched(false);
    assert_eq!(
        delivery_window_ms(&session),
        BACKGROUND_DELTA_FLUSH_MS as i64
    );
    session.set_watched(true);
    assert_eq!(delivery_window_ms(&session), DELTA_FLUSH_MS as i64);
}

/// A single oversized buffer is delivered without waiting for the window.
#[test]
fn the_frame_budget_ends_the_window_early() {
    let mut state = EventState::new("session-1".to_owned());
    state.deltas.push("m1", DeltaKind::Text, "start");
    state.deltas.take(1_000);
    state
        .deltas
        .push("m1", DeltaKind::Text, &"x".repeat(DELTA_FLUSH_BYTES));
    assert!(state.should_deliver(DELTA_FLUSH_MS as i64, false, 1_000));
}

/// The regression this covers: a tool that streams its own output (bash, a build) sent one frame
/// per tick, each carrying the whole partial result - so a minute-long call put hundreds of frames
/// on the wire, every one of them larger than the last. Held for the window, only the newest
/// payload per call is delivered, and the call's own frames stay in the order they were started in.
#[test]
fn a_tool_update_replaces_the_waiting_one_for_its_call() {
    let mut state = EventState::new("session-1".to_owned());
    // The first delivery of a quiet session is due at once, exactly like a first delta.
    state.buffer_tool_update(
        "call-1".to_owned(),
        json!({"type": "tool_updated", "resultText": "a"}),
    );
    assert!(state.should_deliver(DELTA_FLUSH_MS as i64, false, 1_000));
    state.deltas.take(1_000);
    assert_eq!(std::mem::take(&mut state.tool_updates).len(), 1);

    state.buffer_tool_update(
        "call-1".to_owned(),
        json!({"type": "tool_updated", "resultText": "ab"}),
    );
    state.buffer_tool_update(
        "call-1".to_owned(),
        json!({"type": "tool_updated", "resultText": "abc"}),
    );
    state.buffer_tool_update(
        "call-2".to_owned(),
        json!({"type": "tool_updated", "resultText": "x"}),
    );
    // The window has not elapsed, so nothing is due yet.
    assert!(!state.should_deliver(
        DELTA_FLUSH_MS as i64,
        false,
        1_000 + DELTA_FLUSH_MS as i64 - 1
    ));
    assert!(state.should_deliver(DELTA_FLUSH_MS as i64, false, 1_000 + DELTA_FLUSH_MS as i64));

    let waiting = std::mem::take(&mut state.tool_updates);
    assert_eq!(waiting.len(), 2, "one payload per call, not one per update");
    assert_eq!(waiting[0].0, "call-1");
    assert_eq!(waiting[0].1["resultText"], json!("abc"));
    assert_eq!(waiting[1].0, "call-2");
}

/// A terminal frame still carries everything the window was holding: the end of a call must never
/// be published before the last progress it reported.
#[test]
fn a_forced_delivery_drains_tool_updates_too() {
    let mut state = EventState::new("session-1".to_owned());
    state.deltas.push("m1", DeltaKind::Text, "answer");
    state.buffer_tool_update(
        "call-1".to_owned(),
        json!({"type": "tool_updated", "resultText": "out"}),
    );
    assert!(state.should_deliver(DELTA_FLUSH_MS as i64, true, 1_000));
    state.deltas.take(1_000);
    assert_eq!(std::mem::take(&mut state.tool_updates).len(), 1);
    assert!(!state.should_deliver(DELTA_FLUSH_MS as i64, true, 1_000));
}

/// Terminal events bypass the window, and a forced delivery always empties the buffer.
#[test]
fn a_terminal_event_delivers_everything_at_once() {
    let mut state = EventState::new("session-1".to_owned());
    state.deltas.push("m1", DeltaKind::Text, "hello ");
    state.deltas.push("m1", DeltaKind::Thinking, "thinking");
    state.deltas.push("m2", DeltaKind::Text, "world");
    assert!(state.should_deliver(DELTA_FLUSH_MS as i64, true, 1_000));
    let batches = state.deltas.take(1_000);
    assert_eq!(batches.len(), 2);
    assert!(state.deltas.is_empty());
    assert!(!state.should_deliver(DELTA_FLUSH_MS as i64, true, 1_000));
}

/// The regression this covers: a message the engine injected from outside the turn - a
/// background job's or a subagent's answer, a peer's aside - arrives as a `message_start` +
/// `message_end` pair with no deltas at all, so the row its announcement opened stayed empty and
/// a frontend that elides empty rows dropped it: the child's answer never reached the UI. The
/// end frame owes the text the deltas never carried, and it owes it once.
#[test]
fn a_whole_injected_message_is_owed_to_the_row_its_announcement_opened() {
    let mut state = EventState::new("session-1".to_owned());
    let message = json!({
        "id": "m-custom-1",
        "role": "custom",
        "customType": "async-result",
        "display": true,
        "content": "Job 3 finished: 2 files changed.",
    });
    let (text, thinking) = state.message_end_repair(Some(&message), &["m-custom-1"]);
    assert_eq!(text, "Job 3 finished: 2 files changed.");
    assert_eq!(thinking, "");
    assert!(
        state.streamed.is_empty(),
        "the id is spent here, so the record cannot outlive its message"
    );

    // A message whose text came as deltas owes nothing: the row already holds it, and delivering
    // the content as well would put the same words on screen twice.
    let mut streamed = EventState::new("session-1".to_owned());
    streamed
        .streamed
        .entry("m-2".to_owned())
        .or_default()
        .record(DeltaKind::Text, "hi");
    assert_eq!(
        streamed.message_end_repair(
            Some(&json!({"id": "m-2", "role": "custom", "display": true, "content": "hi"})),
            &["m-2"],
        ),
        (String::new(), String::new())
    );

    // `display: false` is the engine saying the entry is context for the model rather than
    // conversation, and a tool result is drawn from the tool execution frames. Neither is text
    // this frame owes. (An assistant message is the third case this frame answers for, and it
    // owes whatever its stream did not deliver - see the repair tests above.)
    for message in [
        json!({"id": "m-3", "role": "custom", "display": false, "content": "@file"}),
        json!({"id": "m-5", "role": "toolResult", "content": "result"}),
        // A delivery with nothing in it owes nothing either.
        json!({"id": "m-6", "role": "custom", "display": true, "content": []}),
        json!({"id": "m-7", "role": "custom", "display": true}),
    ] {
        let id = message["id"].as_str().expect("a fixture id").to_owned();
        assert_eq!(
            streamed.message_end_repair(Some(&message), &[id.as_str()]),
            (String::new(), String::new()),
            "{id} owes no text"
        );
    }
}

/// Both ways a message's words reach a row go through one frame, so the frontend needs one
/// reader for them and the shape of a delta is written down once.
#[test]
fn a_delta_and_a_whole_message_are_the_same_frame() {
    assert_eq!(
        delta_frame("m1", "hello".to_owned(), String::new()),
        json!({"type": "delta", "messageId": "m1", "textDelta": "hello", "thinkingDelta": null})
    );
    assert_eq!(
        delta_frame("m1", String::new(), "thinking".to_owned()),
        json!({"type": "delta", "messageId": "m1", "textDelta": null, "thinkingDelta": "thinking"})
    );
}

/// The roster's exit words and the projector's reason words are not the same vocabulary, and the
/// one translation that matters is `failed`: passed through as it is, `finish_turn` would read it as
/// the `_` arm and report a failed child as completed.
#[test]
fn a_roster_status_becomes_the_reason_a_message_can_state() {
    assert_eq!(roster_stop_reason("aborted"), "aborted");
    assert_eq!(roster_stop_reason("failed"), "error");
    assert_eq!(roster_stop_reason("completed"), "stop");
    assert_eq!(
        roster_stop_reason("a word this build has never seen"),
        "stop",
        "an unknown ending still closes the turn rather than failing the frame"
    );
}

/// The row the reader is looking at is where a stopped or failed turn has to say so: the turn's own
/// frame states the outcome, but the row is what carries the line, and the live path used to leave
/// it blank until the conversation was reopened and the transcript read back.
#[test]
fn a_message_frame_carries_why_its_answer_stopped() {
    let mut aborted = json!({"type": "message_finished", "messageId": "m1"});
    attach_ending(
        &mut aborted,
        Some(&json!({
            "role": "assistant",
            "stopReason": "aborted",
            "errorMessage": "Interrupted by user",
        })),
    );
    assert_eq!(aborted["stopReason"], "aborted");
    assert_eq!(aborted["error"], "Interrupted by user");

    let mut failed = json!({"type": "message_finished", "messageId": "m2"});
    attach_ending(
        &mut failed,
        Some(
            &json!({"role": "assistant", "stopReason": "error", "errorMessage": "  rate limited  "}),
        ),
    );
    assert_eq!(failed["stopReason"], "error");
    assert_eq!(
        failed["error"], "rate limited",
        "the engine's words are trimmed"
    );

    // A completion says nothing extra: the frame a frontend built before this field knows stays
    // exactly the frame it knew.
    let mut completed = json!({"type": "message_finished", "messageId": "m3"});
    attach_ending(
        &mut completed,
        Some(&json!({"role": "assistant", "stopReason": "stop"})),
    );
    assert_eq!(completed["stopReason"], "stop");
    assert!(completed.get("error").is_none());

    // A message that carries neither owes neither: an empty reason is not a reason.
    let mut plain = json!({"type": "message_finished", "messageId": "m4"});
    attach_ending(
        &mut plain,
        Some(&json!({"role": "assistant", "stopReason": "", "errorMessage": "   "})),
    );
    assert!(plain.get("stopReason").is_none());
    assert!(plain.get("error").is_none());
}

/// The engine's own identity pairs the frames of one message even when its ending never arrived:
/// `message_start`, its updates, `message_end` and the run's `agent_end` copy all carry it. A host
/// row id cannot pair anything - it is minted on this side and appears in no frame the engine writes.
#[test]
fn a_message_is_known_by_the_engines_own_key() {
    assert_eq!(
        message_key(&json!({"id": "m-1", "timestamp": 5})),
        Some("id:m-1".to_owned())
    );
    assert_eq!(
        message_key(&json!({"role": "assistant", "timestamp": 5})),
        Some("at:5".to_owned()),
        "a message with no id is still known by the moment the engine created it"
    );
    assert_eq!(message_key(&json!({"role": "assistant"})), None);
}

/// The regression this covers (2026-10-24): an answer whose own frames were lost never opened a
/// row, and the turn still ended normally - the reader saw a finished turn with no answer in it.
/// `agent_end` carries the run's messages, so the end of the run is where the hole is found: every
/// message with a row to draw that was never closed.
#[test]
fn a_run_owes_the_answer_it_never_closed() {
    let run = [
        json!({"role": "user", "timestamp": 1, "content": [{"type": "text", "text": "go"}]}),
        json!({"role": "assistant", "id": "a-1", "timestamp": 2, "content": [
            {"type": "toolCall", "id": "c1", "name": "read", "arguments": {}},
        ]}),
        json!({"role": "toolResult", "toolCallId": "c1", "timestamp": 3,
               "content": [{"type": "text", "text": "ok"}]}),
        json!({"role": "assistant", "id": "a-2", "timestamp": 4,
               "content": [{"type": "text", "text": "the answer"}]}),
    ];
    let owed: Vec<&Value> = unclosed_messages(&run, &std::collections::HashSet::new());
    assert_eq!(owed.len(), 1, "{owed:?}");
    assert_eq!(owed[0]["id"], "a-2");

    // Once its closing frame went out, the run owes nothing. A tool-only step and a result are not
    // rows of their own, so they are never owed in the first place.
    let mut finished = std::collections::HashSet::new();
    finished.insert(message_key(&run[3]).expect("a key"));
    assert!(unclosed_messages(&run, &finished).is_empty());
}

/// A message with nothing to draw would be a blank row, and `display: false` is the engine saying
/// the entry is context for the model rather than conversation: neither is owed.
#[test]
fn only_rows_with_something_to_draw_are_owed() {
    let run = [
        json!({"role": "assistant", "id": "a-1", "content": [{"type": "thinking", "thinking": " "}]}),
        json!({"role": "custom", "display": false, "id": "a-2", "content": "context"}),
        json!({"role": "assistant", "id": "a-3", "content": [{"type": "text", "text": "kept"}]}),
        json!({"role": "assistant", "id": "a-4", "errorMessage": "boom", "content": []}),
        json!({"role": "assistant", "id": "a-5",
               "content": [{"type": "image", "mimeType": "image/png", "data": "AA=="}]}),
    ];
    let owed: Vec<Value> = unclosed_messages(&run, &std::collections::HashSet::new())
        .into_iter()
        .map(|message| message["id"].clone())
        .collect();
    assert_eq!(owed, vec![json!("a-3"), json!("a-4"), json!("a-5")]);
}

/// What a repaired answer looks like on the wire: the words as the same `delta` a stream sends, then
/// the closing frame carrying the engine's usage and the reason the answer stopped. That pair is the
/// whole of what the reader was missing - the reported loss (2026-10-24) ended a turn normally with
/// no frame ever reaching the row, and the run's own record is what this frame pair is built from.
#[test]
fn a_repaired_answer_arrives_as_its_words_then_the_frame_that_took_them() {
    let message = json!({
        "role": "assistant",
        "content": [
            {"type": "thinking", "thinking": "checked"},
            {"type": "text", "text": "the answer"},
        ],
        "timestamp": 1_000,
        "completedAt": 2_000,
        "stopReason": "stop",
        "provider": "me",
        "model": "deepseek",
        "usage": {
            "input": 10,
            "output": 20,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 30,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
        },
    });
    let frames = close_frames(
        "m7",
        None,
        2_000,
        "the answer".to_owned(),
        "checked".to_owned(),
        Some(&message),
    );
    assert_eq!(frames.len(), 2, "{frames:?}");
    assert_eq!(
        frames[0],
        json!({
            "type": "delta",
            "messageId": "m7",
            "textDelta": "the answer",
            "thinkingDelta": "checked",
        }),
        "the row fills through the frame the streaming path uses"
    );
    let finished = &frames[1];
    assert_eq!(finished["type"], "message_finished");
    assert_eq!(finished["messageId"], "m7");
    assert_eq!(finished["endedAt"], 2_000);
    assert!(
        finished["startedAt"].is_null(),
        "a step this side never watched start has no clock of its own"
    );
    assert_eq!(finished["usage"]["output"], 20);
    assert_eq!(finished["modelProvider"], "me");
    assert_eq!(finished["modelId"], "deepseek");
    assert_eq!(
        finished["stopReason"], "stop",
        "the ending is what a completion has to state; without it the row would read as unfinished"
    );
    // The row is completed from these two fields, not from the deltas: a stream that was cut short
    // (or that this side never saw) still ends on the engine's whole message.
    assert_eq!(finished["text"], "the answer");
    assert_eq!(finished["thinking"], "checked");

    // A message that owes no words closes its row with the one frame: nothing empty is sent.
    let silent = close_frames("m8", None, 2_000, String::new(), String::new(), None);
    assert_eq!(silent.len(), 1);
    assert_eq!(silent[0]["type"], "message_finished");
    assert!(
        silent[0]["usage"].is_null(),
        "an unaccounted message reports no usage"
    );
    assert!(
        silent[0]["text"].is_null() && silent[0]["thinking"].is_null(),
        "a message with no words adds no text fields to replace the row with"
    );
}

/// A row id is a name the **frontend's record** answers to, and that record outlives the host
/// session which announced the row: a released conversation keeps its rows and merges the
/// transcript back into them, and the window survives a host restart. Two projectors of one
/// conversation therefore mint into the same record, and a counter alone started again from `m1` -
/// so a later message's frames landed in the rows of an earlier one (see `EventState::mint`).
#[test]
fn ids_are_unique_across_projectors_of_one_conversation() {
    let mut first = EventState::new("session-1".to_owned());
    let mut second = EventState::new("session-1".to_owned());
    let mut minted: Vec<String> = Vec::new();
    for _ in 0..3 {
        minted.push(first.next_row_id());
        minted.push(second.next_row_id());
    }
    let unique: std::collections::HashSet<&String> = minted.iter().collect();
    assert_eq!(
        unique.len(),
        minted.len(),
        "two projectors of one conversation minted the same row id: {minted:?}"
    );

    // A turn id names a turn a reader may still hold, so it carries the same identity.
    let mut third = EventState::new("session-1".to_owned());
    let mut fourth = EventState::new("session-1".to_owned());
    let turns = [third.new_turn_id(), fourth.new_turn_id()];
    assert_ne!(
        turns[0], turns[1],
        "two projectors of one conversation minted the same turn id: {turns:?}"
    );
}

/// The regression this covers (2026-10-30): an answer finished, the engine had nothing left to do
/// but wait on a background job, and the desktop kept drawing 「运行中」 with a clock under it — for
/// hours. The engine ends such a run with `isTerminal: false` (a result may still resume the
/// session) but also `awaitingAsyncWork: true`, which is its own word for "the turn is over, only a
/// job can wake me", and its TUI reads exactly this frame as idle. Treating every non-terminal end
/// as "still running" left the turn open forever whenever the wake never came — a cancelled or
/// suppressed job delivers none — and the stall watchdog will not reclaim a conversation that has
/// pending async work.
#[test]
fn a_run_waiting_only_on_background_work_ends_its_turn() {
    // The ordinary ending, and an end that carries no flag at all (an older host): both close.
    assert!(ends_turn(&json!({"type": "agent_end", "isTerminal": true})));
    assert!(ends_turn(&json!({"type": "agent_end"})));

    // A run the agent resumes by itself — a retry, a compaction continuation, a stop-time reminder —
    // is not an ending: closing there would end a row the turn is still filling.
    assert!(!ends_turn(&json!({
        "type": "agent_end",
        "isTerminal": false,
        "yielded": false,
    })));

    // An end whose run has already been replaced is not an ending for this turn: the host stamps
    // the engine's live reading, and a streaming session means a newer run owns the row.
    assert!(!ends_turn(&json!({
        "type": "agent_end",
        "isTerminal": true,
        "sessionStreaming": true,
    })));

    // Only a background result can resume this one, so the turn is over as far as the reader is
    // concerned; the job's own result opens the next turn when (and if) it arrives.
    assert!(ends_turn(&json!({
        "type": "agent_end",
        "isTerminal": false,
        "yielded": true,
        "awaitingAsyncWork": true,
    })));
}

/// A notice keeps the code its event carried, and one that carried none stays the two-field line it
/// always was.
///
/// The code is the page's suppression key and the only thing that tells two notices with the same
/// `level` apart: the idle recap arrives as a notice this host wrote (`engine_recap`), and the
/// projection used to rebuild every notice from `level` + `message` alone.
#[test]
fn a_notice_keeps_the_code_its_event_carried() {
    let recap = notice_frame(&json!({
        "type": "notice",
        "level": "info",
        "code": "engine_recap",
        "message": "Where things stand: the parser is fixed.",
    }));
    assert_eq!(recap["code"], "engine_recap");
    assert_eq!(recap["level"], "info");
    assert_eq!(recap["message"], "Where things stand: the parser is fixed.");

    // The engine's own notices carry no code, and none is invented for them.
    let engine =
        notice_frame(&json!({"type": "notice", "level": "warning", "message": "Mounted xd://lsp"}));
    assert_eq!(engine.get("code"), None);
    assert_eq!(engine["level"], "warning");

    // An empty code is not a code.
    let blank = notice_frame(&json!({"level": "info", "code": "", "message": "hi"}));
    assert_eq!(blank.get("code"), None);
}

/// A failure the reader asked for is the command's own line, not a second notice above the field.
///
/// `/compact` prints `Compaction failed: …` into the conversation (`host/src/slash.ts::commandReportCode`),
/// so a manual end that failed must leave the notice path silent. A pass nobody asked for - an
/// automatic compaction at a boundary, or one an endpoint performed - has no command line, and
/// the strip is the only place its failure exists.
#[test]
fn a_manual_compaction_failure_is_left_to_its_command_line() {
    let failed = json!({"errorMessage": "the summarizer exploded"});
    assert_eq!(
        compaction_end_notice("manual_compaction_end", &failed),
        None
    );

    // The same failure with an explicit `skipped: false` — the engine saying it did rewrite
    // something — still belongs to the command line, not to a success notice above the field.
    let failed_after_rewrite = json!({"errorMessage": "the summarizer exploded", "skipped": false});
    assert_eq!(
        compaction_end_notice("manual_compaction_end", &failed_after_rewrite),
        None
    );

    let notice = compaction_end_notice("auto_compaction_end", &failed).expect("a notice");
    assert_eq!(notice["level"], "warning");
    let message = notice["message"].as_str().expect("a string");
    assert!(message.contains("summarizer exploded"));

    // A manual pass with nothing to compact is only skipped: the engine still says so, on the code
    // the conversation's page suppresses, because the command's own line already carries the why.
    let skipped =
        json!({"skipped": true, "errorMessage": "Nothing to compact (session too small)"});
    let skipped_notice =
        compaction_end_notice("manual_compaction_end", &skipped).expect("a notice");
    assert_eq!(skipped_notice["code"], "engine_compaction_skipped");

    // A cancelled pass keeps its word even when the abort carried a sentence.
    let aborted = json!({"aborted": true, "errorMessage": "the reader stopped it"});
    let aborted_notice =
        compaction_end_notice("manual_compaction_end", &aborted).expect("a notice");
    assert_eq!(aborted_notice["code"], "engine_compaction_stopped");
}

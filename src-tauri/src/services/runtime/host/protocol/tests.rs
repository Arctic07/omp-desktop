//! The dispatcher's own tests: which lane a frame takes, and the shapes each handler can read.
//!
//! Split out of `protocol.rs` when it reached the 1000-line bound of `rules.md#single-file-line-limit` - the
//! frame vocabulary grows with every frame the host learns to compose, while the dispatcher
//! above it is settled. Same split as `services/runtime/events/tests.rs`,
//! `services/runtime/host/session/tests.rs` and `models/agent/tests.rs`: the assertions are
//! unchanged, and only this module is the part the application does not carry into the binary.

use serde_json::json;

use super::*;

/// One advertisement as the host sends it: an entry without a name is what the palette cannot
/// address, and the handler counts it rather than keeping a copy of the list (the list travels
/// in the session's state).
fn unusable(frame: &Value) -> usize {
    unusable_commands(frame).expect("the frame carries a commands array")
}

fn fake_session(id: &str) -> Arc<SessionRuntime> {
    Arc::new(SessionRuntime::new(
        id.to_owned(),
        "D:/ws".to_owned(),
        Some(1),
        None,
    ))
}

/// A session whose cursor is at `seq`, i.e. one that has already delivered `seq - 1` frames -
/// the state `session_open`'s `state.seq` anchor leaves it in mid-conversation.
fn session_at(id: &str, seq: u64) -> Arc<SessionRuntime> {
    let session = fake_session(id);
    session.set_expected_seq(seq);
    session
}

/// The cursor decision for one frame, spelled the way the dispatcher spells it.
fn order(session: &Arc<SessionRuntime>, frame: &Value, from_replay: bool) -> FrameOrder {
    session.accept_seq(frame.get("seq").and_then(Value::as_u64), from_replay)
}

/// The regression this covers: the host stamps **every** frame it publishes for a session
/// (`host/src/events.ts::#stamp`), the dedicated branches included. Accounting only for the
/// projected ones left the cursor at 4 after a `prompt_result`, so the `state` frame the host
/// sends next arrived "ahead" of it - a replay was asked for and the live frame was dropped
/// before it could be projected. The frames here are shaped exactly as the fanout sends them.
#[test]
fn a_prompt_result_carries_the_sequence_the_state_frame_after_it_continues() {
    let session = session_at("s00000000000000ff", 4);
    let prompt_result = json!({
        "type": "prompt_result",
        "sessionId": "s00000000000000ff",
        "seq": 4,
        "agentInvoked": true,
    });
    assert_eq!(order(&session, &prompt_result, false), FrameOrder::Next);
    assert_eq!(session.expected_seq(), 5);

    // The state frame that follows is the next one, not a hole: no replay, nothing dropped.
    let state = json!({
        "type": "state",
        "sessionId": "s00000000000000ff",
        "seq": 5,
        "state": {"isStreaming": true},
    });
    assert_eq!(order(&session, &state, false), FrameOrder::Next);
    assert_eq!(session.expected_seq(), 6);
    assert_eq!(session.last_frame_seq(), 5);
}

/// A frame type that is recognized and not projected carries a `seq` too, so it has to move the
/// cursor exactly like a projected one - otherwise every `advisor_cost_changed` or
/// `tool_stream_update` would make the frame after it look like a hole.
#[test]
fn an_ignored_frame_advances_the_cursor_like_a_projected_one() {
    let session = session_at("s00000000000000ff", 2);
    let ignored =
        json!({"type": "advisor_cost_changed", "sessionId": "s00000000000000ff", "seq": 2});
    assert_eq!(order(&session, &ignored, false), FrameOrder::Next);
    let event = json!({"type": "message_start", "sessionId": "s00000000000000ff", "seq": 3});
    assert_eq!(order(&session, &event, false), FrameOrder::Next);
    assert_eq!(session.expected_seq(), 4);
}

/// A real hole is still reported, and the cursor stays where it was so the replay asks for the
/// first frame that never arrived. A frame older than the cursor is dropped rather than
/// projected twice, and a frame without a `seq` claims nothing.
#[test]
fn a_missing_frame_leaves_the_cursor_for_the_replay() {
    let session = session_at("s00000000000000ff", 4);
    assert_eq!(session.accept_seq(Some(4), false), FrameOrder::Next);
    assert_eq!(session.accept_seq(Some(9), false), FrameOrder::Gap);
    assert_eq!(session.expected_seq(), 5, "a gap must not move the cursor");
    assert_eq!(session.accept_seq(Some(4), false), FrameOrder::Duplicate);
    // The replay hands the journal back in the order it was written, so a frame ahead of the
    // cursor is delivered rather than triggering the repair again.
    assert_eq!(session.accept_seq(Some(9), true), FrameOrder::Next);
    assert_eq!(session.expected_seq(), 10);
    assert_eq!(session.accept_seq(None, false), FrameOrder::Next);
    assert_eq!(session.expected_seq(), 10);
}

/// The regression this covers: a `host_shutdown` sent without an `id` is answered with
/// `id: null`, and every such acknowledgement was read as the host reporting a protocol-level
/// failure - an `ENGINE_PROTOCOL` error on each streaming session and one unknown frame per
/// reply. Only a refusal belongs to the sessions; an acknowledgement is counted and dropped.
#[test]
fn an_acknowledgement_without_an_id_is_not_a_protocol_failure() {
    assert!(!unattributed_failure(
        &json!({"type": "response", "id": null, "success": true, "data": {"closed": true}})
    ));
    assert!(unattributed_failure(
        &json!({"type": "response", "id": null, "success": false, "error": "busy"})
    ));
    // No `success` at all is not a success either.
    assert!(unattributed_failure(
        &json!({"type": "response", "id": null})
    ));
}

#[test]
fn an_advertisement_without_a_name_is_counted() {
    let frame = json!({"type": "available_commands_update", "commands": [
        {"name": "compact", "description": "Compact", "aliases": ["c"], "input": {"hint": "level"}, "source": "builtin"},
        {"name": "deploy", "description": "Deploy", "source": "extension"},
        {"description": "no name"},
        {"name": ""},
    ]});
    assert_eq!(
        unusable(&frame),
        2,
        "a command nothing can address is counted"
    );
    assert!(
        unusable_commands(&json!({"type": "available_commands_update"})).is_none(),
        "an advertisement with no list at all is a frame this handler cannot use"
    );
}

/// The regression this covers: the replay loop classified a journal entry as `state` or as an
/// engine event, so a journaled `subagent` frame went to the projector - whose catch-all
/// answered `false` and dropped it, *after* the cursor had already moved past it. The host
/// journals every frame before shedding it and sheds progress frames, so the frames a replay
/// exists to repair were exactly the ones it discarded: a shed lifecycle edge left the roster
/// reading `running` for the rest of the session. A replay is now routed frame for frame the
/// way the live stream is, so the roster lane settles the row.
#[test]
fn a_replayed_lifecycle_frame_settles_the_roster_row() {
    // The live path's answer for the type, which the replay now shares.
    assert_eq!(routing::route_of("subagent"), Route::Roster);

    let session = fake_session("s00000000000000ff");
    // The same frame the host journals, read by the same code the handler reads it with. The
    // frame is bound to a name because what comes back borrows from it.
    let half = |status: &str| {
        json!({
            "type": "subagent",
            "sessionId": "s00000000000000ff",
            "seq": 9,
            "kind": "lifecycle",
            "payload": {"id": "a7f3c1", "agent": "scout", "status": status, "index": 0},
        })
    };
    let started_frame = half("started");
    let (kind, payload) = subagent_half(&started_frame).expect("a known half");
    assert_eq!(kind, "lifecycle");
    // What `events::on_subagent` does with what the router hands it: the merge, minus the
    // frontend emit (which needs an app handle this harness does not have). The row is the
    // part the cursor gate could not repair before.
    let started = session
        .merge_subagent(kind, payload, 1_000)
        .expect("a child nobody has seen is a row");
    assert_eq!(started.status, "running");

    let settled_frame = half("completed");
    let (kind, payload) = subagent_half(&settled_frame).expect("a known half");
    let settled = session
        .merge_subagent(kind, payload, 2_000)
        .expect("settling a child changes the row");
    assert_eq!(
        settled.status, "completed",
        "a replayed lifecycle edge settles the row instead of being dropped"
    );

    // A kind this build does not know is neither a row nor a silent drop: the handler counts
    // it, and no half-row is published for it.
    assert!(subagent_half(&json!({"type": "subagent", "kind": "gossip"})).is_none());
    // A type neither table nor lane knows lands in the one arm that counts and logs it.
    assert_eq!(routing::route_of("host_pigeon"), Route::Unregistered);
}

/// The regression this covers: a forwarded child event that cannot be addressed.
///
/// The child is named twice - its id and the transcript it is stored in - and the channel the
/// event is published on is derived from the file alone. A frame missing either half, or the
/// event itself, is counted as a loss rather than guessed at: publishing into whichever channel
/// a half-frame suggested is how one conversation's rows end up in another's window.
#[test]
fn a_forwarded_child_event_needs_an_agent_a_file_and_an_event() {
    // The live path's answer for the type, and the lane that publishes it: not the parent's
    // roster merge, and not the projector (the event is the child's own, on the child's
    // channel).
    assert_eq!(routing::route_of("subagent_event"), Route::SubagentEvent);

    let frame = json!({
        "type": "subagent_event",
        "agentId": "a7f3c1",
        "sessionFile": "D:/store/sessions/parent/a7f3c1.jsonl",
        "event": {"type": "tool_execution_start", "toolName": "grep"},
    });
    let (agent_id, file, event) = subagent_event_parts(&frame).expect("three facts");
    assert_eq!(agent_id, "a7f3c1");
    assert_eq!(file, "D:/store/sessions/parent/a7f3c1.jsonl");
    // The event reaches the frontend as the engine published it: this side only wraps it.
    assert_eq!(
        event.get("type").and_then(Value::as_str),
        Some("tool_execution_start")
    );

    for missing in ["agentId", "sessionFile", "event"] {
        let mut hole = frame.clone();
        hole.as_object_mut().expect("an object").remove(missing);
        assert!(subagent_event_parts(&hole).is_none(), "{missing} missing");
    }
    // An empty id is a missing one, and a null event is a frame with nothing to forward.
    assert!(subagent_event_parts(&json!({
        "agentId": "",
        "sessionFile": "D:/store/sessions/parent/a7f3c1.jsonl",
        "event": {},
    }))
    .is_none());
    assert!(subagent_event_parts(&json!({
        "agentId": "a7f3c1",
        "sessionFile": "D:/store/sessions/parent/a7f3c1.jsonl",
        "event": null,
    }))
    .is_none());
}

/// The regression this covers: a settled child read as running again.
///
/// The child's own progress frames are the last thing to arrive - a tail of output, the closing
/// counts - and the word inside them is the child's own (`active`, `running`), not the roster's.
/// Writing it into the same field the lifecycle edge settled let a finished child be put back
/// on the live strip for good: the row kept its spinner, the session's working reading never
/// fell, and the stop control it drew cancelled nothing, which is what the host answers with
/// `aborted:false`. The assertions below are that ending, its outcome, and the two readings a
/// live child's own word gets.
#[test]
fn a_settled_row_is_not_put_back_on_the_roster_by_its_own_progress() {
    let session = fake_session("s00000000000000fe");
    let lifecycle = |status: &str| {
        json!({
            "type": "subagent",
            "sessionId": "s00000000000000fe",
            "kind": "lifecycle",
            "payload": {"id": "b21d90", "agent": "scout", "status": status, "index": 0},
        })
    };
    // A progress half carries more than its status; the count rides along so a merge that
    // changes something is distinguishable from one the row already agreed with.
    let progress = |status: &str, tool_count: i64| {
        json!({
            "type": "subagent",
            "sessionId": "s00000000000000fe",
            "kind": "progress",
            "payload": {
                "id": "b21d90",
                "agent": "scout",
                "progress": {"id": "b21d90", "status": status, "toolCount": tool_count},
            },
        })
    };
    let merge = |frame: &Value| {
        let (kind, payload) = subagent_half(frame).expect("a known half");
        session.merge_subagent(kind, payload, 3_000)
    };

    let started_frame = lifecycle("started");
    assert_eq!(
        merge(&started_frame)
            .expect("a started child is a row")
            .status,
        "running"
    );
    let live_progress = progress("active", 3);
    let live = merge(&live_progress).expect("a live child's own report changes its row");
    assert_eq!(
        live.status, "running",
        "a word outside the roster's own vocabulary is the running state it describes"
    );
    assert_eq!(
        live.tool_count,
        Some(3),
        "the counts on that frame are kept"
    );

    let settled_frame = lifecycle("completed");
    assert_eq!(
        merge(&settled_frame)
            .expect("settling a child changes the row")
            .status,
        "completed"
    );
    let late_tail = progress("running", 9);
    let late = merge(&late_tail).expect("a child's tail is still reported after it ended");
    assert_eq!(
        late.status, "completed",
        "the lifecycle edge is what ends a child; a later progress frame cannot reopen it"
    );
    assert_eq!(
        late.tool_count,
        Some(9),
        "what that tail does say about the child is kept"
    );
}

#[test]
fn a_frame_without_a_command_array_is_recognized_but_unusable() {
    assert!(unusable_commands(&json!({"type": "available_commands_update"})).is_none());
}

/// The regression this covers: the host reports an engine failure as
/// `{type:"error", level, message}`, while a rejected command answers with `error` inside its
/// response envelope. Reading only the second spelling replaced every engine message - the
/// actionable "No model selected." included - with the fallback sentence.
#[test]
fn an_engine_failure_keeps_the_message_it_arrived_with() {
    let event = json!({
        "type": "error",
        "level": "error",
        "message": "No model selected.\n\nUse /login, set an API key environment variable, or create D:\\Data\\agent.db\n\nThen use /model to select a model.",
    });
    let text = error_text(&event, "The engine reported an error.");
    assert!(text.starts_with("No model selected."), "{text}");
    assert!(text.contains("Use /login"), "{text}");
    // Paths inside it are still redacted, and the sentence around them survives.
    assert!(text.contains("<path>"), "{text}");
    assert!(!text.contains("D:\\Data"), "{text}");

    // The response spelling still works, and an empty frame still gets the fallback.
    assert_eq!(
        error_text(&json!({"error": "The session is busy."}), "fallback"),
        "The session is busy."
    );
    assert_eq!(
        error_text(&json!({"type": "error"}), "fallback"),
        "fallback"
    );
    assert_eq!(
        error_text(&json!({"message": "", "error": "x"}), "fallback"),
        "x"
    );
}

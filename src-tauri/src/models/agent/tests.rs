//! Wire contract of the agent models: one test per field group the frontend reads by name.
//!
//! Split out of `agent.rs` when it outgrew one file (`rules.md#single-file-line-limit`); the assertions and the paths
//! inside them are unchanged - these are the only lines of that module the application does not
//! carry into the binary.

use super::*;
use crate::services::runtime::PROTOCOL_VERSION;

use super::form::UiFormValue;

/// An ask answer is one of two documents, and nothing else: a submission carries one result per
/// question (the engine refuses a count that does not match), a chat answer carries none. The
/// names are the ones the host reads back (`selectedOptions`, `customInput`, `timedOut`), so a
/// rename here would leave the answer half-empty on the engine's side.
#[test]
fn ask_responses_keep_the_two_documents_and_the_wire_names() {
    let submitted = UiResponse {
        kind: Some("submit".to_owned()),
        results: Some(vec![UiAskResult {
            id: "skill_name".to_owned(),
            question: "What is it called?".to_owned(),
            options: vec!["api-review".to_owned()],
            multi: false,
            selected_options: vec!["api-review".to_owned()],
            custom_input: Some("api-review".to_owned()),
            note: None,
            timed_out: Some(true),
        }]),
        ..UiResponse::default()
    };
    assert!(submitted.validate("ask").is_ok());
    // The answer is serialized as it travels to the engine, which is where the names matter;
    // a `UiResponse` itself only ever arrives from the frontend.
    let row = serde_json::to_value(submitted.results.as_ref().expect("results")[0].clone())
        .expect("serialize");
    let row = &row;
    assert_eq!(row["selectedOptions"], serde_json::json!(["api-review"]));
    assert_eq!(row["customInput"], serde_json::json!("api-review"));
    assert_eq!(row["timedOut"], serde_json::json!(true));

    let chat = UiResponse {
        kind: Some("chat".to_owned()),
        ..UiResponse::default()
    };
    assert!(chat.validate("ask").is_ok());

    let shapeless = UiResponse {
        kind: Some("submit".to_owned()),
        ..UiResponse::default()
    };
    assert!(shapeless.validate("ask").is_err());
    // A submission is not a `value` answer, and the shape gate rejects it as one.
    assert!(shapeless.validate("select").is_err());
}

/// The role table is what the settings page renders field by field
/// (`src/utils/agentTypes.ts`): the two multi-word fields are renamed on the wire and the rest
/// keep their snake_case source names, which are all single words. A rename here would leave
/// the panel reading `undefined`.
#[test]
fn the_role_table_keeps_the_wire_names_the_panel_reads() {
    let table = serde_json::to_value(ModelRoleTable {
        roles: vec![ModelRoleRow {
            id: "default".to_owned(),
            tag: None,
            name: "Default".to_owned(),
            section: "chat".to_owned(),
            configured: true,
            value: Some("anthropic/claude-sonnet-4-5:high".to_owned()),
            source: "global".to_owned(),
            model: Some(ModelRoleModel {
                provider: "anthropic".to_owned(),
                id: "claude-sonnet-4-5".to_owned(),
                name: "Claude Sonnet 4.5".to_owned(),
            }),
            thinking_level: Some("high".to_owned()),
            auto_selected: false,
        }],
    })
    .expect("serialize");
    assert_eq!(
        table,
        serde_json::json!({
            "roles": [{
                "id": "default",
                "tag": null,
                "name": "Default",
                "section": "chat",
                "configured": true,
                "value": "anthropic/claude-sonnet-4-5:high",
                "source": "global",
                "model": {
                    "provider": "anthropic",
                    "id": "claude-sonnet-4-5",
                    "name": "Claude Sonnet 4.5",
                },
                "thinkingLevel": "high",
                "autoSelected": false,
            }],
        })
    );
}

/// The two level lists are a wire contract of the same kind: the model rows and the session
/// state both spell the field `thinkingLevels`, so a rename or a case change here would leave
/// whichever picker reads it with `undefined` and nothing on either side to notice. The session
/// state's list carries `auto` in front of the levels the model itself takes, and an empty list
/// serializes as `[]` rather than being skipped: "this model has no controllable effort
/// surface" is a fact the picker acts on, not a field this build forgot to send.
#[test]
fn level_lists_keep_the_wire_names_the_pickers_read() {
    let model = serde_json::to_value(EngineModel {
        provider: "anthropic".to_owned(),
        id: "claude-sonnet-4-5".to_owned(),
        name: "Claude Sonnet 4.5".to_owned(),
        context_window: 200_000,
        max_tokens: 64_000,
        supports_images: true,
        reasoning: true,
        thinking_levels: vec!["off".to_owned(), "low".to_owned()],
    })
    .expect("serialize");
    assert_eq!(model["thinkingLevels"], serde_json::json!(["off", "low"]));

    let state = serde_json::to_value(SessionRuntimeState {
        session_id: "s01a2b3c4".to_owned(),
        tip_entry_id: None,
        model_provider: Some("anthropic".to_owned()),
        model_id: Some("claude-sonnet-4-5".to_owned()),
        thinking_level: Some("low".to_owned()),
        thinking_levels: vec!["auto".to_owned(), "off".to_owned(), "low".to_owned()],
        is_streaming: false,
        is_compacting: false,
        modes: serde_json::json!({}),
        retry: None,
        message_count: 0,
        context_tokens: 0,
        context_window: 0,
        context_percent: 0.0,
        auto_compact_percent: None,
        context_categories: ContextCategories::default(),
        context_anchored: false,
        session_usage: SessionUsageTotals::default(),
        commands: Vec::new(),
        interrupted: false,
        pending_async_work: false,
        cancellable_subagents: 0,
        last_event_at: 0,
        background_jobs: Vec::new(),
        todo_phases: Vec::new(),
    })
    .expect("serialize");
    assert_eq!(
        state["thinkingLevels"],
        serde_json::json!(["auto", "off", "low"])
    );
    assert_eq!(state["thinkingLevel"], "low");
}

/// The todo list's own wire names, which `src/utils/agentTypes.ts` and the dock read by name:
/// a phase is a `name` with `tasks`, a task is a `content` with a `status`, and the empty list
/// is not a field at all.
#[test]
fn todo_phases_keep_their_wire_names_and_hide_when_empty() {
    let empty = serde_json::to_value(SessionRuntimeState {
        session_id: "s01a2b3c4".to_owned(),
        tip_entry_id: None,
        model_provider: None,
        model_id: None,
        thinking_level: None,
        thinking_levels: Vec::new(),
        is_streaming: false,
        is_compacting: false,
        modes: serde_json::json!({}),
        retry: None,
        message_count: 0,
        context_tokens: 0,
        context_window: 0,
        context_percent: 0.0,
        auto_compact_percent: None,
        context_categories: ContextCategories::default(),
        context_anchored: false,
        session_usage: SessionUsageTotals::default(),
        commands: Vec::new(),
        interrupted: false,
        pending_async_work: false,
        cancellable_subagents: 0,
        last_event_at: 0,
        background_jobs: Vec::new(),
        todo_phases: Vec::new(),
    })
    .expect("serialize");
    assert!(empty.get("todoPhases").is_none());

    let phases = serde_json::to_value(SessionRuntimeState {
        session_id: "s01a2b3c4".to_owned(),
        tip_entry_id: None,
        model_provider: None,
        model_id: None,
        thinking_level: None,
        thinking_levels: Vec::new(),
        is_streaming: false,
        is_compacting: false,
        modes: serde_json::json!({}),
        retry: None,
        message_count: 0,
        context_tokens: 0,
        context_window: 0,
        context_percent: 0.0,
        auto_compact_percent: None,
        context_categories: ContextCategories::default(),
        context_anchored: false,
        session_usage: SessionUsageTotals::default(),
        commands: Vec::new(),
        interrupted: false,
        pending_async_work: false,
        cancellable_subagents: 0,
        last_event_at: 0,
        background_jobs: Vec::new(),
        todo_phases: vec![TodoPhase {
            name: "Foundation".to_owned(),
            tasks: vec![
                TodoItem {
                    content: "Scaffold crate".to_owned(),
                    status: TodoStatus::InProgress,
                    blocker: None,
                },
                TodoItem {
                    content: "Write the migration".to_owned(),
                    status: TodoStatus::Blocked,
                    blocker: Some("waiting on the engine release".to_owned()),
                },
            ],
        }],
    })
    .expect("serialize");
    assert_eq!(phases["todoPhases"][0]["name"], "Foundation");
    assert_eq!(
        phases["todoPhases"][0]["tasks"][0]["content"],
        "Scaffold crate"
    );
    assert_eq!(phases["todoPhases"][0]["tasks"][0]["status"], "in_progress");
    assert!(phases["todoPhases"][0]["tasks"][0].get("blocker").is_none());
    assert_eq!(
        phases["todoPhases"][0]["tasks"][1]["blocker"],
        "waiting on the engine release"
    );
}

/// The four additive host fields are a wire contract the frontend declares by name
/// (`src/utils/agentTypes.ts`): a rename or a case change here would leave the settings page
/// reading `undefined` with nothing on either side to notice it. `hostStatus` is also the only
/// place "never started" and "gave up after repeated crashes" differ.
#[test]
fn the_host_counters_keep_their_wire_names() {
    let status = RuntimeStatus {
        engine_path: String::new(),
        engine_version: String::new(),
        protocol_version: PROTOCOL_VERSION,
        data_root: String::new(),
        agent_dir: String::new(),
        credential_backend: String::new(),
        engine_verified: false,
        engine_error: None,
        host_version: None,
        sdk_version: None,
        live_sessions: 0,
        data_root_host: String::new(),
        host_status: "degraded",
        unknown_frames: 3,
        dropped_frames: 1,
        replay_attempts: 2,
        processes: Vec::new(),
    };
    let json = serde_json::to_value(&status).expect("serialize");
    assert_eq!(json["hostStatus"], "degraded");
    assert_eq!(json["unknownFrames"], 3);
    assert_eq!(json["droppedFrames"], 1);
    assert_eq!(json["replayAttempts"], 2);
}

/// The global runtime channel is a wire contract: `reason` is a stable token the
/// frontend localizes, and a probe process reports a null workspace.
#[test]
fn runtime_events_serialize_as_stable_tokens() {
    let exit = serde_json::to_value(RuntimeEvent::EngineExit {
        workspace_id: None,
        reason: EngineExitReason::StartupFailed,
    })
    .expect("serialize");
    assert_eq!(
        exit,
        serde_json::json!({
            "type": "engine_exit",
            "workspaceId": null,
            "reason": "startup_failed",
        })
    );

    let ready = serde_json::to_value(RuntimeEvent::EngineReady {
        workspace_id: Some(7),
    })
    .expect("serialize");
    assert_eq!(
        ready,
        serde_json::json!({"type": "engine_ready", "workspaceId": 7})
    );

    let restarted = serde_json::to_value(RuntimeEvent::EngineExit {
        workspace_id: Some(7),
        reason: EngineExitReason::Restart,
    })
    .expect("serialize");
    assert_eq!(restarted["reason"], "restart");
}

/// The two payloads of a history read are a wire contract with
/// `src/utils/agentTypes.ts`: a chunk carries its kind beside the counters, and the answer
/// carries the rows beside the engine's total.
#[test]
fn history_payloads_serialize_in_the_shape_the_frontend_reads() {
    let chunk = serde_json::to_value(HistoryChunk::Progress(HistoryProgress {
        loaded: 3,
        total: 9,
    }))
    .expect("serialize");
    assert_eq!(
        chunk,
        serde_json::json!({"kind": "progress", "loaded": 3, "total": 9})
    );

    // A page of rows is its own kind beside the same counters, and the reset flag is only on the
    // wire when it is true - a caller that does not paint while reading reads none of this.
    let rows = serde_json::to_value(HistoryChunk::Rows {
        messages: Vec::new(),
        loaded: 2,
        total: 9,
        reset: false,
    })
    .expect("serialize");
    assert_eq!(
        rows,
        serde_json::json!({"kind": "rows", "messages": [], "loaded": 2, "total": 9})
    );
    let reset = serde_json::to_value(HistoryChunk::Rows {
        messages: Vec::new(),
        loaded: 0,
        total: 0,
        reset: true,
    })
    .expect("serialize");
    assert_eq!(reset["reset"], serde_json::json!(true));

    let history = serde_json::to_value(SessionHistory {
        messages: Vec::new(),
        total_messages: 7,
    })
    .expect("serialize");
    assert_eq!(
        history,
        serde_json::json!({"messages": [], "totalMessages": 7})
    );
}

/// A read mark is a wire contract with `src/utils/agentTypes.ts`, and the status text inside it
/// is also what the store puts in `session_reads.status`: one declaration serves both
/// directions, so a status added to the enum cannot be stored under a name nothing reads back.
#[test]
fn read_marks_carry_the_stored_status_names_the_frontend_reads() {
    for status in [
        SessionColdStatus::Complete,
        SessionColdStatus::Interrupted,
        SessionColdStatus::Aborted,
        SessionColdStatus::Error,
        SessionColdStatus::Pending,
        SessionColdStatus::Unknown,
    ] {
        let name = serde_json::to_value(status).expect("serialize");
        assert_eq!(name.as_str(), Some(status.wire()));
        assert_eq!(SessionColdStatus::from_wire(status.wire()), Some(status));
    }
    // Text a row could hold without this build having written it: no status, not an error.
    assert_eq!(SessionColdStatus::from_wire("Complete"), None);
    assert_eq!(SessionColdStatus::from_wire(""), None);

    let mark = serde_json::to_value(SessionReadMark {
        session_id: "s01a2b3c4".to_owned(),
        status: SessionColdStatus::Interrupted,
        seen_at: 1_700_000_000_000,
    })
    .expect("serialize");
    assert_eq!(
        mark,
        serde_json::json!({
            "sessionId": "s01a2b3c4",
            "status": "interrupted",
            "seenAt": 1_700_000_000_000_i64,
        })
    );
}

/// A `task` call's subagent rows are a wire contract with `src/utils/agentTypes.ts`: the feed
/// reads these names by name, and the live ones (`status`, `toolCount`, `currentTool`,
/// `lastIntent`) are what let a running batch draw its own rows instead of one chip. What the
/// engine did not report stays absent rather than travelling as `0` or `null`: a row draws
/// "state unknown" and "never used a tool" differently from "idle" and "none so far".
#[test]
fn task_subagent_rows_keep_the_wire_names_the_feed_reads() {
    let row = serde_json::to_value(ToolSubagent {
        name: Some("Scout".to_owned()),
        id: Some("a7f3c1".to_owned()),
        agent: "scout".to_owned(),
        description: Some("map the repo".to_owned()),
        exit_code: 1,
        duration_ms: 1900,
        tokens: 1200,
        truncated: true,
        status: Some("running".to_owned()),
        tool_count: Some(7),
        current_tool: Some("grep".to_owned()),
        last_intent: Some("scanning the store".to_owned()),
        model: Some("acme/fast-1".to_owned()),
    })
    .expect("serialize");
    assert_eq!(
        row,
        serde_json::json!({
            "name": "Scout",
            "id": "a7f3c1",
            "agent": "scout",
            "description": "map the repo",
            "exitCode": 1,
            "durationMs": 1900,
            "tokens": 1200,
            "truncated": true,
            "status": "running",
            "toolCount": 7,
            "currentTool": "grep",
            "lastIntent": "scanning the store",
            "model": "acme/fast-1",
        })
    );

    let bare = serde_json::to_value(ToolSubagent {
        name: None,
        id: None,
        agent: "reviewer".to_owned(),
        description: None,
        exit_code: 0,
        duration_ms: 0,
        tokens: 0,
        truncated: false,
        status: None,
        tool_count: None,
        current_tool: None,
        last_intent: None,
        model: None,
    })
    .expect("serialize");
    assert_eq!(
        bare,
        serde_json::json!({
            "agent": "reviewer",
            "exitCode": 0,
            "durationMs": 0,
            "tokens": 0,
        })
    );
}

/// `pendingAsyncWork` is a wire contract with `src/utils/sessionTypes.ts`, and it travels even when
/// it is `false`: the frontend asks whether the session still owes it something, and a field that
/// appeared only when the answer was yes would make that indistinguishable from a host too old to
/// track the fact at all.
#[test]
fn pending_async_work_is_always_on_the_wire() {
    let pending = serde_json::to_value(SessionRuntimeState {
        session_id: "s01a2b3c4".to_owned(),
        tip_entry_id: None,
        model_provider: None,
        model_id: None,
        thinking_level: None,
        thinking_levels: Vec::new(),
        is_streaming: false,
        is_compacting: false,
        modes: serde_json::json!({}),
        retry: None,
        message_count: 0,
        context_tokens: 0,
        context_window: 0,
        context_percent: 0.0,
        auto_compact_percent: None,
        context_categories: ContextCategories::default(),
        context_anchored: false,
        session_usage: SessionUsageTotals::default(),
        commands: Vec::new(),
        interrupted: false,
        pending_async_work: true,
        cancellable_subagents: 0,
        last_event_at: 0,
        background_jobs: Vec::new(),
        todo_phases: Vec::new(),
    })
    .expect("serialize");
    assert_eq!(pending["pendingAsyncWork"], serde_json::json!(true));
    // The same contract for the count a stop control is drawn on: it travels when there is nothing
    // to cancel too, because "none" and "a host too old to count them" are one answer to the
    // question the button asks, and a missing key would leave the frontend guessing which it is.
    assert_eq!(pending["cancellableSubagents"], serde_json::json!(0));
}

/// `lastEventAt` and `backgroundJobs` are wire contracts with `src/utils/sessionTypes.ts`. The
/// timestamp travels even at `0`, because the frontend gates on `> 0` to tell "no engine event yet"
/// from "a host too old to say" - the two would collapse if the field vanished with the unknown.
/// The job list hides when it is empty, the same additivity rule the todo phases follow, and its
/// four fields are the names the feed reads back.
///
/// The two stop outcomes are contracts of the same kind: their multi-word fields are renamed on the
/// wire (`cancelledSubagents`, `cancelledJobs`, `sessionFile`), and a forced stop that named no file
/// still says `null` rather than dropping the key.
#[test]
fn the_event_clock_and_background_jobs_keep_their_wire_names() {
    let state = serde_json::to_value(SessionRuntimeState {
        session_id: "s01a2b3c4".to_owned(),
        tip_entry_id: None,
        model_provider: None,
        model_id: None,
        thinking_level: None,
        thinking_levels: Vec::new(),
        is_streaming: false,
        is_compacting: false,
        modes: serde_json::json!({}),
        retry: None,
        message_count: 0,
        context_tokens: 0,
        context_window: 0,
        context_percent: 0.0,
        auto_compact_percent: None,
        context_categories: ContextCategories::default(),
        context_anchored: false,
        session_usage: SessionUsageTotals::default(),
        commands: Vec::new(),
        interrupted: false,
        pending_async_work: true,
        cancellable_subagents: 0,
        last_event_at: 1_700_000_000_000,
        background_jobs: vec![BackgroundJob {
            id: "job-1".to_owned(),
            kind: "bash".to_owned(),
            label: "npm test".to_owned(),
            started_at: 1_700_000_000_000,
        }],
        todo_phases: Vec::new(),
    })
    .expect("serialize");
    assert_eq!(
        state["lastEventAt"],
        serde_json::json!(1_700_000_000_000i64)
    );
    assert_eq!(
        state["backgroundJobs"],
        serde_json::json!([{
            "id": "job-1",
            "type": "bash",
            "label": "npm test",
            "startedAt": 1_700_000_000_000i64,
        }])
    );

    let empty = serde_json::to_value(SessionRuntimeState {
        session_id: "s01a2b3c4".to_owned(),
        tip_entry_id: None,
        model_provider: None,
        model_id: None,
        thinking_level: None,
        thinking_levels: Vec::new(),
        is_streaming: false,
        is_compacting: false,
        modes: serde_json::json!({}),
        retry: None,
        message_count: 0,
        context_tokens: 0,
        context_window: 0,
        context_percent: 0.0,
        auto_compact_percent: None,
        context_categories: ContextCategories::default(),
        context_anchored: false,
        session_usage: SessionUsageTotals::default(),
        commands: Vec::new(),
        interrupted: false,
        pending_async_work: false,
        cancellable_subagents: 0,
        last_event_at: 0,
        background_jobs: Vec::new(),
        todo_phases: Vec::new(),
    })
    .expect("serialize");
    // The clock stays on the wire at `0` - the honest "no engine event yet" - while the empty job
    // list is not a field at all.
    assert_eq!(empty["lastEventAt"], serde_json::json!(0));
    assert!(empty.get("backgroundJobs").is_none());

    let abort = serde_json::to_value(AbortOutcome {
        aborted: true,
        cancelled_subagents: 2,
        cancelled_jobs: 1,
        remaining: vec!["turn".to_owned(), "queued".to_owned()],
        restored: vec!["look at the other file".to_owned()],
    })
    .expect("serialize");
    assert_eq!(
        abort,
        serde_json::json!({
            "aborted": true,
            "cancelledSubagents": 2,
            "cancelledJobs": 1,
            "remaining": ["turn", "queued"],
            "restored": ["look at the other file"],
        })
    );

    let forced = serde_json::to_value(ForceStopOutcome {
        forced: true,
        cancelled_subagents: 0,
        cancelled_jobs: 3,
        restored: Vec::new(),
        session_file: Some("s01a2b3c4".to_owned()),
    })
    .expect("serialize");
    assert_eq!(
        forced,
        serde_json::json!({
            "forced": true,
            "cancelledSubagents": 0,
            "cancelledJobs": 3,
            "restored": [],
            "sessionFile": "s01a2b3c4",
        })
    );

    let unnamed = serde_json::to_value(ForceStopOutcome {
        forced: false,
        cancelled_subagents: 0,
        cancelled_jobs: 0,
        restored: Vec::new(),
        session_file: None,
    })
    .expect("serialize");
    assert_eq!(unnamed["sessionFile"], serde_json::json!(null));
}

/// `autoCompactPercent` is a wire contract with `src/utils/sessionTypes.ts`, and it travels even
/// when the engine would not compact: the ring's card words "the engine will not compact" and "the
/// host never said" differently, so a field that vanished with `None` would collapse the two.
#[test]
fn the_auto_compaction_boundary_is_always_on_the_wire() {
    let without = serde_json::to_value(SessionRuntimeState {
        session_id: "s01a2b3c4".to_owned(),
        tip_entry_id: None,
        model_provider: None,
        model_id: None,
        thinking_level: None,
        thinking_levels: Vec::new(),
        is_streaming: false,
        is_compacting: false,
        modes: serde_json::json!({}),
        retry: None,
        message_count: 0,
        context_tokens: 0,
        context_window: 0,
        context_percent: 0.0,
        auto_compact_percent: None,
        context_categories: ContextCategories::default(),
        context_anchored: false,
        session_usage: SessionUsageTotals::default(),
        commands: Vec::new(),
        interrupted: false,
        pending_async_work: false,
        cancellable_subagents: 0,
        last_event_at: 0,
        background_jobs: Vec::new(),
        todo_phases: Vec::new(),
    })
    .expect("serialize");
    assert_eq!(without["autoCompactPercent"], serde_json::json!(null));

    // The engine's own share of the window, which is what the ring draws its trigger line from.
    let bounded = serde_json::to_value(SessionRuntimeState {
        session_id: "s01a2b3c4".to_owned(),
        tip_entry_id: None,
        model_provider: None,
        model_id: None,
        thinking_level: None,
        thinking_levels: Vec::new(),
        is_streaming: false,
        is_compacting: false,
        modes: serde_json::json!({}),
        retry: None,
        message_count: 0,
        context_tokens: 0,
        context_window: 200_000,
        context_percent: 0.0,
        auto_compact_percent: Some(85.0),
        context_categories: ContextCategories {
            system_prompt: 1_800,
            system_tools: 8_800,
            system_context: 0,
            skills: 0,
            messages: 13_700,
        },
        context_anchored: true,
        session_usage: SessionUsageTotals {
            input_tokens: 18_515,
            cache_read_tokens: 120_000,
            cache_write_tokens: 4_500,
        },
        commands: Vec::new(),
        interrupted: false,
        pending_async_work: false,
        cancellable_subagents: 0,
        last_event_at: 0,
        background_jobs: Vec::new(),
        todo_phases: Vec::new(),
    })
    .expect("serialize");
    assert_eq!(bounded["autoCompactPercent"], serde_json::json!(85.0));
    // The same contract for the engine's own split and for the session's cache totals, which the
    // popover's bar and legend are drawn from: every category id travels, an empty one as `0`.
    assert_eq!(
        bounded["contextCategories"],
        serde_json::json!({
            "systemPrompt": 1_800,
            "systemTools": 8_800,
            "systemContext": 0,
            "skills": 0,
            "messages": 13_700,
        })
    );
    assert_eq!(bounded["contextAnchored"], serde_json::json!(true));
    // The other half of the same contract: an estimated occupancy says so, which is what lets the
    // card write `≈` instead of presenting a tokenizer's guess as a provider's reading.
    assert_eq!(without["contextAnchored"], serde_json::json!(false));
    assert_eq!(
        bounded["sessionUsage"],
        serde_json::json!({
            "inputTokens": 18_515,
            "cacheReadTokens": 120_000,
            "cacheWriteTokens": 4_500,
        })
    );
    // The contract the frontend's hit rate is measured from: every bucket travels, an untouched
    // session reporting three zeros rather than a missing object.
    assert_eq!(
        without["sessionUsage"],
        serde_json::json!({"inputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0})
    );
}

/// A roster row is the one payload the frontend replaces its own copy with, so every field it
/// draws is on the wire and an unknown fact is `null` rather than a missing key: a field that hid
/// when empty would leave the row drawing the previous frame's facts, which is the one mistake a
/// merge of partial frames cannot notice on its own. The names are the ones
/// `src/utils/subagentTypes.ts` declares for `LiveSubagent`.
///
/// The key set is exact in both directions. A field the engine sends but no reader draws stays
/// out - a child's `sessionFile`, the rendered prompt the spawn passed as `task`, and the `endMs`
/// a recent tool used to carry - because a key nobody reads is a second, unowned copy of the
/// engine's payload. `startedAt` is a plain number: this process always writes it, since the
/// engine reports how long a child has run rather than when it started. The whole object is
/// compared, which is what makes "absent" testable rather than merely unasserted.
#[test]
fn subagent_rows_carry_every_field_the_roster_reads() {
    let empty = serde_json::to_value(SubagentRow {
        id: "a7f3c1".to_owned(),
        agent: "scout".to_owned(),
        index: 2,
        parent_tool_call_id: None,
        detached: false,
        status: "running".to_owned(),
        description: None,
        assignment: None,
        tool_count: None,
        current_tool: None,
        current_tool_args: None,
        last_intent: None,
        model: None,
        tokens: None,
        duration_ms: None,
        started_at: 1_789_627_445_383,
        recent_tools: Vec::new(),
        recent_output: Vec::new(),
    })
    .expect("serialize");
    assert_eq!(
        empty,
        serde_json::json!({
            "id": "a7f3c1",
            "agent": "scout",
            "index": 2,
            "parentToolCallId": null,
            "detached": false,
            "status": "running",
            "description": null,
            "assignment": null,
            "toolCount": null,
            "currentTool": null,
            "currentToolArgs": null,
            "lastIntent": null,
            "model": null,
            "tokens": null,
            "durationMs": null,
            "startedAt": 1_789_627_445_383i64,
            "recentTools": [],
            "recentOutput": [],
        })
    );

    let busy = serde_json::to_value(SubagentRow {
        id: "a7f3c1".to_owned(),
        agent: "scout".to_owned(),
        index: 2,
        parent_tool_call_id: Some("call_1".to_owned()),
        detached: true,
        status: "running".to_owned(),
        description: Some("map the repo".to_owned()),
        assignment: Some("map it".to_owned()),
        tool_count: Some(7),
        current_tool: Some("grep".to_owned()),
        current_tool_args: Some("{\"pattern\":\"host\"}".to_owned()),
        last_intent: Some("scanning the store".to_owned()),
        model: Some("acme/fast-1".to_owned()),
        tokens: Some(1_200),
        duration_ms: Some(1_900),
        started_at: 1_789_627_445_383,
        recent_tools: vec![SubagentRecentTool {
            tool: "grep".to_owned(),
            args: "host".to_owned(),
        }],
        recent_output: vec!["found 3".to_owned()],
    })
    .expect("serialize");
    assert_eq!(
        busy,
        serde_json::json!({
            "id": "a7f3c1",
            "agent": "scout",
            "index": 2,
            "parentToolCallId": "call_1",
            "detached": true,
            "status": "running",
            "description": "map the repo",
            "assignment": "map it",
            "toolCount": 7,
            "currentTool": "grep",
            "currentToolArgs": "{\"pattern\":\"host\"}",
            "lastIntent": "scanning the store",
            "model": "acme/fast-1",
            "tokens": 1_200,
            "durationMs": 1_900,
            "startedAt": 1_789_627_445_383i64,
            "recentTools": [{"tool": "grep", "args": "host"}],
            "recentOutput": ["found 3"],
        })
    );
}
/// A dialog's `secret` hint travels only when it is true.
///
/// The engine marks a credential dialog through `ExtensionUIDialogOptions.secret`; the host
/// forwards it (`host/src/ui.ts`) and this projection carries it to the frontend, which draws a
/// masked field for it. `false` is what every ordinary input dialog is, and sending it would put a
/// field on the wire that every reader has to learn to ignore — so the serde predicate drops it.
#[test]
fn a_secret_dialog_says_so_and_an_ordinary_one_does_not() {
    let secret = serde_json::to_value(UiRequest::Input {
        id: "ui-1".to_owned(),
        title: "API key".to_owned(),
        message: "The extension needs a credential.".to_owned(),
        placeholder: "sk-…".to_owned(),
        secret: true,
        timeout_ms: None,
    })
    .expect("serialize");
    assert_eq!(secret["method"], "input");
    assert_eq!(secret["secret"], true);

    let ordinary = serde_json::to_value(UiRequest::Input {
        id: "ui-2".to_owned(),
        title: "Objective".to_owned(),
        message: String::new(),
        placeholder: "what to build".to_owned(),
        secret: false,
        timeout_ms: None,
    })
    .expect("serialize");
    assert!(ordinary.get("secret").is_none(), "{ordinary}");
}

/// A form answer is its controls and nothing else: every field travels by name, and an empty list
/// is a real answer (the form was submitted untouched, so each field keeps its own default).
///
/// The names are what the host reads back (`answers[].name` / `answers[].value`) and what the engine
/// validates the data against, so a rename here would leave the form half-answered on the engine's
/// side. A value's three shapes are the engine's own (`HtmlFormValue`): text, a number, or a group's
/// checked values.
#[test]
fn form_responses_carry_per_control_answers_and_nothing_else() {
    let answered = UiResponse {
        answers: Some(vec![
            UiFormAnswer {
                name: "store".to_owned(),
                value: UiFormValue::Text("sqlite".to_owned()),
            },
            UiFormAnswer {
                name: "ttl".to_owned(),
                value: UiFormValue::Number(30.0),
            },
            UiFormAnswer {
                name: "tags".to_owned(),
                value: UiFormValue::Multiple(vec!["a".to_owned(), "b".to_owned()]),
            },
        ]),
        ..UiResponse::default()
    };
    assert!(answered.validate("form").is_ok());

    let row = serde_json::to_value(answered.answers.as_ref().expect("answers")).expect("serialize");
    assert_eq!(row[0]["name"], serde_json::json!("store"));
    assert_eq!(row[0]["value"], serde_json::json!("sqlite"));
    assert_eq!(row[1]["value"], serde_json::json!(30.0));
    assert_eq!(row[2]["value"], serde_json::json!(["a", "b"]));

    // An untouched submit is still an answer: every field keeps the form's own default.
    let untouched = UiResponse {
        answers: Some(Vec::new()),
        ..UiResponse::default()
    };
    assert!(untouched.validate("form").is_ok());

    // A form answer is not a question-list answer, and the shape gate keeps them apart.
    let shapeless = UiResponse {
        kind: Some("submit".to_owned()),
        ..UiResponse::default()
    };
    assert!(shapeless.validate("form").is_err());
    assert!(answered.validate("ask").is_err());
}

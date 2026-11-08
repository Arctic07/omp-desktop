/**
 * The session runtime's own tests: the state projections and the subagent roster's merge rules.
 *
 * A submodule rather than an inline block: `rules.md#single-file-line-limit` bounds a file at 1000 lines, and the
 * projections here are the part that keeps growing. Same split as `events/tests.rs` and
 * `e2e/tests.rs`.
 */
use serde_json::json;

use super::*;
use crate::services::runtime::MAX_TEXT_CHARS;

/// The name a session opens with is engine-authored title text, so it is cleaned the way the
/// session index cleans a file's title slot: a title model that translated the `<title>` marker
/// leaves `<标题>…</标题>` in the name, and the conversation header and the `Fork of …` titles
/// built from it must read the words, not the envelope. A name that cleans to nothing is no name.
#[test]
fn the_open_title_is_cleaned_like_a_rows_title() {
    assert_eq!(
        title_of(&json!({"sessionName": "<标题>修复浏览器 agent 蒙版错位与 GPU 卡顿</标题>"})),
        Some("修复浏览器 agent 蒙版错位与 GPU 卡顿".to_owned())
    );
    assert_eq!(title_of(&json!({"sessionName": "<title/>"})), None);
    assert_eq!(title_of(&json!({"sessionName": ""})), None);
    assert_eq!(title_of(&json!({})), None);
}

/// The regression this covers: the command list was kept in a copy of the advertisement, and
/// the advertisement arrives *before* this process registers the session it names - so a
/// conversation opened here had no commands for the rest of its life, and the palette stayed
/// empty in exactly the place a reader first tries it. The list travels in the session's state
/// instead, which is what both the open response and every later snapshot carry.
#[test]
fn the_command_list_is_read_from_the_state_payload() {
    let session = fake_session("s00000000000000ff");
    let state = json!({
        "commands": [
            {"name": "tools", "description": "Show available tools", "source": "builtin"},
            {
                "name": "skill:deploy",
                "description": "Deploy it",
                "aliases": ["d"],
                "input": {"hint": "arguments"},
                "source": "skill",
                "subcommands": [{"name": "now", "description": "right away"}],
            },
            {"description": "no name"},
        ],
        "messageCount": 0,
    });
    let projected = project_state(&session, &state);
    assert_eq!(projected.message_count, 0);
    assert_eq!(
        projected.commands.len(),
        2,
        "a nameless entry is not a command"
    );
    assert_eq!(projected.commands[0].name, "tools");
    assert_eq!(projected.commands[0].source, "builtin");
    assert_eq!(projected.commands[1].name, "skill:deploy");
    assert_eq!(projected.commands[1].aliases, vec!["d".to_owned()]);
    assert_eq!(projected.commands[1].input_hint, "arguments");
    assert_eq!(projected.commands[1].subcommands.len(), 1);
    assert_eq!(projected.commands[1].source, "skill");

    // A payload with no list at all is a session that has advertised nothing.
    let silent = project_state(&session, &json!({"messageCount": 3}));
    assert!(silent.commands.is_empty());
    assert_eq!(silent.message_count, 3);
}

/// A session record for the projections that read one.
fn fake_session(id: &str) -> Arc<SessionRuntime> {
    Arc::new(SessionRuntime::new(
        id.to_owned(),
        "D:/ws".to_owned(),
        Some(1),
        None,
    ))
}

/// A child the engine is describing right now, in the shape the host forwards it in: the
/// spawn's own fields beside the progress record, which carries the child's id and its report.
fn progress_frame(id: &str, status: &str) -> Value {
    json!({
        "index": 1,
        "agent": "scout",
        "task": "map the repo",
        "assignment": "map it",
        "parentToolCallId": "call_1",
        "detached": true,
        "sessionFile": "D:/Data/host/sessions/s1/a7f3c1.jsonl",
        "progress": {
            "id": id,
            "index": 1,
            "agent": "scout",
            "status": status,
            "toolCount": 7,
            "tokens": 1200,
            "durationMs": 1900,
            "currentTool": "grep",
            "currentToolArgs": "{\"pattern\":\"host\"}",
            "lastIntent": "scanning the store",
            "recentTools": [{"tool": "grep", "args": "host", "endMs": 1_789_627_445_373i64}],
            "recentOutput": ["found 3"],
        },
    })
}

/// A progress frame is the whole of what a child is doing, and the row it produces is what the
/// frontend replaces its own copy with - so the assertions below are on the wire names
/// `src/utils/subagentTypes.ts` declares for the live roster row, not on the row's Rust fields.
/// The engine's payload carries more than the row does (the child's session file, the prompt it
/// was spawned with, each call's end time); what arrives with them and what reaches the wire is
/// what these names are about, and the exact key set is pinned by
/// `models/agent/tests.rs::subagent_rows_carry_every_field_the_roster_reads`.
#[test]
fn a_progress_frame_produces_the_merged_roster_row() {
    let mut roster = SubagentRoster::default();
    let row = roster
        .apply(
            "progress",
            &progress_frame("a7f3c1", "running"),
            1_789_627_445_000,
        )
        .expect("a frame about a child nobody has seen is a row");
    assert_eq!(
        row.started_at, 1_789_627_445_000,
        "first sight of the id is what times the row"
    );

    let wire = serde_json::to_value(&row).expect("serialize");
    assert_eq!(wire["id"], "a7f3c1");
    assert_eq!(wire["agent"], "scout");
    assert_eq!(wire["index"], 1);
    assert_eq!(wire["status"], "running");
    assert_eq!(wire["parentToolCallId"], "call_1");
    assert_eq!(wire["detached"], json!(true));
    assert_eq!(wire["assignment"], "map it");
    assert_eq!(wire["toolCount"], 7);
    assert_eq!(wire["currentTool"], "grep");
    assert_eq!(wire["currentToolArgs"], "{\"pattern\":\"host\"}");
    assert_eq!(wire["lastIntent"], "scanning the store");
    assert_eq!(wire["tokens"], 1200);
    assert_eq!(wire["durationMs"], 1900);
    assert_eq!(wire["startedAt"], 1_789_627_445_000i64);
    // The call's arguments travel; the engine's own end time for it is not a key of the row.
    assert_eq!(
        wire["recentTools"],
        json!([{"tool": "grep", "args": "host"}])
    );
    assert_eq!(wire["recentOutput"], json!(["found 3"]));

    // A frame that says nothing new is not published again: the engine coalesces its own
    // progress frames, and the frontend would be told the same row twice.
    assert!(roster
        .apply(
            "progress",
            &progress_frame("a7f3c1", "running"),
            1_789_627_445_100
        )
        .is_none());
}

/// The two halves of one child land on one row, and the lifecycle half is the one that settles
/// it: `started` is that frame's word for the roster's `running`, while every word that settles
/// a child is already the roster's own and travels as itself.
#[test]
fn a_lifecycle_frame_settles_the_row_a_progress_frame_opened() {
    let mut roster = SubagentRoster::default();
    let started = roster
        .apply(
            "lifecycle",
            &json!({
                "id": "a7f3c1",
                "agent": "scout",
                "status": "started",
                "index": 0,
                "description": "map the repo",
                "parentToolCallId": "call_1",
            }),
            1_000,
        )
        .expect("a child nobody has seen is a row");
    assert_eq!(
        started.status, "running",
        "`started` is the roster's `running`"
    );
    assert_eq!(started.started_at, 1_000);

    let running = roster
        .apply("progress", &progress_frame("a7f3c1", "running"), 2_000)
        .expect("the child's own report changes the row");
    assert_eq!(
        running.started_at, 1_000,
        "the row keeps the time it was first seen, not the time of its newest frame"
    );
    assert_eq!(
        running.description.as_deref(),
        Some("map the repo"),
        "a frame that does not mention a field leaves it alone"
    );
    assert_eq!(running.tool_count, Some(7));

    for status in ["completed", "failed", "aborted"] {
        let settled = roster
            .apply(
                "lifecycle",
                &json!({"id": "a7f3c1", "agent": "scout", "status": status, "index": 0}),
                3_000,
            )
            .expect("settling a child changes the row");
        assert_eq!(settled.status, status);
        assert!(
            roster
                .apply(
                    "lifecycle",
                    &json!({"id": "a7f3c1", "agent": "scout", "status": status, "index": 0}),
                    4_000,
                )
                .is_none(),
            "the same settling frame again says nothing new"
        );
    }
}

/// The roster is bounded, and the rows that go first are the ones that have been settled
/// longest: a conversation that spawned a batch an hour ago keeps what it is still waiting on.
#[test]
fn the_roster_drops_the_oldest_settled_rows_first() {
    let mut roster = SubagentRoster::default();
    for index in 0..SUBAGENT_ROSTER_MAX {
        let started = roster.apply(
            "lifecycle",
            &json!({
                "id": format!("child-{index}"),
                "agent": "scout",
                "status": "started",
                "index": index as i64,
            }),
            1_000,
        );
        assert!(started.is_some(), "every new child is a row");
    }
    assert_eq!(roster.rows.len(), SUBAGENT_ROSTER_MAX);
    roster.apply(
        "lifecycle",
        &json!({"id": "child-0", "agent": "scout", "status": "completed", "index": 0}),
        2_000,
    );

    let late = roster
        .apply(
            "lifecycle",
            &json!({"id": "late", "agent": "reviewer", "status": "started", "index": 9}),
            3_000,
        )
        .expect("a new child is made room for");
    assert_eq!(late.id, "late");
    assert_eq!(roster.rows.len(), SUBAGENT_ROSTER_MAX);
    assert!(
        !roster.rows.contains_key("child-0"),
        "the settled row is the one that made room"
    );
    assert!(roster.rows.contains_key("child-1"));

    // A roster whose children are all still running has nothing settled to drop, and then the
    // oldest row goes: the cap bounds memory, and the child that lost its row is one whose next
    // frame opens a fresh one.
    let mut running = SubagentRoster::default();
    for index in 0..SUBAGENT_ROSTER_MAX {
        running.apply(
            "lifecycle",
            &json!({
                "id": format!("run-{index}"),
                "agent": "scout",
                "status": "started",
                "index": index as i64,
            }),
            1_000,
        );
    }
    let late = running
        .apply(
            "lifecycle",
            &json!({"id": "run-late", "agent": "scout", "status": "started", "index": 99}),
            2_000,
        )
        .expect("a new child is made room for");
    assert_eq!(running.rows.len(), SUBAGENT_ROSTER_MAX);
    assert!(
        !running.rows.contains_key("run-0"),
        "with nothing settled, the oldest row goes"
    );
    assert!(running.rows.contains_key("run-late"));
    assert_eq!(late.started_at, 2_000);
}

/// A frame that names no child is dropped rather than given an invented id: a row nothing could
/// be matched against is not a row, and inventing one would put a child on screen that the
/// engine never reported.
#[test]
fn a_frame_that_names_no_child_is_not_a_row() {
    let mut roster = SubagentRoster::default();
    assert!(roster
        .apply(
            "lifecycle",
            &json!({"agent": "scout", "status": "started"}),
            1_000
        )
        .is_none());
    assert!(roster
        .apply(
            "progress",
            &json!({"agent": "scout", "progress": {}}),
            1_000
        )
        .is_none());
    assert!(roster.rows.is_empty());
}

/// Every string a row carries is bounded, and the cut says so in the value itself - a reader of
/// the roster has to be able to tell "this is all of it" from "this is as much as fits". Both
/// lists carry the same bound, and because the engine's windows are newest-first, the entries
/// the bound keeps are the newest ones.
#[test]
fn a_roster_row_is_bounded_and_says_where_it_was_cut() {
    let mut roster = SubagentRoster::default();
    let tools: Vec<Value> = (0..12)
        .map(|index| json!({"tool": format!("tool-{index}"), "args": "a", "endMs": index}))
        .collect();
    let output: Vec<Value> = (0..12)
        .map(|index| json!(format!("line-{index}")))
        .collect();
    let row = roster
        .apply(
            "progress",
            &json!({
                "index": 0,
                "agent": "scout",
                "progress": {
                    "id": "c1",
                    "status": "running",
                    "lastIntent": "x".repeat(MAX_TEXT_CHARS + 1),
                    "recentTools": tools,
                    "recentOutput": output,
                },
            }),
            1_000,
        )
        .expect("the frame says something about the child");

    assert_eq!(row.recent_tools.len(), SUBAGENT_LIST_MAX);
    assert_eq!(row.recent_output.len(), SUBAGENT_LIST_MAX);
    assert_eq!(row.recent_tools[0].tool, "tool-0");
    assert_eq!(row.recent_output[0], "line-0");

    let intent = row.last_intent.expect("the frame named one");
    assert!(
        intent.ends_with("…(truncated)"),
        "a clamped value says it was cut: {intent}"
    );
    assert_eq!(
        intent.chars().count(),
        MAX_TEXT_CHARS + "\n…(truncated)".chars().count()
    );
}

/// `pendingAsyncWork` travels from the host's state payload to the frontend, and a host that
/// predates the field answers `false` rather than leaving the frontend to guess: the question
/// is "can this session still produce work on its own", and "not tracked" is not a yes.
#[test]
fn the_state_view_reports_pending_background_work() {
    let session = SessionRuntime::new(
        "s00000000000000ff".to_owned(),
        "D:/ws".to_owned(),
        Some(1),
        None,
    );
    let busy = serde_json::to_value(project_state(
        &session,
        &json!({"isStreaming": false, "pendingAsyncWork": true}),
    ))
    .expect("serialize");
    assert_eq!(busy["pendingAsyncWork"], json!(true));

    let idle = serde_json::to_value(project_state(&session, &json!({"isStreaming": false})))
        .expect("serialize");
    assert_eq!(idle["pendingAsyncWork"], json!(false));
}

/// The modes travel from the host's state payload to the frontend unchanged: goal accounting,
/// plan file and vibe worker rows are the host's own shapes, and a host that predates the field
/// answers an empty object rather than making the strip guess.
#[test]
fn the_state_view_reports_the_modes_object() {
    let session = SessionRuntime::new(
        "s00000000000000ff".to_owned(),
        "D:/ws".to_owned(),
        Some(1),
        None,
    );
    let modes = json!({
        "goal": {"enabled": true, "status": "active", "objective": "ship it", "tokensUsed": 10, "tokenBudget": null, "timeUsedSeconds": 3},
        "plan": {"planFilePath": "local://PLAN.md"},
        "vibe": {"workers": [{"id": "W1", "cli": "fast", "state": "running"}]},
    });
    let busy = serde_json::to_value(project_state(
        &session,
        &json!({"isStreaming": false, "modes": modes.clone()}),
    ))
    .expect("serialize");
    assert_eq!(busy["modes"], modes);

    let plain = serde_json::to_value(project_state(&session, &json!({"isStreaming": false})))
        .expect("serialize");
    assert_eq!(plain["modes"], json!({}));
}

/// The two fields a session stop needs travel from the host's state payload to the frontend. The
/// event clock is `0` when the host never sent one (and on a host that predates it), because the
/// frontend gates on `> 0`; the job list keeps only entries that name an id, since a row that names
/// nothing cannot be addressed, and defaults the rest rather than dropping an otherwise usable job.
#[test]
fn the_state_view_reports_the_event_clock_and_background_jobs() {
    let session = fake_session("s00000000000000ff");
    let silent = project_state(&session, &json!({"isStreaming": false}));
    assert_eq!(silent.last_event_at, 0);
    assert!(silent.background_jobs.is_empty());

    let state = json!({
        "isStreaming": true,
        "lastEventAt": 1_700_000_000_000i64,
        "backgroundJobs": [
            {"id": "job-1", "type": "bash", "label": "npm test", "startedAt": 1_700_000_000_000i64},
            {"type": "eval", "label": "no id"},
            {"id": ""},
            {"id": "job-2"},
        ],
    });
    let projected = project_state(&session, &state);
    assert_eq!(projected.last_event_at, 1_700_000_000_000);
    assert_eq!(
        projected
            .background_jobs
            .iter()
            .map(|job| job.id.as_str())
            .collect::<Vec<_>>(),
        vec!["job-1", "job-2"]
    );
    assert_eq!(projected.background_jobs[0].kind, "bash");
    assert_eq!(projected.background_jobs[0].label, "npm test");
    assert_eq!(projected.background_jobs[0].started_at, 1_700_000_000_000);
    // A job that named its id but nothing else still travels, with the facts it omitted read as
    // their empty/default form.
    assert_eq!(projected.background_jobs[1].kind, "");
    assert_eq!(projected.background_jobs[1].label, "");
    assert_eq!(projected.background_jobs[1].started_at, 0);
}

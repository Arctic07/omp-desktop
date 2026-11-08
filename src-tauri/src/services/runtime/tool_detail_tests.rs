use serde_json::json;

use super::*;

/// A live tool result is an `AgentToolResult`, so the row's text is its content parts — not the
/// escaped object a naive stringify would put there.
#[test]
fn a_result_reads_as_its_content_not_as_json() {
    let result = json!({
        "content": [{ "type": "text", "text": "Edited src/main.ts" }],
        "details": { "path": "src/main.ts" },
    });
    assert_eq!(result_text(Some(&result)), "Edited src/main.ts");
    // A bare string stays itself, and a shape with neither form still says something.
    assert_eq!(result_text(Some(&json!("plain"))), "plain");
    assert_eq!(result_text(Some(&json!({ "count": 2 }))), "{\"count\":2}");
    assert_eq!(result_text(None), "");
}

/// The two facts an edit row draws: the diff and the file it touched.
#[test]
fn an_edit_details_carry_its_diff_and_path() {
    let details = json!({
        "diff": "@@ -1,3 +1,4 @@\n-a\n+b\n",
        "firstChangedLine": 1,
        "path": "C:/w/src/main.ts",
        "oldText": "whole file before",
        "newText": "whole file after",
    });
    let projected = tool_details(Some(&details)).expect("an edit reports a diff");
    assert_eq!(projected.diff.as_deref(), Some("@@ -1,3 +1,4 @@\n-a\n+b\n"));
    assert_eq!(projected.first_changed_line, Some(1));
    assert_eq!(projected.path.as_deref(), Some("C:/w/src/main.ts"));
    // Whole-file snapshots are engine bookkeeping, not something a row draws.
    let serialized = serde_json::to_value(&projected).expect("serialize");
    assert!(serialized.get("oldText").is_none());
    assert!(serialized.get("newText").is_none());
}

/// A multi-file edit and a `task` call each report their own list, and a details object that
/// names neither is not a field at all.
#[test]
fn file_and_subagent_lists_are_projected_and_capped() {
    let details = json!({
        "perFileResults": [
            { "path": "a.ts", "diff": "+a", "firstChangedLine": 2 },
            { "path": "b.ts", "isError": true, "errorText": "no match", "displayErrorText": "No match for the patch" },
            { "diff": "+orphan" },
        ],
        "results": [
            { "name": "Scout", "agent": "scout", "description": "map the repo", "exitCode": 0, "durationMs": 1900, "tokens": 1200, "truncated": true },
            { "agent": "reviewer", "task": "review the diff", "exitCode": 1, "durationMs": 300, "tokens": 10 },
            { "description": "no agent type" },
        ],
        "async": { "state": "running", "jobId": "Task_1", "type": "task" },
        "projectAgentsDir": null,
    });
    let projected = tool_details(Some(&details)).expect("details name files and subagents");
    assert_eq!(
        projected.files.len(),
        2,
        "an entry without a path is not a file"
    );
    assert_eq!(projected.files[0].path, "a.ts");
    assert_eq!(
        projected.files[1].error_text.as_deref(),
        Some("No match for the patch")
    );
    assert_eq!(
        projected.subagents.len(),
        2,
        "an entry without an agent type is not a subagent"
    );
    assert_eq!(projected.subagents[0].name.as_deref(), Some("Scout"));
    assert!(projected.subagents[0].truncated);
    assert_eq!(
        projected.subagents[1].description.as_deref(),
        Some("review the diff")
    );
    // A result states its own outcome only through its exit code, so a roster built from one
    // has to read it: a row whose state is unknown draws as work still going.
    assert_eq!(projected.subagents[0].status.as_deref(), Some("completed"));
    assert_eq!(projected.subagents[1].status.as_deref(), Some("failed"));
    assert_eq!(projected.subagent_state.as_deref(), Some("running"));

    assert!(tool_details(Some(&json!({ "projectAgentsDir": null }))).is_none());
    assert!(tool_details(Some(&json!("not an object"))).is_none());
    assert!(tool_details(None).is_none());
}

/// The live half of a `task` call: a background spawn reports its children on `progress[]` and
/// leaves `results[]` empty until the call returns, so a projection that read only `results`
/// drew a running batch as a call that spawned nothing.
#[test]
fn a_live_roster_is_read_from_progress_and_settled_by_results() {
    let live = json!({
        "progress": [
            {
                "index": 0,
                "id": "Task_1",
                "agent": "scout",
                "status": "running",
                "task": "rendered prompt: map the repo",
                "assignment": "map the repo",
                "toolCount": 7,
                "tokens": 1200,
                "durationMs": 0,
                "currentTool": "grep",
                "lastIntent": "scanning the store",
            },
            { "index": 1, "id": "Task_2", "agent": "reviewer", "status": "pending", "assignment": "review the diff" },
            { "agent": "no id" },
        ],
        "results": [],
        "async": { "state": "running", "jobId": "Task_1", "type": "task" },
    });
    let projected = tool_details(Some(&live)).expect("a live roster is details");
    assert_eq!(
        projected.subagents.len(),
        2,
        "a progress row without an id names no child"
    );
    assert_eq!(projected.subagents[0].agent, "scout");
    assert_eq!(projected.subagents[0].status.as_deref(), Some("running"));
    assert_eq!(projected.subagents[0].tool_count, Some(7));
    assert_eq!(projected.subagents[0].current_tool.as_deref(), Some("grep"));
    assert_eq!(
        projected.subagents[0].last_intent.as_deref(),
        Some("scanning the store")
    );
    assert_eq!(
        projected.subagents[0].description.as_deref(),
        Some("map the repo")
    );
    assert_eq!(projected.subagents[1].status.as_deref(), Some("pending"));
    assert_eq!(projected.subagent_state.as_deref(), Some("running"));

    // The same call once its children settled: the result is the last word on the row the
    // live roster opened, keyed by the engine's own subagent id, and a result for a child the
    // roster never announced still gets a row.
    let settled = json!({
        "progress": [
            {
                "index": 0,
                "id": "Task_1",
                "agent": "scout",
                "status": "completed",
                "assignment": "map the repo",
                "toolCount": 9,
                "tokens": 3000,
                "durationMs": 4200,
            },
        ],
        "results": [
            {
                "id": "Task_1",
                "agent": "scout",
                "assignment": "map the repo",
                "exitCode": 0,
                "durationMs": 4200,
                "tokens": 3100,
            },
            { "id": "Task_9", "agent": "reviewer", "exitCode": 1, "stderr": "boom" },
        ],
        "async": { "state": "completed", "jobId": "Task_1", "type": "task" },
    });
    let projected = tool_details(Some(&settled)).expect("a settled roster is details");
    assert_eq!(
        projected.subagents.len(),
        2,
        "the result lands on the row it settles"
    );
    assert_eq!(projected.subagents[0].status.as_deref(), Some("completed"));
    assert_eq!(
        projected.subagents[0].tokens, 3100,
        "the result is the last word"
    );
    assert_eq!(
        projected.subagents[0].tool_count,
        Some(9),
        "a live count survives the settle"
    );
    assert_eq!(projected.subagents[1].agent, "reviewer");
    assert_eq!(projected.subagents[1].status.as_deref(), Some("failed"));
    assert_eq!(projected.subagents[1].exit_code, 1);
    assert_eq!(projected.subagent_state.as_deref(), Some("completed"));
}

/// A background `bash` or `eval` call publishes the same `async` marker a background `task`
/// does - `{ state, jobId, type }` - but spawns no subagents, and a call that returned that way
/// forwards no later details frame to clear it: a state read off one would leave its row
/// reading as work in flight for the rest of the session. The marker's `type` says whose state
/// it is, and only a `task` call's own state belongs to this field.
#[test]
fn only_a_task_marker_is_a_subagent_state() {
    // The whole payload a background bash call starts with: `async` is the one member this
    // projection has a field for, and it is not a task's - so there is no state to read, and
    // nothing else for a row to open either.
    let background_bash = json!({
        "async": { "state": "running", "jobId": "bash_1", "type": "bash" },
    });
    let projected = tool_details(Some(&background_bash));
    assert_eq!(
        projected
            .as_ref()
            .and_then(|details| details.subagent_state.as_deref()),
        None,
        "a bash job's state is not a subagent state"
    );
    assert!(
        projected.is_none(),
        "a background bash call is not details at all"
    );

    // An eval job carries the same marker under its own type, and reads the same way.
    let background_eval = json!({
        "async": { "state": "running", "jobId": "eval_1", "type": "eval" },
    });
    assert!(tool_details(Some(&background_eval)).is_none());

    // The task tool's own marker is the one this field exists for.
    let background_task = json!({
        "projectAgentsDir": null,
        "results": [],
        "totalDurationMs": 0,
        "async": { "state": "running", "jobId": "Task_1", "type": "task" },
    });
    let projected = tool_details(Some(&background_task)).expect("a task job reports its state");
    assert_eq!(projected.subagent_state.as_deref(), Some("running"));
    assert!(
        projected.subagents.is_empty(),
        "an aggregate state is not a roster row"
    );
}

/// A call that reports both lists at once - its live window full, and children settled outside
/// that window - is still one roster to a row, so the bound has to hold on the merged list: a
/// cap per list let one call roster twice `MAX_DETAIL_SUBAGENTS`.
#[test]
fn a_mixed_roster_never_exceeds_the_cap() {
    let progress: Vec<Value> = (0..MAX_DETAIL_SUBAGENTS)
        .map(|index| {
            json!({
                "index": index,
                "id": format!("Task_{index}"),
                "agent": "scout",
                "status": "running",
                "assignment": format!("slice {index}"),
            })
        })
        .collect();
    let results: Vec<Value> = (0..4)
        .map(|index| {
            json!({
                "id": format!("Task_{}", MAX_DETAIL_SUBAGENTS + index),
                "agent": "reviewer",
                "exitCode": 0,
            })
        })
        .collect();

    let details = json!({ "progress": progress, "results": results });
    let projected = tool_details(Some(&details)).expect("a roster is details");
    assert_eq!(projected.subagents.len(), MAX_DETAIL_SUBAGENTS);
    // The rows that survive are the ones the call announced while they ran: the settled
    // children outside the live window are the overflow, so the cut lands on them.
    assert!(
        projected
            .subagents
            .iter()
            .all(|row| row.status.as_deref() == Some("running")),
        "the cap keeps the live roster and cuts the settled overflow"
    );
}

/// A diff is bounded on its own terms, and the cut is visible rather than silent.
#[test]
fn an_oversized_diff_is_cut_and_says_so() {
    let diff = "+".to_owned() + &"x".repeat(MAX_DIFF_CHARS + 10);
    let details = json!({ "diff": diff });
    let projected = tool_details(Some(&details)).expect("a diff is details");
    let projected_diff = projected.diff.expect("the diff survives");
    assert!(projected_diff.ends_with("…(truncated)"));
    assert!(projected_diff.chars().count() < MAX_DIFF_CHARS + 32);
}

/// A shell call whose output the minimizer rewrote carries that fact under `meta`, and a row reads
/// it as the filter and the two byte counts - the only statement about a result its own text cannot
/// make, because the text a reader sees is already the minimized capture.
#[test]
fn a_minimized_shell_result_names_its_filter_and_bytes() {
    let details = json!({
        "meta": {
            "minimized": {
                "filter": "git",
                "inputBytes": 123_289,
                "outputBytes": 3_276,
                "artifactId": "art_7",
            },
        },
    });
    let projected = tool_details(Some(&details)).expect("a minimized result is details");
    let minimized = projected.minimized.clone().expect("the record survives");
    assert_eq!(minimized.filter, "git");
    assert_eq!(minimized.input_bytes, 123_289);
    assert_eq!(minimized.output_bytes, 3_276);

    // The artifact id is how the raw capture is re-read; it stays engine bookkeeping here, like the
    // whole-file snapshots beside it, because the wire carries what the row draws.
    let serialized = serde_json::to_value(&projected).expect("serialize");
    assert!(serialized["minimized"].get("artifactId").is_none());

    // A record the engine never wrote is not a minimized one: no counts, no field.
    assert!(tool_details(Some(&json!({ "meta": {} }))).is_none());
}

/// The record is engine output like any other string on this projection: a label a rehydrated
/// session or an extension wrote is bounded before it reaches a row.
#[test]
fn an_oversized_minimizer_label_is_bounded() {
    let details = json!({
        "meta": {
            "minimized": {
                "filter": "f".repeat(MAX_MINIMIZED_FILTER_CHARS + 20),
                "inputBytes": 10,
                "outputBytes": 1,
            },
        },
    });
    let projected = tool_details(Some(&details)).expect("a minimized result is details");
    let minimized = projected.minimized.expect("the record survives");
    assert_eq!(
        minimized.filter.chars().count(),
        MAX_MINIMIZED_FILTER_CHARS,
        "the label is cut at the engine's own width, the ellipsis included"
    );
    assert!(
        minimized.filter.ends_with('…'),
        "a cut label says it was cut: {}",
        minimized.filter
    );
}

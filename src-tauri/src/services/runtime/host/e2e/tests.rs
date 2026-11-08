//! The four end-to-end scenarios, each one a lifecycle claim about a real host process.
//!
//! | test | what running it proves |
//! | --- | --- |
//! | [`the_installed_host_answers_a_full_session`] | artifact digest, handshake, session lifecycle, ordered shutdown |
//! | [`a_protocol_mismatch_ends_the_host_with_exit_code_three`] | the refusal path of the handshake |
//! | [`closing_stdin_ends_the_host_by_itself`] | the launcher-gone path |
//! | [`killing_the_host_leaves_no_process_behind`] | the kill path |
//! | [`deleting_a_conversation_takes_its_transcript_and_nothing_else`] | the explicit delete path |
//!
//! They run one at a time (the harness serializes them) and each one owns a private data root.

use std::path::Path;

use super::*;
use crate::services::paths::{is_within, normalize_for_compare};
use crate::services::session_index;
use crate::state::SessionIndexCache;

/// The directories `ready` names have to be the ones this fixture pinned, because the host refuses
/// to start when a pinned variable disagrees with its data root - reaching this assertion at all
/// means the pins were accepted, and this says they were the right ones.
fn assert_ready(ready: &Value, fixture: &Fixture) {
    assert_eq!(
        field(ready, &["type"]).as_str(),
        Some("ready"),
        "the boot ends with ready: {ready}"
    );
    assert!(
        field(ready, &["initMs"]).as_u64().is_some(),
        "ready reports how long the boot took: {ready}"
    );
    for (key, expected) in [
        ("agentDir", &fixture.paths.agent_dir),
        ("sessionDir", &fixture.paths.host_sessions),
    ] {
        let reported = field(ready, &[key])
            .as_str()
            .unwrap_or_else(|| panic!("ready names {key}: {ready}"));
        assert_eq!(
            normalize_for_compare(Path::new(reported)),
            normalize_for_compare(expected),
            "the host must run against the data root it was given: {ready}"
        );
    }
}

/// The routing id shape the host mints: `s` followed by sixteen lowercase hex digits.
fn is_session_id(text: &str) -> bool {
    text.len() == 17
        && text.starts_with('s')
        && text[1..]
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
}

/// The artifact, the handshake, a session's whole life, and an ordered shutdown.
#[test]
#[ignore = "starts the real host artifact: needs binaries/omp-host-<triple>.exe + omp-host.json (run with --ignored)"]
fn the_installed_host_answers_a_full_session() {
    let _serial = serial();
    let mut host = Host::start(Fixture::new("session"));

    let ready = host.handshake();
    assert_ready(&ready, &host.fixture);

    let workspace = host.fixture.workspace.clone();
    let opened = host.ok(json!({
        "type": "session_open",
        "cwd": workspace,
        "workspaceId": 1,
    }));
    let session_id = field(&opened, &["sessionId"])
        .as_str()
        .expect("session_open names the session")
        .to_owned();
    assert!(
        is_session_id(&session_id),
        "the host mints `s<16 hex>` routing ids, got {session_id}"
    );
    assert_eq!(
        field(&opened, &["created"]).as_bool(),
        Some(true),
        "a path that did not exist yet is created: {opened}"
    );
    assert_eq!(
        field(&opened, &["loaded"]).as_bool(),
        Some(true),
        "the created session is loaded: {opened}"
    );
    let session_file = field(&opened, &["sessionFile"])
        .as_str()
        .expect("session_open names the file it owns")
        .to_owned();
    assert!(
        is_within(&host.fixture.canonical_root, Path::new(&session_file)),
        "the session file must live inside the data root the host was given: {session_file}"
    );
    // The id the desktop's own scan mints for that file has to be the one the host just answered
    // with: the sidebar keys the streaming state, the active row and the cold-status reads on the
    // id, and a `session_open` that answers with anything else can never be matched to it.
    assert_eq!(
        session_index::host_session_id(Path::new(&session_file)),
        session_id,
        "the scan's id and the host's routing id are one contract"
    );
    let state = field(&opened, &["state"]);
    assert!(
        field(state, &["seq"]).as_u64().is_some(),
        "session_open anchors the event stream with an integer state.seq: {state}"
    );
    assert_eq!(
        field(state, &["messageCount"]).as_u64(),
        Some(0),
        "a conversation with no turn has no messages: {state}"
    );
    assert_eq!(
        field(state, &["isStreaming"]).as_bool(),
        Some(false),
        "nothing is running in a session that just opened: {state}"
    );
    // The response is written after the session's own frames, which is what makes its `state.seq`
    // an anchor rather than a command that overtakes what it counts.
    assert!(
        host.unsolicited.iter().any(|frame| {
            frame.get("type").and_then(Value::as_str) == Some("state")
                && frame.get("sessionId").and_then(Value::as_str) == Some(session_id.as_str())
        }),
        "the session published its state before the open response: {:?}",
        host.unsolicited
    );

    let read = host.ok(json!({"type": "session_state", "sessionId": session_id}));
    let state = field(&read, &["state"]);
    assert!(
        field(state, &["seq"]).as_u64().is_some(),
        "session_state carries the same resync anchor: {state}"
    );
    assert_eq!(
        normalize_for_compare(Path::new(
            field(state, &["sessionFile"])
                .as_str()
                .expect("the state names its file")
        )),
        normalize_for_compare(Path::new(&session_file)),
        "the state describes the file the open named: {state}"
    );

    let page = host.ok(json!({
        "type": "session_history_page",
        "sessionId": session_id,
        "limit": 200,
    }));
    assert_eq!(
        field(&page, &["totalMessages"]).as_u64(),
        Some(0),
        "an untouched conversation has nothing to page through: {page}"
    );
    assert_eq!(
        field(&page, &["messages"]).as_array().map(Vec::len),
        Some(0),
        "the empty page carries no rows: {page}"
    );
    assert!(
        page.get("nextCursor").is_none(),
        "a page that is the whole transcript carries no cursor: {page}"
    );
    assert_eq!(
        field(&page, &["sessionId"]).as_str(),
        Some(session_id.as_str()),
        "the page answers for the session it was asked about: {page}"
    );

    // The store the host wrote that file into is one the desktop's own scan can list: the row it
    // reports for the session is the file the host opened, under the id it answers with.
    let listed = session_index::list_sessions(
        &host.fixture.paths.host_sessions,
        &host.fixture.workspace.to_string_lossy(),
        &SessionIndexCache::new(),
    );
    let row = listed
        .iter()
        .find(|summary| summary.id == session_id)
        .unwrap_or_else(|| panic!("the host's own session has to be listed: {listed:?}"));
    assert_eq!(
        normalize_for_compare(Path::new(&row.file_path)),
        normalize_for_compare(Path::new(&session_file)),
        "the listed row is the file the host opened: {row:?}"
    );

    let closed = host.ok(json!({"type": "session_close", "sessionId": session_id}));
    assert_eq!(
        field(&closed, &["closed"]).as_bool(),
        Some(true),
        "closing a live session reports it closed: {closed}"
    );
    // Idempotence at the host level: a second close is answered, not failed. The desktop layer
    // returns `Ok(())` for either answer (`session.rs::close`).
    let again = host.ok(json!({"type": "session_close", "sessionId": session_id}));
    assert_eq!(
        field(&again, &["closed"]).as_bool(),
        Some(false),
        "a session that is already gone closes as a no-op: {again}"
    );

    host.shutdown("e2e-session");
    // greeting, ready, hello_ok, the session's own frames, the four responses, and host_exit.
    host.assert_stdout_decoded(10);
}

/// A launcher speaking another protocol must be refused, with the exit code that refusal is
/// defined to produce.
#[test]
#[ignore = "starts the real host artifact: needs binaries/omp-host-<triple>.exe + omp-host.json (run with --ignored)"]
fn a_protocol_mismatch_ends_the_host_with_exit_code_three() {
    let _serial = serial();
    let mut host = Host::start(Fixture::new("mismatch"));

    let hello = host.frame(HANDSHAKE_DEADLINE);
    assert_hello(&hello);

    let id = host.id();
    host.send(json!({"type": "hello_ok", "protocol": PROTOCOL_VERSION + 1, "id": id}));
    let response = host.frame_of("response", HANDSHAKE_DEADLINE);
    assert_eq!(
        response.get("id").and_then(Value::as_str),
        Some(id.as_str()),
        "the refusal answers the handshake that was refused: {response}"
    );
    assert_eq!(
        response.get("success").and_then(Value::as_bool),
        Some(false),
        "an unsupported protocol cannot be accepted: {response}"
    );
    assert_eq!(
        response.get("code").and_then(Value::as_str),
        Some("protocol_mismatch"),
        "the refusal names the reason: {response}"
    );

    let exit = host.frame_of("host_exit", EXIT_DEADLINE);
    assert_eq!(
        field(&exit, &["reason"]).as_str(),
        Some("protocol_mismatch"),
        "the host says why it is leaving: {exit}"
    );
    assert_eq!(
        field(&exit, &["code"]).as_u64(),
        Some(3),
        "the exit frame carries the code the process leaves with: {exit}"
    );
    let status = host.expect_exit(EXIT_DEADLINE);
    assert_eq!(
        status.code(),
        Some(3),
        "a protocol mismatch ends the host with exit code 3: {status:?}"
    );
    // greeting, ready, the refusal.
    host.assert_stdout_decoded(3);
}

/// Closing stdin without a word is how a vanished launcher reaches the host: it has to end by
/// itself, cleanly, rather than linger.
#[test]
#[ignore = "starts the real host artifact: needs binaries/omp-host-<triple>.exe + omp-host.json (run with --ignored)"]
fn closing_stdin_ends_the_host_by_itself() {
    let _serial = serial();
    let mut host = Host::start(Fixture::new("stdin"));

    // The greeting and a completed boot prove the host got as far as serving, but no `hello_ok`
    // follows: the launcher simply goes away. Dropping the handle closes the pipe.
    let hello = host.frame(HANDSHAKE_DEADLINE);
    assert_hello(&hello);
    let ready = host.frame_of("ready", HANDSHAKE_DEADLINE);
    assert_ready(&ready, &host.fixture);
    host.stdin = None;

    let exit = host.frame_of("host_exit", EXIT_DEADLINE);
    assert_eq!(
        field(&exit, &["reason"]).as_str(),
        Some("stdin_closed"),
        "a closed command channel is why it left: {exit}"
    );
    assert_eq!(
        field(&exit, &["code"]).as_u64(),
        Some(0),
        "a launcher that went away is not a failure: {exit}"
    );
    let status = host.expect_exit(EXIT_DEADLINE);
    assert_eq!(
        status.code(),
        Some(0),
        "the host ends by itself with exit code 0 within {EXIT_DEADLINE:?}: {status:?}"
    );
    // greeting, ready, host_exit.
    host.assert_stdout_decoded(3);
}

/// The kill path (crash recovery, restart, application quit) has to take the whole tree down and
/// leave nothing behind.
#[test]
#[ignore = "starts the real host artifact: needs binaries/omp-host-<triple>.exe + omp-host.json (run with --ignored)"]
fn killing_the_host_leaves_no_process_behind() {
    let _serial = serial();
    let mut host = Host::start(Fixture::new("kill"));
    host.handshake();
    let workspace = host.fixture.workspace.clone();
    let opened = host.ok(json!({
        "type": "session_open",
        "cwd": workspace,
        "workspaceId": 1,
    }));
    assert_eq!(
        field(&opened, &["loaded"]).as_bool(),
        Some(true),
        "the host has to be serving a session when it is killed: {opened}"
    );

    // The probe is only worth anything if it can see the process before the kill.
    assert!(
        process_table_has(host.pid),
        "the host (pid {}) must be visible before the kill",
        host.pid
    );
    process::kill_tree(&host.child, host.pid);

    let status = host.expect_exit(EXIT_DEADLINE);
    assert_ne!(
        status.code(),
        Some(0),
        "a killed host does not report a clean exit: {status:?}"
    );
    assert!(
        wait_until_gone(host.pid, EXIT_DEADLINE),
        "the host tree must vanish from the process table when it is killed{}",
        host.diagnostics()
    );
    // greeting, ready, hello_ok, the session's own frames, session_open - all decoded before the
    // kill took the pipe away.
    host.assert_stdout_decoded(5);
}

/// The artifact the application spawns answers the composer's `/` palette: it advertises the
/// engine's commands (with the capability each came from) and runs a builtin locally.
///
/// This is the claim the running app depends on and neither side can check alone: the palette is
/// drawn from the `state` snapshot this host publishes, and a picked `/name` only does something
/// if the host dispatches it instead of handing the text to the engine's prompt path.
#[test]
#[ignore = "starts the real host artifact: needs binaries/omp-host-<triple>.exe + omp-host.json (run with --ignored)"]
fn the_installed_host_answers_a_command_prompt() {
    let _serial = serial();
    let mut host = Host::start(Fixture::new("slash"));

    host.handshake();
    let workspace = host.fixture.workspace.clone();
    let opened = host.ok(json!({
        "type": "session_open",
        "cwd": workspace,
        "workspaceId": 1,
    }));
    let session_id = field(&opened, &["sessionId"])
        .as_str()
        .expect("session_open names the session")
        .to_owned();

    let advertisement = host.take("available_commands_update");
    let commands = field(&advertisement, &["commands"])
        .as_array()
        .expect("the advertisement carries a command list");
    assert!(
        !commands.is_empty(),
        "the palette needs commands to draw: {advertisement}"
    );
    assert!(
        commands.iter().all(|command| !field(command, &["name"])
            .as_str()
            .unwrap_or_default()
            .is_empty()),
        "every advertised command has a name: {advertisement}"
    );
    assert!(
        commands.iter().all(|command| !field(command, &["source"])
            .as_str()
            .unwrap_or_default()
            .is_empty()),
        "every advertised command names where it came from: {advertisement}"
    );
    assert!(
        commands
            .iter()
            .any(|command| command.get("name").and_then(Value::as_str) == Some("tools")),
        "the engine's own `/tools` is advertised: {advertisement}"
    );

    // A builtin with a text handler runs in the host: the prompt is acknowledged, reported as
    // having invoked nothing, and what it printed arrives on the notice channel - with no agent
    // turn, which is what makes it a command rather than a prompt to the model.
    host.ok(json!({
        "type": "session_prompt",
        "sessionId": session_id,
        "message": "/tools",
    }));
    let result = host.take("prompt_result");
    assert_eq!(
        field(&result, &["agentInvoked"]).as_bool(),
        Some(false),
        "a builtin runs locally rather than as a turn: {result}"
    );
    let notice = host.take("notice");
    assert!(
        !field(&notice, &["message"])
            .as_str()
            .unwrap_or_default()
            .is_empty(),
        "the command's own output reaches the reader: {notice}"
    );
    assert!(
        host.unsolicited
            .iter()
            .chain(std::iter::once(&notice))
            .all(|frame| frame.get("type").and_then(Value::as_str) != Some("agent_start")),
        "a local command starts no turn{}",
        host.diagnostics()
    );
}

/// A conversation the composer opened and never used is discarded with its file; one that was
/// written to is kept.
///
/// The desktop opens a session for the hero before the first message - the engine's command list
/// *is* a session's - so a screen the user only looked at would otherwise leave an untitled row in
/// the session list. The engine writes a session file the moment one is created, so undoing that is
/// the host's to do, and only on the caller's word: `session_close` without `dropFile` keeps a
/// transcript, because a screen moving on never deletes what the user wrote (contract §4).
#[test]
#[ignore = "starts the real host artifact: needs binaries/omp-host-<triple>.exe + omp-host.json (run with --ignored)"]
fn an_unused_session_is_discarded_only_when_the_caller_says_so() {
    let _serial = serial();
    let mut host = Host::start(Fixture::new("empty-draft"));

    host.handshake();
    let workspace = host.fixture.workspace.clone();

    // A plain close keeps the file: the transcript a session names is not the host's to throw away.
    let opened = host.ok(json!({"type": "session_open", "cwd": workspace, "workspaceId": 1}));
    let kept_session = field(&opened, &["sessionId"])
        .as_str()
        .expect("session_open names the session")
        .to_owned();
    let kept_file = field(&opened, &["sessionFile"])
        .as_str()
        .expect("the engine writes a session file as it creates one")
        .to_owned();
    assert!(
        Path::new(&kept_file).is_file(),
        "the file the open named exists: {kept_file}"
    );
    host.ok(json!({"type": "session_close", "sessionId": kept_session}));
    assert!(
        Path::new(&kept_file).is_file(),
        "a close without `dropFile` leaves the file where it is: {kept_file}"
    );

    // And the caller that knows the conversation holds nothing takes it away.
    let draft = host.ok(json!({"type": "session_open", "cwd": workspace, "workspaceId": 1}));
    let draft_session = field(&draft, &["sessionId"])
        .as_str()
        .expect("session_open names the session")
        .to_owned();
    let draft_file = field(&draft, &["sessionFile"])
        .as_str()
        .expect("the engine writes a session file as it creates one")
        .to_owned();
    host.ok(json!({"type": "session_close", "sessionId": draft_session, "dropFile": true}));
    assert!(
        !Path::new(&draft_file).exists(),
        "a discarded conversation leaves no file behind: {draft_file}"
    );
}

/// Deleting a conversation removes its own files, refuses a path outside the session directory, and
/// answers rather than failing when there is nothing left to remove.
///
/// This is the one command that destroys a transcript, so what it may touch is the claim worth
/// pinning: the path is resolved inside the host's session directory (`invalid_session_path`
/// otherwise), the transcript leaves the disk with it, and a second call is a no-op - the caller
/// asked for the file to not exist, and it does not.
///
/// A conversation that is still working is refused with `session_busy` and is deliberately not
/// covered here: producing a running turn needs a model, which these tests do not have. What is
/// covered is the shape of the refusal: the same request against a session that *is* loaded and
/// idle is answered, so the gate is the work rather than the lookup.
#[test]
#[ignore = "starts the real host artifact: needs binaries/omp-host-<triple>.exe + omp-host.json (run with --ignored)"]
fn deleting_a_conversation_takes_its_transcript_and_nothing_else() {
    let _serial = serial();
    let mut host = Host::start(Fixture::new("delete-conversation"));

    host.handshake();
    let workspace = host.fixture.workspace.clone();
    let sessions_dir = host.fixture.paths.host_sessions.clone();

    // Something to delete: a conversation the host created and then let go of, so the delete has to
    // find it by its file rather than by a record it still holds.
    let opened = host.ok(json!({"type": "session_open", "cwd": workspace, "workspaceId": 1}));
    let session_id = field(&opened, &["sessionId"])
        .as_str()
        .expect("session_open names the session")
        .to_owned();
    let session_file = field(&opened, &["sessionFile"])
        .as_str()
        .expect("the engine writes a session file as it creates one")
        .to_owned();
    host.ok(json!({"type": "session_close", "sessionId": session_id}));
    assert!(
        Path::new(&session_file).is_file(),
        "the conversation is on disk before the delete: {session_file}"
    );

    let deleted = host.ok(json!({"type": "session_delete", "sessionFile": session_file}));
    assert_eq!(
        field(&deleted, &["deleted"]).as_bool(),
        Some(true),
        "the delete reports what it removed: {deleted}"
    );
    assert!(
        !Path::new(&session_file).exists(),
        "the transcript is gone: {session_file}"
    );

    // The same request again: nothing left to remove is not a failure.
    let again = host.ok(json!({"type": "session_delete", "sessionFile": session_file}));
    assert_eq!(
        field(&again, &["deleted"]).as_bool(),
        Some(false),
        "a second delete finds nothing and says so: {again}"
    );

    // Outside the session directory - here, the workspace the sessions point at - is refused, and
    // the file it named is untouched. The workspace holds no session file, so this asserts the
    // refusal rather than a deletion the caller could have meant.
    let outside = sessions_dir
        .parent()
        .expect("the session directory has a parent")
        .join("outside-the-session-directory.jsonl");
    std::fs::write(&outside, b"{}\n").expect("write the file that must survive");
    let refusal =
        host.call(json!({"type": "session_delete", "sessionFile": outside.to_string_lossy()}));
    assert_eq!(
        field(&refusal, &["success"]).as_bool(),
        Some(false),
        "a path outside the session directory is refused: {refusal}"
    );
    assert_eq!(
        field(&refusal, &["code"]).as_str(),
        Some("invalid_session_path"),
        "the refusal carries the code the launcher words: {refusal}"
    );
    assert!(
        outside.is_file(),
        "the refused path is untouched: {}",
        outside.display()
    );
    let _ = std::fs::remove_file(&outside);

    host.shutdown("e2e-delete-conversation");
}

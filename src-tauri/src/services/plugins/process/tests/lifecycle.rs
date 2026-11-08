use super::*;

// ---- the lifecycle ----

/// A process starts on the first call, answers under the request's own id, and stops the graceful
/// way: `worker_unload` is answered and the child leaves by itself (no kill).
#[test]
fn a_process_starts_answers_and_stops_after_unloading() {
    let spawner = FakeSpawner::new(FakeScript::default());
    let process = supervisor(Arc::clone(&spawner));
    process.sync(vec![install("demo")]);

    let answer = process
        .run_command("demo", "user", "probe")
        .expect("an answer");
    assert!(answer.ok, "{answer:?}");
    assert_eq!(answer.value.expect("a value")["method"], "command.execute");

    let row = process.snapshot().processes.remove(0);
    assert_eq!(row.state, "running");
    assert_eq!(row.pid, Some(4242));

    process.shutdown_all();
    assert_eq!(process.snapshot().processes[0].state, "stopped");

    let record = spawner.record("demo@test-market");
    let (unload, kill) = record.positions("send:worker_unload", "kill");
    assert!(unload.is_some(), "the stop always tries the unload");
    assert!(kill.is_none(), "a worker that says goodbye is not killed");
    assert_eq!(record.exit_code.load(Ordering::SeqCst), 0);
}

/// A renderer call is judged before anything is started: an undeclared method and one that is not a
/// method name at all are refused without waking a process, and a declared one reaches the worker as
/// `renderer.call` with the method and parameters it named.
#[test]
fn a_renderer_call_is_whitelisted_before_it_reaches_the_worker() {
    let spawner = FakeSpawner::new(FakeScript::default());
    let process = supervisor(Arc::clone(&spawner));
    process.sync(vec![install("demo")]);

    let undeclared = process.call_renderer("demo", "user", "deleteEverything", json!({}));
    assert!(!undeclared.ok);
    assert_eq!(undeclared.code.as_deref(), Some(PLUGIN_ACTION_UNDECLARED));
    let malformed = process.call_renderer("demo", "user", "not a method", json!({}));
    assert!(!malformed.ok);
    assert_eq!(malformed.code.as_deref(), Some(PLUGIN_ACTION_UNKNOWN));
    assert_eq!(
        process.snapshot().processes[0].state,
        "stopped",
        "a refused method does not wake a process"
    );
    assert!(
        !spawner
            .record("demo@test-market")
            .events()
            .iter()
            .any(|event| event == "send:worker_call"),
        "nothing was sent for a refused method"
    );

    let answer = process.call_renderer("demo", "user", "listSnippets", json!({ "query": "x" }));
    assert!(answer.ok, "{answer:?}");
    let value = answer.value.expect("a value");
    assert_eq!(value["method"], "renderer.call");
    assert_eq!(value["params"]["method"], "listSnippets");
    assert_eq!(value["params"]["params"]["query"], "x");
    assert_eq!(process.snapshot().processes[0].state, "running");

    process.shutdown_all();
}

/// A renderer call for an installation with no process descriptor is refused with the process
/// vocabulary, never answered by starting something else.
#[test]
fn a_renderer_call_without_a_process_is_unavailable() {
    let spawner = FakeSpawner::new(FakeScript::default());
    let process = supervisor(Arc::clone(&spawner));
    process.sync(Vec::new());
    let answer = process.call_renderer("demo", "user", "listSnippets", json!({}));
    assert!(!answer.ok);
    assert_eq!(answer.code.as_deref(), Some(PLUGIN_PROCESS_UNAVAILABLE));
    assert_eq!(spawner.record("demo@test-market").spawns(), 0);
}

/// A worker speaking another protocol version is stopped and the row says why; a second call is
/// refused without spawning anything, because a mismatch is not a crash to retry.
#[test]
fn a_protocol_mismatch_is_refused_and_not_retried() {
    let spawner = FakeSpawner::new(FakeScript {
        protocol: WORKER_PROTOCOL + 1,
        ..FakeScript::default()
    });
    let process = supervisor(Arc::clone(&spawner));
    process.sync(vec![install("demo")]);

    let refusal = process
        .run_command("demo", "user", "probe")
        .expect_err("refused");
    assert_eq!(refusal.code.as_ref(), PLUGIN_PROCESS_PROTOCOL_MISMATCH);

    let row = process.snapshot().processes.remove(0);
    assert_eq!(row.state, "crashed");
    assert_eq!(row.reason.as_deref(), Some(REASON_PROTOCOL_MISMATCH));
    assert_eq!(row.restarts, 0, "a mismatch is not a crash budget");

    let again = process
        .run_command("demo", "user", "probe")
        .expect_err("refused again");
    assert_eq!(again.code.as_ref(), PLUGIN_PROCESS_PROTOCOL_MISMATCH);
    assert_eq!(
        spawner.record("demo@test-market").spawns(),
        1,
        "a terminal crash never starts another child on its own"
    );
}

/// A call that runs past its budget stops the process, records the timeout, and answers `timeout`.
#[test]
fn a_call_that_hangs_is_killed_with_the_timeout_token() {
    let spawner = FakeSpawner::new(FakeScript {
        answer_calls: false,
        ..FakeScript::default()
    });
    let process = supervisor(Arc::clone(&spawner));
    process.sync(vec![install("demo")]);

    let answer = process
        .run_command("demo", "user", "probe")
        .expect("a settlement");
    assert!(!answer.ok);
    assert_eq!(answer.code.as_deref(), Some("timeout"));

    let row = process.snapshot().processes.remove(0);
    assert_eq!(row.state, "crashed");
    assert_eq!(row.reason.as_deref(), Some(REASON_TIMEOUT));
    assert!(
        spawner
            .record("demo@test-market")
            .killed
            .load(Ordering::SeqCst),
        "the hung child is stopped, not waited on"
    );
}

/// The seventeenth live installation recycles the least recently used one first, and the stop is an
/// unload followed by a kill - never a kill alone.
#[test]
fn the_seventeenth_installation_recycles_the_oldest_and_unloads_first() {
    // A worker that does not answer `worker_unload`, so the forced-stop half of the rule is what
    // runs and the recorded order is the one that matters.
    let spawner = FakeSpawner::new(FakeScript {
        answer_unload: false,
        ..FakeScript::default()
    });
    let process = supervisor(Arc::clone(&spawner));
    let installs: Vec<ProcessInstall> = (0..17)
        .map(|index| install(&format!("demo-{index:02}")))
        .collect();
    process.sync(installs);

    for index in 0..17 {
        let answer = process
            .run_command(&format!("demo-{index:02}"), "user", "probe")
            .expect("an answer");
        assert!(answer.ok, "{index}: {answer:?}");
    }

    let live = process
        .snapshot()
        .processes
        .iter()
        .filter(|row| row.state == "running")
        .count();
    assert_eq!(live, MAX_LIVE_PROCESSES, "the ceiling is sixteen");

    let victim = spawner.record("demo-00@test-market");
    let (unload, kill) = victim.positions("send:worker_unload", "kill");
    assert!(unload.is_some(), "the recycled worker is asked to unload");
    let kill = kill.expect("a worker that never answers is killed");
    assert!(
        unload.expect("recorded") < kill,
        "the unload is written before the kill: {:?}",
        victim.events()
    );
    let recycled = process
        .snapshot()
        .processes
        .into_iter()
        .find(|row| row.plugin_id == "demo-00")
        .expect("the row stays");
    assert_eq!(recycled.state, "stopped");
}

/// A manifest that turned the restarts off goes straight to `crashed`: no second spawn is ever
/// scheduled, and the row is where the reader sees it (the manual restart still works).
#[test]
fn a_manifest_that_forbids_restarts_is_not_restarted() {
    let spawner = FakeSpawner::new(FakeScript {
        crash_after_load: true,
        ..FakeScript::default()
    });
    let process = supervisor(Arc::clone(&spawner));
    let mut installation = install("demo");
    installation.auto_restart = false;
    process.sync(vec![installation]);
    let _ = process.run_command("demo", "user", "probe");

    wait_until("the crashed row", || {
        process
            .snapshot()
            .processes
            .first()
            .is_some_and(|row| row.state == "crashed")
    });
    // The row is `crashed` before any retry could have fired, so the assertion has to outlive the
    // first backoff step: a scheduled restart appears within it, and no restart in that window is
    // what `autoRestart: false` means. The positive control is `a_crash_is_retried_after_the_backoff`,
    // which sees the second spawn inside this same window.
    let deadline = Instant::now() + Duration::from_millis(2_500);
    while Instant::now() < deadline && spawner.record("demo@test-market").spawns() < 2 {
        std::thread::sleep(Duration::from_millis(25));
    }
    assert_eq!(
        spawner.record("demo@test-market").spawns(),
        1,
        "a manifest with `autoRestart: false` is not restarted"
    );
}

/// A crash after the process became live is retried after the first backoff step (1 s), and the row
/// reports the restart; the second start is healthy and the process runs again.
#[test]
fn a_crash_is_retried_after_the_backoff() {
    let spawner = FakeSpawner::new(FakeScript {
        crash_after_load: true,
        ..FakeScript::default()
    });
    let process = supervisor(Arc::clone(&spawner));
    process.sync(vec![install("demo")]);
    let _ = process.run_command("demo", "user", "probe");

    wait_until("the restarted process", || {
        process
            .snapshot()
            .processes
            .first()
            .is_some_and(|row| row.state == "running" && row.restarts == 1)
    });
    assert_eq!(spawner.record("demo@test-market").spawns(), 2);
}

/// A new revision stops the running process and keeps the row at `stopped`; an installation the list
/// no longer reports loses its row - the two upgrade/uninstall triggers of plan §6.4.
#[test]
fn an_upgrade_stops_the_process_and_an_uninstall_drops_the_row() {
    let spawner = FakeSpawner::new(FakeScript::default());
    let process = supervisor(Arc::clone(&spawner));
    process.sync(vec![install("demo")]);
    assert!(
        process
            .run_command("demo", "user", "probe")
            .expect("an answer")
            .ok
    );

    let mut upgraded = install("demo");
    upgraded.revision = "2.0.0\u{0}main.js".to_owned();
    process.sync(vec![upgraded]);
    wait_until("the stopped worker", || {
        spawner
            .record("demo@test-market")
            .positions("send:worker_unload", "kill")
            .0
            .is_some()
    });
    assert_eq!(process.snapshot().processes[0].state, "stopped");

    process.sync(Vec::new());
    assert!(
        process.snapshot().processes.is_empty(),
        "an uninstalled plugin has no row"
    );
}

/// A disabled installation is stopped and not started again by a call; the row stays so the page can
/// say it is disabled rather than absent.
#[test]
fn a_disabled_installation_is_stopped() {
    let spawner = FakeSpawner::new(FakeScript::default());
    let process = supervisor(Arc::clone(&spawner));
    process.sync(vec![install("demo")]);
    assert!(
        process
            .run_command("demo", "user", "probe")
            .expect("an answer")
            .ok
    );

    let mut disabled = install("demo");
    disabled.enabled = false;
    process.sync(vec![disabled]);
    wait_until("the stop", || {
        process
            .snapshot()
            .processes
            .first()
            .is_some_and(|row| row.state == "stopped")
    });
    let refusal = process
        .run_command("demo", "user", "probe")
        .expect_err("a disabled installation has no process");
    assert_eq!(refusal.code.as_ref(), PLUGIN_PROCESS_UNAVAILABLE);
}

/// A write that replaces or removes a package stops that installation's child first, and only that
/// one.
///
/// An uninstall, an upgrade and a source switch all rewrite the installation's directory, and a live
/// worker holds it: its working directory *is* the package, and Windows answers `EBUSY` to the
/// engine's own removal while the child exists (2026-10-27 - a source switch failed that way and left
/// the plugin uninstalled with its files behind). The supervisor therefore has a targeted stop the
/// write flows call before touching the files.
#[test]
fn stopping_one_installation_leaves_the_others_running() {
    let spawner = FakeSpawner::new(FakeScript::default());
    let process = supervisor(Arc::clone(&spawner));
    process.sync(vec![install("demo"), install("other")]);
    process
        .run_command("demo", "user", "probe")
        .expect("an answer");
    process
        .run_command("other", "user", "probe")
        .expect("an answer");
    assert_eq!(process.snapshot().processes.len(), 2);

    process
        .stop_installation("demo", "user")
        .expect("a targeted stop");

    let rows = process.snapshot().processes;
    let state_of = |id: &str| {
        rows.iter()
            .find(|row| row.plugin_id == id)
            .map(|row| row.state)
    };
    assert_eq!(state_of("demo"), Some("stopped"));
    assert_eq!(state_of("other"), Some("running"));

    let record = spawner.record("demo@test-market");
    let (unload, kill) = record.positions("send:worker_unload", "kill");
    assert!(unload.is_some(), "the stop is graceful first");
    assert!(kill.is_none(), "a worker that says goodbye is not killed");

    // Stopping what is not running is what the caller wants too, not an error.
    process
        .stop_installation("demo", "user")
        .expect("an idempotent stop");
    process
        .stop_installation("never-started", "user")
        .expect("an unknown installation is a no-op");
}

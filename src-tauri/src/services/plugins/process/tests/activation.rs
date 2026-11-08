use super::*;

// ---- activation events ----

/// Only a row that may run, is enabled and lists `onStartup` asks to be started (plan §6.1).
///
/// The descriptor is the first filter: `install_of` refuses a row without a `main`, without
/// `plugin.process` and without the recorded confirmation, so a row that reaches the supervisor has
/// already passed "may run at all".
#[test]
fn only_a_declaring_enabled_available_row_asks_for_startup() {
    let declaring = row("demo", false, &["plugin.process"]);
    let checked = recheck_desktop(&declaring).expect("a valid block");
    let install = install_of(&declaring, Some(&checked), true, None).expect("an available row");
    assert!(install.wants_startup(), "the row declares onStartup");

    let mut lazy_row = declaring.clone();
    lazy_row
        .desktop
        .as_mut()
        .and_then(|block| block.process.as_mut())
        .expect("a process block")
        .activation_events = vec!["onCommand:probe".to_owned()];
    let checked = recheck_desktop(&lazy_row).expect("a valid block");
    let lazy = install_of(&lazy_row, Some(&checked), true, None).expect("an available row");
    assert!(
        !lazy.wants_startup(),
        "a package that declares no onStartup is not started with the application"
    );

    let mut disabled_row = declaring.clone();
    disabled_row.enabled = false;
    let checked = recheck_desktop(&disabled_row).expect("a valid block");
    let disabled = install_of(&disabled_row, Some(&checked), true, None).expect("a descriptor");
    assert!(
        !disabled.wants_startup(),
        "a disabled plugin is not started with the application"
    );

    assert!(
        install_of(&declaring, Some(&checked), false, None).is_none(),
        "a third-party row without the confirmation has no descriptor at all"
    );

    let mut no_main = declaring.clone();
    no_main
        .desktop
        .as_mut()
        .and_then(|block| block.process.as_mut())
        .expect("a process block")
        .main = None;
    let checked = recheck_desktop(&no_main).expect("a valid block");
    assert!(
        install_of(&no_main, Some(&checked), true, None).is_none(),
        "a block without a main has nothing to start"
    );
}

/// `onStartup` starts the declaring, enabled installations and leaves the others `stopped`; the load
/// frame names the event that woke it, and the start happens off the caller's thread.
#[test]
fn on_startup_wakes_only_the_installations_that_declare_it() {
    let spawner = FakeSpawner::new(FakeScript::default());
    let process = supervisor(Arc::clone(&spawner));
    let mut disabled = install_with_events("demo-disabled", &[ACTIVATION_STARTUP]);
    disabled.enabled = false;
    process.sync(vec![
        install_with_events("demo-up", &[ACTIVATION_STARTUP]),
        install_with_events("demo-lazy", &["onCommand:probe"]),
        disabled,
    ]);

    process.start_on_startup();
    wait_until("the declared installation's process", || {
        process
            .snapshot()
            .processes
            .iter()
            .any(|row| row.plugin_id == "demo-up" && row.state == "running")
    });

    let state_of = |id: &str| {
        process
            .snapshot()
            .processes
            .into_iter()
            .find(|row| row.plugin_id == id)
            .map(|row| row.state)
            .expect("a row")
    };
    assert_eq!(state_of("demo-lazy"), "stopped");
    assert_eq!(state_of("demo-disabled"), "stopped");
    assert_eq!(spawner.record("demo-lazy@test-market").spawns(), 0);
    assert_eq!(spawner.record("demo-disabled@test-market").spawns(), 0);
    assert!(
        spawner
            .record("demo-up@test-market")
            .events()
            .iter()
            .any(|event| event == "send:worker_load:onStartup"),
        "the load carries the event that woke it"
    );

    // A second read of the same list does not wake anything again: onStartup is per package.
    process.start_on_startup();
    assert_eq!(spawner.record("demo-up@test-market").spawns(), 1);
}

/// A terminally crashed process is not woken by `onStartup`: the crash budget is the user's manual
/// restart to overrule (plan §6.4).
#[test]
fn on_startup_leaves_a_crashed_process_alone() {
    let spawner = FakeSpawner::new(FakeScript {
        protocol: WORKER_PROTOCOL + 1,
        ..FakeScript::default()
    });
    let process = supervisor(Arc::clone(&spawner));
    process.sync(vec![install_with_events("demo", &[ACTIVATION_STARTUP])]);

    process.start_on_startup();
    wait_until("the crashed row", || {
        process
            .snapshot()
            .processes
            .first()
            .is_some_and(|row| row.state == "crashed")
    });
    process.start_on_startup();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(
        spawner.record("demo@test-market").spawns(),
        1,
        "the crashed row is not respawned by a list read"
    );
    assert_eq!(process.snapshot().processes[0].state, "crashed");
}

/// The live ceiling still applies when the wake-ups come from `onStartup`: the seventeenth start
/// recycles the least recently used process, unload first.
#[test]
fn startup_wake_ups_still_recycle_at_the_live_ceiling() {
    // A worker that does not answer `worker_unload`, so the forced-stop half of the rule is what
    // runs and the recorded order is the one that matters.
    let spawner = FakeSpawner::new(FakeScript {
        answer_unload: false,
        ..FakeScript::default()
    });
    let process = supervisor(Arc::clone(&spawner));
    let installs: Vec<ProcessInstall> = (0..17)
        .map(|index| install_with_events(&format!("demo-{index:02}"), &[ACTIVATION_STARTUP]))
        .collect();
    process.sync(installs);

    process.start_on_startup();
    wait_until("sixteen live processes", || {
        process
            .snapshot()
            .processes
            .iter()
            .filter(|row| row.state == "running")
            .count()
            == MAX_LIVE_PROCESSES
    });

    let rows = process.snapshot().processes;
    let recycled = rows
        .iter()
        .find(|row| row.plugin_id == "demo-00")
        .expect("the row stays");
    assert_eq!(recycled.state, "stopped");
    assert!(
        rows.iter()
            .find(|row| row.plugin_id == "demo-16")
            .is_some_and(|row| row.state == "running"),
        "the newest of the seventeen is the one that replaced it"
    );
    let victim = spawner.record("demo-00@test-market");
    let (unload, kill) = victim.positions("send:worker_unload", "kill");
    let unload = unload.expect("the recycled worker is asked to unload");
    let kill = kill.expect("a worker that never answers is killed");
    assert!(
        unload < kill,
        "the unload is written before the kill: {:?}",
        victim.events()
    );
}

/// `activate` acts only on an event the package declared, wakes a stopped process under that event,
/// and treats a live process as kept - the same event is a no-op and another one is advisory.
#[test]
fn activate_refuses_an_undeclared_event_and_keeps_a_live_process() {
    let spawner = FakeSpawner::new(FakeScript::default());
    let process = supervisor(Arc::clone(&spawner));
    process.sync(vec![install_with_events(
        "demo",
        &[ACTIVATION_STARTUP, "onView:card", "onCommand:probe"],
    )]);

    let refusal = process
        .activate("demo", "user", "onView:other")
        .expect_err("an undeclared event");
    assert_eq!(refusal.code.as_ref(), INVALID_INPUT);
    assert!(
        refusal.message.contains("onView:other"),
        "the refusal names the event: {refusal:?}"
    );
    assert_eq!(
        spawner.record("demo@test-market").spawns(),
        0,
        "an undeclared event wakes nothing"
    );

    let view = process
        .activate("demo", "user", "onView:card")
        .expect("a declared event");
    assert_eq!(view.processes[0].state, "running");
    let record = spawner.record("demo@test-market");
    assert!(
        record
            .events()
            .iter()
            .any(|event| event == "send:worker_load:onView:card"),
        "the load carries the view event that woke it: {:?}",
        record.events()
    );

    // Twice with the same event: the live process is kept, and nothing is loaded again.
    process
        .activate("demo", "user", "onView:card")
        .expect("the same event");
    assert_eq!(record.spawns(), 1);
    assert_eq!(
        record
            .events()
            .iter()
            .filter(|event| event.starts_with("send:worker_load"))
            .count(),
        1
    );

    // A different declared event while running is advisory only: no restart, no second load.
    let view = process
        .activate("demo", "user", "onStartup")
        .expect("another declared event");
    assert_eq!(view.processes[0].state, "running");
    assert_eq!(record.spawns(), 1);
    assert_eq!(
        record
            .events()
            .iter()
            .filter(|event| event.starts_with("send:worker_load"))
            .count(),
        1
    );
}

/// A command execution wakes its process under `onCommand:<id>`, which is the event the load frame
/// carries (plan §6.1).
#[test]
fn a_command_wakes_its_process_under_the_command_activation_event() {
    let spawner = FakeSpawner::new(FakeScript::default());
    let process = supervisor(Arc::clone(&spawner));
    process.sync(vec![install_with_events("demo", &[ACTIVATION_STARTUP])]);

    let answer = process
        .run_command("demo", "user", "probe")
        .expect("an answer");
    assert!(answer.ok, "{answer:?}");
    assert!(
        spawner
            .record("demo@test-market")
            .events()
            .iter()
            .any(|event| event == "send:worker_load:onCommand:probe"),
        "the load names the command that woke it"
    );
}

/// Switching a plugin off stops it; switching it on again fires its `onStartup` start once more,
/// while a process the live ceiling recycled is not re-woken by every list read.
#[test]
fn re_enabling_fires_on_startup_again() {
    let spawner = FakeSpawner::new(FakeScript::default());
    let process = supervisor(Arc::clone(&spawner));
    process.sync(vec![install_with_events("demo", &[ACTIVATION_STARTUP])]);
    process.start_on_startup();
    wait_until("the startup process", || {
        process
            .snapshot()
            .processes
            .first()
            .is_some_and(|row| row.state == "running")
    });

    let mut disabled = install_with_events("demo", &[ACTIVATION_STARTUP]);
    disabled.enabled = false;
    process.sync(vec![disabled]);
    process.start_on_startup();
    wait_until("the disabled stop", || {
        process
            .snapshot()
            .processes
            .first()
            .is_some_and(|row| row.state == "stopped")
    });

    process.sync(vec![install_with_events("demo", &[ACTIVATION_STARTUP])]);
    process.start_on_startup();
    wait_until("the enabled process", || {
        process
            .snapshot()
            .processes
            .first()
            .is_some_and(|row| row.state == "running")
    });
    assert_eq!(spawner.record("demo@test-market").spawns(), 2);
}

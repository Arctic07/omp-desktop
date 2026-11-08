use super::*;

// ---- the real worker ----

/// The one test that runs the protocol against the real host tree: a temp plugin, `bun
/// host/src/main.ts --plugin-worker …`, and the four facts that matter.
///
/// It is skipped when this machine has no `bun`, which is the same prerequisite the host build has;
/// every other test in this file is the fake. The fixture's command asks for `fs.read` while the
/// manifest does not declare it, so the refusal it returns is *this side's* answer, relayed by the
/// worker - the seam the whole feature exists for.
#[test]
fn a_real_worker_handshakes_answers_and_unloads() {
    let Some(bun) = find_bun() else {
        eprintln!("skipping the real worker test: bun is not on PATH");
        return;
    };
    let Some(script) = host_script() else {
        eprintln!("skipping the real worker test: the host tree is not beside this crate");
        return;
    };
    let root = fixture_root();
    let install = fixture_install(&root);
    let process = PluginProcess::detached(
        Arc::new(ScriptSpawner {
            program: bun,
            script,
        }),
        Timeouts::default(),
    );
    process.sync(vec![install]);

    let answer = process
        .run_command("process-fixture", "user", "probe")
        .expect("an answer");
    assert!(answer.ok, "the command ran: {answer:?}");
    let value = answer.value.expect("the command's value");
    assert_eq!(
        value["refusal"], "permission_denied",
        "the worker relayed this side's refusal verbatim: {value}"
    );
    assert_eq!(process.snapshot().processes[0].state, "running");

    process.shutdown_all();
    assert_eq!(process.snapshot().processes[0].state, "stopped");
    wait_until("the worker's own exit", || {
        process.last_exit_code("process-fixture@local", "user") == Some(Some(0))
    });
    let _ = std::fs::remove_dir_all(&root);
}

/// The install one fixture directory describes: the process permission, the command permission, and
/// the one command the manifest contributes.
fn fixture_install(root: &std::path::Path) -> ProcessInstall {
    ProcessInstall {
        install: "process-fixture@local".to_owned(),
        plugin_id: "process-fixture".to_owned(),
        name: "Process Fixture".to_owned(),
        scope: "user".to_owned(),
        root: root.to_path_buf(),
        commands: vec![InstallCommand {
            id: "probe".to_owned(),
        }],
        activation_events: Vec::new(),
        renderer_call_methods: Vec::new(),
        // `command.register` is declared, `fs.read` deliberately is not: the command's own body
        // calls `pi.fs.read` and reports the code it was refused with.
        grants: PageGrants {
            permissions: vec!["plugin.process".to_owned(), "command.register".to_owned()],
            ..PageGrants::default()
        },
        enabled: true,
        workspace: None,
        auto_restart: true,
        revision: "1.0.0\u{0}main.mjs".to_owned(),
    }
}

/// A restarted child registers its own commands again.
///
/// The registry `command.register` writes into belongs to the *process*, and a restart is a new
/// process running `onLoad` once more. Keeping the previous child's ids made every re-registration
/// fail as a duplicate, which a plugin whose `onLoad` awaits it (the shape the author guide shows)
/// turns into a startup refusal: the plugin could not be restarted at all, including after a crash.
#[test]
fn a_restarted_worker_registers_its_commands_again() {
    let Some(bun) = find_bun() else {
        eprintln!("skipping the real worker test: bun is not on PATH");
        return;
    };
    let Some(script) = host_script() else {
        eprintln!("skipping the real worker test: the host tree is not beside this crate");
        return;
    };
    let root = fixture_root();
    let process = PluginProcess::detached(
        Arc::new(ScriptSpawner {
            program: bun,
            script,
        }),
        Timeouts::default(),
    );
    process.sync(vec![fixture_install(&root)]);

    let first = process
        .run_command("process-fixture", "user", "probe")
        .expect("an answer");
    assert!(first.ok, "the first start ran its command: {first:?}");

    let after = process.restart("process-fixture", "user").expect("a table");
    assert_eq!(
        after.processes[0].state, "running",
        "the restarted child is running: {after:?}"
    );
    assert_eq!(
        after.processes[0].reason, None,
        "and it did not refuse to start"
    );

    let second = process
        .run_command("process-fixture", "user", "probe")
        .expect("an answer");
    assert!(
        second.ok,
        "the restarted child answers its command, so its `onLoad` registered it again: {second:?}"
    );
    assert_eq!(
        second.value, first.value,
        "the same command, the same answer"
    );

    process.shutdown_all();
    let _ = std::fs::remove_dir_all(&root);
}

/// The production spawner, pointed at a script instead of the artifact: the real worker's launch,
/// with the real host tree.
struct ScriptSpawner {
    program: PathBuf,
    script: PathBuf,
}

impl Spawner for ScriptSpawner {
    fn spawn(&self, install: &ProcessInstall) -> IpcResult<Spawned> {
        // The production spawner, with the test's launcher: what it proves is the real argv, the
        // real environment clearing and the real pipes.
        HostSpawner {
            launch: Launch::Script {
                program: self.program.clone(),
                script: self.script.clone(),
            },
        }
        .spawn(install)
    }
}

/// The runtime the host tree is run with, when this machine has one.
fn find_bun() -> Option<PathBuf> {
    let name = if cfg!(windows) { "bun.exe" } else { "bun" };
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let candidate = PathBuf::from(home).join(".bun").join("bin").join(name);
    candidate.is_file().then_some(candidate)
}

/// `host/src/main.ts` of the repository this crate is built in.
fn host_script() -> Option<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let script = root.join("host").join("src").join("main.ts");
    script.is_file().then_some(script)
}

/// A temp plugin whose one command probes the gate and reports the refusal it got.
fn fixture_root() -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let root =
        std::env::temp_dir().join(format!("omp-plugin-process-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&root).expect("a fixture directory");
    std::fs::write(
        root.join("package.json"),
        serde_json::to_string_pretty(&json!({
            "name": "process-fixture",
            "version": "1.0.0",
            "private": true,
            "type": "module",
            "omp": {
                "name": "process-fixture",
                "desktop": {
                    "main": "main.mjs",
                    "activationEvents": ["onStartup"],
                    "contributes": { "commands": [{ "id": "probe", "title": { "en": "Probe" } }] },
                    "permissions": ["plugin.process", "command.register"]
                }
            }
        }))
        .expect("a manifest"),
    )
    .expect("a manifest file");
    std::fs::write(
        root.join("main.mjs"),
        r#"export function onLoad(pi) {
  pi.commands.register({
    id: 'probe',
    handler: async () => {
      try {
        await pi.fs.read('notes.md')
        return { refusal: 'none' }
      } catch (error) {
        return { refusal: error.code }
      }
    },
  }).catch(error => pi.log(`register failed: ${error.code}`))
}

export function onUnload() {}
"#,
    )
    .expect("a fixture entry");
    root
}

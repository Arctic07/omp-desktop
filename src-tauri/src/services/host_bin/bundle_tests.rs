//! Unit tests for the bundle path.

pub(crate) use super::*;

/// One directory per case; see the compiled tests' `workspace` for why.
fn workspace(case: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("omp-host-bundle-{case}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let _ = fs::create_dir_all(&root);
    root
}

/// Writes a bundle whose manifest matches its files, and returns the directory.
fn write_bundle(case: &str, files: &[(&str, &str, &[u8])], argv: &[&str], entry: &str) -> PathBuf {
    let root = workspace(case);
    let mut entries: Vec<String> = Vec::new();
    for (name, role, bytes) in files {
        fs::write(root.join(name), bytes).expect("write bundle file");
        let digest = digest(&root.join(name)).expect("digest");
        entries.push(format!(
            r#"{{"file":"{name}","role":"{role}","bytes":{},"sha256":"{digest}"}}"#,
            bytes.len()
        ));
    }
    let argv: Vec<String> = argv.iter().map(|arg| format!(r#""{arg}""#)).collect();
    fs::write(
            root.join(BUNDLE_MANIFEST),
            format!(
                r#"{{"layout":"bundle","sdkVersion":"18.16.0","bunVersion":"1.3.14","protocol":{PROTOCOL_VERSION},"target":"x86_64-pc-windows-msvc","entry":"{entry}","argv":[{}],"files":[{}]}}"#,
                argv.join(","),
                entries.join(",")
            ),
        )
        .expect("write bundle manifest");
    root
}

/// The bundle's invocation is rebuilt, never taken as a shell string: the program is the
/// manifest's runtime, the flags precede it, and the entry is resolved inside the directory.
#[test]
fn a_verified_bundle_names_its_runtime_and_entry() {
    let root = write_bundle(
        "ok",
        &[
            ("bun.exe", "runtime", b"runtime bytes"),
            ("host.js", "bundle", b"host bytes"),
            ("addon.node", "addon", b"addon bytes"),
        ],
        &["--no-env-file", "--user-agent=omp/1", "host.js"],
        "host.js",
    );
    let artifact = verify_bundle(&root).expect("verified bundle");
    assert_eq!(artifact.sdk_version, "18.16.0");
    assert_eq!(artifact.program, root.join("bun.exe"));
    assert_eq!(artifact.path, root);
    let args: Vec<String> = artifact
        .args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(args.len(), 3);
    assert_eq!(args[0], "--no-env-file");
    assert_eq!(args[1], "--user-agent=omp/1");
    assert_eq!(args[2], root.join("host.js").to_string_lossy());
    let _ = fs::remove_dir_all(&root);
}

/// The regression this covers: a file whose bytes no longer match is refused even though the
/// manifest still lists it, because every file is hashed and not merely found.
#[test]
fn a_tampered_bundle_file_is_refused() {
    let root = write_bundle(
        "tampered",
        &[
            ("bun.exe", "runtime", b"runtime bytes"),
            ("host.js", "bundle", b"host bytes"),
        ],
        &["host.js"],
        "host.js",
    );
    assert!(verify_bundle(&root).is_ok());
    fs::write(root.join("host.js"), b"tampered bytes").expect("rewrite entry");
    assert_eq!(
        verify_bundle(&root).expect_err("tampered entry").code,
        ENGINE_CHECKSUM_MISMATCH
    );
    let _ = fs::remove_dir_all(&root);
}

/// A name that leaves the directory is refused before anything is read: the manifest is data,
/// and a `..` in it must not become a path this process opens or executes.
#[test]
fn a_file_name_outside_the_bundle_is_refused() {
    let root = workspace("traversal");
    fs::write(root.join("bun.exe"), b"runtime bytes").expect("runtime");
    // Every spelling that makes `Path::join` leave the directory: parent traversal, an absolute
    // path, and the Windows forms that carry a prefix or a root - `join("C:bun.exe")` replaces the
    // directory outright, so a separator test alone would let it through.
    for name in [r"../bun.exe", r"/bun.exe", r"C:bun.exe", r"C:\bun.exe"] {
        fs::write(
            root.join(BUNDLE_MANIFEST),
            format!(
                r#"{{"layout":"bundle","sdkVersion":"18.16.0","protocol":{PROTOCOL_VERSION},"entry":"host.js","argv":["host.js"],"files":[{{"file":"{name}","role":"runtime","bytes":13,"sha256":"00"}}]}}"#
            ),
        )
        .expect("manifest");
        assert_eq!(
            verify_bundle(&root).expect_err("traversal").code,
            ENGINE_CHECKSUM_MISMATCH,
            "{name} must be refused"
        );
    }
    let _ = fs::remove_dir_all(&root);
}

/// A bundle built for another protocol is refused with the same remedy the compiled artifact's
/// refusal names, because the consequence is identical.
#[test]
fn a_bundle_for_another_protocol_is_refused() {
    let root = workspace("protocol");
    let other = PROTOCOL_VERSION + 1;
    fs::write(root.join("bun.exe"), b"runtime bytes").expect("runtime");
    fs::write(root.join("host.js"), b"host bytes").expect("entry");
    let runtime = digest(&root.join("bun.exe")).expect("digest");
    let entry = digest(&root.join("host.js")).expect("digest");
    fs::write(root.join(BUNDLE_MANIFEST), format!(
            r#"{{"layout":"bundle","sdkVersion":"18.16.0","protocol":{other},"entry":"host.js","argv":["host.js"],"files":[{{"file":"bun.exe","role":"runtime","bytes":13,"sha256":"{runtime}"}},{{"file":"host.js","role":"bundle","bytes":10,"sha256":"{entry}"}}]}}"#
        ))
        .expect("manifest");
    let error = verify_bundle(&root).expect_err("another protocol");
    assert_eq!(error.code, ENGINE_PROTOCOL);
    assert!(error.message.contains(&other.to_string()));
    let _ = fs::remove_dir_all(&root);
}

/// An invocation that does not end at the entry, or carries something that is not a flag, is
/// refused: the manifest may not choose a different program to run.
#[test]
fn an_invocation_this_build_cannot_reproduce_is_refused() {
    let root = write_bundle(
        "argv",
        &[
            ("bun.exe", "runtime", b"runtime bytes"),
            ("host.js", "bundle", b"host bytes"),
        ],
        &["host.js"],
        "host.js",
    );
    let original = fs::read_to_string(root.join(BUNDLE_MANIFEST)).expect("manifest");
    for invocation in [
        r#"["--exec","other.js","host.js"]"#,
        r#"["host.js","--data-root"]"#,
    ] {
        let patched = original.replace(r#""argv":["host.js"]"#, &format!(r#""argv":{invocation}"#));
        assert!(
            patched.contains(invocation),
            "the test rewrote the invocation"
        );
        fs::write(root.join(BUNDLE_MANIFEST), patched).expect("manifest");
        assert_eq!(
            verify_bundle(&root).expect_err("bad invocation").code,
            ENGINE_CHECKSUM_MISMATCH
        );
    }
    let _ = fs::remove_dir_all(&root);
}

/// End to end: the verified bundle's own invocation starts a host that answers `hello`.
///
/// The unit cases above prove the manifest is read correctly; this one proves the thing the
/// manifest exists for - that `program` plus `args` launches a host speaking this protocol.
/// Skipped when the repository has no bundle, so a compiled-only checkout stays green.
#[test]
fn a_verified_bundle_starts_a_host_that_answers_hello() {
    use std::io::{BufRead, BufReader};

    let bundle = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(BUNDLE_DIR);
    if !bundle.join(BUNDLE_MANIFEST).is_file() {
        return;
    }
    let artifact = verify_bundle(&bundle).expect("the shipped bundle verifies");
    let root = workspace("spawn");
    let home = root.join("home");
    fs::create_dir_all(&home).expect("create home");

    let mut command = std::process::Command::new(&artifact.program);
    command.args(&artifact.args);
    command.arg("--data-root").arg(&root);
    // The host pins its own locations and asserts them, so the child gets only what the
    // launcher's own whitelist would have given it.
    command.env_clear();
    command.env("HOME", &home).env("USERPROFILE", &home);
    for name in ["PATH", "SystemRoot", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = command.spawn().expect("start the verified bundle");
    let mut line = String::new();
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout is piped"));
    stdout.read_line(&mut line).expect("read the first frame");
    let _ = child.kill();
    let _ = child.wait();

    assert!(
        line.contains(r#""type":"hello""#),
        "the bundle's own invocation must answer hello, saw: {line}"
    );
    let _ = fs::remove_dir_all(&root);
}

/// A bundle that names no runtime, or two, has no program this build can start.
#[test]
fn a_bundle_without_exactly_one_runtime_is_refused() {
    let root = write_bundle(
        "noruntime",
        &[("host.js", "bundle", b"host bytes")],
        &["host.js"],
        "host.js",
    );
    assert_eq!(
        verify_bundle(&root).expect_err("no runtime").code,
        ENGINE_CHECKSUM_MISMATCH
    );
    let _ = fs::remove_dir_all(&root);

    let root = write_bundle(
        "tworuntimes",
        &[
            ("bun.exe", "runtime", b"runtime bytes"),
            ("bun2.exe", "runtime", b"runtime bytes"),
            ("host.js", "bundle", b"host bytes"),
        ],
        &["host.js"],
        "host.js",
    );
    assert_eq!(
        verify_bundle(&root).expect_err("two runtimes").code,
        ENGINE_CHECKSUM_MISMATCH
    );
    let _ = fs::remove_dir_all(&root);
}

use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

fn main() {
    let root = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_owned());
    // A release build is an installer, and an installer carries the engine: the bundle, the
    // application and the protocol are one release or the release does not build. A missing or
    // stale bundle is the defect that shipped once - a 38-protocol host behind a 39-protocol
    // application - so a release refuses it here instead of discovering it on a user's machine.
    // A debug build may run without one because it resolves the repository copy at start-up.
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        check_shipped_host(&root);
    }
    tauri_build::build();

    // The Windows resource, and with it the executable's own icon, is generated here. tauri_build
    // lists its other inputs (tauri.conf.json, capabilities, binaries, resources) but not
    // bundle.icon, so without this line a redrawn src-tauri/icons/** never reaches the binary.
    println!("cargo:rerun-if-changed=icons");

    // The build's identity, for the one line every run starts with (`state::AppState::new`). It is
    // what turns `omp_desktop.exe+0x1a2b3c` from a stall's stack walk or a minidump into a place in
    // the source: the offset is resolved against the PDB of this exact build. No git, no checkout,
    // or a source archive all leave `unknown`, which is honest rather than a wrong build.
    let sha = match git(&root, &["rev-parse", "--short=12", "HEAD"]) {
        Some(sha) if tree_is_dirty(&root) => format!("{sha}+dirty"),
        Some(sha) => sha,
        None => "unknown".to_owned(),
    };
    println!("cargo:rustc-env=OMP_BUILD_SHA={sha}");
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    println!("cargo:rustc-env=OMP_BUILD_TIME={seconds}");
    // A rebuild of an unchanged tree is the ordinary case; without this a checkout that moved to
    // another commit would keep the previous identity in every artifact until a source file
    // changed. Missing (a source archive) is ignored by Cargo.
    println!("cargo:rerun-if-changed=../.git/HEAD");
}

/// Refuses a release whose packaged engine is absent, stale, or from another SDK.
///
/// The installer ships exactly one host form: `binaries/bundle`, the runtime plus plain files,
/// because the compiled self-extracting executable is what antivirus engines flag. An installer
/// that carries a bundle built for another protocol, SDK, or platform starts an application whose
/// engine pages never fill in; the gate is what makes that a build failure instead.
fn check_shipped_host(root: &str) {
    for path in [
        "binaries/bundle",
        "../host/src/constants.ts",
        "../host/package.json",
        "src/services/runtime/mod.rs",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    let base = Path::new(root);
    if !base.join("binaries/bundle/manifest.json").is_file() {
        panic!("a release build needs the engine bundle at src-tauri/binaries/bundle; run `pnpm host:install` first");
    }
    let manifest = read_json(base, "binaries/bundle/manifest.json", "the engine bundle");
    let from_bundle = u32::try_from(
        manifest["protocol"]
            .as_u64()
            .expect("the engine bundle records its protocol"),
    )
    .expect("the engine bundle's protocol is a u32");
    let from_host = protocol_in(
        &read(base, "../host/src/constants.ts"),
        "export const PROTOCOL_VERSION = ",
    )
    .unwrap_or_else(|| panic!("host/src/constants.ts states no PROTOCOL_VERSION"));
    let from_desktop = protocol_in(
        &read(base, "src/services/runtime/mod.rs"),
        "PROTOCOL_VERSION: u32 = ",
    )
    .unwrap_or_else(|| panic!("src/services/runtime/mod.rs states no PROTOCOL_VERSION"));
    assert_eq!(
        from_host, from_desktop,
        "the host and the desktop speak different protocols ({from_host} and {from_desktop})"
    );
    assert_eq!(
        from_bundle, from_host,
        "the packaged engine bundle speaks protocol {from_bundle}, this build speaks {from_host}; run `pnpm host:install`"
    );

    assert_eq!(
        manifest["layout"].as_str(),
        Some("bundle"),
        "the packaged engine's layout is not the bundle layout"
    );
    let sdk = manifest["sdkVersion"]
        .as_str()
        .expect("the engine bundle records its SDK version");
    let host_package = read_json(base, "../host/package.json", "host/package.json");
    let pin = host_package["dependencies"]["@oh-my-pi/pi-coding-agent"]
        .as_str()
        .expect("host/package.json pins the coding agent");
    assert_eq!(
        sdk, pin,
        "the engine bundle was built against SDK {sdk}, host/package.json pins {pin}; run `pnpm host:install`"
    );

    let target = std::env::var("TARGET").expect("cargo names the compilation target");
    assert_eq!(
        manifest["target"].as_str(),
        Some(target.as_str()),
        "the engine bundle was built for {}, this build targets {target}; run `pnpm host:install`",
        manifest["target"].as_str().unwrap_or("an unnamed target")
    );

    let entry = manifest["entry"]
        .as_str()
        .expect("the engine bundle records its entry");
    let argv = manifest["argv"]
        .as_array()
        .expect("the engine bundle records its invocation");
    let Some((last, flags)) = argv.split_last() else {
        panic!("the engine bundle records no invocation");
    };
    assert_eq!(
        last.as_str(),
        Some(entry),
        "the engine bundle's invocation does not end at its entry; run `pnpm host:install`"
    );
    assert!(
        flags
            .iter()
            .all(|flag| flag.as_str().is_some_and(|value| value.starts_with("--"))),
        "the engine bundle records an invocation this build cannot reproduce; run `pnpm host:install`"
    );

    let bundle = base.join("binaries/bundle");
    let files = manifest["files"]
        .as_array()
        .expect("the engine bundle lists its files");
    assert!(!files.is_empty(), "the engine bundle lists no files");
    let mut runtimes = 0;
    let mut entry_listed = false;
    for file in files {
        let name = file["file"]
            .as_str()
            .expect("every engine bundle entry names a file");
        let mut components = Path::new(name).components();
        assert!(
            matches!(components.next(), Some(std::path::Component::Normal(_)))
                && components.next().is_none(),
            "the engine bundle names a file outside itself: {name}"
        );
        let path = bundle.join(name);
        let metadata = fs::metadata(&path)
            .unwrap_or_else(|_| panic!("the engine bundle is incomplete: {name} is missing"));
        assert!(
            metadata.is_file(),
            "the engine bundle entry {name} is not a file"
        );
        assert_eq!(
            metadata.len(),
            file["bytes"].as_u64().unwrap_or(0),
            "the engine bundle entry {name} is not the size its manifest records"
        );
        let recorded = file["sha256"]
            .as_str()
            .expect("every engine bundle entry records a digest");
        let actual = sha256(&path);
        assert!(
            actual.eq_ignore_ascii_case(recorded),
            "the engine bundle entry {name} does not match the digest its manifest records; run `pnpm host:install`"
        );
        match file["role"].as_str() {
            Some("runtime") => runtimes += 1,
            Some("bundle") if name == manifest["entry"].as_str().unwrap_or("") => {
                entry_listed = true
            }
            _ => {}
        }
    }
    assert_eq!(
        runtimes, 1,
        "the engine bundle must name exactly one runtime"
    );
    assert!(
        entry_listed,
        "the engine bundle does not list its own entry"
    );
}

/// sha256 of one packaged bundle file, read in chunks so a multi-hundred-megabyte entry never lands
/// in memory whole. The gate hashes every file as well as checking its size: a same-size rewrite is
/// exactly the stale artifact this release refuses.
fn sha256(path: &Path) -> String {
    let mut file = fs::File::open(path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let sum = hasher.finalize();
    let mut hex = String::with_capacity(sum.len() * 2);
    for byte in sum.iter().copied() {
        hex.push(HEX[usize::from(byte >> 4)] as char);
        hex.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    hex
}

/// One `KEY = <number>` line from a source file the protocol lives in.
fn protocol_in(text: &str, marker: &str) -> Option<u32> {
    text.lines().find_map(|line| {
        let (_, value) = line.split_once(marker)?;
        value.trim().trim_end_matches(';').trim().parse().ok()
    })
}

/// Reads one input the build cannot do without.
fn read(base: &Path, relative: &str) -> String {
    let path = base.join(relative);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("cannot read {relative}: {error}"))
}

/// Reads one JSON input the build cannot do without.
fn read_json(base: &Path, relative: &str, what: &str) -> serde_json::Value {
    let text = read(base, relative);
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{what} is not JSON: {error}"))
}

/// One git answer, trimmed, or `None` when git is absent or refuses.
fn git(root: &str, args: &[&str]) -> Option<String> {
    let output = quiet("git", args, root).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// Whether tracked files differ from `HEAD`. Untracked files do not change the artifact's code, so
/// they do not mark it; a modified tracked file does, and then the offsets no longer belong to any
/// commit that can be checked out.
fn tree_is_dirty(root: &str) -> bool {
    quiet("git", &["diff-index", "--quiet", "HEAD", "--"], root)
        .output()
        .map(|output| !output.status.success())
        .unwrap_or(false)
}

/// A command for one of this script's own queries.
///
/// A build script may be run by a GUI process with no console of its own (the Tauri CLI), and a
/// console program started from one is given a window: the flash a reader sees during every build
/// is exactly this. `CREATE_NO_WINDOW` gives the child no console at all, which is all these
/// queries need.
fn quiet(program: &str, args: &[&str], dir: &str) -> Command {
    let mut command = Command::new(program);
    command.args(args).current_dir(dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

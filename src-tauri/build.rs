use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    tauri_build::build();

    // The Windows resource, and with it the executable's own icon, is generated here. tauri_build
    // lists its other inputs (tauri.conf.json, capabilities, binaries, resources) but not
    // bundle.icon, so without this line a redrawn src-tauri/icons/** never reaches the binary.
    println!("cargo:rerun-if-changed=icons");

    // The build's identity, for the one line every run starts with (`state::AppState::new`). It is
    // what turns `omp_desktop.exe+0x1a2b3c` from a stall's stack walk or a minidump into a place in
    // the source: the offset is resolved against the PDB of this exact build. No git, no checkout,
    // or a source archive all leave `unknown`, which is honest rather than a wrong build.
    let root = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_owned());
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

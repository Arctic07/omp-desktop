//! The toolchain caches the host's children fill, and the budget they are held to.
//!
//! The host runs with `HOME` / `USERPROFILE` / `XDG_DATA_HOME` pinned into the data root
//! (`services::runtime::host::process`), so every tool the agent's shell runs keeps its cache *there*
//! rather than in the reader's own profile. That is the point - a sandboxed home - and it is also
//! why these directories grow with nobody watching: measured on this machine, `<home>/.cargo` 522 MiB
//! (of which 422 MiB is unpacked crate sources), `<xdg>/pnpm/store` 228 MiB, `<home>/.bun` 59 MiB,
//! `<home>/AppData/Local` 422 MiB.
//!
//! Three rules, in the order they run:
//!
//! 1. **A whole data root left inside the pinned home goes first.** `<home>/AppData/Local/
//!    com.omp.desktop.dev` is what a dev instance wrote when its profile had not been restored
//!    (`AGENTS.md`'s dev recipe): a complete second data root - store, sessions, engine home -
//!    that no build reads. Its newest write decides, not its own stamp, so a dev instance that is
//!    running right now keeps everything it is writing (`RESIDUE_MAX_AGE_SECS`).
//! 2. **The package store is pruned by pnpm itself when pnpm agrees it is the store in question.**
//!    `pnpm store prune` removes only what nothing references; the fallback below is blunter.
//! 3. **Everything else is one budget** ([`BUDGET_BYTES`]), evicted oldest write first, and anything
//!    written inside [`RECENT_SECS`] is skipped - the case that matters is the reader's own build
//!    running in a terminal tab while the pass runs.
//!
//! **What it costs.** A crate directory removed here is downloaded and unpacked again on the next
//! build that needs it: the sweep trades disk for that download, which is the trade the budget
//! makes. Nothing here touches the engine's tree (`<home>/.omp`), a reader's own files, or the
//! pinned home's non-cache children - the roots below are an explicit list, so a directory this
//! module does not name cannot be removed by it.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::services::log;
use crate::services::paths::DataPaths;
use crate::services::runtime::host::process::hide_console;

/// What the toolchain caches together may weigh.
///
/// 2 GiB: an order of magnitude above what a full Rust and Node toolchain measured on this machine
/// (about 1.2 GiB), so a working install never touches it and only an abandoned set of builds
/// reaches it. It is a ceiling, not a target - the pass removes nothing while the total fits.
pub(crate) const BUDGET_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// How recently an entry may have been written and still be left alone, whatever the budget says.
///
/// An hour: a `cargo build` or `pnpm install` the reader started in a terminal tab writes into these
/// directories continuously, and taking the crate a build is reading breaks it. Long enough to cover
/// a build's gap between compiles, short enough that the next pass reclaims what that build left.
pub(crate) const RECENT_SECS: u64 = 60 * 60;

/// How old a left-over data root inside the pinned home has to be.
///
/// A day: a dev instance writes its store on every switch, so one that is running is never this
/// quiet; one that has been silent for a day is a root nothing is coming back to.
pub(crate) const RESIDUE_MAX_AGE_SECS: u64 = 24 * 60 * 60;

/// How many entries one sweep walks. A pathological cache cannot hold the pass.
const MAX_ENTRIES: usize = 20_000;

/// How long `pnpm` is given to answer, and how long `pnpm store prune` is given to work.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const PRUNE_TIMEOUT: Duration = Duration::from_secs(180);

/// One directory the sweep may remove, with the size and age the budget reads.
struct Entry {
    path: PathBuf,
    kind: &'static str,
    bytes: u64,
    newest: u64,
}

/// What one sweep removed, and what it left behind.
///
/// The same shape the engine's reclaim answers with (`services::runtime::reclaim::Answer`): bytes,
/// per kind, and the reasons a target was kept - so the two halves of a cache clear read alike in
/// the log and in the page's report.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Swept {
    pub(crate) freed_bytes: u64,
    /// The bytes removed, per kind.
    pub(crate) removed: Vec<(&'static str, u64)>,
    /// The bytes left behind, per kind and reason.
    pub(crate) skipped: Vec<(&'static str, &'static str, u64)>,
}

impl Swept {
    fn freed(&mut self, kind: &'static str, bytes: u64) {
        self.freed_bytes = self.freed_bytes.saturating_add(bytes);
        match self.removed.iter_mut().find(|(name, _)| *name == kind) {
            Some((_, total)) => *total = total.saturating_add(bytes),
            None => self.removed.push((kind, bytes)),
        }
    }

    fn kept(&mut self, kind: &'static str, reason: &'static str, bytes: u64) {
        match self
            .skipped
            .iter_mut()
            .find(|(name, why, _)| *name == kind && *why == reason)
        {
            Some((_, _, total)) => *total = total.saturating_add(bytes),
            None => self.skipped.push((kind, reason, bytes)),
        }
    }

    /// The removals as one clause, for the log line: `cargo-src=4096, tauri-tools=512`.
    fn removed_clause(&self) -> String {
        self.removed
            .iter()
            .map(|(kind, bytes)| format!("{kind}={bytes}"))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The skips as one clause: `cargo-src in-use=1024`.
    fn skipped_clause(&self) -> String {
        self.skipped
            .iter()
            .map(|(kind, reason, bytes)| format!("{kind} {reason}={bytes}"))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Applies the budget once, against the system clock.
pub(crate) fn sweep(paths: &DataPaths) -> Swept {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    sweep_at(paths, now, BUDGET_BYTES, RECENT_SECS, prune_store)
}

/// Runs the sweep and writes its one line. Silent when it removed nothing.
pub(crate) fn sweep_and_report(paths: &DataPaths) -> u64 {
    let swept = sweep(paths);
    report(&swept);
    swept.freed_bytes
}

/// The one line a sweep leaves behind.
pub(crate) fn report(swept: &Swept) {
    if swept.freed_bytes == 0 && swept.skipped.is_empty() {
        return;
    }
    let removed = swept.removed_clause();
    let skipped = swept.skipped_clause();
    log::info(&format!(
        "toolchain caches: {} bytes freed{}{}",
        swept.freed_bytes,
        if removed.is_empty() {
            String::new()
        } else {
            format!(" [{removed}]")
        },
        if skipped.is_empty() {
            String::new()
        } else {
            format!("; kept [{skipped}]")
        },
    ));
}

/// The sweep itself. Clock, budget and the recent window are arguments, and so is the package-store
/// pruner, so a test drives every branch without waiting a month or spawning `pnpm`.
fn sweep_at(
    paths: &DataPaths,
    now: u64,
    budget: u64,
    recent: u64,
    pruner: impl FnOnce(&DataPaths, &Path) -> Option<u64>,
) -> Swept {
    let mut swept = Swept::default();
    sweep_residue(paths, now, &mut swept);
    let mut entries = Vec::new();
    for (kind, root, depth) in cache_roots(paths) {
        for path in dirs_at(&root, depth) {
            if entries.len() >= MAX_ENTRIES {
                break;
            }
            let (bytes, newest) = measure(&path);
            entries.push(Entry {
                path,
                kind,
                bytes,
                newest,
            });
        }
    }
    // The package store gets its own rule before the budget sees it: pnpm removes only what nothing
    // references, which is a better answer than the oldest shard. The entry is left out of the
    // budget when the pruner handled it, so the same bytes cannot be counted twice.
    if let Some(files) = store_files(paths) {
        match pruner(paths, &files) {
            Some(freed) => swept.freed("pnpm-store", freed),
            None => {
                for path in dirs_at(&files, 1) {
                    let (bytes, newest) = measure(&path);
                    entries.push(Entry {
                        path,
                        kind: "pnpm-store",
                        bytes,
                        newest,
                    });
                }
            }
        }
    }
    evict(entries, now, budget, recent, &mut swept);
    swept
}

/// Removes what the total over `budget` requires, oldest write first.
fn evict(mut entries: Vec<Entry>, now: u64, budget: u64, recent: u64, swept: &mut Swept) {
    entries.sort_by(|left, right| {
        left.newest
            .cmp(&right.newest)
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut total: u64 = entries.iter().map(|entry| entry.bytes).sum();
    for entry in entries {
        if total <= budget {
            break;
        }
        if now.saturating_sub(entry.newest) <= recent {
            swept.kept(entry.kind, "in-use", entry.bytes);
            continue;
        }
        if std::fs::remove_dir_all(&entry.path).is_ok() {
            total = total.saturating_sub(entry.bytes);
            swept.freed(entry.kind, entry.bytes);
        } else {
            swept.kept(entry.kind, "failed", entry.bytes);
        }
    }
}

/// Removes a data root a dev instance left inside the pinned home.
///
/// The recursive removal is deliberate and the only one in this module: the target is a directory
/// this application made, whose newest write proves nothing is using it. Each directory in the list
/// is checked on its own, so a running instance (writing now) keeps everything.
fn sweep_residue(paths: &DataPaths, now: u64, swept: &mut Swept) {
    for (kind, path) in residue_roots(paths) {
        if !path.is_dir() {
            continue;
        }
        let (bytes, newest) = measure(&path);
        if now.saturating_sub(newest) <= RESIDUE_MAX_AGE_SECS {
            swept.kept(kind, "in-use", bytes);
            continue;
        }
        if std::fs::remove_dir_all(&path).is_ok() {
            swept.freed(kind, bytes);
        } else {
            swept.kept(kind, "failed", bytes);
        }
    }
}

/// The data roots that do not belong inside the pinned home.
///
/// `com.omp.desktop.dev`'s is what a dev instance wrote before its profile was restored: a complete
/// second data root - store, sessions, engine home - that no build reads.
///
/// The installed identity's `EBWebView` beside it is the same mistake one directory over (a WebView2
/// profile created under the pinned home instead of the data root), and it is deliberately **not**
/// on this list: measured on this machine, something still writes into it during a normal run (newest
/// write minutes old, 15 MB), so it is a live profile rather than a leftover - and 15 MB does not buy
/// the risk of removing a webview's cookies while the process that owns them is idle-but-open.
fn residue_roots(paths: &DataPaths) -> Vec<(&'static str, PathBuf)> {
    let local = paths.host_home.join("AppData").join("Local");
    vec![("dev-residue", local.join("com.omp.desktop.dev"))]
}

/// The cache directories, each with the depth at which its entries start.
///
/// An entry is one directory the toolchain rebuilds on demand: an unpacked crate, one registry
/// index's downloads, one `bun` package, one pnpm shard. The depth is what keeps this from removing
/// a root wholesale - `.cargo/registry/src` is the root, its `<index>` child is the branch, and the
/// crate directories below that are the entries.
fn cache_roots(paths: &DataPaths) -> Vec<(&'static str, PathBuf, usize)> {
    let home = &paths.host_home;
    let local = home.join("AppData").join("Local");
    vec![
        (
            "cargo-src",
            home.join(".cargo").join("registry").join("src"),
            2,
        ),
        (
            "cargo-cache",
            home.join(".cargo").join("registry").join("cache"),
            2,
        ),
        ("cargo-git", home.join(".cargo").join("git").join("db"), 1),
        (
            "bun-install",
            home.join(".bun").join("install").join("cache"),
            1,
        ),
        ("volta-cache", local.join("Volta").join("cache"), 1),
        ("tauri-tools", local.join("tauri"), 1),
    ]
}

/// `<xdg>/pnpm/store/*/files`: the package store's content shards, one directory per hash prefix.
fn store_files(paths: &DataPaths) -> Option<PathBuf> {
    let store = paths.host_xdg.join("pnpm").join("store");
    dirs_at(&store, 1)
        .into_iter()
        .map(|version| version.join("files"))
        .find(|files| files.is_dir())
}

/// Asks pnpm to prune the store, answering what it freed.
///
/// Three things have to hold, and any of them failing falls back to the shard rule: pnpm resolves the
/// store this function was handed (a `pnpm store path` under the pinned environment), it exits zero,
/// and the store got smaller. pnpm resolving *another* store is the case that matters - pruning the
/// reader's real store would delete packages their own projects use, for no gain here.
fn prune_store(paths: &DataPaths, files: &Path) -> Option<u64> {
    // `files` is `<store>/<version>/files`: `<store>/<version>` is the directory that grows.
    let version = files.parent()?;
    let before = measure(version).0;
    let answer = run(paths, &["store", "path"], PROBE_TIMEOUT)?;
    // pnpm prints its active store, which is this version directory - or the `files` directory
    // inside it, depending on the pnpm version. Anything else is another store, and it is left
    // alone.
    let answer = answer.trim();
    if !same_path(answer, &version.to_string_lossy())
        && !same_path(answer, &files.to_string_lossy())
    {
        return None;
    }
    run(paths, &["store", "prune"], PRUNE_TIMEOUT)?;
    Some(before.saturating_sub(measure(version).0))
}

/// Runs one `pnpm` subcommand under the pinned environment, answering its stdout.
///
/// The environment is the one the host gives its children (`HOME` / `USERPROFILE` /
/// `XDG_DATA_HOME` / `LOCALAPPDATA` under the data root): a `pnpm` run with this application's own
/// environment would answer where the *reader's* store is, and this pass must never reach it.
///
/// `None` covers every way this can fail - no `pnpm` on the machine, a non-zero exit, a timeout that
/// had to kill it, output that is not text - because the caller's answer to all of them is the same
/// fallback. The child is killed on the timeout rather than waited for.
///
/// The sweep runs on a timer in this windowed process, so `pnpm` is spawned with a hidden console
/// ([`hide_console`]): without the flag Windows gives this automatic pass a console window of its
/// own, which the reader sees as a terminal flashing open five minutes after a launch and every six
/// hours after that. A console child of this process is only ever visible by mistake.
fn run(paths: &DataPaths, args: &[&str], timeout: Duration) -> Option<String> {
    let home = paths.host_home.clone();
    let local = home.join("AppData").join("Local");
    let mut command = Command::new("pnpm");
    command
        .args(args)
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("XDG_DATA_HOME", &paths.host_xdg)
        .env("LOCALAPPDATA", &local)
        .env("APPDATA", local.join("Roaming"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console(&mut command);
    let mut child = command.spawn().ok()?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let output = child.wait_with_output().ok()?;
                return String::from_utf8(output.stdout).ok();
            }
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
}

/// Whether two spellings name one directory, folding separators and case the way the rest of this
/// application compares paths.
fn same_path(left: &str, right: &str) -> bool {
    crate::services::paths::normalize_for_compare(Path::new(left))
        == crate::services::paths::normalize_for_compare(Path::new(right))
}

/// The directories at exactly `depth` levels below `root`; nothing when there are none.
fn dirs_at(root: &Path, depth: usize) -> Vec<PathBuf> {
    let mut level = vec![root.to_path_buf()];
    for _ in 0..depth {
        let mut next = Vec::new();
        for parent in level {
            let Ok(read) = std::fs::read_dir(&parent) else {
                continue;
            };
            for entry in read.flatten() {
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    next.push(entry.path());
                }
            }
        }
        if next.is_empty() {
            return Vec::new();
        }
        level = next;
    }
    level.sort();
    level
}

/// The bytes under `directory` and its newest write, both bounded by [`MAX_ENTRIES`].
///
/// Only files carry a time here: creating an entry moves a directory's own modification time, so a
/// directory stamp says when the tree last changed shape rather than when anything was written - and
/// the whole question these two numbers answer is "how big is this, and how long has nobody touched
/// it". Links are neither counted nor followed: a link here is not a cache this application wrote.
fn measure(directory: &Path) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut newest = 0u64;
    let mut seen = 0usize;
    let mut stack = vec![directory.to_path_buf()];
    while let Some(next) = stack.pop() {
        if seen >= MAX_ENTRIES {
            break;
        }
        let Ok(read) = std::fs::read_dir(&next) else {
            continue;
        };
        for entry in read.flatten() {
            seen += 1;
            if seen >= MAX_ENTRIES {
                break;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                stack.push(entry.path());
                continue;
            }
            bytes = bytes.saturating_add(metadata.len());
            let touched = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_secs())
                .unwrap_or_default();
            newest = newest.max(touched);
        }
    }
    (bytes, newest)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    const NOW: u64 = 1_700_000_000;
    const DAY: u64 = 24 * 60 * 60;

    /// A data root of this process's own, with the pinned home the sweep expects.
    fn root(tag: &str) -> (DataPaths, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("omp-cache-budget-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("data root");
        (DataPaths::from_root(root.clone()), root)
    }

    /// A directory of `bytes` bytes, stamped `touched`, with one file inside.
    fn entry(path: &Path, bytes: usize, touched: u64) {
        fs::create_dir_all(path).expect("a directory");
        let file = path.join("payload");
        fs::write(&file, vec![b'x'; bytes]).expect("a file");
        let handle = fs::File::options()
            .write(true)
            .open(&file)
            .expect("open the file");
        handle
            .set_modified(UNIX_EPOCH + Duration::from_secs(touched))
            .expect("age the file");
    }

    /// A pruner that always declines, so the shard fallback is what runs.
    fn no_prune(_: &DataPaths, _: &Path) -> Option<u64> {
        None
    }

    #[test]
    fn a_cache_inside_the_budget_is_left_alone() {
        let (paths, root_dir) = root("inside");
        let crates = paths
            .host_home
            .join(".cargo")
            .join("registry")
            .join("src")
            .join("index");
        entry(&crates.join("serde-1.0.0"), 400, NOW - 10 * DAY);

        let swept = sweep_at(&paths, NOW, 1024, RECENT_SECS, no_prune);

        assert_eq!(swept.freed_bytes, 0);
        assert!(crates.join("serde-1.0.0").is_dir());
        let _ = fs::remove_dir_all(&root_dir);
    }

    #[test]
    fn over_the_budget_the_oldest_entries_go_first() {
        let (paths, root_dir) = root("over");
        let crates = paths
            .host_home
            .join(".cargo")
            .join("registry")
            .join("src")
            .join("index");
        entry(&crates.join("oldest-1.0.0"), 400, NOW - 30 * DAY);
        entry(&crates.join("middle-1.0.0"), 400, NOW - 20 * DAY);
        entry(&crates.join("newest-1.0.0"), 400, NOW - 10 * DAY);

        // 1200 bytes against a 900-byte budget: exactly the oldest crate has to go.
        let swept = sweep_at(&paths, NOW, 900, RECENT_SECS, no_prune);

        assert_eq!(swept.freed_bytes, 400);
        assert_eq!(swept.removed, vec![("cargo-src", 400)]);
        assert!(!crates.join("oldest-1.0.0").is_dir());
        assert!(crates.join("middle-1.0.0").is_dir());
        assert!(crates.join("newest-1.0.0").is_dir());
        let _ = fs::remove_dir_all(&root_dir);
    }

    #[test]
    fn an_entry_written_within_the_hour_is_skipped_even_when_over_budget() {
        let (paths, root_dir) = root("in-use");
        let crates = paths
            .host_home
            .join(".cargo")
            .join("registry")
            .join("src")
            .join("index");
        let building = crates.join("active-0.1.0");
        entry(&building, 800, NOW - 60);
        entry(&crates.join("idle-0.1.0"), 400, NOW - 5 * DAY);

        let swept = sweep_at(&paths, NOW, 100, RECENT_SECS, no_prune);

        assert!(
            building.is_dir(),
            "a crate written a minute ago is not taken"
        );
        assert_eq!(swept.skipped, vec![("cargo-src", "in-use", 800)]);
        assert!(!crates.join("idle-0.1.0").is_dir(), "the idle one went");
        let _ = fs::remove_dir_all(&root_dir);
    }

    #[test]
    fn the_package_store_falls_back_to_its_shards_when_the_pruner_declines() {
        let (paths, root_dir) = root("pnpm");
        let files = paths
            .host_xdg
            .join("pnpm")
            .join("store")
            .join("v10")
            .join("files");
        entry(&files.join("00"), 400, NOW - 9 * DAY);
        entry(&files.join("ff"), 400, NOW - 8 * DAY);

        let swept = sweep_at(&paths, NOW, 400, RECENT_SECS, no_prune);

        assert_eq!(swept.freed_bytes, 400);
        assert_eq!(swept.removed, vec![("pnpm-store", 400)]);
        assert!(!files.join("00").is_dir(), "the oldest shard went");
        assert!(files.join("ff").is_dir());
        let _ = fs::remove_dir_all(&root_dir);
    }

    #[test]
    fn a_store_the_pruner_handled_is_not_walked_again() {
        let (paths, root_dir) = root("pruned");
        let files = paths
            .host_xdg
            .join("pnpm")
            .join("store")
            .join("v10")
            .join("files");
        entry(&files.join("00"), 400, NOW - 9 * DAY);

        let swept = sweep_at(&paths, NOW, 0, RECENT_SECS, |_: &DataPaths, _: &Path| {
            Some(128)
        });

        assert_eq!(
            swept.removed,
            vec![("pnpm-store", 128)],
            "pnpm's own number"
        );
        assert!(files.join("00").is_dir(), "the fallback did not run");
        let _ = fs::remove_dir_all(&root_dir);
    }

    #[test]
    fn a_left_over_data_root_goes_once_it_is_a_day_quiet() {
        let (paths, root_dir) = root("residue");
        let local = paths.host_home.join("AppData").join("Local");
        let stale = local.join("com.omp.desktop.dev");
        entry(&stale.join("host").join("sessions"), 512, NOW - 2 * DAY);
        let running = local.join("com.omp.desktop.dev-running");
        entry(&running.join("EBWebView"), 256, NOW - 60);

        let swept = sweep_at(&paths, NOW, u64::MAX, RECENT_SECS, no_prune);

        assert!(!stale.exists(), "a day and a half quiet: nothing uses it");
        assert_eq!(swept.removed, vec![("dev-residue", 512)]);
        assert!(
            running.is_dir(),
            "a directory this rule does not name stays"
        );
        let _ = fs::remove_dir_all(&root_dir);
    }

    #[test]
    fn a_data_root_that_is_being_written_stays() {
        let (paths, root_dir) = root("residue-live");
        let local = paths.host_home.join("AppData").join("Local");
        let live = local.join("com.omp.desktop.dev");
        entry(&live.join("logs"), 256, NOW - 60);

        let swept = sweep_at(&paths, NOW, u64::MAX, RECENT_SECS, no_prune);

        assert!(
            live.is_dir(),
            "written a minute ago: a running instance owns it"
        );
        assert_eq!(swept.skipped, vec![("dev-residue", "in-use", 256)]);
        let _ = fs::remove_dir_all(&root_dir);
    }

    #[test]
    fn a_directory_this_module_does_not_name_is_never_removed() {
        let (paths, root_dir) = root("foreign");
        // The engine's own tree is read-only to this process (§5.3), and a reader's notes are not a
        // cache: neither is a candidate however old it is.
        let engine = paths.host_home.join(".omp").join("natives");
        entry(&engine.join("18.6.1"), 9_000, NOW - 400 * DAY);
        let notes = paths.host_home.join("notes");
        entry(&notes, 1_000, NOW - 400 * DAY);

        let swept = sweep_at(&paths, NOW, 0, RECENT_SECS, no_prune);

        assert_eq!(swept.freed_bytes, 0);
        assert!(engine.join("18.6.1").is_dir());
        assert!(notes.join("payload").is_file());
        let _ = fs::remove_dir_all(&root_dir);
    }
}

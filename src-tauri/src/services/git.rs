//! Workspace git operations the commands call: the review the panel renders, staging, unstaging,
//! discarding, commit and sync.
//!
//! Everything that starts a `git` process lives in [`process`], everything that turns git's output
//! into review rows lives in [`review`]; this module owns the order those steps run in, what their
//! failures mean to the caller, and the operations that change the repository.

mod process;
mod review;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::models::{
    RepositoryBranch, WorkspaceBranch, WorkspaceBranches, WorkspaceReview, WorkspaceReviewDelta,
};
use crate::services::log;
use crate::services::paths::plain_path;
use crate::services::workspace::{canonical_workspace_root, safe_git_path};

use process::{run_git, run_git_command, run_git_diagnosed, DiagnosedOutput};
use review::{
    build_review_sides, changed_paths_for_review, read_workspace_changes, UNTRACKED_PATCH_BUDGET,
};

const COMMIT_MESSAGE_LIMIT: usize = 64 * 1024;

/// How many paths one git command carries.
///
/// The review no longer caps how many files a side lists, so a bulk action can name a whole large
/// tree. A command line is a platform limit (Windows `CreateProcess` caps it near 32 KiB), so the
/// paths are split over several commands instead of being refused or truncated.
const GIT_PATH_CHUNK: usize = 200;

/// Ceiling on the paths one IPC call may carry. It bounds the input a single command accepts; it
/// is not the number of rows the review lists — a tree with more changed files than this still
/// shows every one, and only a bulk action over more paths than this stops here.
const WORKSPACE_PATH_LIMIT: usize = 20_000;

/// The repository a workspace's review is read from: git's own top level, or `None` when this
/// directory is not inside a working tree. `Err` is git itself being unavailable, which is a
/// different answer from "there is no repository here".
///
/// **Every path a review names is relative to the repository, not to the workspace.** `git status`
/// prints them that way whatever directory it was run in, while every command that consumes one —
/// `diff`, `ls-files`, `add`, `restore` — resolves it against the directory it runs in. So a
/// workspace that is a *subdirectory* of its repository has to run those commands from the top
/// level: run from the workspace, `src/src/App.tsx` is read as
/// `<workspace>/src/src/App.tsx`, git answers `pathspec ... did not match any files`, and the
/// panel has nothing to show for it but "Unable to stage workspace file" (2026-10-19, a workspace
/// opened on `src-tauri`).
fn repository_root(canonical_root: &Path) -> Result<Option<PathBuf>, String> {
    let output = run_git(canonical_root, &["rev-parse", "--show-toplevel"])?;
    if !output.status.success() {
        return Ok(None);
    }
    let top = std::str::from_utf8(&output.stdout)
        .map(str::trim)
        .unwrap_or_default();
    if top.is_empty() {
        return Ok(None);
    }
    // git answers the path in its own spelling — forward slashes, and whatever case it was given —
    // while every other path in a review is canonical. They are compared as one form, so this one
    // is canonicalized too (and a top level that cannot be canonicalized is one that is gone).
    Ok(PathBuf::from(top)
        .canonicalize()
        .ok()
        .filter(|path| path.is_dir()))
}

/// The repository root this workspace's git operations run in, or the reason there is none.
fn require_repository_root(workspace_root: &str) -> Result<PathBuf, String> {
    let canonical_root = canonical_workspace_root(workspace_root)?;
    repository_root(&canonical_root)?
        .ok_or_else(|| "This workspace is not inside a git repository".to_owned())
}

/// A review with no rendered files: the shape every early return reports, so a failure answers
/// with the reason and not with rows that were never built. It carries no repository root, because
/// the root exists to place a row on disk and there are no rows here.
fn empty_review(
    repo: bool,
    clean: bool,
    truncated: bool,
    error: Option<String>,
) -> WorkspaceReview {
    WorkspaceReview {
        repo,
        clean,
        staged_files: Vec::new(),
        unstaged_files: Vec::new(),
        truncated,
        repository_root: None,
        head: None,
        branch: None,
        error,
    }
}

/// A failed command's message: this side's sentence, then git's own first useful line, so the
/// panel names the reason and the path instead of only that something failed.
///
/// git mixes its answer with `hint:` lines, which are advice for a terminal reader rather than the
/// reason; the first line that is neither empty nor a hint is the reason.
///
/// A list answer puts the reason's subject on the next line — `The following paths are ignored by
/// one of your .gitignore files:` names the refused path only below itself — so a reason that ends
/// with `:` takes the line after it too. Without that, the reader was told what kind of failure it
/// was and never which file it was about.
fn git_failure(error: &str, output: &DiagnosedOutput) -> String {
    let mut reason = output
        .diagnosis
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("hint:"));
    let Some(mut detail) = reason.next().map(str::to_owned) else {
        return error.to_owned();
    };
    if detail.ends_with(':') {
        if let Some(subject) = reason.next() {
            detail.push(' ');
            detail.push_str(subject);
        }
    }
    format!("{error}: {}", detail.chars().take(240).collect::<String>())
}

/// The paths `git add` will accept out of the ones a review row named: the paths the index knows -
/// a worktree deletion is staged through them too - and the ones on disk git does not ignore.
///
/// A row can outlive the file it names. An untracked path can be removed by anything between the
/// read that listed it and the click that stages it, and `git add` answers one of those with a
/// fatal pathspec error that fails the whole command - every other row in the same action stays
/// unstaged for a file that is no longer there. Those paths are dropped here; nothing is lost,
/// because there is nothing left to stage for them.
///
/// The result holds two kinds, and they are why the stage runs with `--force`: an untracked path
/// git does not ignore, and a path the index already knows. The second kind can sit under a
/// directory `.gitignore` excludes - a file committed before its directory was ignored - and there
/// `git add` refuses the pathspec over the excluded directory even though ignore rules never
/// apply to a tracked file. Forcing is safe for the whole list because the first kind was already
/// filtered against the same ignore rules.
fn stageable_paths(root: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    let mut listed = std::collections::HashSet::with_capacity(paths.len());
    for chunk in paths.chunks(GIT_PATH_CHUNK) {
        // One read answers both kinds: `-c` the index, `-o --exclude-standard` the untracked
        // files git would add.
        let mut args: Vec<OsString> = ["ls-files", "-z", "-c", "-o", "--exclude-standard", "--"]
            .iter()
            .map(OsString::from)
            .collect();
        args.extend(chunk.iter().map(OsString::from));
        let output = run_git(root, &args)?;
        if !output.status.success() {
            return Err("Unable to stage workspace file".to_owned());
        }
        for path in output.stdout.split(|byte| *byte == 0) {
            if let Ok(path) = std::str::from_utf8(path) {
                if !path.is_empty() {
                    listed.insert(path.to_owned());
                }
            }
        }
    }
    Ok(paths
        .iter()
        .filter(|path| listed.contains(path.as_str()))
        .cloned()
        .collect())
}

/// Runs one git command over every path, in chunks the platform's command line can carry.
fn run_git_with_paths(
    root: &Path,
    base: &[&str],
    paths: &[String],
    error: &'static str,
) -> Result<(), String> {
    for chunk in paths.chunks(GIT_PATH_CHUNK) {
        let mut args: Vec<OsString> = base.iter().map(OsString::from).collect();
        args.extend(chunk.iter().map(OsString::from));
        let output = run_git_diagnosed(root, &args, error, "Git command timed out")?;
        if !output.status.success() {
            return Err(git_failure(error, &output));
        }
    }
    Ok(())
}

fn validate_workspace_paths(root: &Path, paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("Workspace paths cannot be empty".to_owned());
    }

    let mut safe_paths = Vec::with_capacity(paths.len().min(WORKSPACE_PATH_LIMIT));
    let mut seen = std::collections::HashSet::with_capacity(paths.len().min(WORKSPACE_PATH_LIMIT));
    for path in paths {
        if path.is_empty() || path.contains('\0') || !safe_git_path(root, &path) {
            return Err("Workspace path is invalid".to_owned());
        }
        if seen.insert(path.clone()) {
            safe_paths.push(path);
        }
    }
    if safe_paths.len() > WORKSPACE_PATH_LIMIT {
        return Err("Too many workspace paths".to_owned());
    }
    if safe_paths.is_empty() {
        return Err("Workspace paths cannot be empty".to_owned());
    }
    Ok(safe_paths)
}

pub(crate) fn update_workspace_files(
    root: String,
    paths: Vec<String>,
    stage: bool,
) -> Result<WorkspaceReviewDelta, String> {
    let canonical_root = require_repository_root(&root)?;
    let paths = validate_workspace_paths(&canonical_root, paths)?;

    if stage {
        let stageable = stageable_paths(&canonical_root, &paths)?;
        if !stageable.is_empty() {
            run_git_with_paths(
                &canonical_root,
                &["add", "--force", "--"],
                &stageable,
                "Unable to stage workspace file",
            )?;
        }
    } else {
        let head = run_git(&canonical_root, &["rev-parse", "--verify", "HEAD"])?;
        let base: &[&str] = if head.status.success() {
            &["restore", "--staged", "--"]
        } else {
            &["rm", "--cached", "--ignore-unmatch", "--"]
        };
        run_git_with_paths(
            &canonical_root,
            base,
            &paths,
            "Unable to unstage workspace file",
        )?;
    }

    let (staged_changes, unstaged_changes) = read_workspace_changes(&canonical_root, Some(&paths))?;
    // The delta carries both sides whole; the review the panel refreshes afterwards is what
    // reports the untracked budget it ran into.
    let (staged, unstaged) = build_review_sides(
        &canonical_root,
        staged_changes,
        unstaged_changes,
        UNTRACKED_PATCH_BUDGET,
    );

    Ok(WorkspaceReviewDelta {
        staged_files: staged?.files,
        unstaged_files: unstaged?.files,
    })
}

pub(crate) fn stage_workspace_files(
    root: String,
    paths: Vec<String>,
) -> Result<WorkspaceReviewDelta, String> {
    update_workspace_files(root, paths, true)
}

pub(crate) fn unstage_workspace_files(
    root: String,
    paths: Vec<String>,
) -> Result<WorkspaceReviewDelta, String> {
    update_workspace_files(root, paths, false)
}

/// Which of these paths HEAD already carries, and which it does not. One plumbing read of the
/// tree answers both: a repository with no HEAD yet - a fresh one - reports none of them instead of
/// failing the discard, which leaves every path on the side that is removed from disk.
fn split_workspace_paths(root: &Path, paths: &[String]) -> (Vec<String>, Vec<String>) {
    // One chunk of `ls-tree` per command line, as the index writes are: a whole-tree discard can
    // name more paths than a single command can carry.
    let mut listed = std::collections::HashSet::with_capacity(paths.len());
    for chunk in paths.chunks(GIT_PATH_CHUNK) {
        let mut args: Vec<OsString> = ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--"]
            .iter()
            .map(OsString::from)
            .collect();
        args.extend(chunk.iter().map(OsString::from));
        match run_git(root, &args) {
            Ok(output) if output.status.success() => {
                for path in output.stdout.split(|byte| *byte == 0) {
                    if let Ok(path) = std::str::from_utf8(path) {
                        if !path.is_empty() {
                            listed.insert(path.to_owned());
                        }
                    }
                }
            }
            _ => return (Vec::new(), paths.to_vec()),
        }
    }

    // git answers one path per NUL; the caller's order is what its delta is read back in, so the
    // requested paths are the ones split.
    paths
        .iter()
        .cloned()
        .partition(|path| listed.contains(path))
}

/// Removes one path HEAD does not carry from the worktree: a file, or the directory a path may
/// name instead. A path that is already gone is what a discard is after, so a missing one is a
/// success rather than a failure.
fn remove_workspace_entry(root: &Path, path: &str) -> Result<(), String> {
    // Validated before git ran; resolved again here because this is the step that writes to the
    // filesystem, and the path is the one git was told about.
    if !safe_git_path(root, path) {
        return Err("Unable to discard workspace file".to_owned());
    }

    let target = root.join(path);
    let removal = match std::fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(&target),
        Ok(_) => std::fs::remove_file(&target),
        Err(error) => Err(error),
    };
    match removal {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Unable to discard workspace file".to_owned()),
    }
}

/// Discards the changes the panel's two discard actions mean: a path HEAD carries is restored - the
/// worktree from the index when only the unstaged side is discarded, both sides from HEAD when the
/// staged side goes too - and a path HEAD does not carry is dropped from the index and then from
/// disk, which is the only shape discarding a file git has never committed can take.
pub(crate) fn discard_workspace_files(
    root: String,
    paths: Vec<String>,
    staged: bool,
) -> Result<WorkspaceReviewDelta, String> {
    let canonical_root = require_repository_root(&root)?;
    let paths = validate_workspace_paths(&canonical_root, paths)?;

    let (tracked, fresh) = split_workspace_paths(&canonical_root, &paths);

    if !tracked.is_empty() {
        let base: &[&str] = if staged {
            &["restore", "--source=HEAD", "--staged", "--worktree", "--"]
        } else {
            // Without `--staged` the index is left alone, so a file that is also staged keeps the
            // part the caller did not ask to discard.
            &["restore", "--"]
        };
        run_git_with_paths(
            &canonical_root,
            base,
            &tracked,
            "Unable to discard workspace file",
        )?;
    }

    if !fresh.is_empty() {
        // The index entry first, the same plumbing the unstage path uses; a path git never added
        // has none, which is what `--ignore-unmatch` reports.
        run_git_with_paths(
            &canonical_root,
            &["rm", "--cached", "-f", "--ignore-unmatch", "--"],
            &fresh,
            "Unable to discard workspace file",
        )?;
        for path in &fresh {
            remove_workspace_entry(&canonical_root, path)?;
        }
    }

    let (staged_changes, unstaged_changes) = read_workspace_changes(&canonical_root, Some(&paths))?;
    let (staged_side, unstaged_side) = build_review_sides(
        &canonical_root,
        staged_changes,
        unstaged_changes,
        UNTRACKED_PATCH_BUDGET,
    );

    Ok(WorkspaceReviewDelta {
        staged_files: staged_side?.files,
        unstaged_files: unstaged_side?.files,
    })
}

pub(crate) fn commit_workspace(root: String, message: String) -> Result<(), String> {
    let canonical_root = canonical_workspace_root(&root)?;
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message cannot be empty".to_owned());
    }
    if message.contains('\0') || message.len() > COMMIT_MESSAGE_LIMIT {
        return Err("Commit message is invalid".to_owned());
    }

    let mut command = Command::new("git");
    command.args(["commit", "-m"]).arg(message);
    let output = run_git_command(
        &canonical_root,
        &mut command,
        "Unable to commit workspace changes",
        "Git commit timed out",
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(git_failure("Unable to commit workspace changes", &output))
    }
}

/// One git command that talks to the remote: prompting is off so a missing credential fails
/// instead of hanging a panel behind an invisible prompt.
fn run_remote_git(
    root: &Path,
    args: &[&str],
    timeout: &'static str,
    error: &'static str,
) -> Result<(), String> {
    let mut command = Command::new("git");
    command.args(args).env("GIT_TERMINAL_PROMPT", "0");
    let output = run_git_command(root, &mut command, error, timeout)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(git_failure(error, &output))
    }
}

/// One synchronization, in the order that cannot half-finish: the upstream's commits into this
/// branch first (fast-forward only, so a diverged branch reports the pull instead of inventing a
/// merge), then this branch's commits out to the upstream.
///
/// The pull is a fetch and a merge on the up-stream ref, not `git pull --ff-only`: pull takes its
/// merge heads out of `.git/FETCH_HEAD`, a file every git process in the repository appends to, so
/// a fetch running beside it — the branch row's own ([`fetch_remote`]), a terminal, an editor —
/// left two heads in that file and failed the pull with `Cannot fast-forward to multiple branches`
/// (measured 2026-11-04: 198 of 400 pulls beside a concurrent fetch). `merge` names its one head
/// and reads no file another process writes.
pub(crate) fn sync_workspace(root: String) -> Result<(), String> {
    let canonical_root = canonical_workspace_root(&root)?;
    let Some(branch) = read_branch_sync(&canonical_root) else {
        return Err("Unable to pull workspace changes: this branch tracks no upstream".to_owned());
    };
    // A local up-stream (`branch.<name>.remote = .`) names no configured remote; its ref is
    // already in this repository, so the merge still runs and only the fetch is skipped.
    if let Some(remote) = upstream_remote(&canonical_root, &branch.upstream) {
        fetch_remote(&canonical_root, &remote)?;
    }
    run_remote_git(
        &canonical_root,
        &["merge", "--ff-only", &branch.upstream],
        "Git merge timed out",
        "Unable to pull workspace changes",
    )?;
    run_remote_git(
        &canonical_root,
        &["push"],
        "Git push timed out",
        "Unable to push workspace changes",
    )
}

/// How far this branch and its upstream have drifted, read from git's own local bookkeeping: two
/// plumbing commands that never reach the network, and every failure answers `None` - a branch
/// without an upstream and a detached HEAD are normal states, not reasons to fail a review.
fn read_branch_sync(root: &Path) -> Option<WorkspaceBranch> {
    let upstream_output = run_git(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok()?;
    if !upstream_output.status.success() {
        return None;
    }
    let upstream = std::str::from_utf8(&upstream_output.stdout)
        .map(str::trim)
        .unwrap_or_default();
    if upstream.is_empty() {
        return None;
    }

    let counts_output = run_git(
        root,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    )
    .ok()?;
    if !counts_output.status.success() {
        return None;
    }
    let counts = std::str::from_utf8(&counts_output.stdout).ok()?;
    let mut counts = counts.split_whitespace();
    // `--left-right` numbers the left side - the upstream - first, then HEAD.
    let behind = counts.next()?.parse::<u32>().ok()?;
    let ahead = counts.next()?.parse::<u32>().ok()?;

    Some(WorkspaceBranch {
        upstream: upstream.to_owned(),
        ahead,
        behind,
    })
}

/// The commit HEAD points at, or `None` when the repository has none yet (a fresh `init` refuses
/// `rev-parse HEAD`) — or when the read itself fails, which is not a review failure.
///
/// The whole object name, not `--short`: the panel compares two reads for equality, and an
/// abbreviation length that changed with the object database would read as a commit that never
/// happened. A HEAD that did move names a commit (or a checkout) since the message box's text was
/// written, and that text no longer describes the tree.
fn read_head_commit(root: &Path) -> Option<String> {
    let output = run_git(root, &["rev-parse", "HEAD"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let head = std::str::from_utf8(&output.stdout)
        .map(str::trim)
        .unwrap_or_default();
    if head.is_empty() {
        return None;
    }
    Some(head.to_owned())
}

/// Ceiling on the branches one picker lists. A repository with more still lists this many; the
/// picker is a switcher, not a branch browser, and every row costs a read here and a render there.
const BRANCH_ENTRY_LIMIT: usize = 500;

/// How long one repository's remote is left alone after it was asked for its refs.
///
/// The row is read whenever the changes area opens and again on every ref report the workspace watch
/// makes — and this fetch writes exactly such a report. Without a door the row would ask the network
/// once per report, a loop with nothing new behind it; a minute is long enough that a reader cannot
/// press faster than it, and short enough that a colleague's push shows up while they are still
/// looking at the panel.
const FETCH_INTERVAL: Duration = Duration::from_secs(60);

/// The repositories whose remote was asked for its refs, and when they were asked.
///
/// Keyed by the repository root, so two conversations showing two repositories fetch independently
/// while two surfaces of one repository share one fetch. Expired entries are dropped on every
/// question, so the table holds the roots looked at inside the last interval and nothing older —
/// the memory follows what is on screen rather than the session's history.
#[derive(Default)]
struct FetchGate {
    asked: Mutex<HashMap<PathBuf, Instant>>,
}

impl FetchGate {
    /// Whether `root`'s remote may be asked at `now`, recording the question when it may.
    fn claim(&self, root: &Path, now: Instant) -> bool {
        let mut asked = self
            .asked
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        asked.retain(|_, at| now.saturating_duration_since(*at) < FETCH_INTERVAL);
        if asked.contains_key(root) {
            return false;
        }
        asked.insert(root.to_path_buf(), now);
        true
    }
}

static FETCH_GATE: LazyLock<FetchGate> = LazyLock::new(FetchGate::default);

/// The remote `upstream` names, as this repository itself lists one.
///
/// `rev-parse --abbrev-ref @{upstream}` answers `<remote>/<branch>`, and a branch name may contain a
/// slash, so the split is the one matching a configured remote rather than the first `/`. A remote
/// name cannot contain a slash (`git remote add a/b` is refused), so at most one configured remote
/// can be the up-stream's and the match is unambiguous. `None` when nothing matches — an up-stream
/// rewritten by hand — and the fetch is skipped rather than aimed at a guess.
fn upstream_remote(root: &Path, upstream: &str) -> Option<String> {
    let output = run_git(root, &["remote"]).ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|name| upstream.strip_prefix(&format!("{name}/")).is_some())
        .map(str::to_owned)
}

/// Fetches one remote's refs: the only command here that reaches the network.
///
/// Prompting is off like every other remote command, and the credential helper is told not to open
/// a window either — this runs with nobody watching for a dialog, so a missing credential has to
/// end as a log line instead of leaving a popup on screen the reader never asked for.
///
/// `--no-write-fetch-head` keeps this process out of `.git/FETCH_HEAD`, which is a pull's own
/// inbox and not a report: every `git pull` reads the heads it finds there, and a fetch landing
/// between a pull's fetch and its merge can hand it two (`Cannot fast-forward to multiple
/// branches`) or none (see [`sync_workspace`]). The refs this panel reads are the remote-tracking
/// ones.
fn fetch_remote(root: &Path, remote: &str) -> Result<(), String> {
    run_remote_git(
        root,
        &[
            "-c",
            "credential.interactive=false",
            "fetch",
            "--quiet",
            "--no-write-fetch-head",
            remote,
        ],
        "Git fetch timed out",
        "Unable to fetch workspace changes",
    )
}

/// Asks the upstream's remote for its refs, off the caller's thread.
///
/// The row is drawn from git's local records ([`read_branch_sync`]), which only move when something
/// fetched — and the desktop is the one place a reader expects that to happen by itself. So the row
/// asks, at most once a [`FETCH_INTERVAL`] per repository and never on the thread drawing it, and
/// the answer arrives the way a fetch from a terminal does: git moves the remote-tracking refs, the
/// workspace watch reports them, and `home/BranchPicker.tsx` reads the row again. It writes no
/// `.git/FETCH_HEAD` ([`fetch_remote`]), so a pull running in a terminal is never handed this
/// fetch's heads. A failure — no network, no credential, no such remote — is logged and dropped:
/// the row keeps its last true reading and is never blocked behind a remote that cannot answer.
fn request_upstream_fetch(root: &Path, upstream: &str) {
    if !FETCH_GATE.claim(root, Instant::now()) {
        return;
    }
    let Some(remote) = upstream_remote(root, upstream) else {
        return;
    };
    let root = root.to_path_buf();
    thread::spawn(move || {
        if let Err(error) = fetch_remote(&root, &remote) {
            log::warn(&format!("omp: could not fetch {remote}: {error}"));
        }
    });
}

/// The checked-out branch and every local branch beside it, for the sidebar's branch picker.
///
/// `Ok(None)` is a workspace that is not inside a working tree: there is no branch to show, which
/// is a normal answer rather than a failure. Every read is local plumbing; a branch without an
/// upstream, and a detached HEAD, simply carry no sync counts. The answer itself never waits on the
/// network — the one remote command this call can start is [`request_upstream_fetch`]'s, on its own
/// thread, and it lands as a workspace-watch report rather than in these counts.
pub(crate) fn get_workspace_branches(root: String) -> Result<Option<WorkspaceBranches>, String> {
    let workspace_root = canonical_workspace_root(&root)?;
    let Some(canonical_root) = repository_root(&workspace_root)? else {
        return Ok(None);
    };

    let head = run_git(
        &canonical_root,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )?;
    let current = if head.status.success() {
        let name = String::from_utf8_lossy(&head.stdout).trim().to_owned();
        (!name.is_empty()).then_some(name)
    } else {
        None
    };
    // A detached HEAD still names where the reader is, so the row has something to say: the short
    // hash git resolved, and nothing else.
    let detached_at = if current.is_none() {
        run_git(&canonical_root, &["rev-parse", "--short", "HEAD"])
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .filter(|short| !short.is_empty())
    } else {
        None
    };

    let repo_name = canonical_root
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        // A repository whose top level is a drive root has no file name; the path itself is the
        // only honest name for it.
        .unwrap_or_else(|| canonical_root.display().to_string());

    // One git process for the whole list. Fields are separated by a unit separator and records by
    // NUL, which are not characters a branch name, subject or author can contain; `for-each-ref`
    // still writes a newline after each record, so it is trimmed off the next one.
    let format = "--format=%(refname:short)%1f%(committerdate:unix)%1f%(subject)%1f%(authorname)%1f%(HEAD)%00";
    let count = format!("--count={BRANCH_ENTRY_LIMIT}");
    let listed = run_git(
        &canonical_root,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            format,
            count.as_str(),
            "refs/heads",
        ],
    )?;
    if !listed.status.success() {
        return Err("Unable to read repository branches".to_owned());
    }

    let output = String::from_utf8_lossy(&listed.stdout);
    let mut branches = parse_branch_entries(&output);
    // `--count` is applied after the sort, so a checked-out branch with an old commit can fall off
    // the end of a large repository's list. It is always the first row, so it is read on its own
    // and put back when the capped listing missed it.
    if let Some(name) = current.as_deref() {
        if !branches.iter().any(|branch| branch.current) {
            let current_ref = format!("refs/heads/{name}");
            if let Ok(extra) = run_git(
                &canonical_root,
                &["for-each-ref", format, current_ref.as_str()],
            ) {
                if extra.status.success() {
                    branches.extend(parse_branch_entries(&String::from_utf8_lossy(
                        &extra.stdout,
                    )));
                }
            }
        }
    }
    // The checked-out branch heads the list whatever its commit date; the rest keep git's own
    // newest-first order.
    branches.sort_by_key(|branch| !branch.current);

    let sync = read_branch_sync(&canonical_root);
    // The counts above are as fresh as the last fetch, and this row is the one place that is worth
    // asking for a new one; the answer moves the row through the workspace watch, not through this
    // answer (see `request_upstream_fetch`).
    if let Some(branch) = sync.as_ref() {
        request_upstream_fetch(&canonical_root, &branch.upstream);
    }

    Ok(Some(WorkspaceBranches {
        repo_name,
        current,
        detached_at,
        sync,
        branches,
    }))
}

/// Turns one `for-each-ref` answer into branch rows: fields separated by a unit separator, records
/// by NUL, with the newline git writes after each record trimmed off the next one.
fn parse_branch_entries(output: &str) -> Vec<RepositoryBranch> {
    let mut branches = Vec::new();
    for record in output.split('\0') {
        let record = record.trim_start_matches('\n');
        if record.is_empty() {
            continue;
        }
        let mut fields = record.split('\u{1f}');
        let (Some(name), Some(updated_at), Some(subject), Some(author), Some(head)) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            continue;
        };
        branches.push(RepositoryBranch {
            name: name.to_owned(),
            updated_at: updated_at.parse::<i64>().unwrap_or(0),
            subject: subject.to_owned(),
            author: author.to_owned(),
            current: head == "*",
        });
    }
    branches
}

/// Checks out one local branch by name.
///
/// The name is checked against the repository's own branch refs before git is asked to switch, so
/// the only revisions this command can reach are branches it just listed. A worktree with changes
/// that conflict with the target branch fails the switch and leaves the repository untouched, which
/// is git's own answer and the reason it is reported rather than worked around.
pub(crate) fn checkout_workspace_branch(root: String, branch: String) -> Result<(), String> {
    let canonical_root = require_repository_root(&root)?;
    if branch.is_empty() || branch.contains('\0') || branch.starts_with('-') || branch.len() > 255 {
        return Err("Branch name is invalid".to_owned());
    }

    let refname = format!("refs/heads/{branch}");
    let exists = run_git(
        &canonical_root,
        &["rev-parse", "--verify", "--quiet", refname.as_str()],
    )?;
    if !exists.status.success() {
        return Err("Branch is not in this repository".to_owned());
    }

    let switched = run_git(&canonical_root, &["checkout", "--quiet", branch.as_str()])?;
    if switched.status.success() {
        Ok(())
    } else {
        Err("Unable to switch branch".to_owned())
    }
}

pub(crate) fn get_workspace_review(root: String) -> Result<WorkspaceReview, String> {
    let workspace_root = canonical_workspace_root(&root)?;
    // The same probe that answers "is this a repository at all" also answers *which* repository,
    // which is the directory every command of the review runs in (see `repository_root`).
    let canonical_root = match repository_root(&workspace_root) {
        Ok(Some(repository)) => repository,
        Ok(None) => return Ok(empty_review(false, true, false, None)),
        Err(error) => return Ok(empty_review(false, true, false, Some(error))),
    };
    // The root every row's path is named against, in the spelling the frontend holds every other
    // path in: `canonicalize` answers with the verbatim form on Windows, and that spelling never
    // matches the workspace root the frontend already has.
    let top_level = plain_path(&canonical_root.to_string_lossy());

    let status = run_git(
        &canonical_root,
        &[
            "status",
            "--porcelain=v1",
            "--renames",
            "-z",
            "--untracked-files=all",
        ],
    )
    .map_err(|_| "Unable to inspect git status".to_owned())?;
    if !status.status.success() {
        return Ok(empty_review(
            true,
            false,
            false,
            Some("Unable to inspect git status".to_owned()),
        ));
    }
    let dirty = !status.stdout.is_empty();
    // Read before the rows so both sides' returns carry it: the panel drops a message box's text
    // when this changes between two reads, and a partial answer must not look like a moved HEAD.
    let head = read_head_commit(&canonical_root);

    let (staged_changes, unstaged_changes) =
        match changed_paths_for_review(&canonical_root, &status.stdout, None) {
            Ok(changes) => changes,
            Err(error) => return Ok(empty_review(true, !dirty, false, Some(error))),
        };

    // Both sides are rendered together; the staged error is still reported first, exactly as it
    // was when the sides were built one after the other.
    let (staged, unstaged) = build_review_sides(
        &canonical_root,
        staged_changes,
        unstaged_changes,
        UNTRACKED_PATCH_BUDGET,
    );
    let staged = match staged {
        Ok(built) => built,
        Err(error) => return Ok(empty_review(true, !dirty, false, Some(error))),
    };
    let unstaged = match unstaged {
        Ok(built) => built,
        Err(error) => {
            return Ok(WorkspaceReview {
                repo: true,
                clean: !dirty,
                staged_files: staged.files,
                unstaged_files: Vec::new(),
                truncated: staged.patch_truncated,
                repository_root: Some(top_level),
                head,
                branch: None,
                error: Some(error),
            })
        }
    };

    // Read once, on the one path that reports a real repository: the plumbing cannot fail here
    // with anything the caller could act on, so a `None` is the absence of a branch to sync with
    // rather than an error.
    let branch = read_branch_sync(&canonical_root);
    Ok(WorkspaceReview {
        repo: true,
        clean: !dirty,
        staged_files: staged.files,
        unstaged_files: unstaged.files,
        truncated: staged.patch_truncated || unstaged.patch_truncated,
        repository_root: Some(top_level),
        head,
        branch,
        error: None,
    })
}

#[cfg(test)]
mod tests;

//! The review side of git: what status means, how a patch or a `numstat` record maps onto a
//! changed path, and how both become the rows the review panel renders.
//!
//! Nothing here starts a process of its own; the commands come from [`super::process`], and the
//! work is arranged so the independent ones run together.

use std::path::Path;
use std::thread::{self, ScopedJoinHandle};

use crate::models::{ReviewFile, ReviewHunk, ReviewLine};
use crate::services::workspace::safe_git_path;

use super::process::{
    run_git, run_git_patch, run_git_patch_batch, LimitedOutput, PatchSource, PATCH_LIMIT,
};

/// Whole-batch ceiling on the untracked patches a single review keeps. One file is already capped
/// at `PATCH_LIMIT`, and this is the second bound: what a repository with many untracked files can
/// put into one response.
pub(super) const UNTRACKED_PATCH_BUDGET: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy)]
pub(super) enum ReviewStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
}

impl ReviewStatus {
    fn from_git_code(code: u8) -> Self {
        match code {
            b'A' => Self::Added,
            b'D' => Self::Deleted,
            b'R' | b'C' => Self::Renamed,
            b'M' | b'T' | b'U' => Self::Modified,
            _ => Self::Modified,
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
            Self::Renamed => "renamed",
            Self::Untracked => "untracked",
        }
    }
}

pub(super) struct ChangedPath {
    pub(super) path: String,
    pub(super) old_path: Option<String>,
    status: ReviewStatus,
    source: PatchSource,
}

struct ParsedPatch {
    binary: bool,
    additions: usize,
    deletions: usize,
    hunks: Vec<ReviewHunk>,
}

impl ParsedPatch {
    /// The patch of a file that was not read: no hunks and no counts, because there is nothing to
    /// report for it.
    fn none() -> Self {
        Self {
            binary: false,
            additions: 0,
            deletions: 0,
            hunks: Vec::new(),
        }
    }
}

struct BatchPatch {
    header: Vec<u8>,
    parsed: ParsedPatch,
    too_large: bool,
}
type BatchStat = (String, Option<String>, usize, usize, bool);

/// One side of the review: the rows to render and whether the untracked budget cut a patch short.
pub(super) struct BuiltReview {
    pub(super) files: Vec<ReviewFile>,
    pub(super) patch_truncated: bool,
}

/// Joins one scoped git step. A worker that panicked is a bug in this module rather than a git
/// failure, and it is reported as a failed step instead of unwinding into the command.
fn joined<T>(
    handle: ScopedJoinHandle<'_, Result<T, String>>,
    error: &'static str,
) -> Result<T, String> {
    handle.join().unwrap_or_else(|_| Err(error.to_owned()))
}

/// Renders both sides of a review.
///
/// The two sides are independent - each reads its own patches and counts, and neither writes - so
/// they run together: on a repository with staged and unstaged work this halves the wait. The two
/// reads inside one side run together for the same reason, which keeps a review at four git
/// processes at most, however many files changed. Every result still comes back in its own order
/// and with its own error, so the caller's error precedence does not change.
pub(super) fn build_review_sides(
    root: &Path,
    staged: Vec<ChangedPath>,
    unstaged: Vec<ChangedPath>,
    untracked_budget: usize,
) -> (Result<BuiltReview, String>, Result<BuiltReview, String>) {
    let staged_paths = patch_paths_for_changes(&staged);
    let unstaged_paths = patch_paths_for_changes(&unstaged);
    thread::scope(|scope| {
        let staged_paths = &staged_paths;
        let unstaged_paths = &unstaged_paths;
        let staged = scope
            .spawn(move || build_review_files(root, staged, Some(staged_paths), untracked_budget));
        let unstaged = scope.spawn(move || {
            build_review_files(root, unstaged, Some(unstaged_paths), untracked_budget)
        });
        (
            joined(staged, "Unable to read git patch"),
            joined(unstaged, "Unable to read git patch"),
        )
    })
}

/// Reads the changed paths of one side of the review: the patches and, when the side is read from
/// the index or the worktree, the `numstat` counts alongside them.
fn build_review_files(
    root: &Path,
    changes: Vec<ChangedPath>,
    patch_paths: Option<&[String]>,
    untracked_budget: usize,
) -> Result<BuiltReview, String> {
    let Some(source) = changes.first().map(|change| change.source) else {
        return Ok(BuiltReview {
            files: Vec::new(),
            patch_truncated: false,
        });
    };

    match source {
        PatchSource::Cached | PatchSource::Worktree => {
            let (batch, stat_batch) = thread::scope(|scope| {
                let patch = scope.spawn(|| run_git_patch_batch(root, source, patch_paths, false));
                let stats = scope.spawn(|| run_git_patch_batch(root, source, patch_paths, true));
                (
                    joined(patch, "Unable to read git patch"),
                    joined(stats, "Unable to read git numstat"),
                )
            });
            let batch = batch?;
            let stat_batch = stat_batch?;
            if !batch.status.success() && !batch.exceeded {
                return Err("Unable to read git patch".to_owned());
            }
            if !stat_batch.status.success() && !stat_batch.exceeded {
                return Err("Unable to read git numstat".to_owned());
            }
            // A batch that ran past the output ceiling left some files without a patch or without
            // counts: those rows are rendered as unreadable rather than guessed at, and the review
            // says at least one diff was cut.
            let patch_truncated = batch.exceeded || stat_batch.exceeded;
            let mut stats: Vec<Option<BatchStat>> = parse_batch_stats(&stat_batch)
                .into_iter()
                .map(Some)
                .collect();
            let mut patches: Vec<Option<BatchPatch>> =
                parse_batch_patches(&batch).into_iter().map(Some).collect();
            // Both batches are keyed once, so a whole-tree review does not compare every file
            // against every remaining patch and stat record.
            let mut patch_index: std::collections::HashMap<Vec<u8>, usize> =
                std::collections::HashMap::with_capacity(patches.len());
            for (index, patch) in patches.iter().enumerate() {
                if let Some(patch) = patch {
                    let header = patch.header.strip_suffix(b"\r").unwrap_or(&patch.header);
                    patch_index.entry(header.to_vec()).or_insert(index);
                }
            }
            let mut stat_index: std::collections::HashMap<String, Vec<usize>> =
                std::collections::HashMap::with_capacity(stats.len());
            for (index, stat) in stats.iter().enumerate() {
                if let Some((path, _, _, _, _)) = stat {
                    stat_index.entry(path.clone()).or_default().push(index);
                }
            }
            let mut files = Vec::with_capacity(changes.len());
            for change in changes {
                let patch =
                    take_batch_patch(&mut patches, &mut patch_index, &change, batch.exceeded);
                let stat = take_batch_stat(&mut stats, &stat_index, &change);
                let mut file = review_file_from_patch(
                    change,
                    patch.parsed,
                    patch.too_large || stat_batch.exceeded,
                );
                if let Some((_, _, additions, deletions, binary)) = stat {
                    file.additions = additions;
                    file.deletions = deletions;
                    file.binary = binary;
                }
                files.push(file);
            }
            Ok(BuiltReview {
                files,
                patch_truncated,
            })
        }
        PatchSource::NoIndex => {
            // An untracked file has no batch form, so each one costs a process of its own. The
            // budget bounds the batch: a file is only read while what is left can still cover a
            // whole patch of it - `PATCH_LIMIT` is the most one file can contribute - so the batch
            // ends below the budget instead of stepping over it by one file. Files the budget has
            // no room for are reported without being read.
            let mut remaining = untracked_budget;
            let mut patch_truncated = false;
            let mut files = Vec::with_capacity(changes.len());
            for change in changes {
                if remaining < PATCH_LIMIT {
                    patch_truncated = true;
                    files.push(review_file_from_patch(change, ParsedPatch::none(), true));
                    continue;
                }
                let patch = run_git_patch(root, &change.path)?;
                if !patch.status.success() && !patch.exceeded && patch.status.code() != Some(1) {
                    return Err("Unable to read git patch".to_owned());
                }
                remaining = remaining.saturating_sub(patch.stdout.len());
                let parsed = parse_patch(&patch.stdout);
                files.push(review_file_from_patch(change, parsed, patch.exceeded));
            }
            Ok(BuiltReview {
                files,
                patch_truncated,
            })
        }
    }
}

pub(super) fn read_workspace_changes(
    root: &Path,
    requested_paths: Option<&[String]>,
) -> Result<(Vec<ChangedPath>, Vec<ChangedPath>), String> {
    let status = run_git(
        root,
        &[
            "status",
            "--porcelain=v1",
            "--renames",
            "-z",
            "--untracked-files=all",
        ],
    )?;
    if !status.status.success() {
        return Err("Unable to inspect git status".to_owned());
    }
    changed_paths_for_review(root, &status.stdout, requested_paths)
}

/// The changed paths a review keeps, one list per side.
///
/// The list is the whole of `git status`: it is the panel's index of what changed, so it is not
/// cut down to a page. What stays bounded is each file's patch (see [`build_review_files`]) — a
/// large tree lists every path, and the rows whose diffs could not be read say so on their own.
pub(super) fn changed_paths_for_review(
    root: &Path,
    status_data: &[u8],
    requested_paths: Option<&[String]>,
) -> Result<(Vec<ChangedPath>, Vec<ChangedPath>), String> {
    let (mut staged_changes, mut unstaged_changes) = parse_status_changes(status_data);
    retain_safe_changed_paths(root, &mut staged_changes);
    retain_safe_changed_paths(root, &mut unstaged_changes);

    if let Some(requested_paths) = requested_paths {
        // A bulk action can name as many paths as the tree has files; a set keeps that filter
        // linear instead of comparing every changed path against every requested one.
        let requested: std::collections::HashSet<&str> =
            requested_paths.iter().map(String::as_str).collect();
        let matches = |change: &ChangedPath| {
            requested.contains(change.path.as_str())
                || change
                    .old_path
                    .as_deref()
                    .is_some_and(|old_path| requested.contains(old_path))
        };
        staged_changes.retain(|change| matches(change));
        unstaged_changes.retain(|change| matches(change));
    }

    sort_changed_paths(&mut staged_changes);
    sort_changed_paths(&mut unstaged_changes);

    Ok((staged_changes, unstaged_changes))
}

fn parse_status_changes(data: &[u8]) -> (Vec<ChangedPath>, Vec<ChangedPath>) {
    let mut fields = data.split(|byte| *byte == 0);
    let mut staged_changes = Vec::new();
    let mut unstaged_changes = Vec::new();

    while let Some(record) = fields.next() {
        if record.len() < 4 || record[2] != b' ' {
            continue;
        }

        let index_status = record[0];
        let worktree_status = record[1];
        let Some(path) = std::str::from_utf8(&record[3..]).ok() else {
            continue;
        };
        if path.is_empty() {
            continue;
        }

        let has_index_rename = matches!(index_status, b'R' | b'C');
        let has_worktree_rename = matches!(worktree_status, b'R' | b'C');
        let old_path = if has_index_rename || has_worktree_rename {
            let Some(old_path_bytes) = fields.next() else {
                continue;
            };
            let Ok(old_path) = std::str::from_utf8(old_path_bytes) else {
                continue;
            };
            if old_path.is_empty() {
                continue;
            }
            Some(old_path.to_owned())
        } else {
            None
        };

        if index_status != b' ' && index_status != b'?' && index_status != b'!' {
            staged_changes.push(ChangedPath {
                path: path.to_owned(),
                old_path: if has_index_rename {
                    old_path.clone()
                } else {
                    None
                },
                status: ReviewStatus::from_git_code(index_status),
                source: PatchSource::Cached,
            });
        }

        if worktree_status != b' ' && worktree_status != b'?' && worktree_status != b'!' {
            unstaged_changes.push(ChangedPath {
                path: path.to_owned(),
                old_path: if has_worktree_rename { old_path } else { None },
                status: ReviewStatus::from_git_code(worktree_status),
                source: PatchSource::Worktree,
            });
        } else if index_status == b'?' && worktree_status == b'?' {
            unstaged_changes.push(ChangedPath {
                path: path.to_owned(),
                old_path: None,
                status: ReviewStatus::Untracked,
                source: PatchSource::NoIndex,
            });
        }
    }

    (staged_changes, unstaged_changes)
}

fn parse_patch(data: &[u8]) -> ParsedPatch {
    let text = String::from_utf8_lossy(data);
    let mut binary = false;
    let mut additions = 0;
    let mut deletions = 0;
    let mut hunks = Vec::new();
    let mut current_hunk: Option<ReviewHunk> = None;

    for raw_line in text.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            binary = true;
            continue;
        }
        if line.starts_with("literal ") || line.starts_with("delta ") {
            binary = true;
            continue;
        }

        if line.starts_with("@@ ") || line.starts_with("@@@ ") {
            if let Some(hunk) = current_hunk.take() {
                hunks.push(hunk);
            }
            current_hunk = Some(ReviewHunk {
                header: line.to_owned(),
                lines: Vec::new(),
            });
            continue;
        }

        let Some(hunk) = current_hunk.as_mut() else {
            continue;
        };
        if line == "\\ No newline at end of file" {
            continue;
        }
        let Some(prefix) = line.as_bytes().first().copied() else {
            continue;
        };
        let Some(content) = line.get(1..) else {
            continue;
        };
        let line_type = match prefix {
            b'+' => {
                additions += 1;
                "add"
            }
            b'-' => {
                deletions += 1;
                "del"
            }
            b' ' => "context",
            _ => continue,
        };
        hunk.lines.push(ReviewLine {
            line_type: line_type.to_owned(),
            text: content.to_owned(),
        });
    }
    if let Some(hunk) = current_hunk {
        hunks.push(hunk);
    }

    ParsedPatch {
        binary,
        additions,
        deletions,
        hunks,
    }
}

fn is_patch_header(line: &[u8]) -> bool {
    line.starts_with(b"diff --git ")
}

fn parse_batch_patches(output: &LimitedOutput) -> Vec<BatchPatch> {
    let mut starts = Vec::new();
    let mut line_start = 0;
    for (index, byte) in output.stdout.iter().enumerate() {
        if *byte == b'\n' {
            if is_patch_header(&output.stdout[line_start..index]) {
                starts.push(line_start);
            }
            line_start = index + 1;
        }
    }
    if line_start < output.stdout.len() && is_patch_header(&output.stdout[line_start..]) {
        starts.push(line_start);
    }

    let mut patches = Vec::with_capacity(starts.len());
    for (index, start) in starts.iter().copied().enumerate() {
        let end = starts
            .get(index + 1)
            .copied()
            .unwrap_or(output.stdout.len());
        let bytes = &output.stdout[start..end];
        let limited_len = bytes.len().min(PATCH_LIMIT);
        let parsed = parse_patch(&bytes[..limited_len]);
        let incomplete =
            output.exceeded && end == output.stdout.len() && bytes.last().copied() != Some(b'\n');
        let header_end = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .unwrap_or(bytes.len());
        let header = bytes[..header_end].to_vec();
        patches.push(BatchPatch {
            header,
            parsed,
            too_large: bytes.len() > PATCH_LIMIT || incomplete,
        });
    }
    patches
}

fn parse_batch_stats(output: &LimitedOutput) -> Vec<BatchStat> {
    let mut records = output.stdout.split(|byte| *byte == 0);
    let mut pending = None;
    let mut stats = Vec::new();
    let parse_count = |field: &[u8]| -> usize {
        std::str::from_utf8(field)
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0)
    };
    while let Some(record) = pending.take().or_else(|| records.next()) {
        let mut columns = record.splitn(3, |byte| *byte == b'\t');
        let (Some(additions), Some(deletions), Some(path)) =
            (columns.next(), columns.next(), columns.next())
        else {
            continue;
        };
        let Ok(mut path) = String::from_utf8(path.to_vec()) else {
            continue;
        };
        let binary = additions == b"-" || deletions == b"-";
        let additions = if binary { 0 } else { parse_count(additions) };
        let deletions = if binary { 0 } else { parse_count(deletions) };
        if path.is_empty() {
            let (Some(old_path), Some(new_path)) = (records.next(), records.next()) else {
                continue;
            };
            let (Ok(old_path), Ok(path)) = (
                String::from_utf8(old_path.to_vec()),
                String::from_utf8(new_path.to_vec()),
            ) else {
                continue;
            };
            stats.push((path, Some(old_path), additions, deletions, binary));
            continue;
        }
        let mut old_path = None;
        if let Some(next) = records.next().filter(|next| !next.is_empty()) {
            if next.contains(&b'\t') {
                pending = Some(next);
            } else {
                old_path = Some(path);
                let Ok(new_path) = String::from_utf8(next.to_vec()) else {
                    continue;
                };
                path = new_path;
            }
        }
        stats.push((path, old_path, additions, deletions, binary));
    }
    stats
}

/// Takes the counts `git diff --numstat` reported for one change.
///
/// The records are indexed by their new path once; a rename carries its old path as well, so the
/// exact pair wins and a record without an old path stands for the file itself.
fn take_batch_stat(
    stats: &mut [Option<BatchStat>],
    index: &std::collections::HashMap<String, Vec<usize>>,
    change: &ChangedPath,
) -> Option<BatchStat> {
    let positions = index.get(&change.path)?;
    let expected_old = change.old_path.as_deref().unwrap_or(change.path.as_str());
    let exact = positions.iter().copied().find(|&position| {
        stats[position]
            .as_ref()
            .is_some_and(|(_, old_path, _, _, _)| old_path.as_deref() == Some(expected_old))
    });
    let unnamed = positions.iter().copied().find(|&position| {
        stats[position]
            .as_ref()
            .is_some_and(|(_, old_path, _, _, _)| old_path.is_none())
    });
    stats[exact.or(unnamed)?].take()
}

fn quote_git_path(path: &str) -> String {
    let mut quoted = String::with_capacity(path.len() + 2);
    quoted.push('"');
    for byte in path.bytes() {
        match byte {
            b'"' => quoted.push_str("\\\""),
            b'\\' => quoted.push_str("\\\\"),
            b'\x07' => quoted.push_str("\\a"),
            b'\x08' => quoted.push_str("\\b"),
            b'\t' => quoted.push_str("\\t"),
            b'\n' => quoted.push_str("\\n"),
            b'\x0b' => quoted.push_str("\\v"),
            b'\x0c' => quoted.push_str("\\f"),
            b'\r' => quoted.push_str("\\r"),
            0x20..=0x7e => quoted.push(byte as char),
            byte => {
                const OCTAL: &[u8; 8] = b"01234567";
                quoted.push('\\');
                quoted.push(OCTAL[((byte >> 6) & 0x07) as usize] as char);
                quoted.push(OCTAL[((byte >> 3) & 0x07) as usize] as char);
                quoted.push(OCTAL[(byte & 0x07) as usize] as char);
            }
        }
    }
    quoted.push('"');
    quoted
}

/// The header spellings git can write for one change: plain, plain-quoted, and fully escaped.
fn patch_header_candidates(change: &ChangedPath) -> [String; 3] {
    let old_path = change.old_path.as_deref().unwrap_or(change.path.as_str());
    [
        format!("diff --git a/{old_path} b/{}", change.path),
        format!("diff --git \"a/{old_path}\" \"b/{}\"", change.path),
        format!(
            "diff --git {} {}",
            quote_git_path(&format!("a/{old_path}")),
            quote_git_path(&format!("b/{}", change.path))
        ),
    ]
}

fn patch_matches_change(patch: &BatchPatch, change: &ChangedPath) -> bool {
    let header = patch.header.strip_suffix(b"\r").unwrap_or(&patch.header);
    patch_header_candidates(change)
        .iter()
        .any(|candidate| header == candidate.as_bytes())
}

fn take_batch_patch(
    patches: &mut [Option<BatchPatch>],
    index: &mut std::collections::HashMap<Vec<u8>, usize>,
    change: &ChangedPath,
    missing_too_large: bool,
) -> BatchPatch {
    // The index makes the common case a lookup; the tolerant scan below still catches a header
    // spelling this side could not reproduce.
    for candidate in patch_header_candidates(change) {
        let position = index.get(candidate.as_bytes()).copied();
        if let Some(position) = position {
            if let Some(patch) = patches[position].take() {
                index.remove(candidate.as_bytes());
                return patch;
            }
        }
    }

    let selected = patches.iter().enumerate().find_map(|(index, patch)| {
        patch
            .as_ref()
            .filter(|patch| patch_matches_change(patch, change))
            .map(|_| index)
    });

    if let Some(index) = selected {
        if let Some(patch) = patches[index].take() {
            return patch;
        }
    }

    BatchPatch {
        header: Vec::new(),
        parsed: ParsedPatch::none(),
        too_large: missing_too_large,
    }
}

fn sort_changed_paths(changes: &mut [ChangedPath]) {
    changes.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.status.as_str().cmp(right.status.as_str()))
    });
}

fn retain_safe_changed_paths(root: &Path, changes: &mut Vec<ChangedPath>) {
    changes.retain(|change| {
        safe_git_path(root, &change.path)
            && change
                .old_path
                .as_deref()
                .map(|old_path| safe_git_path(root, old_path))
                .unwrap_or(true)
    });
}

/// The paths one batch command should read: both sides of a rename, each once.
///
/// A set keeps a whole-tree review linear. Comparing every path against every earlier one was
/// fine while a side held at most a page of files; the list is whole now, so it is not.
fn patch_paths_for_changes(changes: &[ChangedPath]) -> Vec<String> {
    let mut seen = std::collections::HashSet::with_capacity(changes.len() * 2);
    let mut paths = Vec::with_capacity(changes.len() * 2);
    for change in changes {
        if let Some(old_path) = change.old_path.as_ref() {
            if seen.insert(old_path.as_str()) {
                paths.push(old_path.clone());
            }
        }
        if seen.insert(change.path.as_str()) {
            paths.push(change.path.clone());
        }
    }
    paths
}

fn review_file_from_patch(change: ChangedPath, parsed: ParsedPatch, too_large: bool) -> ReviewFile {
    ReviewFile {
        path: change.path,
        old_path: change.old_path,
        status: change.status.as_str().to_owned(),
        additions: parsed.additions,
        deletions: parsed.deletions,
        binary: parsed.binary,
        too_large,
        hunks: parsed.hunks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    fn git(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-c")
            .arg("core.autocrlf=false")
            .args(args)
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("git is available");
        assert!(status.success(), "git {args:?} failed");
    }

    /// An untracked file of `lines` lines; the patch of such a file is what the budget counts.
    fn untracked(root: &Path, name: &str, lines: usize) {
        let body = (0..lines)
            .map(|line| format!("{name} line {line} {}", "x".repeat(64)))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(root.join(name), format!("{body}\n")).expect("untracked file");
    }

    /// A repository with two untracked files, read the way the commands read one: the root a review
    /// runs against is always canonical, and the path checks compare against it.
    fn fixture(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("omp-git-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("repository directory");
        git(&root, &["init", "--quiet"]);
        untracked(&root, "a.txt", 20);
        untracked(&root, "b.txt", 20);
        std::fs::canonicalize(&root).expect("canonical root")
    }

    /// A budget below one file's ceiling cannot cover a patch at all: nothing is read, and every
    /// file is reported as too large - the bound holds even at the smallest budget there is.
    #[test]
    fn a_budget_below_one_patch_reads_no_file() {
        let root = fixture("tiny");

        let (_, unstaged) =
            changed_paths_for_review(&root, status_of(&root).as_slice(), None).expect("changes");
        let built = build_review_files(&root, unstaged, None, PATCH_LIMIT - 1).expect("review");

        assert!(built.patch_truncated);
        assert_eq!(built.files.len(), 2);
        for file in &built.files {
            assert!(file.too_large);
            assert_eq!(file.additions, 0);
            assert_eq!(file.deletions, 0);
            assert!(file.hunks.is_empty());
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The boundary the bound rests on: once the first file's patch is counted, what is left
    /// cannot cover another whole patch, so the next file is reported without being read.
    #[test]
    fn what_is_left_after_one_file_does_not_cover_the_next() {
        let root = fixture("boundary");

        let (_, unstaged) =
            changed_paths_for_review(&root, status_of(&root).as_slice(), None).expect("changes");
        let built = build_review_files(&root, unstaged, None, PATCH_LIMIT).expect("review");

        assert!(built.patch_truncated);
        assert_eq!(built.files.len(), 2);
        assert!(!built.files[0].too_large);
        assert!(built.files[0].additions > 0, "the first file is read");
        assert!(built.files[1].too_large, "the second file is not");
        assert_eq!(built.files[1].additions, 0);
        assert!(built.files[1].hunks.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The same batch with room to spare keeps every file and reports nothing as cut.
    #[test]
    fn a_batch_within_its_budget_keeps_every_patch() {
        let root = fixture("room");

        let (_, unstaged) =
            changed_paths_for_review(&root, status_of(&root).as_slice(), None).expect("changes");
        let built =
            build_review_files(&root, unstaged, None, UNTRACKED_PATCH_BUDGET).expect("review");

        assert!(!built.patch_truncated);
        assert_eq!(built.files.len(), 2);
        for file in &built.files {
            assert!(!file.too_large);
            assert_eq!(file.additions, 20);
            assert_eq!(file.deletions, 0);
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    /// `git status --porcelain` output for the fixture, read through the process layer.
    fn status_of(root: &Path) -> Vec<u8> {
        run_git(
            root,
            &[
                "status",
                "--porcelain=v1",
                "--renames",
                "-z",
                "--untracked-files=all",
            ],
        )
        .expect("status")
        .stdout
    }
}

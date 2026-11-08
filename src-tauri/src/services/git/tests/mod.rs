//! The git review's tests, split out of `git.rs` when it outgrew one file (`rules.md#single-file-line-limit`).
//!
//! They build a real fixture repository and run the same `git` binary the review runs, so a
//! failure here is a broken environment rather than a code path under test.

mod remotes;

use super::*;
use crate::models::ReviewFile;
use std::path::PathBuf;
use std::process::Stdio;

/// Runs one git command in the fixture repository. The fixture is built with the same binary
/// the review reads, so a failure here is a broken environment rather than a code path under
/// test; `core.autocrlf` is pinned so the worktree files keep the bytes this test wrote.
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

fn body(index: usize, revision: usize) -> String {
    (0..3)
        .map(|line| format!("line {index} r{revision} {line}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

/// A throwaway repository: `tracked` files committed, `staged` of them rewritten and added to
/// the index, and `untracked` files git has never seen. The two kinds are deliberately kept on
/// their own side of the review: how a side is read (a batch for the index, one command per
/// untracked file) follows from its first path.
fn repository(tag: &str, tracked: usize, staged: usize, untracked: usize) -> PathBuf {
    let root = std::env::temp_dir().join(format!("omp-git-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("repository directory");
    git(&root, &["init", "--quiet"]);
    git(&root, &["config", "user.email", "omp@example.com"]);
    git(&root, &["config", "user.name", "OMP"]);
    // The fixture's own commands pin `core.autocrlf` per call; the operations under test run
    // plain `git`, so the repository itself has to keep the bytes these tests wrote.
    git(&root, &["config", "core.autocrlf", "false"]);
    for index in 0..tracked {
        std::fs::write(root.join(format!("mod-{index:03}.txt")), body(index, 1))
            .expect("tracked file");
    }
    git(&root, &["add", "--all"]);
    git(&root, &["commit", "--quiet", "-m", "fixture"]);
    for index in 0..staged {
        std::fs::write(root.join(format!("mod-{index:03}.txt")), body(index, 2))
            .expect("staged file");
        git(&root, &["add", "--", &format!("mod-{index:03}.txt")]);
    }
    for index in 0..untracked {
        std::fs::write(root.join(format!("fix-{index:03}.txt")), body(index, 1))
            .expect("untracked file");
    }
    root
}

fn review_of(root: &Path) -> WorkspaceReview {
    get_workspace_review(root.to_string_lossy().into_owned()).expect("review")
}

/// Lines one path's patch contributes, by kind.
fn patch_lines(file: &ReviewFile) -> (usize, usize) {
    let count = |kind: &str| {
        file.hunks
            .iter()
            .flat_map(|hunk| &hunk.lines)
            .filter(|line| line.line_type == kind)
            .count()
    };
    (count("add"), count("del"))
}

/// Every changed path has to carry its own patch and its own counts, whichever thread read it:
/// this is what breaks first if the two sides of the review get mixed up.
#[test]
fn a_changed_path_keeps_its_own_patch_and_counts() {
    let root = repository("review", 4, 3, 2);
    let review = review_of(&root);

    assert!(review.repo);
    assert!(!review.clean);
    assert_eq!(review.error, None);
    assert!(!review.truncated);

    // The rewritten files are staged, so their patches come from the index and git's own
    // `numstat` counts decide the totals.
    let staged: Vec<&str> = review
        .staged_files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(staged, ["mod-000.txt", "mod-001.txt", "mod-002.txt"]);
    for file in &review.staged_files {
        assert_eq!(file.status, "modified");
        assert_eq!(file.additions, 3);
        assert_eq!(file.deletions, 3);
        assert_eq!(patch_lines(file), (3, 3));
        assert!(!file.binary);
        assert!(!file.too_large);
        assert!(file.old_path.is_none());
    }

    // Untracked files are read against the empty file: every line is an addition.
    let unstaged: Vec<&str> = review
        .unstaged_files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(unstaged, ["fix-000.txt", "fix-001.txt"]);
    for file in &review.unstaged_files {
        assert_eq!(file.status, "untracked");
        assert_eq!(file.additions, 3);
        assert_eq!(file.deletions, 0);
        assert_eq!(patch_lines(file), (3, 0));
        assert!(!file.binary);
        assert!(!file.too_large);
        assert!(file.old_path.is_none());
    }

    let _ = std::fs::remove_dir_all(&root);
}

/// The review names the commit HEAD points at, and a commit moves it. This is the panel's only
/// signal that the tree a message box's text was written against has been committed, whichever
/// actor committed it (2026-10-31).
#[test]
fn a_review_names_the_head_commit_and_a_commit_moves_it() {
    let root = repository("head", 1, 1, 0);
    let before = review_of(&root);
    let expected = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&root)
        .output()
        .expect("git is available");
    let expected = String::from_utf8_lossy(&expected.stdout).trim().to_owned();
    assert_eq!(before.head.as_deref(), Some(expected.as_str()));

    commit_workspace(root.to_string_lossy().into_owned(), "next".to_owned()).expect("commit");
    let after = review_of(&root);
    assert_ne!(after.head, before.head, "the commit moved HEAD");
    assert!(after.staged_files.is_empty());

    let _ = std::fs::remove_dir_all(&root);
}

/// A tree with more changed files than the old per-side display ceiling still lists every path.
///
/// The ceiling used to cut each side at 100 and the panel said so; the list is the review's index
/// of what changed, so it is whole however large the tree is (2026-10-20).
#[test]
fn every_changed_path_is_listed() {
    let root = std::env::temp_dir().join(format!("omp-git-all-paths-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("repository directory");
    git(&root, &["init", "--quiet"]);
    git(&root, &["config", "user.email", "omp@example.com"]);
    git(&root, &["config", "user.name", "OMP"]);
    git(&root, &["config", "core.autocrlf", "false"]);
    for index in 0..101 {
        std::fs::write(root.join(format!("mod-{index:03}.txt")), body(index, 1))
            .expect("tracked file");
    }
    git(&root, &["add", "--all"]);
    git(&root, &["commit", "--quiet", "-m", "fixture"]);
    for index in 0..101 {
        std::fs::write(root.join(format!("mod-{index:03}.txt")), body(index, 2))
            .expect("changed file");
    }
    git(&root, &["add", "--all"]);

    let review = review_of(&root);
    assert!(review.repo);
    assert_eq!(review.staged_files.len(), 101);
    assert!(
        !review.truncated,
        "the path list is whole; truncation names unread patches only"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// A directory that is not a repository is reported as such instead of as an error.
#[test]
fn a_directory_without_a_repository_is_not_an_error() {
    let root = std::env::temp_dir().join(format!("omp-git-plain-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("directory");

    let review = review_of(&root);
    assert!(!review.repo);
    assert!(review.clean);
    assert!(review.staged_files.is_empty());
    assert!(review.unstaged_files.is_empty());
    assert_eq!(review.error, None);
    // Nothing was read from a repository, so there is no root to name the rows against either.
    assert_eq!(review.repository_root, None);

    let _ = std::fs::remove_dir_all(&root);
}

/// A workspace that is a *subdirectory* of its repository.
///
/// Every path a review names is relative to the repository (`git status` prints them that way
/// whatever directory it runs in), and the commands that consume one resolve it against the
/// directory they run in — so reading and staging both have to happen at the top level. Run
/// from the workspace instead, `fix-000.txt` is read as `nested/fix-000.txt`, git answers
/// `pathspec ... did not match any files`, and staging fails with nothing on screen but
/// "Unable to stage workspace file" (2026-10-19).
#[test]
fn a_workspace_inside_the_repository_reads_and_stages_the_repositorys_paths() {
    let root = repository("nested", 2, 0, 1);
    let nested = root.join("nested");
    std::fs::create_dir_all(&nested).expect("nested workspace");
    let workspace = nested.to_string_lossy().into_owned();

    let review = review_of(&nested);
    assert!(review.repo);
    assert!(!review.clean);
    assert_eq!(review.error, None);
    let paths: Vec<&str> = review
        .unstaged_files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(paths, ["fix-000.txt"]);
    // The patch is read from the top level too: read from the workspace it comes back empty,
    // which is the `+0 -0` a row showed for every file.
    assert_eq!(patch_lines(&review.unstaged_files[0]), (3, 0));
    // The row's path is the repository's, so the root reported beside it is the repository's
    // too: the frontend joins the two to get the file on disk, and joining the workspace
    // instead names a file that does not exist.
    let repository_root = plain_path(
        &root
            .canonicalize()
            .expect("canonical repository")
            .to_string_lossy(),
    );
    assert_eq!(
        review.repository_root.as_deref(),
        Some(repository_root.as_str())
    );
    // Read back by the name the frontend parses (`repositoryRoot`, `api/git.ts`): a rename that
    // drifts from it would leave every row without a file on disk, and nothing would say so.
    let wire = serde_json::to_value(&review).expect("serialize the review");
    assert_eq!(wire["repositoryRoot"], serde_json::json!(repository_root));

    let delta = stage_workspace_files(workspace.clone(), vec!["fix-000.txt".to_owned()])
        .expect("staging a path that lives outside the workspace directory");
    assert_eq!(delta.staged_files.len(), 1);
    assert_eq!(delta.staged_files[0].path, "fix-000.txt");
    assert_eq!(patch_lines(&delta.staged_files[0]), (3, 0));

    // The path is still the workspace's own file, and the refusal for one that escapes the
    // repository still holds.
    assert!(stage_workspace_files(workspace, vec!["../outside.txt".to_owned()]).is_err());

    let _ = std::fs::remove_dir_all(&root);
}

/// A review row can outlive the file it names: an untracked path removed between the read that
/// listed it and the click that stages it is not a reason to refuse the rest of the action.
///
/// `git add` answers a path that matches neither the index nor the worktree with
/// `fatal: pathspec ... did not match any files`, which used to fail the whole chunk - every other
/// row of the same press stayed unstaged for a file that is no longer there (2026-10-30).
#[test]
fn a_vanished_untracked_path_does_not_stop_the_rest_of_a_stage() {
    let root = repository("stage-vanished", 1, 0, 2);
    std::fs::remove_file(root.join("fix-001.txt")).expect("remove the vanished row's file");

    let delta = stage_workspace_files(
        root.to_string_lossy().into_owned(),
        vec!["fix-000.txt".to_owned(), "fix-001.txt".to_owned()],
    )
    .expect("the file that is still there is staged");

    let staged: Vec<&str> = delta
        .staged_files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(staged, ["fix-000.txt"]);
    assert!(delta.unstaged_files.is_empty());

    let _ = std::fs::remove_dir_all(&root);
}

/// A repository whose `notes/` directory is excluded by `.gitignore` while the file inside it was
/// committed first. The review lists the file (ignore rules never apply to a tracked path), and
/// `git add` refuses to name it by pathspec because its directory is excluded.
fn tracked_inside_ignored_directory(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("omp-git-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("notes")).expect("notes directory");
    git(&root, &["init", "--quiet"]);
    git(&root, &["config", "user.email", "omp@example.com"]);
    git(&root, &["config", "user.name", "OMP"]);
    git(&root, &["config", "core.autocrlf", "false"]);
    std::fs::write(root.join("notes/README.md"), body(0, 1)).expect("tracked note");
    git(&root, &["add", "--", "notes/README.md"]);
    git(&root, &["commit", "--quiet", "-m", "note"]);
    std::fs::write(root.join(".gitignore"), "notes/\n").expect("ignore file");
    git(&root, &["add", "--", ".gitignore"]);
    git(&root, &["commit", "--quiet", "-m", "ignore"]);
    std::fs::write(root.join("notes/README.md"), body(0, 2)).expect("changed note");
    root
}

/// A tracked file under an ignored directory is staged by its own path.
///
/// The row is in the review because `git status` lists tracked changes whatever `.gitignore` says,
/// but a bare `git add -- notes/README.md` answers `The following paths are ignored by one of your
/// .gitignore files: notes` and the panel could do nothing with the row it had just drawn
/// (2026-10-31). Ignore rules never apply to a path the index already carries, so the stage forces
/// the check it would otherwise fail.
#[test]
fn a_tracked_file_inside_an_ignored_directory_stages() {
    let root = tracked_inside_ignored_directory("stage-ignored-dir");

    let review = review_of(&root);
    let listed: Vec<&str> = review
        .unstaged_files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(listed, ["notes/README.md"]);

    let delta = stage_workspace_files(
        root.to_string_lossy().into_owned(),
        vec!["notes/README.md".to_owned()],
    )
    .expect("a tracked path is stageable even when its directory is ignored");

    assert_eq!(delta.staged_files.len(), 1);
    assert_eq!(delta.staged_files[0].path, "notes/README.md");
    assert_eq!(patch_lines(&delta.staged_files[0]), (3, 3));
    assert!(delta.unstaged_files.is_empty());

    let _ = std::fs::remove_dir_all(&root);
}

/// The refusal this side prints keeps the subject git puts on the line below the reason: the
/// message names the refused path, not only the kind of failure.
#[test]
fn a_failed_stage_names_the_path_git_refused() {
    let root = tracked_inside_ignored_directory("stage-ignored-message");

    // The command the panel used to run, so the answer is git's own refusal and not a stand-in.
    let output = run_git_diagnosed(
        &root,
        &["add", "--", "notes/README.md"],
        "Unable to stage workspace file",
        "Git command timed out",
    )
    .expect("git ran");
    assert!(!output.status.success(), "the fixture must be refused");

    let error = git_failure("Unable to stage workspace file", &output);
    assert!(
        error.starts_with("Unable to stage workspace file: "),
        "{error}"
    );
    assert!(
        error.contains("ignored by one of your .gitignore files"),
        "{error}"
    );
    assert!(
        error.contains("notes"),
        "git's own line names the path: {error}"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// A rename is staged by its new path, and the old half the panel used to send is dropped rather
/// than refused.
///
/// `git add` itself answers the old path with `fatal: pathspec ... did not match any files` - it is
/// not in the worktree any more - which is why the frontend names only the new path for a stage
/// (`src/src/state/git-review-paths.ts`). A caller that still names both is answered with the
/// rename staged, not with a failed action.
#[test]
fn a_rename_is_staged_by_its_new_path() {
    let root = repository("stage-rename", 1, 0, 0);
    git(&root, &["mv", "mod-000.txt", "moved-000.txt"]);

    let delta = stage_workspace_files(
        root.to_string_lossy().into_owned(),
        vec!["mod-000.txt".to_owned(), "moved-000.txt".to_owned()],
    )
    .expect("the old half is not a stageable path, so only the new half reaches git");
    assert_eq!(delta.staged_files.len(), 1);
    assert_eq!(delta.staged_files[0].path, "moved-000.txt");
    assert_eq!(
        delta.staged_files[0].old_path.as_deref(),
        Some("mod-000.txt")
    );
    assert_eq!(delta.staged_files[0].status, "renamed");

    let _ = std::fs::remove_dir_all(&root);
}

/// A failure names git's own reason, not only this side's sentence: an index held by another
/// process is the one of these that cannot be guessed from the panel.
#[test]
fn a_failed_stage_carries_gits_own_reason() {
    let root = repository("stage-locked", 1, 0, 1);
    std::fs::write(root.join(".git/index.lock"), "").expect("held lock");

    let error = stage_workspace_files(
        root.to_string_lossy().into_owned(),
        vec!["fix-000.txt".to_owned()],
    )
    .err()
    .expect("a held index lock fails the stage");

    assert!(
        error.starts_with("Unable to stage workspace file: "),
        "{error}"
    );
    assert!(error.contains("index.lock"), "{error}");

    let _ = std::fs::remove_dir_all(&root);
}

/// Discarding an unstaged change restores the worktree from the index and leaves the index
/// alone: a file that is also staged keeps the part the discard was not asked to touch.
#[test]
fn discarding_an_unstaged_change_restores_the_worktree_from_the_index() {
    let root = repository("discard-unstaged", 2, 1, 0);
    // mod-000 is staged at revision 2, and this rewrite on top of it is the unstaged change.
    std::fs::write(root.join("mod-000.txt"), body(0, 3)).expect("worktree file");

    let delta = discard_workspace_files(
        root.to_string_lossy().into_owned(),
        vec!["mod-000.txt".to_owned()],
        false,
    )
    .expect("discard");

    assert_eq!(
        std::fs::read_to_string(root.join("mod-000.txt")).expect("worktree file"),
        body(0, 2),
        "the worktree comes back from the index"
    );
    let staged: Vec<&str> = delta
        .staged_files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(staged, ["mod-000.txt"], "the index keeps its staged change");
    assert!(delta.unstaged_files.is_empty());

    let _ = std::fs::remove_dir_all(&root);
}

/// Discarding the staged side of a tracked path returns it to HEAD in both the index and the
/// worktree, so neither side of the review has a change left to report.
#[test]
fn discarding_a_staged_change_returns_the_path_to_head() {
    let root = repository("discard-staged", 2, 1, 0);
    std::fs::write(root.join("mod-000.txt"), body(0, 3)).expect("worktree file");

    let delta = discard_workspace_files(
        root.to_string_lossy().into_owned(),
        vec!["mod-000.txt".to_owned()],
        true,
    )
    .expect("discard");

    assert_eq!(
        std::fs::read_to_string(root.join("mod-000.txt")).expect("worktree file"),
        body(0, 1),
        "the worktree comes back from HEAD"
    );
    assert!(delta.staged_files.is_empty(), "the index comes back too");
    assert!(delta.unstaged_files.is_empty());

    let _ = std::fs::remove_dir_all(&root);
}

/// A path HEAD does not carry is removed from disk, and from the index when it was added to it:
/// nothing else can make an untracked file or a staged-new file read as discarded.
#[test]
fn discarding_an_untracked_or_added_file_removes_it_from_disk() {
    let root = repository("discard-fresh", 1, 0, 1);
    std::fs::write(root.join("added-000.txt"), body(0, 1)).expect("added file");
    git(&root, &["add", "--", "added-000.txt"]);

    let delta = discard_workspace_files(
        root.to_string_lossy().into_owned(),
        vec!["fix-000.txt".to_owned(), "added-000.txt".to_owned()],
        false,
    )
    .expect("discard");

    assert!(
        !root.join("fix-000.txt").exists(),
        "the untracked file is gone"
    );
    assert!(
        !root.join("added-000.txt").exists(),
        "the added file is gone"
    );
    assert!(
        delta.staged_files.is_empty(),
        "the added file left the index"
    );
    assert!(delta.unstaged_files.is_empty());

    let _ = std::fs::remove_dir_all(&root);
}

/// A path that escapes the workspace root is refused before git runs, and the file it names is
/// left where it is.
#[test]
fn discarding_a_path_outside_the_workspace_is_refused() {
    let root = repository("discard-escape", 1, 0, 0);
    let name = format!("omp-git-discard-outside-{}", std::process::id());
    let outside = root.parent().expect("temp directory").join(&name);
    std::fs::write(&outside, body(0, 1)).expect("outside file");

    let error = discard_workspace_files(
        root.to_string_lossy().into_owned(),
        vec![format!("../{name}")],
        false,
    )
    // `WorkspaceReviewDelta` carries no `Debug`, so the refusal is read off the result rather
    // than asserted through `expect_err`.
    .err()
    .expect("a path outside the workspace is refused");

    assert_eq!(error, "Workspace path is invalid");
    assert!(outside.exists(), "the file outside the root is untouched");

    let _ = std::fs::remove_file(&outside);
    let _ = std::fs::remove_dir_all(&root);
}

/// Benchmark: the review of a repository with 120 rewritten (staged) and 20 untracked files,
/// read twice.
///
/// `cargo test -- --ignored --nocapture review_benchmark_over_a_dirty_repository`
#[test]
#[ignore = "benchmark: builds a real repository in the temp directory"]
fn review_benchmark_over_a_dirty_repository() {
    use std::time::Instant;

    let root = repository("bench", 120, 120, 20);
    let root_path = root.to_string_lossy().into_owned();
    // The review runs against the canonical root and its path checks compare against it, so the
    // two arms below read the repository the same way the commands do.
    let canonical_root = std::fs::canonicalize(&root).expect("canonical root");

    process::reset_git_processes();
    let started = Instant::now();
    let cold = get_workspace_review(root_path.clone()).expect("review");
    let cold_ms = started.elapsed().as_millis();
    let cold_processes = process::git_processes();

    process::reset_git_processes();
    let started = Instant::now();
    let hot = get_workspace_review(root_path).expect("review");
    let hot_ms = started.elapsed().as_millis();
    let hot_processes = process::git_processes();

    println!(
        "120 rewritten + 20 untracked: cold {cold_ms} ms / {cold_processes} git processes, \
         hot {hot_ms} ms / {hot_processes} git processes, {} staged + {} unstaged rows, \
         truncated {}",
        cold.staged_files.len(),
        cold.unstaged_files.len(),
        cold.truncated
    );
    assert_eq!(cold.staged_files.len(), 120, "every changed path is listed");
    assert_eq!(cold.unstaged_files.len(), 20);
    assert!(
        !cold.truncated,
        "the list is whole; only patch reads can be cut"
    );
    assert_eq!(hot.staged_files.len(), cold.staged_files.len());
    assert_eq!(hot.unstaged_files.len(), cold.unstaged_files.len());
    assert_eq!(hot_processes, cold_processes);

    // The staged side's two reads on their own: once one after the other, once through the
    // review's own path, which runs them together. Both arms read the same files, so the
    // difference is what the parallelism buys on a repository this size.
    let status = process::run_git(
        &canonical_root,
        &[
            "status",
            "--porcelain=v1",
            "--renames",
            "-z",
            "--untracked-files=all",
        ],
    )
    .expect("status");
    let paths: Vec<String> = cold
        .staged_files
        .iter()
        .map(|file| file.path.clone())
        .collect();
    let started = Instant::now();
    let patch = process::run_git_patch_batch(
        &canonical_root,
        process::PatchSource::Cached,
        Some(&paths),
        false,
    )
    .expect("patch batch");
    let stats = process::run_git_patch_batch(
        &canonical_root,
        process::PatchSource::Cached,
        Some(&paths),
        true,
    )
    .expect("numstat batch");
    let sequential_ms = started.elapsed().as_millis();
    let (staged_changes, _) =
        changed_paths_for_review(&canonical_root, &status.stdout, None).expect("changes");
    assert_eq!(
        staged_changes.len(),
        120,
        "the staged paths have to be attributed before the two arms mean anything"
    );
    let started = Instant::now();
    let (staged, _) = build_review_sides(
        &canonical_root,
        staged_changes,
        Vec::new(),
        UNTRACKED_PATCH_BUDGET,
    );
    let parallel_ms = started.elapsed().as_millis();
    assert!(staged.is_ok(), "the staged side reads");
    println!(
        "staged side alone ({} paths): {sequential_ms} ms one after the other ({} + {} bytes), \
         {parallel_ms} ms through the review",
        paths.len(),
        patch.stdout.len(),
        stats.stdout.len()
    );

    let _ = std::fs::remove_dir_all(&root);
}

//! The remote-facing tests: the branch rows the sidebar draws, the up-stream the row names, and
//! the synchronization that moves commits both ways. They live beside the review tests because
//! they share the fixture (`tests/mod.rs`).

use super::*;

/// Both sides of a branch's drift, and the order sync runs in: a bare origin with two clones,
/// so a commit has to be counted on the side that actually holds it - and the pull that runs
/// before the push has to be what carries the peer's commit in.
#[test]
fn sync_reports_both_sides_of_the_branch_and_pulls_before_it_pushes() {
    let origin = std::env::temp_dir().join(format!("omp-git-origin-{}", std::process::id()));
    let work = std::env::temp_dir().join(format!("omp-git-work-{}", std::process::id()));
    let peer = std::env::temp_dir().join(format!("omp-git-peer-{}", std::process::id()));
    for root in [&origin, &work, &peer] {
        let _ = std::fs::remove_dir_all(root);
    }

    std::fs::create_dir_all(&origin).expect("origin directory");
    git(&origin, &["init", "--bare", "--quiet"]);
    let origin_arg = origin.to_string_lossy().into_owned();
    let work_arg = work.to_string_lossy().into_owned();
    git(&origin, &["clone", "--quiet", &origin_arg, &work_arg]);
    git(&work, &["config", "user.email", "omp@example.com"]);
    git(&work, &["config", "user.name", "OMP"]);
    git(&work, &["config", "core.autocrlf", "false"]);
    std::fs::write(work.join("sync.txt"), "first\n").expect("worktree file");
    git(&work, &["add", "--all"]);
    git(&work, &["commit", "--quiet", "-m", "first"]);
    git(&work, &["push", "--quiet", "-u", "origin", "HEAD"]);

    // A branch that just pushed is level with the upstream it tracks.
    let branch = review_of(&work)
        .branch
        .expect("a clone tracks its upstream");
    assert!(
        branch.upstream.starts_with("origin/"),
        "{}",
        branch.upstream
    );
    assert_eq!((branch.ahead, branch.behind), (0, 0));

    // A commit only this branch has is ahead of the upstream, never behind it.
    std::fs::write(work.join("sync.txt"), "second\n").expect("worktree file");
    git(&work, &["add", "--all"]);
    git(&work, &["commit", "--quiet", "-m", "second"]);
    let branch = review_of(&work).branch.expect("branch");
    assert_eq!((branch.ahead, branch.behind), (1, 0));

    // Sync pushes that commit out, and the upstream catches up to this branch.
    sync_workspace(work_arg.clone()).expect("sync");
    let branch = review_of(&work).branch.expect("branch");
    assert_eq!((branch.ahead, branch.behind), (0, 0));

    // The peer's commit sits on the upstream side until sync pulls it in.
    let peer_arg = peer.to_string_lossy().into_owned();
    git(&origin, &["clone", "--quiet", &origin_arg, &peer_arg]);
    git(&peer, &["config", "user.email", "omp@example.com"]);
    git(&peer, &["config", "user.name", "OMP"]);
    git(&peer, &["config", "core.autocrlf", "false"]);
    std::fs::write(peer.join("peer.txt"), "peer\n").expect("peer file");
    git(&peer, &["add", "--all"]);
    git(&peer, &["commit", "--quiet", "-m", "peer"]);
    git(&peer, &["push", "--quiet", "origin", "HEAD"]);
    git(&work, &["fetch", "--quiet"]);
    let branch = review_of(&work).branch.expect("branch");
    assert_eq!((branch.ahead, branch.behind), (0, 1));

    // Sync fast-forwards onto that commit - only the pull can do it.
    sync_workspace(work_arg).expect("sync");
    let branch = review_of(&work).branch.expect("branch");
    assert_eq!((branch.ahead, branch.behind), (0, 0));

    // A repository git knows but no upstream tracks has no drift to report.
    let plain = repository("branchless", 1, 0, 0);
    assert!(review_of(&plain).branch.is_none());
    let _ = std::fs::remove_dir_all(&plain);

    for root in [&origin, &work, &peer] {
        let _ = std::fs::remove_dir_all(root);
    }
}

/// `.git/FETCH_HEAD` belongs to pulls, not to this app: every git process in the repository
/// appends to it, and `git pull` merges whatever heads it finds there, so a fetch landing between
/// a pull's fetch and its merge handed pull two heads — `fatal: Cannot fast-forward to multiple
/// branches` — and failed the Sync press (measured 2026-11-04: 198 of 400 pulls run beside a
/// concurrent fetch). The fetch that draws the branch row was the writer inside this app.
///
/// Both remote commands therefore leave the file exactly as they found it, and the pull is a merge
/// on the up-stream ref, which no other process can redirect.
#[test]
fn sync_leaves_the_fetch_head_to_the_pulls_run_in_a_terminal() {
    let origin = std::env::temp_dir().join(format!("omp-git-fh-origin-{}", std::process::id()));
    let work = std::env::temp_dir().join(format!("omp-git-fh-work-{}", std::process::id()));
    let peer = std::env::temp_dir().join(format!("omp-git-fh-peer-{}", std::process::id()));
    for root in [&origin, &work, &peer] {
        let _ = std::fs::remove_dir_all(root);
    }

    std::fs::create_dir_all(&origin).expect("origin directory");
    git(&origin, &["init", "--bare", "--quiet"]);
    let origin_arg = origin.to_string_lossy().into_owned();
    let work_arg = work.to_string_lossy().into_owned();
    git(&origin, &["clone", "--quiet", &origin_arg, &work_arg]);
    for setting in [
        ("user.email", "omp@example.com"),
        ("user.name", "OMP"),
        ("core.autocrlf", "false"),
    ] {
        git(&work, &["config", setting.0, setting.1]);
    }
    std::fs::write(work.join("head.txt"), "first\n").expect("worktree file");
    git(&work, &["add", "--all"]);
    git(&work, &["commit", "--quiet", "-m", "first"]);
    git(&work, &["push", "--quiet", "-u", "origin", "HEAD"]);

    // A commit only the peer has, so the sync has something to fast-forward onto.
    let peer_arg = peer.to_string_lossy().into_owned();
    git(&origin, &["clone", "--quiet", &origin_arg, &peer_arg]);
    for setting in [
        ("user.email", "omp@example.com"),
        ("user.name", "OMP"),
        ("core.autocrlf", "false"),
    ] {
        git(&peer, &["config", setting.0, setting.1]);
    }
    std::fs::write(peer.join("peer.txt"), "peer\n").expect("peer file");
    git(&peer, &["add", "--all"]);
    git(&peer, &["commit", "--quiet", "-m", "peer"]);
    git(&peer, &["push", "--quiet", "origin", "HEAD"]);

    // The file a fetch beside a pull leaves behind: another branch's tip, unmarked, so a pull that
    // reads it would have had more than one head to merge.
    let fetch_head = work.join(".git").join("FETCH_HEAD");
    let seeded = format!("{}\t\tbranch 'ghost' of origin\n", "abcdef0123456789");
    std::fs::write(&fetch_head, &seeded).expect("seeded fetch head");

    // The branch row's own fetch is the writer the app owns; it must not touch the file either.
    fetch_remote(&work, "origin").expect("fetch");
    assert_eq!(
        std::fs::read_to_string(&fetch_head).expect("fetch head"),
        seeded,
        "a fetch wrote the file a concurrent pull merges from"
    );

    sync_workspace(work_arg).expect("sync");
    let branch = review_of(&work).branch.expect("branch");
    assert_eq!((branch.ahead, branch.behind), (0, 0));
    assert_eq!(
        std::fs::read_to_string(&fetch_head).expect("fetch head"),
        seeded,
        "the sync rewrote the file a concurrent pull merges from"
    );

    for root in [&origin, &work, &peer] {
        let _ = std::fs::remove_dir_all(root);
    }
}

/// The branch picker's two answers: where HEAD is and what else this repository has, then the
/// switch itself. The picked branch has to be the checked-out one afterwards, which is the only
/// observable effect a reader can see from the sidebar.
#[test]
fn a_branch_is_listed_and_switched_to() {
    let root = repository("branches", 2, 0, 0);
    git(&root, &["branch", "topic"]);

    let listed = get_workspace_branches(root.to_string_lossy().into_owned())
        .expect("branches")
        .expect("a repository");
    let current = listed.current.clone().expect("a checked-out branch");
    assert_eq!(
        listed.repo_name,
        root.file_name().unwrap().to_string_lossy()
    );
    assert_eq!(
        listed
            .branches
            .iter()
            .map(|branch| branch.name.as_str())
            .collect::<Vec<_>>(),
        [current.as_str(), "topic"],
        "the checked-out branch heads the list"
    );
    for branch in &listed.branches {
        assert_eq!(branch.subject, "fixture");
        assert_eq!(branch.current, branch.name == current);
        assert!(branch.updated_at > 0);
    }
    assert!(listed.sync.is_none(), "the fixture has no upstream");

    checkout_workspace_branch(root.to_string_lossy().into_owned(), "topic".to_owned())
        .expect("switch");
    let switched = get_workspace_branches(root.to_string_lossy().into_owned())
        .expect("branches")
        .expect("a repository");
    assert_eq!(switched.current.as_deref(), Some("topic"));

    let failed =
        checkout_workspace_branch(root.to_string_lossy().into_owned(), "missing".to_owned());
    assert!(
        failed.is_err(),
        "a branch the repository does not have is refused"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// A directory that is not inside a working tree has no branches to draw, which is a normal answer
/// and not a failure: the sidebar just has nothing to show.
#[test]
fn a_non_repository_has_no_branches() {
    let root = std::env::temp_dir().join(format!("omp-git-plain-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("plain directory");

    assert!(get_workspace_branches(root.to_string_lossy().into_owned())
        .expect("no repository is not a failure")
        .is_none());

    let _ = std::fs::remove_dir_all(&root);
}

/// The wire shape the sidebar reads: the renames are the contract between this answer and
/// `src/api/git.ts`, and a field that stops being renamed would leave the picker blank rather than
/// fail a type check on either side.
#[test]
fn the_branch_answer_uses_the_frontend_field_names() {
    let answer = WorkspaceBranches {
        repo_name: "repo".to_owned(),
        current: None,
        detached_at: Some("abc1234".to_owned()),
        sync: None,
        branches: vec![RepositoryBranch {
            name: "topic".to_owned(),
            updated_at: 1,
            subject: "fixture".to_owned(),
            author: "OMP".to_owned(),
            current: true,
        }],
    };
    let value = serde_json::to_value(answer).expect("json");

    assert_eq!(value["repoName"], "repo");
    assert!(value.get("current").is_none(), "a detached HEAD omits it");
    assert_eq!(value["detachedAt"], "abc1234");
    assert_eq!(value["branches"][0]["updatedAt"], 1);
    assert_eq!(value["branches"][0]["current"], true);
}

/// The gate that keeps the branch row from asking the network once per ref report it causes: one
/// repository per interval, another repository its own door, and an answer that expires so the table
/// only ever holds what was looked at recently.
#[test]
fn a_repository_asks_its_remote_once_an_interval() {
    let gate = FetchGate::default();
    let first = Path::new("D:/project/one");
    let second = Path::new("D:/project/two");
    let start = Instant::now();

    assert!(gate.claim(first, start), "the first look asks the remote");
    assert!(
        !gate.claim(first, start + FETCH_INTERVAL - Duration::from_millis(1)),
        "a look inside the interval is the same look"
    );
    assert!(
        gate.claim(second, start),
        "another repository is not held back by the first"
    );
    assert!(
        gate.claim(first, start + FETCH_INTERVAL),
        "an expired answer is asked for again"
    );
    assert_eq!(
        gate.asked.lock().expect("gate").len(),
        1,
        "an expired root is dropped, so the table only holds what is inside the interval"
    );
    assert!(
        gate.claim(second, start + FETCH_INTERVAL),
        "the dropped root is asked for again like any other"
    );
}

/// The remote a fetch is aimed at: the configured name the up-stream starts with. A name that
/// merely starts the same (`fork` against `forker/main`) is not it.
#[test]
fn the_fetched_remote_is_the_one_the_upstream_names() {
    let root = repository("fetch-remote", 1, 0, 0);
    git(
        &root,
        &["remote", "add", "fork", "https://example.invalid/fork.git"],
    );
    git(
        &root,
        &[
            "remote",
            "add",
            "forker",
            "https://example.invalid/forker.git",
        ],
    );

    assert_eq!(upstream_remote(&root, "fork/main").as_deref(), Some("fork"));
    assert_eq!(
        upstream_remote(&root, "fork/feature/one").as_deref(),
        Some("fork"),
        "a branch name's own slash is not the remote's"
    );
    assert_eq!(
        upstream_remote(&root, "elsewhere/main"),
        None,
        "an up-stream no remote owns is not guessed at"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// What the row's own fetch is worth: the peer's commit sits on the upstream side, the local counts
/// only see it once the remote was asked for its refs - which is the whole reason the row asks.
#[test]
fn fetching_the_remote_brings_its_commits_into_the_count() {
    let origin = std::env::temp_dir().join(format!("omp-git-fetch-origin-{}", std::process::id()));
    let work = std::env::temp_dir().join(format!("omp-git-fetch-work-{}", std::process::id()));
    let peer = std::env::temp_dir().join(format!("omp-git-fetch-peer-{}", std::process::id()));
    for root in [&origin, &work, &peer] {
        let _ = std::fs::remove_dir_all(root);
    }

    std::fs::create_dir_all(&origin).expect("origin directory");
    git(&origin, &["init", "--bare", "--quiet"]);
    let origin_arg = origin.to_string_lossy().into_owned();
    let work_arg = work.to_string_lossy().into_owned();
    let peer_arg = peer.to_string_lossy().into_owned();
    git(&origin, &["clone", "--quiet", &origin_arg, &work_arg]);
    git(&work, &["config", "user.email", "omp@example.com"]);
    git(&work, &["config", "user.name", "OMP"]);
    git(&work, &["config", "core.autocrlf", "false"]);
    std::fs::write(work.join("shared.txt"), "first\n").expect("worktree file");
    git(&work, &["add", "--all"]);
    git(&work, &["commit", "--quiet", "-m", "first"]);
    git(&work, &["push", "--quiet", "-u", "origin", "HEAD"]);

    // The peer clones what the remote holds, so its own commit sits on top of it.
    git(&origin, &["clone", "--quiet", &origin_arg, &peer_arg]);
    git(&peer, &["config", "user.email", "omp@example.com"]);
    git(&peer, &["config", "user.name", "OMP"]);
    git(&peer, &["config", "core.autocrlf", "false"]);
    std::fs::write(peer.join("peer.txt"), "peer\n").expect("peer file");
    git(&peer, &["add", "--all"]);
    git(&peer, &["commit", "--quiet", "-m", "peer"]);
    git(&peer, &["push", "--quiet", "origin", "HEAD"]);

    // The remote moved; nothing local knows it yet, which is the stale zero the row used to show.
    let stale = read_branch_sync(&work).expect("a clone tracks its upstream");
    assert_eq!((stale.ahead, stale.behind), (0, 0));

    // Opening the row is what asks: this answer is still the stale one, and the remote command it
    // started lands on its own thread.
    let opened = get_workspace_branches(work.to_string_lossy().into_owned())
        .expect("branches")
        .expect("a repository");
    let opened = opened.sync.expect("a clone tracks its upstream");
    assert_eq!((opened.ahead, opened.behind), (0, 0));

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut fresh = read_branch_sync(&work).expect("a clone tracks its upstream");
    while (fresh.ahead, fresh.behind) == (0, 0) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
        fresh = read_branch_sync(&work).expect("a clone tracks its upstream");
    }
    assert_eq!(
        (fresh.ahead, fresh.behind),
        (0, 1),
        "the peer's commit is counted once the row's own fetch answered"
    );

    for root in [&origin, &work, &peer] {
        let _ = std::fs::remove_dir_all(root);
    }
}

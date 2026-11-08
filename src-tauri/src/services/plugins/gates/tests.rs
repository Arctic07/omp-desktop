use super::*;

#[test]
fn a_star_matches_inside_one_segment_and_double_star_matches_any_depth() {
    assert!(scope_matches("desktop/**", "desktop/panel/index.html"));
    assert!(scope_matches("desktop/**", "desktop/a"));
    assert!(!scope_matches("desktop/**", "desktop"));
    assert!(!scope_matches("desktop/**", "desktopfile"));
    assert!(scope_matches("docs/*.md", "docs/readme.md"));
    assert!(!scope_matches("docs/*.md", "docs/nested/readme.md"));
    assert!(scope_matches("**/*.json", "a/b/c.json"));
    assert!(scope_matches("**", "anything/at/all.txt"));
    assert!(scope_matches("a/**/b.txt", "a/x/y/b.txt"));
    assert!(
        !scope_matches("a/**/b.txt", "a/b.txt"),
        "** is one or more segments, not zero"
    );
    assert!(scope_matches("assets/*", "assets/logo"));
}

/// A star beside a multi-byte name is matched by cutting the *characters*, never the bytes.
///
/// This is the input the first version of the matcher panicked on: `a*` against `文档.md` took the
/// byte offset of `a` (1) and split the string there, which is inside `文` - a panic in the protocol
/// handler thread, so the page's call never came back at all. The cases below are the ones a
/// byte-wise walk gets wrong in either direction.
#[test]
fn a_star_beside_a_multi_byte_name_is_matched_by_character() {
    assert!(
        !scope_matches("a*", "文档.md"),
        "a literal prefix that is not there is not a match"
    );
    assert!(scope_matches("*.md", "文档.md"));
    assert!(scope_matches("文*", "文档.md"));
    assert!(scope_matches("*档*", "文档.md"));
    assert!(scope_matches("*", "文档.md"));
    assert!(!scope_matches("b*", "文档.md"));
    assert!(scope_matches("**", "文档/说明.txt"));
    assert!(scope_matches("文档/**", "文档/说明.txt"));
    assert!(
        !scope_matches("文档/**", "文档"),
        "** is one or more whole segments"
    );
}

#[test]
fn scope_patterns_the_two_sides_could_read_differently_are_refused() {
    assert!(validate_scope_pattern("desktop/**"));
    assert!(validate_scope_pattern("README.md"));
    assert!(validate_scope_pattern("a/*/b"));
    assert!(validate_scope_pattern("a*b"));
    assert!(validate_scope_pattern("**"));
    assert!(
        !validate_scope_pattern("a/*/b?"),
        "? is a wildcard this matcher does not have"
    );
    assert!(
        !validate_scope_pattern("desktop/panel**"),
        "a star inside a segment may not double"
    );
    assert!(!validate_scope_pattern("../escape"));
    assert!(!validate_scope_pattern("/absolute"));
    assert!(!validate_scope_pattern("trailing/"));
    assert!(!validate_scope_pattern(""));
    assert!(!validate_scope_pattern("a//b"));
    assert!(!validate_scope_pattern("a/{b,c}"));
    assert!(!validate_scope_pattern("a/b\u{7}"));
    assert!(!validate_scope_pattern(&"x".repeat(SCOPE_PATTERN_MAX + 1)));
    // The bound counts characters, as the host's does: 100 CJK characters are 100, not 300.
    assert!(validate_scope_pattern(&"文".repeat(100)));
    assert!(!validate_scope_pattern(&"文".repeat(SCOPE_PATTERN_MAX + 1)));
    assert!(!validate_scope_pattern(&format!(
        "a/{}",
        vec!["b"; SCOPE_SEGMENTS_MAX].join("/")
    )));
}

#[test]
fn the_reject_table_covers_credentials_and_private_directories_at_any_depth() {
    assert!(is_rejected_path(".env"));
    assert!(is_rejected_path("nested/.env.local"));
    assert!(is_rejected_path("id_rsa"));
    assert!(is_rejected_path("keys/id_rsa.pub"));
    assert!(is_rejected_path("certs/server.pem"));
    assert!(is_rejected_path(".git/config"));
    assert!(is_rejected_path("a/.ssh/known_hosts"));
    assert!(is_rejected_path("deep/.docker/config.json"));
    assert!(!is_rejected_path("desktop/panel/index.html"));
    assert!(
        !is_rejected_path(".gitignore"),
        "the table names the directory, not the file"
    );
    assert!(!is_rejected_path("docs/environment.md"));
}

/// Only a read scope may name a whole tree: the same four patterns are refused for the two modes
/// that change what is on disk (spec §3.2), and both sides refuse the same list.
#[test]
fn a_whole_tree_scope_is_a_read_only_reach() {
    for pattern in ["**", "**/*", "*/**", "./*"] {
        assert!(is_whole_tree_scope(pattern), "{pattern}");
    }
    // Three of the four are patterns both sides read; `./*` is refused as a *pattern* before the
    // whole-tree rule is even reached (a `.` segment is not a path this build resolves), which is
    // the stronger answer and the one the host gives too.
    for pattern in ["**", "**/*", "*/**"] {
        assert!(validate_scope_pattern(pattern), "{pattern}");
    }
    assert!(!validate_scope_pattern("./*"));
    for pattern in ["docs/**", "**/docs", "src/*.ts", "notes.md"] {
        assert!(!is_whole_tree_scope(pattern), "{pattern}");
    }
}

/// The delete brake counts per installation, allows a burst and then refuses, and forgets one
/// installation without touching another's count.
#[test]
fn the_delete_brake_counts_per_installation() {
    let budget = DeleteBudget::new();
    for index in 0..DELETES_PER_WINDOW {
        assert!(budget.take("key-a"), "delete {index} is inside the window");
    }
    assert!(!budget.take("key-a"), "the burst is over");
    assert!(
        budget.take("key-b"),
        "another installation has its own count"
    );
    budget.forget("key-a");
    assert!(
        budget.take("key-a"),
        "forgetting an installation clears its count"
    );
}

/// A page with a workspace resolves against it first and against its own package second: a plugin
/// reads the user's project, and can still read what it ships. A name neither has is the workspace's
/// answer, because the workspace is the root the page is working in.
#[test]
fn the_workspace_is_the_first_root_and_the_package_the_second() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let unique = NEXT.fetch_add(1, Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!("omp-roots-test-{}-{unique}", std::process::id()));
    let plugin = base.join("plugin");
    let workspace = base.join("workspace");
    for root in [&plugin, &workspace] {
        std::fs::create_dir_all(root.join("docs")).expect("a fixture directory");
    }
    std::fs::write(plugin.join("docs/readme.md"), "plugin").expect("a fixture file");
    std::fs::write(plugin.join("only-here.md"), "packaged").expect("a fixture file");
    std::fs::write(workspace.join("docs/readme.md"), "workspace").expect("a fixture file");

    let roots = FsRoots {
        workspace: Some(workspace.clone()),
        plugin: plugin.clone(),
    };
    assert_eq!(
        std::fs::read_to_string(
            roots
                .resolve("docs/readme.md", FsMode::Read)
                .expect("resolved")
        )
        .expect("readable"),
        "workspace",
        "a name both roots have is the user's file"
    );
    assert_eq!(
        std::fs::read_to_string(
            roots
                .resolve("only-here.md", FsMode::Read)
                .expect("resolved")
        )
        .expect("readable"),
        "packaged",
        "the installation's own package answers for what only it has"
    );
    assert_eq!(
        roots.resolve("nope.md", FsMode::Read),
        Err(ReadRefusal::NotFound),
        "neither root has it"
    );
    assert_eq!(
        roots.resolve("../escape.md", FsMode::Read),
        Err(ReadRefusal::Relative),
        "the shape gate is the same for both roots"
    );

    let alone = FsRoots {
        workspace: None,
        plugin: plugin.clone(),
    };
    assert!(alone.resolve("only-here.md", FsMode::Read).is_ok());
    assert!(alone.resolve("docs/readme.md", FsMode::Read).is_ok());

    let _ = std::fs::remove_dir_all(&base);
}

/// `fs.anyPath`: the unrestricted resolver has no root, no reject table and no shape gate, and the
/// answers it still gives are the ones about the file rather than about a permission.
#[test]
fn an_unrestricted_path_reaches_anywhere_and_still_reports_what_is_there() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let unique = NEXT.fetch_add(1, Ordering::Relaxed);
    let base =
        std::env::temp_dir().join(format!("omp-anypath-test-{}-{unique}", std::process::id()));
    let plugin = base.join("plugin");
    let outside = base.join("elsewhere");
    for root in [&plugin, &outside] {
        std::fs::create_dir_all(root).expect("a fixture directory");
    }
    std::fs::write(plugin.join("inside.md"), "inside").expect("a fixture file");
    std::fs::write(outside.join("outside.md"), "outside").expect("a fixture file");
    std::fs::write(outside.join(".env"), "TOKEN=1").expect("a credential file");

    // A relative name resolves against the package, which is the one directory a plugin can name
    // without knowing where it was installed.
    assert!(resolve_any(&plugin, "inside.md", FsMode::Read).is_ok());
    // An absolute name outside the package is the whole point of the permission.
    let reachable = outside.join("outside.md");
    assert_eq!(
        std::fs::read_to_string(
            resolve_any(&plugin, reachable.to_str().expect("utf8"), FsMode::Read)
                .expect("resolved")
        )
        .expect("readable"),
        "outside"
    );
    // The reject table is not consulted: with the whole disk declared, a credential file is a file
    // like any other. That is what the permission means, and the consent copy says so.
    assert!(resolve_any(
        &plugin,
        outside.join(".env").to_str().expect("utf8"),
        FsMode::Read
    )
    .is_ok());
    // What is not there is still `NotFound`, and a write still needs a directory to land in.
    assert_eq!(
        resolve_any(&plugin, "missing.md", FsMode::Read),
        Err(ReadRefusal::NotFound)
    );
    assert_eq!(
        resolve_any(&plugin, "no/such/dir/file.md", FsMode::Write),
        Err(ReadRefusal::NotFound)
    );
    // A write names a file, so a directory is not one - the same answer the rooted resolver gives.
    assert_eq!(
        resolve_any(&plugin, outside.to_str().expect("utf8"), FsMode::Write),
        Err(ReadRefusal::NotFound)
    );
    assert_eq!(
        resolve_any(&plugin, "   ", FsMode::Read),
        Err(ReadRefusal::Relative)
    );

    let _ = std::fs::remove_dir_all(&base);
}

/// An inspection names a directory, a read does not: the two share every gate and differ in exactly
/// one answer.
#[test]
fn an_inspection_answers_with_a_directory_where_a_read_says_not_found() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let unique = NEXT.fetch_add(1, Ordering::Relaxed);
    let root =
        std::env::temp_dir().join(format!("omp-inspect-test-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(root.join("docs")).expect("a fixture directory");
    std::fs::create_dir_all(root.join(".ssh")).expect("a private directory");
    std::fs::write(root.join("docs/readme.md"), "hello").expect("a fixture file");
    std::fs::write(root.join(".ssh/known_hosts"), "host").expect("a private file");

    assert!(resolve_read(&root, "docs").is_err(), "a read names a file");
    assert!(
        resolve_inspect(&root, "docs").is_ok(),
        "an inspection may name one"
    );
    // Everything else is the same gate, including the shape rule and the reject table - the second
    // applied to the *requested* name and again to what it resolved to, so a listing of a private
    // directory is refused exactly as a read of a file inside it is.
    assert_eq!(
        resolve_inspect(&root, "../escape"),
        Err(ReadRefusal::Relative)
    );
    assert_eq!(resolve_inspect(&root, "nope"), Err(ReadRefusal::NotFound));
    assert_eq!(
        resolve_inspect(&root, ".ssh"),
        Err(ReadRefusal::DeniedByPolicy)
    );
    assert_eq!(
        resolve_inspect(&root, ".ssh/known_hosts"),
        Err(ReadRefusal::DeniedByPolicy)
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn session_grants_are_per_installation_and_forgotten_with_it() {
    let grants = SessionGrants::new();
    let read = SessionGrant::Read("/tmp/demo.txt".to_owned());
    assert!(!grants.holds("key-a", &read));
    grants.remember("key-a", read.clone());
    assert!(grants.holds("key-a", &read));
    assert!(
        !grants.holds("key-b", &read),
        "one installation's answer is not another's"
    );
    grants.remember("key-a", SessionGrant::Clipboard("read"));
    assert!(grants.holds("key-a", &SessionGrant::Clipboard("read")));
    assert!(!grants.holds("key-a", &SessionGrant::Clipboard("write")));
    grants.forget("key-a");
    assert!(!grants.holds("key-a", &read));
    assert!(!grants.holds("key-a", &SessionGrant::Clipboard("read")));
    assert_eq!(grants.len(), 0);
}

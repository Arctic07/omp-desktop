use super::*;

/// One throwaway directory tree, removed when the test that owns it ends.
struct Tree {
    root: PathBuf,
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl Tree {
    /// A fresh directory under the process's own temporary directory, with a unique name.
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "omp-glob-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&root).expect("a temporary directory");
        Self { root }
    }

    fn file(&self, relative: &str) -> PathBuf {
        let path = self
            .root
            .join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("a parent directory");
        std::fs::write(&path, b"x").expect("a file");
        path
    }
}

/// One plan, or a panic naming the pattern that was supposed to be readable.
fn planned(pattern: &str, allow_absolute: bool) -> GlobPlan {
    plan(pattern, allow_absolute).unwrap_or_else(|| panic!("{pattern} should be a pattern"))
}

/// Every hit one walk found, as `(path, directory)` pairs in the walk's own order.
fn hits(tree: &Tree, pattern: &str) -> (Vec<(String, bool)>, bool) {
    let plan = planned(pattern, false);
    let base = if plan.base.is_empty() {
        tree.root.clone()
    } else {
        tree.root
            .join(plan.base.replace('/', std::path::MAIN_SEPARATOR_STR))
    };
    let mut out = Vec::new();
    let truncated = walk(&base, &plan.pattern, true, &mut out);
    out.sort_by(|left, right| left.relative.cmp(&right.relative));
    (
        out.into_iter()
            .map(|hit| (hit.relative, hit.directory))
            .collect(),
        truncated,
    )
}

#[test]
fn a_star_stays_inside_one_segment_and_double_star_descends() {
    let tree = Tree::new("stars");
    tree.file("src/main.rs");
    tree.file("src/lib.rs");
    tree.file("src/nested/deep.rs");
    tree.file("readme.md");

    assert_eq!(
        hits(&tree, "src/*.rs").0,
        vec![("lib.rs".to_owned(), false), ("main.rs".to_owned(), false),],
        "a star matches inside one segment only"
    );
    assert_eq!(
        hits(&tree, "src/**/*.rs").0,
        vec![("nested/deep.rs".to_owned(), false)],
        "** is one or more whole segments, the rule the scope language uses"
    );
    assert_eq!(
        hits(&tree, "**/*.rs").0,
        vec![
            ("src/lib.rs".to_owned(), false),
            ("src/main.rs".to_owned(), false),
            ("src/nested/deep.rs".to_owned(), false),
        ]
    );
    assert_eq!(hits(&tree, "*.md").0, vec![("readme.md".to_owned(), false)]);
}

#[test]
fn the_reject_table_stops_the_walk_at_a_credential_directory() {
    let tree = Tree::new("rejected");
    tree.file("src/main.rs");
    tree.file(".git/config");
    tree.file(".env");
    tree.file("keys/id_rsa");

    let (found, _) = hits(&tree, "**");
    assert_eq!(
        found,
        vec![
            ("keys".to_owned(), true),
            ("src".to_owned(), true),
            ("src/main.rs".to_owned(), false),
        ],
        "a rejected name is never a hit and is never descended into"
    );
}

/// The one reading of `fs.anyPath`: the table the resolver drops for an unrestricted installation is
/// dropped here too, because a plugin that may open `.env` must be able to see that it is there. A
/// walk that hid those names would be a second, narrower gate behind the permission.
#[test]
fn an_unrestricted_walk_is_not_stopped_by_the_reject_table() {
    let tree = Tree::new("unrestricted");
    tree.file("src/main.rs");
    tree.file(".git/config");
    tree.file(".env");
    tree.file("keys/id_rsa");

    let plan = planned("**", false);
    let mut out = Vec::new();
    let truncated = walk(&tree.root, &plan.pattern, false, &mut out);
    out.sort_by(|left, right| left.relative.cmp(&right.relative));
    let found: Vec<&str> = out.iter().map(|hit| hit.relative.as_str()).collect();
    assert!(!truncated);
    assert_eq!(
        found,
        vec![
            ".env",
            ".git",
            ".git/config",
            "keys",
            "keys/id_rsa",
            "src",
            "src/main.rs",
        ],
        "the reach an unrestricted installation declared covers these names"
    );
}

#[test]
fn a_symbolic_link_is_neither_followed_nor_reported() {
    let tree = Tree::new("links");
    tree.file("real/file.txt");
    let link = tree.root.join("link.txt");
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(tree.root.join("real"), &link).is_ok();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_dir(tree.root.join("real"), &link).is_ok();
    if !linked {
        // A platform that will not make a link (an unprivileged Windows account) cannot exercise
        // this rule; the walker's check is the same line either way.
        return;
    }

    let (found, _) = hits(&tree, "**");
    assert_eq!(
        found,
        vec![
            ("real".to_owned(), true),
            ("real/file.txt".to_owned(), false),
        ]
    );
}

#[test]
fn the_entry_ceiling_marks_the_answer_truncated_instead_of_refusing_it() {
    let tree = Tree::new("entries");
    for index in 0..(MAX_GLOB_ENTRIES + 8) {
        tree.file(&format!("many/file-{index:04}.txt"));
    }

    let (found, truncated) = hits(&tree, "many/*.txt");
    assert_eq!(found.len(), MAX_GLOB_ENTRIES);
    assert!(truncated, "hitting a ceiling is marked, not raised");
}

#[test]
fn the_depth_ceiling_marks_the_answer_truncated() {
    let tree = Tree::new("depth");
    let deep = format!("{}leaf.txt", "d/".repeat(MAX_GLOB_DEPTH + 2));
    tree.file(&deep);

    let (found, truncated) = hits(&tree, "**/*.txt");
    assert!(found.is_empty(), "the leaf is below the depth ceiling");
    assert!(truncated);
}

#[test]
fn a_pattern_outside_the_scope_language_is_not_a_pattern() {
    assert!(plan("", false).is_none());
    assert!(plan("   ", false).is_none());
    assert!(plan("src/*.rs", false).is_some());
    assert!(plan("**", false).is_some());
    assert!(
        plan("/etc/**", false).is_none(),
        "an absolute pattern is a name a scoped installation has no reading for"
    );
    assert!(plan("/etc/**", true).is_some());
    assert!(plan("C:/Users/**", true).is_some());
    assert!(
        plan("C:/Users/**", false).is_none(),
        "a drive-qualified pattern is only a pattern for an unrestricted installation"
    );
    for refused in [
        "src/a?.rs",
        "src/[ab].rs",
        "src/{a,b}.rs",
        "src/../escape",
        "src/",
    ] {
        assert!(plan(refused, false).is_none(), "{refused} is refused");
    }
}

#[test]
fn the_plan_keeps_the_last_literal_segment_in_the_pattern() {
    let plan = planned("src/a*.rs", false);
    assert_eq!(plan.base, "src");
    assert_eq!(plan.pattern, "a*.rs");
    let plan = planned("src/readme.md", false);
    assert_eq!(plan.base, "src");
    assert_eq!(
        plan.pattern, "readme.md",
        "a pattern that names one file is a match against that name"
    );
    let plan = planned("readme.md", false);
    assert_eq!(plan.base, "");
    assert_eq!(plan.pattern, "readme.md");
    let plan = planned("**/*.rs", false);
    assert_eq!(plan.base, "");
    assert_eq!(plan.pattern, "**/*.rs");
    let plan = planned("/home/me/**", true);
    assert_eq!(plan.prefix.as_deref(), Some("/"));
    assert_eq!(plan.base, "home/me");
    assert_eq!(plan.pattern, "**");
    let plan = planned("C:/Users/me/**", true);
    assert_eq!(plan.prefix.as_deref(), Some("C:/"));
    assert_eq!(plan.base, "Users/me");
    assert_eq!(plan.pattern, "**");
}

#[test]
fn a_hit_keeps_the_callers_own_spelling() {
    let plan = planned("src/*.rs", false);
    assert_eq!(join(&plan, "main.rs"), "src/main.rs");
    let plan = planned("**", false);
    assert_eq!(join(&plan, "deep/file.txt"), "deep/file.txt");
    let plan = planned("/home/me/**", true);
    assert_eq!(join(&plan, "file.txt"), "/home/me/file.txt");
    let plan = planned("C:/Users/**", true);
    assert_eq!(join(&plan, "me.txt"), "C:/Users/me.txt");
}

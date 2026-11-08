//! Bridge tests: the reach a plugin can *use*
//!
//! `fs.glob`, `fs.readRange`, `fs.openDefault` and `fs.reveal`, split from `files.rs` by theme so no
//! file in this tree grows past the engineering limit (`rules.md#single-file-line-limit`). Every
//! helper the tests use lives in `super`.

use super::*;

/// One call with a body, from the method name and its parameters.
fn call(method: &str, params: serde_json::Value) -> BridgeCall {
    BridgeCall::Body(serde_json::to_vec(&json!({ "m": method, "params": params })).expect("a body"))
}

/// A fixture package with the tree a pattern can walk: two levels, a file at each, and a credential
/// directory the reject table has to stop the walk at.
fn tree_package() -> (Package, PluginPage) {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let unique = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "omp-glob-gate-test-{}-{unique}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    for (path, text) in [
        ("docs/readme.md", "root"),
        ("docs/guide/intro.md", "deep"),
        ("docs/guide/notes.txt", "deep"),
        ("secret.txt", "outside"),
        (".env", "TOKEN=1"),
        (".git/config", "[core]"),
    ] {
        let file = root.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
        std::fs::create_dir_all(file.parent().expect("a parent")).expect("a directory");
        std::fs::write(&file, text).expect("a file");
    }
    let page = page(&root, &["fs.read"], &["docs/**"]);
    (Package { root }, page)
}

/// One path as the resolvers hand it on: canonical, which on Windows is the verbatim form.
fn canonical(path: PathBuf) -> String {
    std::fs::canonicalize(&path)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

/// The paths one `fs.glob` answer carries, in the order it carries them.
fn glob_paths(value: &Value) -> Vec<String> {
    value["result"]["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|entry| entry["path"].as_str().expect("a path").to_owned())
        .collect()
}

/// `fs.glob` is the read gate's reach: the same permission, the same scope question, and a walk that
/// stops at the reject table. The pattern language is the manifest's own, which is why a `**` under
/// `docs/**` is a match and a `?` is not a pattern at all.
#[test]
fn a_glob_walks_the_scope_and_stops_at_the_reject_table() {
    let (_package, page) = tree_package();
    let mut effects = Nobody::default();

    let listed = answer(
        &page,
        &test_roots(&page),
        &call("fs.glob", json!({ "pattern": "docs/**" })),
        &mut effects,
    )
    .expect("inside the scope runs");
    assert_eq!(
        glob_paths(&listed),
        vec![
            "docs/guide".to_owned(),
            "docs/guide/intro.md".to_owned(),
            "docs/guide/notes.txt".to_owned(),
            "docs/readme.md".to_owned(),
        ],
        "sorted by path, so two identical calls answer identically"
    );
    assert_eq!(listed["result"]["truncated"], json!(false));
    assert_eq!(listed["result"]["pattern"], json!("docs/**"));
    assert!(
        effects.asked.is_empty(),
        "a pattern inside the declared scope is not a question"
    );

    // The reject table covers a scoped installation's own scope: a walk that reached `.git` would
    // hand out a repository's own configuration under a name nobody would look for.
    let whole_scope = page_with(&page, &["fs.read"], &["**"]);
    let scoped = answer(
        &whole_scope,
        &test_roots(&whole_scope),
        &call("fs.glob", json!({ "pattern": "**" })),
        &mut effects,
    )
    .expect("a scope that names everything is a standing reach");
    let paths = glob_paths(&scoped);
    assert!(
        paths.iter().all(|path| !path.contains(".git")),
        "{paths:?} must not name a rejected path"
    );
    assert!(paths.iter().any(|path| path == "secret.txt"));

    // Under `fs.anyPath` the table is dropped here exactly as the resolver in front of a read drops
    // it: one widening, one reading, so the names it covers are names this installation can already
    // open - and a walk that hid them would be a second, narrower gate behind the permission.
    let everything = answer(
        &page_with(&page, &["fs.read", "fs.anyPath"], &[]),
        &test_roots(&page),
        &call("fs.glob", json!({ "pattern": "**" })),
        &mut effects,
    )
    .expect("the widening runs");
    let paths = glob_paths(&everything);
    assert!(
        paths.iter().any(|path| path == ".git/config") && paths.iter().any(|path| path == ".env"),
        "{paths:?} must name what the same installation may read"
    );
    assert!(paths.iter().any(|path| path == "secret.txt"));

    // A pattern outside the declared scope is the user's question, exactly as a read outside it is.
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &call("fs.glob", json!({ "pattern": "**" })),
            &mut effects
        )),
        OUT_OF_SCOPE
    );
    assert_eq!(
        effects.asked.last().expect("a question").1,
        "**",
        "the question names the pattern the caller wrote"
    );
    assert_eq!(
        effects.asked.last().expect("a question").0,
        PromptKind::ReadOutOfScope,
        "a glob outside the declared scope is the read gate's own question"
    );

    // A pattern this language does not have is not a pattern.
    for refused in ["docs/*.md?", "docs/{a,b}", "no-such-dir/**"] {
        let judged = refusal(answer(
            &page,
            &test_roots(&page),
            &call("fs.glob", json!({ "pattern": refused })),
            &mut effects,
        ));
        assert!(
            judged == INVALID_REQUEST || judged == NOT_FOUND,
            "{refused} is refused before the walk, got {judged:?}"
        );
    }
}

/// An absolute pattern is the name an unrestricted installation may write, and the location it names
/// is where the walk starts - not a path below the plugin's own package, which is where a *relative*
/// name resolves, and not a set of paths spelled one way and walked another.
#[test]
fn a_glob_over_an_absolute_pattern_starts_where_the_pattern_says() {
    let (_package, page) = tree_package();
    let mut effects = Nobody::default();
    let unrestricted = page_with(&page, &["fs.read", "fs.anyPath"], &[]);
    // The fixture's own directory, spelled the way a pattern is spelled. A profile path the pattern
    // language cannot carry (a character it forbids) cannot exercise this rule; the language itself
    // is pinned in `glob::tests`, and this test is about where the walk starts.
    let base = page.root.to_string_lossy().replace('\\', "/");
    if crate::services::plugins::glob::plan(&format!("{base}/docs/**"), true).is_none() {
        return;
    }

    let walked = answer(
        &unrestricted,
        &test_roots(&unrestricted),
        &call("fs.glob", json!({ "pattern": format!("{base}/docs/**") })),
        &mut effects,
    )
    .expect("an absolute pattern is a name this installation has a reading for");
    assert_eq!(
        glob_paths(&walked),
        vec![
            format!("{base}/docs/guide"),
            format!("{base}/docs/guide/intro.md"),
            format!("{base}/docs/guide/notes.txt"),
            format!("{base}/docs/readme.md"),
        ],
        "every hit is spelled the way the pattern asked, and the walk starts where the prefix points"
    );
    assert_eq!(walked["result"]["truncated"], json!(false));
    assert!(
        effects.asked.is_empty(),
        "an installation that declared the whole disk is asked about nothing"
    );
}

/// The glob gate answers the *permission* before anything else, and a missing one is not a question.
#[test]
fn a_glob_without_the_permission_is_denied_rather_than_asked_about() {
    let (_package, page) = tree_package();
    let mut effects = Nobody::default();
    let without = page_with(&page, &[], &["docs/**"]);
    assert_eq!(
        refusal(answer(
            &without,
            &test_roots(&without),
            &call("fs.glob", json!({ "pattern": "docs/**" })),
            &mut effects
        )),
        PERMISSION_DENIED
    );
    assert!(effects.asked.is_empty());
}

/// A walk that hits a ceiling answers what it found, marked, rather than refusing: half a listing is
/// still an answer to "what is under here", which is the rule `fs.list` already follows.
#[test]
fn a_glob_over_a_ceiling_is_marked_rather_than_refused() {
    let (_package, page) = tree_package();
    let mut effects = Nobody::default();
    let root = page.root.clone();
    for index in 0..(crate::services::plugins::glob::MAX_GLOB_ENTRIES + 4) {
        std::fs::write(root.join(format!("docs/many-{index:04}.md")), "x").expect("a file");
    }
    let listed = answer(
        &page,
        &test_roots(&page),
        &call("fs.glob", json!({ "pattern": "docs/*.md" })),
        &mut effects,
    )
    .expect("the walk runs");
    assert_eq!(
        listed["result"]["entries"]
            .as_array()
            .expect("entries")
            .len(),
        crate::services::plugins::glob::MAX_GLOB_ENTRIES
    );
    assert_eq!(
        listed["result"]["truncated"],
        json!(true),
        "the ceiling is marked, not raised"
    );
}

/// `fs.readRange` reads through the read gate: one range, base64, and an offset past the end is an
/// empty answer rather than an error.
#[test]
fn a_read_range_answers_the_bytes_it_read_and_tolerates_the_end_of_the_file() {
    let (_package, page) = tree_package();
    let mut effects = Nobody::default();
    assert_eq!(
        std::fs::read_to_string(page.root.join("docs/readme.md")).expect("the fixture"),
        "root"
    );

    let middle = answer(
        &page,
        &test_roots(&page),
        &call(
            "fs.readRange",
            json!({ "path": "docs/readme.md", "offset": 1, "length": 2 }),
        ),
        &mut effects,
    )
    .expect("inside the scope");
    assert_eq!(middle["result"]["offset"], json!(1));
    assert_eq!(middle["result"]["bytes"], json!(2));
    assert_eq!(middle["result"]["encoding"], json!("base64"));
    assert_eq!(middle["result"]["text"], json!("b28="));

    // Past the end: nothing is there, which is a fact rather than a refusal.
    let past = answer(
        &page,
        &test_roots(&page),
        &call(
            "fs.readRange",
            json!({ "path": "docs/readme.md", "offset": 64, "length": 8 }),
        ),
        &mut effects,
    )
    .expect("past the end is an empty answer");
    assert_eq!(past["result"]["bytes"], json!(0));
    assert_eq!(past["result"]["text"], json!(""));

    // The bound is refused rather than clamped, and the other gates still answer first.
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &call(
                "fs.readRange",
                json!({ "path": "docs/readme.md", "length": MAX_READ_BYTES + 1 }),
            ),
            &mut effects
        )),
        TOO_LARGE
    );
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &call("fs.readRange", json!({ "path": "../escape.txt" })),
            &mut effects
        )),
        INVALID_REQUEST
    );
    let without = page_with(&page, &[], &["docs/**"]);
    assert_eq!(
        refusal(answer(
            &without,
            &test_roots(&without),
            &call("fs.readRange", json!({ "path": "docs/readme.md" })),
            &mut effects
        )),
        PERMISSION_DENIED
    );
}

/// The two openers: their own permission each, the same reach as a read, and the two brakes that no
/// permission relaxes - a credential name, and a program file.
#[test]
fn the_openers_refuse_credentials_and_programs_whatever_is_declared() {
    let (_package, page) = tree_package();
    std::fs::write(page.root.join("docs/setup.exe"), "MZ").expect("a program file");
    std::fs::write(page.root.join("docs/notes.md"), "hi").expect("a document");
    let mut effects = Nobody::default();

    // The permission is each method's own: a read does not open, and the two do not borrow.
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &call("fs.openDefault", json!({ "path": "docs/notes.md" })),
            &mut effects
        )),
        PERMISSION_DENIED
    );
    let opening = page_with(&page, &["fs.openDefault"], &["docs/**"]);
    let revealing_only = page_with(&page, &["fs.reveal"], &["docs/**"]);
    assert_eq!(
        refusal(answer(
            &revealing_only,
            &test_roots(&revealing_only),
            &call("fs.openDefault", json!({ "path": "docs/notes.md" })),
            &mut effects
        )),
        PERMISSION_DENIED
    );

    // Inside the scope both run, and each reaches the caller's own effect.
    let opened = answer(
        &opening,
        &test_roots(&opening),
        &call("fs.openDefault", json!({ "path": "docs/notes.md" })),
        &mut effects,
    )
    .expect("inside the scope");
    assert_eq!(opened["ok"], json!(true));
    assert_eq!(
        effects.opened_default,
        vec![canonical(page.root.join("docs/notes.md"))],
        "the path the launcher is handed is the resolved one, not the name the caller wrote"
    );
    let revealed = answer(
        &revealing_only,
        &test_roots(&revealing_only),
        &call("fs.reveal", json!({ "path": "docs/notes.md" })),
        &mut effects,
    )
    .expect("inside the scope");
    assert_eq!(revealed["ok"], json!(true));
    assert_eq!(
        effects.revealed,
        vec![canonical(page.root.join("docs"))],
        "a file is shown where it lives"
    );

    // The brakes hold for an installation that declared the *whole disk*: this is the one widening
    // that does not reach them, because neither brake is about where a plugin may look.
    let any_path = page_with(&opening, &["fs.openDefault", "fs.anyPath"], &[]);
    assert_eq!(
        refusal(answer(
            &any_path,
            &test_roots(&any_path),
            &call("fs.openDefault", json!({ "path": "docs/setup.exe" })),
            &mut effects
        )),
        EXECUTABLE_REFUSED
    );
    assert_eq!(
        refusal(answer(
            &any_path,
            &test_roots(&any_path),
            &call("fs.openDefault", json!({ "path": ".env" })),
            &mut effects
        )),
        DENIED_BY_POLICY
    );
    // A document is still served, which is what makes the two refusals specific rather than blanket.
    assert!(answer(
        &any_path,
        &test_roots(&any_path),
        &call("fs.openDefault", json!({ "path": "docs/notes.md" })),
        &mut effects
    )
    .is_ok());
}

/// The openers' brakes are the *act's* brakes too. The judgement and the act are apart in time - the
/// question can sit on screen for a minute - so a path that names a program by the time the opener is
/// handed it is refused there as well, not only where it was answered.
#[test]
fn the_opener_brakes_are_asked_again_where_the_path_is_acted_on() {
    let (_package, page) = tree_package();
    std::fs::write(page.root.join("docs/notes.md"), "hi").expect("a document");
    std::fs::write(page.root.join("docs/setup.exe"), "MZ").expect("a program file");
    let opener = page_with(&page, &["fs.openDefault", "fs.reveal"], &["docs/**"]);
    let roots = test_roots(&opener);
    let mut effects = Nobody::default();

    // The judgement's own reading, which is what an installation inside its scope is allowed.
    assert!(answer(
        &opener,
        &roots,
        &call("fs.openDefault", json!({ "path": "docs/notes.md" })),
        &mut effects
    )
    .is_ok());

    // The same job, run without the judgement that would have refused it: the path names a program,
    // and the act is where that has to be caught a second time.
    for job in [
        Job::OpenDefault {
            display: "docs/setup.exe".to_owned(),
        },
        Job::Reveal {
            display: "docs/setup.exe".to_owned(),
        },
    ] {
        let ran =
            crate::services::plugins::bridge::perform::run(&job, &opener, &roots, &mut effects);
        assert_eq!(ran, Err(EXECUTABLE_REFUSED), "the act refuses a program");
    }
    assert_eq!(
        effects.opened_default,
        vec![canonical(page.root.join("docs/notes.md"))],
        "nothing but the document ever reached the opener"
    );
    assert!(effects.revealed.is_empty());
}

/// "Allow for this session" is a grant of the *reach*, not of one call.
///
/// Every read-shaped gate asks the same question (`files::read_reach`), so every one of them has to
/// remember the answer: a stat, a listing, a walk, a byte range and the two openers are the same reach
/// as a read, and a grant that only the read arm recorded would leave the user answering the same
/// question on the next call - the answer they gave would have had no effect.
#[test]
fn a_session_grant_is_remembered_for_every_read_shaped_gate() {
    let (_package, page) = tree_package();
    // Every case names something outside the fixture's `docs/**` scope, so the first call is a
    // question rather than a run.
    let cases: [(&str, serde_json::Value, &[&str]); 6] = [
        ("fs.stat", json!({ "path": "secret.txt" }), &["fs.read"]),
        (
            "fs.readRange",
            json!({ "path": "secret.txt" }),
            &["fs.read"],
        ),
        ("fs.list", json!({ "path": "docs" }), &["fs.read"]),
        ("fs.glob", json!({ "pattern": "**" }), &["fs.read"]),
        (
            "fs.openDefault",
            json!({ "path": "secret.txt" }),
            &["fs.openDefault"],
        ),
        ("fs.reveal", json!({ "path": "secret.txt" }), &["fs.reveal"]),
    ];

    for (method, params, permissions) in cases {
        let caller = page_with(&page, permissions, &["docs/**"]);
        let roots = test_roots(&caller);
        let mut effects = Nobody::default();

        // The control: "once" runs the call and remembers nothing, so the next one asks again.
        effects.answer = Some(PromptAnswer::Once);
        assert!(
            answer(&caller, &roots, &call(method, params.clone()), &mut effects).is_ok(),
            "{method} runs on an answer of once"
        );
        assert!(
            effects.remembered.is_empty(),
            "{method}: an answer of once remembers nothing"
        );
        effects.answer = None;
        assert_eq!(
            refusal(answer(
                &caller,
                &roots,
                &call(method, params.clone()),
                &mut effects
            )),
            OUT_OF_SCOPE,
            "{method} is asked about again"
        );

        // The grant: the same call then runs with nobody to answer, because the reach is remembered.
        effects.answer = Some(PromptAnswer::Session);
        assert!(
            answer(&caller, &roots, &call(method, params.clone()), &mut effects).is_ok(),
            "{method} runs on a session answer"
        );
        assert_eq!(effects.remembered.len(), 1, "{method} records the grant");
        effects.answer = None;
        assert!(
            answer(&caller, &roots, &call(method, params), &mut effects).is_ok(),
            "{method} is not asked about again: the granted reach is the same one"
        );
    }
}

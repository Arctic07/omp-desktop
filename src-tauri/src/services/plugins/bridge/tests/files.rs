//! Bridge tests: files
//!
//! Split from the module harness (`super`) by theme so no file in this tree grows past the
//! engineering limit (`rules.md#single-file-line-limit`). Every helper the tests use lives in `super`.

use super::*;

#[test]
fn the_gates_refuse_what_they_name_and_run_what_the_scope_covers() {
    let (_package, page) = package();
    let mut effects = Nobody::default();
    let inside = answer(
        &page,
        &test_roots(&page),
        &read("docs/readme.md"),
        &mut effects,
    )
    .expect("inside the scope");
    assert_eq!(inside["ok"], json!(true));
    assert_eq!(inside["result"]["encoding"], json!("utf8"));
    assert_eq!(inside["result"]["text"], json!("hello"));
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &read("../escape.txt"),
            &mut effects
        )),
        INVALID_REQUEST
    );
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &read("nope.txt"),
            &mut effects
        )),
        NOT_FOUND
    );
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &read(".env"),
            &mut effects
        )),
        DENIED_BY_POLICY
    );
    assert!(
        effects.asked.is_empty(),
        "nothing inside the scope needed an answer"
    );
}

#[test]
fn a_read_outside_the_scope_is_the_users_question_and_a_silent_user_denies() {
    let (_package, page) = package();
    let mut effects = Nobody::default();
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &read("secret.txt"),
            &mut effects
        )),
        OUT_OF_SCOPE
    );
    assert_eq!(
        effects.asked.len(),
        1,
        "the question was asked exactly once"
    );
    assert_eq!(effects.asked[0].0, PromptKind::ReadOutOfScope);
    assert_eq!(
        effects.asked[0].1, "secret.txt",
        "the question names the file the page asked for"
    );
    assert!(
        effects.remembered.is_empty(),
        "a question nobody answered remembers nothing"
    );

    // "Allow once" runs the call and remembers nothing; the next call asks again.
    effects.answer = Some(PromptAnswer::Once);
    assert!(answer(&page, &test_roots(&page), &read("secret.txt"), &mut effects).is_ok());
    assert!(effects.remembered.is_empty());
    effects.answer = None;
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &read("secret.txt"),
            &mut effects
        )),
        OUT_OF_SCOPE
    );

    // "Allow this session" remembers the file, and the next call runs without a question.
    effects.answer = Some(PromptAnswer::Session);
    assert!(answer(&page, &test_roots(&page), &read("secret.txt"), &mut effects).is_ok());
    assert_eq!(effects.remembered.len(), 1);
    effects.answer = None;
    let asked_before = effects.asked.len();
    assert!(answer(&page, &test_roots(&page), &read("secret.txt"), &mut effects).is_ok());
    assert_eq!(
        effects.asked.len(),
        asked_before,
        "the granted file is not asked about again"
    );
}

#[test]
fn the_reject_table_outranks_a_session_grant() {
    let (_package, page) = package();
    let mut effects = Nobody {
        answer: Some(PromptAnswer::Session),
        ..Nobody::default()
    };
    // A credential file is refused before the scope gate, so it is never a question and never a
    // granted reach, whatever the user answered before (spec §6.3-3).
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &read(".env"),
            &mut effects
        )),
        DENIED_BY_POLICY
    );
    assert!(effects.asked.is_empty());
}

/// A write is judged by its own permission, its own scope and its own question, and it lands as the
/// bytes it carried - through a temporary file and a rename, so a file the plugin replaced is either
/// the old one or the new one.
#[test]
fn a_write_is_judged_by_its_own_scope_and_lands_as_bytes() {
    let (_package, page) = package();
    let write = |path: &str, text: &str| {
        BridgeCall::Body(
            serde_json::to_vec(
                &json!({ "m": "fs.write", "params": { "path": path, "text": text } }),
            )
            .expect("a body"),
        )
    };
    let mut effects = Nobody::default();

    // The permission is the switch: a plugin that declared only `fs.read` cannot write.
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &write("docs/notes.md", "hi"),
            &mut effects
        )),
        PERMISSION_DENIED
    );
    assert!(
        effects.asked.is_empty(),
        "a missing permission is not a question"
    );

    let declaring = page_with_scopes(&page, &["fs.write"], &[], &["docs/**"], &[]);
    let written = answer(
        &declaring,
        &test_roots(&declaring),
        &write("docs/notes.md", "hi"),
        &mut effects,
    )
    .expect("inside the scope");
    assert_eq!(written["ok"], json!(true));
    assert_eq!(written["result"]["bytes"], json!(2));
    assert_eq!(
        std::fs::read_to_string(page.root.join("docs/notes.md")).expect("the file was written"),
        "hi"
    );

    // Out of scope is the user's question, and a refusal is the answer.
    assert_eq!(
        refusal(answer(
            &declaring,
            &test_roots(&declaring),
            &write("secret.txt", "hi"),
            &mut effects
        )),
        OUT_OF_SCOPE
    );
    assert_eq!(
        effects.asked.last().expect("a question").0,
        PromptKind::WriteOutOfScope
    );
    assert_eq!(effects.asked.last().expect("a question").1, "secret.txt");

    // The other three gates answer first: a path that climbs, a path the reject table names, and a
    // parent that is not there.
    assert_eq!(
        refusal(answer(
            &declaring,
            &test_roots(&declaring),
            &write("../escape.md", "hi"),
            &mut effects
        )),
        INVALID_REQUEST
    );
    assert_eq!(
        refusal(answer(
            &declaring,
            &test_roots(&declaring),
            &write(".env", "hi"),
            &mut effects
        )),
        DENIED_BY_POLICY
    );
    assert_eq!(
        refusal(answer(
            &declaring,
            &test_roots(&declaring),
            &write("nowhere/notes.md", "hi"),
            &mut effects
        )),
        NOT_FOUND
    );
}

/// A write may carry bytes rather than text, and they land unchanged: the decoded bytes are what the
/// file holds, not a re-encoding of them.
#[test]
fn a_base64_write_lands_the_bytes_it_carried() {
    let (_package, page) = package();
    let declaring = page_with_scopes(&page, &["fs.write"], &[], &["docs/**"], &[]);
    let mut effects = Nobody::default();
    // `/wD+` is base64 for 0xff 0x00 0xfe, which is not text: it can only be written if the bytes
    // are carried as bytes.
    let call = BridgeCall::Body(
        serde_json::to_vec(&json!({
            "m": "fs.write",
            "params": { "path": "docs/blob.bin", "text": "/wD+", "encoding": "base64" },
        }))
        .expect("a body"),
    );
    assert_eq!(
        answer(&declaring, &test_roots(&declaring), &call, &mut effects),
        Ok(json!({ "ok": true, "result": { "path": "docs/blob.bin", "bytes": 3 } }))
    );
    assert_eq!(
        std::fs::read(page.root.join("docs/blob.bin")).expect("the file was written"),
        vec![0xff, 0x00, 0xfe]
    );
}

/// A delete is judged like the other file modes - permission, containment, reject table, its own
/// scope - and the brake is what answers a series of them. The delete itself is never run here: it
/// would move a file to the machine's real trash, and what this build promises about *that* is the
/// gate's business rather than a test's.
#[test]
fn a_delete_is_judged_by_its_own_scope_and_answers_a_series() {
    let (_package, page) = package();
    let delete = BridgeCall::Body(
        serde_json::to_vec(&json!({ "m": "fs.delete", "params": { "path": "secret.txt" } }))
            .expect("a body"),
    );
    let mut effects = Nobody::default();

    assert_eq!(
        refusal(answer(&page, &test_roots(&page), &delete, &mut effects)),
        PERMISSION_DENIED,
        "fs.read does not authorize a delete"
    );

    let declaring = page_with_scopes(&page, &["fs.delete"], &[], &[], &["secret.txt"]);
    assert_eq!(
        refusal(answer(&declaring, &test_roots(&declaring), &delete, &mut effects)),
        INTERNAL,
        "the brake in this fake is wide open, so the call reaches the trash - and a test machine is not asked to move a file"
    );

    // With the brake closed the same call is refused before anything is touched.
    let mut closed = Nobody {
        deletes_left: 0,
        ..Nobody::default()
    };
    assert_eq!(
        refusal(answer(
            &declaring,
            &test_roots(&declaring),
            &delete,
            &mut closed
        )),
        TOO_MANY_DELETES
    );

    // Out of scope asks first; a directory is not a file the delete gate names; the reject table and
    // the containment gate answer before either.
    let scoped = page_with_scopes(&page, &["fs.delete"], &[], &[], &["docs/**"]);
    assert_eq!(
        refusal(answer(&scoped, &test_roots(&scoped), &delete, &mut effects)),
        OUT_OF_SCOPE
    );
    assert_eq!(
        effects.asked.last().expect("a question").0,
        PromptKind::DeleteOutOfScope
    );
    for path in ["docs", ".env", "../escape.txt"] {
        let call = BridgeCall::Body(
            serde_json::to_vec(&json!({ "m": "fs.delete", "params": { "path": path } }))
                .expect("a body"),
        );
        let judged = refusal(answer(&scoped, &test_roots(&scoped), &call, &mut effects));
        assert!(
            judged == NOT_FOUND || judged == DENIED_BY_POLICY || judged == INVALID_REQUEST,
            "{path} is refused by an earlier gate, got {judged:?}"
        );
    }
}

/// `fs.anyPath`: the declaration is the whole gate, so a path no root covers runs and nobody is
/// asked - and the reject table, which exists to keep the *user's* credentials out of a page, is not
/// consulted either, because "any path" that is not any path is a permission whose name is a lie.
#[test]
fn an_unrestricted_installation_reaches_outside_its_roots_without_a_question() {
    let (package, page) = package();
    let outside_dir = package.root.with_file_name(format!(
        "{}-outside",
        package
            .root
            .file_name()
            .expect("a fixture name")
            .to_string_lossy()
    ));
    std::fs::create_dir_all(&outside_dir).expect("a directory outside the package");
    let outside_file = outside_dir.join("reachable.txt");
    std::fs::write(&outside_file, "reached").expect("a file outside the package");
    let outside = outside_file.to_str().expect("utf8").to_owned();

    // Without the permission the same absolute name is refused before any question: it is not a
    // relative path this application resolves.
    let mut effects = Nobody::default();
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &read(&outside),
            &mut effects
        )),
        INVALID_REQUEST
    );

    let unrestricted = page_with(&page, &["fs.read", "fs.anyPath"], &["docs/**"]);
    let roots = test_roots(&unrestricted);
    let mut effects = Nobody::default();
    let reached = answer(&unrestricted, &roots, &read(&outside), &mut effects)
        .expect("the permission is the whole gate");
    assert_eq!(reached["result"]["text"], json!("reached"));
    // The reject table is not a second gate behind the permission.
    let credential = answer(&unrestricted, &roots, &read(".env"), &mut effects)
        .expect("a credential file is a file like any other here");
    assert_eq!(credential["result"]["text"], json!("TOKEN=1"));
    assert!(
        effects.asked.is_empty(),
        "an installation that declared the whole disk is asked about nothing"
    );

    // The write mode widens the same way: a target outside every root lands.
    let writing = page_with(&page, &["fs.write", "fs.anyPath"], &[]);
    let target = outside_dir.join("written.txt");
    let write = BridgeCall::Body(
        serde_json::to_vec(&json!({
            "m": "fs.write",
            "params": { "path": target.to_str().expect("utf8"), "text": "written" }
        }))
        .expect("a body"),
    );
    let written = answer(&writing, &test_roots(&writing), &write, &mut effects)
        .expect("written outside the package");
    assert_eq!(written["ok"], json!(true));
    assert_eq!(
        std::fs::read_to_string(&target).expect("the file was written"),
        "written"
    );

    // The same permission makes a directory outside every root nameable, which is what turns the
    // reach from a set of paths the plugin already knows into a set it can discover.
    let listing_call = BridgeCall::Body(
        serde_json::to_vec(&json!({
            "m": "fs.list",
            "params": { "path": outside_dir.to_str().expect("utf8") }
        }))
        .expect("a body"),
    );
    let listing = answer(&unrestricted, &roots, &listing_call, &mut effects)
        .expect("listed outside the package");
    let names: Vec<&str> = listing["result"]["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .filter_map(|entry| entry["name"].as_str())
        .collect();
    assert!(names.contains(&"written.txt"), "got {names:?}");

    let _ = std::fs::remove_dir_all(&outside_dir);
}

/// `fs.stat` and `fs.list`: the read gate's reach with a directory as an answer rather than a
/// `NotFound` - the two calls that turn a granted reach into a usable one.
#[test]
fn an_inspection_names_a_directory_and_lists_what_is_inside_it() {
    let (_package, page) = package();
    let call = |method: &str, path: &str| {
        BridgeCall::Body(
            serde_json::to_vec(&json!({ "m": method, "params": { "path": path } }))
                .expect("a body"),
        )
    };
    let mut effects = Nobody::default();
    // The fixture's own scope is `docs/**`, which names what is *under* `docs` and not the directory
    // itself - so the cases that inspect the directory declare both patterns.
    let scoped = page_with(&page, &["fs.read"], &["docs", "docs/**"]);

    // The fixture package holds `docs/` (with one file), `secret.txt` and `.env`.
    let directory = answer(
        &scoped,
        &test_roots(&scoped),
        &call("fs.stat", "docs"),
        &mut effects,
    )
    .expect("a directory is an answer to a stat");
    assert_eq!(directory["result"]["directory"], json!(true));

    let file = answer(
        &scoped,
        &test_roots(&scoped),
        &call("fs.stat", "docs/readme.md"),
        &mut effects,
    )
    .expect("a file is one too");
    assert_eq!(file["result"]["directory"], json!(false));
    assert_eq!(file["result"]["size"], json!(5), "'hello'");
    assert!(
        file["result"]["modifiedMs"].is_u64(),
        "a file this side just wrote has a stamp"
    );

    let listing = answer(
        &scoped,
        &test_roots(&scoped),
        &call("fs.list", "docs"),
        &mut effects,
    )
    .expect("listed");
    assert_eq!(
        listing["result"]["entries"],
        json!([{ "name": "readme.md", "directory": false }])
    );
    assert_eq!(listing["result"]["truncated"], json!(false));

    // A plain read still refuses a directory: the widening lives in the inspection mode, not in the
    // read, so the two cannot drift into meaning the same thing.
    assert_eq!(
        refusal(answer(
            &scoped,
            &test_roots(&scoped),
            &read("docs"),
            &mut effects
        )),
        NOT_FOUND
    );
    // The reject table is applied to an inspection exactly as it is to a read.
    assert_eq!(
        refusal(answer(
            &scoped,
            &test_roots(&scoped),
            &call("fs.stat", ".env"),
            &mut effects
        )),
        DENIED_BY_POLICY
    );
    // `docs/**` does not name `docs` itself - `**` is one or more whole segments - so a directory
    // asked for under a scope that only names its contents is the user's question, exactly as a file
    // outside the scope is.
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &call("fs.stat", "docs"),
            &mut effects
        )),
        OUT_OF_SCOPE
    );
    // No permission is denied before anything is resolved...
    let unreadable = page_with(&page, &[], &[]);
    assert_eq!(
        refusal(answer(
            &unreadable,
            &test_roots(&unreadable),
            &call("fs.list", "docs"),
            &mut effects
        )),
        PERMISSION_DENIED
    );
    // ...and so is a path outside every declared pattern.
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &call("fs.stat", "secret.txt"),
            &mut effects
        )),
        OUT_OF_SCOPE
    );
    assert_eq!(
        effects.asked.last().expect("a question").0,
        PromptKind::ReadOutOfScope
    );
}

/// A listing answers the read gate's *reach*, so a name a read is refused under is a name a listing
/// does not hand out either: one directory cannot have two answers, and the names a plugin is shown
/// are the names it may use.
#[test]
fn a_listing_does_not_name_what_a_read_refuses() {
    let (_package, page) = package();
    std::fs::write(page.root.join("docs/.env"), "TOKEN=1")
        .expect("a credential file inside the scope");
    let scoped = page_with(&page, &["fs.read"], &["docs", "docs/**"]);
    let mut effects = Nobody::default();
    let listing = |path: &str| {
        BridgeCall::Body(
            serde_json::to_vec(&json!({ "m": "fs.list", "params": { "path": path } }))
                .expect("a body"),
        )
    };

    let listed = answer(
        &scoped,
        &test_roots(&scoped),
        &listing("docs"),
        &mut effects,
    )
    .expect("listed");
    assert_eq!(
        listed["result"]["entries"],
        json!([{ "name": "readme.md", "directory": false }]),
        "the credential file is not named"
    );
    // A read of that name is refused for the same reason the listing does not name it.
    assert_eq!(
        refusal(answer(
            &scoped,
            &test_roots(&scoped),
            &read("docs/.env"),
            &mut effects
        )),
        DENIED_BY_POLICY
    );

    // An installation that declared the whole disk is told, exactly as it may read it: the one
    // widening drops the table for this answer the way it drops it for a read.
    let unrestricted = page_with(&page, &["fs.read", "fs.anyPath"], &[]);
    let listed = answer(
        &unrestricted,
        &test_roots(&unrestricted),
        &listing("docs"),
        &mut effects,
    )
    .expect("listed");
    let names: Vec<&str> = listed["result"]["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .filter_map(|entry| entry["name"].as_str())
        .collect();
    assert!(
        names.contains(&".env") && names.contains(&"readme.md"),
        "got {names:?}"
    );
}

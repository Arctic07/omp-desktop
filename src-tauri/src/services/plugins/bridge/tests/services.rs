//! Bridge tests: services
//!
//! Split from the module harness (`super`) by theme so no file in this tree grows past the
//! engineering limit (`rules.md#single-file-line-limit`). Every helper the tests use lives in `super`.

use super::*;

/// `close` is answered for a window that belongs to the installation and refused for one that
/// does not - the same rule the query path has always had.
#[test]
fn close_belongs_to_the_caller() {
    let (_package, page) = package();
    let mut owner = Nobody {
        closable: true,
        ..Nobody::default()
    };
    assert!(answer(
        &page,
        &test_roots(&page),
        &BridgeCall::Query("m=close".to_owned()),
        &mut owner
    )
    .is_ok());
    let mut docked = Nobody::default();
    assert_eq!(
        refusal(answer(
            &page,
            &test_roots(&page),
            &BridgeCall::Query("m=close".to_owned()),
            &mut docked
        )),
        PERMISSION_DENIED
    );
}

/// The egress gate is a filter with one answer: a host the manifest did not list is not
/// something a user answer could allow, so the call is refused rather than asked about.
#[test]
fn the_egress_gate_answers_with_the_manifest_and_never_with_a_question() {
    let (_package, page) = package();
    let fetch = |body: Value| BridgeCall::Body(serde_json::to_vec(&body).expect("a body"));
    let call =
        fetch(json!({ "m": "net.fetch", "params": { "url": "https://api.example.com/v1" } }));
    let mut effects = Nobody::default();

    let without_permission = page_with_permissions(&page, &["fs.read"], &[], &[]);
    assert_eq!(
        refusal(answer(
            &without_permission,
            &test_roots(&without_permission),
            &call,
            &mut effects
        )),
        PERMISSION_DENIED
    );
    assert!(
        effects.asked.is_empty(),
        "a missing permission is not a question"
    );

    let with_permission = page_with_permissions(&page, &["net.fetch"], &[], &[]);
    assert_eq!(
        refusal(answer(
            &with_permission,
            &test_roots(&with_permission),
            &call,
            &mut effects
        )),
        HOST_NOT_DECLARED,
        "no declared domain is no reach, whatever the permission says"
    );
    assert!(effects.asked.is_empty());

    let listed = page_with_permissions(&page, &["net.fetch"], &[], &["api.example.com"]);
    let mut nobody = Nobody::default();
    // The judgement stands on its own: what the job *would* do is a socket, which no test opens.
    assert!(matches!(
        judge(&listed, &test_roots(&listed), &call, &|_grant| nobody
            .holds(&SessionGrant::Clipboard("read"))),
        Ok(Judgement::Run(Job::Fetch { .. }))
    ));
    assert_eq!(
        refusal(answer(
            &listed,
            &test_roots(&page),
            &fetch(json!({
                "m": "net.fetch",
                "params": { "url": "https://evil.test/v1" },
            })),
            &mut nobody
        )),
        HOST_NOT_DECLARED
    );
}

/// A clipboard direction is asked about the first time and never executed by a test: the gate is
/// what is under test here, and the answers that would reach the real clipboard are not taken.
#[test]
fn a_clipboard_call_asks_once_and_a_silent_user_denies() {
    let (_package, page) = package();
    let read = BridgeCall::Body(b"{\"m\":\"clipboard.read\"}".to_vec());
    let mut effects = Nobody::default();
    assert_eq!(
        refusal(answer(
            &page_with_permissions(&page, &[], &[], &[]),
            &test_roots(&page),
            &read,
            &mut effects
        )),
        PERMISSION_DENIED
    );
    assert!(effects.asked.is_empty());

    let declaring = page_with_permissions(&page, &["clipboard.read"], &[], &[]);
    assert_eq!(
        refusal(answer(
            &declaring,
            &test_roots(&declaring),
            &read,
            &mut effects
        )),
        PERMISSION_REFUSED_BY_USER,
        "a question nobody answered is the user's refusal, not a missing permission"
    );
    assert_eq!(
        effects.asked.len(),
        1,
        "the first use is the user's question"
    );
    assert_eq!(effects.asked[0].0, PromptKind::ClipboardRead);

    // An answer that arrived too late (or a table with no room) is the same refusal.
    effects.grants = vec![SessionGrant::Clipboard("read")];
    assert!(matches!(
        judge(&declaring, &test_roots(&declaring), &read, &|grant| effects
            .grants
            .contains(grant)),
        Ok(Judgement::Run(Job::ClipboardRead))
    ));
}

/// A clipboard write is judged like a read - permission, then the first-use question - and the
/// text it carries is the job the gate hands back. The judgement is asserted rather than run,
/// because running it would reach the real clipboard.
///
/// This is the case the first version of the gate got wrong: a write was answered `internal`
/// before it was ever judged, so the permission and the question never came into it.
#[test]
fn a_clipboard_write_is_judged_and_carries_its_text() {
    let (_package, page) = package();
    let call = BridgeCall::Body(br#"{"m":"clipboard.write","params":{"text":"hello"}}"#.to_vec());
    let declaring = page_with_permissions(&page, &["clipboard.write"], &[], &[]);

    match judge(&declaring, &test_roots(&declaring), &call, &|_grant| false).expect("a judgement") {
        Judgement::Ask { kind, job, .. } => {
            assert_eq!(kind, PromptKind::ClipboardWrite);
            assert!(
                matches!(job, Job::ClipboardWrite { ref text } if text == "hello"),
                "the question carries the write it is about"
            );
        }
        other => panic!("the first use is the user's question, got {other:?}"),
    }
    match judge(&declaring, &test_roots(&declaring), &call, &|_grant| true).expect("a judgement") {
        Judgement::Run(Job::ClipboardWrite { text }) => assert_eq!(text, "hello"),
        other => panic!("a granted write runs, got {other:?}"),
    }
    assert_eq!(
        refusal(answer(
            &page_with_permissions(&page, &[], &[], &[]),
            &test_roots(&page),
            &call,
            &mut Nobody::default()
        )),
        PERMISSION_DENIED,
        "without the permission it is refused before any question"
    );
}

/// A notice is the one permission with no question attached: declared means served, and what the
/// gate reads is the plugin's own bounds. A body is optional, and a body that is not text is refused
/// rather than dropped.
#[test]
fn a_notice_needs_the_permission_and_stays_inside_its_bounds() {
    let (_package, page) = package();
    let notice = |body: Value| BridgeCall::Body(serde_json::to_vec(&body).expect("a body"));
    let mut effects = Nobody::default();
    let call = notice(
        json!({ "m": "notify", "params": { "title": "Build finished", "body": "3 warnings" } }),
    );

    assert_eq!(
        refusal(answer(&page, &test_roots(&page), &call, &mut effects)),
        PERMISSION_DENIED,
        "a plugin that did not declare notify is refused"
    );
    assert!(effects.notices.is_empty());

    let declaring = page_with_permissions(&page, &["notify"], &[], &[]);
    assert_eq!(
        answer(&declaring, &test_roots(&declaring), &call, &mut effects),
        Ok(json!({ "ok": true }))
    );
    assert_eq!(
        effects.notices,
        vec![("Build finished".to_owned(), "3 warnings".to_owned())],
        "the notice the plugin asked for is what the user is shown"
    );
    assert!(
        effects.asked.is_empty(),
        "notify is granted with the plugin, not asked about"
    );

    // A title is required and bounded; the body is optional and bounded; a body that is not text is
    // not read as text.
    assert_eq!(
        refusal(answer(
            &declaring,
            &test_roots(&declaring),
            &notice(json!({ "m": "notify", "params": {} })),
            &mut effects
        )),
        INVALID_REQUEST
    );
    assert_eq!(
        refusal(answer(
            &declaring,
            &test_roots(&page),
            &notice(json!({ "m": "notify", "params": { "title": "  " } })),
            &mut effects
        )),
        INVALID_REQUEST,
        "a title that is only whitespace says nothing"
    );
    assert_eq!(
        refusal(answer(
            &declaring,
            &test_roots(&page),
            &notice(json!({ "m": "notify", "params": { "title": "t", "body": 7 } })),
            &mut effects
        )),
        INVALID_REQUEST
    );
    assert_eq!(
        refusal(answer(
            &declaring,
            &test_roots(&page),
            &notice(json!({ "m": "notify", "params": { "title": "x".repeat(129) } })),
            &mut effects
        )),
        INVALID_REQUEST
    );
    assert_eq!(
        refusal(answer(
            &declaring,
            &test_roots(&page),
            &notice(
                json!({ "m": "notify", "params": { "title": "t", "body": "y".repeat(1_025) } })
            ),
            &mut effects
        )),
        TOO_LARGE
    );
    assert_eq!(
        answer(
            &declaring,
            &test_roots(&page),
            &notice(json!({ "m": "notify", "params": { "title": "only a title" } })),
            &mut effects
        ),
        Ok(json!({ "ok": true })),
        "a title alone is a notice"
    );
}

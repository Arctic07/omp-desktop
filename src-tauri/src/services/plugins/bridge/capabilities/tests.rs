//! The P1 gates, driven with nothing running: one allow, one deny and one over-limit per family.
//!
//! Every case goes through the bridge's own `answer`, not through the judge: what a plugin receives
//! is the envelope, and a test that asserted on a `Judgement` would pass while the caller saw a
//! different thing. The fake effects (`super::super::tests`' `Nobody` shape, rebuilt here so this
//! file owns its fixtures) record what a gate let through.

use serde_json::{json, Value};

use super::super::{
    answer, BridgeCall, BridgeEffects, BrowserRequest, Refusal, RefusalOrRequest, INVALID_REQUEST,
    PERMISSION_DENIED, TOO_LARGE, TOO_MANY_REQUESTS, UNSUPPORTED,
};
use crate::services::plugins::gates::SessionGrant;
use crate::services::plugins::pages::{FsScopes, PageGrants, PluginPage};
use crate::services::plugins::prompt::{PromptAnswer, PromptKind};

/// One installation with the permissions a case names; a resident process unless a case says
/// otherwise, because that is the surface `bus.subscribe` is served for.
fn page(permissions: &[&str], resident: bool) -> PluginPage {
    PluginPage {
        plugin_id: "smoke-plugin".to_owned(),
        name: "Smoke Plugin".to_owned(),
        scope: "user".to_owned(),
        root: std::path::PathBuf::from("."),
        enabled: true,
        revision: "rev:capabilities".to_owned(),
        pages: Vec::new(),
        theme_assets: Vec::new(),
        renderer_module: None,
        grants: PageGrants {
            permissions: permissions.iter().map(|name| (*name).to_owned()).collect(),
            fs_scopes: FsScopes::default(),
            net_domains: vec!["api.example.com".to_owned()],
            net_any_host: false,
            resident,
        },
    }
}

/// The fake's record of what a gate let through.
#[derive(Default)]
struct Fake {
    data: Vec<crate::services::plugins::bridge::DataRequest>,
    published: Vec<(String, Value)>,
    subscribed: Vec<Vec<String>>,
    opened: Vec<String>,
    opened_default: Vec<String>,
    revealed: Vec<String>,
    browser: Vec<crate::services::plugins::bridge::BrowserRequest>,
    grants: Vec<SessionGrant>,
    answer: Option<PromptAnswer>,
    asked: Vec<PromptKind>,
}

impl BridgeEffects for Fake {
    fn holds(&self, grant: &SessionGrant) -> bool {
        self.grants.contains(grant)
    }
    fn remember(&mut self, grant: SessionGrant) {
        self.grants.push(grant);
    }
    fn ask(&mut self, kind: PromptKind, _target: &str) -> Option<PromptAnswer> {
        self.asked.push(kind);
        self.answer
    }
    fn close_caller(&mut self) -> bool {
        false
    }
    fn notify(&mut self, _title: &str, _body: &str) {}
    fn take_delete(&mut self) -> bool {
        true
    }
    fn log_line(&mut self, _level: &'static str, _message: &str) {}
    fn plugin_data(
        &mut self,
        request: &crate::services::plugins::bridge::DataRequest,
    ) -> Result<Value, Refusal> {
        self.data.push(request.clone());
        Ok(json!({ "sessions": [], "nextCursor": null }))
    }
    fn bus_publish(&mut self, topic: &str, payload: &Value) -> Result<Value, Refusal> {
        self.published.push((topic.to_owned(), payload.clone()));
        Ok(json!({ "delivered": 1 }))
    }
    fn bus_subscribe(&mut self, topics: &[String]) -> Result<Value, Refusal> {
        self.subscribed.push(topics.to_vec());
        Ok(json!({ "topics": topics }))
    }
    fn open_external_url(&mut self, url: &str) -> Result<(), Refusal> {
        self.opened.push(url.to_owned());
        Ok(())
    }
    /// The directory this fake would answer with: one path per installation, made up rather than
    /// created, because these tests are about the gate and not about the filesystem.
    fn data_dir(&mut self) -> Result<String, Refusal> {
        Ok(String::from("/tmp/plugin-data/fake"))
    }
    /// Both openers record the path instead of launching anything: the gate is what these tests
    /// prove, and a test that opened a real file manager window would be testing the machine.
    fn open_default(&mut self, path: &str) -> Result<(), Refusal> {
        self.opened_default.push(path.to_owned());
        Ok(())
    }
    fn reveal(&mut self, path: &str) -> Result<(), Refusal> {
        self.revealed.push(path.to_owned());
        Ok(())
    }
    fn browser(&mut self, request: &BrowserRequest) -> Result<Value, Refusal> {
        self.browser.push(request.clone());
        Ok(json!({ "ok": true }))
    }
}

fn roots(page: &PluginPage) -> crate::services::plugins::gates::FsRoots {
    crate::services::plugins::gates::FsRoots {
        workspace: None,
        plugin: page.root.clone(),
    }
}

/// One call through the whole gate, answering the envelope's `result` on success.
fn call(
    page: &PluginPage,
    method: &str,
    params: Value,
    effects: &mut Fake,
) -> Result<Value, Refusal> {
    let body = serde_json::to_vec(&json!({ "m": method, "params": params })).expect("a body");
    match answer(page, &roots(page), &BridgeCall::Body(body), effects) {
        Ok(value) => Ok(value),
        Err(RefusalOrRequest::Refused(refusal)) => Err(refusal),
        Err(RefusalOrRequest::Request) => panic!("{method} is a method this build serves"),
    }
}

/// The refusal one call answered with.
fn refused(page: &PluginPage, method: &str, params: Value, effects: &mut Fake) -> Refusal {
    call(page, method, params, effects).expect_err("the call was refused")
}

// ---- session.read / usage.read ----

#[test]
fn a_session_list_is_served_with_the_page_the_caller_asked_for() {
    let page = page(&["session.read"], false);
    let mut effects = Fake::default();
    let answer = call(&page, "session.list", json!({ "limit": 10 }), &mut effects)
        .expect("a declared session.read is served");
    assert_eq!(answer["ok"], json!(true));
    assert_eq!(effects.data.len(), 1);
    assert!(matches!(
        effects.data[0],
        crate::services::plugins::bridge::DataRequest::SessionList { limit: 10, .. }
    ));
}

#[test]
fn a_session_read_without_its_permission_is_refused() {
    let page = page(&["usage.read"], false);
    let mut effects = Fake::default();
    assert_eq!(
        refused(
            &page,
            "session.get",
            json!({ "sessionId": "s0" }),
            &mut effects
        ),
        PERMISSION_DENIED
    );
    assert!(effects.data.is_empty(), "a refused call reached no host");
}

#[test]
fn a_page_over_the_ceiling_is_invalid_rather_than_trimmed() {
    let page = page(&["session.read"], false);
    let mut effects = Fake::default();
    assert_eq!(
        refused(
            &page,
            "session.list",
            json!({ "limit": 5_000 }),
            &mut effects
        ),
        INVALID_REQUEST
    );
    // A body budget over the ceiling is the same answer, and a body budget of zero is not a
    // spelling of "no bodies": the caller that wants none simply omits the field.
    assert_eq!(
        refused(
            &page,
            "session.messages",
            json!({ "sessionId": "s0", "contentLimit": 8_192 }),
            &mut effects
        ),
        INVALID_REQUEST
    );
    assert_eq!(
        refused(
            &page,
            "session.messages",
            json!({ "sessionId": "s0", "contentLimit": 0 }),
            &mut effects
        ),
        INVALID_REQUEST
    );
}

#[test]
fn a_usage_window_wider_than_a_year_is_refused() {
    let page = page(&["usage.read"], false);
    let mut effects = Fake::default();
    let day = 86_400_000i64;
    assert_eq!(
        refused(
            &page,
            "usage.turns",
            json!({ "fromMs": 0, "toMs": 400 * day }),
            &mut effects
        ),
        INVALID_REQUEST
    );
    assert!(
        call(
            &page,
            "usage.turns",
            json!({ "fromMs": 0, "toMs": 200 * day }),
            &mut effects
        )
        .is_ok(),
        "a window inside the year is served"
    );
}

/// The ceiling is a bound on *arithmetic*, not on spelling: the widest legal window (exactly a
/// year) is served, and a pair whose true span does not fit in an `i64` is refused rather than
/// allowed to wrap `to - from` negative and slip under the ceiling.
#[test]
fn an_extreme_usage_window_is_refused_rather_than_wrapped() {
    let page = page(&["usage.read"], false);
    let mut effects = Fake::default();
    let day = 86_400_000i64;
    for window in [
        // The whole `i64` range: `i64::MIN..i64::MAX` is ordered, so only the span arithmetic can
        // stop it. `to - from` wraps to `-1`, which is below the year ceiling.
        json!({ "fromMs": i64::MIN, "toMs": i64::MAX }),
        // One saturated end is enough - both of these have a true span of ~9.2e18 ms.
        json!({ "fromMs": i64::MIN, "toMs": 0 }),
        json!({ "fromMs": 0, "toMs": i64::MAX }),
    ] {
        assert_eq!(
            refused(&page, "usage.turns", window.clone(), &mut effects),
            INVALID_REQUEST,
            "{window} is over the ceiling and must be refused"
        );
    }
    // The same guard leaves the boundary honest: exactly a year is inside, one millisecond more is
    // not, and a one-sided window still measures its named end against now.
    assert!(
        call(
            &page,
            "usage.turns",
            json!({ "fromMs": 0, "toMs": 365 * day }),
            &mut effects
        )
        .is_ok(),
        "a window of exactly the ceiling is served"
    );
    assert_eq!(
        refused(
            &page,
            "usage.turns",
            json!({ "fromMs": 0, "toMs": 365 * day + 1 }),
            &mut effects
        ),
        INVALID_REQUEST
    );
    assert!(
        call(&page, "usage.turns", json!({}), &mut effects).is_ok(),
        "a window with no ends names everything up to now and is still served"
    );
}

// ---- agent.complete ----

#[test]
fn a_completion_asks_the_user_before_it_spends_anything() {
    let page = page(&["agent.complete"], true);
    let mut effects = Fake {
        answer: Some(PromptAnswer::Deny),
        ..Fake::default()
    };
    assert_eq!(
        refused(
            &page,
            "agent.complete",
            json!({ "prompt": "hello" }),
            &mut effects
        )
        .code,
        "permission_denied"
    );
    assert_eq!(effects.asked, vec![PromptKind::AgentComplete]);
    assert!(
        effects.data.is_empty(),
        "a denied completion never reached the model"
    );
}

#[test]
fn a_session_yes_covers_every_later_completion() {
    let page = page(&["agent.complete"], true);
    let mut effects = Fake {
        answer: Some(PromptAnswer::Session),
        ..Fake::default()
    };
    call(
        &page,
        "agent.complete",
        json!({ "prompt": "one" }),
        &mut effects,
    )
    .expect("the first call after the answer runs");
    call(
        &page,
        "agent.complete",
        json!({ "prompt": "two" }),
        &mut effects,
    )
    .expect("the session grant answers the second");
    assert_eq!(
        effects.asked.len(),
        1,
        "the question is asked once per session, not once per call"
    );
    assert_eq!(effects.data.len(), 2);
}

#[test]
fn a_completion_over_the_output_ceiling_is_invalid() {
    let page = page(&["agent.complete"], true);
    let mut effects = Fake {
        grants: vec![SessionGrant::AgentComplete],
        ..Fake::default()
    };
    assert_eq!(
        refused(
            &page,
            "agent.complete",
            json!({ "prompt": "hello", "maxTokens": 100_000 }),
            &mut effects
        ),
        INVALID_REQUEST
    );
    assert_eq!(
        refused(&page, "agent.complete", json!({}), &mut effects),
        INVALID_REQUEST
    );
}

// ---- bus ----

#[test]
fn a_publish_inside_the_callers_own_namespace_is_delivered() {
    let page = page(&["bus.publish"], true);
    let mut effects = Fake::default();
    let answer = call(
        &page,
        "bus.publish",
        json!({ "topic": "plugin:smoke-plugin/hello", "payload": { "n": 1 } }),
        &mut effects,
    )
    .expect("the publisher owns that topic");
    assert_eq!(answer["ok"], json!(true));
    assert_eq!(effects.published.len(), 1);
}

#[test]
fn a_publish_under_another_plugins_namespace_is_refused() {
    let page = page(&["bus.publish"], true);
    let mut effects = Fake::default();
    assert_eq!(
        refused(
            &page,
            "bus.publish",
            json!({ "topic": "plugin:someone-else/hello", "payload": null }),
            &mut effects
        ),
        PERMISSION_DENIED
    );
    assert!(effects.published.is_empty());
}

#[test]
fn a_topic_that_is_not_a_topic_is_invalid_and_someone_elses_is_a_permission_answer() {
    let page = page(&["bus.publish"], true);
    let mut effects = Fake::default();
    // Not a topic at all: no `plugin:` prefix.
    assert_eq!(
        refused(
            &page,
            "bus.publish",
            json!({ "topic": "hello", "payload": null }),
            &mut effects
        ),
        INVALID_REQUEST
    );
    // A topic with no name after the owner.
    assert_eq!(
        refused(
            &page,
            "bus.publish",
            json!({ "topic": "plugin:smoke-plugin/", "payload": null }),
            &mut effects
        ),
        INVALID_REQUEST
    );
    assert!(effects.published.is_empty(), "neither call reached the bus");
}

#[test]
fn a_payload_over_the_ceiling_is_too_large() {
    let page = page(&["bus.publish"], true);
    let mut effects = Fake::default();
    let big = "x".repeat(70_000);
    assert_eq!(
        refused(
            &page,
            "bus.publish",
            json!({ "topic": "plugin:smoke-plugin/big", "payload": big }),
            &mut effects
        ),
        TOO_LARGE
    );
}

#[test]
fn a_page_may_not_subscribe_because_it_has_no_channel_to_receive_on() {
    let document = page(&["bus.subscribe"], false);
    let mut effects = Fake::default();
    assert_eq!(
        refused(
            &document,
            "bus.subscribe",
            json!({ "topics": ["plugin:other/x"] }),
            &mut effects
        ),
        UNSUPPORTED
    );
    let watching = page(&["bus.subscribe"], true);
    call(
        &watching,
        "bus.subscribe",
        json!({ "topics": ["plugin:other/x"] }),
        &mut effects,
    )
    .expect("a resident process subscribes");
    assert_eq!(effects.subscribed, vec![vec!["plugin:other/x".to_owned()]]);
}

// ---- net.websocket ----

#[test]
fn a_socket_on_a_declared_host_is_opened_and_one_elsewhere_is_not() {
    let page = page(&["net.websocket"], true);
    let mut effects = Fake::default();
    call(
        &page,
        "net.websocket.connect",
        json!({ "url": "wss://api.example.com/socket" }),
        &mut effects,
    )
    .expect("the manifest lists that host");
    assert_eq!(effects.data.len(), 1);
    assert_eq!(
        refused(
            &page,
            "net.websocket.connect",
            json!({ "url": "wss://elsewhere.test/socket" }),
            &mut effects
        )
        .code,
        "denied_by_policy"
    );
}

#[test]
fn a_socket_frame_over_the_ceiling_is_too_large() {
    let page = page(&["net.websocket"], true);
    let mut effects = Fake::default();
    let big = "x".repeat(300_000);
    assert_eq!(
        refused(
            &page,
            "net.websocket.send",
            json!({ "socketId": "ws-1", "data": big }),
            &mut effects
        ),
        TOO_LARGE
    );
}

// ---- shell.openExternal ----

#[test]
fn an_address_is_handed_to_the_system_browser_only_on_a_declared_host() {
    let page = page(&["shell.openExternal"], true);
    let mut effects = Fake::default();
    call(
        &page,
        "shell.openExternal",
        json!({ "url": "https://api.example.com/docs" }),
        &mut effects,
    )
    .expect("the host is declared");
    assert_eq!(
        effects.opened,
        vec!["https://api.example.com/docs".to_owned()]
    );
    // A scheme the launcher would hand to a file handler, not a page: refused with the egress
    // family's code, and with a sentence about opening rather than about fetching.
    let scheme = refused(
        &page,
        "shell.openExternal",
        json!({ "url": "file:///C:/Windows/system32/calc.exe" }),
        &mut effects,
    );
    assert_eq!(scheme.code, "denied_by_policy");
    assert_ne!(scheme.code, INVALID_REQUEST.code);
    assert_eq!(
        refused(
            &page,
            "shell.openExternal",
            json!({ "url": "https://elsewhere.test/" }),
            &mut effects
        )
        .code,
        "denied_by_policy"
    );
}

// ---- net.anyHost ----

#[test]
fn the_second_key_is_what_widens_the_hosts() {
    let mut page = page(&["net.fetch"], false);
    assert_eq!(
        refused(
            &page,
            "net.fetch",
            json!({ "url": "https://elsewhere.test/x" }),
            &mut Fake::default()
        )
        .code,
        "denied_by_policy"
    );
    // The permission alone is not the reach: the block's flag is the other half.
    page.grants.permissions.push("net.anyHost".to_owned());
    assert_eq!(
        refused(
            &page,
            "net.fetch",
            json!({ "url": "https://elsewhere.test/x" }),
            &mut Fake::default()
        )
        .code,
        "denied_by_policy",
        "the flag without `net.anyHost` in the block's own field still reaches only its list"
    );
    page.grants.net_any_host = true;
    assert!(
        super::super::super::net::ensure_allowed(
            "https://elsewhere.test/x",
            page.grants.net_policy()
        )
        .is_ok(),
        "both keys together widen the range"
    );
}

#[test]
fn a_refusal_that_is_not_a_permission_answer_still_names_its_cause() {
    // The envelope's code is what a plugin branches on, and `too_many_requests` is the pace's own
    // token rather than a permission's: the two are different answers to different problems.
    assert_eq!(TOO_MANY_REQUESTS.code, "too_many_requests");
    assert_ne!(TOO_MANY_REQUESTS.code, PERMISSION_DENIED.code);
}

// ---- session.write ----

#[test]
fn the_session_writes_need_their_own_permission_and_their_own_shape() {
    let mut effects = Fake::default();
    // The read permission is not the write one, in either direction.
    let reading = page(&["session.read"], false);
    for (method, params) in [
        (
            "session.rename",
            json!({ "sessionId": "s0", "title": "New" }),
        ),
        ("session.delete", json!({ "sessionId": "s0" })),
    ] {
        assert_eq!(
            refused(&reading, method, params, &mut effects),
            PERMISSION_DENIED
        );
    }
    assert!(effects.data.is_empty(), "a refused call reached no host");

    let writing = page(&["session.write"], false);
    let renamed = call(
        &writing,
        "session.rename",
        json!({ "sessionId": "s0", "title": "  New title  " }),
        &mut effects,
    )
    .expect("a declared session.write is served");
    assert_eq!(renamed["ok"], json!(true));
    assert_eq!(
        effects.data[0],
        crate::services::plugins::bridge::DataRequest::SessionRename {
            session_id: "s0".to_owned(),
            title: "New title".to_owned(),
        },
        "the title travels trimmed, once the shape gate has read it"
    );

    let deleted = call(
        &writing,
        "session.delete",
        json!({ "sessionId": "s1" }),
        &mut effects,
    )
    .expect("a declared session.write is served");
    assert_eq!(deleted["ok"], json!(true));
    assert_eq!(
        effects.data[1],
        crate::services::plugins::bridge::DataRequest::SessionDelete {
            session_id: "s1".to_owned()
        }
    );

    // An id this build cannot address and an empty title are shape failures, not questions.
    assert_eq!(
        refused(
            &writing,
            "session.delete",
            json!({ "sessionId": "" }),
            &mut effects
        ),
        INVALID_REQUEST
    );
    assert_eq!(
        refused(
            &writing,
            "session.rename",
            json!({ "sessionId": "s0", "title": "   " }),
            &mut effects
        ),
        INVALID_REQUEST
    );
    assert!(
        effects.asked.is_empty(),
        "no write path asks the user a question"
    );
}

// ---- browser.use ----

#[test]
fn the_browser_verbs_need_their_permission_and_their_own_shapes() {
    let mut effects = Fake::default();
    let without = page(&["session.read"], false);
    assert_eq!(
        refused(&without, "browser.snapshot", json!({}), &mut effects),
        PERMISSION_DENIED
    );
    assert!(effects.browser.is_empty());

    let page = page(&["browser.use"], false);
    // A navigation is an egress: the scheme first, then the manifest's own list.
    assert_eq!(
        refused(
            &page,
            "browser.navigate",
            json!({ "url": "file:///etc/passwd" }),
            &mut effects
        )
        .code,
        "denied_by_policy"
    );
    assert_eq!(
        refused(
            &page,
            "browser.navigate",
            json!({ "url": "https://elsewhere.test/" }),
            &mut effects
        )
        .code,
        "denied_by_policy"
    );
    let navigated = call(
        &page,
        "browser.navigate",
        json!({ "url": "https://api.example.com/x" }),
        &mut effects,
    )
    .expect("a listed host is served");
    assert_eq!(navigated["ok"], json!(true));
    assert_eq!(
        effects.browser[0],
        BrowserRequest::Navigate {
            url: "https://api.example.com/x".to_owned()
        }
    );

    // The read-only verbs carry no parameters, and each one reaches its own arm.
    for method in ["browser.reveal", "browser.snapshot", "browser.screenshot"] {
        call(&page, method, json!({}), &mut effects).expect("served");
    }
    call(
        &page,
        "browser.evaluate",
        json!({ "expression": "document.title" }),
        &mut effects,
    )
    .expect("served");
    call(
        &page,
        "browser.console",
        json!({ "limit": 5 }),
        &mut effects,
    )
    .expect("served");
    call(
        &page,
        "browser.action",
        json!({ "action": "reload" }),
        &mut effects,
    )
    .expect("served");
    assert_eq!(effects.browser.len(), 7);

    // A shape this surface does not read is refused rather than guessed at: the action vocabulary is
    // closed, the expression is bounded, and `fullPage` is a boolean or nothing.
    assert_eq!(
        refused(
            &page,
            "browser.action",
            json!({ "action": "cdp" }),
            &mut effects
        ),
        INVALID_REQUEST
    );
    assert_eq!(
        refused(
            &page,
            "browser.evaluate",
            json!({ "expression": "" }),
            &mut effects
        ),
        INVALID_REQUEST
    );
    assert_eq!(
        refused(
            &page,
            "browser.screenshot",
            json!({ "fullPage": "yes" }),
            &mut effects
        ),
        INVALID_REQUEST
    );
    assert_eq!(
        refused(
            &page,
            "browser.console",
            json!({ "limit": 2_000 }),
            &mut effects
        ),
        INVALID_REQUEST
    );
    assert_eq!(
        effects.browser.last(),
        Some(&BrowserRequest::Action {
            action: "reload".to_owned()
        }),
        "the refused calls reached no effect"
    );
}

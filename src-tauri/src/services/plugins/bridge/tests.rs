use super::*;
use crate::services::plugins::pages::{FsScopes, Page, PageGrants, PageKind, PluginPage};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// One installation whose package is a temporary directory, so the containment gates are real.
fn page(root: &Path, permissions: &[&str], scope: &[&str]) -> PluginPage {
    PluginPage {
        plugin_id: "smoke-plugin".to_owned(),
        name: "Smoke Plugin".to_owned(),
        scope: "user".to_owned(),
        root: root.to_path_buf(),
        enabled: true,
        revision: "rev:test".to_owned(),
        pages: vec![Page {
            id: "main".to_owned(),
            kind: PageKind::Panel,
            entry: "index.html".to_owned(),
            title: None,
            width: None,
            height: None,
            resizable: None,
        }],
        theme_assets: Vec::new(),
        renderer_module: None,
        grants: PageGrants {
            permissions: permissions.iter().map(|name| (*name).to_owned()).collect(),
            fs_scopes: FsScopes {
                read: scope.iter().map(|pattern| (*pattern).to_owned()).collect(),
                write: Vec::new(),
                delete: Vec::new(),
            },
            net_domains: Vec::new(),
            net_any_host: false,
            resident: false,
        },
    }
}

/// A fake caller: no session grants, no window, no user - the "cannot ask" case.
struct Nobody {
    grants: Vec<SessionGrant>,
    answer: Option<PromptAnswer>,
    asked: Vec<(PromptKind, String)>,
    closable: bool,
    remembered: Vec<SessionGrant>,
    notices: Vec<(String, String)>,
    /// How many more deletes this fake's brake allows; `u32::MAX` by default.
    deletes_left: u32,
    /// Every line a plugin asked for this application's log, in order.
    log_lines: Vec<(&'static str, String)>,
    /// Every P1 data request that reached the fake, in order.
    data_requests: Vec<crate::services::plugins::bridge::DataRequest>,
    /// What the fake answers a data request with; an empty object by default.
    data_answer: serde_json::Value,
    /// Every bus message the fake was asked to deliver, in order.
    published: Vec<(String, serde_json::Value)>,
    /// Every subscription set the fake was given, in order.
    subscribed: Vec<Vec<String>>,
    /// Every address handed to the system's own browser, in order.
    opened_external: Vec<String>,
    /// Every path handed to the system's default program, in order.
    opened_default: Vec<String>,
    /// Every path pointed at in the file manager, in order.
    revealed: Vec<String>,
    /// Every browser verb a gate let through, in order.
    browser: Vec<crate::services::plugins::bridge::BrowserRequest>,
}

/// The default fake has every brake wide open: the tests that care about the delete budget set the
/// count themselves, and the rest would otherwise be testing the brake by accident.
impl Default for Nobody {
    fn default() -> Self {
        Self {
            grants: Vec::new(),
            answer: None,
            asked: Vec::new(),
            closable: false,
            remembered: Vec::new(),
            notices: Vec::new(),
            deletes_left: u32::MAX,
            log_lines: Vec::new(),
            data_requests: Vec::new(),
            data_answer: json!({ "sessions": [], "nextCursor": null }),
            published: Vec::new(),
            subscribed: Vec::new(),
            opened_external: Vec::new(),
            opened_default: Vec::new(),
            revealed: Vec::new(),
            browser: Vec::new(),
        }
    }
}

impl BridgeEffects for Nobody {
    /// The fake holds what it was seeded with *and* what it was told to remember, which is what
    /// the real session store does: an answer of "this session" is a fact the next call sees.
    fn holds(&self, grant: &SessionGrant) -> bool {
        self.grants.contains(grant) || self.remembered.contains(grant)
    }
    fn remember(&mut self, grant: SessionGrant) {
        self.remembered.push(grant);
    }
    fn ask(&mut self, kind: PromptKind, target: &str) -> Option<PromptAnswer> {
        self.asked.push((kind, target.to_owned()));
        self.answer
    }
    fn close_caller(&mut self) -> bool {
        self.closable
    }
    fn notify(&mut self, title: &str, body: &str) {
        self.notices.push((title.to_owned(), body.to_owned()));
    }
    fn take_delete(&mut self) -> bool {
        if self.deletes_left == 0 {
            return false;
        }
        self.deletes_left -= 1;
        true
    }
    fn log_line(&mut self, level: &'static str, message: &str) {
        self.log_lines.push((level, message.to_owned()));
    }
    fn plugin_data(
        &mut self,
        request: &crate::services::plugins::bridge::DataRequest,
    ) -> Result<Value, Refusal> {
        self.data_requests.push(request.clone());
        Ok(self.data_answer.clone())
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
        self.opened_external.push(url.to_owned());
        Ok(())
    }
    /// A made-up path: the real one is resolved from the application's data root, which these tests
    /// do not have - what they pin is that the call is served with no permission in front of it.
    fn data_dir(&mut self) -> Result<String, Refusal> {
        Ok(String::from("/tmp/plugin-data/smoke-plugin"))
    }
    /// Both openers and the browser record what the gate let through instead of acting: these tests
    /// prove the decision, and a test that launched a program would be testing the machine it runs
    /// on.
    fn open_default(&mut self, path: &str) -> Result<(), Refusal> {
        self.opened_default.push(path.to_owned());
        Ok(())
    }
    fn reveal(&mut self, path: &str) -> Result<(), Refusal> {
        self.revealed.push(path.to_owned());
        Ok(())
    }
    fn browser(
        &mut self,
        request: &crate::services::plugins::bridge::BrowserRequest,
    ) -> Result<Value, Refusal> {
        self.browser.push(request.clone());
        Ok(json!({ "ok": true }))
    }
}

/// One fixture package: the directory, removed when the test that owns it ends.
///
/// The guard is why the tests bind it (`let (_package, page) = package();`) instead of dropping the
/// path: a test that leaves its directory behind leaves one per run, and the next reader has to work
/// out whether those are fixtures or something the application wrote.
struct Package {
    root: PathBuf,
}

impl Drop for Package {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// The roots a test's calls resolve against: the fixture package itself, and no workspace - which is
/// the case a page with no workspace is in.
fn test_roots(page: &PluginPage) -> crate::services::plugins::gates::FsRoots {
    crate::services::plugins::gates::FsRoots {
        workspace: None,
        plugin: page.root.clone(),
    }
}

/// A fixture package with a file inside the scope, a file outside it, and a credential file.
///
/// Each call gets its own directory: the tests run in parallel, and a shared one would have them
/// deleting each other's files while the gates are being read.
fn package() -> (Package, PluginPage) {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let unique = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("omp-gate-test-{}-{unique}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("docs")).expect("the fixture directory");
    std::fs::write(root.join("docs/readme.md"), "hello").expect("a file inside the scope");
    std::fs::write(root.join("secret.txt"), "outside").expect("a file outside the scope");
    std::fs::write(root.join(".env"), "TOKEN=1").expect("a credential file");
    let page = page(&root, &["fs.read"], &["docs/**"]);
    (Package { root }, page)
}

fn read(path: &str) -> BridgeCall {
    BridgeCall::Body(
        serde_json::to_vec(&json!({ "m": "fs.read", "params": { "path": path } })).expect("a body"),
    )
}

fn refusal(result: Result<Value, RefusalOrRequest>) -> Refusal {
    match result {
        Err(RefusalOrRequest::Refused(refusal)) => refusal,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// The same declaration with a different permission set, for the cases that turn on it.
fn page_with(page: &PluginPage, permissions: &[&str], scope: &[&str]) -> PluginPage {
    page_with_permissions(page, permissions, scope, &[])
}

/// The same declaration with all three lists named, for the gates that read more than one.
fn page_with_permissions(
    page: &PluginPage,
    permissions: &[&str],
    scope: &[&str],
    domains: &[&str],
) -> PluginPage {
    let mut copy = page.clone();
    copy.grants = PageGrants {
        permissions: permissions.iter().map(|name| (*name).to_owned()).collect(),
        fs_scopes: FsScopes {
            read: scope.iter().map(|pattern| (*pattern).to_owned()).collect(),
            write: Vec::new(),
            delete: Vec::new(),
        },
        net_domains: domains.iter().map(|domain| (*domain).to_owned()).collect(),
        net_any_host: false,
        resident: false,
    };
    copy
}

/// The same declaration with all three scopes named, for the modes that read one of their own.
fn page_with_scopes(
    page: &PluginPage,
    permissions: &[&str],
    read: &[&str],
    write: &[&str],
    delete: &[&str],
) -> PluginPage {
    let mut copy = page.clone();
    copy.grants = PageGrants {
        permissions: permissions.iter().map(|name| (*name).to_owned()).collect(),
        fs_scopes: FsScopes {
            read: read.iter().map(|pattern| (*pattern).to_owned()).collect(),
            write: write.iter().map(|pattern| (*pattern).to_owned()).collect(),
            delete: delete.iter().map(|pattern| (*pattern).to_owned()).collect(),
        },
        net_domains: Vec::new(),
        net_any_host: false,
        resident: false,
    };
    copy
}

// The tests themselves, by theme: one module per group of calls, so this file stays the
// shared harness rather than the whole suite.
mod envelope;
mod files;
mod reach;
mod services;

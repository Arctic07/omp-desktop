//! One browser page's document state and the two types the chrome and the host lane share.
//!
//! Split from `page` (`rules.md#single-file-line-limit`): these are plain data with no webview, no window and no
//! lock; the page owns one [`Document`] behind its own mutex, and the wire type is what the
//! `browser-state` event carries.

use serde::Serialize;
use tokio::sync::oneshot;

/// What the chrome draws about one page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserState {
    /// The conversation whose page this is.
    pub(crate) session_id: String,
    /// The tab inside that conversation.
    pub(crate) tab_id: String,
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) is_loading: bool,
    pub(crate) can_go_back: bool,
    pub(crate) can_go_forward: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) load_error: Option<String>,
}

/// One page's mutable document state.
#[derive(Debug, Clone)]
pub(crate) struct Document {
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) loading: bool,
    pub(crate) load_error: Option<String>,
    pub(crate) started: bool,
    pub(crate) can_go_back: bool,
    pub(crate) can_go_forward: bool,
    /// The navigation epoch, so an answer for a superseded load cannot satisfy the current one.
    pub(crate) epoch: u64,
    /// WebView2's id for the newest main-frame navigation, so a completion of an older one is
    /// ignored instead of overwriting the document that replaced it.
    pub(crate) navigation_id: u64,
    /// The address a load is waiting for, for `stop`.
    pub(crate) pending_target: Option<String>,
}

impl Default for Document {
    fn default() -> Self {
        Self {
            url: String::new(),
            title: String::new(),
            loading: false,
            load_error: None,
            started: false,
            can_go_back: false,
            can_go_forward: false,
            epoch: 0,
            navigation_id: 0,
            pending_target: None,
        }
    }
}

/// One navigation result, as the event handlers report it.
#[derive(Debug, Clone)]
pub(crate) struct NavigationOutcome {
    pub(crate) success: bool,
}

pub(crate) struct PendingNavigation {
    pub(crate) epoch: u64,
    /// The address the managed navigation asked for, and the redirect hops seen so far. A commit
    /// to either one is the document the navigation asked for.
    pub(crate) target: String,
    pub(crate) redirects: Vec<String>,
    pub(crate) tx: oneshot::Sender<NavigationOutcome>,
}

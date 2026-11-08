//! What the supervisor owes the P1 capabilities when a child starts receiving, stops, or is asked to
//! take a message (`omp.desktop` API 0.2.0).
//!
//! Two things make this the supervisor's job rather than the bridge's:
//!
//! - **A delivery needs the child, and the child is this table's.** The bus answers which
//!   installations subscribed (`services::plugins::bus`); writing the frame needs the pipe, which is
//!   [`Worker::link`] and lives here. One place knows how a worker is addressed, so the bus does not
//!   learn it.
//! - **A stop has to release what the installation held.** A subscription outliving its process is a
//!   handler nobody owns, and a socket outliving it is a connection the host keeps paying for. The
//!   three exits that matter - a stop, a crash, and the live ceiling's recycle - all pass the two
//!   calls below, which is why they are here rather than at each call site.
//!
//! Nothing here decides *whether* a message may be delivered: the bus's gate did (`bus.publish`),
//! and a subscription only exists because `bus.subscribe` was judged. What this adds is the address
//! and the release.

use std::sync::Arc;

use serde_json::Value;

use super::{Key, PluginProcess};
use crate::services::plugins::pages::origin_key;
use crate::state::AppState;
use tauri::Manager;

impl PluginProcess {
    /// Writes one `worker_event` frame to the child of the installation named by `plugin_id`/`scope`.
    ///
    /// `false` means the installation has no live child: the caller prunes the subscription it was
    /// delivering to, because a stopped process is not a subscriber and keeping it would make every
    /// later publish pay for a write nobody reads.
    pub(crate) fn send_event(&self, plugin_id: &str, scope: &str, frame: &Value) -> bool {
        let Ok(line) = serde_json::to_string(frame) else {
            return false;
        };
        // The link is taken *under* the lock and the write happens after it is released: a write to a
        // child's stdin blocks when the child's pipe is full (a plugin that stopped reading), and a
        // blocking write held against this table would freeze every other process operation behind it.
        // Cloning the `Arc` costs one refcount and moves the wait to the caller's own thread.
        let link = {
            let inner = self.lock();
            inner
                .entries
                .values()
                .find(|entry| entry.install.plugin_id == plugin_id && entry.install.scope == scope)
                .and_then(|entry| entry.worker.as_ref().map(|worker| Arc::clone(&worker.link)))
        };
        link.map(|link| link.send(&line)).unwrap_or(false)
    }

    /// Releases what the installation's capabilities held: its bus subscriptions and its sockets.
    ///
    /// The subscriptions go first and drop their topics with them (a topic whose last subscriber left
    /// is gone, `bus::PluginBus::unsubscribe_all`). The sockets are the host's to close, so they are
    /// handed over as a frame and *not awaited*: a stop is not the moment to hold this table's lock
    /// for a round trip, and the host closes every socket it holds on the way out regardless.
    pub(super) fn release_capabilities(&self, key: &Key) {
        let Some(app) = self.app.as_ref() else {
            return;
        };
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let install_key = origin_key(&key.plugin_id, &key.scope);
        state.plugin_bus.unsubscribe_all(&install_key);
        // The installation's browser page is released here for the same reason its sockets are: it is
        // keyed by this same installation key, no conversation owns it (a plugin's page is
        // `headless`), and nothing else names it once the installation stops - without this line one
        // hosted WebView2 guest per browsing installation would live until the app exits. Closing is
        // invisible: nothing draws that page, and a plugin that wants it back gets a new one on its
        // next `browser.*` call. Closing a webview is main-thread work, so it is dispatched.
        if let Some(browser) = state.browser.clone() {
            let owner = install_key.clone();
            let _ = app.run_on_main_thread(move || browser.close_session(&owner));
        }
        let sockets = state.plugin_sockets.take_all(&install_key);
        if sockets.is_empty() {
            return;
        }
        let runtime = state.runtime.clone();
        // The same key the sockets were opened under (`capabilities_io::plugin_data`): one
        // installation, not one plugin - the other scope's sockets are somebody else's.
        let owner = install_key.clone();
        tauri::async_runtime::spawn(async move {
            runtime.plugin_sockets_close_owner(&owner).await;
        });
    }
}

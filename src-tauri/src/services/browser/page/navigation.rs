//! The guest's document events: navigation starts, commits, history and the managed navigation's
//! resolution. Split from `page` (`rules.md#single-file-line-limit`); the methods are this module's, the fields they
//! read are the page's.

use super::super::policy::START_URL;
use super::super::state::NavigationOutcome;
use super::Page;

impl Page {
    pub(super) fn on_navigation_started(&self, url: String, navigation_id: u64) {
        if url == START_URL {
            return;
        }
        let url: String = url.chars().take(8_192).collect();
        let mut document = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        document.loading = true;
        document.load_error = None;
        document.pending_target = Some(url.clone());
        if navigation_id != 0 {
            document.navigation_id = navigation_id;
        }
        if !url.is_empty() {
            document.url = url.clone();
        }
        drop(document);
        self.publish();
        self.remember_redirect(&url);
    }

    pub(super) fn on_navigation_completed(
        &self,
        success: bool,
        error: Option<String>,
        url: String,
        can_go_back: bool,
        can_go_forward: bool,
        navigation_id: u64,
    ) {
        if url == START_URL {
            return;
        }
        let url: String = url.chars().take(8_192).collect();
        let epoch = {
            let mut document = self
                .document
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // A completion for a navigation a newer one replaced is the old document's event; it
            // must not overwrite the state the newer navigation is building.
            if navigation_id != 0
                && document.navigation_id != 0
                && navigation_id != document.navigation_id
            {
                return;
            }
            // A stop after the document committed is a stop of the *load*, not of the page, so an
            // `ERR_ABORTED` is ignored here and the document is kept.
            let was_started = document.started;
            let epoch = document.epoch;
            if !success && error.as_deref() == Some("ERR_ABORTED") && was_started {
                document.loading = false;
                document.pending_target = None;
                drop(document);
                self.publish();
                self.resolve_pending(epoch, NavigationOutcome { success: true });
                return;
            }
            document.loading = false;
            document.started = success;
            document.load_error = if success {
                None
            } else {
                Some(error.unwrap_or_else(|| "ERR_FAILED".to_owned()))
            };
            document.pending_target = None;
            if !url.is_empty() {
                document.url = url;
            }
            document.can_go_back = can_go_back;
            document.can_go_forward = can_go_forward;
            document.epoch
        };
        self.publish();
        // A first navigation starts with the guest hidden; the commit is what makes it drawable.
        // The page only draws if the registry still says it is the one on screen.
        self.apply();
        self.resolve_pending(epoch, NavigationOutcome { success });
    }

    pub(super) fn on_source_changed(&self, url: String) {
        if url.is_empty() || url == START_URL {
            return;
        }
        let url: String = url.chars().take(8_192).collect();
        let mut document = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if document.url == url {
            return;
        }
        document.url = url.clone();
        document.started = true;
        document.pending_target = None;
        drop(document);
        self.publish();
        self.apply();
        self.resolve_commit(&url);
    }

    pub(super) fn set_history(&self, can_go_back: bool, can_go_forward: bool) {
        let mut document = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if document.can_go_back == can_go_back && document.can_go_forward == can_go_forward {
            return;
        }
        document.can_go_back = can_go_back;
        document.can_go_forward = can_go_forward;
        drop(document);
        self.publish();
    }

    /// Remember one redirect hop of the managed navigation.
    pub(super) fn remember_redirect(&self, url: &str) {
        if url.is_empty() || url == START_URL {
            return;
        }
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(entry) = pending.as_mut() {
                if entry.redirects.len() < 32 && !entry.redirects.iter().any(|hop| hop == url) {
                    entry.redirects.push(url.to_owned());
                }
            }
        }
    }

    /// Resolve the managed navigation when the document commits, which is what the reference
    /// desktop's `did-navigate` answers. A load that never commits is still settled by
    /// `NavigationCompleted` (success or failure) or the timeout.
    pub(super) fn resolve_commit(&self, url: &str) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let matches = pending.as_ref().is_some_and(|entry| {
            entry.target == url || entry.redirects.iter().any(|hop| hop == url)
        });
        if !matches {
            return;
        }
        if let Some(entry) = pending.take() {
            let _ = entry.tx.send(NavigationOutcome { success: true });
        }
    }
}

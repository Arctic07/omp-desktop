//! One page's document: what it is, and the transitions that change it.
//!
//! Split from `page` (`rules.md#single-file-line-limit`) the way `navigation` is, and the division
//! between the two is where a transition comes from: this module holds the state - the address, the
//! title, the loading flag, history, the epoch the newest navigation owns, and the wait a caller is
//! parked on - together with the transitions the page's own methods drive (beginning a navigation,
//! failing one before or after it started, a title change, the load events Tauri reports, the timeout
//! that ends a wait); `navigation` holds the transitions the *guest's* events drive on the same state.
//! What stays in `page` is the guest webview itself, plus `publish` and `apply` - what the shell and
//! the platform are told, rather than what the document is.

use tauri::Url;

use super::super::policy::TargetError;
use super::super::state::{BrowserState, NavigationOutcome};
use super::Page;

impl Page {
    pub(crate) fn is_started(&self) -> bool {
        self.document
            .lock()
            .map(|document| document.started)
            .unwrap_or(false)
    }

    pub(crate) fn is_loading(&self) -> bool {
        self.document
            .lock()
            .map(|document| document.loading)
            .unwrap_or(false)
    }

    pub(crate) fn state(&self) -> BrowserState {
        let document = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        BrowserState {
            session_id: self.owner.clone(),
            tab_id: self.tab_id.clone(),
            // A page can set a title of any length; the chrome and the IPC channel are not a place
            // to carry a megabyte of it.
            url: document.url.chars().take(8_192).collect(),
            title: document.title.chars().take(512).collect(),
            is_loading: document.loading,
            can_go_back: document.can_go_back,
            can_go_forward: document.can_go_forward,
            load_error: document.load_error.clone(),
        }
    }

    pub(super) fn set_title(&self, title: String) {
        let title: String = title.chars().take(512).collect();
        let mut document = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if document.title == title {
            return;
        }
        document.title = title;
        drop(document);
        self.publish();
    }

    /// Tauri's own view of a load, used where the platform has no WebView2 events (`navigation`
    /// installs the richer ones on Windows): started is the address beginning, finished is it
    /// committing, and the wait a caller is parked on is resolved by the commit.
    pub(super) fn on_page_load(&self, event: tauri::webview::PageLoadEvent, url: &Url) {
        if cfg!(windows) {
            // Windows resolves the same events through WebView2's own handlers, where a failed
            // load carries its error status; letting Tauri's success-only view answer here would
            // report an error page as a committed document.
            return;
        }
        match event {
            tauri::webview::PageLoadEvent::Started => {
                let mut document = self
                    .document
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                document.loading = true;
                document.url = url.as_str().to_owned();
                drop(document);
                self.publish();
            }
            tauri::webview::PageLoadEvent::Finished => {
                let epoch = {
                    let mut document = self
                        .document
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    document.loading = false;
                    document.load_error = None;
                    document.started = true;
                    document.url = url.as_str().to_owned();
                    document.epoch
                };
                self.publish();
                self.resolve_pending(epoch, NavigationOutcome { success: true });
            }
        }
    }

    /// This page is now navigating to `address`: the address, the loading flag and a new epoch
    /// change, and the answer is announced.
    pub(super) fn begin_navigation(&self, address: &str) -> u64 {
        let epoch = {
            let mut document = self
                .document
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            document.epoch += 1;
            document.loading = true;
            document.load_error = None;
            document.pending_target = Some(address.to_owned());
            document.url = address.to_owned();
            document.epoch
        };
        self.publish();
        epoch
    }

    /// The navigation never reached the guest - an address this build refuses - so the document
    /// records the failure as its current state and the page re-applies the guest.
    pub(super) fn fail_before_load(&self, raw: &str, error: TargetError) {
        let mut document = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        document.epoch += 1;
        document.loading = false;
        document.started = false;
        document.load_error = Some(error.load_error().to_owned());
        document.url = raw.to_owned();
        document.pending_target = None;
        drop(document);
        self.publish();
        self.apply();
    }

    /// The guest refused or could not carry the navigation: the failure belongs to the epoch that
    /// asked for it, and a caller waiting on that epoch is answered rather than left parked.
    pub(super) fn fail_navigation(&self, address: &str, message: String) {
        let epoch = {
            let mut document = self
                .document
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            document.loading = false;
            document.started = false;
            document.load_error = Some(message.clone());
            document.url = address.to_owned();
            document.pending_target = None;
            document.epoch
        };
        self.publish();
        self.resolve_pending(epoch, NavigationOutcome { success: false });
    }

    /// The managed navigation ran out of time.
    ///
    /// Answers whether `epoch` is still the document's own - a later navigation has replaced it, and
    /// answering that one's wait would settle the wrong load - and drops the wait when it is: the
    /// caller announces the failure and puts the guest back.
    pub(super) fn timed_out(&self, epoch: u64) -> bool {
        let mut document = self
            .document
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if document.epoch != epoch {
            return false;
        }
        document.loading = false;
        document.started = false;
        document.load_error = Some("ERR_TIMED_OUT".to_owned());
        drop(document);
        if let Ok(mut held) = self.pending.lock() {
            if held.as_ref().is_some_and(|entry| entry.epoch == epoch) {
                held.take();
            }
        }
        true
    }

    /// One parked caller, answered when its own epoch commits or fails. An answer for an epoch the
    /// document has moved past is dropped: the navigation it belonged to is no longer this page's.
    pub(super) fn resolve_pending(&self, epoch: u64, outcome: NavigationOutcome) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let matches = pending.as_ref().is_some_and(|entry| entry.epoch == epoch);
        if !matches {
            return;
        }
        if let Some(entry) = pending.take() {
            let _ = entry.tx.send(outcome);
        }
    }
}

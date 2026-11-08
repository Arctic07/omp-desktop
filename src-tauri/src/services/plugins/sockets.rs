//! The sockets one installation holds, counted where the installation is (`omp.desktop` API 0.2.0).
//!
//! The socket itself lives in the host process's own client (`host/src/plugin-websocket.ts`): this
//! application has exactly one place with a WebSocket implementation and it is that one. What lives
//! *here* is the number - eight per installation - and the ids, because two things about a socket are
//! this side's to decide:
//!
//! - **How many.** The ceiling belongs to the installation the manifest described, not to the host
//!   process's global list: an installation that opened eight has spent its own allowance and another
//!   plugin's are untouched.
//! - **Which ids are its own.** The host issues an id and answers `not_found` for one it does not
//!   hold, but a plugin that named *another* plugin's id would be asking the host a question about
//!   somebody else's socket. This table is what makes that question unaskable: a call is answered
//!   against the caller's own set, and an id outside it never becomes a frame.
//!
//! **Owner / bound / release.** Owned by `AppState` for the process's life. Bounded by
//! [`SOCKETS_MAX`] ids per installation. Released by `close`, by the installation's process stopping
//! or being disabled ([`PluginSockets::take_all`], whose caller also tells the host to close them),
//! and by the application exiting - the host closes every socket it holds on the way out.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

/// Sockets one installation may hold open. Mirrors `PLUGIN_WS_SOCKETS_MAX`.
pub(crate) const SOCKETS_MAX: usize = 8;

/// The socket ids each installation owns.
#[derive(Default)]
pub(crate) struct PluginSockets {
    by_key: Mutex<HashMap<String, BTreeSet<String>>>,
}

impl PluginSockets {
    /// Issues one id for an installation, or `None` when it already holds [`SOCKETS_MAX`].
    ///
    /// The id is this application's, not the plugin's: it is derived from the installation's own key
    /// and a counter, so two installations cannot collide and a plugin cannot choose an id that says
    /// something about another one.
    pub(crate) fn issue(&self, key: &str) -> Option<String> {
        let mut table = self.lock();
        let held = table.entry(key.to_owned()).or_default();
        if held.len() >= SOCKETS_MAX {
            return None;
        }
        let mut sequence = held.len() + 1;
        loop {
            let candidate = format!("ws-{sequence}");
            if !held.contains(&candidate) {
                held.insert(candidate.clone());
                return Some(candidate);
            }
            sequence += 1;
        }
    }

    /// Whether this installation holds that id - the check every `send`/`close`/`receive` makes before
    /// a frame is built.
    pub(crate) fn holds(&self, key: &str, socket_id: &str) -> bool {
        self.lock()
            .get(key)
            .map(|held| held.contains(socket_id))
            .unwrap_or(false)
    }

    /// Forgets one id; `false` when this installation did not hold it.
    pub(crate) fn release(&self, key: &str, socket_id: &str) -> bool {
        let mut table = self.lock();
        let Some(held) = table.get_mut(key) else {
            return false;
        };
        let removed = held.remove(socket_id);
        if held.is_empty() {
            table.remove(key);
        }
        removed
    }

    /// Forgets every id one installation holds, answering them so the caller can close them.
    pub(crate) fn take_all(&self, key: &str) -> Vec<String> {
        self.lock()
            .remove(key)
            .map(|held| held.into_iter().collect())
            .unwrap_or_default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, BTreeSet<String>>> {
        self.by_key
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_installation_may_hold_eight_and_no_more() {
        let sockets = PluginSockets::default();
        for _ in 0..SOCKETS_MAX {
            assert!(sockets.issue("install-a").is_some());
        }
        assert!(
            sockets.issue("install-a").is_none(),
            "the ninth socket is refused"
        );
        assert!(
            sockets.issue("install-b").is_some(),
            "another installation's allowance is its own"
        );
    }

    #[test]
    fn an_id_is_held_by_one_installation_only() {
        let sockets = PluginSockets::default();
        let id = sockets.issue("install-a").expect("the first socket");
        assert!(sockets.holds("install-a", &id));
        assert!(
            !sockets.holds("install-b", &id),
            "another installation cannot address a socket it does not hold"
        );
        assert!(sockets.release("install-a", &id));
        assert!(!sockets.holds("install-a", &id));
        assert!(
            sockets.issue("install-a").is_some(),
            "a released id gives its slot back"
        );
    }

    #[test]
    fn a_stop_takes_every_id_and_leaves_nothing_behind() {
        let sockets = PluginSockets::default();
        sockets.issue("install-a");
        sockets.issue("install-a");
        let taken = sockets.take_all("install-a");
        assert_eq!(taken.len(), 2);
        assert_eq!(sockets.take_all("install-a"), Vec::<String>::new());
    }
}

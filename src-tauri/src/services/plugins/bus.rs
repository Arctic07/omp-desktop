//! The plugin bus: one topic table and one subscription set, for plugins that declare `bus.publish`
//! and `bus.subscribe` (`omp.desktop` API 0.2.0).
//!
//! It is deliberately *not* a second event system. The engine already has one for its own
//! extensions (`@oh-my-pi`'s event bus), and this application already has one per conversation (the
//! session pipes). What neither of them is, is a channel *between two plugins' resident processes*
//! that this desktop can bound and attribute - which is the whole of what this module adds:
//!
//! - **A topic's owner is part of its name.** `plugin:<owner>/<name>`, and the bridge refuses a
//!   publish whose `<owner>` is not the publisher's own id (`bridge::capabilities`). Two plugins
//!   therefore cannot impersonate each other, and a subscriber does not have to trust the payload's
//!   `from` field - the topic it arrived on is the attribution.
//! - **Every table here is bounded, and the bounds are the reason it exists.** [`TOPICS_MAX`]
//!   topics, [`SUBSCRIBERS_MAX`] subscribers per topic, [`PUBLISH_PER_SECOND_MAX`] publishes per
//!   installation per second. A bus without those is an unbounded fan-out in a process the user did
//!   not write.
//! - **No subscription outlives its process.** A subscription names an installation, not a handler:
//!   the process supervisor drops every entry for a key when that key's child goes away
//!   ([`PluginBus::unsubscribe_all`]), and a delivery that cannot reach a live child prunes the
//!   subscriber on the spot. Nothing here holds a callback, so there is nothing to leak.
//!
//! Delivery is *not* here: `publish` answers the subscriber list and the caller
//! (`BridgeEffects::bus_publish`) writes the frames. One place that knows how a worker is addressed
//! is the supervisor's, and this module stays a table a test can drive with nothing running.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Topics this bus tracks at once. Mirrors `PLUGIN_BUS_TOPICS_MAX`.
pub(crate) const TOPICS_MAX: usize = 256;
/// Subscribers one topic may hold. Mirrors `PLUGIN_BUS_SUBSCRIBERS_MAX`.
pub(crate) const SUBSCRIBERS_MAX: usize = 16;
/// Publishes one installation may make inside [`PUBLISH_WINDOW`].
/// Mirrors `PLUGIN_BUS_PUBLISH_PER_SECOND_MAX`.
pub(crate) const PUBLISH_PER_SECOND_MAX: usize = 100;
const PUBLISH_WINDOW: Duration = Duration::from_secs(1);

/// One subscriber: the installation that asked, and the child a delivery goes to.
///
/// `key` is what a stop names (the same string the supervisor files a child under), and the pair
/// `install`/`scope` is what the supervisor needs to find that child again. Both are carried because
/// one is the identity a subscription is released by and the other is the address a frame is written
/// to; deriving either from the other would mean guessing at the supervisor's key format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Subscriber {
    /// The installation's key (`pages::origin_key`): what a stop releases, and what a delivery is
    /// pruned by when its child has gone.
    pub(crate) key: String,
    /// The pair the supervisor files a child under, which is what a frame is addressed by.
    pub(crate) plugin_id: String,
    pub(crate) scope: String,
}

/// The bus's whole state: which topics exist, who listens on them, and how much each installation has
/// published lately.
#[derive(Default)]
pub(crate) struct PluginBus {
    /// Owner: `AppState` for the process's life. Bound: [`TOPICS_MAX`]. Release: a topic leaves when
    /// its last subscriber does, and every entry for a key leaves with that key.
    topics: std::sync::Mutex<BTreeMap<String, Vec<Subscriber>>>,
    /// Which topics each installation subscribed to, so a re-subscribe replaces rather than adds and a
    /// stop releases exactly what that installation held.
    ///
    /// Its size is implied by the topic table's (`SUBSCRIBERS_MAX` × `TOPICS_MAX`), which is the
    /// reason it needs no bound of its own.
    subscriptions: std::sync::Mutex<HashMap<String, BTreeSet<String>>>,
    /// The publishes each installation has made in the current window.
    published: std::sync::Mutex<HashMap<String, (Instant, usize)>>,
}

impl PluginBus {
    /// Records one installation's subscription set and answers what it now holds.
    ///
    /// The call *replaces* the previous set: a plugin that subscribes twice holds what it asked for
    /// the second time, and a subscription it dropped stops arriving. That is what keeps this table
    /// from growing per call, and it is the behaviour a `subscribe(list)` naturally reads as.
    ///
    /// A topic over [`SUBSCRIBERS_MAX`] is refused rather than dropped: the caller named it, and a
    /// subscription that silently did not happen is a handler that never fires.
    pub(crate) fn subscribe(
        &self,
        subscriber: &Subscriber,
        topics: &[String],
    ) -> Result<Vec<String>, ()> {
        let mut table = self.lock_topics();
        // The whole call is refused before anything is written, so a refused set leaves the previous
        // one in place - half a subscription list is not the list the plugin asked for.
        for topic in topics {
            let known = table.get(topic).map(|list| list.len()).unwrap_or(0);
            let already = table
                .get(topic)
                .map(|list| list.iter().any(|entry| entry.key == subscriber.key))
                .unwrap_or(false);
            if !already && known >= SUBSCRIBERS_MAX {
                return Err(());
            }
        }
        // A topic nobody has opened yet is a new row in the table, so the topic ceiling is checked
        // against the ones the call would add rather than against the ones it names.
        let new_topics: BTreeSet<String> = topics.iter().cloned().collect();
        let added = new_topics
            .iter()
            .filter(|topic| !table.contains_key(*topic))
            .count();
        if table.len() + added > TOPICS_MAX {
            return Err(());
        }
        let mut held = self.lock_subscriptions();
        if let Some(previous) = held.get(&subscriber.key) {
            for topic in previous.difference(&new_topics) {
                if let Some(list) = table.get_mut(topic) {
                    list.retain(|entry| entry.key != subscriber.key);
                    if list.is_empty() {
                        table.remove(topic);
                    }
                }
            }
        }
        for topic in &new_topics {
            let list = table.entry(topic.clone()).or_default();
            if !list.iter().any(|entry| entry.key == subscriber.key) {
                list.push(subscriber.clone());
            }
        }
        held.insert(subscriber.key.clone(), new_topics.clone());
        Ok(new_topics.into_iter().collect())
    }

    /// Drops every subscription one installation holds; the topics it alone listened on go with it.
    pub(crate) fn unsubscribe_all(&self, key: &str) {
        let mut held = self.lock_subscriptions();
        let Some(topics) = held.remove(key) else {
            return;
        };
        drop(held);
        let mut table = self.lock_topics();
        for topic in topics {
            if let Some(list) = table.get_mut(&topic) {
                list.retain(|entry| entry.key != key);
                if list.is_empty() {
                    table.remove(&topic);
                }
            }
        }
    }

    /// The subscribers one topic has right now, in the order they asked.
    pub(crate) fn subscribers(&self, topic: &str) -> Vec<Subscriber> {
        self.lock_topics().get(topic).cloned().unwrap_or_default()
    }

    /// Takes one publish from an installation's budget; `false` when the minute's allowance is spent.
    ///
    /// A rolling second rather than a token bucket: the point is that a plugin cannot make this
    /// process fan a message out faster than a hundred times a second, and a window that resets once
    /// is simpler to reason about (and to test) than a refill rate nobody can observe.
    pub(crate) fn take_publish(&self, key: &str, now: Instant) -> bool {
        let mut published = self.lock_published();
        let entry = published.entry(key.to_owned()).or_insert((now, 0));
        if now.duration_since(entry.0) >= PUBLISH_WINDOW {
            *entry = (now, 0);
        }
        if entry.1 >= PUBLISH_PER_SECOND_MAX {
            return false;
        }
        entry.1 += 1;
        true
    }

    /// How many topics the table is holding, for the tests.
    #[cfg(test)]
    pub(crate) fn topic_count(&self) -> usize {
        self.lock_topics().len()
    }

    /// One message as a subscriber's process receives it.
    ///
    /// The frame is the worker's (`host/src/plugin-worker/frames.ts`): `worker_event`, one topic, the
    /// publisher's id and the payload verbatim. It is built here because the shape is the bus's
    /// contract with the worker and not the supervisor's business.
    pub(crate) fn event_frame(topic: &str, from: &str, payload: &Value) -> Value {
        json!({
            "type": "worker_event",
            "event": { "topic": topic, "from": from, "payload": payload },
        })
    }

    fn lock_topics(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Vec<Subscriber>>> {
        self.topics
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_subscriptions(&self) -> std::sync::MutexGuard<'_, HashMap<String, BTreeSet<String>>> {
        self.subscriptions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_published(&self) -> std::sync::MutexGuard<'_, HashMap<String, (Instant, usize)>> {
        self.published
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subscriber(key: &str) -> Subscriber {
        Subscriber {
            key: key.to_owned(),
            plugin_id: format!("plugin-{key}"),
            scope: "user".to_owned(),
        }
    }

    #[test]
    fn a_subscription_is_replaced_not_accumulated() {
        let bus = PluginBus::default();
        let first = subscriber("a");
        bus.subscribe(
            &first,
            &["plugin:a/one".to_owned(), "plugin:a/two".to_owned()],
        )
        .expect("two topics are inside every bound");
        let held = bus
            .subscribe(&first, &["plugin:a/one".to_owned()])
            .expect("a narrower set is legal");
        assert_eq!(held, vec!["plugin:a/one".to_owned()]);
        assert_eq!(
            bus.subscribers("plugin:a/two"),
            Vec::new(),
            "a topic the plugin no longer listens on is released with the re-subscribe"
        );
    }

    #[test]
    fn the_subscriber_ceiling_is_refused_rather_than_trimmed() {
        let bus = PluginBus::default();
        let topic = "plugin:a/crowded".to_owned();
        for index in 0..SUBSCRIBERS_MAX {
            bus.subscribe(&subscriber(&format!("s{index}")), &[topic.clone()])
                .expect("within the ceiling");
        }
        assert!(
            bus.subscribe(&subscriber("late"), &[topic.clone()])
                .is_err(),
            "the seventeenth subscriber is refused, and nothing was written"
        );
        assert_eq!(bus.subscribers(&topic).len(), SUBSCRIBERS_MAX);
    }

    #[test]
    fn a_stop_releases_every_topic_the_installation_held() {
        let bus = PluginBus::default();
        let one = subscriber("one");
        bus.subscribe(
            &one,
            &["plugin:one/x".to_owned(), "plugin:other/y".to_owned()],
        )
        .expect("two topics");
        bus.unsubscribe_all(&one.key);
        assert_eq!(
            bus.topic_count(),
            0,
            "a topic with no subscriber leaves the table"
        );
    }

    #[test]
    fn the_publish_budget_resets_after_its_window() {
        let bus = PluginBus::default();
        let start = Instant::now();
        for _ in 0..PUBLISH_PER_SECOND_MAX {
            assert!(bus.take_publish("key", start));
        }
        assert!(
            !bus.take_publish("key", start),
            "the window's allowance is spent"
        );
        assert!(
            bus.take_publish("key", start + Duration::from_secs(1)),
            "the next window starts empty"
        );
    }
}

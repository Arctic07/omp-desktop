//! The child sessions whose own events this process draws: one projector per subagent transcript
//! that has published a turn, so a screen attached to that transcript renders exactly the frames a
//! conversation renders.
//!
//! A child's own events arrive already addressed to its transcript (`subagent_event`, see
//! `protocol.rs::on_subagent_event`), and the desktop draws them with the one reducer it has -
//! `src/stores/sessionEvents.ts`, the same one a conversation's frames go through. What that
//! reducer reads is *this process's* vocabulary, not the engine's: forwarding an engine event as it
//! arrives publishes a frame no reader of that channel can read (the frontend's `SessionEvent`
//! union has no member for it), which is what a child's live turn silently was - a running child
//! drew a transcript read from disk and a closing line nothing could ever settle.
//!
//! The projection itself is the projector every conversation uses (`events.rs::EventState`): one
//! implementation, so a child's row and a conversation's row cannot disagree about what a message,
//! a tool call or a turn boundary looks like - and so the frontend keeps one reducer rather than a
//! second vocabulary for children. What a child does not have is a record to project *through*: it
//! is not a conversation of this process, and by design nothing opens, lists, addresses, evicts or
//! rebuilds it (`on_subagent_event`). The projector is therefore carried by a `SessionRuntime` that
//! is deliberately never registered: every path that could treat one as a conversation - the
//! registry, the eviction candidate, the restore queue, `session_state`, `session_close` - reads
//! `HostState::sessions`, and this map is not that map. The record exists for its `emit` (which
//! writes on the child's own channel, since the channel is its routing id) and for the two bits the
//! delivery window reads; the session facts it is built with are the child's own and are never
//! opened, addressed or listed.
//!
//! Owner: the host runtime (`HostInner`), for the life of the process. Bound:
//! `CHILD_PROJECTIONS_MAX` rows, the child whose stream has been quiet the longest dropped first,
//! because a projector is a handful of ids plus the increments one delivery window holds, and the
//! children a reader is still watching are the ones still speaking. Released: with the generation
//! that published them (`clear`, called when the host exits - the engine sessions behind those
//! events are gone with it) and with the runtime itself.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use super::session::SessionRuntime;

/// Projectors one process keeps at once.
///
/// A child that has settled keeps its row until newer spawns push it out: its last frames may
/// still be in flight, and re-creating the projector would restart the ids its rows are keyed by.
const CHILD_PROJECTIONS_MAX: usize = 16;

/// The projectors of the children whose own events this process is drawing.
pub(crate) struct ChildProjections {
    inner: Mutex<Inner>,
    /// How many projectors the map holds, so the delivery window can skip it without a lock.
    ///
    /// That pass runs on every inbound frame - the host streams on exactly this path, per token -
    /// and a process with no child transcript ever projected (the ordinary case: no screen is
    /// attached to a subagent) must not pay a map lock per frame for nothing. One relaxed load,
    /// and only a non-zero count asks the map.
    count: AtomicUsize,
}

#[derive(Default)]
struct Inner {
    /// Ids in the order they were last heard from, least recent first, so the cap drops the child a
    /// reader is least likely to still be watching.
    order: VecDeque<String>,
    states: HashMap<String, Arc<SessionRuntime>>,
}

/// Moves one id to the back of an order list, marking it the one heard from most recently.
///
/// The list is short (bounded by `CHILD_PROJECTIONS_MAX`), so a linear scan is the whole of it, and
/// an id that is not in it is appended rather than ignored: a caller that names a child the list has
/// not seen is naming one it is about to hold.
fn touch(order: &mut VecDeque<String>, id: &str) {
    if let Some(position) = order.iter().position(|known| known == id) {
        order.remove(position);
    }
    order.push_back(id.to_owned());
}

impl ChildProjections {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            count: AtomicUsize::new(0),
        }
    }

    /// The projector one child's own events are projected by, created the first time one arrives.
    ///
    /// `cwd` and `file` are the child's own facts as the frame that named it reported them - the
    /// conversation it belongs to ran it, and the validated frame named the transcript the engine
    /// writes for it. Nothing reads them again: the record is a projector, not a session.
    ///
    /// Every call marks the child as the most recent one, so a full map sheds the child whose
    /// stream has been quiet the longest rather than the one that happened to start first: a
    /// projector dropped mid-turn would restart the ids its rows are keyed by, and the child that
    /// is streaming right now is the one a screen is attached to.
    pub(crate) fn projector(&self, id: &str, cwd: &str, file: &str) -> Arc<SessionRuntime> {
        let mut inner = super::lock(&self.inner);
        if let Some(existing) = inner.states.get(id) {
            let projector = existing.clone();
            touch(&mut inner.order, id);
            return projector;
        }
        while inner.order.len() >= CHILD_PROJECTIONS_MAX {
            let Some(oldest) = inner.order.pop_front() else {
                break;
            };
            if inner.states.remove(&oldest).is_some() {
                self.count.fetch_sub(1, Ordering::Relaxed);
            }
        }
        let projector = Arc::new(SessionRuntime::new(
            id.to_owned(),
            cwd.to_owned(),
            None,
            Some(file.to_owned()),
        ));
        inner.order.push_back(id.to_owned());
        inner.states.insert(id.to_owned(), projector.clone());
        self.count.fetch_add(1, Ordering::Relaxed);
        projector
    }

    /// One child's projector, when this process already has one for it.
    ///
    /// Read by the paths that have a child's id and no frame of their own to hand it: the child's
    /// next event (`protocol.rs::on_subagent_event`, which resolves the child's own facts only when
    /// this answers none - a `cwd` read per token would be a lock per token for a fact nothing
    /// reads) and the roster's settle edge (`protocol.rs::settle_child_channel`). A child no screen
    /// ever opened has no projector, and "none" is the answer rather than a reason to create one -
    /// an idle frame must not bring a channel to life.
    ///
    /// This access counts as hearing from the child, exactly as `projector` does: what the cap
    /// sheds is the child whose stream went quiet longest, and a frame arriving is the opposite of
    /// quiet.
    pub(crate) fn get(&self, id: &str) -> Option<Arc<SessionRuntime>> {
        let mut inner = super::lock(&self.inner);
        let projector = inner.states.get(id)?.clone();
        touch(&mut inner.order, id);
        Some(projector)
    }

    /// Whether this process projects any child at all.
    ///
    /// Asked by the delivery window before it touches the map: the pass runs per inbound frame, and
    /// a desktop showing no subagent transcript - the ordinary case - must not pay a lock for it.
    pub(crate) fn has_children(&self) -> bool {
        self.count.load(Ordering::Relaxed) != 0
    }

    /// Every child whose projector is holding increments the delivery window has not sent yet.
    ///
    /// Asked by the same pass that flushes the conversations, and read the same way: the flag is
    /// checked before the projector's own lock is taken, so a child with nothing buffered costs one
    /// atomic load rather than a lock on a pass that runs per inbound frame.
    pub(crate) fn pending(&self) -> Vec<Arc<SessionRuntime>> {
        super::lock(&self.inner)
            .states
            .values()
            .filter(|projector| projector.has_pending_deltas())
            .cloned()
            .collect()
    }

    /// Every child whose events this process has projected, for the paths that end them all at
    /// once: the host's own exit is the only one, and it reports the same failure to each channel
    /// it was drawing before it drops them.
    pub(crate) fn all(&self) -> Vec<Arc<SessionRuntime>> {
        super::lock(&self.inner).states.values().cloned().collect()
    }

    /// Drops every projector: the host that published those events is gone, so nothing will ever
    /// settle, extend or end what they hold.
    pub(crate) fn clear(&self) {
        let mut inner = super::lock(&self.inner);
        inner.order.clear();
        inner.states.clear();
        self.count.store(0, Ordering::Relaxed);
    }

    /// Rows this map holds; the bound is what the cap test asserts against.
    #[cfg(test)]
    fn tracked(&self) -> usize {
        super::lock(&self.inner).states.len()
    }

    /// The lock-free skip count, which the tests hold against the map it describes.
    #[cfg(test)]
    fn counted(&self) -> usize {
        self.count.load(Ordering::Relaxed)
    }

    /// Whether one child is still tracked; the cap test reads which one went.
    #[cfg(test)]
    fn has(&self, id: &str) -> bool {
        super::lock(&self.inner).states.contains_key(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One child keeps one projector: the frames that describe a turn are keyed by the ids it
    /// minted, so a second projector for the same child would open a second set of rows.
    #[test]
    fn one_child_keeps_one_projector() {
        let projections = ChildProjections::new();
        let file = "C:/sessions/parent/Scout1.jsonl";
        let first = projections.projector("Scout1", "C:/workspace", file);
        let again = projections.projector("Scout1", "C:/workspace", file);
        assert!(Arc::ptr_eq(&first, &again), "the same child projects once");
        assert_eq!(projections.tracked(), 1);
    }

    /// The cap keeps the children that are still speaking and drops the quietest one: a projector is
    /// a live window, and a child nobody has heard from in sixteen frames is not one a screen is
    /// still attached to. A child that speaks again moves to the back of that order, so the one
    /// dropped is never the one streaming right now.
    #[test]
    fn the_quietest_projector_is_the_one_dropped() {
        let projections = ChildProjections::new();
        projections.projector("child-0", "", "C:/sessions/parent/child-0.jsonl");
        for index in 1..CHILD_PROJECTIONS_MAX + 3 {
            projections.projector(
                &format!("child-{index}"),
                "",
                &format!("C:/sessions/parent/child-{index}.jsonl"),
            );
        }
        assert_eq!(projections.tracked(), CHILD_PROJECTIONS_MAX);
        assert!(
            !projections.has("child-0"),
            "the child whose stream went quiet first is the one shed"
        );
        // And a frame for a child that is still here keeps it here: the map is full, and the child
        // that just spoke must not be the next victim.
        let file = "C:/sessions/parent/child-18.jsonl";
        let speaking = projections.projector("child-18", "", file);
        let newcomer = projections.projector(
            &format!("child-{}", CHILD_PROJECTIONS_MAX + 3),
            "",
            "C:/sessions/parent/child-new.jsonl",
        );
        assert!(Arc::ptr_eq(
            &speaking,
            &projections.projector("child-18", "", file)
        ));
        assert!(!Arc::ptr_eq(&newcomer, &speaking));
        assert_eq!(
            projections.tracked(),
            CHILD_PROJECTIONS_MAX,
            "and the cap holds"
        );
    }

    /// The flush pass reads the same flag the conversation pass reads: a projector with nothing
    /// buffered is not returned, and one that buffered an increment is.
    #[test]
    fn only_projectors_holding_increments_are_pending() {
        let projections = ChildProjections::new();
        let child = projections.projector("Scout1", "", "C:/sessions/parent/Scout1.jsonl");
        assert!(projections.pending().is_empty(), "nothing buffered yet");
        child.mark_delta_pending();
        assert_eq!(projections.pending().len(), 1);
        child.clear_delta_pending();
        assert!(
            projections.pending().is_empty(),
            "delivered increments are not pending"
        );
    }

    /// A host that exited takes its children's projectors with it: no frame can arrive for them
    /// any more, and a later host speaks about new children only.
    #[test]
    fn an_exited_host_leaves_no_projectors_behind() {
        let projections = ChildProjections::new();
        projections.projector("Scout1", "", "C:/sessions/parent/Scout1.jsonl");
        projections.clear();
        assert_eq!(projections.tracked(), 0);
        assert!(projections.pending().is_empty());
    }

    /// The delivery window skips the map on the count alone, so a count that drifted would be a
    /// silent stall (`has_children()` false while rows exist: no child increment would ever be
    /// delivered) or a lock per frame for nothing (true while empty). It is held against the map
    /// through creation, the cap's own shedding, and a host that exited.
    #[test]
    fn the_skip_count_never_drifts_from_the_map() {
        let projections = ChildProjections::new();
        assert_eq!(projections.counted(), 0);
        assert!(!projections.has_children());
        let file = "C:/sessions/parent/Scout1.jsonl";
        projections.projector("Scout1", "", file);
        assert_eq!(projections.counted(), projections.tracked());
        assert!(projections.has_children());
        for index in 0..CHILD_PROJECTIONS_MAX + 4 {
            projections.projector(&format!("child-{index}"), "", file);
        }
        assert_eq!(
            projections.counted(),
            projections.tracked(),
            "the shed rows left the count with the map"
        );
        assert!(projections.has_children(), "a full map is not an empty one");
        projections.clear();
        assert_eq!(projections.counted(), 0);
        assert!(!projections.has_children());
        projections.projector("Scout2", "", file);
        assert!(
            projections.has_children(),
            "and the child that arrives after an exit is seen again"
        );
    }
}

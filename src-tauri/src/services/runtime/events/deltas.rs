//! Streamed text, held until the delivery window opens.
//!
//! Split out of [`super`] when the projector outgrew one file (`rules.md#single-file-line-limit`). One concern: what
//! one message's stream has accumulated but not yet published, and when that becomes due.

use std::collections::HashMap;

use super::super::DELTA_FLUSH_BYTES;

/// Which field of the streaming message a delta belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeltaKind {
    Text,
    Thinking,
}

/// Accumulated delta text that has not been delivered yet.
#[derive(Default, Debug)]
pub(crate) struct DeltaBuffer {
    pub(crate) text: String,
    pub(crate) thinking: String,
}

impl DeltaBuffer {
    /// Adds one fragment to the field of the message it belongs to.
    pub(crate) fn record(&mut self, kind: DeltaKind, delta: &str) {
        match kind {
            DeltaKind::Text => self.text.push_str(delta),
            DeltaKind::Thinking => self.thinking.push_str(delta),
        }
    }
}

/// Pending deltas plus the delivery clock.
///
/// Streaming must not cross the IPC boundary once per token, so deltas accumulate and are
/// delivered at most once per window. The window ends early when the buffer would exceed the
/// frame budget, and terminal events deliver unconditionally through `EventState::flush`.
#[derive(Default)]
pub(crate) struct DeltaSet {
    pub(crate) buffers: HashMap<String, DeltaBuffer>,
    order: Vec<String>,
    pub(crate) last_delivery_ms: i64,
}

impl DeltaSet {
    pub(crate) fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    fn buffered_bytes(&self) -> usize {
        self.buffers
            .values()
            .map(|buffer| buffer.text.len() + buffer.thinking.len())
            .sum()
    }

    pub(crate) fn push(&mut self, message_id: &str, kind: DeltaKind, delta: &str) {
        let buffer = self.buffers.entry(message_id.to_owned()).or_default();
        buffer.record(kind, delta);
        if !self.order.iter().any(|known| known == message_id) {
            self.order.push(message_id.to_owned());
        }
    }

    /// True when a delivery is due: the window elapsed, or the buffer is already at the
    /// frame budget.
    pub(crate) fn due(&self, now_ms: i64, window_ms: i64) -> bool {
        if self.is_empty() {
            return false;
        }
        self.buffered_bytes() >= DELTA_FLUSH_BYTES
            || now_ms.saturating_sub(self.last_delivery_ms) >= window_ms
    }

    /// Takes everything buffered and restarts the window.
    pub(crate) fn take(&mut self, now_ms: i64) -> Vec<(String, DeltaBuffer)> {
        self.last_delivery_ms = now_ms;
        std::mem::take(&mut self.order)
            .into_iter()
            .filter_map(|message_id| {
                self.buffers
                    .remove(&message_id)
                    .map(|buffer| (message_id, buffer))
            })
            .collect()
    }
}

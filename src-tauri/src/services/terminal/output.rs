//! The pty's output path: coalescing, backpressure, and the flusher thread.
//!
//! Every frame the terminal sends is one IPC message, and every message is one `eval` on the
//! window's main thread. Sending each 16 KiB pty read on its own put a build's output on that
//! thread faster than it could paint or take input: measured 2026-11-03, a terminal build stalled
//! the main thread 42.6 s inside wry's per-message `RedrawWindow`, and the host was killed by the
//! liveness probe while the window could not answer anything.
//!
//! Three rules keep this path from doing that again:
//!
//! - **Coalesce.** The reader queues bytes; the flusher sends one frame per display interval
//!   ([`FLUSH_INTERVAL`]) or per [`FLUSH_BYTES`], whichever comes first.
//! - **Never feed a stalled window.** While `main_thread_watch` reports a stall, the flusher sends
//!   nothing. The queue is what has to drain for the window to answer, and adding to it is the one
//!   thing that cannot help.
//! - **Bound the buffer.** The reader stops taking bytes from the pty at [`PENDING_LIMIT`], so a
//!   build waits on its own pipe instead of this process growing without end. The flusher sends at
//!   most [`FLUSH_BYTES`] per frame, so a backlog drains in bounded chunks rather than one huge
//!   long task; an attach or exit may send the bounded pending buffer at once.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::models::TerminalFrame;

use super::{lock, Session};

/// How long pty output waits for company before it is sent as one frame.
///
/// One display frame is the longest delay a reader cannot see, and it bounds a fast producer to one
/// message per interval.
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);

/// Output that reaches this size is sent without waiting for the interval.
///
/// A burst then costs one frame per this many bytes instead of one per pty read, and the wait
/// cannot let the pending buffer grow without bound while the pty keeps filling it. It is also the
/// ceiling on one frame: a backlog is drained in chunks of this size, not as one long main-thread
/// task.
const FLUSH_BYTES: usize = 256 * 1024;

/// Output this process will hold while the window is not draining it.
///
/// The reader stops taking bytes from the pty at this point, so the shell's own pipe backs up and a
/// build waits instead of this process growing without end. It is deliberately small: the
/// terminal's own ring keeps 128 KiB for the screen, and a reader who comes back needs the tail,
/// not every byte a build printed while the window was frozen.
const PENDING_LIMIT: usize = 4 * 1024 * 1024;

/// How often the flusher looks again while the main thread is in a reported stall.
///
/// It does not send during the stall: each send is one main-thread closure, and the queue is the
/// thing that has to drain for the window to answer. The pending buffer holds the output instead.
const STALL_RECHECK: Duration = Duration::from_millis(50);

/// Output the reader has taken from the pty but no frame has carried yet.
pub(super) struct Pending {
    bytes: Mutex<Vec<u8>>,
    /// Wakes the flusher when output is queued, or when the pty stream ends.
    ready: Condvar,
    /// Set when no more output can arrive: the reader saw EOF, or the session is being killed.
    closed: AtomicBool,
}

impl Pending {
    pub(super) fn new() -> Self {
        Self {
            bytes: Mutex::new(Vec::new()),
            ready: Condvar::new(),
            closed: AtomicBool::new(false),
        }
    }

    /// Queues pty output for the flusher.
    ///
    /// Called from the pty reader thread. A flusher waiting for the first byte wakes now; one
    /// inside the coalescing window is left alone until the window closes, or until the batch is
    /// full - notifying it on every read would send one frame per read again.
    pub(super) fn push(&self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let (wake, full) = {
            let mut bytes = lock(&self.bytes);
            let was_empty = bytes.is_empty();
            bytes.extend_from_slice(data);
            (was_empty, bytes.len() >= FLUSH_BYTES)
        };
        if wake || full {
            self.ready.notify_one();
        }
    }

    /// Marks the stream over and wakes the flusher to drain and leave.
    pub(super) fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.ready.notify_all();
    }

    pub(super) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    pub(super) fn len(&self) -> usize {
        lock(&self.bytes).len()
    }

    /// True when the reader must stop taking bytes from the pty until the flusher catches up.
    pub(super) fn over_limit(&self) -> bool {
        self.len() >= PENDING_LIMIT
    }

    /// Everything queued, for an attach replay or the exit frame.
    pub(super) fn take(&self) -> Vec<u8> {
        std::mem::take(&mut *lock(&self.bytes))
    }

    /// At most one frame's worth, leaving the rest for the next interval.
    fn take_batch(&self) -> Vec<u8> {
        let mut bytes = lock(&self.bytes);
        let take = bytes.len().min(FLUSH_BYTES);
        bytes.drain(..take).collect()
    }
}

/// The flusher thread: waits for output, sends it in bounded frames, and leaves when the stream
/// closes. See this module's header for the rules.
pub(super) fn run(session: Arc<Session>) {
    // The first batch is due immediately; later ones keep one display frame between them even when
    // a backlog has to be drained.
    let mut last_sent = Instant::now() - FLUSH_INTERVAL;
    loop {
        // Wait for output, or for the stream to end.
        {
            let mut bytes = lock(&session.pending.bytes);
            while bytes.is_empty() && !session.pending.is_closed() {
                bytes = session
                    .pending
                    .ready
                    .wait(bytes)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            if bytes.is_empty() && session.pending.is_closed() {
                return;
            }
            // A fast producer gets the rest of the display frame to fill the batch; a batch
            // already at the ceiling goes now.
            if bytes.len() < FLUSH_BYTES && !session.pending.is_closed() {
                let (guard, _) = session
                    .pending
                    .ready
                    .wait_timeout(bytes, FLUSH_INTERVAL)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                drop(guard);
            }
        }
        // A window that cannot run its own posted closure cannot draw this frame. Waiting keeps
        // the main-thread queue from growing while it is the thing that has to drain.
        if crate::services::main_thread_watch::stalled() {
            let bytes = lock(&session.pending.bytes);
            let _ = session
                .pending
                .ready
                .wait_timeout(bytes, STALL_RECHECK)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            continue;
        }
        let due = last_sent + FLUSH_INTERVAL;
        if let Some(wait) = due.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
        // Everything below the replay lock: a subscriber that attaches while this frame is pending
        // gets it through the ring replay instead, never twice.
        let _replay_guard = lock(&session.replay_lock);
        let bytes = session.pending.take_batch();
        if bytes.is_empty() {
            continue;
        }
        session.broadcast_locked(TerminalFrame::Data {
            data: STANDARD.encode(bytes),
        });
        last_sent = Instant::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_flushed_frame_never_exceeds_the_batch_ceiling() {
        let pending = Pending::new();
        pending.push(&vec![b'x'; FLUSH_BYTES + 7]);
        assert_eq!(pending.len(), FLUSH_BYTES + 7);
        let first = pending.take_batch();
        assert_eq!(first.len(), FLUSH_BYTES, "one frame is capped");
        assert_eq!(pending.len(), 7, "the rest waits for the next interval");
        assert_eq!(pending.take(), vec![b'x'; 7]);
    }

    #[test]
    fn the_reader_is_told_when_the_buffer_is_full() {
        let pending = Pending::new();
        pending.push(&vec![b'x'; PENDING_LIMIT - 1]);
        assert!(!pending.over_limit());
        pending.push(b"x");
        assert!(pending.over_limit(), "the pty reader backs off at the cap");
        pending.close();
        assert!(pending.is_closed());
    }
}

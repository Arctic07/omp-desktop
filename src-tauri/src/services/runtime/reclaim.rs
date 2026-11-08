//! The engine's share of a cache clear: what its own process reclaimed inside its own tree.
//!
//! `rules.md#engine-integration-and-data-ownership` makes the engine's data directory read-only to everything else in this
//! application, and its caches are the one kind of file there that can never be recovered by
//! deleting them from outside. So the reclaim is a protocol command (`engine_reclaim`, protocol 28)
//! and this module is its caller.
//!
//! Two callers, one command, two appetites:
//!
//! - **The settings page's clear** ([`reclaim`]) reports its numbers to the page and asks for the
//!   one-day window `host/src/reclaim.ts` uses by default. The reader is watching, and everything it
//!   removes is rebuilt on demand.
//! - **The automatic pass** ([`schedule`]) runs once shortly after start and every six hours after
//!   that, with a [`AUTOMATIC_RECENT_MS`] window. Nobody is watching it, so it keeps more: an
//!   engine build a day old may be the one an older window still runs
//!   (`removed:notes/implemented/architecture/2026-10-28-engine-cache-reclaim.md`).
//!
//! Deliberately best-effort in both: a clear is maintenance, and the host may not be running, may be
//! older than the command, or may time out over a large profile. Every one of those answers is "the
//! engine freed nothing", which is the truth - and the file side of the clear has already done its
//! work by then. Failing the page over the engine's half would report a clear that did happen as one
//! that did not.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};

use crate::services::log;
use crate::services::paths::DataPaths;
use crate::services::runtime::host::HostRuntime;

/// How long the engine's own reclaim may take. It deletes directories of small files - native
/// builds of retired engine versions measured in the hundreds of megabytes - so this is generous
/// where the ordinary commands are not.
const RECLAIM_TIMEOUT_MS: u64 = 60_000;

/// How recently a target may have been written and still count as in use, for the automatic pass.
///
/// A week, against the explicit clear's day: the leftover is a native build of an engine version
/// that may still be the one an older window runs. A day is not enough to tell "the reader gave up
/// on this" from "the reader used this yesterday"; the cost of waiting is one more week of a few
/// hundred megabytes.
pub(crate) const AUTOMATIC_RECENT_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// How long after start the automatic pass runs. Late enough that it never competes with the window
/// and the host's first start - both of which read the same disk - and early enough that a window
/// opened for an afternoon gets one pass.
const AUTOMATIC_START_DELAY: Duration = Duration::from_secs(5 * 60);

/// How often it runs after that: four passes an afternoon, which is far more often than the
/// directories it walks change, and cheap enough (one bounded readdir per target) to be background
/// work rather than a task the reader ever waits on.
const AUTOMATIC_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Set by the one call that registers the pass. The start-up path must not arm it twice: two loops
/// would walk the same tree at the same time and report each other's removals as failures.
static SCHEDULED: AtomicBool = AtomicBool::new(false);

/// What the engine reclaimed, and what it had to leave.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EngineReclaim {
    pub(crate) freed_bytes: u64,
    /// Bytes the engine kept because a target was in use, current, or refused a delete.
    pub(crate) skipped_bytes: u64,
}

/// One `engine_reclaim` answer, as this process reads it.
///
/// The shape is the host's own (`host/src/reclaim.ts`): `freedBytes`, one `removed` row per directory
/// it deleted and one `skipped` row per directory it left, each with `kind`, `bytes` and - for the
/// skipped ones - `reason`. Grouped by kind and by reason because the automatic pass reports what it
/// did in one line, and a support report needs the kinds and the reasons rather than a hundred paths.
#[derive(Debug, Default, PartialEq, Eq)]
struct Answer {
    freed_bytes: u64,
    skipped_bytes: u64,
    /// Bytes removed, per `kind`.
    removed: BTreeMap<String, u64>,
    /// How many targets were left behind and what they weigh, per `reason`.
    skipped: BTreeMap<String, (usize, u64)>,
}

impl Answer {
    fn read(data: &Value) -> Self {
        let mut answer = Answer {
            freed_bytes: data
                .get("freedBytes")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            ..Answer::default()
        };
        for row in rows(data, "removed") {
            let entry = answer.removed.entry(kind_of(row)).or_default();
            *entry = entry.saturating_add(bytes_of(row));
        }
        for row in rows(data, "skipped") {
            let reason = row
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            let bytes = bytes_of(row);
            answer.skipped_bytes = answer.skipped_bytes.saturating_add(bytes);
            let entry = answer.skipped.entry(reason).or_default();
            entry.0 += 1;
            entry.1 = entry.1.saturating_add(bytes);
        }
        answer
    }

    fn reclaim(&self) -> EngineReclaim {
        EngineReclaim {
            freed_bytes: self.freed_bytes,
            skipped_bytes: self.skipped_bytes,
        }
    }

    /// The removals as one clause: `engine-natives=1024, scratch=512`.
    fn removed_clause(&self) -> String {
        self.removed
            .iter()
            .map(|(kind, bytes)| format!("{kind}={bytes}"))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The skips as one clause: `in-use 2 (1024 bytes), current-version 1 (512 bytes)`.
    fn skipped_clause(&self) -> String {
        self.skipped
            .iter()
            .map(|(reason, (count, bytes))| format!("{reason} {count} ({bytes} bytes)"))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Asks the host to reclaim its own caches, answering what it managed.
///
/// A failure is logged and answered as zero: the clear that called this has already emptied what
/// this application owns, and the page's report must not turn that into an error.
pub(crate) async fn reclaim(host: &HostRuntime) -> EngineReclaim {
    let answer = host
        .call_ok(json!({ "type": "engine_reclaim" }), RECLAIM_TIMEOUT_MS)
        .await;
    match answer {
        Ok(data) => {
            let answer = Answer::read(&data);
            let outcome = answer.reclaim();
            // One line in the run's log: the per-target detail lives in the host's own log, where a
            // support report can read it without this process carrying a list across the IPC.
            log::info(&format!(
                "engine reclaim: {} bytes freed, {} bytes kept",
                outcome.freed_bytes, outcome.skipped_bytes
            ));
            outcome
        }
        Err(error) => {
            log::warn(&format!(
                "engine reclaim unavailable: {} ({}); the engine's caches were left alone",
                error.code, error.message
            ));
            EngineReclaim::default()
        }
    }
}

/// The frame the automatic pass sends: the same command, asked with a week-long window.
fn automatic_frame() -> Value {
    json!({ "type": "engine_reclaim", "recentMs": AUTOMATIC_RECENT_MS })
}

/// One automatic pass, and the line it leaves in the run's log.
///
/// A failure is a log line and nothing else: the next pass is six hours away, and an engine that is
/// not running has nothing to reclaim anyway. Nothing here can panic - the answer is read
/// defensively, and a missing or non-numeric field is zero (`Answer::read`).
async fn pass(host: &HostRuntime) -> EngineReclaim {
    match host.call_ok(automatic_frame(), RECLAIM_TIMEOUT_MS).await {
        Ok(data) => {
            let answer = Answer::read(&data);
            let removed = answer.removed_clause();
            let skipped = answer.skipped_clause();
            log::info(&format!(
                "engine reclaim (automatic, {} days untouched): {} bytes freed{}{}",
                AUTOMATIC_RECENT_MS / (24 * 60 * 60 * 1000),
                answer.freed_bytes,
                if removed.is_empty() {
                    String::new()
                } else {
                    format!(" [{removed}]")
                },
                if skipped.is_empty() {
                    String::new()
                } else {
                    format!("; kept [{skipped}]")
                },
            ));
            answer.reclaim()
        }
        Err(error) => {
            log::info(&format!(
                "engine reclaim (automatic) skipped: {} ({})",
                error.code, error.message
            ));
            EngineReclaim::default()
        }
    }
}

/// Registers the automatic pass for the life of the process, answering whether this call was the one.
///
/// Once per process: the second caller would arm a second loop over the same tree, which is why the
/// registration is claimed rather than assumed ([`claim`]).
///
/// Each round does both halves of "disk this application filled without anyone asking": the engine's
/// caches through the protocol ([`pass`]), then the toolchain's own under the pinned home
/// (`services::cache_budget`, held to its ceiling and skipped where it was written within the hour).
pub(crate) fn schedule(runtime: HostRuntime, paths: DataPaths) -> bool {
    if !claim() {
        return false;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(AUTOMATIC_START_DELAY).await;
        loop {
            pass(&runtime).await;
            let toolchain = paths.clone();
            // Blocking: measuring the caches is tens of thousands of `read_dir`s, and removing a
            // crate directory is a real delete. A join failure is a log line, like every other
            // outcome here.
            if tauri::async_runtime::spawn_blocking(move || {
                crate::services::cache_budget::sweep_and_report(&toolchain)
            })
            .await
            .is_err()
            {
                log::warn("toolchain caches: the pass could not run");
            }
            tokio::time::sleep(AUTOMATIC_INTERVAL).await;
        }
    });
    true
}

/// Takes the one registration this process has, answering whether it was already taken.
fn claim() -> bool {
    !SCHEDULED.swap(true, Ordering::SeqCst)
}

/// The rows of one answer's list, or nothing when the field is absent or not a list.
fn rows<'a>(data: &'a Value, key: &str) -> &'a [Value] {
    data.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn kind_of(row: &Value) -> String {
    row.get("kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned()
}

fn bytes_of(row: &Value) -> u64 {
    row.get("bytes").and_then(Value::as_u64).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer() -> Value {
        json!({
            "freedBytes": 4096,
            "removed": [
                { "path": "/p", "kind": "engine-natives", "bytes": 4000 },
                { "path": "/p2", "kind": "engine-natives", "bytes": 96 }
            ],
            "skipped": [
                { "path": "/q", "kind": "engine-natives", "bytes": 100, "reason": "in-use" },
                { "path": "/r", "kind": "engine-natives", "bytes": 200, "reason": "failed" },
                { "path": "/s", "kind": "engine-natives", "bytes": 0, "reason": "outside-root" }
            ]
        })
    }

    #[test]
    fn an_answer_is_read_as_freed_and_kept_bytes() {
        assert_eq!(
            Answer::read(&answer()).reclaim(),
            EngineReclaim {
                freed_bytes: 4096,
                skipped_bytes: 300
            }
        );
    }

    #[test]
    fn the_line_names_each_kind_and_each_reason() {
        let answer = Answer::read(&answer());
        assert_eq!(answer.removed_clause(), "engine-natives=4096");
        assert_eq!(
            answer.skipped_clause(),
            "failed 1 (200 bytes), in-use 1 (100 bytes), outside-root 1 (0 bytes)"
        );
    }

    #[test]
    fn an_answer_without_numbers_is_nothing_freed() {
        assert_eq!(
            Answer::read(&json!({ "removed": [], "skipped": [] })).reclaim(),
            EngineReclaim::default()
        );
        assert_eq!(
            Answer::read(&json!({ "freedBytes": "128" })).reclaim(),
            EngineReclaim::default(),
            "a string is not a byte count"
        );
        assert_eq!(
            Answer::read(&json!({})).reclaim(),
            EngineReclaim::default(),
            "an engine that answered nothing at all is nothing freed"
        );
        assert_eq!(
            Answer::read(&json!({ "removed": "none", "skipped": 7 })).reclaim(),
            EngineReclaim::default(),
            "a field of the wrong shape is not a list of rows"
        );
    }

    #[test]
    fn the_automatic_pass_asks_for_a_week() {
        let frame = automatic_frame();
        assert_eq!(frame["type"], "engine_reclaim");
        assert_eq!(
            frame["recentMs"],
            7 * 24 * 60 * 60 * 1000,
            "a week untouched, against the clear's day"
        );
    }

    #[test]
    fn only_one_caller_arms_the_pass() {
        // The guard is what `schedule` checks before it starts a loop; the loop itself is not
        // started here because it would outlive the test.
        assert!(claim(), "the first caller registers");
        assert!(!claim(), "the second does not arm a second loop");
    }
}

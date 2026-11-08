//! What one installation may spend on `agent.complete` (`omp.desktop` API 0.2.0): a rate and a
//! concurrency ceiling.
//!
//! Both exist because the capability costs money at a provider the user configured, and a plugin's
//! loop is not a reason for the user's bill to grow: [`CALLS_MAX`] calls inside [`WINDOW`], and
//! [`CONCURRENCY_MAX`] in flight at once. Nothing here is a permission - the permission is the
//! manifest's, and the first-use question is the user's (`bridge::capabilities::judge_agent`); this
//! is the pace, which is the one thing a declared permission does not bound.
//!
//! **Owner / bound / release.** Owned by `AppState` for the process's life. Bounded by the two
//! numbers above, per installation. A call's slot is released by [`AgentLease`]'s `Drop`, which is
//! why the lease is a value the caller holds for the whole call: an error path, a panic in a
//! `?`-chain and an early return all give the slot back the same way, and a refused call never
//! consumed one.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Calls one installation may start inside [`WINDOW`]. Mirrors `PLUGIN_AGENT_CALLS_MAX`.
pub(crate) const CALLS_MAX: usize = 20;
/// Calls one installation may have in flight. Mirrors `PLUGIN_AGENT_CONCURRENCY_MAX`.
pub(crate) const CONCURRENCY_MAX: usize = 2;
/// The rolling window the call count is taken over. Mirrors `PLUGIN_AGENT_WINDOW_MS`.
const WINDOW: Duration = Duration::from_secs(60);

/// The per-installation counters.
#[derive(Default)]
pub(crate) struct AgentBudget {
    /// `(window start, calls started in it)`.
    calls: Mutex<HashMap<String, (Instant, usize)>>,
    /// Calls in flight right now.
    in_flight: Mutex<HashMap<String, usize>>,
}

impl AgentBudget {
    /// Takes one call's slot, or answers what ran out.
    ///
    /// The rate is checked first, then the concurrency: a caller that has spent its minute is
    /// refused without touching the in-flight count, and one that is refused for concurrency has not
    /// spent a call (a call that never started is not one the user pays for).
    pub(crate) fn begin<'a>(
        &'a self,
        key: &str,
        now: Instant,
    ) -> Result<AgentLease<'a>, BudgetRefusal> {
        {
            let mut calls = self.lock_calls();
            let entry = calls.entry(key.to_owned()).or_insert((now, 0));
            if now.duration_since(entry.0) >= WINDOW {
                *entry = (now, 0);
            }
            if entry.1 >= CALLS_MAX {
                return Err(BudgetRefusal::Rate);
            }
            let mut in_flight = self.lock_in_flight();
            let running = in_flight.entry(key.to_owned()).or_insert(0);
            if *running >= CONCURRENCY_MAX {
                return Err(BudgetRefusal::Concurrency);
            }
            *running += 1;
            entry.1 += 1;
        }
        Ok(AgentLease {
            budget: self,
            key: key.to_owned(),
        })
    }

    /// How many calls one installation has in flight, for the tests.
    #[cfg(test)]
    pub(crate) fn in_flight(&self, key: &str) -> usize {
        self.lock_in_flight().get(key).copied().unwrap_or(0)
    }

    fn release(&self, key: &str) {
        let mut in_flight = self.lock_in_flight();
        if let Some(running) = in_flight.get_mut(key) {
            *running = running.saturating_sub(1);
            if *running == 0 {
                in_flight.remove(key);
            }
        }
    }

    fn lock_calls(&self) -> std::sync::MutexGuard<'_, HashMap<String, (Instant, usize)>> {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_in_flight(&self) -> std::sync::MutexGuard<'_, HashMap<String, usize>> {
        self.in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Which of the two ceilings a call ran into. Both answer `too_many_requests` to the plugin, and this
/// difference is for the log and the tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BudgetRefusal {
    Rate,
    Concurrency,
}

/// One call's slot, given back when it is dropped.
pub(crate) struct AgentLease<'a> {
    budget: &'a AgentBudget,
    key: String,
}

impl Drop for AgentLease<'_> {
    fn drop(&mut self) {
        self.budget.release(&self.key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_minute_is_a_rolling_window() {
        let budget = AgentBudget::default();
        let start = Instant::now();
        for _ in 0..CALLS_MAX {
            drop(budget.begin("key", start).expect("inside the minute"));
        }
        assert_eq!(
            budget.begin("key", start).err(),
            Some(BudgetRefusal::Rate),
            "the twenty-first call in the same minute is refused"
        );
        assert!(
            budget.begin("key", start + WINDOW).is_ok(),
            "the next window starts empty"
        );
    }

    #[test]
    fn only_two_calls_run_at_once_and_a_dropped_lease_frees_its_slot() {
        let budget = AgentBudget::default();
        let now = Instant::now();
        let first = budget.begin("key", now).expect("the first slot");
        let second = budget.begin("key", now).expect("the second slot");
        assert_eq!(
            budget.begin("key", now).err(),
            Some(BudgetRefusal::Concurrency),
            "a third call waits for one of the two"
        );
        assert_eq!(budget.in_flight("key"), 2);
        drop(first);
        assert_eq!(budget.in_flight("key"), 1);
        assert!(
            budget.begin("key", now).is_ok(),
            "the released slot is usable again"
        );
        drop(second);
    }

    #[test]
    fn a_refused_call_never_spent_the_minute() {
        let budget = AgentBudget::default();
        let now = Instant::now();
        let _first = budget.begin("key", now).expect("slot one");
        let _second = budget.begin("key", now).expect("slot two");
        let _ = budget.begin("key", now);
        drop(_first);
        drop(_second);
        // Two calls were started; the refusals are not calls.
        for _ in 0..(CALLS_MAX - 2) {
            drop(budget.begin("key", now).expect("still inside the count"));
        }
        assert_eq!(budget.begin("key", now).err(), Some(BudgetRefusal::Rate));
    }
}

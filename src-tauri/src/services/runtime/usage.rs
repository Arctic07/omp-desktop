use std::collections::HashMap;

use serde_json::Value;

use crate::models::agent::ChatTokenUsage;

/// Token accounting of one assistant message. `usage` fields are the engine's own names
/// (`input` / `output` / `cacheRead` / `cacheWrite` / `reasoningTokens` / `cost`); the value is
/// `None` unless the engine actually reported at least one bucket.
pub(crate) fn token_usage(message: Option<&Value>) -> Option<ChatTokenUsage> {
    let usage = message?.get("usage")?.as_object()?;
    let bucket = |key: &str| usage.get(key).and_then(Value::as_i64);
    let input = bucket("input");
    let output = bucket("output");
    let cache_read = bucket("cacheRead");
    let cache_write = bucket("cacheWrite");
    // A message the engine never accounted for stays `None`: four zeroed buckets would
    // reach the UI as a real measurement of zero tokens.
    if input.is_none() && output.is_none() && cache_read.is_none() && cache_write.is_none() {
        return None;
    }
    Some(ChatTokenUsage {
        input: input.unwrap_or_default(),
        output: output.unwrap_or_default(),
        cache_read: cache_read.unwrap_or_default(),
        cache_write: cache_write.unwrap_or_default(),
        // Passed through as reported-or-absent rather than zero-filled: whether the model
        // reasoned is a fact of its own, and a bucket the engine did not report has to stay
        // distinguishable from one it reported as zero.
        reasoning: bucket("reasoningTokens"),
        cost_usd: cost_usd(usage.get("cost")),
    })
}

/// `(provider, model)` of an assistant message, each `None` when absent.
pub(crate) fn model_identity(message: Option<&Value>) -> (Option<String>, Option<String>) {
    let field = |key: &str| {
        message
            .and_then(|message| message.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    (field("provider"), field("model"))
}

/// The engine's four cost buckets are disjoint, so their sum is the message's cost. A missing
/// `cost` object or sub-field really did cost nothing and counts as 0.0.
fn cost_usd(cost: Option<&Value>) -> f64 {
    let bucket = |key: &str| {
        cost.and_then(|cost| cost.get(key))
            .and_then(Value::as_f64)
            .unwrap_or_default()
    };
    bucket("input") + bucket("output") + bucket("cacheRead") + bucket("cacheWrite")
}

/// Host-clock facts the wire does not carry: when a message's first delta arrived and when each
/// tool call started. Keyed by the id the UI renders under.
#[derive(Default)]
pub(crate) struct Clock {
    messages: HashMap<String, i64>,
    /// Start time of every call still running, dropped when the call ends.
    tools: HashMap<String, i64>,
}

impl Clock {
    /// First observation wins: the delta stream must not keep restarting the clock.
    pub(crate) fn message_delta(&mut self, message_id: &str, now_ms: i64) {
        self.messages.entry(message_id.to_owned()).or_insert(now_ms);
    }

    /// Removes and returns the start time for the first id present. `ids` holds every id the same
    /// logical message is known by (announced id, wire id) so a rename cannot lose the clock.
    pub(crate) fn message_end(&mut self, ids: &[&str]) -> Option<i64> {
        ids.iter().find_map(|id| self.messages.remove(*id))
    }

    /// A call that starts twice under the same id restarts its clock: the second start is the
    /// one the engine is actually running.
    pub(crate) fn tool_start(&mut self, tool_call_id: &str, now_ms: i64) {
        self.tools.insert(tool_call_id.to_owned(), now_ms);
    }

    /// Removes and returns the start time of that tool call.
    pub(crate) fn tool_end(&mut self, tool_call_id: &str) -> Option<i64> {
        self.tools.remove(tool_call_id)
    }

    /// Drops everything still held.
    ///
    /// A message or a call whose end never arrived - the engine aborted mid-stream, or the turn was
    /// lost with the host - leaves its entry behind, and the turn's own end is where that residue is
    /// collected: nothing from this turn can report a start time any more, and the next turn stamps
    /// its own ids.
    pub(crate) fn clear(&mut self) {
        self.messages.clear();
        self.tools.clear();
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Four disjoint buckets are summed into the single `costUsd` the UI renders; a `cost`
    /// object the engine omitted costs nothing instead of costing the whole usage.
    #[test]
    fn cost_is_the_sum_of_the_engine_buckets() {
        let usage = token_usage(Some(&json!({
            "usage": {
                "input": 18_273,
                "output": 107,
                "cacheRead": 625,
                "cacheWrite": 0,
                "cost": {"input": 0.25, "output": 0.5, "cacheRead": 0.125, "cacheWrite": 0.125},
            }
        })));
        match usage {
            Some(usage) => {
                assert_eq!(usage.input, 18_273);
                assert_eq!(usage.output, 107);
                assert_eq!(usage.cache_read, 625);
                assert_eq!(usage.cache_write, 0);
                assert_eq!(usage.cost_usd, 1.0);
            }
            None => panic!("the engine reported usage"),
        }

        match token_usage(Some(&json!({"usage": {"input": 5}}))) {
            Some(usage) => assert_eq!(usage.cost_usd, 0.0),
            None => panic!("one reported bucket is enough"),
        }
    }

    /// The reasoning bucket is a fact of its own: the tokens the engine reported travel through,
    /// while a bucket it did not report stays absent rather than reading as zero.
    #[test]
    fn reasoning_is_reported_only_when_the_engine_reports_it() {
        match token_usage(Some(
            &json!({"usage": {"input": 999, "reasoningTokens": 428}}),
        )) {
            Some(usage) => assert_eq!(usage.reasoning, Some(428)),
            None => panic!("the engine reported usage"),
        }

        match token_usage(Some(&json!({"usage": {"input": 999}}))) {
            Some(usage) => assert!(usage.reasoning.is_none()),
            None => panic!("one reported bucket is enough"),
        }
    }

    /// A message the engine never accounted for must not turn into four zeroed buckets.
    #[test]
    fn an_unaccounted_message_stays_none() {
        assert!(token_usage(None).is_none());
        assert!(token_usage(Some(&json!({"role": "assistant"}))).is_none());
        assert!(token_usage(Some(&json!({"usage": {}}))).is_none());
        assert!(token_usage(Some(&json!({"usage": "120"}))).is_none());
    }

    #[test]
    fn model_identity_reads_the_engine_fields_only() {
        let (provider, model) = model_identity(Some(&json!({
            "provider": "anthropic",
            "model": "claude-sonnet-4-5",
        })));
        assert_eq!(provider.as_deref(), Some("anthropic"));
        assert_eq!(model.as_deref(), Some("claude-sonnet-4-5"));

        let (provider, model) = model_identity(None);
        assert!(provider.is_none());
        assert!(model.is_none());

        let (provider, model) = model_identity(Some(&json!({"provider": 7, "model": null})));
        assert!(provider.is_none());
        assert!(model.is_none());
    }

    /// The delta stream re-announces a message on every token, so the first sighting is the
    /// start time; an id the message was renamed away from still resolves it.
    #[test]
    fn the_message_clock_keeps_its_first_sighting() {
        let mut clock = Clock::default();
        clock.message_delta("wire-1", 1_000);
        clock.message_delta("wire-1", 1_400);
        assert_eq!(clock.message_end(&["announced-1", "wire-1"]), Some(1_000));
        // Reading a start time consumes it: a late duplicate must not resurrect it.
        assert_eq!(clock.message_end(&["wire-1"]), None);
    }

    #[test]
    fn the_tool_clock_reports_each_start_once() {
        let mut clock = Clock::default();
        clock.message_delta("m1", 1_000);
        clock.tool_start("call_1", 2_000);
        assert_eq!(clock.tool_end("call_1"), Some(2_000));
        assert_eq!(clock.tool_end("call_1"), None);

        clock.tool_start("call_2", 3_000);
        assert_eq!(clock.message_end(&["m1"]), Some(1_000));
        assert_eq!(clock.tool_end("call_2"), Some(3_000));
    }

    /// The regression this covers: a message or a call whose end never arrived - the engine aborted
    /// mid-stream, the turn was lost with the host - kept its id here for the life of the session,
    /// because only an end frame ever removed one. The turn's own end is where that residue goes.
    #[test]
    fn the_turn_boundary_drops_what_never_ended() {
        let mut clock = Clock::default();
        clock.message_delta("never-ended", 1_000);
        clock.tool_start("never-ended-call", 2_000);
        clock.clear();
        assert_eq!(clock.message_end(&["never-ended"]), None);
        assert_eq!(clock.tool_end("never-ended-call"), None);
        assert!(clock.messages.is_empty() && clock.tools.is_empty());
    }
}

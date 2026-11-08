//! One answer to "which handler owns this frame", for every frame that belongs to a session.
//!
//! Two paths deliver session frames here: the live stream, and the replay that repairs a hole from
//! the host's journal. They are the same stream at two moments - the journal keeps what the
//! outbound queue had to shed, which is exactly why a replay is asked for - so a frame type has to
//! reach the same handler on both. Anything else makes a repaired hole look different from a
//! delivery that was never lost, which is the failure a replay exists to prevent.
//!
//! This module is therefore the whole of the session vocabulary: the engine's own event types (the
//! two tables) and the frames the host composes itself, each with a lane of its own. The dispatch
//! itself lives with the handlers in `protocol.rs`; what is decided here is only where a frame
//! goes.

use serde_json::Value;

/// Frame types the projector understands: everything listed here reaches `events.rs`, and every
/// one of them has its own arm in `EventState::on_event` - including `turn_start`/`turn_end`, which
/// the projector recognizes and deliberately does not render (see that arm). A type belongs here
/// only once it has an arm; a recognized-but-unhandled type would otherwise fall through the
/// projector's catch-all, which is the one path that neither counts nor reports what it drops.
///
/// The two tables are the engine's session-event vocabulary. Frames the host composes itself
/// (`state`, `subagent`, the forwarded child event, `error`, the dialog pair and its cancels, the
/// command advertisement, the prompt result) belong in neither: each has a lane of its own in
/// [`Route`].
const PROJECTED: &[&str] = &[
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "model_changed",
    "thinking_level_changed",
    "notice",
    // The host's own session-info frame: the name it carries is what a sidebar row renders.
    "session_info_update",
    "auto_compaction_start",
    "auto_compaction_end",
    // A compaction a reader asked for (an extension's `ctx.compact()`, `/compact`). Same two edges
    // as the automatic one and the same projection: the gauge moves either way, and the engine's
    // own reason for a failure exists in no other frame.
    "manual_compaction_start",
    "manual_compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    // A retry that moved to another model: the retry is the same turn, and this is the one frame a
    // reader would otherwise only learn the switch from, on the answer that follows it. It has an
    // arm in the projector like every other member of this table.
    "retry_fallback_applied",
];

/// Frame types that are recognized and deliberately not projected: they are neither counted nor
/// logged, because a frame that is known to carry nothing the desktop renders would otherwise
/// print a line every time a session becomes active. Anything genuinely unrecognized is
/// [`Route::Unregistered`], which is counted and logged.
///
/// The list is the engine's own session-event vocabulary minus what the projector renders, checked
/// against the SDK this build ships (`@oh-my-pi/pi-coding-agent@18.13.3`,
/// `src/session/agent-session-events.ts`: `AgentSessionEvent` is `AgentEvent` plus the session's own
/// members, and `AgentSession` re-emits every one of them through the subscription the host forwards
/// verbatim - `host/src/session-activate.ts:244`). A type the union declares is therefore a type that
/// can arrive, and one that arrives with no entry here is counted and logged as unregistered.
///
/// The removed RPC-sidecar vocabulary is deliberately absent: `command_output`,
/// `subagent_lifecycle`, `subagent_progress` and the four `host_*` request types were names this
/// protocol never publishes (the host composes `{type:"subagent"}` and a `notice` for the first
/// three; the last four are commands the host *refuses*, `host/src/dispatch.ts`), so listing them
/// here made the unregistered arm quieter about a frame it would only ever see if something were
/// wrong.
const IGNORED: &[&str] = &[
    // The fallback answering says nothing the transcript does not already carry: the message it
    // produced names the model that produced it, and the switch itself is projected from
    // `retry_fallback_applied`.
    "retry_fallback_succeeded",
    "ttsr_triggered",
    "todo_reminder",
    "todo_auto_clear",
    "irc_message",
    "goal_updated",
    // The cache warmer's two edges: which cache a refresh is warming and how it went is the
    // engine's own housekeeping, with no surface on this side.
    "cache_warming_start",
    "cache_warming_end",
    // The engine's coalesced snapshot of its steering/follow-up queue. The desktop's own queue is
    // the reader's, drawn from `state`/`prompt_result` (`host/src/session-view.ts`), so this is a
    // second account of a different queue rather than the one on screen.
    "queue_update",
    // SDK `AgentSessionEvent` members with no desktop surface.
    "advisor_cost_changed",
    "advisor_yielded",
    "config_warnings_changed",
    // Core `AgentEvent` member: raw tool output chunks. Tool cards are built from
    // `tool_execution_start`/`_update`/`_end`, which carry the same content in their final form.
    "tool_stream_update",
];

/// Which handler owns one frame type.
///
/// One lane per handler, because the answer has to be the same on both paths and the handler is
/// what differs: a `state` snapshot replaces the session's view, a `subagent` frame is merged into
/// a roster, an engine event is normalized by the projector, and so on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Route {
    /// The host's state snapshot: replaces the session's view instead of extending it.
    Snapshot,
    /// The host's own roster frame for one live subagent.
    Roster,
    /// The host's own side-question frame: a streamed answer and its lifecycle, drawn by the
    /// composer's side panel rather than the transcript.
    Btw,
    /// One child's own session event, forwarded by the host so the child can be watched while it
    /// works: published on the child's own channel, addressed by the transcript the frame names
    /// rather than by any session this process has registered (`protocol.rs::on_subagent_event`).
    SubagentEvent,
    /// An engine session event, normalized by the projector in `events.rs`.
    Projector,
    /// An engine dialog, which the reader has to answer or cancel.
    Dialog,
    /// The host voiding a dialog: the request it names is no longer answerable.
    DialogCancel,
    /// The engine's extension-side failure report.
    ExtensionError,
    /// The engine's advertised command list for the session.
    Commands,
    /// A standalone engine failure: the session-level report the frontend renders.
    Failure,
    /// The host acknowledging a prompt, which decides whether a turn is running.
    PromptResult,
    /// The host asking the application about the terminals the user has open, or asking it to type
    /// into one - the lane where the host is the requester (`host/terminal.rs`).
    TerminalRequest,
    /// The host asking the application to drive or read one browser page - the same
    /// host-as-requester shape, for the built-in browser (`host/browser.rs`).
    BrowserRequest,
    /// Recognized and deliberately not projected (the [`IGNORED`] table).
    Ignored,
    /// A type neither table nor lane knows: counted and logged, never silently dropped.
    Unregistered,
}

/// The `type` of one frame, empty when it carries none.
///
/// An absent type is read as the empty string rather than refused here: an arrival with no type is
/// an arrival nothing can route, and it is [`Route::Unregistered`] - the arm that counts and logs
/// it - exactly like a type that is simply unknown.
pub(super) fn frame_type(frame: &Value) -> &str {
    frame
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// Classifies one frame type.
///
/// The process-level vocabulary is deliberately absent: `hello`, `ready`, `host_fatal`,
/// `host_exit`, `response` and `rpc_chunk` belong to no session, `protocol.rs::handle` matches each
/// of them before this table is consulted, and a journal - which is per session - never holds one.
pub(super) fn route_of(frame_type: &str) -> Route {
    match frame_type {
        "state" => Route::Snapshot,
        "subagent" => Route::Roster,
        "btw" => Route::Btw,
        "subagent_event" => Route::SubagentEvent,
        "prompt_result" => Route::PromptResult,
        // The frames the host requests rather than answers (`host/terminal.rs`).
        "terminal_request" => Route::TerminalRequest,
        "browser_request" => Route::BrowserRequest,
        "extension_ui_request" => Route::Dialog,
        "extension_ui_cancel" => Route::DialogCancel,
        "extension_error" => Route::ExtensionError,
        "available_commands_update" => Route::Commands,
        "error" => Route::Failure,
        other if PROJECTED.contains(&other) => Route::Projector,
        other if IGNORED.contains(&other) => Route::Ignored,
        _ => Route::Unregistered,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One frame type has exactly one lane, and the two tables are disjoint: a type in both would
    /// make the answer depend on which table the reader looked at first.
    #[test]
    fn every_known_type_has_exactly_one_lane() {
        for frame_type in PROJECTED {
            assert_eq!(route_of(frame_type), Route::Projector, "{frame_type}");
            assert!(!IGNORED.contains(frame_type), "{frame_type} is in both");
        }
        for frame_type in IGNORED {
            assert_eq!(route_of(frame_type), Route::Ignored, "{frame_type}");
        }
        // The frames the host composes itself are in neither table: their lane is their handler.
        for (frame_type, route) in [
            ("state", Route::Snapshot),
            ("subagent", Route::Roster),
            ("btw", Route::Btw),
            ("subagent_event", Route::SubagentEvent),
            ("error", Route::Failure),
            ("prompt_result", Route::PromptResult),
            ("extension_ui_request", Route::Dialog),
            ("extension_ui_cancel", Route::DialogCancel),
            ("extension_error", Route::ExtensionError),
            ("available_commands_update", Route::Commands),
            ("terminal_request", Route::TerminalRequest),
            ("browser_request", Route::BrowserRequest),
        ] {
            assert_eq!(route_of(frame_type), route, "{frame_type}");
            assert!(
                !PROJECTED.contains(&frame_type),
                "{frame_type} is projected"
            );
            assert!(!IGNORED.contains(&frame_type), "{frame_type} is ignored");
        }
        // A type nobody has taught this build is the one arm that counts and logs it.
        assert_eq!(route_of("host_pigeon"), Route::Unregistered);
        assert_eq!(route_of(""), Route::Unregistered);
    }

    /// Every frame type the host journals has a lane of its own, and none of them is the
    /// unregistered arm: the journal keeps what the live stream published, so a type emitted
    /// anywhere in `host/src` reaches this router on the live path or on a replay - never nowhere.
    #[test]
    fn every_type_the_host_publishes_is_routed() {
        // The producers: `host/src/events.ts` (snapshots, the shed roster frames, the budget
        // notice), `host/src/sessions.ts` (state, prompt results, engine failures, command
        // advertisements, name changes), `host/src/session-activate.ts` (the forwarded engine
        // events) and `host/src/ui.ts` (the dialog pair).
        for frame_type in [
            "state",
            "subagent",
            "subagent_event",
            "message_update",
            "notice",
            "session_info_update",
            "available_commands_update",
            "prompt_result",
            "error",
            "extension_ui_request",
            "extension_ui_cancel",
            "agent_start",
            "agent_end",
            "tool_execution_end",
        ] {
            assert_ne!(
                route_of(frame_type),
                Route::Unregistered,
                "{frame_type} is published by the host and would be counted as unknown"
            );
        }
    }

    /// The regression this covers: the engine's own union is what the host forwards, so every member
    /// of it has to have a lane. `cache_warming_start` / `cache_warming_end` / `queue_update` were
    /// absent from both tables, and every emission of one was counted as an unknown frame and
    /// `log::warn`-ed - which is exactly the counter a real missing arm is diagnosed by, spent on a
    /// frame the host knew about all along.
    ///
    /// The list is `AgentSessionEvent` as `@oh-my-pi/pi-coding-agent@18.13.3` declares it
    /// (`src/session/agent-session-events.ts`), transcribed: the core `AgentEvent` members first,
    /// then the session's own. Re-derive it against a new SDK, and add the member here when it
    /// arrives - a member missing from this list is a member the host will forward as unknown.
    #[test]
    fn every_engine_session_event_is_routed() {
        for frame_type in [
            // Core `AgentEvent`.
            "agent_start",
            "agent_end",
            "turn_start",
            "turn_end",
            "message_start",
            "message_update",
            "message_end",
            "tool_execution_start",
            "tool_execution_update",
            "tool_execution_end",
            "tool_stream_update",
            // The session's own members.
            "auto_compaction_start",
            "auto_compaction_end",
            "manual_compaction_start",
            "manual_compaction_end",
            "auto_retry_start",
            "auto_retry_end",
            "cache_warming_start",
            "cache_warming_end",
            "retry_fallback_applied",
            "retry_fallback_succeeded",
            "model_changed",
            "config_warnings_changed",
            "advisor_cost_changed",
            "advisor_yielded",
            "ttsr_triggered",
            "todo_reminder",
            "todo_auto_clear",
            "irc_message",
            "notice",
            "thinking_level_changed",
            "goal_updated",
            "queue_update",
        ] {
            assert_ne!(
                route_of(frame_type),
                Route::Unregistered,
                "{frame_type} is an engine session event and would be counted as unknown"
            );
        }
    }

    /// The regression this covers: the removed RPC-sidecar vocabulary sat in the ignore table, so a
    /// frame this protocol has no producer for was read as a known frame with nothing to render. The
    /// three the host replaced (`command_output`, `subagent_lifecycle`, `subagent_progress`) are not
    /// names it can publish at all, and the four `host_*` entries are commands the host refuses
    /// (`host/src/dispatch.ts`), not frames: if one ever reached the stream, that is a bug worth the
    /// unregistered arm's counter and log line.
    #[test]
    fn removed_sidecar_vocabulary_is_not_ignored() {
        for frame_type in [
            "command_output",
            "subagent_lifecycle",
            "subagent_progress",
            "host_tool_call",
            "host_tool_cancel",
            "host_uri_request",
            "host_uri_cancel",
        ] {
            assert_eq!(route_of(frame_type), Route::Unregistered, "{frame_type}");
        }
    }

    /// The regression this covers: a frame the host really emits but this side does not render
    /// belongs in the explicit-ignore table, not in the unregistered arm. `advisor_cost_changed`
    /// was the one rev-host saw live - every session activation logged an `unregistered host frame`
    /// line and counted an unknown frame - and the other three are its siblings from the same SDK
    /// unions.
    #[test]
    fn engine_bookkeeping_frames_are_ignored_rather_than_unregistered() {
        for frame_type in [
            "advisor_cost_changed",
            "advisor_yielded",
            "config_warnings_changed",
            "tool_stream_update",
        ] {
            assert_eq!(route_of(frame_type), Route::Ignored, "{frame_type}");
            assert!(
                !PROJECTED.contains(&frame_type),
                "{frame_type} is projected"
            );
        }
    }

    /// The regression this covers: `retry_fallback_applied` was left in the explicit-ignore table
    /// while `events.rs` had an arm to render it, so the notice could only ever appear on a replay
    /// path - the live frame was dropped before it reached the projector. A frame belongs in
    /// exactly one of the lanes, and the two frames the host composes itself (`state`, `subagent`)
    /// belong in neither table.
    #[test]
    fn the_fallback_notice_is_projected_and_the_roster_frame_has_its_own_lane() {
        assert_eq!(route_of("retry_fallback_applied"), Route::Projector);
        assert!(
            !IGNORED.contains(&"retry_fallback_applied"),
            "a projected frame cannot be ignored as well"
        );
        // The fallback answering stays ignored, and its rationale lives with the entry.
        assert_eq!(route_of("retry_fallback_succeeded"), Route::Ignored);

        assert_eq!(route_of("subagent"), Route::Roster);
        assert!(!PROJECTED.contains(&"subagent"));
        assert!(!IGNORED.contains(&"subagent"));
    }

    /// The regression this covers: the host's forwarding of a child's own session event.
    ///
    /// `subagent_event` sat in the ignore table as an SDK member with nothing on this side that
    /// could render it, so a live child view had no stream to draw at all - which is what a user
    /// who stepped into a running subagent saw: no rows, no tool chips, no clock. The frame the
    /// host composes now carries a child's own event to the child's channel, and it is rendered;
    /// the ignore table is what it left. It is not the parent's roster frame either: a child event
    /// says what the child is doing, while the roster is a row about the child.
    #[test]
    fn the_forwarded_child_event_has_its_own_lane() {
        assert_eq!(route_of("subagent_event"), Route::SubagentEvent);
        assert!(
            !IGNORED.contains(&"subagent_event"),
            "the forwarding is rendered, so it is not an ignore case"
        );
        assert_ne!(route_of("subagent_event"), Route::Roster);
        assert_ne!(route_of("subagent_event"), Route::Projector);
    }
}

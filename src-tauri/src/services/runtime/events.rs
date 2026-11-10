use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::AppHandle;

use super::history::message_timestamp;
use super::host::session::SessionRuntime;
use super::usage::Clock;
use crate::services::store;

use super::{clamp_text, sanitize_message, BACKGROUND_DELTA_FLUSH_MS, DELTA_FLUSH_MS};
use crate::services::presence;
use crate::services::session_title::clean_title_text;

mod compaction;
mod deltas;
mod frames;

use deltas::{DeltaBuffer, DeltaKind, DeltaSet};
use frames::{
    attach_details, attach_images, close_frames, delta_frame, ends_turn, message_is_drawn,
    message_key, message_role, missing_tail, notice_frame, reminder_frame, text_field,
    unclosed_messages,
};
pub(crate) use frames::{is_user_skill_prompt, on_subagent, roster_stop_reason, skill_prompt_text};

/// A message the engine is currently streaming. Deltas are addressed to it, so its role
/// has to be remembered: a user message must never collect streamed assistant text.
struct CurrentMessage {
    id: String,
    role: String,
    /// The engine's own identity for this message (`frames::message_key`), when its frame carried
    /// one. The row id above is minted here and appears in no `agent_end`, so this is what the end
    /// of the run matches a still-open row against when it repairs a message whose frames were lost.
    key: Option<String>,
}

/// How long this conversation's streamed text may wait before it is published.
///
/// A conversation on screen is delivered at the display cadence; one the reader has left is
/// coalesced over the wider background window, so several parallel conversations do not each cost
/// the webview an event per frame (`BACKGROUND_DELTA_FLUSH_MS`). Only the cadence changes: a
/// message's buffer is the whole text so far, and terminal edges still flush immediately, so
/// nothing is dropped and nothing arrives out of order.
fn delivery_window_ms(session: &SessionRuntime) -> i64 {
    if session.is_watched() {
        DELTA_FLUSH_MS as i64
    } else {
        BACKGROUND_DELTA_FLUSH_MS as i64
    }
}

/// Normalizes engine session events into the host's event shape and coalesces deltas.
///
/// Terminal events (`turn_finished`, `message_finished`, tool transitions, errors) flush the
/// pending deltas first, so the UI can never observe a completion before its text.
pub(crate) struct EventState {
    message_seq: u64,
    turn_seq: u64,
    current_message: Option<CurrentMessage>,
    deltas: DeltaSet,
    turn_id: Option<String>,
    last_stop_reason: Option<String>,
    last_error: Option<String>,
    /// Host-clock facts the wire does not carry. Cleared with the rest of the turn state,
    /// so a session switch can never report the previous session's timings.
    clock: Clock,
    /// What each message has already streamed, under the id its deltas were addressed to.
    ///
    /// A message can be announced under one id and ended under another, and this is what the end of
    /// the message is read against to decide whether any of its words are still owed to the UI - so
    /// it lives as long as the message does rather than as long as the buffer: a buffer that has
    /// been delivered is empty, while a message that has been delivered is recorded here.
    ///
    /// The words are kept rather than only a flag saying something arrived, because a stream can be
    /// cut short as well as lost whole: the host sheds queued increments under backpressure
    /// (`host/src/events.ts::sheddable`) and a shed increment is text no reader ever saw, and
    /// telling a fragment apart from a message the engine rewrote needs what arrived rather than
    /// that something did.
    ///
    /// Owner: this projector. Bound: one turn's own streamed output, which is what the turn is
    /// already holding in its buffers and its rows. Released in `finish_turn` with the rest of the
    /// turn's bookkeeping, because a message's end always precedes it in the turn that announced it.
    streamed: HashMap<String, DeltaBuffer>,
    /// Messages of this turn whose closing frame has already gone out, keyed by the engine's own
    /// identity (`frames::message_key`).
    ///
    /// This is what makes the end of a run able to tell a message it already showed from one whose
    /// frames never arrived: the row ids on the wire are minted here, so only the engine's own key
    /// can be looked up in the `agent_end` copy of the message. It is cleared when the next turn
    /// starts rather than when the previous one ends, because a turn can be made of several runs and
    /// a later run's `agent_end` repeats the messages the earlier one already reported.
    finished: HashSet<String>,
    /// Tool updates waiting for the delivery window, newest payload per call.
    ///
    /// `tool_execution_update` carries the whole partial result so far - the engine re-sends the
    /// growing result on every tick - so an earlier update for a call says nothing a later one does
    /// not, and replacing it is what keeps a long-running call from sending one frame per tick. The
    /// order is first-seen, which is the order the calls themselves were started in.
    tool_updates: Vec<(String, Value)>,
    /// Session every delivery of this state belongs to. One projector serves one conversation,
    /// so an event can never be re-attributed to another one.
    owner_session: String,
    /// Whether the turn most recently closed was closed by the roster's own settle edge rather than
    /// by the child's stream (`settle_from_roster`).
    ///
    /// The child's `agent_end` is deferred until its prompt unwinds, and a stop releases the child's
    /// session inside that window, so that frame can arrive after the roster already stated the
    /// ending. What is left of it is a `finish_turn` whose turn id is gone, and the back-to-back
    /// pair that path emits belongs to a prompt that never started a turn - not to a turn this
    /// state has already reported. One flag, consumed by that one frame, and cleared by a new turn
    /// (`ensure_turn`), so a later run can never inherit it.
    closed_by_roster: bool,
    /// What every id this projector mints for a conversation carries (`mint_token`).
    ///
    /// A row id minted here names a row the **frontend holds**, and those rows outlive the host
    /// session that announced them: a conversation the desktop let go of keeps its rows and merges
    /// the transcript back into them, and a host that restarts keeps the window. A bare counter
    /// therefore minted `m1`, `m2`, … again for a conversation whose record already answers to
    /// those names, and the new message's frames went into the *older* rows — the answer's body
    /// appended somewhere above (or dropped outright, where the row it hit was the reader's own
    /// prompt: `state/transcript.ts::applyDelta` writes nothing into a row of another kind), while
    /// the transcript on disk had it in the right place. That is the reader's report of
    /// 2026-10-27: the answer only appeared after the app was reopened. Uniqueness is per
    /// conversation and per process run, so the token carries both.
    mint: String,
}

impl EventState {
    pub(crate) fn new(session_id: String) -> Self {
        Self {
            message_seq: 0,
            turn_seq: 0,
            mint: mint_token(),
            current_message: None,
            deltas: DeltaSet::default(),
            turn_id: None,
            last_stop_reason: None,
            last_error: None,
            clock: Clock::default(),
            streamed: HashMap::new(),
            finished: HashSet::new(),
            tool_updates: Vec::new(),
            owner_session: session_id,
            closed_by_roster: false,
        }
    }

    /// Handles one engine event. Returns true when the caller should refresh `get_state`.
    pub(crate) fn on_event(
        &mut self,
        app: &AppHandle,
        session: &Arc<SessionRuntime>,
        event: &Value,
    ) -> bool {
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match event_type {
            "agent_start" => {
                self.ensure_turn(app, session);
                true
            }
            "message_start" => {
                // A tool result, an injected developer message or an agent-authored user message is
                // not a row of this conversation; see `message_is_drawn`.
                if !message_is_drawn(event) {
                    return false;
                }
                let role = message_role(event);
                // A reminder arrives whole: `message_end` emits it as one frame, and an opening frame
                // with no words would draw a row that is empty until the closer lands.
                if role == "reminder" {
                    return false;
                }
                let id = self.next_message_id(event);
                let message = event.get("message");
                let at = message.and_then(message_timestamp);
                session.emit(
                    app,
                    json!({"type": "message_started", "messageId": id, "role": role, "at": at}),
                );
                self.current_message = Some(CurrentMessage {
                    id,
                    role: role.to_owned(),
                    key: message.and_then(message_key),
                });
                false
            }
            "message_update" => {
                if !message_is_drawn(event) {
                    return false;
                }
                self.on_delta(app, session, event);
                false
            }
            // Context occupancy changes only when a step of the answer ends, so the
            // usage follows the conversation here: once per message, not per delta.
            "message_end" => {
                if !message_is_drawn(event) {
                    return false;
                }
                // A user row (a prompt or a skill invocation) is claimed by its opening frame and has
                // nothing to finish: the row's own words and time are already the record. Clearing
                // the current message keeps the next assistant step's id its own.
                if message_role(event) == "user" {
                    self.current_message = None;
                    return false;
                }
                if message_role(event) == "reminder" {
                    let message = event.get("message");
                    if let Some(text) = message.and_then(super::reminder_text) {
                        let id = message
                            .and_then(|message| message.get("id"))
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .unwrap_or_else(|| self.next_row_id());
                        let at = message
                            .and_then(message_timestamp)
                            .unwrap_or_else(store::now_ms);
                        session.emit(app, reminder_frame(&id, at, &text));
                    }
                    return false;
                }
                let announced = self.current_message.take();
                self.close_message(app, session, event.get("message"), announced);
                true
            }
            "agent_end" => {
                // The run's own record of what it wrote, before the turn is closed: a message whose
                // frames were lost on the way here still has to reach the screen, and this frame is
                // the last place its words exist on this side (see `repair_run`).
                self.repair_run(app, session, event);
                if !ends_turn(event) {
                    return false;
                }
                self.finish_turn(app, session, None);
                true
            }
            "tool_execution_start" => {
                // Deliver pending text first: a tool card must not overtake it.
                self.flush(app, session);
                let tool_call_id = text_field(event, "toolCallId");
                let now_ms = store::now_ms();
                // One reader for both paths (`intent_text`): the value here is the same fact the
                // page carries on the call part, so a row cannot read differently after a reload.
                let intent = super::intent_text(event.get("intent"));
                self.clock.tool_start(&tool_call_id, now_ms);
                session.emit(
                    app,
                    json!({
                        "type": "tool_started",
                        "toolCallId": tool_call_id,
                        "name": text_field(event, "toolName"),
                        "argsText": clamp_text(super::stringify(event.get("args"))),
                        "startedAt": now_ms,
                        "intent": intent,
                    }),
                );
                false
            }
            "tool_execution_update" => {
                let partial = event.get("partialResult");
                let mut payload = json!({
                    "type": "tool_updated",
                    "toolCallId": text_field(event, "toolCallId"),
                    // The partial result is read the same way the final one is: the engine
                    // sends the same `{content, details}` shape while a call streams.
                    "resultText": super::result_text(partial),
                });
                // What a call reports while it runs rather than when it ends: the live roster of a
                // background `task` spawn arrives here, and a row that waited for the end frame
                // would draw a batch that is still going as one that spawned nothing.
                attach_details(
                    &mut payload,
                    super::tool_details(partial.and_then(|value| value.get("details"))),
                );
                // The pictures the call has produced so far, read from the same partial result the
                // text above came from, so screenshots appear while the call runs rather than all
                // at once when it ends.
                attach_images(
                    &mut payload,
                    super::content_images(partial.and_then(|value| value.get("content"))),
                );
                // Held for the window rather than written straight out, and only the newest per
                // call: the engine re-sends the whole partial result on every tick, so the earlier
                // ones are superseded exactly like a text delta (`buffer_tool_update`). A bash call
                // that prints for a minute would otherwise send a frame per tick, each up to the
                // frame budget, and the delta cadence the rest of the stream is delivered on would
                // be the one thing the heaviest stream ignores.
                self.buffer_tool_update(text_field(event, "toolCallId"), payload);
                session.mark_delta_pending();
                let now_ms = store::now_ms();
                if self.should_deliver(delivery_window_ms(session), false, now_ms) {
                    self.flush_due(app, session);
                }
                false
            }
            "tool_execution_end" => {
                self.flush(app, session);
                let is_error = event
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let tool_call_id = text_field(event, "toolCallId");
                let ended_at = store::now_ms();
                // The call's start time was already delivered with `tool_started`, so this
                // frame owes only the end; the clock entry is dropped along with it.
                self.clock.tool_end(&tool_call_id);
                let result = event.get("result");
                let details = super::tool_details(result.and_then(|value| value.get("details")));
                let mut payload = json!({
                    "type": "tool_finished",
                    "toolCallId": tool_call_id,
                    "name": text_field(event, "toolName"),
                    "state": if is_error { "error" } else { "success" },
                    "resultText": super::result_text(result),
                    "endedAt": ended_at,
                });
                // What a row draws from the result rather than reads: a diff, the file it touched,
                // the subagents a `task` call ran. The field is added only when the call reported
                // some of it, so a frame stays the size of what it says and the addition stays
                // additive for a frontend built before it.
                attach_details(&mut payload, details);
                // What the call produced rather than said: a screenshot, the picture a `read`
                // returned. Added only when the result carried some, so a frame stays the size of
                // what it says.
                attach_images(
                    &mut payload,
                    super::content_images(result.and_then(|value| value.get("content"))),
                );
                session.emit(app, payload);
                false
            }
            "notice" => {
                // The text that arrived before this line goes first: a notice about what just
                // happened must not overtake the words it interrupted.
                self.flush(app, session);
                session.emit(app, notice_frame(event));
                false
            }
            // The engine named the session: its title sidecar writes the name and the session
            // manager reports it, in the same frame a user rename publishes. The row and the
            // conversation header read their title from the record this patches, so the frame is
            // forwarded as a title patch; an unnamed session says nothing and is dropped here.
            // The name is cleaned through the same rule the session index applies to a file's title
            // slot: a title model that translated the `<title>` marker leaves its envelope in the
            // name, and the desktop shows the words inside it, not the tags.
            "session_info_update" => {
                let title = clean_title_text(
                    event
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                );
                if !title.is_empty() {
                    session.emit(app, json!({"type": "title_changed", "title": title}));
                }
                false
            }
            "auto_retry_start" => {
                self.flush(app, session);
                session.emit(
                    app,
                    json!({
                        "type": "notice",
                        "level": "warning",
                        "code": "engine_retrying",
                        "message": "The engine is retrying the last request.",
                    }),
                );
                false
            }
            // A retry that moved to another model is a second fact about the same turn, and the
            // one a reader would otherwise only learn from the model name on the answer that
            // follows. The model it switched to answers the turn either way; what this line adds
            // is that the answer came from somewhere other than where the turn started.
            "retry_fallback_applied" => {
                self.flush(app, session);
                session.emit(
                    app,
                    json!({
                        "type": "notice",
                        "level": "warning",
                        "code": "engine_retry_fallback",
                        "message": "The engine switched to a fallback model.",
                    }),
                );
                false
            }
            // A compaction's two edges: the engine's own automatic one at a context boundary, and
            // the one a caller asked for (`ctx.compact()`, `/compact`). Both are the same fact on
            // this side - the context is being rewritten - so both project the same reading.
            //
            // The start refreshes the state as well as putting the line up: `isCompacting` runs
            // with the turn bit idle, so the snapshot taken at the last turn edge says `false`, and
            // the composer's stop control (and the session's lifetime gates) read it. The end arm's
            // refresh below is the other half.
            "auto_compaction_start" | "manual_compaction_start" => {
                self.flush(app, session);
                session.emit(
                    app,
                    json!({
                        "type": "notice",
                        "level": "info",
                        "code": "engine_compacting",
                        "message": "The engine is compacting the context.",
                    }),
                );
                true
            }
            // The end of a compaction settles the line its start put up, and the refresh asked
            // for here is its other half: the occupancy the reader watches drops when the
            // compaction lands, which - mid-turn - is long before the turn holding it ends. The
            // notice's words and whether there is one at all are `compaction::compaction_end_notice`'s
            // rule.
            "auto_compaction_end" | "manual_compaction_end" => {
                self.flush(app, session);
                if let Some(notice) = compaction::compaction_end_notice(event_type, event) {
                    session.emit(app, notice);
                }
                true
            }
            "model_changed" | "thinking_level_changed" | "auto_retry_end" => true,
            // The engine's own turn boundaries, recognized and deliberately not rendered: the
            // desktop's turn is opened from `agent_start` and closed from `agent_end`, both of
            // which the SDK emits *inside* the turn, so a `turn_started` here would open a second
            // row for the same turn and a `turn_finished` would close it twice. An explicit arm is
            // the point: a projected type that fell through to the catch-all would be dropped with
            // nothing to notice it, which is what this arm used to be.
            "turn_start" | "turn_end" => false,
            // The one arm a frame should never reach. The router (`protocol.rs::route_frame`,
            // shared by the live stream and the replay) sends a type here only when it is listed in
            // `PROJECTED` (`host/routing.rs`), whose every member owns an arm above; a type in
            // neither table is counted and logged by the router itself and never gets this far.
            // Reaching this arm therefore means a type was added to the table without an arm, and it
            // is dropped rather than guessed at - which is what the table's doc requires an entry
            // to have.
            _ => false,
        }
    }

    /// Closes the turn a child's channel still shows as open, on the roster's own word that its run
    /// is over.
    ///
    /// The child's own stream is the first witness of its ending and the roster's edge is the
    /// second: the executor publishes that edge when the run ends whatever became of the stream (and
    /// this host synthesizes one for every child a stop killed), where the child's `agent_end` is
    /// deferred until its prompt unwinds and can be lost with the session a release disposes in that
    /// window. A screen attached to the child is waiting on exactly this frame - it is what ends the
    /// running line it drew - so a turn the stream did not close is closed here.
    ///
    /// `status` is the roster's own word for the run's exit (`completed` / `failed` / `aborted`). A
    /// projector with no open turn is left alone: the child ended its turn honestly, and the pair
    /// `finish_turn` synthesizes for a missing turn id belongs to a pending state this one is not.
    pub(crate) fn settle_from_roster(
        &mut self,
        app: &AppHandle,
        session: &Arc<SessionRuntime>,
        status: &str,
    ) {
        if self.turn_id.is_none() {
            return;
        }
        self.last_stop_reason = Some(roster_stop_reason(status).to_owned());
        self.closed_by_roster = true;
        self.finish_turn(app, session, None);
    }

    /// Completes the current turn, if any. `fallback` is used when the engine never
    /// reported a stop reason (for example a same-id scheduling failure).
    pub(crate) fn finish_turn(
        &mut self,
        app: &AppHandle,
        session: &Arc<SessionRuntime>,
        fallback: Option<(&'static str, Option<String>)>,
    ) {
        self.flush(app, session);
        let fallback_outcome = fallback.as_ref().map(|(outcome, _)| *outcome);
        let fallback_error = fallback.and_then(|(_, error)| error);
        let outcome = match self.last_stop_reason.as_deref() {
            Some("aborted") => "aborted",
            Some("error") => "failed",
            Some(_) => "completed",
            None => fallback_outcome.unwrap_or("completed"),
        };
        let error = self.last_error.clone().or(fallback_error);
        let turn_id = self.turn_id.take();
        self.last_stop_reason = None;
        self.last_error = None;
        self.current_message = None;
        // The per-turn bookkeeping goes with the turn: from here on no message of it can end, so
        // the ids and clocks it still held are the shape a long-lived session would otherwise grow
        // a little with every aborted or restarted turn. Both are keyed by the ids the wire does
        // not carry, and the turn that follows re-stamps them from its own frames.
        self.streamed.clear();
        self.clock.clear();
        session.set_streaming(false);
        let at = store::now_ms();
        match turn_id {
            Some(turn_id) => session.emit(
                app,
                json!({
                    "type": "turn_finished",
                    "turnId": turn_id,
                    "outcome": outcome,
                    "error": error,
                    "at": at,
                }),
            ),
            None => {
                // A turn the roster already closed may still be followed by the child's own
                // `agent_end`: that frame is deferred until its prompt unwinds, and a stop releases
                // the child's session inside that window, so it can arrive after `settle_from_roster`
                // ended the turn. The pair below exists for a prompt that never started a turn - a
                // pending state the UI has to leave - and emitting it here would open an empty row
                // under a turn the roster has already stated. The flag belongs to that one tail.
                if self.closed_by_roster {
                    self.closed_by_roster = false;
                    return;
                }
                let turn_id = self.new_turn_id();
                session.emit(
                    app,
                    json!({"type": "turn_started", "turnId": turn_id, "at": at}),
                );
                session.emit(
                    app,
                    json!({
                        "type": "turn_finished",
                        "turnId": turn_id,
                        "outcome": outcome,
                        "error": error,
                        "at": at,
                    }),
                );
            }
        }
    }

    /// Emits a session error and closes any turn it interrupted.
    pub(crate) fn report_error(
        &mut self,
        app: &AppHandle,
        session: &Arc<SessionRuntime>,
        code: &str,
        message: String,
    ) {
        self.flush(app, session);
        session.emit(
            app,
            json!({"type": "error", "code": code, "message": message}),
        );
        if self.turn_id.is_some() {
            self.last_stop_reason = Some("error".to_owned());
            self.last_error = Some(message);
            self.finish_turn(app, session, None);
        }
    }

    pub(crate) fn ensure_turn(&mut self, app: &AppHandle, session: &Arc<SessionRuntime>) {
        if self.turn_id.is_some() {
            return;
        }
        // A turn is starting, so the tail of whatever closed the last one is no longer anything a
        // later frame could be: the wake turn of a kept-alive child lands here.
        self.closed_by_roster = false;
        // The run whose messages this turn's `agent_end` may have to repair is this one: what the
        // last turn closed can no longer be missing from a run that has not started yet.
        self.finished.clear();
        let turn_id = self.new_turn_id();
        session.set_streaming(true);
        // Work has started again, so a finish mark left on the taskbar from the last turn is no
        // longer the current state of this conversation.
        if session.is_top_level() {
            presence::clear_attention(app);
        }
        session.emit(
            app,
            json!({"type": "turn_started", "turnId": turn_id, "at": store::now_ms()}),
        );
        self.turn_id = Some(turn_id);
    }

    /// Terminal delivery: bypasses the window. Every terminal event uses this, so a
    /// completion can never arrive before the text it closes.
    pub(crate) fn flush(&mut self, app: &AppHandle, session: &Arc<SessionRuntime>) {
        self.deliver(app, session, true);
    }

    /// Windowed delivery: called for every inbound frame and on every idle tick, and a
    /// no-op until the window elapsed or the buffer reached the frame budget.
    pub(crate) fn flush_due(&mut self, app: &AppHandle, session: &Arc<SessionRuntime>) {
        self.deliver(app, session, false);
    }

    fn deliver(&mut self, app: &AppHandle, session: &Arc<SessionRuntime>, force: bool) {
        let now_ms = store::now_ms();
        if !self.should_deliver(delivery_window_ms(session), force, now_ms) {
            return;
        }
        if self.channel().is_empty() {
            // Nothing is listening: drop the buffer rather than publish it nowhere.
            return;
        }
        for (message_id, buffer) in self.deltas.take(now_ms) {
            session.emit(app, delta_frame(&message_id, buffer.text, buffer.thinking));
        }
        for (_, payload) in std::mem::take(&mut self.tool_updates) {
            session.emit(app, payload);
        }
        // Everything this projector held is now on the wire, so the dispatcher's own pass can skip
        // this session again until the next increment arrives.
        session.clear_delta_pending();
    }

    fn should_deliver(&self, window_ms: i64, force: bool, now_ms: i64) -> bool {
        if self.deltas.is_empty() && self.tool_updates.is_empty() {
            return false;
        }
        force || self.deltas.due(now_ms, window_ms) || self.tool_update_due(now_ms, window_ms)
    }

    /// Holds the newest partial result of one call, replacing whatever was waiting for it.
    fn buffer_tool_update(&mut self, tool_call_id: String, payload: Value) {
        match self
            .tool_updates
            .iter_mut()
            .find(|(known, _)| known == &tool_call_id)
        {
            Some(waiting) => waiting.1 = payload,
            None => self.tool_updates.push((tool_call_id, payload)),
        }
    }

    /// Whether a held tool update has waited out the window.
    ///
    /// Measured on the same clock the deltas are delivered on, so one stream cannot carry two
    /// cadences: the first update after a quiet spell is due at once (its predecessor is the start
    /// of time, exactly like a first delta's), and everything after it waits the window.
    fn tool_update_due(&self, now_ms: i64, window_ms: i64) -> bool {
        !self.tool_updates.is_empty()
            && now_ms.saturating_sub(self.deltas.last_delivery_ms) >= window_ms
    }

    /// Channel every emission of this state goes to.
    fn channel(&self) -> String {
        self.owner_session.clone()
    }

    fn on_delta(&mut self, app: &AppHandle, session: &Arc<SessionRuntime>, event: &Value) {
        let Some(assistant_event) = event.get("assistantMessageEvent") else {
            return;
        };
        let Some(delta) = assistant_event.get("delta").and_then(Value::as_str) else {
            return;
        };
        if delta.is_empty() {
            return;
        }
        let kind = match assistant_event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "text_delta" => DeltaKind::Text,
            "thinking_delta" => DeltaKind::Thinking,
            // Tool-call argument deltas are not rendered live; the tool card is created
            // from `tool_execution_start`, which carries the final arguments.
            _ => return,
        };
        let event_role = message_role(event);
        if event_role != "assistant" {
            return;
        }
        let message_id = self.message_id_for(app, session, event);
        // Recorded as the fragment arrives rather than as it is delivered: what the end of the
        // message has to know is what its stream carried, and by then the buffer that carried it
        // has been taken by a flush.
        self.streamed
            .entry(message_id.clone())
            .or_default()
            .record(kind, delta);
        let now_ms = store::now_ms();
        self.clock.message_delta(&message_id, now_ms);
        self.deltas.push(&message_id, kind, delta);
        session.mark_delta_pending();
        let now_ms = store::now_ms();
        if self.should_deliver(delivery_window_ms(session), false, now_ms) {
            self.flush_due(app, session);
        }
    }

    /// The id a message's frames are addressed to, from whichever of the two names the engine is
    /// using, opening a row when it never announced one.
    ///
    /// The streaming path and the whole-message path resolve it through this one function, because
    /// the frontend keys its row by this id: a start, a body and an end that resolved differently
    /// would fill one row and complete another.
    fn message_id_for(
        &mut self,
        app: &AppHandle,
        session: &Arc<SessionRuntime>,
        event: &Value,
    ) -> String {
        if let Some(id) = event
            .get("message")
            .and_then(|message| message.get("id"))
            .and_then(Value::as_str)
        {
            return id.to_owned();
        }
        if let Some(current) = self.current_message.as_ref() {
            if current.role == "assistant" {
                return current.id.clone();
            }
        }
        // A message the engine never announced: open a bubble for it instead of dropping its
        // text or attaching it to a different role.
        //
        // The reading travels with the frame even though the engine announced nothing: a row opened
        // here is the same message a later history walk reads back out of the transcript, and the
        // walk's row is dated by the engine's own `timestamp` (`history.rs::timestamp_of`). One
        // reading on both sides is what lets the frontend pair the two rows as one message
        // (`sessionMessages.ts::twinKeys`) instead of drawing a half-written row beside the whole
        // one - which is exactly the shape a screen attached to a child presents when a message ends
        // inside the window between its subscribe and its first page.
        let id = self.next_message_id(event);
        let at = event.get("message").and_then(message_timestamp);
        session.emit(
            app,
            json!({"type": "message_started", "messageId": id, "role": "assistant", "at": at}),
        );
        self.current_message = Some(CurrentMessage {
            id: id.clone(),
            role: "assistant".to_owned(),
            key: event.get("message").and_then(message_key),
        });
        id
    }

    /// What a message's own record still owes the UI, when its stream did not carry it.
    ///
    /// A `custom` message owes its whole text. The engine writes the messages it injects from
    /// outside the turn - a background job's or a subagent's answer, a peer's aside, an advisor
    /// card - straight into the transcript, and publishes them as a `message_start`/`message_end`
    /// pair with the words inside the message instead of in deltas that never come. A user message
    /// is this side's own echo and a tool result is drawn from the tool execution frames, so
    /// neither is read here.
    ///
    /// An assistant message owes whatever its stream did not deliver. Its words are supposed to
    /// arrive as deltas, but a delta can be lost on the way: the host sheds queued increments under
    /// backpressure (`host/src/events.ts::sheddable`) and a shed increment is text no reader ever
    /// saw, which is how an answer reaches the screen as a fragment or - when every one of its
    /// deltas went - as no row at all, because the frontend draws no row for an answer with nothing
    /// in it. The engine's own record of the message is the authority on its words, and this is
    /// where the row is completed from it, before `message_finished`, so the row that is completed
    /// is the one that takes the message's usage.
    ///
    /// Only a prefix is repaired. A message the engine rewrote after streaming it (an inline macro
    /// expansion, `config.transformAssistantMessage`) no longer starts with what the reader watched
    /// arrive, and appending its record would show the answer twice; leaving it alone keeps the
    /// words that did arrive. A message the engine marked `display: false` owes nothing: that is the
    /// engine saying the entry is context for the model rather than conversation, which is the one
    /// place it has to stay out of.
    ///
    /// Every id is spent here whichever way the answer goes - a record that outlived its message
    /// must not be inherited by the next message reusing an id.
    fn message_end_repair(&mut self, message: Option<&Value>, ids: &[&str]) -> (String, String) {
        let mut streamed = DeltaBuffer::default();
        for id in ids {
            if let Some(buffer) = self.streamed.remove(*id) {
                streamed.text.push_str(&buffer.text);
                streamed.thinking.push_str(&buffer.thinking);
            }
        }
        let Some(message) = message else {
            return (String::new(), String::new());
        };
        match message.get("role").and_then(Value::as_str) {
            Some("custom") => {
                // A skill invocation owes nothing either: its content is the expanded SKILL.md the
                // model reads, and its row is the user's own draft, which that row already carries.
                // A delivery whose words did stream is not owed them a second time.
                if message.get("display").and_then(Value::as_bool) == Some(false)
                    || is_user_skill_prompt(message)
                    || !streamed.text.is_empty()
                {
                    return (String::new(), String::new());
                }
                // Read the way the transcript and the history walk read a message's words, so a
                // delivery looks the same while it arrives as it does after the session is reopened.
                (super::content_text(message.get("content")), String::new())
            }
            Some("assistant") => (
                missing_tail(&super::content_text(message.get("content")), &streamed.text),
                missing_tail(
                    &super::history::thinking_text(message.get("content")),
                    &streamed.thinking,
                ),
            ),
            _ => (String::new(), String::new()),
        }
    }

    fn next_message_id(&mut self, event: &Value) -> String {
        if let Some(id) = event
            .get("message")
            .and_then(|message| message.get("id"))
            .and_then(Value::as_str)
        {
            return id.to_owned();
        }
        self.next_row_id()
    }

    /// A row id for a message the engine named nothing of: this projector's own identity for it.
    ///
    /// `m<token>-<n>` rather than `m<n>`: the record the frame lands in keeps its rows across
    /// session opens and host restarts, so the name has to be unique for the conversation's whole
    /// life rather than for this projector's (`EventState::mint`).
    fn next_row_id(&mut self) -> String {
        self.message_seq += 1;
        format!("m{}-{}", self.mint, self.message_seq)
    }

    /// The ending the turn will report, read off the message the engine just closed.
    ///
    /// Kept here rather than read at the turn's end because the engine states it once, on the
    /// message: a turn that ended on a stop must not read as a success, and a turn whose last
    /// message was retried away keeps the reason of the attempt that did end it.
    fn remember_ending(&mut self, message: &Value) {
        self.last_stop_reason = message
            .get("stopReason")
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.last_error = message
            .get("errorMessage")
            .and_then(Value::as_str)
            .map(sanitize_message);
    }

    /// Completes one message's row: the words its stream did not deliver, its usage, and its ending.
    ///
    /// Shared by `message_end` - the frame that normally closes a row - and by [`Self::repair_run`],
    /// which closes a row whose own frames never arrived. One body for both is what makes a repaired
    /// row the same row a streamed one would have been: same id, same clock, same usage and ending.
    ///
    /// What the message's own record still owes the UI goes out before the message is closed: a
    /// message the engine delivered in one piece (the answer a background job or a subagent hands
    /// back, a peer's aside, an advisor card) has its words in the message rather than in deltas
    /// that never came, and an answer whose deltas were shed on the way here has the rest of its
    /// words there too. Both belong to the row the announcement opened - the same frame the
    /// streaming path uses, so the row fills exactly as a streamed one does instead of staying
    /// empty until a frontend that elides empty rows drops it - and both go out before
    /// `message_finished`, so the row that is completed is the one that takes the message's usage.
    fn close_message(
        &mut self,
        app: &AppHandle,
        session: &Arc<SessionRuntime>,
        message: Option<&Value>,
        announced: Option<CurrentMessage>,
    ) {
        if let Some(message) = message {
            self.remember_ending(message);
        }
        self.flush(app, session);
        // The id a message is known by can change between its deltas and its end, so every id it
        // was announced under resolves the same host-clock start.
        let wire_id = message
            .and_then(|message| message.get("id"))
            .and_then(Value::as_str);
        let message_id = match announced.as_ref() {
            Some(announced) => announced.id.clone(),
            None => match wire_id {
                Some(wire_id) => wire_id.to_owned(),
                None => self.next_row_id(),
            },
        };
        let mut ids: Vec<&str> = Vec::with_capacity(2);
        if let Some(announced) = announced.as_ref() {
            ids.push(announced.id.as_str());
        }
        if let Some(wire_id) = wire_id {
            ids.push(wire_id);
        }
        let (text, thinking) = self.message_end_repair(message, &ids);
        let started_at = self.clock.message_end(&ids);
        let frames = close_frames(
            &message_id,
            started_at,
            store::now_ms(),
            text,
            thinking,
            message,
        );
        if let Some(key) = message.and_then(message_key) {
            self.finished.insert(key);
        }
        for frame in frames {
            session.emit(app, frame);
        }
    }

    /// Delivers the messages of a finished run whose own frames never reached this projector.
    ///
    /// `agent_end` carries the run's own messages and is the one frame that states the turn's end,
    /// so it is also the last place a lost answer exists on this side. A loss upstream is silent
    /// here: no frame is missing from a sequence this side can count (the host numbers what it
    /// sends, not what it drops), so the only way to see it is to compare the run's own record with
    /// what was closed - which is what [`unclosed_messages`] does.
    ///
    /// Each owed message is delivered through [`Self::close_message`], under the id its own
    /// announcement opened when that announcement did arrive (the reader's half-written row, dated
    /// by the announcement) and under a fresh row otherwise, dated by the engine's own `timestamp`
    /// so a later history walk pairs the two rows as one message. Repairing the row rather than the
    /// whole transcript is deliberate: the words are what the frame carries, and the rows around
    /// them are the reader's own, which a replay would move.
    fn repair_run(&mut self, app: &AppHandle, session: &Arc<SessionRuntime>, event: &Value) {
        let Some(messages) = event.get("messages").and_then(Value::as_array) else {
            return;
        };
        for message in unclosed_messages(messages, &self.finished) {
            let key = message_key(message);
            // The row this message's own announcement opened, when it is still open: it is the one
            // the reader is looking at, and the repair then owes only the words that never arrived.
            let announced = match self.current_message.as_ref() {
                Some(current) if current.key.is_some() && current.key == key => {
                    self.current_message.take()
                }
                // A row announced for some other message must not be reused: its own words may
                // still arrive, and two messages ending on one id would overwrite each other.
                _ => None,
            };
            let announced = match announced {
                Some(announced) => announced,
                None => self.open_row(app, session, message, key),
            };
            self.close_message(app, session, Some(message), Some(announced));
        }
    }

    /// Opens the row for a message whose own announcement never arrived.
    fn open_row(
        &mut self,
        app: &AppHandle,
        session: &Arc<SessionRuntime>,
        message: &Value,
        key: Option<String>,
    ) -> CurrentMessage {
        let id = message
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| self.next_row_id());
        session.emit(
            app,
            json!({
                "type": "message_started",
                "messageId": id,
                "role": "assistant",
                "at": message_timestamp(message),
            }),
        );
        CurrentMessage {
            id,
            role: "assistant".to_owned(),
            key,
        }
    }

    fn new_turn_id(&mut self) -> String {
        self.turn_seq += 1;
        // Same reason as the row ids (`EventState::mint`): a turn id names a turn a reader may
        // still hold, and a counter alone would name the new one after an old one.
        format!("turn-{}-{}", self.mint, self.turn_seq)
    }
}

/// A token no other projector instance in this process — and no earlier run of it — will mint.
///
/// The process's own start clock plus this instance's number: `EventState` is created per session
/// open, so the instance part separates two projectors of one conversation inside a run, and the
/// clock part separates a run from the host that replaced it under a window that never reloaded.
fn mint_token() -> String {
    static INSTANCES: AtomicU64 = AtomicU64::new(0);
    // When this process started, as the seed of every token it mints.
    static BOOT: LazyLock<u128> = LazyLock::new(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_nanos())
            .unwrap_or_default()
    });
    let instance = INSTANCES.fetch_add(1, Ordering::Relaxed);
    format!("{:x}.{instance:x}", *BOOT)
}

#[cfg(test)]
mod tests;

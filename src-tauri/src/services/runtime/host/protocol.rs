//! The inbound side: one frame at a time from the host's stdout.
//!
//! Every frame is either the handshake, a response to a request this process sent, or an event
//! for one session. Responses are matched by `id` - never by arrival order, because the host
//! dispatches sessions concurrently - and session events carry the id of the conversation they
//! belong to plus a `seq`, which is what lets a missing frame be noticed and repaired instead of
//! leaving the UI with a gap it cannot see.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use super::super::{events, sanitize_message, ui, DELTA_FLUSH_MS, PROTOCOL_VERSION};
use super::replay;
use super::routing::{self, Route};
use super::session::{self, FrameOrder, SessionRuntime};
use super::{HelloInfo, HostRuntime, Inbound, InboundBudget};
use crate::errors::{IpcError, ENGINE_PROTOCOL, ENGINE_REQUEST_FAILED, ENV_PIN_FAILED};
use crate::services::log;
use crate::services::runtime::protocol::FrameLimits;
use crate::services::session_index;

/// Reads frames until the host's stdout ends, then ends the generation.
///
/// The budget is closed when this loop ends, whatever the reason: the reader thread waits on it
/// when the queue is over its byte ceiling, and a loop that stopped - by `Closed`, by a panic, or
/// by the task being aborted - is one that will never release another byte.
///
/// **Nothing in this loop may await a round trip to the host.** The byte budget makes the reader
/// stop reading once the queue is full, and a host with a full stdout pipe stops reading its stdin
/// in turn; a request answered only by that host would therefore never be answered, while this loop
/// is exactly what has to keep draining to release the budget. Every host call a handler needs -
/// a state refresh, a replay - is spawned, and this loop only ever waits on this process's own
/// locks and timers.
pub(super) async fn run(
    host: HostRuntime,
    generation: u64,
    mut inbound: tokio::sync::mpsc::Receiver<Inbound>,
    budget: Arc<InboundBudget>,
) {
    let _closed_on_exit = BudgetClose(Arc::clone(&budget));
    loop {
        // The receive deadline doubles as the delta window: while the host streams, frames arrive
        // and buffered text is delivered once the window elapsed; while it is quiet, this tick
        // delivers what is left.
        let message =
            tokio::time::timeout(Duration::from_millis(DELTA_FLUSH_MS), inbound.recv()).await;
        match message {
            Err(_) => {
                flush(&host, false).await;
                note_turn_activity(&host);
            }
            Ok(Some(Inbound::Frame(frame, bytes))) => {
                flush(&host, false).await;
                handle(&host, generation, frame).await;
                // Released after the handler returned, so the ceiling describes the memory the
                // frame actually holds: the parsed frame is dropped inside `handle`.
                budget.release(bytes);
                note_turn_activity(&host);
            }
            Ok(Some(Inbound::Malformed(reason))) => {
                flush(&host, true).await;
                report_malformed(&host, reason).await;
            }
            Ok(Some(Inbound::Closed)) | Ok(None) => break,
        }
    }
    let code = host.exit_code().await;
    host.finalize(generation, code).await;
}

/// Closes the inbound budget when the dispatcher stops, however it stops.
///
/// A guard rather than a call at the end of [`run`]: a panic inside a handler would leave the
/// reader waiting for a release that cannot come, and that thread would then live as long as the
/// process.
struct BudgetClose(Arc<InboundBudget>);

impl Drop for BudgetClose {
    fn drop(&mut self) {
        self.0.close();
    }
}

/// Every live session flushes what it buffered, and every child transcript does too. `force` is the
/// terminal case: a rejected line or a closing stream must not swallow text that was already
/// received.
///
/// A session with nothing buffered is skipped without touching its projector: this pass runs on
/// every inbound frame, and a conversation that is idle (or whose increments already went out) must
/// not cost a lock per frame - the command the host streams on is per token, so the scan is on the
/// hot path of every session in the process. A child's own projector is asked the same question the
/// same way (`child_events::ChildProjections::pending`), because a child's stream is the same kind
/// of stream and its window is the same window.
async fn flush(host: &HostRuntime, force: bool) {
    // A window that cannot run its own posted closure cannot draw what would be flushed now.
    // Keeping the buffers until it answers is what stops the main-thread queue from growing while
    // it is the thing that has to drain; the next tick after recovery sends them coalesced.
    // A forced flush is the closing stream's last chance to deliver, so it is not held back.
    if !force && crate::services::main_thread_watch::stalled() {
        return;
    }
    let app = host.app().clone();
    for session in host.sessions().iter() {
        if !force && !session.has_pending_deltas() {
            continue;
        }
        let mut events = session.events.lock().await;
        if force {
            events.flush(&app, session);
        } else {
            events.flush_due(&app, session);
        }
    }
    // A process with no attached child transcript - the ordinary case - pays one relaxed load for
    // this and no lock at all (`child_events::ChildProjections::has_children`).
    if host.child_projections().has_children() {
        for child in host.child_projections().pending() {
            let mut events = child.events.lock().await;
            if force {
                events.flush(&app, &child);
            } else {
                events.flush_due(&app, &child);
            }
        }
    }
}

/// Tells the process tuning whether any conversation has a turn in flight.
///
/// The background demotion is suspended for exactly as long as one does (`process_tuning`), so the
/// answer has to follow the frames that move it rather than the window's focus alone: a reader who
/// brushes the page of another application and comes straight back must not leave the answer they
/// are waiting on throttled. The value is compared inside the callee, so an unchanged answer costs
/// one atomic on this, the frame path.
fn note_turn_activity(host: &HostRuntime) {
    let running = host.sessions().iter().any(|session| session.is_streaming());
    crate::services::process_tuning::set_turn_running(running);
}

/// One rejected line has no session of its own, so it is reported to the conversations that are
/// running - the only ones that could have been mid-answer - and counted on the host.
async fn report_malformed(host: &HostRuntime, reason: String) {
    host.note_frame_seen(true);
    let app = host.app().clone();
    for session in host.sessions().iter() {
        if !session.is_streaming() {
            continue;
        }
        let mut events = session.events.lock().await;
        events.report_error(&app, session, ENGINE_PROTOCOL, reason.clone());
    }
}

async fn handle(host: &HostRuntime, generation: u64, frame: Value) {
    if !host.is_current(generation) {
        return;
    }
    // Every frame that names one of this process's sessions accounts for its sequence number
    // here, once, before any branch looks at it. The dedicated branches below are not exempt: the
    // host stamps every frame it publishes for a session, so a prompt result or a dialog carries a
    // `seq` too, and a frame that skipped this would leave the cursor behind - which turns the
    // next frame into a reported hole, a pointless replay and a dropped live frame.
    if let Some(session) = session_named(host, &frame) {
        if note_frame_seq(host, &session, &frame, false) != FrameOrder::Next {
            return;
        }
    }
    let frame_type = routing::frame_type(&frame);
    match frame_type {
        "hello" => on_hello(host, generation, &frame),
        "ready" => host.mark_ready(generation),
        "host_fatal" => on_fatal(host, generation, &frame),
        // The host is on its way out; the EOF that follows does the reporting.
        "host_exit" => {}
        "response" => on_response(host, &frame).await,
        // A chunk only reaches this point when the decoder could not reassemble it, i.e. it was
        // not part of a well-formed sequence.
        "rpc_chunk" => host.note_frame_seen(true),
        // Everything else belongs to a session, and [`route_frame`] is the one place a session
        // frame is routed: the live stream and the replay both come through it, so a frame type
        // cannot be handled one way live and another way when it comes back from the journal.
        _ => route_frame(host, &frame).await,
    }
}

/// Routes one frame that belongs to a session - live, or restored from a replay.
///
/// Two paths deliver session frames here, and the journal is what makes them the same stream: it
/// keeps every frame that went out, numbered consecutively (`host/src/events.ts`), so a frame this
/// reader is missing is one the journal can hand back. A type that reached one handler live
/// therefore has to reach the same handler when it is replayed - otherwise a repaired hole looks
/// different from a delivery that was never lost, which is the failure the repair exists to prevent.
///
/// The one hole no replay can fill is the frame the host's own outbound budget took: the budget runs
/// before a frame is numbered, so what it takes was never published and never left a hole at all.
/// What is left for a replay is a reader that fell further behind than the journal's window, and a
/// line this process could not reassemble.
pub(super) async fn route_frame(host: &HostRuntime, frame: &Value) {
    match routing::route_of(routing::frame_type(frame)) {
        // A state snapshot is the host's own view of the session, in the same shape
        // `session_state` answers with.
        Route::Snapshot => on_event(host, frame, Projection::State).await,
        // The engine's live subagent roster: a frame the host composes itself from the engine's own
        // reports rather than an engine session event, so it has a lane of its own and a place in
        // neither of the engine's two tables.
        Route::Roster => on_subagent(host, frame).await,
        // A side question's answer: the host's own stream for the side panel, not an engine event.
        Route::Btw => on_btw(host, frame).await,
        // A child's own session event, forwarded so a running subagent can be watched while it
        // works. It names its child by transcript instead of being one of this process's sessions,
        // and nothing here registers one (`on_subagent_event`).
        Route::SubagentEvent => on_subagent_event(host, frame).await,
        Route::Projector => on_event(host, frame, Projection::Event).await,
        Route::Dialog => on_ui_frame(host, frame).await,
        Route::DialogCancel => on_ui_cancel(host, frame).await,
        Route::ExtensionError => on_extension_error(host, frame).await,
        Route::Commands => on_commands(host, frame).await,
        // A standalone error frame: the session-level report the frontend renders as a failure.
        Route::Failure => on_error_frame(host, frame).await,
        Route::PromptResult => on_prompt_result(host, frame).await,
        // The host's own request: the agent's tool asking what the user's terminals have printed, or
        // typing into one. Nothing about it reaches a page - a pty is this process's own. It is not
        // awaited: the handler hands the work to its own task, because the answer it owes is a
        // frame only this loop can receive.
        Route::TerminalRequest => super::terminal::on_terminal_request(host, frame),
        // The agent's own browser page: the tool asks, the application resolves the page of the
        // session that routed the frame, and the answer is a frame only this loop can receive.
        Route::BrowserRequest => super::browser::on_browser_request(host, frame),
        Route::Ignored => host.note_frame_seen(false),
        // Recognized by neither table nor lane: counted and logged rather than dropped in silence,
        // because a frame nobody can name is what a missing arm looks like from here.
        Route::Unregistered => {
            host.note_frame_seen(true);
            log::warn(&format!(
                "unregistered host frame {}",
                routing::frame_type(frame)
            ));
        }
    }
}

/// The host greets first, with everything this process needs to decide it is talking to the
/// build it was compiled against.
fn on_hello(host: &HostRuntime, generation: u64, frame: &Value) {
    let text = |key: &str| {
        frame
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let limits = frame.get("limits");
    let advertised = FrameLimits {
        protocol_version: PROTOCOL_VERSION,
        max_frame_bytes: limits
            .and_then(|limits| limits.get("maxFrameBytes"))
            .and_then(Value::as_u64)
            .map(|value| value.max(1).min(super::super::MAX_FRAME_LIMIT as u64) as usize)
            .unwrap_or(FrameLimits::default().max_frame_bytes),
        // A host that omits this key is not an error: the default is what this process would have
        // used anyway (contract §8 F7).
        max_reassembled_bytes: limits
            .and_then(|limits| limits.get("maxReassembledFrameBytes"))
            .and_then(Value::as_u64)
            .map(|value| (value.max(1) as usize).min(super::super::MAX_REASSEMBLED_LIMIT))
            .unwrap_or(FrameLimits::default().max_reassembled_bytes),
    };
    host.note_hello(
        generation,
        HelloInfo {
            host_version: text("hostVersion"),
            sdk_version: text("sdkVersion"),
            bun_version: text("bunVersion"),
            target: text("target"),
        },
        advertised,
    );
}

/// `host_fatal` is the host refusing to run at all - a pinned directory it disagrees with, or a
/// protocol it cannot speak. Neither gets better by restarting it, so this is reported as data and
/// the process is left alone.
fn on_fatal(host: &HostRuntime, generation: u64, frame: &Value) {
    let code = frame
        .get("code")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(ENV_PIN_FAILED);
    let detail = frame
        .get("detail")
        .and_then(Value::as_str)
        .map(sanitize_message)
        .unwrap_or_default();
    let message = if detail.is_empty() {
        "The engine host refused the directories it was started with.".to_owned()
    } else {
        format!("The engine host refused to start ({detail}).")
    };
    host.note_fatal(generation, IpcError::from_engine(Some(code), message));
}

async fn on_response(host: &HostRuntime, frame: &Value) {
    let success = frame
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(id) = frame.get("id").and_then(Value::as_str) else {
        // A response that names no request cannot be attributed to one. A failure still belongs to
        // the conversations that are running - the host refused a command it could not name - but a
        // success is an acknowledgement of a request nobody here is waiting for, and reporting it
        // as a protocol-level failure put an `ENGINE_PROTOCOL` error on every streaming session.
        if unattributed_failure(frame) {
            let message = error_text(frame, "The engine host reported a protocol-level failure.");
            let app = host.app().clone();
            for session in host.sessions().iter() {
                if !session.is_streaming() {
                    continue;
                }
                let mut events = session.events.lock().await;
                events.report_error(&app, session, ENGINE_PROTOCOL, message.clone());
            }
        } else {
            // Recognized, and nothing this process can act on: counted, not reported.
            host.note_frame_seen(true);
        }
        return;
    };
    // A command this process sent without waiting for an answer - the `host_shutdown`
    // acknowledgement - names a request that really was made, so its response is recognized and
    // dropped rather than counted as a frame the host sent on its own.
    if host.take_unawaited(id) {
        return;
    }
    let claimed = host.take_pending(id);
    if let Some((sender, prompt, session_id)) = claimed {
        let _ = sender.send(frame.clone());
        if prompt {
            if let Some(session) = session_id
                .as_deref()
                .and_then(|session_id| host.session(session_id))
            {
                on_prompt_answered(host, &session, frame, success).await;
            }
        }
        return;
    }
    // A second response for an acknowledged prompt is the SDK's asynchronous scheduling failure;
    // the id is what identifies it, and it belongs to the session that sent the prompt.
    if let Some(session_id) = host.is_late_prompt(id) {
        host.forget_prompt(id);
        if !success {
            if let Some(session) = host.session(&session_id) {
                let message = error_text(frame, "The engine could not schedule the prompt.");
                let mut events = session.events.lock().await;
                events.report_error(
                    &host.app().clone(),
                    &session,
                    ENGINE_REQUEST_FAILED,
                    message,
                );
            }
        }
        return;
    }
    host.note_frame_seen(true);
    log::warn(&format!(
        "a response frame did not match any pending request id: {id} - the request it answers was given up on"
    ));
}

/// The acknowledgement of a prompt decides whether a turn is running.
async fn on_prompt_answered(
    host: &HostRuntime,
    session: &Arc<SessionRuntime>,
    frame: &Value,
    success: bool,
) {
    if !success {
        // The caller receives this failure from the command itself, and no turn started.
        session.set_streaming(false);
        return;
    }
    let agent_invoked = frame
        .get("data")
        .and_then(|data| data.get("agentInvoked"))
        .and_then(Value::as_bool);
    {
        let app = host.app().clone();
        let mut events = session.events.lock().await;
        if agent_invoked == Some(false) {
            events.finish_turn(&app, session, Some(("completed", None)));
        } else {
            session.set_streaming(true);
            events.ensure_turn(&app, session);
        }
    }
    replay::refresh_state(host, session);
}

async fn on_prompt_result(host: &HostRuntime, frame: &Value) {
    let Some(session) = session_of(host, frame) else {
        return;
    };
    let app = host.app().clone();
    let mut events = session.events.lock().await;
    events.flush(&app, &session);
    let agent_invoked = frame
        .get("agentInvoked")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !agent_invoked {
        events.finish_turn(&app, &session, Some(("completed", None)));
    }
    drop(events);
    if !agent_invoked {
        replay::refresh_state(host, &session);
    }
}

async fn on_ui_frame(host: &HostRuntime, frame: &Value) {
    let Some(session) = session_of(host, frame) else {
        return;
    };
    {
        let app = host.app().clone();
        let mut events = session.events.lock().await;
        // A dialog must never overtake the text that prompted it.
        events.flush(&app, &session);
    }
    match ui::handle_request(host, &host.app().clone(), &session, frame) {
        ui::UiDisposition::Delivered
        | ui::UiDisposition::Cancelled
        | ui::UiDisposition::Notice
        | ui::UiDisposition::Opened => {}
        ui::UiDisposition::Projected
        | ui::UiDisposition::Unsupported
        | ui::UiDisposition::MissingId => host.note_frame_seen(false),
    }
}

/// The host's own cancellation notice: the request it names is void, so the dialog has to close.
async fn on_ui_cancel(host: &HostRuntime, frame: &Value) {
    let Some(session) = session_of(host, frame) else {
        return;
    };
    let request_id = frame
        .get("id")
        .or_else(|| frame.get("requestId"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if request_id.is_empty() {
        host.note_frame_seen(false);
        return;
    }
    ui::cancel_request(host, &host.app().clone(), &session, request_id);
}

async fn on_extension_error(host: &HostRuntime, frame: &Value) {
    let Some(session) = session_of(host, frame) else {
        return;
    };
    let detail = sanitize_message(
        frame
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    session.events.lock().await.report_error(
        &host.app().clone(),
        &session,
        ENGINE_PROTOCOL,
        format!("Engine extension error: {detail}"),
    );
}

/// The engine's advertisement for a session, which is a *signal* rather than the data.
///
/// The list itself travels in the session's state - the host carries it in the open response and
/// in every snapshot it publishes after one - so nothing here keeps a copy: an advertisement that
/// arrives before this process has registered the session it names (which is exactly what happens
/// while a session is being opened) would leave that copy empty for good, and the state that
/// follows it would disagree with the one thing the frontend reads. What this handler does is
/// account for an advertisement whose payload cannot be used at all, and put it on the wire in
/// order.
async fn on_commands(host: &HostRuntime, frame: &Value) {
    let Some(session) = session_of(host, frame) else {
        return;
    };
    let Some(dropped) = unusable_commands(frame) else {
        host.note_frame_seen(true);
        return;
    };
    if dropped > 0 {
        host.note_frame_dropped(dropped as u64);
    }
    session
        .events
        .lock()
        .await
        .flush(&host.app().clone(), &session);
}

/// What one session frame becomes on the frontend channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Projection {
    /// An engine event, normalized by the projector.
    Event,
    /// A state snapshot, which replaces the session's view instead of extending it.
    State,
}

/// A session event: routed by `sessionId`, ordered by `seq`, repaired by `session_replay`.
async fn on_event(host: &HostRuntime, frame: &Value, projection: Projection) {
    let Some(session) = session_of(host, frame) else {
        return;
    };
    dispatch(host, &session, frame, projection).await;
}

/// The one place a frame's `seq` is accounted for.
///
/// Every path that routes a session frame goes through here - the live stream for each of the
/// frame types `handle` knows, and the replay loop for each journal entry - so no branch can move
/// the cursor on its own or forget to. A frame that turns out to be ahead of the cursor is handed
/// to [`replay::trigger_replay`], which is what turns a hole into a resend instead of a lost live
/// frame.
pub(super) fn note_frame_seq(
    host: &HostRuntime,
    session: &Arc<SessionRuntime>,
    frame: &Value,
    from_replay: bool,
) -> FrameOrder {
    let order = session.accept_seq(frame.get("seq").and_then(Value::as_u64), from_replay);
    if order == FrameOrder::Gap {
        replay::trigger_replay(host, session);
    }
    order
}

/// The session a frame names, for a caller that has its own bookkeeping to do with it. Nothing is
/// counted here: a frame for a session this process does not know is reported by [`session_of`],
/// which is the one place that decides what an unknown session means.
fn session_named(host: &HostRuntime, frame: &Value) -> Option<Arc<SessionRuntime>> {
    frame
        .get("sessionId")
        .and_then(Value::as_str)
        .and_then(|session_id| host.session(session_id))
}

/// Projects one frame this process has already accepted in order.
///
/// The `seq` was accounted for by [`note_frame_seq`] before this call - once for the live stream,
/// once per journal entry during a replay - so nothing here may move the cursor again.
async fn dispatch(
    host: &HostRuntime,
    session: &Arc<SessionRuntime>,
    frame: &Value,
    projection: Projection,
) {
    match projection {
        Projection::State => {
            // The payload is the session's own state, wrapped or inlined: both spellings name the
            // same object, and the one the host uses must not be guessed from the outside.
            let payload = frame.get("state").unwrap_or(frame);
            session.set_streaming(
                payload
                    .get("isStreaming")
                    .and_then(Value::as_bool)
                    .unwrap_or_else(|| session.is_streaming()),
            );
            session::emit_state(host.app(), session, payload);
        }
        Projection::Event => {
            let app = host.app().clone();
            let mut events = session.events.lock().await;
            if events.on_event(&app, session, frame) {
                // A refresh must not overtake buffered text either.
                events.flush(&app, session);
                drop(events);
                replay::refresh_state(host, session);
            }
        }
    }
}

/// A side question's frame, as the engine's controller reported it through the host.
///
/// Nothing in the main transcript changes when a side question answers, so this is neither an
/// engine event nor a state snapshot: the side panel reads it as its own stream, and the frame
/// reaches the page with the session's sequence number like every other frame.
async fn on_btw(host: &HostRuntime, frame: &Value) {
    let Some(session) = session_of(host, frame) else {
        return;
    };
    let kind = frame
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if kind != "delta" && kind != "record" && kind != "cleared" {
        host.note_frame_seen(true);
        log::warn(&format!("unregistered btw frame kind {kind:?}"));
        return;
    }
    session.emit(&host.app().clone(), frame.clone());
}

/// The engine's live subagent roster for one session, as the host hands it over.
///
/// `kind` says which half of a child the payload carries; a kind this build does not know is
/// counted the way every other frame the router cannot use is counted, and nothing is published for
/// it - half a row drawn as a whole one would show a child with facts nobody sent.
async fn on_subagent(host: &HostRuntime, frame: &Value) {
    let Some(session) = session_of(host, frame) else {
        return;
    };
    let Some((kind, payload)) = subagent_half(frame) else {
        host.note_frame_seen(true);
        log::warn(&format!(
            "unregistered subagent frame kind {:?}",
            frame
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ));
        return;
    };
    events::on_subagent(host.app(), &session, kind, payload);
    // The same edge ends the child's own channel when a screen is attached to it: the roster's
    // settle frame is the run's terminal fact, and the child's own `agent_end` can be lost in the
    // window a stop disposes its session in.
    if kind == "lifecycle" {
        settle_child_channel(host, payload).await;
    }
}

/// Closes a child's own channel on the roster's word that its run is over.
///
/// The child's own stream is the first witness of its ending and the roster's lifecycle edge is the
/// second: the executor publishes that edge when the run ends whatever became of the stream, and
/// this host synthesizes one for every child a stop killed. The child's own `agent_end` is deferred
/// until its prompt unwinds (`session/agent-session.ts`'s `#pendingAgentEndEmit`), and a stop
/// releases the child's session inside that window - so the frame that would end the running line a
/// screen attached to that child is drawing is the one that can go missing. Nothing here invents an
/// outcome: the edge names the run's own exit, and the projector it is handed to
/// (`events::EventState::settle_from_roster`) closes a turn only if one is still open.
///
/// A frame that names no transcript, a child this process never projected (no screen ever opened it,
/// `child_events::ChildProjections::get`), and a status that is not one of the three endings all
/// end here as no-ops. The transcript is resolved through the same gate the child's own events are
/// (`validate_session_file`), so the id this looks a projector up by is the id that addressed it.
async fn settle_child_channel(host: &HostRuntime, payload: &Value) {
    let status = payload
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(status, "completed" | "failed" | "aborted") {
        return;
    }
    let Some(file) = payload
        .get("sessionFile")
        .and_then(Value::as_str)
        .filter(|file| !file.is_empty())
    else {
        return;
    };
    let Ok(file) = super::super::session::validate_session_file(host, file) else {
        return;
    };
    let Some(child) = host
        .child_projections()
        .get(&session_index::host_session_id(Path::new(&file)))
    else {
        return;
    };
    let mut events = child.events.lock().await;
    events.settle_from_roster(host.app(), &child, status);
}

/// The half of a child one `subagent` frame carries: the host's own word for which half it is, and
/// the payload to merge into the roster.
///
/// `None` for a kind this build does not know, and for a frame that names none: half a row drawn as
/// a whole one would show a child with facts nobody sent. A known kind with no payload at all is
/// the other shape - a frame with nothing to merge - and the roster answers it with "nothing
/// changed" rather than with an error, because a child with no facts is not a row.
fn subagent_half(frame: &Value) -> Option<(&str, &Value)> {
    let kind = frame
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| matches!(*kind, "lifecycle" | "progress"))?;
    Some((kind, frame.get("payload").unwrap_or(&Value::Null)))
}

/// One child's own session event, forwarded by the host, projected and published on the child's
/// channel.
///
/// A child is not one of this process's sessions and is not made into one here: the frame names the
/// transcript the engine is writing, and the channel is derived from that file
/// (`session_index::host_session_id`, the id every other surface addresses the child by). Nothing is
/// registered, opened, listed or rebuilt - the record the projector is carried by is kept out of the
/// registry (`child_events`), so no command can address a child as a conversation and a restart
/// cannot resurrect one.
///
/// The event is *projected*, not forwarded: the desktop draws a child's transcript with the same
/// reducer it draws a conversation with (`src/stores/sessionEvents.ts`), and that reducer reads this
/// process's vocabulary. A payload the engine published verbatim (`{type: "session_event", event}`)
/// is a frame no reader of that channel has a branch for - which left a running child's live turn
/// undrawn and its reading of "still working" impossible to settle. One projector serves one child
/// (`child_events::ChildProjections`), so a child's frames are the same shape as a conversation's
/// and the frontend keeps one reducer.
///
/// The buffered increments of the child streams are delivered by the same window the conversations
/// use: `flush` below walks both maps.
async fn on_subagent_event(host: &HostRuntime, frame: &Value) {
    let Some((agent_id, session_file, event)) = subagent_event_parts(frame) else {
        host.note_frame_dropped(1);
        log::warn("dropped a subagent_event with no agent id, session file or event");
        return;
    };
    // The transcript is checked the way every other caller-addressed path is (`session::delete`
    // reads it through the same gate) - `super::super::session` is the command-side module that owns
    // it, not this folder's `SessionRuntime`. A path outside the engine's data root names no
    // conversation this app may address, and a frame is not a reason to relax that.
    let file = match super::super::session::validate_session_file(host, session_file) {
        Ok(file) => file,
        Err(_) => {
            host.note_frame_dropped(1);
            log::warn(&format!(
                "dropped a subagent_event for {agent_id}: its session file is not one this app can address"
            ));
            return;
        }
    };
    let session_id = session_index::host_session_id(Path::new(&file));
    // Only a transcript a screen has open (`child_watch`) is projected. A child's events arrive once
    // per token, and the ordinary case is a subagent running with no tab on it: projecting those
    // into a channel nobody listens to is the heaviest work this bridge can do for nothing. The
    // parent's roster frame still reports the child, and a transcript opened later is read from disk
    // and followed from that point on.
    if !host.is_child_watched(&session_id) {
        return;
    }
    // The steady state - a screen attached to a child whose frames are already flowing - reaches the
    // projector through the map alone; the child's own facts are resolved only when the first frame
    // for it arrives, because they are written onto the record and read no further (`child_events`).
    let projections = host.child_projections();
    let projector = match projections.get(&session_id) {
        Some(existing) => existing,
        None => {
            // The conversation the child belongs to, when this process still holds it: it is where
            // the child ran. Asked of the registry directly rather than through `session_of`,
            // because a child's frame is not an event *of* that conversation: one that arrived after
            // its parent was closed names no unknown vocabulary and must not be charged as one.
            let cwd = frame
                .get("sessionId")
                .and_then(Value::as_str)
                .and_then(|parent_id| host.session(parent_id))
                .map(|parent| parent.cwd().to_owned())
                .unwrap_or_default();
            projections.projector(&session_id, &cwd, &file)
        }
    };
    let mut events = projector.events.lock().await;
    // The return value is the conversation path's cue to refresh that session's `state` from the
    // host; a child has no state command and no state frame, so what is left of that cue here is
    // the delivery of whatever the event left buffered.
    if events.on_event(host.app(), &projector, event) {
        events.flush(host.app(), &projector);
    }
}

/// The three facts one forwarded child event carries: the child's id, the transcript it is stored
/// in, and the engine event itself.
///
/// `None` when any of them is missing, empty, or (for the event) a null: the file is the only way
/// to know which channel to publish on and the id is how the frontend attributes what it receives,
/// so a frame with a hole where one of them belongs cannot be addressed at all - it is counted as a
/// loss rather than published into a conversation nobody asked about.
fn subagent_event_parts(frame: &Value) -> Option<(&str, &str, &Value)> {
    let agent_id = frame
        .get("agentId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())?;
    let session_file = frame
        .get("sessionFile")
        .and_then(Value::as_str)
        .filter(|file| !file.is_empty())?;
    let event = frame.get("event").filter(|event| !event.is_null())?;
    Some((agent_id, session_file, event))
}

/// A standalone `error` frame: the session-level report the frontend renders as a failure.
async fn on_error_frame(host: &HostRuntime, frame: &Value) {
    let Some(session) = session_of(host, frame) else {
        return;
    };
    let message = error_text(frame, "The engine reported an error.");
    let code = frame
        .get("code")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(ENGINE_REQUEST_FAILED);
    let mut events = session.events.lock().await;
    events.report_error(&host.app().clone(), &session, code, message);
}

/// Whether a response that names no request has to be reported as a protocol-level failure.
///
/// Consulted only after an `id` lookup came up empty: such a response cannot be matched to anything
/// this process sent, so the only question left is whether the host was refusing something. A
/// `success` of `false` is a refusal and belongs to the conversations that are running; a missing
/// `success` is read the same way, because "not known to have succeeded" is not a success. What
/// must not happen is what used to: an acknowledgement of a request this side made (the host's
/// answer to a `host_shutdown` it could not name) read as a failure of the protocol itself.
fn unattributed_failure(frame: &Value) -> bool {
    frame.get("success").and_then(Value::as_bool) != Some(true)
}

/// The session a frame belongs to, or `None` when the frame names none this process knows - a
/// frame for a conversation that was closed, or one that arrived for a session of an earlier
/// generation.
pub(super) fn session_of(host: &HostRuntime, frame: &Value) -> Option<Arc<SessionRuntime>> {
    let session_id = frame.get("sessionId").and_then(Value::as_str)?;
    match host.session(session_id) {
        Some(session) => Some(session),
        None => {
            host.note_frame_seen(false);
            None
        }
    }
}

/// The readable text of a failure frame.
///
/// Two spellings name the same thing: an engine failure event carries `message` (contract §2.6
/// engine vocabulary - `host/src/sessions.ts` emits `{type:"error", level, message}`), while a
/// rejected command carries `error` inside its response envelope. Reading only one of them turned
/// every engine failure into the fallback sentence, so the event spelling is tried first and the
/// response spelling covers the rest; an empty text does not count as an answer. What comes back
/// is redacted either way.
fn error_text(frame: &Value, fallback: &str) -> String {
    for key in ["message", "error"] {
        if let Some(text) = frame.get(key).and_then(Value::as_str) {
            let text = sanitize_message(text);
            if !text.is_empty() {
                return text;
            }
        }
    }
    fallback.to_owned()
}

/// How many entries of an `available_commands_update` payload cannot be used, or `None` when the
/// frame carried no `commands` array at all.
///
/// The list the palette reads is projected from the session's state, so this counts what that
/// projection will leave out: the palette keys commands by name, and an entry without one has
/// nowhere to be addressed. The number is what turns a list that silently lost rows into a health
/// counter.
fn unusable_commands(frame: &Value) -> Option<usize> {
    let entries = frame.get("commands").and_then(Value::as_array)?;
    Some(
        entries
            .iter()
            .filter(|entry| nonempty_text(entry.get("name")).is_none())
            .count(),
    )
}

/// A non-empty string field, or `None`. An empty string is as unusable as a missing one for
/// every field this projection requires.
fn nonempty_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests;

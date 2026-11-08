//! Replay, and the state snapshot a truncated replay re-anchors to.
//!
//! One job lives here: repairing the frames a session lost. A live frame that arrives ahead of the
//! cursor is what asks for a replay at all, a journal that can no longer cover the gap is answered
//! with a fresh snapshot instead of the events that are gone, and a refresh is that same
//! `session_state` read published on the frontend channel. Re-anchoring the cursor, rebuilding the
//! session after a truncation and pushing the snapshot to the UI are one thing rather than three,
//! because all of them move the single cursor a session has - and keeping them out of the frame
//! router is what makes that visible.
//!
//! `protocol.rs` keeps the reading and the routing of frames: `run` drains the host's stdout,
//! `handle` accounts for a frame's `seq` through [`note_frame_seq`] and hands it to
//! [`route_frame`], and nothing there builds a request of its own. The replay loop below reuses
//! both, so a journal entry is delivered exactly the way it was when it was live - the journal
//! keeps frames of every type, and every frame it holds is one that went out.

use std::sync::Arc;

use serde_json::{json, Value};

use super::super::CONNECT_TIMEOUT_MS;
use super::protocol::{note_frame_seq, route_frame};
use super::session::{self, FrameOrder, SessionRuntime, REPLAY_FAILURES_BEFORE_NOTICE};
use super::HostRuntime;
use crate::errors::IpcResult;
use crate::services::log;

/// The notice code that says a session lost events the journal could no longer replay.
///
/// The code is the stable name of the fact; the sentence beside it is this side's own wording and is
/// what the reader sees - a notice frame becomes a dismissible row on the conversation
/// (`src/state/session-record.ts` folds one into the record's own notice list). No frontend module
/// branches on this code today: the row states what happened, and what the reader does about it -
/// walking the conversation again, which is where the lost text still is - is their own decision.
const SESSION_EVENTS_LOST: &str = "session_events_lost";

/// Asks the host to resend the frames this process missed.
///
/// One replay per session at a time: the frames that arrive while it runs are dropped and come
/// back from the journal, which is what keeps the recovered order identical to the live one.
pub(super) fn trigger_replay(host: &HostRuntime, session: &Arc<SessionRuntime>) {
    if !session.begin_replay(crate::services::store::now_ms().max(0) as u64) {
        return;
    }
    host.note_replay_attempt();
    let host = host.clone();
    let session = session.clone();
    tauri::async_runtime::spawn(async move {
        let from_seq = session.expected_seq();
        let command = json!({"type": "session_replay", "fromSeq": from_seq});
        match host
            .call_session_ok(&session.id, command, CONNECT_TIMEOUT_MS)
            .await
        {
            Ok(data) => {
                let truncated = data
                    .get("truncated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if truncated {
                    // The journal no longer covers the gap, so the events are gone: resynchronize
                    // from state instead of pretending the loss did not happen. The loss itself is
                    // counted whatever happens next.
                    host.note_frame_dropped(1);
                    // The reader is told, because the snapshot below carries none of what was
                    // lost: the rows on screen are missing whatever the hole held - an answer's
                    // text among it - and the transcript is where the repair is. The sentence here
                    // is this side's own and is what the reader sees.
                    session.emit(
                        host.app(),
                        json!({
                            "type": "notice",
                            "level": "warning",
                            "code": SESSION_EVENTS_LOST,
                            "message": "This session lost events and was resynchronized from its transcript.",
                        }),
                    );
                    // The cursor has to move as well, and the snapshot is the only place a usable
                    // one can come from: the frames that would have carried it are exactly the
                    // ones the journal dropped, so leaving the cursor where it was makes every
                    // later live frame read as another hole - dropped forever, with the session
                    // never recovering. The state view's own `seq` is what the host had published
                    // when it built the payload, so `seq + 1` is the first frame an arriving live
                    // stream can carry.
                    if let Some((seq, state)) = resync_state(&host, &session).await {
                        session.set_expected_seq(seq.saturating_add(1));
                        session::emit_state(host.app(), &session, &state);
                        session.note_repair_success();
                        log::warn(&format!(
                            "session {} lost events before {} and was resynchronized from state",
                            session.id, from_seq
                        ));
                    }
                } else {
                    session.note_repair_success();
                    let events = data
                        .get("events")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    for event in &events {
                        // A journal entry arrives with the sequence number it was emitted under,
                        // and is accounted for through the same entry the live stream uses - the
                        // journal is what the cursor was rewound for.
                        if note_frame_seq(&host, &session, event, true) != FrameOrder::Next {
                            continue;
                        }
                        // Routed exactly as a live frame is. The journal keeps every frame the
                        // live path published - a shed roster edge, a state snapshot, a dialog -
                        // so a type routed differently here would drop the very frames the replay
                        // was asked to repair. The cursor has already moved above: nothing below
                        // may move it again.
                        route_frame(&host, event).await;
                    }
                }
            }
            Err(error) => {
                log::warn(&format!(
                    "session {} replay failed: {}",
                    session.id, error.message
                ));
                report_stalled_stream(&host, &session);
            }
        }
        session.end_replay();
    });
}

/// Tells a conversation it has stopped updating, once per episode.
///
/// The two repairs this process has for a stream it cannot follow - a replay, and the state resync a
/// truncated replay re-anchors to - both leave the cursor where it was when they fail, and a cursor
/// that does not move makes every later live frame read as a gap and be dropped
/// (`protocol.rs::handle`). The conversation then stops updating with nothing on the wire saying so:
/// the screen keeps its last row and its spinner, the retry keeps running every
/// `REPLAY_MIN_INTERVAL_MS`, and the only account of it was a `log::warn` line. This is the account
/// the reader gets instead.
///
/// One attempt is not worth a row on screen - the host may simply be busy with the turn it is
/// running, and the next attempt is seconds away - so the report waits for
/// [`REPLAY_FAILURES_BEFORE_NOTICE`] in a row, which the counter only reaches when the conversation
/// has really been frozen for that long. A repair that lands resets the count
/// (`SessionRuntime::note_repair_success`), so a later episode reports again.
fn report_stalled_stream(host: &HostRuntime, session: &Arc<SessionRuntime>) {
    if session.note_repair_failure() != REPLAY_FAILURES_BEFORE_NOTICE {
        return;
    }
    session.emit(
        host.app(),
        json!({
            "type": "notice",
            "level": "warning",
            "message": format!(
                "This conversation stopped updating: the engine host did not answer {REPLAY_FAILURES_BEFORE_NOTICE} \
                 attempts in a row to repair its event stream, so the frames it produced meanwhile were dropped. \
                 It keeps retrying."
            ),
        }),
    );
}

/// The state a truncated replay re-anchors to: the session's fresh snapshot, and the `seq` it
/// reflects.
///
/// A read that did not land is logged and answered with `None` rather than raised: the replay task
/// is the last thing running for this session, and leaving the cursor where it was is exactly the
/// position it would have been in without the attempt - a later replay can try again.
///
/// The read is serialized with the state refreshes (`state_lock`), so a snapshot built before this
/// one cannot be published after it.
async fn resync_state(host: &HostRuntime, session: &Arc<SessionRuntime>) -> Option<(u64, Value)> {
    let _guard = session.state_lock.lock().await;
    match read_state(host, session).await {
        Ok(state) => match state.get("seq").and_then(Value::as_u64) {
            Some(seq) => Some((seq, state)),
            None => {
                log::warn(&format!(
                    "session {} state carried no seq; the cursor stays where it was",
                    session.id
                ));
                // A resync that did not land leaves the cursor where it was, which is the same
                // frozen conversation a failed replay leaves: the report is the one above.
                report_stalled_stream(host, session);
                None
            }
        },
        Err(error) => {
            log::warn(&format!(
                "session {} state resync failed: {}",
                session.id, error.message
            ));
            report_stalled_stream(host, session);
            None
        }
    }
}

/// Asks the host for a fresh state snapshot and publishes it as a `state` event.
pub(super) fn refresh_state(host: &HostRuntime, session: &Arc<SessionRuntime>) {
    let host = host.clone();
    let session = session.clone();
    tauri::async_runtime::spawn(async move {
        let _guard = session.state_lock.lock().await;
        match read_state(&host, &session).await {
            Ok(state) => {
                session::emit_state(host.app(), &session, &state);
            }
            Err(error) => log::warn(&format!(
                "session {} state refresh failed: {}",
                session.id, error.message
            )),
        }
    });
}

/// One `session_state` read, with the state view unwrapped the way both callers publish it.
///
/// The answer wraps the view in `state` (`host/src/session-reads.ts::readState`); falling back to
/// the whole payload covers a host that answers with the view inline, which is the shape this
/// process has always tolerated.
async fn read_state(host: &HostRuntime, session: &Arc<SessionRuntime>) -> IpcResult<Value> {
    let command = json!({"type": "session_state"});
    let data = host
        .call_session_ok(&session.id, command, CONNECT_TIMEOUT_MS)
        .await?;
    Ok(data.get("state").cloned().unwrap_or(data))
}

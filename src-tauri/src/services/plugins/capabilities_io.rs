//! What the P1 capability gates perform on the live side: the host frames, the bus fan-out and the
//! system's own opener.
//!
//! The split is the same one the rest of the bridge uses (`rules.md#single-file-line-limit`): `bridge::capabilities`
//! decides *whether* a call may run and with what bounds, `bridge::perform` runs what it decided, and
//! this module is the one implementation of the effects those runs need. Keeping it out of
//! `protocol.rs` is not cosmetic - the trait's four new methods would have added a hundred lines to a
//! file whose job is answering HTTP requests - and it keeps the four together, which is what makes
//! the budgets readable in one place.
//!
//! Two rules hold across every function here:
//!
//! - **A refusal is what happened.** A host that could not answer, a socket this installation does
//!   not hold, a pace that is spent: each is answered with the token the plugin branches on, never
//!   with a success the caller would act on.
//! - **Nothing is recorded that did not happen.** A socket id is issued before the host is asked and
//!   given back when the host refuses; a subscriber is dropped the moment a delivery cannot reach it;
//!   a spent call is not counted twice.

use serde_json::{json, Value};

use crate::services::plugins::agent_budget::BudgetRefusal;
use crate::services::plugins::bridge::{
    BrowserRequest, DataRequest, Refusal, BROWSER_PAGE_UNAVAILABLE, HOST_SESSION_BUSY,
    HOST_SESSION_NOT_HELD, INTERNAL, INVALID_REQUEST, NOT_FOUND, TOO_LARGE, TOO_MANY_REQUESTS,
};
use crate::services::plugins::bus::Subscriber;
use crate::services::plugins::pages::PluginPage;
use crate::state::AppState;

/// One `capabilities::DataRequest` performed: a host read, a completion, or one socket operation.
pub(crate) fn plugin_data(
    state: &AppState,
    page: Option<&PluginPage>,
    key: &str,
    request: &DataRequest,
) -> Result<Value, Refusal> {
    let page = page.ok_or(INTERNAL)?;
    match request {
        DataRequest::SessionList { .. }
        | DataRequest::SessionGet { .. }
        | DataRequest::SessionMessages { .. }
        | DataRequest::UsageTurns { .. } => {
            tauri::async_runtime::block_on(state.runtime.plugin_data(request)).map_err(|_| INTERNAL)
        }
        // A rename is the host's own frame (`session_set_name`), sent on the routing id the plugin
        // holds. This side never turns an id into a path, and the host's own refusals - a conversation
        // that is not there, one that is still working - travel with their codes (`host_refusal`).
        DataRequest::SessionRename { .. } => {
            tauri::async_runtime::block_on(state.runtime.plugin_session_write(request))
                .map_err(|error| host_refusal(&error))
        }
        // A delete leaves the same state behind whoever asked for it, which is why the three steps
        // the desktop's own delete runs after this frame run here too
        // (`services::runtime::session::after_delete`): a plugin's delete is not a lesser delete. A
        // step that could not be taken is logged rather than reported - the transcript is gone.
        DataRequest::SessionDelete { session_id } => {
            let answer =
                tauri::async_runtime::block_on(state.runtime.plugin_session_write(request))
                    .map_err(|error| host_refusal(&error))?;
            tauri::async_runtime::block_on(crate::services::runtime::session::after_delete(
                &state.runtime,
                &state.store,
                session_id,
            ));
            Ok(answer)
        }
        DataRequest::AgentComplete {
            prompt,
            system,
            model,
            max_tokens,
        } => {
            // The lease is held for the whole call and given back on every way out of it, which is
            // what makes the concurrency ceiling a fact rather than a hope.
            let _lease = state
                .plugin_agent_budget
                .begin(key, std::time::Instant::now())
                .map_err(budget_refusal)?;
            tauri::async_runtime::block_on(state.runtime.plugin_agent_complete(
                prompt,
                system.as_deref(),
                model.as_deref(),
                *max_tokens,
            ))
            .map_err(|_| INTERNAL)
        }
        DataRequest::WebSocketOpen { url } => {
            let Some(socket_id) = state.plugin_sockets.issue(key) else {
                return Err(TOO_MANY_REQUESTS);
            };
            // The owner is the installation's key, not the plugin id: one plugin installed twice
            // (user scope and a project's) holds two independent sets of sockets, and stopping one
            // must not close the other's (the same key every other per-installation table uses).
            let owner = crate::services::plugins::pages::origin_key(&page.plugin_id, &page.scope);
            let opened = tauri::async_runtime::block_on(
                state.runtime.plugin_socket_open(&socket_id, url, &owner),
            );
            match opened {
                Ok(_) => Ok(json!({ "socketId": socket_id })),
                Err(error) => {
                    // The id was issued, not used: a socket the host refused must not hold one of
                    // the installation's eight.
                    state.plugin_sockets.release(key, &socket_id);
                    Err(host_refusal(&error))
                }
            }
        }
        DataRequest::WebSocketSend { socket_id, data } => {
            if !state.plugin_sockets.holds(key, socket_id) {
                return Err(NOT_FOUND);
            }
            tauri::async_runtime::block_on(state.runtime.plugin_socket_send(socket_id, data))
                .map_err(|error| host_refusal(&error))
        }
        DataRequest::WebSocketClose { socket_id } => {
            if !state.plugin_sockets.holds(key, socket_id) {
                return Err(NOT_FOUND);
            }
            state.plugin_sockets.release(key, socket_id);
            tauri::async_runtime::block_on(state.runtime.plugin_socket_close(socket_id))
                .map_err(|_| INTERNAL)?;
            Ok(json!({ "closed": true }))
        }
        DataRequest::WebSocketReceive {
            socket_id,
            wait_ms,
            limit,
        } => {
            if !state.plugin_sockets.holds(key, socket_id) {
                return Err(NOT_FOUND);
            }
            let answer = tauri::async_runtime::block_on(
                state
                    .runtime
                    .plugin_socket_receive(socket_id, *wait_ms, *limit),
            )
            .map_err(|error| host_refusal(&error))?;
            Ok(json!({ "frames": answer.get("frames").cloned().unwrap_or_else(|| json!([])) }))
        }
    }
}

/// One bus message: the rate, the subscriber list, and one frame per delivery.
///
/// A delivery that cannot reach its child prunes that subscriber on the spot: a stopped process is
/// not a subscriber, and keeping it would make every later publish pay for a write nobody reads.
pub(crate) fn bus_publish(
    state: &AppState,
    page: Option<&PluginPage>,
    key: &str,
    topic: &str,
    payload: &Value,
) -> Result<Value, Refusal> {
    let page = page.ok_or(INTERNAL)?;
    if !state
        .plugin_bus
        .take_publish(key, std::time::Instant::now())
    {
        return Err(TOO_MANY_REQUESTS);
    }
    let frame =
        crate::services::plugins::bus::PluginBus::event_frame(topic, &page.plugin_id, payload);
    let mut delivered = 0usize;
    let mut gone: Vec<String> = Vec::new();
    for subscriber in state.plugin_bus.subscribers(topic) {
        if state
            .plugin_process
            .send_event(&subscriber.plugin_id, &subscriber.scope, &frame)
        {
            delivered += 1;
        } else {
            gone.push(subscriber.key);
        }
    }
    for key in gone {
        state.plugin_bus.unsubscribe_all(&key);
    }
    Ok(json!({ "delivered": delivered }))
}

/// One subscription set, recorded for this installation.
pub(crate) fn bus_subscribe(
    state: &AppState,
    page: Option<&PluginPage>,
    key: &str,
    topics: &[String],
) -> Result<Value, Refusal> {
    let page = page.ok_or(INTERNAL)?;
    let subscriber = Subscriber {
        key: key.to_owned(),
        plugin_id: page.plugin_id.clone(),
        scope: page.scope.clone(),
    };
    state
        .plugin_bus
        .subscribe(&subscriber, topics)
        .map(|held| json!({ "topics": held }))
        // The bus's two ceilings (subscribers per topic, topics in the table) are both "this build
        // is holding as much as it will": one token, because a plugin can only act on the same thing.
        .map_err(|()| TOO_MANY_REQUESTS)
}

/// One address for the system's own browser.
///
/// The launcher is [`crate::services::system_open::launch`] - "hand this address to whatever opens
/// addresses" is one operation. What chose the address is the gate's business, not this function's:
/// `capabilities::judge_open_external` already checked the scheme and the host.
pub(crate) fn open_external(url: &str) -> Result<(), Refusal> {
    if crate::services::system_open::launch(url) {
        Ok(())
    } else {
        Err(INTERNAL)
    }
}

/// One already-resolved path handed to the system's own default program (`fs.openDefault`).
///
/// The gate has already refused the two families this application never launches - a credential
/// name and an executable extension - so what is left is "whatever handles this file type", which is
/// the whole point of the method.
pub(crate) fn open_default(path: &str) -> Result<(), Refusal> {
    crate::services::system_open::open_path(std::path::Path::new(path)).map_err(|_| INTERNAL)
}

/// One already-resolved path shown in this machine's own file manager (`fs.reveal`).
pub(crate) fn reveal(path: &str) -> Result<(), Refusal> {
    if crate::services::open_in_app::open_directory(std::path::Path::new(path)) {
        Ok(())
    } else {
        Err(INTERNAL)
    }
}

/// One `pi.browser.*` call, performed on the page this installation owns.
///
/// The owner is the installation's key (`page.key()`'s own input for a worker, the origin key for a
/// page): a plugin's browser is keyed by the plugin, so no request can name a conversation's tab and
/// no conversation's tab can be reached by a plugin - and nothing about a plugin's page is announced
/// to the shell at all (`services::browser::BrowserService::plugin_reveal`), so the reader's work
/// panel is never drawn from one. The CDP channel is deliberately not reachable here - the seven
/// verbs are what this surface serves (`capabilities::judge_browser`).
pub(crate) fn browser(
    state: &AppState,
    key: &str,
    request: &BrowserRequest,
) -> Result<Value, Refusal> {
    let service = state.browser.as_ref().ok_or(BROWSER_PAGE_UNAVAILABLE)?;
    match request {
        BrowserRequest::Navigate { url } => {
            let page = tauri::async_runtime::block_on(service.plugin_navigate(key, url))
                .map_err(|error| browser_refusal(&error))?;
            Ok(json!({ "state": page }))
        }
        BrowserRequest::Reveal => Ok(json!({ "revealed": service.plugin_reveal(key) })),
        BrowserRequest::Snapshot => service
            .snapshot(key)
            .map_err(|error| browser_refusal(&error)),
        BrowserRequest::Screenshot { full_page } => service
            .screenshot(key, *full_page)
            .map_err(|error| browser_refusal(&error)),
        BrowserRequest::Evaluate { expression } => {
            let value = service
                .evaluate(key, expression)
                .map_err(|error| browser_refusal(&error))?;
            Ok(json!({ "value": value }))
        }
        BrowserRequest::Console { limit } => service
            .console(key, limit.map(|limit| limit as usize))
            .map_err(|error| browser_refusal(&error)),
        BrowserRequest::Action { action } => {
            service
                .plugin_action(key, action)
                .map_err(|error| browser_refusal(&error))?;
            Ok(json!({ "ok": true }))
        }
    }
}

/// One browser failure, in the plugin's vocabulary: a browser page this build cannot reach is
/// `unsupported`, and everything else is this application's.
///
/// `BROWSER_UNAVAILABLE` covers three causes - a window with no browser service, a plugin that has
/// not navigated yet, and a page that exists but has not committed a document - and the service's
/// own sentence says which one, so the sentence travels and only the code is restated.
fn browser_refusal(error: &crate::errors::IpcError) -> Refusal {
    if error.code == crate::errors::BROWSER_UNAVAILABLE {
        BROWSER_PAGE_UNAVAILABLE
    } else if error.code == crate::errors::BROWSER_CONSOLE_TOO_LARGE {
        // The page's console holds more than one read carries: the caller can ask for fewer entries
        // (`limit`), which is a different thing from this build failing.
        TOO_LARGE
    } else if error.code == crate::errors::INVALID_INPUT {
        INVALID_REQUEST
    } else {
        INTERNAL
    }
}

/// One budget refusal, in the plugin's vocabulary.
fn budget_refusal(_: BudgetRefusal) -> Refusal {
    TOO_MANY_REQUESTS
}

/// One host failure, in the plugin's vocabulary: a missing target is the caller's to fix, everything
/// else is this application's.
///
/// The host's own codes are its lowercase set (`rules.md#engine-protocol`), and the two the session
/// writes can produce are named here rather than collapsed into `internal`: "that conversation is
/// not one this application holds" and "that conversation is still working" are both facts a plugin
/// author has to act on, and a generic sentence would hide which one happened.
fn host_refusal(error: &crate::errors::IpcError) -> Refusal {
    if error.code == crate::errors::INVALID_INPUT {
        Refusal {
            code: "invalid_request",
            message: "The host could not read this request.",
        }
    } else if error.code == "session_not_found" {
        HOST_SESSION_NOT_HELD
    } else if error.code == "session_busy" {
        HOST_SESSION_BUSY
    } else {
        INTERNAL
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error(code: &'static str) -> crate::errors::IpcError {
        crate::errors::IpcError::from_message(code, "the host said so".to_owned())
    }

    /// Each host cause keeps its own sentence: the two session writes are the calls a plugin author
    /// has to act on, and `too_many_requests`'s own text is about pacing, not about a conversation
    /// that is still working.
    #[test]
    fn every_host_cause_keeps_its_own_refusal() {
        assert_eq!(
            host_refusal(&error("session_not_found")),
            HOST_SESSION_NOT_HELD
        );
        assert_eq!(host_refusal(&error("session_busy")), HOST_SESSION_BUSY);
        assert_eq!(host_refusal(&error("nonsense")), INTERNAL);
        // The host's own "could not read it" keeps its own sentence: the same code with the cause
        // the caller actually has (`INVALID_REQUEST` names a call this build does not read).
        let malformed = host_refusal(&error(crate::errors::INVALID_INPUT));
        assert_eq!(malformed.code, "invalid_request");
        assert_ne!(malformed, INVALID_REQUEST);
    }

    /// One page's console past a single read is `too_large` - the caller can ask for fewer entries -
    /// rather than `internal`, which would say this application failed.
    #[test]
    fn an_oversized_read_is_refused_as_too_large() {
        assert_eq!(
            browser_refusal(&error(crate::errors::BROWSER_CONSOLE_TOO_LARGE)),
            TOO_LARGE
        );
        assert_eq!(
            browser_refusal(&error(crate::errors::BROWSER_UNAVAILABLE)),
            BROWSER_PAGE_UNAVAILABLE
        );
    }
}

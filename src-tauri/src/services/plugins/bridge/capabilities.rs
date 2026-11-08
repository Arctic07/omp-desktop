//! The P1 capability gates: the six families that let a plugin reach this application's own data
//! (`rules.md#plugin-system`, `omp.desktop` API 0.2.0).
//!
//! Each family is one **shape** question and one **permission** question, answered here, and then a
//! job the caller runs (`bridge::perform`). The shape questions are where the bounds live: a page
//! size, a body budget, a window, a topic name, an address. They are answered against constants
//! mirrored from `host/src/constants.ts` (`PLUGIN_SESSION_PAGE_MAX` and friends), because a bound
//! the plugin's own documentation states and the gate does not enforce is a bound an author plans
//! around for nothing.
//!
//! Three properties hold across all six:
//!
//! - **A bound is refused, never trimmed.** A `limit` of 5 000 is `invalid_request`, not a page of
//!   500: the caller asked for something this build does not answer, and answering a different
//!   question is how a plugin ends up reasoning about a window it never received.
//! - **Nothing is implied.** Each method names its own permission. `session.read` is not `usage.read`
//!   because a plugin that lists conversations did not ask to read what they cost, and
//!   `bus.publish` is not `bus.subscribe` because writing a topic is not reading everyone else's.
//! - **The reach is this application's, not a second copy of the engine's.** Every one of these
//!   calls is answered by data this application already holds (`host/src/plugin-sessions.ts` reads
//!   the session index the desktop itself lists, `host/src/plugin-agent.ts` completes on the models
//!   the user already configured). Nothing here writes a session file, and nothing here decides
//!   which provider to call.
//!
//! Rate and concurrency budgets are the one thing that is *not* here: they are per-installation
//! state, so they live where the installation's state lives (`bridge::LiveEffects`, over
//! `AppState`'s tables), and this module stays a pure matrix that a test can drive with nothing
//! running.

use serde_json::{Map, Value};

use crate::services::plugins::prompt::PromptKind;

use super::{
    Job, Judgement, Refusal, HOST_NOT_DECLARED, INVALID_REQUEST, PERMISSION_DENIED,
    SCHEME_NOT_FETCHABLE, SCHEME_NOT_OPENABLE, TOO_LARGE,
};

/// Rows one paged read returns, and the page a caller gets when it names none.
///
/// Mirrors `PLUGIN_SESSION_PAGE_MAX` / `PLUGIN_SESSION_PAGE_DEFAULT`.
pub(crate) const SESSION_PAGE_MAX: u64 = 500;
pub(crate) const SESSION_PAGE_DEFAULT: u64 = 200;

/// Bytes of one message body a caller may ask for (`contentLimit`), and the ceiling on one answer.
///
/// Mirrors `PLUGIN_SESSION_CONTENT_BYTES_MAX` / `PLUGIN_SESSION_RESPONSE_BYTES_MAX`.
pub(crate) const SESSION_CONTENT_BYTES_MAX: u64 = 4_096;
pub(crate) const RESPONSE_BYTES_MAX: usize = 1_048_576;

/// The widest window a usage query may span. Mirrors `PLUGIN_USAGE_WINDOW_DAYS_MAX`.
pub(crate) const USAGE_WINDOW_DAYS_MAX: i64 = 365;
const DAY_MS: i64 = 86_400_000;

/// Output tokens one completion may ask for. Mirrors `PLUGIN_AGENT_OUTPUT_TOKENS_MAX`.
pub(crate) const AGENT_OUTPUT_TOKENS_MAX: u64 = 4_096;
/// The longest prompt or system text one completion may carry, in bytes.
const AGENT_PROMPT_BYTES_MAX: usize = 32 * 1024;
/// The longest model selector one completion may name, in characters.
const AGENT_MODEL_CHARS_MAX: usize = 256;

/// Bus bounds. Mirrors `PLUGIN_BUS_PAYLOAD_BYTES_MAX` / `PLUGIN_BUS_TOPIC_CHARS_MAX`.
pub(crate) const BUS_PAYLOAD_BYTES_MAX: usize = 65_536;
pub(crate) const BUS_TOPIC_CHARS_MAX: usize = 128;
/// How many topics one `bus.subscribe` call may name.
const BUS_SUBSCRIBE_TOPICS_MAX: usize = 64;
/// The prefix every topic carries; the owner segment names who may publish on it.
const TOPIC_PREFIX: &str = "plugin:";

/// WebSocket bounds. Mirrors `PLUGIN_WS_FRAME_BYTES_MAX` / `PLUGIN_WS_URL_CHARS_MAX`.
pub(crate) const WS_FRAME_BYTES_MAX: usize = 262_144;
pub(crate) const WS_URL_CHARS_MAX: usize = 2_048;
/// The longest socket id a caller may name: the host issues them, so only the shape is checked.
const SOCKET_ID_CHARS_MAX: usize = 64;

/// The longest address one `shell.openExternal` may carry.
/// Mirrors `PLUGIN_OPEN_EXTERNAL_URL_CHARS_MAX`.
pub(crate) const OPEN_EXTERNAL_URL_CHARS_MAX: usize = 2_048;

/// The longest cursor this build echoes: the host's cursors are its own tokens, and a page never
/// invents one.
const CURSOR_CHARS_MAX: usize = 512;
/// The longest conversation or project id one call may name, in characters.
const ID_CHARS_MAX: usize = 256;

/// One request whose answer this application already holds, and which the host performs.
///
/// It is one enum rather than a job per method because the failure vocabulary and the transport are
/// one: each arm becomes one host frame, and a refusal from the host is restated as this bridge's
/// `internal` (a caller's mistake was already refused before the frame existed).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum DataRequest {
    /// `session.list`: the conversation index, newest first.
    SessionList {
        limit: u64,
        cursor: Option<String>,
        project_id: Option<String>,
    },
    /// `session.get`: one conversation's metadata.
    SessionGet { session_id: String },
    /// `session.messages`: one conversation's messages, paged, with bodies only as far as asked.
    SessionMessages {
        session_id: String,
        limit: u64,
        cursor: Option<String>,
        descending: bool,
        content_limit: Option<u64>,
    },
    /// `usage.turns`: one row per model call, inside a bounded window.
    UsageTurns {
        from_ms: Option<i64>,
        to_ms: Option<i64>,
        session_id: Option<String>,
        project_id: Option<String>,
        limit: u64,
        cursor: Option<String>,
    },
    /// `agent.complete`: one completion on the models this application is configured with.
    AgentComplete {
        prompt: String,
        system: Option<String>,
        model: Option<String>,
        max_tokens: u64,
    },
    /// `net.websocket.connect`: one socket, opened by the host on the address this side cleared.
    WebSocketOpen { url: String },
    /// `net.websocket.send`: one text frame on a socket this installation opened.
    WebSocketSend { socket_id: String, data: String },
    /// `net.websocket.close`: one socket, closed by the host.
    WebSocketClose { socket_id: String },
    /// `net.websocket.receive`: whatever the socket has buffered, waiting at most `wait_ms`.
    ///
    /// A poll rather than a push: this application has no channel that can call *into* a plugin
    /// page, and the one push lane it does have (a resident process's own stdin) is the bus's
    /// (`services::plugins::bus`). A socket that pushed on the bus's lane would put two very
    /// different deliveries behind one subscription model.
    WebSocketReceive {
        socket_id: String,
        wait_ms: u64,
        limit: u64,
    },
    /// `session.rename`: one conversation's title, changed through the desktop's own frame.
    ///
    /// It carries the id `session.read` published and a title, and nothing else: the frame it becomes
    /// is `session_set_name` (`host/src/dispatch.ts`), and this side never turns a conversation id
    /// into a path - the desktop does not write the engine's data directory
    /// (`rules.md#plugin-system`).
    SessionRename { session_id: String, title: String },
    /// `session.delete`: one conversation, removed through the desktop's own `session_delete` frame.
    ///
    /// It carries the id `session.read` published; the host resolves it through the conversation
    /// index (`host/src/session-files.ts`), which is the same set of conversations those reads answer
    /// from, so a plugin cannot name one no reader could see.
    SessionDelete { session_id: String },
}

/// A page size, or the default when the caller named none; over the ceiling is a refusal.
fn page_limit(params: &Map<String, Value>) -> Result<u64, Refusal> {
    match params.get("limit") {
        None | Some(Value::Null) => Ok(SESSION_PAGE_DEFAULT),
        Some(Value::Number(number)) => match number.as_u64() {
            Some(value) if value >= 1 && value <= SESSION_PAGE_MAX => Ok(value),
            _ => Err(INVALID_REQUEST),
        },
        Some(_) => Err(INVALID_REQUEST),
    }
}

/// One bounded optional text argument: absent and `null` are both "none", anything else that is not
/// a bounded string is a refusal rather than a dropped value.
fn opt_text(
    params: &Map<String, Value>,
    name: &str,
    max_chars: usize,
) -> Result<Option<String>, Refusal> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            let text = text.trim();
            if text.is_empty() || text.chars().count() > max_chars {
                return Err(INVALID_REQUEST);
            }
            Ok(Some(text.to_owned()))
        }
        Some(_) => Err(INVALID_REQUEST),
    }
}

/// One required bounded text argument.
fn req_text(params: &Map<String, Value>, name: &str, max_chars: usize) -> Result<String, Refusal> {
    opt_text(params, name, max_chars)?.ok_or(INVALID_REQUEST)
}

/// One optional integer argument (seconds, milliseconds or tokens), refusing a non-integer.
fn opt_int(params: &Map<String, Value>, name: &str) -> Result<Option<i64>, Refusal> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number.as_i64().map(Some).ok_or(INVALID_REQUEST),
        Some(_) => Err(INVALID_REQUEST),
    }
}

/// The parameters as an object, or the shape refusal every method here answers an empty body with.
fn object(params: Option<&Value>) -> Result<&Map<String, Value>, Refusal> {
    params.and_then(Value::as_object).ok_or(INVALID_REQUEST)
}

/// `session.list` / `session.get` / `session.messages`: the conversation index, read-only.
///
/// The three methods are one gate because they are one permission and one source: what changes is
/// which page of it is asked for. The body budget is the interesting half of `session.messages` - a
/// caller that names no `contentLimit` gets ids, roles and timestamps and no text, which is what
/// makes "read the index" and "read the messages" two different requests even under one permission.
pub(super) fn judge_session(
    page: &crate::services::plugins::pages::PluginPage,
    method: super::BridgeMethod,
    params: Option<&Value>,
) -> Judgement {
    if !page.grants.declares("session.read") {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    let params = match object(params) {
        Ok(params) => params,
        Err(refusal) => return Judgement::Refuse(refusal),
    };
    let request = match method {
        super::BridgeMethod::SessionList => {
            let limit = page_limit(params);
            let cursor = opt_text(params, "cursor", CURSOR_CHARS_MAX);
            let project_id = opt_text(params, "projectId", ID_CHARS_MAX);
            match (limit, cursor, project_id) {
                (Ok(limit), Ok(cursor), Ok(project_id)) => DataRequest::SessionList {
                    limit,
                    cursor,
                    project_id,
                },
                (Err(refusal), ..) | (_, Err(refusal), _) | (_, _, Err(refusal)) => {
                    return Judgement::Refuse(refusal)
                }
            }
        }
        super::BridgeMethod::SessionGet => match req_text(params, "sessionId", ID_CHARS_MAX) {
            Ok(session_id) => DataRequest::SessionGet { session_id },
            Err(refusal) => return Judgement::Refuse(refusal),
        },
        super::BridgeMethod::SessionMessages => {
            let shape = (|| -> Result<DataRequest, Refusal> {
                let session_id = req_text(params, "sessionId", ID_CHARS_MAX)?;
                let limit = page_limit(params)?;
                let cursor = opt_text(params, "cursor", CURSOR_CHARS_MAX)?;
                // `order` is one of two tokens; anything else is a spelling this build does not read.
                let descending = match params.get("order") {
                    None | Some(Value::Null) => false,
                    Some(Value::String(order)) if order == "asc" => false,
                    Some(Value::String(order)) if order == "desc" => true,
                    Some(_) => return Err(INVALID_REQUEST),
                };
                let content_limit = match opt_int(params, "contentLimit")? {
                    None => None,
                    Some(value) if value > 0 && (value as u64) <= SESSION_CONTENT_BYTES_MAX => {
                        Some(value as u64)
                    }
                    Some(_) => return Err(INVALID_REQUEST),
                };
                Ok(DataRequest::SessionMessages {
                    session_id,
                    limit,
                    cursor,
                    descending,
                    content_limit,
                })
            })();
            match shape {
                Ok(request) => request,
                Err(refusal) => return Judgement::Refuse(refusal),
            }
        }
        // `judge` dispatches exactly the three `session.*` methods here; anything else would be a
        // second method reaching this gate, which is a change to the judgement table itself.
        _ => return Judgement::Refuse(INVALID_REQUEST),
    };
    Judgement::Run(Job::Data { request })
}

/// `session.rename` / `session.delete`: the two calls that change a conversation the user owns.
///
/// One gate for both because they are one decision: the permission (`session.write`, its own name
/// and its own sentence), the id shape, and then the host's own frame. What differs is the payload -
/// a title, or nothing - and which frame the host answers with. Nothing here asks the user: the
/// permission is the switch, granted with the manifest, and the *reach* is the one `session.read`
/// already has (the ids the index lists), so a plugin cannot name a conversation no reader could see.
pub(super) fn judge_session_write(
    page: &crate::services::plugins::pages::PluginPage,
    method: super::BridgeMethod,
    params: Option<&Value>,
) -> Judgement {
    if !page.grants.declares("session.write") {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    let Ok(params) = object(params) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let request = match method {
        super::BridgeMethod::SessionRename => {
            let shape = (|| -> Result<DataRequest, Refusal> {
                let session_id = req_text(params, "sessionId", ID_CHARS_MAX)?;
                let title = req_text(params, "title", SESSION_TITLE_CHARS_MAX)?;
                Ok(DataRequest::SessionRename { session_id, title })
            })();
            match shape {
                Ok(request) => request,
                Err(refusal) => return Judgement::Refuse(refusal),
            }
        }
        super::BridgeMethod::SessionDelete => match req_text(params, "sessionId", ID_CHARS_MAX) {
            Ok(session_id) => DataRequest::SessionDelete { session_id },
            Err(refusal) => return Judgement::Refuse(refusal),
        },
        // `judge` dispatches exactly these two writes here.
        _ => return Judgement::Refuse(INVALID_REQUEST),
    };
    Judgement::Run(Job::Data { request })
}

/// The longest conversation title one `session.rename` may carry, in characters.
///
/// A title is a display string, not a document: the engine's own titles are one line, and a caller
/// asking for more is writing something the reader's list cannot show.
const SESSION_TITLE_CHARS_MAX: usize = 256;

/// `usage.turns`: the token and cost accounting, one row per model call.
///
/// The window is the bound that matters: a plugin that asked for ten years of history is asking for
/// a scan this application does not run for itself, so it is refused rather than clamped. A
/// half-open window (`from` alone, `to` alone) is legal - both ends are optional - and the span of
/// whatever was named is what the ceiling is applied to.
pub(super) fn judge_usage(
    page: &crate::services::plugins::pages::PluginPage,
    params: Option<&Value>,
) -> Judgement {
    if !page.grants.declares("usage.read") {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    let Ok(params) = object(params) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let shape = (|| -> Result<DataRequest, Refusal> {
        let from_ms = opt_int(params, "fromMs")?;
        let to_ms = opt_int(params, "toMs")?;
        let span = match (from_ms, to_ms) {
            (Some(from), Some(to)) => {
                if to < from {
                    return Err(INVALID_REQUEST);
                }
                // Saturating, not `to - from`: the caller picks both ends, and `i64::MIN..i64::MAX`
                // is a legal ordered pair whose true span does not fit an `i64`. Plain subtraction
                // wraps to `-1` in release, which is *below* every ceiling - the window would pass
                // unbounded. Saturating pins such a pair at `i64::MAX` so the ceiling below still
                // refuses it; for any pair that fits, the value is the same as subtraction.
                to.saturating_sub(from)
            }
            // A one-sided window is unbounded towards the other end, so the ceiling is applied to
            // the side the caller named against "now" at the moment the call is judged.
            (Some(from), None) => now_ms().saturating_sub(from).max(0),
            (None, Some(to)) => now_ms().saturating_sub(to).max(0),
            (None, None) => 0,
        };
        if span > USAGE_WINDOW_DAYS_MAX * DAY_MS {
            return Err(INVALID_REQUEST);
        }
        Ok(DataRequest::UsageTurns {
            from_ms,
            to_ms,
            session_id: opt_text(params, "sessionId", ID_CHARS_MAX)?,
            project_id: opt_text(params, "projectId", ID_CHARS_MAX)?,
            limit: page_limit(params)?,
            cursor: opt_text(params, "cursor", CURSOR_CHARS_MAX)?,
        })
    })();
    match shape {
        Ok(request) => Judgement::Run(Job::Data { request }),
        Err(refusal) => Judgement::Refuse(refusal),
    }
}

/// `agent.complete`: the permission, the shape, and then the user's own answer the first time.
///
/// This is the one P1 method whose cost is money rather than privacy, so it is asked about on first
/// use: the permission turns it on, and the first call parks until the user says yes. `session` is
/// remembered for the rest of the process (`gates::SessionGrant::AgentComplete`), and the rate and
/// concurrency budgets are the caller's (`bridge::perform`), not this function's.
pub(super) fn judge_agent(
    page: &crate::services::plugins::pages::PluginPage,
    params: Option<&Value>,
    holds: &dyn Fn(&crate::services::plugins::gates::SessionGrant) -> bool,
) -> Judgement {
    if !page.grants.declares("agent.complete") {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    let Ok(params) = object(params) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let shape = (|| -> Result<DataRequest, Refusal> {
        let prompt = req_text_bytes(params, "prompt", AGENT_PROMPT_BYTES_MAX)?;
        let system = match params.get("system") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => {
                if text.len() > AGENT_PROMPT_BYTES_MAX {
                    return Err(TOO_LARGE);
                }
                Some(text.clone())
            }
            Some(_) => return Err(INVALID_REQUEST),
        };
        let model = opt_text(params, "model", AGENT_MODEL_CHARS_MAX)?;
        let max_tokens = match opt_int(params, "maxTokens")? {
            None => AGENT_OUTPUT_TOKENS_MAX,
            Some(value) if value > 0 && (value as u64) <= AGENT_OUTPUT_TOKENS_MAX => value as u64,
            Some(_) => return Err(INVALID_REQUEST),
        };
        Ok(DataRequest::AgentComplete {
            prompt,
            system,
            model,
            max_tokens,
        })
    })();
    let request = match shape {
        Ok(request) => request,
        Err(refusal) => return Judgement::Refuse(refusal),
    };
    let job = Job::Data { request };
    if holds(&crate::services::plugins::gates::SessionGrant::AgentComplete) {
        return Judgement::Run(job);
    }
    Judgement::Ask {
        kind: PromptKind::AgentComplete,
        // The question names the capability, not a value: there is no prompt to show the reader,
        // and showing one would put a plugin's own words in the card's mouth.
        target: "agent.complete".to_owned(),
        job,
    }
}

/// One text argument bounded by bytes rather than characters: a prompt is a payload, and the host
/// it travels to counts bytes.
fn req_text_bytes(
    params: &Map<String, Value>,
    name: &str,
    max_bytes: usize,
) -> Result<String, Refusal> {
    match params.get(name) {
        Some(Value::String(text)) if !text.trim().is_empty() => {
            if text.len() > max_bytes {
                return Err(TOO_LARGE);
            }
            Ok(text.clone())
        }
        _ => Err(INVALID_REQUEST),
    }
}

/// One bus topic, in the one shape this build publishes on: `plugin:<owner>/<name>`.
///
/// The owner segment is a plugin id, which may itself contain `/` (`@scope/pkg`), so the check is a
/// prefix match against the publisher's own id rather than a split on `/`: a topic either starts
/// with `<publisher>` and a `/`, or it is somebody else's.
fn topic_owned_by(topic: &str, owner: &str) -> bool {
    let Some(rest) = topic.strip_prefix(TOPIC_PREFIX) else {
        return false;
    };
    let Some(name) = rest.strip_prefix(owner) else {
        return false;
    };
    let Some(name) = name.strip_prefix('/') else {
        return false;
    };
    !name.is_empty()
}

/// One bus topic this build reads at all: the prefix, an owner segment, a name, a bounded length and
/// no control characters.
///
/// The name is what makes a topic addressable - `plugin:<owner>/` names nobody - and the owner may
/// itself contain `/` (an id like `@scope/pkg`), so the name is "everything after the last `/`", not
/// "the second segment": requiring a non-empty tail is the rule both an id with a slash and a plain
/// one satisfy.
fn topic_shaped(topic: &str) -> bool {
    let Some(rest) = topic.strip_prefix(TOPIC_PREFIX) else {
        return false;
    };
    !rest.is_empty()
        && rest.contains('/')
        && !rest.ends_with('/')
        && topic.chars().count() <= BUS_TOPIC_CHARS_MAX
        && !topic.chars().any(char::is_control)
}

/// `bus.publish`: the plugin's own namespace, a bounded JSON payload.
///
/// There is no question to ask the user here and no scope beyond the topic: a plugin that declares
/// `bus.publish` may talk to other plugins, and the only thing that could go wrong is publishing as
/// somebody else - which the owner check refuses, because a topic's owner is part of its name.
pub(super) fn judge_bus_publish(
    page: &crate::services::plugins::pages::PluginPage,
    params: Option<&Value>,
) -> Judgement {
    if !page.grants.declares("bus.publish") {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    let Ok(params) = object(params) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let Ok(topic) = req_text(params, "topic", BUS_TOPIC_CHARS_MAX) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    if !topic_shaped(&topic) {
        // A name that is not a topic at all (no `plugin:` prefix, an empty name, a control character)
        // is a request this build cannot read, and says so - it reveals nobody.
        return Judgement::Refuse(INVALID_REQUEST);
    }
    if !topic_owned_by(&topic, &page.plugin_id) {
        // Somebody else's namespace: one refusal for every such topic, with no hint about which
        // plugin owns it (the topic's owner segment is the answer to a question this plugin may not
        // ask, and a distinct sentence would let it enumerate the bus).
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    // The payload is a JSON value of any shape; what is bounded is its serialized size, because that
    // is what the bus and every subscriber's frame have to carry.
    let payload = params.get("payload").cloned().unwrap_or(Value::Null);
    let Ok(encoded) = serde_json::to_string(&payload) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    if encoded.len() > BUS_PAYLOAD_BYTES_MAX {
        return Judgement::Refuse(TOO_LARGE);
    }
    Judgement::Run(Job::BusPublish { topic, payload })
}

/// `bus.subscribe`: the topics this installation wants delivered, any owner's.
///
/// A page subscribes to nothing: this application can answer a page's request and cannot call into
/// it afterwards, and a subscription with nowhere to deliver is a handler that never fires. The
/// refusal says so (`unsupported`) rather than pretending the subscription exists - a plugin author
/// reading it learns what to change, which a silent no-op never teaches.
pub(super) fn judge_bus_subscribe(
    page: &crate::services::plugins::pages::PluginPage,
    params: Option<&Value>,
) -> Judgement {
    if !page.grants.declares("bus.subscribe") {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    if !page.grants.resident {
        return Judgement::Refuse(super::UNSUPPORTED);
    }
    let Ok(params) = object(params) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let Some(Value::Array(items)) = params.get("topics") else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    if items.is_empty() || items.len() > BUS_SUBSCRIBE_TOPICS_MAX {
        return Judgement::Refuse(INVALID_REQUEST);
    }
    let mut topics: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let Some(text) = item.as_str() else {
            return Judgement::Refuse(INVALID_REQUEST);
        };
        let text = text.trim();
        if !topic_shaped(text) {
            return Judgement::Refuse(INVALID_REQUEST);
        }
        if !topics.iter().any(|known| known == text) {
            topics.push(text.to_owned());
        }
    }
    Judgement::Run(Job::BusSubscribe { topics })
}

/// `net.websocket.*`: the permission, an `http(s)`-family address the egress policy allows, and the
/// socket bookkeeping the caller does.
///
/// `connect` runs the same policy `net.fetch` does (`net::ensure_allowed`), because a socket is an
/// egress like any other: the scheme has to be `ws`/`wss`, the host has to be one the manifest
/// listed - or the `anyHost` key has to hold. `send` and `close` name a socket the host issued, so
/// the only thing to check is the frame's size; the host answers `not_found` for a socket this
/// installation does not hold.
pub(super) fn judge_websocket(
    page: &crate::services::plugins::pages::PluginPage,
    method: super::BridgeMethod,
    params: Option<&Value>,
) -> Judgement {
    if !page.grants.declares("net.websocket") {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    let Ok(params) = object(params) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let request = match method {
        super::BridgeMethod::WebSocketConnect => {
            let Ok(url) = req_text(params, "url", WS_URL_CHARS_MAX) else {
                return Judgement::Refuse(INVALID_REQUEST);
            };
            if let Err(refusal) = ensure_socket_allowed(&url, page) {
                return Judgement::Refuse(refusal);
            }
            DataRequest::WebSocketOpen { url }
        }
        super::BridgeMethod::WebSocketSend => {
            let Ok(socket_id) = req_text(params, "socketId", SOCKET_ID_CHARS_MAX) else {
                return Judgement::Refuse(INVALID_REQUEST);
            };
            let Some(Value::String(data)) = params.get("data") else {
                return Judgement::Refuse(INVALID_REQUEST);
            };
            if data.len() > WS_FRAME_BYTES_MAX {
                return Judgement::Refuse(TOO_LARGE);
            }
            DataRequest::WebSocketSend {
                socket_id,
                data: data.clone(),
            }
        }
        super::BridgeMethod::WebSocketClose => {
            let Ok(socket_id) = req_text(params, "socketId", SOCKET_ID_CHARS_MAX) else {
                return Judgement::Refuse(INVALID_REQUEST);
            };
            DataRequest::WebSocketClose { socket_id }
        }
        super::BridgeMethod::WebSocketReceive => {
            let Ok(socket_id) = req_text(params, "socketId", SOCKET_ID_CHARS_MAX) else {
                return Judgement::Refuse(INVALID_REQUEST);
            };
            let wait_ms = match opt_int(params, "waitMs") {
                Ok(None) => 0,
                Ok(Some(value)) if (0..=WS_WAIT_MS_MAX).contains(&value) => value as u64,
                _ => return Judgement::Refuse(INVALID_REQUEST),
            };
            let limit = match opt_int(params, "limit") {
                Ok(None) => WS_RECEIVE_DEFAULT,
                Ok(Some(value)) if value > 0 && value <= WS_RECEIVE_MAX => value,
                _ => return Judgement::Refuse(INVALID_REQUEST),
            };
            DataRequest::WebSocketReceive {
                socket_id,
                wait_ms,
                limit: limit as u64,
            }
        }
        // See `judge_session`: the four socket methods are the only ones dispatched here.
        _ => return Judgement::Refuse(INVALID_REQUEST),
    };
    Judgement::Run(Job::Data { request })
}

/// The longest a `net.websocket.receive` may wait for a frame, and how many it may take at once.
///
/// A long poll is still a request this application answers synchronously (`bridge::perform` runs it
/// on a blocking thread), so the wait is capped well below any caller's patience: a plugin that
/// wants to wait longer polls again.
pub(crate) const WS_WAIT_MS_MAX: i64 = 10_000;
pub(crate) const WS_RECEIVE_DEFAULT: i64 = 16;
pub(crate) const WS_RECEIVE_MAX: i64 = 64;

/// Whether one socket address may be opened: `ws`/`wss`, on a host the installation's egress policy
/// allows.
///
/// The policy is `net::ensure_allowed`'s, applied to the `ws(s)` form of the address: a WebSocket is
/// an egress exactly like `net.fetch`, and two allow-lists would be two answers to one question.
fn ensure_socket_allowed(
    url: &str,
    page: &crate::services::plugins::pages::PluginPage,
) -> Result<(), Refusal> {
    let parsed = tauri::Url::parse(url).map_err(|_| INVALID_REQUEST)?;
    if !matches!(parsed.scheme(), "ws" | "wss") {
        return Err(INVALID_REQUEST);
    }
    // `ensure_allowed` reads `http(s)`, which is what a socket's address means for the policy's
    // purposes - the host it names and nothing else. Rebuilding the address in that form is how one
    // policy keeps answering one question.
    let seen = format!(
        "http{}{}",
        if parsed.scheme() == "wss" { "s" } else { "" },
        &url[parsed.scheme().len()..]
    );
    crate::services::plugins::net::ensure_allowed(&seen, page.grants.net_policy())
}

/// `shell.openExternal`: one `http(s)` address for the system's own browser.
///
/// Two things are checked and neither is a question: the scheme (the system launcher opens files and
/// handlers for every other one, so nothing but `http(s)` reaches it) and the host, through the same
/// egress policy - a plugin does not get to open a page it could not fetch.
pub(super) fn judge_open_external(
    page: &crate::services::plugins::pages::PluginPage,
    params: Option<&Value>,
) -> Judgement {
    if !page.grants.declares("shell.openExternal") {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    let Ok(params) = object(params) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let Ok(url) = req_text(params, "url", OPEN_EXTERNAL_URL_CHARS_MAX) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let Ok(parsed) = tauri::Url::parse(&url) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        // The egress family's code (`denied_by_policy`), with a sentence about opening rather than
        // fetching: the scheme rule is the same rule, and the caller branches on the code.
        return Judgement::Refuse(SCHEME_NOT_OPENABLE);
    }
    if crate::services::plugins::net::ensure_allowed(&url, page.grants.net_policy()).is_err() {
        // The egress refusal, not a shell one: the address is one this plugin could not fetch, and
        // the token that says so is the one its author already knows.
        return Judgement::Refuse(HOST_NOT_DECLARED);
    }
    Judgement::Run(Job::OpenExternalUrl { url })
}

/// One `pi.browser.*` call: one verb of this application's own built-in browser.
///
/// One enum rather than a job per method because the whole family is one page: the plugin's own,
/// reached through `services::browser`, and every verb is a thin shape check in front of a service
/// method that already exists for the agent. What is deliberately *absent* is the raw CDP channel:
/// this application serves `services::browser::cdp` to its own agent lane, and a plugin gets the
/// seven verbs, not the protocol underneath them - so cookie, storage, target management, DevTools
/// attachment and request interception are unreachable by construction rather than by a list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BrowserRequest {
    /// One `http(s)` address, held to the installation's own `net.domains` list.
    Navigate { url: String },
    /// Shows the plugin's own page in the work panel, if the shell would take it. This application's
    /// shell does not: the work panel indexes its tabs by conversation (`src/state/panel-store.ts`),
    /// so a reveal draws nothing and the answer is only whether the page exists.
    Reveal,
    /// The page's accessibility tree.
    Snapshot,
    /// One image of the page.
    Screenshot { full_page: bool },
    /// One expression evaluated in the page.
    Evaluate { expression: String },
    /// What the page has logged, most recent `limit` entries.
    Console { limit: Option<u64> },
    /// One navigation action: `back`, `forward`, `reload` or `stop`.
    Action { action: String },
}

/// The longest address one `browser.navigate` may carry (`shell.openExternal`'s own bound).
pub(crate) const BROWSER_URL_CHARS_MAX: usize = 2_048;

/// The longest expression one `browser.evaluate` may carry, in characters.
///
/// An expression is a line of script, not a program: a plugin with a program has its own module to
/// put it in, and the page it evaluates against is one this application hosts but did not write.
const BROWSER_EXPRESSION_CHARS_MAX: usize = 8_192;

/// How many console entries one `browser.console` may ask for.
const BROWSER_CONSOLE_MAX: u64 = 200;

/// The actions one `browser.action` may name: the same four the page's own chrome draws.
const BROWSER_ACTIONS: [&str; 4] = ["back", "forward", "reload", "stop"];

/// `browser.*`: one permission, seven verbs, and one page that belongs to the caller.
///
/// The permission (`browser.use`) is the switch; the address rule reuses the egress policy, because
/// a page this plugin can drive is a page it can read, so navigation is an egress like `net.fetch`
/// and `shell.openExternal` rather than a fourth kind of reach. The rest is shape: which verb, which
/// fields, how long. Nothing here decides *whose* page it is - that is the caller's, and it is the
/// installation's own key (`bridge::LiveEffects`), so no plugin can name another session's browser.
pub(super) fn judge_browser(
    page: &crate::services::plugins::pages::PluginPage,
    method: super::BridgeMethod,
    params: Option<&Value>,
) -> Judgement {
    if !page.grants.declares("browser.use") {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    let Ok(params) = object(params) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let request = match method {
        super::BridgeMethod::BrowserNavigate => {
            let Ok(url) = req_text(params, "url", BROWSER_URL_CHARS_MAX) else {
                return Judgement::Refuse(INVALID_REQUEST);
            };
            let Ok(parsed) = tauri::Url::parse(&url) else {
                return Judgement::Refuse(INVALID_REQUEST);
            };
            if !matches!(parsed.scheme(), "http" | "https") {
                return Judgement::Refuse(SCHEME_NOT_FETCHABLE);
            }
            if crate::services::plugins::net::ensure_allowed(&url, page.grants.net_policy())
                .is_err()
            {
                return Judgement::Refuse(HOST_NOT_DECLARED);
            }
            BrowserRequest::Navigate { url }
        }
        super::BridgeMethod::BrowserReveal => BrowserRequest::Reveal,
        super::BridgeMethod::BrowserSnapshot => BrowserRequest::Snapshot,
        super::BridgeMethod::BrowserScreenshot => match params.get("fullPage") {
            None | Some(Value::Null) => BrowserRequest::Screenshot { full_page: false },
            Some(Value::Bool(full_page)) => BrowserRequest::Screenshot {
                full_page: *full_page,
            },
            Some(_) => return Judgement::Refuse(INVALID_REQUEST),
        },
        super::BridgeMethod::BrowserEvaluate => {
            let Ok(expression) = req_text(params, "expression", BROWSER_EXPRESSION_CHARS_MAX)
            else {
                return Judgement::Refuse(INVALID_REQUEST);
            };
            BrowserRequest::Evaluate { expression }
        }
        super::BridgeMethod::BrowserConsole => match opt_int(params, "limit") {
            Ok(None) => BrowserRequest::Console { limit: None },
            Ok(Some(value)) if value > 0 && (value as u64) <= BROWSER_CONSOLE_MAX => {
                BrowserRequest::Console {
                    limit: Some(value as u64),
                }
            }
            _ => return Judgement::Refuse(INVALID_REQUEST),
        },
        super::BridgeMethod::BrowserAction => {
            let Ok(action) = req_text(params, "action", 16) else {
                return Judgement::Refuse(INVALID_REQUEST);
            };
            if !BROWSER_ACTIONS.contains(&action.as_str()) {
                return Judgement::Refuse(INVALID_REQUEST);
            }
            BrowserRequest::Action { action }
        }
        // `judge` dispatches exactly the seven browser verbs here.
        _ => return Judgement::Refuse(INVALID_REQUEST),
    };
    Judgement::Run(Job::Browser { request })
}

/// The wall clock, in milliseconds since the epoch.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;

//! The bridge: the one host API a plugin page has (spec §7.2), and the gates every call passes.
//!
//! A page reaches this process through `fetch('/__bridge…')` on its own origin, and what comes back
//! is decided here rather than in the protocol layer that carries it. The split is the same one
//! `services::plugins::pages` uses for assets - a pure judgement that can be tested without a
//! webview, and a caller that performs what the judgement allowed - and it exists for the same
//! reason: what a page may do is the interesting part, and it is the part that must be provable.
//!
//! Three rules shape the whole vocabulary:
//!
//! - **A method is served or it is not** (spec §7.2). The set is closed and named here; a call that
//!   names something else is refused as a request this build does not serve - `403`, like an asset
//!   path this application never hands out - while a call that names a served method and *fails its
//!   gate* is answered with an envelope (`200` + `{ok:false,code}`), because that call was a
//!   legitimate use of this API and the page's author is the reader who has to act on the reason.
//! - **Nothing is implied** (spec §6.1). A permission the manifest did not declare is denied, a
//!   scope it did not carry is no standing reach, and a path the reject table names is refused even
//!   inside the plugin's own package. Every gate is a filter: the order is fixed, and a later gate
//!   can only take away what an earlier one allowed (spec §6.3).
//! - **The user's answer is part of the gate, not a fallback for it.** A call that needs one is
//!   parked in [`BridgeEffects::ask`]; a refusal, a timeout, a window that is gone and an
//!   installation that was re-published all end the same way - denied - and `once`/`session` are
//!   what the caller records for later ([`crate::services::plugins::gates::SessionGrants`]).
//!
//! The methods this build serves are the ones whose permissions are P2's (spec §6.2): `fs.read`,
//! `net.fetch`, `clipboard.read` and `clipboard.write` (plus the two the carrier always had,
//! `ready` and `close`), the P1 capability names and `shell.openExternal`. A call naming anything
//! else is refused as a request this build does not serve, which is the honest answer and the same
//! one an older artifact gives.

use std::time::Duration;

use serde_json::Value;

use crate::services::plugins::gates::{self, SessionGrant};
use crate::services::plugins::net;
use crate::services::plugins::pages::PluginPage;
use crate::services::plugins::prompt::{PromptAnswer, PromptKind};

mod answers;
mod capabilities;
mod files;
mod methods;
mod perform;

pub(crate) use methods::BridgeMethod;

pub(crate) use capabilities::{BrowserRequest, DataRequest};

use self::answers::{refusal_for, remember_session};
use self::files::{
    judge_delete, judge_glob, judge_list, judge_open, judge_read, judge_read_range, judge_stat,
    judge_write,
};
use self::perform::run;

/// The largest body one bridge call may carry.
pub(crate) const MAX_BRIDGE_BODY_BYTES: usize = 64 * 1024;

/// The largest file one `fs.read` answers with, before it is refused as too large.
pub(crate) const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

/// How long a call waits for the user's answer before the question is denied.
pub(crate) const PROMPT_TIMEOUT: Duration = Duration::from_secs(60);

/// Longest path a file-mode call may name, in characters, so a bounded string is bounded before
/// `realpath`. One bound for all of them - a read, a write, a delete, a stat, a list - because they
/// name the same thing and the bound is about the string, not about what will be done with it.
const MAX_FS_PATH_CHARS: usize = 1_024;

/// Most entries one `fs.list` answers with.
///
/// A directory is not a file: its size says nothing about how many entries it holds, and a listing is
/// an answer the caller has to hold in memory on the other side of the protocol. Over the ceiling the
/// answer is *marked* truncated rather than refused - half a listing is still a usable answer to
/// "what is in here", unlike half a file.
const MAX_LIST_ENTRIES: usize = 512;

/// Longest text one clipboard call may read or write, in bytes.
pub(crate) const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;

/// Longest text one `fs.write` may put in a file, in bytes.
const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;

/// Longest notice a plugin may ask for, in characters: a notice is a line the user reads, not a
/// document, and a plugin with more to say has its own pages to say it on.
const MAX_NOTICE_TITLE_CHARS: usize = 128;
const MAX_NOTICE_BODY_CHARS: usize = 1_024;

/// Longest line a plugin may put in this application's log, in characters. One call is one line, and
/// a line is a line: a plugin with a stack trace to share writes several.
const MAX_LOG_LINE_CHARS: usize = 1_024;

/// The event a plugin's notice is delivered to the main window on. One name, because there is one
/// stack of them.
pub(crate) const NOTICE_EVENT: &str = "plugin-notice";

/// One notice as the shell receives it: the plugin's own words, and who asked for them.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoticePayload {
    pub(crate) plugin_id: String,
    pub(crate) plugin_name: String,
    pub(crate) title: String,
    pub(crate) body: String,
}

/// One bridge call as it arrived.
pub(crate) enum BridgeCall {
    /// `GET <origin>/__bridge?m=…`: a method with no parameters.
    Query(String),
    /// `POST <origin>/__bridge` with a JSON body: a method and its parameters.
    Body(Vec<u8>),
}

/// What one call asks this process to do, once every gate that could refuse it has spoken.
#[derive(Debug, Clone)]
pub(crate) enum Job {
    Ready,
    Close,
    Read {
        display: String,
    },
    Fetch {
        request: net::FetchRequest,
    },
    ClipboardRead,
    ClipboardWrite {
        text: String,
    },
    Notice {
        title: String,
        body: String,
    },
    Write {
        display: String,
        bytes: Vec<u8>,
    },
    Delete {
        display: String,
    },
    /// One line for this application's log: the level the plugin asked for, and its own words.
    Log {
        level: &'static str,
        message: String,
    },
    /// One call whose answer this application already holds: the session index, the usage
    /// accounting, one completion, or one WebSocket operation (`capabilities::DataRequest`).
    Data {
        request: capabilities::DataRequest,
    },
    /// One message for the plugin bus, already checked to be in the publisher's own namespace.
    BusPublish {
        topic: String,
        payload: Value,
    },
    /// The topics one installation wants delivered; the caller records the subscription.
    BusSubscribe {
        topics: Vec<String>,
    },
    /// One address for the system's own browser, already cleared against `net.domains`.
    OpenExternalUrl {
        url: String,
    },
    /// The one directory this installation owns (`plugin.dataDir`). Nothing to judge: the path is
    /// this application's own and holds only what the plugin wrote there.
    DataDir,
    /// What is at one path, already resolved through the read gates.
    Stat {
        display: String,
    },
    /// One directory's entries, already resolved through the read gates.
    List {
        display: String,
    },
    /// Every entry a pattern names below its literal prefix, already judged by the read gates.
    Glob {
        display: String,
        plan: crate::services::plugins::glob::GlobPlan,
    },
    /// One byte range of one file, already resolved through the read gates.
    ReadRange {
        display: String,
        offset: u64,
        length: u64,
    },
    /// One path for the system's own default program.
    OpenDefault {
        display: String,
    },
    /// One path for this machine's file manager.
    Reveal {
        display: String,
    },
    /// One browser verb, for the page this installation owns (`capabilities::BrowserRequest`).
    Browser {
        request: capabilities::BrowserRequest,
    },
}

mod refusals;
pub(crate) use refusals::*;

/// The judgement on one call, before anything is read, fetched or shown.
#[derive(Debug, Clone)]
pub(crate) enum Judgement {
    /// The call may run as it stands.
    Run(Job),
    /// The call may run once the user answers; `target` is what the question names.
    Ask {
        kind: PromptKind,
        target: String,
        job: Job,
    },
    /// The call is refused with an envelope: a served method that failed a gate.
    Refuse(Refusal),
}

/// What the caller can do for a call beyond judging it: the two facts a judgement needs from the
/// session, and the one question it cannot answer alone.
///
/// It is a trait rather than a bundle of closures so the whole gate - including the answer that
/// arrives later - can be exercised without a webview, a window or a host process, and so the live
/// implementation stays where the app handle and the state it needs already are.
pub(crate) trait BridgeEffects {
    /// Whether the user has already granted this for the installation, this session.
    fn holds(&self, grant: &SessionGrant) -> bool;
    /// Records a session grant the user just gave.
    fn remember(&mut self, grant: SessionGrant);
    /// Asks the user, and returns `None` when the question was not answered in time, could not be
    /// asked at all, or was refused - all of which the caller reads as "not allowed".
    fn ask(&mut self, kind: PromptKind, target: &str) -> Option<PromptAnswer>;
    /// Closes the calling window, when it belongs to this installation.
    fn close_caller(&mut self) -> bool;
    /// Shows one notice to the user. There is no failure to report: a notice this application could
    /// not draw is one the user did not need, and the plugin's call is answered either way.
    fn notify(&mut self, title: &str, body: &str);
    /// Takes one delete from the installation's brake, answering whether it may go ahead.
    fn take_delete(&mut self) -> bool;
    /// Writes one line into this application's own log, tagged with the installation that asked.
    ///
    /// It is the one method with no permission in front of it, and deliberately: every other gate
    /// exists because a call reaches *out* of this application - a file, a host, the clipboard, the
    /// user's screen - while this one reaches into a file the user already has, in the plugin's own
    /// words. What it is bounded by is the line itself (one line per call, no control characters) and
    /// the log's own size cap.
    fn log_line(&mut self, level: &'static str, message: &str);

    /// Performs one `capabilities::DataRequest`: the session index, the usage accounting, one
    /// completion, or one WebSocket operation, all through the host process that already holds the
    /// data.
    ///
    /// The rate and concurrency budgets live here rather than in the judgement, because they are
    /// per-installation state: an installation that has spent its minute of completions is refused
    /// `too_many_requests` by the side that counted them, not by the matrix that read its manifest.
    fn plugin_data(&mut self, request: &capabilities::DataRequest) -> Result<Value, Refusal>;

    /// Delivers one message on the plugin bus.
    fn bus_publish(&mut self, topic: &str, payload: &Value) -> Result<Value, Refusal>;

    /// Records one installation's subscriptions and answers with what it now holds.
    fn bus_subscribe(&mut self, topics: &[String]) -> Result<Value, Refusal>;

    /// Hands one address to the system's own browser.
    fn open_external_url(&mut self, url: &str) -> Result<(), Refusal>;

    /// The one directory this installation owns, created if it is not there yet.
    ///
    /// No permission stands in front of it, and the reason is the same one `log_line` states: every
    /// other gate exists because a call reaches *out* of this application, while this one reaches
    /// into a directory this application made for the plugin and nothing else writes to.
    fn data_dir(&mut self) -> Result<String, Refusal>;

    /// Hands one already-resolved path to the system's own default program (`fs.openDefault`).
    ///
    /// An effect rather than a direct call because what it does is outside this process *and*
    /// because the tests must be able to prove the gate without the machine running them launching a
    /// program: the judgement already refused the refused names, and this is the half that acts.
    fn open_default(&mut self, path: &str) -> Result<(), Refusal>;

    /// Shows one already-resolved path in this machine's own file manager (`fs.reveal`).
    fn reveal(&mut self, path: &str) -> Result<(), Refusal>;

    /// Performs one `capabilities::BrowserRequest` on the page this installation owns.
    ///
    /// The key is the caller's, not the request's: the plugin's browser is its own page
    /// (`services::browser`), and no plugin names another session's tab because no request carries
    /// one.
    fn browser(&mut self, request: &capabilities::BrowserRequest) -> Result<Value, Refusal>;
}

/// One call, judged and - when it may run - run.
///
/// The order is the spec's (permission, containment, reject table, declared scope) and it is
/// expressed as one pass: the permission gate answers the whole call, the read gate answers the
/// path, and the scope gate decides between running it now and asking the user.
pub(crate) fn answer(
    page: &PluginPage,
    roots: &gates::FsRoots,
    call: &BridgeCall,
    effects: &mut dyn BridgeEffects,
) -> Result<Value, RefusalOrRequest> {
    let judgement = judge(page, roots, call, &|grant| effects.holds(grant))?;
    match judgement {
        Judgement::Refuse(refusal) => Err(RefusalOrRequest::Refused(refusal)),
        Judgement::Run(job) => run(&job, page, roots, effects).map_err(RefusalOrRequest::Refused),
        Judgement::Ask { kind, target, job } => match effects.ask(kind, &target) {
            Some(PromptAnswer::Deny) | None => Err(RefusalOrRequest::Refused(refusal_for(kind))),
            Some(PromptAnswer::Once) => {
                run(&job, page, roots, effects).map_err(RefusalOrRequest::Refused)
            }
            Some(PromptAnswer::Session) => {
                remember_session(
                    kind,
                    &job,
                    roots,
                    page.grants.declares("fs.anyPath"),
                    effects,
                );
                run(&job, page, roots, effects).map_err(RefusalOrRequest::Refused)
            }
        },
    }
}

/// A call's answer, or the reason it has none: a refusal this page may read, or a request this build
/// does not serve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RefusalOrRequest {
    Refused(Refusal),
    Request,
}

/// The judgement on one call: what it names, whether it may run, and - when it needs one - the
/// question the user has to answer first.
///
/// `holds` is the session-grant lookup, passed in rather than read from a global so the whole matrix
/// is testable with nothing running.
pub(crate) fn judge(
    page: &PluginPage,
    roots: &gates::FsRoots,
    call: &BridgeCall,
    holds: &dyn Fn(&SessionGrant) -> bool,
) -> Result<Judgement, RefusalOrRequest> {
    let (method, params) = match call {
        BridgeCall::Query(query) => {
            let Some(name) = method_of_query(query) else {
                return Err(RefusalOrRequest::Request);
            };
            let Some(method) = BridgeMethod::parse(&name) else {
                return Err(RefusalOrRequest::Request);
            };
            if method.takes_params() {
                return Ok(Judgement::Refuse(INVALID_REQUEST));
            }
            (method, None)
        }
        BridgeCall::Body(bytes) => {
            if bytes.len() > MAX_BRIDGE_BODY_BYTES {
                return Ok(Judgement::Refuse(TOO_LARGE));
            }
            let Ok(parsed) = serde_json::from_slice::<Value>(bytes) else {
                // A body that names no method never was a bridge call, whatever else it carried.
                return Err(RefusalOrRequest::Request);
            };
            let Some(name) = parsed
                .get("m")
                .or_else(|| parsed.get("method"))
                .and_then(Value::as_str)
            else {
                return Err(RefusalOrRequest::Request);
            };
            let Some(method) = BridgeMethod::parse(name) else {
                return Err(RefusalOrRequest::Request);
            };
            let params = parsed.get("params").cloned().unwrap_or(Value::Null);
            (method, Some(params))
        }
    };
    match method {
        BridgeMethod::Ready => Ok(Judgement::Run(Job::Ready)),
        BridgeMethod::Close => Ok(Judgement::Run(Job::Close)),
        BridgeMethod::FsRead => Ok(judge_read(page, roots, params.as_ref(), holds)),
        BridgeMethod::FsStat => Ok(judge_stat(page, roots, params.as_ref(), holds)),
        BridgeMethod::FsList => Ok(judge_list(page, roots, params.as_ref(), holds)),
        BridgeMethod::FsGlob => Ok(judge_glob(page, roots, params.as_ref(), holds)),
        BridgeMethod::FsReadRange => Ok(judge_read_range(page, roots, params.as_ref(), holds)),
        BridgeMethod::FsOpenDefault => Ok(judge_open(page, roots, params.as_ref(), holds, true)),
        BridgeMethod::FsReveal => Ok(judge_open(page, roots, params.as_ref(), holds, false)),
        BridgeMethod::NetFetch => Ok(judge_fetch(page, params.as_ref())),
        BridgeMethod::ClipboardRead => Ok(judge_clipboard(
            page,
            PromptKind::ClipboardRead,
            Job::ClipboardRead,
            holds,
        )),
        BridgeMethod::ClipboardWrite => Ok(judge_clipboard_write(page, params.as_ref(), holds)),
        BridgeMethod::Notify => Ok(judge_notify(page, params.as_ref())),
        BridgeMethod::FsWrite => Ok(judge_write(page, roots, params.as_ref(), holds)),
        BridgeMethod::FsDelete => Ok(judge_delete(page, roots, params.as_ref(), holds)),
        BridgeMethod::Log => Ok(judge_log(params.as_ref())),
        BridgeMethod::SessionList | BridgeMethod::SessionGet | BridgeMethod::SessionMessages => {
            Ok(capabilities::judge_session(page, method, params.as_ref()))
        }
        BridgeMethod::SessionRename | BridgeMethod::SessionDelete => Ok(
            capabilities::judge_session_write(page, method, params.as_ref()),
        ),
        BridgeMethod::BrowserNavigate
        | BridgeMethod::BrowserReveal
        | BridgeMethod::BrowserSnapshot
        | BridgeMethod::BrowserScreenshot
        | BridgeMethod::BrowserEvaluate
        | BridgeMethod::BrowserConsole
        | BridgeMethod::BrowserAction => {
            Ok(capabilities::judge_browser(page, method, params.as_ref()))
        }
        BridgeMethod::UsageTurns => Ok(capabilities::judge_usage(page, params.as_ref())),
        BridgeMethod::AgentComplete => Ok(capabilities::judge_agent(page, params.as_ref(), holds)),
        BridgeMethod::BusPublish => Ok(capabilities::judge_bus_publish(page, params.as_ref())),
        BridgeMethod::BusSubscribe => Ok(capabilities::judge_bus_subscribe(page, params.as_ref())),
        BridgeMethod::WebSocketConnect
        | BridgeMethod::WebSocketSend
        | BridgeMethod::WebSocketClose
        | BridgeMethod::WebSocketReceive => {
            Ok(capabilities::judge_websocket(page, method, params.as_ref()))
        }
        BridgeMethod::ShellOpenExternal => {
            Ok(capabilities::judge_open_external(page, params.as_ref()))
        }
        // No permission and no shape to read: the directory is this application's own, one per
        // installation, and the answer is where it is (`BridgeEffects::data_dir`).
        BridgeMethod::PluginDataDir => Ok(Judgement::Run(Job::DataDir)),
    }
}

/// The log gate (spec §7.2): no permission, a bounded line, and a level from the closed set.
///
/// There is nothing to ask the user here and nothing to filter: the line goes into this
/// application's own log (`services::log`, the file the settings page shows), it is attributed to the
/// installation that wrote it, and the only way it could be more than a line is a control character -
/// so those are removed rather than escaped. A page whose console nobody can see is exactly the case
/// this method exists for.
fn judge_log(params: Option<&Value>) -> Judgement {
    let Some(params) = params else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let Some(message) = params.get("message").and_then(Value::as_str) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let message = message.trim();
    if message.is_empty() || message.chars().count() > MAX_LOG_LINE_CHARS {
        return Judgement::Refuse(INVALID_REQUEST);
    }
    // `debug` is the one level this application's own log does not have, and it is kept as a word in
    // the line rather than dropped: an author who asked for it gets to see it, at the level the file
    // actually has.
    let level = match params.get("level") {
        None => "info",
        Some(Value::String(level)) => match level.as_str() {
            "debug" => "debug",
            "info" => "info",
            "warn" => "warn",
            "error" => "error",
            _ => return Judgement::Refuse(INVALID_REQUEST),
        },
        Some(_) => return Judgement::Refuse(INVALID_REQUEST),
    };
    Judgement::Run(Job::Log {
        level,
        message: message.to_owned(),
    })
}

/// The egress gate (spec §6.4): the permission, then a request whose parameters this build reads.
///
/// There is no question to ask here. A domain the manifest did not list is not something a user
/// answer could allow - that is what the manifest is for - so the gate is a filter with one answer,
/// and the refusal names the list rather than the user's silence.
fn judge_fetch(page: &PluginPage, params: Option<&Value>) -> Judgement {
    if !page.grants.declares("net.fetch") {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    let Some(params) = params else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let request = match net::read_params(params) {
        Ok(request) => request,
        Err(refusal) => return Judgement::Refuse(refusal),
    };
    // The first hop is checked here, so a call to a host the manifest never listed is refused
    // without a socket being opened; the later hops are checked by `net::fetch` itself.
    if let Err(refusal) = net::ensure_allowed(&request.url, page.grants.net_policy()) {
        return Judgement::Refuse(refusal);
    }
    Judgement::Run(Job::Fetch { request })
}

/// The notice gate (spec §6.2): the permission, and nothing else.
///
/// `notify` is granted when the plugin is enabled - it is the one permission whose whole effect is
/// something the user can ignore - so there is no question to ask and no scope to read. What a notice
/// *becomes* (a line in this application, and the system's own notification when the window is not
/// the thing being looked at) is the caller's to decide; the gate reads the manifest and the bounds.
fn judge_notify(page: &PluginPage, params: Option<&Value>) -> Judgement {
    if !page.grants.declares("notify") {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    let Some(params) = params else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let Some(title) = params.get("title").and_then(Value::as_str) else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    let title = title.trim();
    if title.is_empty() || title.chars().count() > MAX_NOTICE_TITLE_CHARS {
        return Judgement::Refuse(INVALID_REQUEST);
    }
    // The body is optional - a title alone is a notice - and a body that is not a string is refused
    // rather than dropped, like every other parameter this build reads.
    let body = match params.get("body") {
        None => "",
        Some(Value::String(body)) => body.trim(),
        Some(_) => return Judgement::Refuse(INVALID_REQUEST),
    };
    if body.chars().count() > MAX_NOTICE_BODY_CHARS {
        return Judgement::Refuse(TOO_LARGE);
    }
    Judgement::Run(Job::Notice {
        title: title.to_owned(),
        body: body.to_owned(),
    })
}

/// The clipboard gate: the permission, then the user's answer the first time (spec §6.2).
///
/// `job` is what the caller will run when the gate lets it through - a read carries nothing, a write
/// carries the text the call was given - so this function decides only *whether* the call may go,
/// never what it does. That split is what keeps the two directions one gate instead of two: the
/// permission and the question are the same for both, and only the payload differs.
fn judge_clipboard(
    page: &PluginPage,
    kind: PromptKind,
    job: Job,
    holds: &dyn Fn(&SessionGrant) -> bool,
) -> Judgement {
    if !page.grants.declares(kind.permission()) {
        return Judgement::Refuse(PERMISSION_DENIED);
    }
    let Some(direction) = kind.clipboard_direction() else {
        // The remaining kind is a read outside a scope, which `judge_read` owns; being asked to judge
        // it here would mean a job this function cannot describe.
        return Judgement::Refuse(INTERNAL);
    };
    if holds(&SessionGrant::Clipboard(direction)) {
        return Judgement::Run(job);
    }
    Judgement::Ask {
        // The question names the capability rather than a value: there is no path and no text to show.
        kind,
        target: direction.to_owned(),
        job,
    }
}

/// The clipboard write gate: the text the call carries is read first, then the same question.
fn judge_clipboard_write(
    page: &PluginPage,
    params: Option<&Value>,
    holds: &dyn Fn(&SessionGrant) -> bool,
) -> Judgement {
    let Some(text) = params
        .and_then(|params| params.get("text"))
        .and_then(Value::as_str)
    else {
        return Judgement::Refuse(INVALID_REQUEST);
    };
    if text.len() > MAX_CLIPBOARD_BYTES {
        return Judgement::Refuse(TOO_LARGE);
    }
    judge_clipboard(
        page,
        PromptKind::ClipboardWrite,
        Job::ClipboardWrite {
            text: text.to_owned(),
        },
        holds,
    )
}

/// The method one query string names: `?m=close`, or `?method=close` for a page that spells it out.
///
/// The value is percent-decoded, because a method name is a token and `%2E` is the same token: the
/// page writes `fs.read`, and a caller that encodes the dot must not be read as naming something
/// else. The first `m`/`method` pair wins, which is what a query string means anywhere else.
pub(crate) fn method_of_query(query: &str) -> Option<String> {
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key != "m" && key != "method" {
            continue;
        }
        return crate::services::plugins::pages::percent_decode(value);
    }
    None
}

#[cfg(test)]
mod tests;

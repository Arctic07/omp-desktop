//! Session supervision: one host process, the sessions it serves, and the projection of its
//! events onto the frontend's channels.

pub(crate) mod approval;
pub(crate) mod events;
pub(crate) mod history;
pub(crate) mod history_read;
pub(crate) mod host;
pub(crate) mod owner;
pub(crate) mod protocol;
pub(crate) mod reclaim;
pub(crate) mod session;
mod text;
pub(crate) mod ui;
pub(crate) mod usage;

pub(crate) use host::HostRuntime;
pub(crate) use text::{sanitize_message, truncate_on_char_boundary};

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::models::agent::{
    subagent_model, ChatImage, ChatMessage, ToolDetails, ToolFileChange, ToolMinimized, ToolSource,
    ToolSubagent,
};
use crate::services::log;

/// Protocol version this desktop speaks (contract §2.3/§4), kept equal to the host's own
/// `host/src/constants.ts` value.
///
/// 2 is the vocabulary that carries the engine-state commands - the model-role trio and the
/// capability commands (skills, MCP, memory, usage) - and 3 adds the MCP definition writes
/// (`mcp_upsert` / `mcp_remove`), which turn the MCP page from a list of switches into a manager. The launcher's bundle verification refuses an artifact whose manifest records anything else, and
/// the host refuses a mismatching `hello_ok`, so a host built before those commands is reported as
/// an unusable artifact rather than started and then silently ignoring them. 4 adds the conversation
/// delete (`session_delete`), which takes a transcript away rather than only ending a screen's use
/// of it. 6 adds the approval-mode read and write (`approval_mode` / `approval_mode_set`), which is
/// what lets the settings page show and change the mode instead of inheriting whatever the engine
/// happens to hold. 7 adds the forwarded child-session event (`subagent_event`): a subagent's own
/// session events travel to that child's channel, so a running subagent can be watched in its own
/// window - a frame both sides have to know, which is what a protocol bump records. 8 adds
/// conversation branching (`session_branch_points` / `session_branch`): the messages a conversation
/// can branch from, and the branch itself, which the engine performs by rewriting the open session
/// onto a new file - commands both sides have to know, and an artifact from before them would
/// absorb the calls as unknown frames while the desktop waited on an answer. 9 was an intermediate
/// shape of the same feature (`session_navigate`, a leaf move inside the conversation being read);
/// 10 replaces it with `session_branch_from`, which starts a conversation of its own continuing
/// from that entry and leaves the one being read whole - a command-table change both sides have to
/// know. 11 adds the automatic-compaction switch (`compaction_status` /
/// `compaction_set_enabled`), which is what lets the settings page report and change whether the
/// engine compacts a filling context by itself. 12 adds `commit_message`: the review panel asks the
/// engine's own commit pipeline for a conventional message drafted from the staged tree. 13 adds the
/// plugin-management commands (`plugins_*` / `marketplaces_*` / `plugins_reload`), which is what lets
/// the settings page install, configure, enable and upgrade plugins - a command-table change both
/// sides have to know. 14 adds `plugins_engine`: the engine build the host runs and which external
/// tools it found, which is what lets the page explain an install that cannot run at all
/// (`plugin_install_unavailable`) instead of reporting the plugin as broken. 15 reshapes the
/// `omp.desktop` page lists the plugin rows carry - `panels` / `views` / `settingsDestinations` /
/// `sidebarTabs` are entries (id, title, entry, order, panel size) rather than bare ids, and an
/// unsatisfied `engines.ompDesktop` refuses the block - which is what lets this process serve those
/// pages and open their windows (`services::plugins::pages`). The command table is unchanged, but
/// the payload is not: an artifact from before this version would fail to read every plugin row.
/// 16 adds the provider-credential pair (`provider_key_set` / `provider_key_clear`): the desktop
/// pushes a key it already holds in the OS credential store into the running host, so a key saved
/// after the host started takes effect without restarting it. A command-table change, like 13.
/// 17 adds the global-rules pair (`rules_read` / `rules_write`): the user-scope `RULES.md` the
/// engine loads into every request, which the settings page shows and replaces whole. The engine
/// only reads that file, so the host does the reading and the atomic replace itself - a
/// command-table change both sides have to know, like 13, because a host built before it would
/// absorb both calls as unknown frames while the desktop waited on an answer.
/// 18, 19, 26 and 31 carried the browser request vocabulary: the agent's `open_in_browser` tool
/// (`browser_open` → `session_browser_open_response`), the loopback CDP endpoint write that 31
/// replaced, and the `Browser` tool's session-scoped pair (`browser_call` →
/// `session_browser_call_response`). 32 removes all of it: this application no longer renders
/// pages, so a host built before it would send a request nothing answers and its tool call would
/// sit until its own timeout - the same class of change as 13, 16, 17 and 18, in the other
/// direction.
/// 20 adds the forced stop (`session_force_stop`): the desktop's last resort for a conversation
/// whose ordinary stop left it reading busy, so the host can take down whatever is wedged and name
/// the transcript it left behind. A host built before it would absorb the frame as an unknown one
/// while the desktop waited on an answer that never comes - the same class of change as 13, 16, 17
/// and 19.
/// 21 adds the marketplace catalogue read (`marketplace_plugins`): the entries a registered
/// marketplace offers, which is what the plugin store lists. A host built before it would absorb the
/// frame as an unknown one and the store would open empty - the same class of change as 13, 16, 17,
/// 19 and 20.
/// 22 adds the second host-request pair (`terminal_request` → `session_terminal_response`): the
/// agent's `workspace_terminal` tool asks this application what the terminals the user has open in a
/// workspace have printed, and types into one. Same shape and same consequence as 18 - a host built
/// before it would count the request as an unregistered frame and the tool call would sit there
/// until its own timeout.
/// 23 extends that request's action set with `create`, which starts a background terminal through the
/// existing PTY service. 24 adds terminal list auto-create and UI attach/open semantics. 25 adds
/// `session_rewind` (a user message taken back, the engine's own branch rewrite addressed by entry id
/// or message timestamp). Older host artifacts must be rejected rather than misreporting the action.
/// 27 changes `session_rewind` to an in-place rewrite: the session keeps its id and file, the
/// answer names no new identity, and the desktop rebuilds the conversation's rows instead of
/// switching to another one. Older host artifacts would branch the conversation onto a new file and
/// answer with a new id - which the desktop has no way to tell from a rewind - so they are rejected.
/// 28 adds the engine reclaim (`engine_reclaim`) whose answer carries what the host itself deleted
/// from the engine's tree; an older host would absorb it as an unknown frame and the settings page
/// could only report the desktop's share.
/// 29 changes what a stop answers: `session_abort` withdraws the reader's queued messages and
/// returns them (`restored`), and a turn that outlasts the stop window is answered with `remaining`
/// naming it rather than with a failed call. An older host would throw the retired `abort_timeout`
/// for the same situation, and an older desktop would read `aborted:true` while dropping the input
/// it never learned about - so the pair is versioned rather than left to field tolerance.
/// 30 adds the P1 capability frames (`plugins_session_*`, `plugins_usage_turns`,
/// `plugins_agent_complete`, `plugins_ws_*`): the three read surfaces and the socket controls a
/// plugin's bridge calls are answered through (`services::plugins::bridge::capabilities`). An older
/// host absorbs each as an unknown frame and the plugin's call sits until its own budget expires -
/// the same silence as 13/16/17, same version.
/// 33 brings the browser back as a host-request pair
/// (`browser_request` → `session_browser_response`) and the `Browser` / `BrowserPreview` tools. A
/// host built before it would count the request as an unregistered frame and the tool call would
/// sit until its own timeout - the same class as 18/22.
/// 34 adds the local-configuration import (`omp_import_scan` / `omp_import_apply`): the scan a
/// dialog renders and the apply that copies another installation's roles, keys, providers, MCP
/// servers and skills. An older host would absorb both frames as unknown and the dialog would wait
/// on answers nothing was going to send - the same silence, same version.
/// 35 adds the MCP source import (`mcp_import_scan` / `mcp_import_apply`): the definitions Claude
/// Code, Codex, omp and legacy pi keep in the real profile, which the pinned host home hides from
/// the engine's own discovery. Same class as 13/16/17/34.
/// 36 adds `compaction_set_options`: the two idle switches under the compaction card
/// (`compaction.idleEnabled`, `recap.enabled`), which the status read now reports as well. Same
/// class as 35 - a new command, and a host built before it would absorb the frame as unknown.
/// 37 adds `provider_keys_set`: the multi-key rotation pool the desktop keeps in the OS keyring is
/// handed to the running host as in-memory credentials. The host decides which environment variable
/// belongs to a provider from the spawn allow-list, never from the frame. An older host would
/// absorb the new frame as unknown and keep serving the first key only.
/// 38 widens `session_delete` to take the routing id `session.read` publishes as well as the
/// transcript path this desktop's own delete names - the id address is the frame behind a plugin's
/// `session.delete`, and a plugin's `session.rename` rides `session_set_name` unchanged. No command
/// is added, but an older host resolves the `sessionFile` it finds missing and refuses a delete a
/// plugin asked for, so the artifact is rebuilt with the desktop rather than left to that answer.
/// 39 adds the `ask` tool's form dialog: engine 18.18.3 replaced `questions[]` with one HTML form and
/// prefers `ui.formDialog`, so the host answers with a `form` request and this process replies with
/// per-control `answers`. An older host absorbs the `form` frame as an unknown method and leaves the
/// tool waiting for an answer nothing was going to send - the same silence as 13/16/17.
pub(crate) const PROTOCOL_VERSION: u32 = 39;
/// Connection-class commands (session state and friends) give up after this long.
pub(crate) const CONNECT_TIMEOUT_MS: u64 = 15_000;
/// Model catalogue reads re-hydrate provider credentials, which was measured at 3-10 s.
pub(crate) const MODELS_TIMEOUT_MS: u64 = 30_000;
/// Skill, MCP and memory calls: the host re-discovers engine configuration for every one of them
/// rather than reading a value it already holds, so they are budgeted wider than a state lookup.
pub(crate) const CAPABILITY_TIMEOUT_MS: u64 = 30_000;
/// The usage roll-up walks the whole session store, so it gets a budget of its own - several times
/// the capability one - that a large history can be scanned inside.
pub(crate) const USAGE_TIMEOUT_MS: u64 = 120_000;
/// Plugin installs, upgrades and marketplace writes: the host downloads a package or clones a
/// repository and unpacks it before it answers, which is network time plus disk time rather than a
/// lookup, so it gets the widest budget here that a command may spend before the user is told it
/// timed out.
pub(crate) const INSTALL_TIMEOUT_MS: u64 = 120_000;
/// One commit message is a model call over the whole staged diff, and the engine runs it as a
/// pipeline: map batches over the diff, an analysis, a summary, and re-validations, each inference
/// carrying the engine's own 120 s attempt ceiling with up to three attempts. That is why the host
/// answers this command under its own inner budget (`host/src/constants.ts::COMMIT_DRAFT_BUDGET_MS`,
/// 240 s) and stops the pipeline there; this outer budget only has to outlast that answer, so a
/// dropped request - the failure of 2026-10-29, where this 120 s expired first and the engine's
/// answer arrived with no pending request to hand it to - cannot happen again.
pub(crate) const COMMIT_MESSAGE_TIMEOUT_MS: u64 = 300_000;
/// One plugin completion (`plugins_agent_complete`): a single model call (`completeSimple`) on the
/// user's own provider, with no streaming, no pipeline and no budget of its own in this process -
/// unlike the commit draft above, which is a multi-operation pipeline the host stops by itself.
pub(crate) const PLUGIN_COMPLETION_TIMEOUT_MS: u64 = 120_000;
/// One plugin data answer (`plugins_session_*`, `plugins_usage_turns`): a read of this host's own
/// session index, budgeted like the usage walk when it pages through stored entries.
pub(crate) const PLUGIN_DATA_TIMEOUT_MS: u64 = 60_000;
/// One plugin socket operation (`plugins_ws_*`). A `receive` long-poll waits at most the caller's
/// own `waitMs` (10 s ceiling), so this covers that wait plus the round trip.
pub(crate) const PLUGIN_SOCKET_TIMEOUT_MS: u64 = 20_000;
/// Time allowed between spawn and the host's `hello` frame.
pub(crate) const HELLO_TIMEOUT_MS: u64 = 20_000;
/// Time allowed between `hello_ok` and the host's `ready` frame.
pub(crate) const READY_TIMEOUT_MS: u64 = 20_000;
/// Graceful shutdown: ask the host to shut down, then wait this long before killing the tree.
pub(crate) const SHUTDOWN_GRACE_MS: u64 = 10_000;
/// Streaming deltas are coalesced per session so the UI never sees one IPC call per token, and the
/// window is one display frame: a delivery then carries about as much text as a frame draws, so the
/// answer arrives as motion instead of a stutter followed by a burst of characters. A fast model
/// still puts several tokens in one window, so the boundary is crossed once per frame and not once
/// per token.
pub(crate) const DELTA_FLUSH_MS: u64 = 16;
pub(crate) const DELTA_FLUSH_BYTES: usize = 64 * 1024;
/// Delivery window for a conversation the reader is not looking at.
///
/// Several conversations can stream side by side, and each one's text would otherwise cost the
/// webview an event per display frame whether it is on screen or not. Nothing reads a background
/// conversation's increments at that cadence - the rail reads its status, which travels on its own
/// edges - so its text is coalesced over this wider window. Nothing is dropped: a message's buffer
/// is the whole text so far, and the terminal edges still flush immediately. The window goes back
/// to [`DELTA_FLUSH_MS`] the moment the conversation is adopted (`session_watch`).
pub(crate) const BACKGROUND_DELTA_FLUSH_MS: u64 = 100;
/// A prompt has to be re-encoded as one physical frame, so it is capped before it is sent.
pub(crate) const PROMPT_LIMIT_BYTES: usize = 512 * 1024;
/// Ceiling on one write of the engine's user-scope `RULES.md`, in UTF-8 bytes - the number the host
/// enforces as `RULES_CONTENT_MAX_BYTES`. The file is pasted text that every request carries, so
/// both sides refuse a larger write instead of truncating it silently; the command checks this
/// first so an oversized paste is reported without a round trip.
pub(crate) const RULES_CONTENT_LIMIT_BYTES: usize = 256 * 1024;
/// Local ceiling for chunk reassembly. The host advertises its own limit, but this process
/// decides how much memory it is willing to assemble for one logical frame.
pub(crate) const MAX_REASSEMBLED_LIMIT: usize = 64 * 1024 * 1024;
/// Local ceiling for one physical stdout line. The host's advertised `maxFrameBytes` is a
/// request, not a promise: this process decides how much it will buffer for one line, so an
/// advertisement asking for gigabytes must not become gigabytes of buffering.
pub(crate) const MAX_FRAME_LIMIT: usize = 8 * 1024 * 1024;
/// Frames the stdout reader may keep queued for the dispatcher before it stops reading.
///
/// The queue is the seam between a hand-written thread and the async dispatcher, and an unbounded
/// one there is a memory leak with a nicer name: a host that outruns the dispatcher would push
/// frames into this process as fast as it can write them. Bounded, the reader blocks instead, the
/// host's own write blocks behind it, and the pressure lands back on the pipe where it belongs.
pub(crate) const MAX_PENDING_FRAMES: usize = 2_048;
/// Bytes the stdout reader may keep queued for the dispatcher, on top of the frame ceiling above.
///
/// A count of frames is not a memory ceiling: one queued item is a frame already parsed, and a
/// reassembled frame may legitimately be tens of megabytes (`MAX_REASSEMBLED_LIMIT`), so a queue
/// bounded by count alone would let a host that speaks in full-size frames hold gigabytes. The
/// reader charges each frame's own wire size against this budget before it queues it and the
/// dispatcher returns it once the frame is handled (`host::InboundBudget`), so what the queue holds
/// is bounded in bytes whatever the frames look like.
pub(crate) const MAX_PENDING_BYTES: usize = 32 * 1024 * 1024;
/// Upper bound for a single rendered text field (tool result, thinking, message text).
pub(crate) const MAX_TEXT_CHARS: usize = 128 * 1024;
/// Upper bound for one diff inside a tool call's details. Larger than a status line and much
/// smaller than a message: it is read line by line, and a rendered diff costs a row per line.
const MAX_DIFF_CHARS: usize = 24 * 1024;
/// How many files one edit's details may name, and how many subagents one `task` call may roster.
const MAX_DETAIL_FILES: usize = 20;
const MAX_DETAIL_SUBAGENTS: usize = 32;
/// Upper bound for a minimizer filter's label, ellipsis included: a short word (`git`, `chain`) the
/// engine wrote, on a row that already has a result body under it. The same width the engine's own
/// card formatter uses (`TRUNCATE_LENGTHS.SHORT`, 40 columns), so the two surfaces cut the same label
/// at the same place.
const MAX_MINIMIZED_FILTER_CHARS: usize = 40;
/// How many image parts one tool result or one message may carry.
///
/// A gallery is read as a strip of thumbnails, and the parts past the first few are the engine
/// repeating itself (a screenshot per step of a browser run); the walk stops here rather than
/// spending a frame on pictures nobody scrolls to.
pub(crate) const MAX_IMAGE_PARTS: usize = 6;
/// Ceiling for one image part's base64 text, about 4 MiB decoded.
pub(crate) const MAX_IMAGE_B64_BYTES: usize = 5_500_000;
/// Ceiling for all image base64 text of one result or message, about 10 MiB decoded.
pub(crate) const MAX_IMAGES_TOTAL_B64_BYTES: usize = 14_000_000;
/// How many sources one tool result may cite.
const MAX_TOOL_SOURCES: usize = 8;
/// Upper bound for a search provider's synthesized answer, in characters.
///
/// The answer is prose a reader reads on the row, not the model's payload: a few paragraphs cover
/// every provider that writes one, and a longer text is the provider restating its sources (which
/// are drawn under it anyway). Counted in characters, like every other rendered field.
const MAX_SEARCH_ANSWER_CHARS: usize = 4 * 1024;
pub(crate) const MAX_LOG_LINE_BYTES: usize = 8 * 1024;
/// Ceiling for one engine log file, counted from what the file already holds rather than from what
/// one host process wrote into it. A file past it is rotated to its `.1` sibling when the next host
/// opens it, so the pair stays bounded and the current file is never cut off mid-write.
pub(crate) const LOG_FILE_LIMIT_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const SESSION_CHANNEL_PREFIX: &str = "omp:session:";
pub(crate) const RUNTIME_CHANNEL: &str = "omp:runtime";

/// Event channel for one session. Tauri only accepts alphanumerics and `-/:_.`,
/// so the session id is folded into that set before it becomes a channel name.
pub(crate) fn session_channel(session_id: &str) -> String {
    let mut channel = String::with_capacity(SESSION_CHANNEL_PREFIX.len() + session_id.len());
    channel.push_str(SESSION_CHANNEL_PREFIX);
    for character in session_id.chars() {
        if character.is_alphanumeric() || matches!(character, '-' | '/' | ':' | '_') {
            channel.push(character);
        } else {
            channel.push('-');
        }
    }
    channel
}

pub(crate) fn emit_session(app: &AppHandle, session_id: &str, payload: Value) {
    if session_id.is_empty() {
        // The session was closed or the host never named one; there is no channel to publish
        // to, and an empty channel name would be a silent dead end.
        return;
    }
    let channel = session_channel(session_id);
    if app.emit(&channel, payload).is_err() {
        log::warn(&format!("emitting to {channel} failed"));
    }
}

pub(crate) fn emit_runtime<T: Serialize + Clone>(app: &AppHandle, payload: T) {
    if app.emit(RUNTIME_CHANNEL, payload).is_err() {
        log::warn(&format!("emitting to {RUNTIME_CHANNEL} failed"));
    }
}

/// Compact JSON text for arbitrary engine payloads (tool arguments, tool results).
pub(crate) fn stringify(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => clamp_text(text.clone()),
        Some(Value::Null) | None => String::new(),
        Some(other) => clamp_text(other.to_string()),
    }
}

/// Truncates a streamed field to a size the UI can render, marking the cut explicitly.
pub(crate) fn clamp_text(text: String) -> String {
    if text.chars().count() <= MAX_TEXT_CHARS {
        return text;
    }
    let mut clamped: String = text.chars().take(MAX_TEXT_CHARS).collect();
    clamped.push_str("\n…(truncated)");
    clamped
}

/// The words of an engine content payload, as the payload holds them: a bare string, or the `text`
/// parts of a content array, with nothing cut.
///
/// Split from [`content_text`] because one reader has to see the whole payload before it is bounded:
/// a stored prompt names its files in the lines at its end (`services/attachment_mentions.rs`), and
/// a read that clamped first would cut those lines away and lose the files the message carried. It
/// is the same flattening either way, so the two cannot disagree about what a payload says.
///
/// Image parts are skipped rather than spelled: a picture is not a word, and the marker this used
/// to leave behind (`[image]`) was noise in a row that draws the picture itself from
/// [`content_images`]. A part whose words this function cannot read contributes nothing.
pub(crate) fn content_words(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => {
            let mut text = String::new();
            for part in parts {
                let part_type = part.get("type").and_then(Value::as_str).unwrap_or_default();
                let chunk = match part_type {
                    "text" => part.get("text").and_then(Value::as_str).unwrap_or_default(),
                    _ => continue,
                };
                if chunk.is_empty() {
                    continue;
                }
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(chunk);
            }
            text
        }
        _ => String::new(),
    }
}

/// The words of an engine content payload, bounded for the screen.
///
/// Both the history walk (which reads a stored message's `content`) and the live projection (which
/// reads a tool result's `content`) flatten through this one function, so a call reads the same
/// while it runs as it does after the session is reopened - the two must never disagree.
pub(crate) fn content_text(content: Option<&Value>) -> String {
    clamp_text(content_words(content))
}

/// The reminder this engine message is, when it is a rule check the reader should see.
///
/// The engine writes these into **developer** messages — context for the model, which the transcript
/// otherwise leaves out. The exception is the rule check that fired on a tool call: it is the only
/// place the reader can learn why the call beside it was refused or altered, so it is the one
/// developer message that becomes a row (`ChatMessage::Reminder`).
///
/// Only `reason="rule_violation"` qualifies. Everything else the engine injects this way — the eval
/// runtime's registry, a todo nudge, the epoch and working-directory reminders — restates something
/// the screen already carries (the eval call's own row, the todo panel, the state line), and a turn
/// would be a wall of injected context if they were drawn.
pub(crate) fn reminder_text(message: &Value) -> Option<String> {
    if message.get("role").and_then(Value::as_str) != Some("developer") {
        return None;
    }
    let text = content_words(message.get("content"));
    let opening = text.trim_start();
    if !opening.starts_with("<system-reminder") || !opening.contains("reason=\"rule_violation\"") {
        return None;
    }
    Some(clamp_text(text))
}

/// The row one reminder becomes, when this message is one (`reminder_text`), or nothing.
///
/// The identity and the stamp are the entry's own, read exactly the way every other row reads them,
/// so the reminder a live frame drew and the one a reopened conversation reads back are the same row.
pub(crate) fn reminder_message(entry: &Value) -> Option<ChatMessage> {
    let text = reminder_text(entry)?;
    Some(ChatMessage::Reminder {
        id: history::message_id(entry),
        at: history::timestamp_of(entry),
        text,
    })
}

/// The image parts of one engine content payload, as the frontend renders them.
///
/// An engine result or message carries its pictures the way it carries its words - parts in
/// `content` - and they are the one part a row cannot read as text: a screenshot is megabytes of
/// base64 whose only use is an `<img src>`. So each part travels as a data URL that is ready to
/// render, and the list is bounded on every axis it can grow along, because the payload is engine
/// output whose size this process does not choose. A part past the per-image ceiling is dropped
/// whole (half a picture is not a picture), and the walk stops at the part count and at the
/// running byte budget below, keeping the parts that appeared first. The vector is built for one
/// frame or one row and lives no longer than it does.
pub(crate) fn content_images(content: Option<&Value>) -> Vec<ChatImage> {
    let Some(Value::Array(parts)) = content else {
        return Vec::new();
    };
    let mut images: Vec<ChatImage> = Vec::new();
    let mut total_bytes = 0usize;
    for part in parts {
        if images.len() >= MAX_IMAGE_PARTS {
            break;
        }
        if part.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        // A part is only a picture if the engine said what kind it is, and everything a browser can
        // draw starts with `image/`: a part whose `mimeType` is missing or is something else is
        // left out rather than drawn wrong.
        let Some(mime_type) = part
            .get("mimeType")
            .and_then(Value::as_str)
            .filter(|value| value.starts_with("image/"))
        else {
            continue;
        };
        let Some(data) = part
            .get("data")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if data.len() > MAX_IMAGE_B64_BYTES {
            continue;
        }
        if total_bytes + data.len() > MAX_IMAGES_TOTAL_B64_BYTES {
            break;
        }
        total_bytes += data.len();
        images.push(ChatImage {
            mime_type: mime_type.to_owned(),
            // Base64 carries three bytes per four characters, and the padding only rounds the
            // estimate up. Decoding the picture to count it exactly would cost a copy of the very
            // payload this function exists to bound, for a label that reads "~" anyway.
            bytes: data.len() / 4 * 3,
            data_url: format!("data:{mime_type};base64,{data}"),
        });
    }
    images
}

/// What a tool call reported, as text: its content parts when it has them, its own text when the
/// engine sent a bare string, and its JSON only for a shape neither of those describes.
///
/// JSON is the fallback rather than the default because an `AgentToolResult` is an object
/// (`{content, details}`): stringifying it would put an escaped blob where the call's words belong,
/// which is neither what the engine wrote nor what a reader can use.
pub(crate) fn result_text(result: Option<&Value>) -> String {
    match result {
        Some(Value::String(text)) => clamp_text(text.clone()),
        Some(value) if value.get("content").is_some() => content_text(value.get("content")),
        Some(other) => stringify(Some(other)),
        None => String::new(),
    }
}

/// The pages one search call read, as the citation lines under its row.
///
/// The engine answers a search with its own source list (`details.response.sources[]`), each entry
/// a page it read with the title, url and snippet it was given, and the row is the only place a
/// reader can follow one. Read like every other engine list: bounded by count, each field taken
/// only when it is the type it claims to be, and an entry with no url dropped rather than drawn as
/// a citation nothing can open. `details` is the whole details object the result carried.
pub(crate) fn tool_sources(details: Option<&Value>) -> Vec<ToolSource> {
    let Some(entries) = details
        .and_then(|details| details.get("response"))
        .and_then(|response| response.get("sources"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    entries
        .iter()
        .take(MAX_TOOL_SOURCES)
        .filter_map(|entry| {
            let url = entry
                .get("url")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())?;
            Some(ToolSource {
                title: entry
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                url: url.to_owned(),
                snippet: entry
                    .get("snippet")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            })
        })
        .collect()
}

/// The answer a search provider wrote for the query, when it wrote one.
///
/// `details.response.answer` is the synthesized prose of the LLM-mediated providers (xAI, Anthropic,
/// Perplexity); a pure search engine leaves it out. It is trimmed, clamped, and answered as nothing
/// when it is only whitespace - the row draws a paragraph, and an empty one is a heading with no
/// text under it. Pure, so the shape can be read without an engine.
pub(crate) fn tool_answer(details: Option<&Value>) -> Option<String> {
    let text = details
        .and_then(|details| details.get("response"))
        .and_then(|response| response.get("answer"))
        .and_then(Value::as_str)?
        .trim();
    if text.is_empty() {
        return None;
    }
    Some(clamp_chars(text, MAX_SEARCH_ANSWER_CHARS))
}

/// The first `limit` characters of a string, with an ellipsis when anything was left out.
fn clamp_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut clamped: String = text.chars().take(limit.saturating_sub(1)).collect();
    clamped.push('…');
    clamped
}

/// The structured part of a tool call's result that a chat row draws.
///
/// The engine reports far more than this — whole-file snapshots (`oldText`/`newText`), per-file
/// metadata, diagnostics, output limits — and none of it belongs on the wire: what travels is the
/// diff a reader looks at, the path a reader opens, the subagents a `task` call ran, and the pages
/// a search read. Every string is bounded and every list is capped, because a tool result is engine
/// output and its size is the file it touched, not something this process chose.
pub(crate) fn tool_details(details: Option<&Value>) -> Option<ToolDetails> {
    let details = details?;
    if !details.is_object() {
        return None;
    }

    let path = details
        .get("resolvedPath")
        .and_then(Value::as_str)
        .or_else(|| details.get("path").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let diff = details
        .get("diff")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(clamp_diff);
    let first_changed_line = details.get("firstChangedLine").and_then(Value::as_i64);

    let files = details
        .get("perFileResults")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .take(MAX_DETAIL_FILES)
                .filter_map(|entry| {
                    let path = entry.get("path").and_then(Value::as_str)?;
                    Some(ToolFileChange {
                        path: path.to_owned(),
                        diff: entry
                            .get("diff")
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty())
                            .map(clamp_diff),
                        first_changed_line: entry.get("firstChangedLine").and_then(Value::as_i64),
                        is_error: entry
                            .get("isError")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        error_text: entry
                            .get("displayErrorText")
                            .and_then(Value::as_str)
                            .or_else(|| entry.get("errorText").and_then(Value::as_str))
                            .filter(|value| !value.is_empty())
                            .map(|value| clamp_text(value.to_owned())),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let subagents = subagent_roster(details);
    let sources = tool_sources(Some(details));
    let answer = tool_answer(Some(details));
    // The minimizer's own account of what it did to a shell call's output: the filter that ran and
    // the bytes before and after. It lives under `meta`, the same object the engine's other output
    // notices come from, and is the one fact about a result that its text cannot state - the text a
    // reader sees is the minimized output, so nothing in it says the raw capture was larger.
    let minimized = details
        .get("meta")
        .and_then(|meta| meta.get("minimized"))
        .and_then(tool_minimized);

    // `async` is not a `task` fact: a background `bash` or `eval` call publishes the same marker,
    // and a call that returns that way forwards no later details frame, so a state read off one
    // would leave its row reading as work in flight for the rest of the session. The marker's own
    // `type` is what says whose state it is.
    let subagent_state = details
        .get("async")
        .filter(|value| value.get("type").and_then(Value::as_str) == Some("task"))
        .and_then(|value| value.get("state"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    if path.is_none()
        && diff.is_none()
        && first_changed_line.is_none()
        && files.is_empty()
        && subagents.is_empty()
        && subagent_state.is_none()
        && sources.is_empty()
        && answer.is_none()
        && minimized.is_none()
    {
        return None;
    }

    Some(ToolDetails {
        path,
        diff,
        first_changed_line,
        files,
        subagents,
        subagent_state,
        sources,
        answer,
        minimized,
    })
}

/// One shell call's minimizer record, from the engine's `meta.minimized`.
///
/// The filter label is engine text that a rehydrated session or an extension may have written, so it
/// is bounded like every other string on the wire; the byte counts are the engine's own numbers and
/// are kept as they are, since a reader compares them with the capture they can open.
fn tool_minimized(minimized: &Value) -> Option<ToolMinimized> {
    let input_bytes = minimized.get("inputBytes").and_then(Value::as_i64)?;
    let output_bytes = minimized.get("outputBytes").and_then(Value::as_i64)?;
    Some(ToolMinimized {
        filter: minimized
            .get("filter")
            .and_then(Value::as_str)
            .map(|filter| clamp_chars(&sanitize_message(filter), MAX_MINIMIZED_FILTER_CHARS))
            .unwrap_or_default(),
        input_bytes: input_bytes.max(0),
        output_bytes: output_bytes.max(0),
    })
}

/// The subagents one `task` call reports, as one roster.
///
/// A `task` call reports its children twice and differently. A spawn that runs in the background
/// publishes that roster live on `progress[]` - each child's state, how many tools it has called,
/// the tool it is inside, the intent it last stated - and leaves `results[]` empty until the call
/// itself returns; a spawn that runs inline publishes only `results[]`. So `progress[]` is the
/// roster and `results[]` is the last word on it: matched by the engine's own subagent id (the key
/// a settling result comes back under), a finished child overwrites its own row instead of
/// appending a second one.
///
/// A call that reported neither list has no roster at all - not an empty one - so a row for a
/// different tool cannot grow a heading with nothing under it.
fn subagent_roster(details: &Value) -> Vec<ToolSubagent> {
    let mut roster: Vec<(String, ToolSubagent)> = details
        .get("progress")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .take(MAX_DETAIL_SUBAGENTS)
                .filter_map(|entry| Some((subagent_id(entry)?, subagent_row(entry)?)))
                .collect()
        })
        .unwrap_or_default();

    if let Some(entries) = details.get("results").and_then(Value::as_array) {
        for entry in entries.iter().take(MAX_DETAIL_SUBAGENTS) {
            let Some(mut settled) = subagent_row(entry) else {
                continue;
            };
            // A result carries no state of its own: the engine derives the child's settled one
            // from it (`task/index.ts`, where the inline path writes the same judgement into the
            // live roster), so the same rule is applied here - aborted stays aborted, a zero exit
            // with no error is completed, anything else failed.
            if settled.status.is_none() {
                settled.status = settled_state(entry).map(str::to_owned);
            }
            let key = subagent_id(entry);
            let position = key
                .as_deref()
                .and_then(|key| roster.iter().position(|(candidate, _)| candidate == key));
            match position {
                Some(index) => absorb(&mut roster[index].1, settled),
                // A result naming neither an id nor a name is still a subagent that ran, so it
                // takes a row of its own rather than being dropped.
                None => roster.push((key.unwrap_or_default(), settled)),
            }
        }
    }

    // Each list is capped as it is read, but the two merge into one roster, so the bound that has
    // to hold is on the merged list: a call whose live window is full can still report children
    // settled outside it, and a cap per list would roster twice `MAX_DETAIL_SUBAGENTS` rows.
    roster
        .into_iter()
        .map(|(_, row)| row)
        .take(MAX_DETAIL_SUBAGENTS)
        .collect()
}

/// One subagent row, from either list a `task` call reports it in.
///
/// Both lists carry the same fields, and one a list does not report stays absent rather than being
/// invented: absent on this row means "the engine did not say", which is not the same fact as
/// `0`. The one field every row renders and every list reports is the agent type, so a row without
/// one is not a subagent at all.
fn subagent_row(entry: &Value) -> Option<ToolSubagent> {
    let agent = nonempty_text(entry.get("agent"))?;
    Some(ToolSubagent {
        name: nonempty_text(entry.get("name")),
        // The engine's own id for the child, and the identity every report of it carries - the same
        // id its live roster frame names it by, which is what a result row is matched with.
        id: subagent_id(entry),
        agent,
        description: nonempty_text(entry.get("description"))
            .or_else(|| nonempty_text(entry.get("assignment")))
            .or_else(|| nonempty_text(entry.get("task")))
            .map(clamp_text),
        exit_code: entry
            .get("exitCode")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        duration_ms: entry
            .get("durationMs")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        tokens: entry
            .get("tokens")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        truncated: entry
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        status: nonempty_text(entry.get("status")),
        tool_count: entry.get("toolCount").and_then(Value::as_i64),
        current_tool: nonempty_text(entry.get("currentTool")),
        // The child's own words for what it is doing; bounded like every other string the engine
        // writes, because it is prose and the child decides how long.
        last_intent: nonempty_text(entry.get("lastIntent")).map(clamp_text),
        // The model it ran on, when the engine resolved one on this record - the same field a live
        // progress frame carries, so a settled row states it after a reload too.
        model: subagent_model(entry),
    })
}

/// How a settled child ended, from its own result: the engine's judgement, applied to the same
/// two facts it applies it to - an abort, and an exit code. A result that reports no exit code
/// states no outcome at all, which is not the same as a successful one.
fn settled_state(entry: &Value) -> Option<&'static str> {
    if entry
        .get("aborted")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Some("aborted");
    }
    let exit_code = entry.get("exitCode").and_then(Value::as_i64)?;
    Some(if exit_code == 0 && entry.get("error").is_none() {
        "completed"
    } else {
        "failed"
    })
}

/// The last word a settling result has on a row the live roster already carries: how the child
/// ended, what it cost, and what it was asked. A field the result says nothing about - the tool the
/// child was inside when the roster last reported, its running tool count - stays as the roster
/// reported it, because a result is not evidence that the child never used a tool.
fn absorb(row: &mut ToolSubagent, settled: ToolSubagent) {
    row.name = settled.name.or_else(|| row.name.take());
    // Either list may be the one that carries the id, so a settled row that names the child keeps
    // the row's identity rather than blanking it.
    row.id = settled.id.or_else(|| row.id.take());
    row.description = settled.description.or_else(|| row.description.take());
    row.exit_code = settled.exit_code;
    row.duration_ms = settled.duration_ms;
    row.tokens = settled.tokens;
    row.truncated = settled.truncated;
    row.status = settled.status;
    row.last_intent = settled.last_intent.or_else(|| row.last_intent.take());
}

/// The identity a settling result comes back under: the engine's own subagent id, or the name it
/// was spawned with when it reports no id.
fn subagent_id(entry: &Value) -> Option<String> {
    nonempty_text(entry.get("id")).or_else(|| nonempty_text(entry.get("name")))
}

/// One optional string field of an engine payload. Absent and empty are the same fact here, and
/// neither is worth carrying: a row draws nothing for either, and a `""` on the wire only invites
/// a reader to treat it as a value.
///
/// Shared with the session's subagent roster (`host/session.rs`), which reads the same payloads
/// under the same rule.
pub(crate) fn nonempty_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The engine's own one-line intent for a tool call, in the shape both paths carry it.
///
/// The engine writes the intent onto the call it belongs to (`ToolCallContent.intent`) and sends
/// the same value on `tool_execution_start`, so one reader serves the live frame and the page a
/// reopened conversation is built from: a call whose arguments name nothing the row's presentation
/// knows - `todo`, `hub`, a `task` spawn - reads as this line and nothing else, and a path that
/// dropped it would leave those rows bare titles after a reload (the regression `history` covers).
/// Engine text like every other string on the wire, so it is redacted and bounded here, once.
pub(crate) fn intent_text(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(clamp_text(sanitize_message(text)))
}

/// A diff is bounded like any other streamed text, but with its own ceiling: it is the one field a
/// reader scrolls, so it earns more room than a line of status text while still being finite.
fn clamp_diff(diff: &str) -> String {
    if diff.chars().count() <= MAX_DIFF_CHARS {
        return diff.to_owned();
    }
    let mut clamped: String = diff.chars().take(MAX_DIFF_CHARS).collect();
    clamped.push_str("\n…(truncated)");
    clamped
}

/// One log file per host process. Append-only, size-capped, never contains unredacted payloads.
pub(crate) struct EngineLog {
    path: PathBuf,
    written: AtomicU64,
    capped: AtomicBool,
    /// Ceiling for the file, counted from what it already holds (see [`EngineLog::new_with_cap`]).
    cap: u64,
}

impl EngineLog {
    pub(crate) fn new(dir: &Path, key: &str) -> Self {
        Self::new_with_cap(dir, key, LOG_FILE_LIMIT_BYTES)
    }

    /// `cap` is a parameter so a test can reach it without writing sixteen megabytes, the same
    /// reason `log::Sink::open_with_limit` takes one.
    ///
    /// A file a previous host already filled is moved to `<name>.1` (overwriting that host's own
    /// predecessor) before this one is opened, so the directory keeps one predecessor and the pair
    /// stays bounded. Without it the cap would only bound one *run*: the handle is opened, written
    /// and closed per line, so an append-only file would keep growing across every start. The
    /// rotation is best-effort - a step that fails leaves the file as it was, and the cap below then
    /// bounds what this host adds to it.
    fn new_with_cap(dir: &Path, key: &str, cap: u64) -> Self {
        let mut name = String::with_capacity(key.len() + 5);
        for character in key.chars() {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                name.push(character);
            } else {
                name.push('-');
            }
        }
        name.push_str(".log");
        let path = dir.join(&name);
        if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > cap) {
            let rotated = dir.join(format!("{name}.1"));
            let _ = std::fs::remove_file(&rotated);
            let _ = std::fs::rename(&path, &rotated);
        }
        // The counter starts at what the file already holds, so the cap bounds the *file* rather
        // than this run's share of it - which is what makes the size of `host.log` a number the user
        // can predict.
        let written = std::fs::metadata(&path).map_or(0, |metadata| metadata.len());
        Self {
            path,
            written: AtomicU64::new(written),
            capped: AtomicBool::new(false),
            cap,
        }
    }

    /// Appends one already-redacted line. Logging must never fail the caller.
    ///
    /// The counter stops within one line of the cap: a spent log returns above before it is touched
    /// again, so a host that keeps printing cannot walk it into a wrap-around that would reopen the
    /// file, and the only value it can hold is the file's own length plus one line.
    pub(crate) fn line(&self, message: &str) {
        if self.capped.load(Ordering::Relaxed) {
            return;
        }
        if self
            .written
            .fetch_add(message.len() as u64, Ordering::Relaxed)
            > self.cap
        {
            if !self.capped.swap(true, Ordering::Relaxed) {
                log::warn(&format!(
                    "engine log {} reached its size limit",
                    self.path.display()
                ));
            }
            return;
        }
        // The engine's own text, under the application log's one-record rules: the host writes to
        // its stderr freely - a stack trace, an escape sequence, a line break - and a file the user
        // is asked to hand to someone else has to read as records rather than as instructions.
        let mut line = String::with_capacity(message.len() + 8);
        log::push_record_text(&mut line, &sanitize_message(message));
        line.push('\n');
        if let Err(error) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()))
        {
            log::warn(&format!("writing {} failed: {error}", self.path.display()));
        }
    }
}

#[cfg(test)]
mod content_image_tests;
#[cfg(test)]
mod engine_log_tests;
#[cfg(test)]
mod history_reminder_tests;
#[cfg(test)]
mod intent_tests;
#[cfg(test)]
mod tool_detail_tests;
#[cfg(test)]
mod tool_source_tests;

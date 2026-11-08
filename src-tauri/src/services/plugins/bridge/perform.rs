//! The half of a bridge call that *does* something, split from the half that decides whether it may
//! (`super`): every function here runs only after [`super::judge`] let the call through, and each one
//! answers either the page's `result` or a refusal it could not complete.
//!
//! The split is not cosmetic. A judgement is a pure matrix over the manifest, the session's grants
//! and the user's answer, which is what makes it testable with nothing running; performing is
//! filesystem, clipboard, network, window and log work, which is not. Keeping them in one file made
//! the readable half the smaller one.
//!
//! Two rules hold across every arm:
//!
//! - **The answer is what happened.** A job that could not complete answers with the refusal that
//!   stopped it; nothing here reports success on the page's behalf.
//! - **The path is resolved again.** A read, a write and a delete re-resolve inside this module
//!   rather than carrying the path the judgement resolved: between the answer and the act the target
//!   can be replaced by a link, and the containment check is exactly the check that catches it.

use base64::Engine;
use serde_json::{json, Value};

use super::capabilities;
use super::{
    BridgeEffects, Job, Refusal, INTERNAL, MAX_CLIPBOARD_BYTES, MAX_READ_BYTES, NOT_FOUND,
    PERMISSION_DENIED, TOO_LARGE, TOO_MANY_DELETES, UNSUPPORTED,
};
use crate::services::plugins::gates;

/// Runs one judged job: the side effects, and the answer the page receives.
pub(super) fn run(
    job: &Job,
    page: &crate::services::plugins::pages::PluginPage,
    roots: &gates::FsRoots,
    effects: &mut dyn BridgeEffects,
) -> Result<Value, Refusal> {
    // The judgement's own reading, so the act resolves the way the answer did; a link swapped in
    // between the two is still resolved the way the installation declared.
    let unrestricted = page.grants.declares("fs.anyPath");
    match job {
        Job::Ready => Ok(json!({ "ok": true })),
        Job::Close => {
            if effects.close_caller() {
                Ok(json!({ "ok": true }))
            } else {
                Err(PERMISSION_DENIED)
            }
        }
        // The domain list comes from the installation's own declaration rather than from the
        // judgement, so a call that was allowed is still checked against the list this process holds.
        Job::Fetch { request } => {
            crate::services::plugins::net::fetch(page.grants.net_policy(), request.clone())
        }
        Job::ClipboardRead => clipboard_read(),
        Job::Write { display, bytes } => {
            let target =
                super::files::resolve_file(roots, display, gates::FsMode::Write, unrestricted)
                    .map_err(super::files::refusal_of)?;
            write_file(&target, bytes)?;
            Ok(json!({ "ok": true, "result": { "path": display, "bytes": bytes.len() } }))
        }
        Job::Delete { display } => {
            let target =
                super::files::resolve_file(roots, display, gates::FsMode::Delete, unrestricted)
                    .map_err(super::files::refusal_of)?;
            // The brake is the caller's (it is per installation, and this function has no key), so it
            // is taken here through the effects - which is also what lets a test count the calls.
            if !effects.take_delete() {
                return Err(TOO_MANY_DELETES);
            }
            if !crate::services::trash::trash_supported() {
                return Err(UNSUPPORTED);
            }
            if !crate::services::trash::move_to_trash(&target) {
                return Err(INTERNAL);
            }
            Ok(json!({ "ok": true, "result": { "path": display } }))
        }
        Job::Notice { title, body } => {
            effects.notify(title, body);
            Ok(json!({ "ok": true }))
        }
        Job::Log { level, message } => {
            effects.log_line(level, message);
            Ok(json!({ "ok": true }))
        }
        // The four P1 families that are answered by data this application already holds. The answer
        // comes back as the host reported it, and the one thing added here is the response ceiling:
        // a page that asked for 500 messages with bodies got an answer, and an answer over the cap is
        // refused rather than truncated - half a page of messages is not the page that was asked for.
        Job::Data { request } => {
            let value = effects.plugin_data(request)?;
            let encoded = serde_json::to_vec(&value).map_err(|_| INTERNAL)?;
            if encoded.len() > capabilities::RESPONSE_BYTES_MAX {
                return Err(TOO_LARGE);
            }
            Ok(json!({ "ok": true, "result": value }))
        }
        Job::BusPublish { topic, payload } => {
            Ok(json!({ "ok": true, "result": effects.bus_publish(topic, payload)? }))
        }
        Job::BusSubscribe { topics } => {
            Ok(json!({ "ok": true, "result": effects.bus_subscribe(topics)? }))
        }
        // The address was cleared against the manifest's own egress policy by the gate
        // (`capabilities::judge_open_external`), so this arm only asks the system to open it.
        Job::OpenExternalUrl { url } => {
            effects.open_external_url(url)?;
            Ok(json!({ "ok": true }))
        }
        // One directory per installation, created here rather than up front: a plugin that never
        // asks for one never gets one, and a plugin that does finds it already there.
        Job::DataDir => Ok(json!({ "ok": true, "result": { "path": effects.data_dir()? } })),
        Job::ClipboardWrite { text } => clipboard_write(text),
        // The path is resolved again here rather than carried from the judgement: between the answer
        // and the read the file could have been replaced by a link, and the containment gate is
        // exactly the check that catches it. The cost is one more canonicalisation.
        Job::Read { display } => {
            let path =
                super::files::resolve_file(roots, display, gates::FsMode::Read, unrestricted)
                    .map_err(super::files::refusal_of)?;
            let metadata = std::fs::metadata(&path).map_err(|_| NOT_FOUND)?;
            if !metadata.is_file() {
                return Err(NOT_FOUND);
            }
            if metadata.len() > MAX_READ_BYTES {
                return Err(TOO_LARGE);
            }
            let bytes = read_capped(&path)?;
            let read = bytes.len();
            let (encoding, text) = match String::from_utf8(bytes) {
                Ok(text) => ("utf8", text),
                Err(error) => (
                    "base64",
                    base64::engine::general_purpose::STANDARD.encode(error.into_bytes()),
                ),
            };
            Ok(json!({
                "ok": true,
                "result": { "path": display, "bytes": read, "encoding": encoding, "text": text },
            }))
        }
        // What is at a path. An inspection, so a directory is an answer rather than a `NotFound` -
        // and nothing is read, which is why a directory's `size` is the platform's own number and
        // says nothing about what it holds.
        Job::Stat { display } => {
            let path =
                super::files::resolve_file(roots, display, gates::FsMode::Inspect, unrestricted)
                    .map_err(super::files::refusal_of)?;
            let metadata = std::fs::metadata(&path).map_err(|_| NOT_FOUND)?;
            Ok(json!({
                "ok": true,
                "result": {
                    "path": display,
                    "directory": metadata.is_dir(),
                    "size": metadata.len(),
                    "modifiedMs": metadata.modified().ok().and_then(modified_ms),
                },
            }))
        }
        // One directory's entries, bounded rather than refused: half a listing still answers "what
        // is in here", unlike half a file, so the cut is marked rather than turned into a refusal.
        Job::List { display } => {
            let path =
                super::files::resolve_file(roots, display, gates::FsMode::Inspect, unrestricted)
                    .map_err(super::files::refusal_of)?;
            let listing = std::fs::read_dir(&path).map_err(|_| NOT_FOUND)?;
            let mut entries: Vec<(String, bool)> = Vec::new();
            let mut truncated = false;
            for entry in listing.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                // The reject table covers a listing the way it covers a read: an installation
                // without `fs.anyPath` is not told the names of the files it will be refused.
                if !unrestricted && gates::is_rejected_path(&name) {
                    continue;
                }
                if entries.len() >= super::MAX_LIST_ENTRIES {
                    truncated = true;
                    break;
                }
                let directory = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
                entries.push((name, directory));
            }
            // A directory's own order is an order that changes between two identical calls, so the
            // answer is sorted by name: the same directory answers the same way twice.
            entries.sort();
            let entries: Vec<Value> = entries
                .into_iter()
                .map(|(name, directory)| json!({ "name": name, "directory": directory }))
                .collect();
            Ok(json!({
                "ok": true,
                "result": { "path": display, "entries": entries, "truncated": truncated },
            }))
        }
        // Every entry a pattern names, walked from the pattern's own literal prefix. The prefix is
        // resolved again here for the same reason a read's path is: between the answer and the walk
        // the target can be replaced by a link, and the containment check is what catches it.
        Job::Glob { display, plan } => {
            let base = super::files::resolve_glob_base(roots, plan, unrestricted)
                .map_err(super::files::refusal_of)?;
            let mut hits = Vec::new();
            // The same reading of `fs.anyPath` the base was resolved with, so the walk and the
            // resolver in front of it cannot disagree about the reject table.
            let truncated = crate::services::plugins::glob::walk(
                &base,
                &plan.pattern,
                !unrestricted,
                &mut hits,
            );
            // A directory's own order is an order that changes between two identical calls, so the
            // answer is sorted by path: the same pattern answers the same way twice.
            hits.sort_by(|left, right| left.relative.cmp(&right.relative));
            let entries: Vec<Value> = hits
                .into_iter()
                .map(|hit| {
                    json!({
                        "path": crate::services::plugins::glob::join(plan, &hit.relative),
                        "directory": hit.directory,
                        "size": hit.size,
                        "modifiedMs": hit.modified.and_then(modified_ms),
                    })
                })
                .collect();
            Ok(json!({
                "ok": true,
                "result": { "pattern": display, "entries": entries, "truncated": truncated },
            }))
        }
        // One byte range. The same resolution and the same "it is a file" check a whole read makes;
        // what is new is where the read starts and stops. An offset past the end is an empty answer
        // rather than a refusal - the caller asked what is there, and past the end nothing is.
        Job::ReadRange {
            display,
            offset,
            length,
        } => {
            let path =
                super::files::resolve_file(roots, display, gates::FsMode::Read, unrestricted)
                    .map_err(super::files::refusal_of)?;
            let metadata = std::fs::metadata(&path).map_err(|_| NOT_FOUND)?;
            if !metadata.is_file() {
                return Err(NOT_FOUND);
            }
            let offset = (*offset).min(metadata.len());
            let want = (*length).min(metadata.len() - offset);
            let mut file = std::fs::File::open(&path).map_err(|_| NOT_FOUND)?;
            use std::io::{Read as _, Seek as _, SeekFrom};
            file.seek(SeekFrom::Start(offset)).map_err(|_| INTERNAL)?;
            let mut bytes: Vec<u8> = Vec::new();
            file.take(want)
                .read_to_end(&mut bytes)
                .map_err(|_| INTERNAL)?;
            Ok(json!({
                "ok": true,
                "result": {
                    "path": display,
                    "offset": offset,
                    "bytes": bytes.len(),
                    // Always base64: a range can start and end in the middle of a character, so the
                    // bytes are the answer and the encoding says how to read them.
                    "encoding": "base64",
                    "text": base64::engine::general_purpose::STANDARD.encode(&bytes),
                },
            }))
        }
        // The two paths this application hands to something outside itself. Both are resolved again
        // here, both are put back through the judgement's own brake, and both go through the caller's
        // own effect, so a test proves the gate without a program being launched on the machine
        // running it. The second look is the point: the question can sit on screen for a minute, and
        // the name it was answered about can be a different file (a link to one, a program) by the
        // time the opener is handed it.
        Job::OpenDefault { display } => {
            let path =
                super::files::resolve_file(roots, display, gates::FsMode::Inspect, unrestricted)
                    .map_err(super::files::refusal_of)?;
            if let Some(refusal) = super::files::open_brake(display, &path) {
                return Err(refusal);
            }
            effects.open_default(&path.to_string_lossy())?;
            Ok(json!({ "ok": true, "result": { "path": display } }))
        }
        Job::Reveal { display } => {
            let path =
                super::files::resolve_file(roots, display, gates::FsMode::Inspect, unrestricted)
                    .map_err(super::files::refusal_of)?;
            if let Some(refusal) = super::files::open_brake(display, &path) {
                return Err(refusal);
            }
            // A directory is shown as itself; a file is shown where it lives, because that is what a
            // file manager's window can point at.
            let target = if path.is_dir() {
                path.clone()
            } else {
                path.parent()
                    .map(std::path::Path::to_path_buf)
                    .ok_or(NOT_FOUND)?
            };
            effects.reveal(&target.to_string_lossy())?;
            Ok(json!({ "ok": true, "result": { "path": display } }))
        }
        // One browser verb, on the page this installation owns: the effects hold the service and the
        // key, so no caller here can name another session's browser.
        Job::Browser { request } => Ok(json!({ "ok": true, "result": effects.browser(request)? })),
    }
}

/// When a file was last written, in milliseconds since the epoch.
///
/// `null` rather than a zero when the platform cannot say: a filesystem without the stamp, and a
/// clock set before 1970, are both cases where `0` would read as "written in 1970" - a fact this side
/// does not have. One function for the two answers that carry a stamp (`fs.stat` and `fs.glob`):
/// the walker hands over the platform's own value, and the spelling of it is here.
fn modified_ms(time: std::time::SystemTime) -> Option<u64> {
    time.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

/// One file's bytes, read through the cap rather than after it.
///
/// The size above is the file's size *then*, and a file can grow between that check and this read -
/// by the plugin's own doing, or by anything else on the machine. Reading at most one byte past the
/// cap and refusing the answer is what makes the bound hold for the bytes this process actually
/// holds, which is the bound the caller asked about.
fn read_capped(path: &std::path::Path) -> Result<Vec<u8>, Refusal> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|_| NOT_FOUND)?;
    let mut bytes: Vec<u8> = Vec::new();
    let mut limited = file.take(MAX_READ_BYTES + 1);
    limited.read_to_end(&mut bytes).map_err(|_| INTERNAL)?;
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err(TOO_LARGE);
    }
    Ok(bytes)
}

/// The clipboard's text, with the platform gap answered rather than hidden.
///
/// A build that cannot read the clipboard says so (`unsupported`) instead of handing the plugin an
/// empty string it would take for an empty clipboard, and a clipboard that holds no text *is* an
/// empty answer: the plugin asked what is there, and nothing is. A read that *failed* - the clipboard
/// was held by another process, or its contents are past the cap - is its own answer, because an
/// empty string for a clipboard nobody got to look at is the one outcome a plugin cannot tell apart.
fn clipboard_read() -> Result<Value, Refusal> {
    use crate::services::clipboard::ClipboardText;
    if !crate::services::clipboard::text_supported() {
        return Err(UNSUPPORTED);
    }
    match crate::services::clipboard::text() {
        ClipboardText::Text(text) if text.len() > MAX_CLIPBOARD_BYTES => Err(TOO_LARGE),
        ClipboardText::Text(text) => Ok(json!({ "ok": true, "result": { "text": text } })),
        ClipboardText::Empty => Ok(json!({ "ok": true, "result": { "text": "" } })),
        ClipboardText::TooLarge => Err(TOO_LARGE),
        ClipboardText::Unreadable => Err(INTERNAL),
    }
}

/// Replaces the clipboard's text, reporting a refusal this build's own write could not complete.
fn clipboard_write(text: &str) -> Result<Value, Refusal> {
    if !crate::services::clipboard::text_supported() {
        return Err(UNSUPPORTED);
    }
    if crate::services::clipboard::set_text(text) {
        Ok(json!({ "ok": true }))
    } else {
        Err(INTERNAL)
    }
}

/// Writes one file, through a temporary file beside it and a rename.
///
/// The rename is what makes a write all-or-nothing: a plugin (or this application) that dies mid-write
/// leaves the previous contents in place and a `.tmp` file nobody reads, rather than a half-written
/// file the user would have to notice. The temporary name sits beside the target, so both are on the
/// same filesystem - which is what makes the rename atomic.
fn write_file(target: &std::path::Path, bytes: &[u8]) -> Result<(), Refusal> {
    let Some(parent) = target.parent() else {
        return Err(NOT_FOUND);
    };
    let Some(name) = target.file_name() else {
        return Err(NOT_FOUND);
    };
    let mut temporary = std::ffi::OsString::from(name);
    temporary.push(".omp-write.tmp");
    let temporary = parent.join(temporary);
    std::fs::write(&temporary, bytes).map_err(|_| INTERNAL)?;
    if std::fs::rename(&temporary, target).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err(INTERNAL);
    }
    Ok(())
}

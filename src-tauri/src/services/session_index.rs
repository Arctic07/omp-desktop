//! Read-only projection of the host's session files under `<data_root>/host/sessions`.
//!
//! The engine owns these files: this module only opens them for reading and never writes,
//! truncates or renames anything. A session file (`<timestamp>_<sessionId>.jsonl`) holds a
//! fixed-width title slot on line 1, the header on line 2 and one entry per line after that; the
//! transcript format and the derived label for a blank title slot belong to
//! [`super::session_title`].
//!
//! A session is a transcript written directly into the session store, which mixes the sessions of
//! every workspace: it belongs to a workspace according to the `cwd` in its own header, and to the
//! frontend according to [`host_session_id`], the id the host routes the file by. A subdirectory
//! is not a session: the engine writes the subagents one session spawned into
//! `<sessions>/<session file name without .jsonl>/<ChildName>.jsonl`, beside that session's own
//! transcript, so those files are read by [`children_of`] - for the header that lists them - and
//! never become rows of a workspace.
//!
//! This module owns the file format - what a session file is, how one summary is derived from it
//! as cheaply as its title, status and time allow, and which id it is reported under. The walk
//! over the store's top level lives in [`scan`], one session's subagents in [`children`], the tail
//! window a summary is classed and timed by in [`tail`], and [`list_sessions`] is re-exported from
//! [`scan`] as the entry the commands call.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};

use serde_json::Value;

use crate::{
    models::agent::{SessionColdStatus, SessionSummary},
    services::{
        paths::{normalize_for_compare, plain_path},
        session_title::{clean_title_text, derived_title, head_holds_message, parse_line},
    },
    state::SessionIndexCache,
};

mod children;
mod projection;
mod scan;
mod tail;

pub(crate) use children::children_of;
pub(crate) use projection::{Page, Projection, SearchRow};
pub(crate) use scan::list_sessions;
use tail::{read_tail, tail_facts, TailFacts};

/// Attribution window: the fixed-width title slot (line 1) and the header (line 2) both sit in the
/// first few hundred bytes, so this is the smallest window that can decide whether a candidate
/// belongs to the workspace being scanned. A header naming another workspace is dropped here,
/// without ever paying for the full head window - the common case, since the store mixes the
/// sessions of every workspace and a scan reads one of them.
const HEADER_PROBE_BYTES: usize = 4 * 1024;
/// Head window of a session file: the title slot, the header and the start of the transcript. It is
/// read for every file that belongs to the workspace, because it serves the derived title, and as
/// the fallback for a header the probe cannot see. The window has to hold the *whole* line of
/// the first human prompt, not merely the offset where it starts: a first turn that is a long task
/// description lands in a single JSON line, and the worst case measured here ends at byte 38738
/// (start 26342, a CLI transcript), so 48 KiB leaves about 10 KiB of margin before that line would
/// be cut short, fail to parse and drop the title back to "untitled". The other bound of the same
/// budget is the prompt *start*: a transcript can carry megabytes of preamble, and when the first
/// human prompt begins beyond the window (6 of 931 inspected CLI transcripts start at 278 KiB or
/// later) no label is derived and the session keeps reading as untitled. Both bounds stay inside a
/// single bounded read - transcripts reach several megabytes, so a whole-file read stays off the
/// table.
const HEAD_BYTES: usize = 48 * 1024;

/// How long a candidate that is not there is asked for again, and how long each ask waits.
///
/// The engine publishes a rewritten transcript by renaming a staged copy over it, and Windows
/// refuses that rename while another process holds the destination open - which the scan itself
/// does. The engine's fallback moves the old file aside first and renames the new one in after, so
/// for an instant the transcript does not exist (see the engine's
/// `#replaceSessionFileAfterEpermSync`). A scan that lands in that instant must not answer "this
/// conversation is gone": its row would vanish from the rail while the conversation is still
/// running, and come back at whatever read happens next (2026-10-26, user report). Measured, that
/// instant is two renames and an unlink - microseconds - so a few milliseconds of patience outlast
/// it, while a conversation the reader really deleted costs one scan nothing but these
/// milliseconds. Owner: the reading scan. Bound: `OPEN_ATTEMPTS` pauses of `OPEN_PAUSE`.
const OPEN_ATTEMPTS: u32 = 5;
const OPEN_PAUSE: Duration = Duration::from_millis(2);

/// Opens one candidate for reading, waiting out a rewrite that is publishing over it.
///
/// Only "the file is not there" is waited on: any other failure is an answer the file already gave
/// (a directory where a file should be, a handle the platform refuses), and asking again would not
/// change it. See [`OPEN_ATTEMPTS`] for why the wait exists at all.
pub(super) fn open_settled(path: &Path) -> Option<File> {
    open_settled_within(path, OPEN_ATTEMPTS, OPEN_PAUSE)
}

/// [`open_settled`] with its patience spelled out, so a test does not have to race the constants.
fn open_settled_within(path: &Path, attempts: u32, pause: Duration) -> Option<File> {
    let mut remaining = attempts.max(1);
    loop {
        match File::open(path) {
            Ok(file) => return Some(file),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && remaining > 1 => {
                remaining -= 1;
                std::thread::sleep(pause);
            }
            Err(_) => return None,
        }
    }
}

// The two FNV-1a constants `host/src/store.ts` hashes paths with. Both sides have to agree on the
// digest for a session id to mean the same thing in the sidebar and in the host.
const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

// Head/tail window reads performed by the calling test thread. Counting per thread keeps tests
// that run in parallel from seeing each other's reads - the scan's own tests count on it.
#[cfg(test)]
thread_local! {
    static WINDOW_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(super) fn window_reads() -> usize {
    WINDOW_READS.with(std::cell::Cell::get)
}

#[cfg(test)]
pub(super) fn reset_window_reads() {
    WINDOW_READS.with(|count| count.set(0));
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FileKind {
    /// Live `*.jsonl` transcript.
    Transcript,
    /// `*.jsonl.gz`: the engine's archive form, kept compressed.
    Archived,
    /// `*.jsonl.*.bak`: a rotated copy of a transcript, still plain NDJSON.
    Backup,
}

impl FileKind {
    pub(super) fn archived(self) -> bool {
        matches!(self, Self::Archived)
    }
}

/// Classifies a file name by suffix: `Path::extension` reports `gz` for `*.jsonl.gz` and hides the
/// session kind for `*.jsonl.*.bak`.
pub(super) fn classify(name: &str) -> Option<FileKind> {
    let lower = name.to_ascii_lowercase();
    if lower.len() > ".jsonl.gz".len() && lower.ends_with(".jsonl.gz") {
        Some(FileKind::Archived)
    } else if lower.len() > ".jsonl".len() && lower.ends_with(".jsonl") {
        Some(FileKind::Transcript)
    } else if lower.len() > ".bak".len() && lower.ends_with(".bak") && lower.contains(".jsonl.") {
        Some(FileKind::Backup)
    } else {
        None
    }
}

/// The id the host routes one session file by: `s` followed by FNV-1a 64 over the canonical path
/// of that file, as sixteen lowercase hex digits.
///
/// This is the twin of `host/src/store.ts::sessionIdFor` (over `identityPath`, which is
/// `canonicalSessionPath`): the host mints it for the path a `session_open` resolved, `session_open`
/// and `session_prompt` address a conversation by it, and the frontend keys the streaming state,
/// the active row and the cold-status reads on it. A summary reported under anything else - the
/// engine's own `<uuid>` from the file name or from the header, say - can never be matched to the
/// conversation it describes.
pub(crate) fn host_session_id(path: &Path) -> String {
    format!("s{}", fnv1a64_hex(&canonical_session_path(path)))
}

/// The path spelling the id is taken over, word for word what `canonicalSessionPath` produces:
/// `realpath` when the file is there and the lexical absolute path when it is not; then the
/// Windows verbatim prefix is stripped (`\\?\UNC\server\share` back to `\\server\share`) and the
/// drive letter is upper-cased.
fn canonical_session_path(path: &Path) -> String {
    let resolved = match std::fs::canonicalize(path) {
        Ok(resolved) => resolved.to_string_lossy().into_owned(),
        Err(_) => lexical_absolute(path),
    };
    uppercase_drive_letter(plain_path(&resolved))
}

/// The absolute spelling of a path the filesystem could not resolve: made absolute against the
/// current directory, with `.` and `..` folded the way `path.resolve` folds them, and separators
/// rebuilt in the platform's own form (the components walk drops the caller's spelling).
///
/// Only the fallback of [`canonical_session_path`] needs it, for the file that vanished between
/// being listed and having its id taken.
fn lexical_absolute(path: &Path) -> String {
    let absolute = match path.is_absolute() {
        true => path.to_path_buf(),
        false => std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf()),
    };
    let mut folded = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            // A `..` that follows a real segment climbs back out of it; one that would climb
            // above the root is dropped, exactly as `path.resolve` drops it.
            Component::ParentDir => {
                if matches!(folded.components().next_back(), Some(Component::Normal(_))) {
                    folded.pop();
                }
            }
            component => folded.push(component),
        }
    }
    folded.to_string_lossy().into_owned()
}

/// FNV-1a over the UTF-8 bytes of `text`, as sixteen lowercase hex digits: the digest
/// `store.ts::fnv1a64Hex` mints, which is what makes the ids on both sides agree.
fn fnv1a64_hex(text: &str) -> String {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{hash:016x}")
}

/// The drive letter upper-cased, the last step of `canonicalSessionPath`: `c:\dir` and `C:\dir`
/// name one file and must mint one id. A path without a drive letter comes back unchanged.
fn uppercase_drive_letter(mut path: String) -> String {
    if path.len() >= 2 && path.as_bytes()[1] == b':' && path.as_bytes()[0].is_ascii_lowercase() {
        // The first byte is one ASCII letter, so byte 1 is a character boundary.
        let letter = path[..1].to_ascii_uppercase();
        path.replace_range(..1, &letter);
    }
    path
}

/// Which row a transcript is read into, because the two readers need different proofs and
/// different labels for the same file format.
///
/// A **workspace row** is a session of the list being scanned: it has to name that workspace in its
/// own header, and a transcript the engine never titled is labelled by the first prompt it holds. A
/// **subagent row** is read by path, on behalf of the conversation that spawned it - the parent's
/// own subdirectory is the proof - and is labelled by its file name, because the engine names a
/// subagent's transcript after the subagent and writes no title of its own into it.
#[derive(Clone, Copy)]
pub(super) enum RowKind<'a> {
    Workspace { workspace_root: &'a str },
    Subagent,
}

impl RowKind<'_> {
    /// Whether a transcript whose header names `cwd` is read at all.
    fn admits(&self, cwd: &str) -> bool {
        match self {
            Self::Workspace { workspace_root } => same_workspace(cwd, workspace_root),
            Self::Subagent => true,
        }
    }
}

/// Derives one summary from a session file, read as the kind of row `row` says it is; `None` when
/// the file cannot be read that way - no usable header, or a workspace row whose header names
/// another workspace.
///
/// A file whose size and modification time are unchanged since the cache last saw it is answered
/// from the cache instead of being read back; the engine appends to a live session, which changes
/// both.
pub(super) fn read_summary(
    path: &Path,
    kind: FileKind,
    row: RowKind<'_>,
    cache: &SessionIndexCache,
) -> Option<SessionSummary> {
    let mut file = open_settled(path)?;
    let stat = file_stat(&file);
    if let Some((len, mtime_ms)) = stat {
        if let Some(summary) = cache.reuse(path, len, mtime_ms) {
            // The cache serves every reader while a summary belongs to one: a cached row only
            // answers for a workspace its own header names, which is the same rule the full read
            // applies below - and a subagent's file is only ever read as a subagent's.
            return row.admits(&summary.cwd).then_some(summary);
        }
    }
    // The fallback a transcript that dates nothing is timed by; `updated_at` below is where it is
    // spent.
    let mtime_ms = stat.map_or(0, |(_, mtime_ms)| mtime_ms);
    let (head, header) = read_head(&mut file, row)?;
    // The engine only fills the title slot from its interactive mode and exposes no title command
    // over RPC, so a blank slot means "no title was ever written" rather than "this session has
    // none". Either way the slot holds display text, so it passes the same cleaning a derived label
    // does - the composer's attachment placeholders and invisible characters never reach a row.
    let mut title = clean_title_text(&parse_title(&head));
    if title.is_empty() {
        title = match row {
            // What a conversation the user began holds in its head window is the first prompt
            // they typed, and that is the label a reader recognizes the session by.
            RowKind::Workspace { .. } => derived_title(&head),
            // A subagent's transcript is named after the subagent itself and its title slot is
            // left empty (every child transcript in a live store was written that way), so the
            // file name is the only name the child carries.
            RowKind::Subagent => file_name_title(path),
        };
    }
    // One pass over the tail window answers both facts the summary carries. The row's time is the
    // session's own transcript, not its file: opening a conversation appends the engine's
    // bookkeeping (`session_exit`, model and thinking-level changes), which moves the file's
    // modification time to "now" and would time a session nobody has written in for hours as if it
    // had just been written. Only a window that holds no readable message - an empty transcript, a
    // message too large for the window - falls back to the file, which is then all there is.
    //
    // The header's own stamp is the other half of that reading, and the newer of the two wins: a
    // conversation *copied* from another one (branching at a message, or continuing from an answer)
    // is created now while every message it carries is older, and a row ordered by those messages
    // alone would sort the copy among conversations from days ago instead of putting the one the
    // reader just made at the top.
    let facts = match read_tail(&mut file) {
        Ok(tail) => tail_facts(&tail),
        Err(_) => TailFacts {
            status: SessionColdStatus::Unknown,
            last_message_at: None,
        },
    };
    let updated_at = match facts.last_message_at {
        Some(messages_at) => messages_at.max(header.created_at),
        None => header.created_at.max(mtime_ms),
    };
    let status = facts.status;

    // The emptiness flag is read from the same head window the title comes from, so a row's
    // emptiness costs no second pass over the file - but the window is not the file. It holds a
    // fixed 48 KiB and normally ends inside a line, so "the window holds no message" is not "the
    // file holds no message": a first prompt longer than the window, or a transcript whose
    // preamble pushes that prompt past it, leaves an empty-looking window behind even though the
    // conversation has rows - and a blank row is hidden from every list and offered back to the
    // composer as the next draft. Only a window that reaches the end of the file can answer, and
    // `stat.len()` is the size the file had when it was opened. A file the platform could not
    // stat proves nothing and stays visible.
    let window_holds_whole_file = stat.is_some_and(|(len, _)| len <= head.len() as u64);

    let summary = SessionSummary {
        // What the frontend addresses through `session_open` is the host's id for this file, not
        // the engine's own id in the header - see [`host_session_id`].
        id: host_session_id(path),
        title,
        cwd: header.cwd,
        status,
        updated_at,
        file_path: path.to_string_lossy().into_owned(),
        compressed: kind.archived(),
        // The two flags are the user's decisions, which this module - a read of the session files -
        // knows nothing about: the list command merges them in from the app's store.
        pinned: false,
        archived: false,
        blank: window_holds_whole_file && !head_holds_message(&head),
    };
    if let Some((len, mtime_ms)) = stat {
        cache.store(path, len, mtime_ms, summary.clone());
        // A conversation the list had to read is a conversation whose searchable text may be out of
        // date, because nothing else reads a transcript nobody has opened. Indexing it here keeps
        // the pass where the cost already is - one blocking scan - so a search never has to walk
        // the store, and a file the cache answered for is skipped without a read.
        if matches!(row, RowKind::Workspace { .. }) {
            cache.index_messages(path, len, mtime_ms);
        }
    }
    Some(summary)
}

/// Reads the head of a session file for a row of kind `row`: the bytes the derived title needs,
/// plus the header that decides whether the file is read at all - or `None` when there is no usable
/// header or `row` does not admit the workspace that header names.
///
/// Attribution is settled from the smallest window that can hold the header, so a candidate that
/// belongs elsewhere costs 4 KiB instead of the full head window. Anything the probe cannot judge -
/// a title slot corrupt enough to hide the header behind it - falls back to the full window, the
/// shape every earlier scan accepted. A file shorter than the probe was already read in full.
fn read_head(file: &mut File, row: RowKind<'_>) -> Option<(Vec<u8>, SessionHeader)> {
    let probe = read_window(file, 0, HEADER_PROBE_BYTES).ok()?;
    if let Some(header) = parse_header(&probe) {
        if !row.admits(&header.cwd) {
            return None;
        }
        if probe.len() < HEADER_PROBE_BYTES {
            return Some((probe, header));
        }
    }
    let head = read_window(file, 0, HEAD_BYTES).ok()?;
    let header = parse_header(&head)?;
    row.admits(&header.cwd).then_some((head, header))
}

/// The one spelling this module compares workspaces by: the frontend hands back the registry's
/// root path while a session header carries whatever the engine recorded, and the two can differ
/// in case or prefix form while naming one directory.
fn same_workspace(cwd: &str, workspace_root: &str) -> bool {
    normalize_for_compare(Path::new(cwd)) == normalize_for_compare(Path::new(workspace_root))
}

/// Summary for an archive, whose header stays compressed and unreadable: the workspace comes from
/// the transcript that proves it (see the scan), and the id from the archive's own path, exactly
/// as for a transcript.
pub(super) fn archived_summary(
    path: &Path,
    workspace_root: &str,
    cache: &SessionIndexCache,
) -> Option<SessionSummary> {
    let file = open_settled(path)?;
    let stat = file_stat(&file);
    if let Some((len, mtime_ms)) = stat {
        if let Some(summary) = cache.reuse(path, len, mtime_ms) {
            // The proving sibling - not the archive, which keeps its header compressed - names
            // the workspace this summary was derived for, so a cached entry fits that workspace
            // alone.
            if same_workspace(&summary.cwd, workspace_root) {
                return Some(summary);
            }
        }
    }
    let summary = SessionSummary {
        id: host_session_id(path),
        title: String::new(),
        cwd: workspace_root.to_owned(),
        status: SessionColdStatus::Unknown,
        // The one place the file's modification time still times a row: an archive is a gzip stream
        // and no window of it reads as plain text, so there is no transcript to take a message
        // stamp from - and for an archive the modification time is when the engine compressed it,
        // which nothing the user writes moves.
        updated_at: stat.map_or(0, |(_, mtime_ms)| mtime_ms),
        file_path: path.to_string_lossy().into_owned(),
        compressed: true,
        // A compressed file is not a decision the user made: it was collected by the engine's own
        // tool, and neither flag is this module's to read. The list command merges them in.
        pinned: false,
        archived: false,
        // An archive is not read as a transcript here, so it cannot answer this: a compressed
        // conversation is never a row a list hides as provisional.
        blank: false,
    };
    if let Some((len, mtime_ms)) = stat {
        cache.store(path, len, mtime_ms, summary.clone());
    }
    Some(summary)
}

/// `<timestamp>_<sessionId>.<kind>` -> `<sessionId>`, the engine's own id for a session: it is what
/// the engine writes in the header and into the transcript's file name, and what tells two files
/// apart as the same session (an archive and the transcript it was compressed from). Anything
/// else in the store is not attributable.
pub(super) fn session_id_from_name(name: &str) -> Option<String> {
    let stem = name.split_once(".jsonl").map(|(stem, _)| stem)?;
    let id = stem.rsplit_once('_').map(|(_, id)| id).unwrap_or(stem);
    let looks_like_id = id.len() >= 16
        && id.starts_with(|character: char| character.is_ascii_hexdigit())
        && id
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-');
    looks_like_id.then(|| id.to_owned())
}

/// A session file's name without its session suffix: `<timestamp>_<sessionId>` for a transcript,
/// `FrontendScout` for a subagent's - the engine names those files after the subagent it spawned -
/// and the name of the subdirectory a session's own subagents are written into.
pub(super) fn session_stem(name: &str) -> &str {
    match name.strip_suffix(".jsonl") {
        Some(stem) => stem,
        // An archive (`*.jsonl.gz`) and a rotated copy (`*.jsonl.*.bak`) are session files too, and
        // a name of either kind keeps its own name: only a transcript has this suffix.
        None => name,
    }
}

/// The name an untitled transcript falls back to: its own file name without the session suffix,
/// which is the only label a subagent's transcript carries.
fn file_name_title(path: &Path) -> String {
    let name = path
        .file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
    session_stem(&name).to_owned()
}

/// What a scan needs out of a session header: the workspace the session belongs to, and when the
/// engine wrote the file. The engine's own id in the header is checked for presence - a header
/// without one is not a session header - but never reported: what the frontend addresses is
/// [`host_session_id`].
struct SessionHeader {
    cwd: String,
    /// Unix ms of the moment the engine created this file, from the header's own `timestamp`.
    ///
    /// A conversation that is a *copy* of another one keeps its messages' own times, so the
    /// transcript cannot say when the copy was made: branching a conversation - from a message, or
    /// from an answer - writes a file whose header is stamped now while every message it carries is
    /// older. `0` when the header states no readable time.
    created_at: i64,
}

/// Reads the session header from the bytes of a head window; the engine writes it on line 2, right
/// after the fixed-width title slot.
fn parse_header(bytes: &[u8]) -> Option<SessionHeader> {
    for line in bytes.split(|byte| *byte == b'\n') {
        // The title slot is line 1 and may be corrupt or absent; only a real header ends the scan.
        let entry: Value = match parse_line(line) {
            Some(entry) => entry,
            None => continue,
        };
        if entry.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        let named = entry
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty());
        if !named {
            return None;
        }
        let cwd = entry.get("cwd").and_then(Value::as_str)?;
        let created_at = match entry.get("timestamp") {
            Some(Value::String(text)) => super::runtime::history::iso_to_ms(text),
            Some(Value::Number(number)) => number.as_i64().unwrap_or(0),
            _ => 0,
        };
        return Some(SessionHeader {
            cwd: cwd.to_owned(),
            created_at,
        });
    }
    None
}

/// Reads the title out of the fixed-width first line. A blank or unparsable slot yields an empty
/// title rather than a fabricated label, and the slot text reaches the caller raw: the caller cleans
/// it with `clean_title_text`, because a slot title is display text like a derived one.
fn parse_title(bytes: &[u8]) -> String {
    let Some(entry) = bytes
        .split(|byte| *byte == b'\n')
        .next()
        .and_then(parse_line)
    else {
        return String::new();
    };
    if entry.get("type").and_then(Value::as_str) != Some("title") {
        return String::new();
    }
    match entry.get("title").and_then(Value::as_str) {
        Some(title) => title.to_owned(),
        None => String::new(),
    }
}

/// Reads at most `length` bytes from `offset`. Short reads only happen at end of file.
fn read_window(file: &mut File, offset: u64, length: usize) -> std::io::Result<Vec<u8>> {
    #[cfg(test)]
    WINDOW_READS.with(|count| count.set(count.get() + 1));
    file.seek(SeekFrom::Start(offset))?;
    let mut buffer = vec![0u8; length];
    let mut filled = 0usize;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    buffer.truncate(filled);
    Ok(buffer)
}

/// Size and modification time of an already-open session file, in Unix milliseconds. `None` when
/// the platform cannot report them - the caller then reads the file and keeps it out of the cache,
/// because a summary no fingerprint can invalidate must never be reused.
fn file_stat(file: &File) -> Option<(u64, i64)> {
    let metadata = file.metadata().ok()?;
    let elapsed = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    let mtime_ms = i64::try_from(elapsed.as_millis()).ok()?;
    Some((metadata.len(), mtime_ms))
}

/// Session files and roots for the tests of this module and of [`scan`].
#[cfg(test)]
pub(super) mod fixtures {
    use super::*;

    /// One message entry as the engine writes it, with or without a stop reason.
    pub(super) fn message(role: &str, stop_reason: Option<&str>) -> String {
        message_with_times(role, stop_reason, None, None)
    }

    /// The same entry with the stamps a real one carries: `timestamp`, which the engine writes on
    /// every role, and `completedAt`, which only an assistant turn that finished has. Each comes in
    /// as a raw JSON literal so a test can hand the reader something the engine would never write
    /// (`0`, a string, a negative) and watch it refuse it; `None` leaves the field out.
    pub(super) fn message_with_times(
        role: &str,
        stop_reason: Option<&str>,
        timestamp: Option<&str>,
        completed_at: Option<&str>,
    ) -> String {
        let mut entry = format!("{{\"role\":\"{role}\"");
        if let Some(stop) = stop_reason {
            entry.push_str(&format!(",\"stopReason\":\"{stop}\""));
        }
        if let Some(stamp) = timestamp {
            entry.push_str(&format!(",\"timestamp\":{stamp}"));
        }
        if let Some(stamp) = completed_at {
            entry.push_str(&format!(",\"completedAt\":{stamp}"));
        }
        entry.push('}');
        format!("{{\"type\":\"message\",\"message\":{entry}}}")
    }

    /// Builds a session file: the fixed-width title slot, the header, then one line per entry.
    pub(super) fn session_file(
        id: &str,
        cwd: &str,
        slot_title: &str,
        entries: &[String],
    ) -> Vec<u8> {
        let mut slot = format!(
            "{{\"type\":\"title\",\"v\":1,\"title\":\"{slot_title}\",\"pad\":\"{}\"}}",
            " ".repeat(150)
        );
        slot.truncate(255);
        while slot.len() < 255 {
            slot.push(' ');
        }
        let mut head = format!(
            "{slot}\n{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"cwd\":\"{cwd}\"}}\n"
        );
        for entry in entries {
            head.push_str(entry);
            head.push('\n');
        }
        head.into_bytes()
    }

    /// A *copy* of a conversation, as branching writes one: a header stamped `created_iso` (the
    /// engine's `fork`/`createBranchedSession` write the moment of copying) carrying entries that
    /// are older than it.
    pub(super) fn forked_session_file(
        id: &str,
        cwd: &str,
        slot_title: &str,
        created_iso: &str,
        entries: &[String],
    ) -> Vec<u8> {
        let mut slot = format!(
            "{{\"type\":\"title\",\"v\":1,\"title\":\"{slot_title}\",\"pad\":\"{}\"}}",
            " ".repeat(150)
        );
        slot.truncate(255);
        while slot.len() < 255 {
            slot.push(' ');
        }
        let mut head = format!(
            "{slot}\n{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"cwd\":\"{cwd}\",\"timestamp\":\"{created_iso}\"}}\n"
        );
        for entry in entries {
            head.push_str(entry);
            head.push('\n');
        }
        head.into_bytes()
    }

    /// A Windows path as the JSON string body the engine writes: its separators are escaped
    /// (`"cwd":"C:\\project\\demo"`), so a fixture that reproduces a real header has to write the
    /// doubled form.
    pub(super) fn escaped_path(path: &str) -> String {
        path.replace('\\', "\\\\")
    }

    /// A title slot filled by the engine plus one finished assistant message.
    pub(super) fn transcript_sample(cwd: &str, id: &str) -> Vec<u8> {
        session_file(id, cwd, "hello", &[message("assistant", Some("stop"))])
    }

    /// One human prompt as the engine writes it: a text block plus `attribution: "user"`.
    pub(super) const HUMAN_ENTRY: &str = concat!(
        "{\"type\":\"message\",\"message\":{\"role\":\"user\",",
        "\"content\":[{\"type\":\"text\",\"text\":\"please refactor the session index projection now\"}],",
        "\"attribution\":\"user\"}}"
    );

    /// Writes the given session files directly into a fresh session store: the layout the host
    /// writes, with the files of every workspace side by side.
    pub(super) fn flat_sessions(suffix: &str, files: &[(&str, Vec<u8>)]) -> std::path::PathBuf {
        let root = fresh_store(suffix);
        for (name, bytes) in files {
            std::fs::write(root.join(name), bytes).expect("session file");
        }
        root
    }

    /// A store holding one session file and the subagent directory the engine writes its children
    /// into: `<name>.jsonl` with `<name>/<child>.jsonl` beside it.
    pub(super) fn session_with_children(
        suffix: &str,
        parent: &str,
        parent_bytes: Vec<u8>,
        children: &[(&str, Vec<u8>)],
    ) -> std::path::PathBuf {
        let root = flat_sessions(suffix, &[(parent, parent_bytes)]);
        let directory = root.join(session_stem(parent));
        std::fs::create_dir_all(&directory).expect("child directory");
        for (name, bytes) in children {
            std::fs::write(directory.join(name), bytes).expect("child transcript");
        }
        root
    }

    /// An empty session store of its own for one test.
    pub(super) fn fresh_store(suffix: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("omp-index-{suffix}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("session store");
        root
    }

    /// The first bytes of a gzip stream: enough that no header of the archive reads as plain text,
    /// which is the state an archive is in.
    pub(super) fn gzip_stub() -> Vec<u8> {
        vec![0x1f, 0x8b, 0x08, 0x00, 0x00, 0x01]
    }

    /// Sets a session file's modification time, so an ordering assertion is a fact of the test
    /// rather than of how quickly the files happened to be written.
    pub(super) fn set_mtime(path: &std::path::Path, unix_ms: u64) {
        use std::time::{Duration, UNIX_EPOCH};
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open the session file")
            .set_modified(UNIX_EPOCH + Duration::from_millis(unix_ms))
            .expect("set the modification time");
    }

    /// The summary of the session whose file is the named one, so a test can name a session the
    /// way the store does.
    pub(super) fn summary_of<'a>(sessions: &'a [SessionSummary], name: &str) -> &'a SessionSummary {
        sessions
            .iter()
            .find(|summary| summary.file_path.ends_with(name))
            .unwrap_or_else(|| panic!("{name} is not in the listing"))
    }

    /// One scan with a cache of its own: the tests that predate the cache want the files read.
    pub(super) fn scan(root: &std::path::Path, workspace: &str) -> Vec<SessionSummary> {
        list_sessions(root, workspace, &SessionIndexCache::new())
    }

    /// A transcript of just over 48 KiB: the head window then ends inside the filler prompt, which
    /// is the read every cache miss pays for.
    pub(super) fn large_transcript(id: &str, cwd: &str) -> Vec<u8> {
        let filler = "x".repeat(49 * 1024);
        let prompt = format!(
            "{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\
             \"content\":[{{\"type\":\"text\",\"text\":\"{filler}\"}}],\"attribution\":\"user\"}}}}"
        );
        session_file(id, cwd, "", &[prompt, message("assistant", Some("stop"))])
    }
}

#[cfg(test)]
mod tests {
    use super::FileKind::*;
    use super::*;

    /// The window a scan has to survive: the engine publishes a rewritten transcript by renaming
    /// the old file aside and the new one in, so for an instant the transcript does not exist. A
    /// scan that lands there must answer the conversation's row anyway - the alternative is the
    /// running conversation vanishing from the rail until whatever list read comes next (2026-10-26,
    /// user report) - which is why a missing candidate is asked for again for a moment.
    #[test]
    fn a_transcript_that_is_momentarily_away_is_waited_for() {
        let root = fixtures::fresh_store("settled-open");
        let path = root.join("session.jsonl");
        let published = path.clone();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            std::fs::write(&published, b"{}\n").expect("publish");
        });
        let opened = open_settled_within(&path, 40, Duration::from_millis(2));
        assert!(
            opened.is_some(),
            "the transcript the writer published is opened, not reported as a deleted conversation"
        );
        writer.join().expect("writer");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The other half of the same rule: a conversation that really is gone is answered as gone,
    /// after bounded patience rather than at once.
    #[test]
    fn a_transcript_that_never_returns_is_answered_as_absent() {
        let root = fixtures::fresh_store("settled-gone");
        let started = std::time::Instant::now();
        assert!(
            open_settled_within(&root.join("gone.jsonl"), 3, Duration::from_millis(2)).is_none()
        );
        assert!(
            started.elapsed() >= Duration::from_millis(2),
            "the patience is spent before the answer is 'no such file'"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn classify_uses_the_session_suffix_not_the_extension() {
        assert_eq!(classify("notes.txt"), None);
        assert_eq!(classify(".jsonl"), None);
        assert_eq!(classify("a.jsonl"), Some(Transcript));
        assert_eq!(classify("a.jsonl.gz"), Some(Archived));
        assert_eq!(classify("a.jsonl.2026-09-17.bak"), Some(Backup));
        assert_eq!(classify("a.jsonl.gz").map(FileKind::archived), Some(true));
        assert_eq!(classify("a.jsonl").map(FileKind::archived), Some(false));
    }

    /// The regression this covers: a workspace's composer opens a conversation before the first
    /// message, so a session file can exist that no one ever wrote to. It is the row a list hides
    /// unless it is the one on screen, and telling it apart from a conversation whose rows simply
    /// have not been read yet is the whole point of the flag.
    #[test]
    fn a_transcript_no_one_wrote_to_reads_as_blank() {
        let bookkeeping = concat!(
            "{\"type\":\"title\",\"v\":1,\"title\":\"\",\"pad\":\"\"}\n",
            "{\"type\":\"session\",\"version\":3,\"id\":\"01a0d783\",\"cwd\":\"D:/w\"}\n",
            "{\"type\":\"model_change\",\"model\":\"x\"}\n",
            "{\"type\":\"thinking_level_change\",\"level\":\"high\"}\n"
        );
        assert!(!head_holds_message(bookkeeping.as_bytes()));

        let with_one_message = format!(
            "{bookkeeping}{}\n",
            concat!(
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",",
                "\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}"
            )
        );
        assert!(head_holds_message(with_one_message.as_bytes()));
    }

    /// The window's own limit: it is a fixed 48 KiB and normally ends inside a line, so an
    /// empty-looking window proves nothing about a file that continues past it. A conversation
    /// whose first prompt is longer than the window is a real one - reading it as blank hides its
    /// row from every list and offers its file back to the composer as the next draft, which is
    /// what the rule before this one did.
    #[test]
    fn a_message_the_head_window_cut_short_does_not_read_as_blank() {
        let root = fixtures::fresh_store("blank-window");
        let cache = SessionIndexCache::new();

        let id = "01a0d783-1e76-7000-aeae-aefed618164f";
        let large = fixtures::large_transcript(id, "D:/w");
        assert!(
            large.len() > HEAD_BYTES,
            "the fixture has to outgrow the window"
        );
        assert!(
            !head_holds_message(&large[..HEAD_BYTES]),
            "the window itself holds no parsable message"
        );
        let large_path = root.join(format!("2026-09-22T16-11-49-097Z_{id}.jsonl"));
        std::fs::write(&large_path, &large).expect("session file");
        let row = RowKind::Workspace {
            workspace_root: "D:/w",
        };
        let summary = read_summary(&large_path, Transcript, row, &cache).expect("summary");
        assert!(!summary.blank, "a file with rows is never blank");

        // The other direction stays as it was: a transcript that really holds nothing is blank,
        // and this one is short enough that the window is provably the whole file.
        let empty_id = "01a0d783-1e76-7000-aeae-aefed6181641";
        let empty = fixtures::session_file(empty_id, "D:/w", "", &[]);
        let empty_path = root.join(format!("2026-09-22T16-11-49-098Z_{empty_id}.jsonl"));
        std::fs::write(&empty_path, &empty).expect("empty session file");
        let empty_summary = read_summary(&empty_path, Transcript, row, &cache).expect("summary");
        assert!(empty_summary.blank, "a file with no message is blank");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn header_and_title_are_read_from_the_head_window() {
        let bytes = concat!(
            "{\"type\":\"title\",\"v\":1,\"title\":\"hello\",\"pad\":\"   \"}\n",
            "{\"type\":\"session\",\"version\":3,\"id\":\"01a0a9a0\",\"cwd\":\"D:\\\\project\"}\n"
        )
        .as_bytes();
        assert_eq!(
            parse_header(bytes).map(|h| h.cwd),
            Some("D:\\project".to_owned())
        );
        assert_eq!(parse_title(bytes), "hello");
        // A corrupt title slot must not hide a valid header further down the window.
        let head = b"{broken\n{\"type\":\"session\",\"id\":\"x\",\"cwd\":\"p\"}\n";
        assert_eq!(parse_header(head).map(|h| h.cwd), Some("p".to_owned()));
        // A header without an id or without a cwd cannot be attributed to a workspace, and an
        // empty id is no id at all.
        assert!(parse_header(b"{\"type\":\"session\"}\n").is_none());
        assert!(parse_header(b"{\"type\":\"session\",\"id\":\"x\"}\n").is_none());
        assert!(parse_header(b"{\"type\":\"session\",\"id\":\"\",\"cwd\":\"p\"}\n").is_none());
        assert_eq!(parse_title(b"{not json}\n"), String::new());
    }

    /// The id has to be the one the host routes the file by, not the engine's own id in the header
    /// or in the file name: the frontend matches `session_open`'s answer, the streaming state and
    /// the active row against it.
    #[test]
    fn host_session_id_is_the_host_derivation_over_the_canonical_path() {
        let root = fixtures::fresh_store("identity");
        let file = root.join("2026-09-22T16-11-49-097Z_01a0c9e3-41e8-7000-bc90-195f85789cf1.jsonl");
        std::fs::write(&file, b"{}\n").expect("session file");

        let id = host_session_id(&file);
        assert_eq!(id.len(), 17, "`s` plus sixteen hex digits: {id}");
        assert!(
            id.starts_with('s')
                && id[1..]
                    .chars()
                    .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character)),
            "the id is `s` and lowercase hex: {id}"
        );
        let name = file.file_name().expect("file name");
        let mut spellings = vec![
            // The same path spelled with the other separator, and one that walks out of the store
            // and back in: `realpath` erases both.
            PathBuf::from(file.to_string_lossy().replace('\\', "/")),
            root.join("..")
                .join(root.file_name().expect("root name"))
                .join(name),
        ];
        #[cfg(windows)]
        spellings.push(PathBuf::from(format!(r"\\?\{}", file.display())));
        for spelling in spellings {
            assert_eq!(
                host_session_id(&spelling),
                id,
                "one file, one id: {spelling:?}"
            );
        }

        let other =
            root.join("2026-09-22T16-11-49-097Z_01a0c9e3-41e8-7000-bc90-195f85789cf2.jsonl");
        std::fs::write(&other, b"{}\n").expect("session file");
        assert_ne!(host_session_id(&other), id, "a different file is a session");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The cross-language contract, pinned to what the host's own implementation printed: run
    /// `bun probe-ids.ts <path>` against `host/src/store.ts::sessionIdFor` (which hashes
    /// `identityPath`, i.e. `canonicalSessionPath`) over each path below and it answers with the
    /// id asserted here. A divergence in the hash, in the prefix stripping or in the `..` folding
    /// fails this test instead of silently splitting the sidebar from the host.
    #[test]
    #[cfg(windows)]
    fn host_session_id_matches_the_vectors_the_host_printed() {
        let first = "2026-09-22T16-11-49-097Z_01a0c9e3-41e8-7000-bc90-195f85789cf1.jsonl";
        let second = "2026-09-22T16-11-49-097Z_01a0c9e3-41e8-7000-bc90-195f85789cf2.jsonl";
        for spelling in [
            format!(r"C:\project\team\sessions\{first}"),
            format!("c:/project/team/sessions/{first}"),
            format!(r"\\?\C:\project\team\sessions\{first}"),
            format!(r"C:\project\team\other\..\sessions\{first}"),
        ] {
            assert_eq!(
                host_session_id(Path::new(&spelling)),
                "s02c046856b850333",
                "{spelling}"
            );
        }
        // A UNC path keeps its plain `\\server\share` form: the verbatim spelling the filesystem
        // answers with is stripped before hashing, as `canonicalSessionPath` strips it.
        assert_eq!(
            host_session_id(Path::new(&format!(r"\\server\share\sessions\{first}"))),
            "sa70b6d5a07ed135a"
        );
        assert_eq!(
            host_session_id(Path::new(&format!(
                r"\\?\UNC\server\share\sessions\{first}"
            ))),
            "sa70b6d5a07ed135a"
        );
        // The digest is over the path, so one character of the file name changes the id.
        assert_eq!(
            host_session_id(Path::new(&format!(r"C:\project\team\sessions\{second}"))),
            "sc19233fbbf622eda"
        );
    }
}

//! The application's own log: one file per run under `<data_root>/logs`, next to the host log the
//! engine side keeps in the same directory.
//!
//! The file is for everything the user is never asked about - a reclaimed scratch copy, a custom
//! provider file that could not be converged, a panic - so a failure that only shows as strange
//! behavior still leaves evidence behind. Nothing here can fail a caller: a line that cannot be
//! written is dropped, and an `init` whose file cannot be opened leaves the module silent.

use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::services::runtime::sanitize_message;

/// Name of the log inside the logs directory, and the name a run that overflowed it is moved to
/// when the next run starts. `logs/` also holds the host-side `host.log`, which this module never
/// touches.
pub(crate) const APP_LOG_FILE: &str = "app.log";
const APP_LOG_ROTATED_FILE: &str = "app.log.1";

/// The record the exit path writes, and the one the next start looks for.
///
/// A run whose file does not end with this line did not reach its own exit: a native fault, a kill,
/// or a power loss all look the same from here, and that is still more than no evidence at all.
/// `services::crash` writes its own records for the first case, so the next start can usually say
/// which one it was instead of only that something happened.
pub(crate) const END_RUN_MARKER: &str = "omp: run ended";

/// How much of a previous run's file the start check reads. One record is what it needs, and the
/// records this file carries are one line each; 8 KiB covers several even at their longest.
const PREVIOUS_TAIL_BYTES: u64 = 8 * 1024;

/// How much of that record the start check repeats. A page's stack trace can be a long line, and
/// the line that says "the previous run did not end" is about the fact, not the whole trace.
const PREVIOUS_TAIL_CHARS: usize = 240;

/// Frames kept from a panic's backtrace. Ten is the panic itself and its immediate caller; the
/// remainder is the runtime's own dispatch, which every panic shares.
const BACKTRACE_FRAMES: usize = 10;

/// Ceiling for one run's file. Past it the run writes the one line that says so and stops; the next
/// start rotates the file aside, so the log is bounded without losing the run that filled it.
const APP_LOG_LIMIT_BYTES: u64 = 4 * 1024 * 1024;

/// The process-wide sink. The file's location is known only once the data root is resolved, so the
/// cell is filled by [`init`] rather than by a declaration-time initializer; `get_or_init` is also
/// what makes a repeated `init` a no-op.
static APP_LOG: OnceLock<AppLog> = OnceLock::new();

/// Opens `<logs_dir>/app.log` for this run. Everything logged before the call is dropped, so the
/// caller runs this as soon as the data root exists - the earliest a file can be opened.
///
/// The first line of this run may be about the previous one: a file that does not end with
/// [`END_RUN_MARKER`] says the run before this one never reached its exit. The check reads the file
/// before this run writes into it, so the verdict is about the old content only; a file the rotation
/// just moved to `app.log.1` is read from there.
pub(crate) fn init(logs_dir: &Path) {
    if APP_LOG
        .set(AppLog::new(logs_dir.join(APP_LOG_FILE)))
        .is_err()
    {
        // Already initialized: repeated calls are no-ops, as this module's contract says.
        return;
    }
    if let Some(tail) = previous_run_tail(logs_dir) {
        if !tail.ends_with(END_RUN_MARKER) {
            warn(&format!(
                "omp: previous run did not end cleanly (its last record: {})",
                shorten(tail)
            ));
        }
    }
}

/// The exit path's record. Written even once the file has reached its ceiling: the next start reads
/// this line to tell a clean exit from a death, so it is the one record the cap may not drop.
pub(crate) fn end_run() {
    let Some(log) = APP_LOG.get() else {
        return;
    };
    let line = format_line(Level::Info, END_RUN_MARKER);
    log.append_always(&line);
    #[cfg(debug_assertions)]
    eprintln!("{line}");
}

/// One formatted record at error level, for a caller that appends it itself.
///
/// `services::crash` uses this instead of [`error`]: its record goes through a handle of its own,
/// because the crashing thread may be the one holding this module's mutex.
pub(crate) fn error_record(message: &str) -> String {
    format_line(Level::Error, message)
}

/// The last non-empty record of the previous run's file, whole: the caller's verdict compares it
/// with [`END_RUN_MARKER`], so shortening it there would be a shortened verdict.
///
/// `app.log` first, then the file a rotation moved aside: a run longer than the ceiling leaves this
/// run's `app.log` empty and the previous content in `app.log.1`, and that content is exactly what
/// the check is about.
fn previous_run_tail(logs_dir: &Path) -> Option<String> {
    let live = tail_record(&logs_dir.join(APP_LOG_FILE));
    live.or_else(|| tail_record(&logs_dir.join(APP_LOG_ROTATED_FILE)))
}

/// The last non-empty line of one file, or `None` when it is missing, empty, or unreadable.
fn tail_record(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 {
        return None;
    }
    file.seek(SeekFrom::Start(len.saturating_sub(PREVIOUS_TAIL_BYTES)))
        .ok()?;
    let mut bytes = Vec::new();
    file.take(PREVIOUS_TAIL_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    // The window can start mid-record: only the last complete line matters, and it is the last one.
    let text = String::from_utf8_lossy(&bytes);
    let last = text
        .split('\n')
        .rev()
        .map(|line| line.trim_end_matches('\r').trim())
        .find(|line| !line.is_empty())?;
    Some(last.to_owned())
}

/// One record as a message may repeat it, bounded. Only the presentation shortens; the verdict is
/// made on the whole record.
fn shorten(record: String) -> String {
    if record.chars().count() <= PREVIOUS_TAIL_CHARS {
        return record;
    }
    let mut short: String = record.chars().take(PREVIOUS_TAIL_CHARS).collect();
    short.push('…');
    short
}

/// Truncates this run's file and answers how many bytes it held, or `None` when this run holds no
/// file of its own - before `init`, and after a write failed and closed it.
///
/// In place rather than by deleting the file: the sink holds an open handle to it, and on Windows
/// the delete completes as a shared delete - the name goes away while the handle lives - so every
/// later line of this run would be appended to a file with no name, and `app.log` would only
/// reappear at the next start. Truncating keeps the name and the handle on the same file.
///
/// `None` is what a caller clearing the logs directory needs: the name on disk belongs to nobody
/// then, so it is the caller's to delete. A file this run still writes through has to keep its name
/// even when the truncation itself failed, which is why the two answers are not the same one.
pub(crate) fn reset() -> Option<u64> {
    APP_LOG.get().and_then(AppLog::reset)
}

pub(crate) fn info(message: &str) {
    write(Level::Info, message);
}

pub(crate) fn warn(message: &str) {
    write(Level::Warn, message);
}

pub(crate) fn error(message: &str) {
    write(Level::Error, message);
}

/// Records panics in the same file, location included, so a crash that leaves nothing on screen
/// still says where it happened.
///
/// A debug build keeps the default hook's console output as well - that is where a developer reads
/// a panic - while a release build writes the log line alone: it has no console to print to.
pub(crate) fn panic_hook() {
    #[cfg(debug_assertions)]
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(location_text)
            .unwrap_or_else(|| "unknown location".to_owned());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|text| (*text).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".to_owned());
        // The location is where the panic was raised, which can be a shared helper far from the
        // call that made the state wrong; the stack is what connects the two. It is captured only
        // here, never on a working path.
        error(&format!(
            "panic at {location}: {payload}\n{}",
            backtrace_excerpt()
        ));
        #[cfg(debug_assertions)]
        previous(info);
    }));
}

/// The head of this thread's stack, innermost first, as one block of text.
///
/// `force_capture` ignores `RUST_BACKTRACE`: a release build has no console to ask, and the log is
/// where this belongs. Names come from the build's own PDB where one is present; without it the
/// frames are addresses, which is still where the panic came from.
fn backtrace_excerpt() -> String {
    let stack = std::backtrace::Backtrace::force_capture();
    stack
        .to_string()
        .lines()
        .take(BACKTRACE_FRAMES)
        .collect::<Vec<_>>()
        .join("\n")
}

/// `file:line:column` for the place a panic came from, as one field of the log line.
fn location_text(location: &std::panic::Location<'_>) -> String {
    format!(
        "{}:{}:{}",
        location.file(),
        location.line(),
        location.column()
    )
}

/// Writes one line, and in a debug build echoes it to the console. Before `init` - and when the
/// log file could not be opened - a release build has nowhere to write and stays silent, which is
/// the visibility the app had in that state before this module existed.
fn write(level: Level, message: &str) {
    let line = format_line(level, message);
    if let Some(log) = APP_LOG.get() {
        log.append(&line);
    }
    #[cfg(debug_assertions)]
    eprintln!("{line}");
}

#[derive(Clone, Copy)]
enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

/// One formatted line: the UTC second it was written, its level, and the message after redaction.
/// The redaction lives here rather than at the call sites, so no caller can forget it.
///
/// The message is then made safe to be *one record*. A message is not always text this application
/// composed - a page's stack trace is several lines by construction, and an error can quote a file
/// name or a response body - so:
///
/// - a line break becomes the two characters `\n`, which a reader can still see, because an
///   unescaped one would start a line that nothing stamped: no reader could tell a real record from
///   one a message forged, and a tool counting lines would count lines that are not records;
/// - every other control character is dropped, escape sequences above all. Nothing in a log needs
///   them, and they would reach whatever terminal opens this file as instructions rather than text.
///   A tab is the one that stays, because it separates what a message joined.
fn format_line(level: Level, message: &str) -> String {
    let mut line = format!("{} {} ", timestamp(), level.label());
    push_record_text(&mut line, &sanitize_message(message));
    line.push('\n');
    line
}

/// Appends `text` as part of one record, per [`format_line`]'s rules.
///
/// Shared with the engine log (`runtime::EngineLog`), which writes text this application did not
/// compose - the host's own stderr, escape sequences and all - and needs the same guarantee: one
/// call is one record, and nothing in the file can address the terminal that opens it.
pub(crate) fn push_record_text(line: &mut String, text: &str) {
    for character in text.chars() {
        match character {
            '\n' => line.push_str("\\n"),
            '\r' => line.push_str("\\r"),
            // Line separators are breaks to some readers (Python's `splitlines`, several editors)
            // though not to `char::is_control`, so they are escaped like the breaks they are.
            '\u{2028}' => line.push_str("\\u{2028}"),
            '\u{2029}' => line.push_str("\\u{2029}"),
            // Bidi overrides and isolates reorder what a reader sees without changing the bytes: in
            // a log they only let a message look like something it is not.
            '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' => {}
            // A tab is the one control character that stays: it separates what a message joined and
            // carries no instruction, so dropping it would run two words together for no gain.
            '\t' => line.push('\t'),
            control if control.is_control() => {}
            printable => line.push(printable),
        }
    }
}

/// The one line a run writes when it reaches the cap, so a reader of the file knows what the
/// silence after it means.
fn cap_notice(limit: u64) -> String {
    format!("app log reached its {limit}-byte limit; later lines are dropped until restart")
}

/// Now, as `2026-09-25T20:04:11Z`.
fn timestamp() -> String {
    let since_epoch = SystemTime::now().duration_since(UNIX_EPOCH);
    let seconds = since_epoch.map_or(0, |since| since.as_secs() as i64);
    iso_utc(seconds)
}

/// A UTC stamp for one Unix second, in the fixed shape above. The conversion is Howard Hinnant's
/// `civil_from_days`; a date crate for one line of output is not a dependency this module adds.
pub(crate) fn iso_utc(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let within_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = within_day / 3_600;
    let minute = (within_day % 3_600) / 60;
    let second = within_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Days since 1970-01-01 -> `(year, month, day)`, month 1-12. The shift makes 0000-03-01 the start
/// of an era, so a leap day is the last day of a year and needs no special case.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

struct AppLog {
    /// Held across an append so two threads cannot interleave halves of one line. A poisoned lock
    /// is recovered from rather than propagated: the guard protects a file append, nothing else.
    sink: Mutex<Sink>,
}

impl AppLog {
    fn new(path: PathBuf) -> Self {
        Self {
            sink: Mutex::new(Sink::open(&path)),
        }
    }

    fn append(&self, line: &str) {
        let mut sink = self
            .sink
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sink.append(line);
    }

    /// Writes one record past the ceiling. Only [`end_run`] uses it: the exit marker has to exist
    /// for the next start's check even in a run whose log filled up.
    fn append_always(&self, line: &str) {
        let mut sink = self
            .sink
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sink.append_always(line);
    }

    fn reset(&self) -> Option<u64> {
        let mut sink = self
            .sink
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sink.reset()
    }
}

/// The open file and the budget left in it.
struct Sink {
    file: Option<File>,
    /// Where the file is, kept so a clear can reach it through a handle opened for writing - the
    /// append handle below cannot resize a file on Windows (see [`Sink::reset`]).
    path: PathBuf,
    written: u64,
    limit: u64,
    /// Set once the limit is reached; the run then writes nothing again.
    capped: bool,
}

impl Sink {
    fn open(path: &Path) -> Self {
        Self::open_with_limit(path, APP_LOG_LIMIT_BYTES)
    }

    /// A file a previous run already filled is moved to `app.log.1` (overwriting that run's own
    /// predecessor) before this one starts, so the current log begins at the top. Every step is
    /// best-effort: a rotation that fails leaves the file as it was, and the cap below then keeps
    /// this run from appending to it.
    ///
    /// `limit` is a parameter so a test can reach the cap without writing four megabytes.
    fn open_with_limit(path: &Path, limit: u64) -> Self {
        let filled = std::fs::metadata(path).is_ok_and(|metadata| metadata.len() > limit);
        if filled {
            let rotated = path.with_file_name(APP_LOG_ROTATED_FILE);
            let _ = std::fs::remove_file(&rotated);
            let _ = std::fs::rename(path, &rotated);
        }
        let file = OpenOptions::new().create(true).append(true).open(path).ok();
        let written = file
            .as_ref()
            .and_then(|file| file.metadata().ok())
            .map_or(0, |metadata| metadata.len());
        Self {
            file,
            path: path.to_path_buf(),
            written,
            limit,
            capped: false,
        }
    }

    fn append(&mut self, line: &str) {
        if self.capped {
            return;
        }
        if self.written.saturating_add(line.len() as u64) > self.limit {
            self.capped = true;
            // One line records why the rest of this run is missing; a loop that logs on every
            // iteration cannot use this to fill the disk.
            let notice = format_line(Level::Warn, &cap_notice(self.limit));
            self.write(&notice);
            return;
        }
        self.write(line);
    }

    /// Writes one record regardless of the ceiling, for the exit marker only. `write` is the one
    /// path that touches the handle, so a run whose file failed earlier still stays silent rather
    /// than reopening a file it could not write.
    fn append_always(&mut self, line: &str) {
        self.write(line);
    }

    /// Best-effort append. A failed write drops the line and closes the run's log for good:
    /// repeating a failure the caller can do nothing about is not worth a syscall per line.
    fn write(&mut self, line: &str) {
        let failed = match self.file.as_mut() {
            Some(file) => file.write_all(line.as_bytes()).is_err(),
            None => return,
        };
        if failed {
            self.file = None;
            return;
        }
        self.written += line.len() as u64;
    }

    /// Truncates the file to nothing and answers the bytes it held, or `None` when this sink has no
    /// file - it never opened one, or a failed write closed it.
    ///
    /// A truncation that fails answers `Some(0)` rather than `None`: the handle is still open, so
    /// this run keeps appending through it, and a caller that removed the file would send those
    /// lines somewhere nobody can find them.
    ///
    /// The handle this sink writes through is opened for append alone, which on Windows is
    /// `FILE_APPEND_DATA` without `FILE_WRITE_DATA` and therefore cannot resize the file; the
    /// truncation goes through a second handle opened for writing when that first attempt fails.
    /// Appends land at the end of the file whatever its size, so a handle opened here does not
    /// disturb the one the sink keeps.
    fn reset(&mut self) -> Option<u64> {
        self.file.as_ref()?;
        let truncated = self
            .file
            .as_ref()
            .is_some_and(|file| file.set_len(0).is_ok())
            || OpenOptions::new()
                .write(true)
                .open(&self.path)
                .and_then(|file| file.set_len(0))
                .is_ok();
        if !truncated {
            return Some(0);
        }
        // The cap is reset with the bytes it counted, so the run can fill the file again.
        let freed = self.written;
        self.written = 0;
        self.capped = false;
        Some(freed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory one test alone owns. The module's sink is process-wide, so the tests drive
    /// `Sink` directly and never call `init`.
    fn fresh_logs_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omp-log-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("logs directory");
        dir
    }

    /// The start after a run that filled the log: the filled file has to survive as `app.log.1`,
    /// and the new run has to write into a file of its own.
    #[test]
    fn a_file_a_previous_run_filled_is_rotated_before_the_next_run_writes() {
        let dir = fresh_logs_dir("rotate");
        let path = dir.join(APP_LOG_FILE);
        std::fs::write(&path, "x".repeat(64)).expect("a log a previous run filled");

        // The limit has to sit between one line and the file a previous run left: smaller than the
        // 64 bytes on disk, so this run rotates it aside, and larger than a formatted line, so the
        // first append below is a real line rather than the cap notice.
        let line = format_line(Level::Info, "a line of this run");
        let mut sink = Sink::open_with_limit(&path, line.len() as u64 + 1);

        let rotated_path = dir.join(APP_LOG_ROTATED_FILE);
        let rotated = std::fs::read_to_string(&rotated_path).expect("the rotated log");
        assert_eq!(rotated.len(), 64, "the previous run is kept whole");

        let fresh = std::fs::metadata(&path).expect("the new run's log").len();
        assert_eq!(fresh, 0, "the new run starts at the top");

        sink.append(&line);
        let text = std::fs::read_to_string(&path).expect("read the log");
        assert!(text.ends_with("INFO a line of this run\n"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The cap: one line records the limit, everything after it is dropped, and the run cannot
    /// grow a file it already filled.
    #[test]
    fn a_run_past_its_limit_records_one_notice_and_stops() {
        let dir = fresh_logs_dir("cap");
        let path = dir.join(APP_LOG_FILE);
        let mut sink = Sink::open_with_limit(&path, 256);

        for index in 0..64 {
            sink.append(&format_line(Level::Info, &format!("line {index}")));
        }

        assert!(sink.capped, "the run must stop at the limit");
        let text = std::fs::read_to_string(&path).expect("read the log");
        assert!(text.contains("INFO line 0\n"), "{text}");
        let notices = text.matches("reached its 256-byte limit").count();
        assert_eq!(notices, 1, "{text}");

        let settled = std::fs::metadata(&path).expect("the log").len();
        sink.append(&format_line(Level::Error, "written after the cap"));
        assert_eq!(std::fs::metadata(&path).expect("the log").len(), settled);
        let after = std::fs::read_to_string(&path).expect("read the log");
        assert!(!after.contains("written after the cap"), "{after}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A clear truncates the run's file where it stands: the name stays, the size goes to zero, and
    /// the run keeps writing into it afterwards - including a run that had already reached its cap,
    /// which the clear resets along with the bytes it counted.
    #[test]
    fn a_clear_truncates_the_run_log_and_lets_it_write_again() {
        let dir = fresh_logs_dir("reset");
        let path = dir.join(APP_LOG_FILE);
        let mut sink = Sink::open_with_limit(&path, 256);

        for index in 0..64 {
            sink.append(&format_line(Level::Info, &format!("line {index}")));
        }
        assert!(sink.capped, "the run must reach its cap before the clear");
        let filled = std::fs::metadata(&path).expect("the log").len();
        assert!(filled > 0);

        assert_eq!(
            sink.reset(),
            Some(filled),
            "the clear frees what the file held"
        );
        assert_eq!(std::fs::metadata(&path).expect("the log").len(), 0);
        assert!(!sink.capped, "the cap goes with the bytes it counted");

        sink.append(&format_line(Level::Info, "after the clear"));
        let text = std::fs::read_to_string(&path).expect("read the log");
        assert!(text.ends_with("INFO after the clear\n"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A sink with no file has nothing to truncate and says so, rather than reporting a clear that
    /// never happened: `None` is what tells a caller the name on disk is nobody's to keep.
    #[test]
    fn a_sink_without_a_file_frees_nothing() {
        let dir = fresh_logs_dir("reset-none");
        // A file inside a directory that does not exist is one this cannot open, on either
        // platform, whatever the platform says about the directory above it.
        let mut sink = Sink::open_with_limit(&dir.join("absent").join(APP_LOG_FILE), 256);
        assert!(sink.file.is_none(), "nothing was opened to truncate");
        assert_eq!(sink.reset(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A message that carries a line break still becomes one record, and one that carries an escape
    /// sequence carries none of it: a page's stack trace cannot turn into lines that look stamped
    /// and real, and nothing in the file can address the terminal that opens it.
    #[test]
    fn a_message_that_carries_a_line_break_stays_one_record() {
        let forged = "first\n2026-01-01T00:00:00Z ERROR forged by a message";
        let line = format_line(Level::Info, forged);

        assert_eq!(line.matches('\n').count(), 1, "{line}");
        assert!(
            line.ends_with("INFO first\\n2026-01-01T00:00:00Z ERROR forged by a message\n"),
            "{line}"
        );

        let windows_break = format_line(Level::Warn, "one\r\ntwo");
        assert_eq!(windows_break.matches('\n').count(), 1, "{windows_break}");
        assert!(
            windows_break.ends_with("WARN one\\r\\ntwo\n"),
            "{windows_break}"
        );

        let escapes = format_line(Level::Error, "red\u{1b}[31m and a bell\u{7}\u{0}");
        assert!(escapes.ends_with("ERROR red[31m and a bell\n"), "{escapes}");

        // The one control character that stays, because it separates what the message joined.
        let columns = format_line(Level::Info, "name\tsize");
        assert!(columns.ends_with("INFO name\tsize\n"), "{columns}");

        // A line separator is a break to some readers though not to `char::is_control`.
        let separator = format_line(Level::Info, "one\u{2028}two");
        assert_eq!(separator.matches('\n').count(), 1, "{separator}");
        assert!(separator.ends_with("INFO one\\u{2028}two\n"), "{separator}");
    }

    /// The line's shape and its redaction: the stamp must be the UTC one the format promises, and
    /// a message that looks like a credential must not reach the file.
    #[test]
    fn a_line_is_stamped_and_redacted() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(1_709_164_800), "2024-02-29T00:00:00Z");

        let secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        let line = format_line(Level::Error, &format!("the provider rejected {secret}"));
        assert!(!line.contains(secret), "{line}");
        assert!(
            line.ends_with("ERROR the provider rejected <redacted>\n"),
            "{line}"
        );
    }

    /// The start check reads the record the previous run left behind: the exit marker means it
    /// closed, anything else means it did not, and a file the rotation moved aside is read when
    /// this run's own file is empty.
    #[test]
    fn the_previous_run_is_judged_by_its_last_record() {
        let dir = fresh_logs_dir("previous");
        std::fs::write(
            dir.join(APP_LOG_FILE),
            format!(
                "{}INFO omp: run started\n{}",
                format_line(Level::Info, "first"),
                format_line(Level::Info, END_RUN_MARKER)
            ),
        )
        .expect("a run that closed");

        let clean = previous_run_tail(&dir).expect("the last record");
        assert!(clean.ends_with(END_RUN_MARKER), "{clean}");

        std::fs::write(
            dir.join(APP_LOG_FILE),
            format!(
                "{}ERROR omp: fatal exception 0xC0000005 at x\n",
                format_line(Level::Info, "first")
            ),
        )
        .expect("a run that died");

        let died = previous_run_tail(&dir).expect("the last record");
        assert!(!died.ends_with(END_RUN_MARKER), "{died}");
        assert!(died.contains("fatal exception"), "{died}");

        // A run that overflowed the file was rotated aside: its verdict comes from `app.log.1`.
        std::fs::write(dir.join(APP_LOG_FILE), "").expect("an empty new run");
        std::fs::write(
            dir.join(APP_LOG_ROTATED_FILE),
            format_line(Level::Info, "older run, unclosed"),
        )
        .expect("the rotated file");
        let rotated = previous_run_tail(&dir).expect("the rotated record");
        assert!(rotated.contains("older run, unclosed"), "{rotated}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Nothing to judge is not an unclean death: a first run, an empty directory, and an empty
    /// pair of files all answer `None`.
    #[test]
    fn a_first_run_has_no_previous_verdict() {
        let dir = fresh_logs_dir("first");
        assert_eq!(previous_run_tail(&dir), None, "no file at all");
        std::fs::write(dir.join(APP_LOG_FILE), "").expect("an empty log");
        assert_eq!(previous_run_tail(&dir), None, "an empty log");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The exit marker is not subject to the ceiling: a run that filled the file still says it
    /// closed, so the next start does not report a clean exit as a death.
    #[test]
    fn the_exit_marker_survives_the_cap() {
        let dir = fresh_logs_dir("exit-cap");
        let path = dir.join(APP_LOG_FILE);
        let mut sink = Sink::open_with_limit(&path, 128);
        for index in 0..64 {
            sink.append(&format_line(Level::Info, &format!("line {index}")));
        }
        assert!(sink.capped);

        sink.append_always(&format_line(Level::Info, END_RUN_MARKER));
        let text = std::fs::read_to_string(&path).expect("read the log");
        assert!(
            text.ends_with(&format!("INFO {END_RUN_MARKER}\n")),
            "{text}"
        );
        assert!(previous_run_tail(&dir).is_some_and(|tail| tail.ends_with(END_RUN_MARKER)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A panic's record carries a stack, cut to the frames that name the panic and its caller.
    #[test]
    fn a_panic_record_carries_the_head_of_its_stack() {
        let excerpt = backtrace_excerpt();
        assert!(!excerpt.trim().is_empty(), "a captured stack is not empty");
        assert!(
            excerpt.lines().count() <= BACKTRACE_FRAMES,
            "at most {BACKTRACE_FRAMES} frames: {excerpt}"
        );
    }
}

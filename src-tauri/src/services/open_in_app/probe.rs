//! The machine facts the open-in-app resolver probes: `${VAR}` expansion, executable lookup,
//! the Windows registry view (registered executables and uninstall records), and XDG desktop
//! entries. Everything here is read-only and bounded; nothing in this module launches anything.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

/// Deadline for one probe command (`reg.exe`, `xcode-select`): a failure bound, not a latency
/// budget - the same conservative 10 s the example project ships.
pub(super) const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Ceiling on one probe command's stdout. A registry dump is text, and a machine with many
/// installed programs makes a large one; anything past this is not a dump this resolver is willing
/// to parse, and the command is killed rather than buffered.
const PROBE_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

/// How often a bounded command is checked for its exit while it runs.
const PROBE_POLL: Duration = Duration::from_millis(25);

/// macOS application directories the bundle locator checks, in order.
pub(super) fn application_roots() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = home_dir() {
        roots.push(home.join("Applications"));
    }
    roots
}

/// The user's home directory, as `~` in a candidate resolves against it.
pub(super) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

/// Expand `${VAR}` references and a leading `~/` in one candidate template.
///
/// Expansion is string substitution: a candidate keeps its template's `/` separators after the
/// expanded prefix, which the Windows path APIs accept. A reference to a variable this machine
/// does not set makes the whole candidate unusable, and `None` says so rather than producing a
/// path that cannot exist.
pub(super) fn expand(template: &str) -> Option<PathBuf> {
    let expanded = expand_env(template)?;
    if let Some(rest) = expanded.strip_prefix("~/") {
        return Some(home_dir()?.join(rest));
    }
    Some(PathBuf::from(expanded))
}

/// `${VAR}` substitution over one template; `None` when a referenced variable is unset.
fn expand_env(template: &str) -> Option<String> {
    let mut out = String::with_capacity(template.len());
    let mut index = 0;
    while index < template.len() {
        let rest = &template[index..];
        if let Some(after) = rest.strip_prefix("${") {
            let end = after.find('}')?;
            out.push_str(&std::env::var(&after[..end]).ok()?);
            index += 2 + end + 1;
            continue;
        }
        let character = rest.chars().next()?;
        out.push(character);
        index += character.len_utf8();
    }
    Some(out)
}

/// `%VAR%` substitution over one registry value; `None` when a referenced variable is unset.
fn expand_registry_value(value: &str) -> Option<String> {
    let mut out = String::with_capacity(value.len());
    let mut index = 0;
    while index < value.len() {
        let rest = &value[index..];
        if let Some(after) = rest.strip_prefix('%') {
            let end = after.find('%')?;
            out.push_str(&std::env::var(&after[..end]).ok()?);
            index += 1 + end + 1;
            continue;
        }
        let character = rest.chars().next()?;
        out.push(character);
        index += character.len_utf8();
    }
    Some(out)
}

/// Whether `path` is an existing regular file.
pub(super) fn is_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

/// Whether `path` is an existing directory.
pub(super) fn is_dir(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
}

/// Resolve one bare command name against `PATH` (and, on Windows, `PATHEXT`).
pub(super) fn resolve_executable(name: &str) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    let direct = Path::new(name);
    if direct.is_absolute() {
        return is_file(direct).then(|| direct.to_path_buf());
    }
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        if directory.as_os_str().is_empty() {
            continue;
        }
        #[cfg(windows)]
        {
            for extension in executable_extensions() {
                let candidate = directory.join(format!("{name}{extension}"));
                if is_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
        #[cfg(not(windows))]
        {
            let candidate = directory.join(name);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// `PATHEXT` entries to try after a bare name, the name itself first.
#[cfg(windows)]
fn executable_extensions() -> Vec<String> {
    let mut extensions = vec![String::new()];
    match std::env::var("PATHEXT") {
        Ok(value) => {
            extensions.extend(
                value
                    .split(';')
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty())
                    .map(str::to_lowercase),
            );
        }
        Err(_) => extensions.extend([".com", ".exe", ".bat", ".cmd"].map(str::to_owned)),
    }
    extensions
}

/// Whether `path` is a file the shell would run: a regular file with an execute bit.
#[cfg(not(windows))]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Run one probe command with a deadline and an output ceiling.
///
/// The window is the point: `reg.exe` is fast, but a machine that answers nothing at all must not
/// hold a resolution pass open forever. A command that outlives the deadline is killed, and a
/// command whose output passes the ceiling is killed rather than buffered whole.
pub(super) fn run_bounded(
    program: &str,
    args: &[&str],
    timeout: Duration,
    limit: usize,
) -> Option<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // A console child of a windowed process would flash a console window of its own.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let overflow = Arc::new(AtomicBool::new(false));
    let reader_overflow = Arc::clone(&overflow);
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    if bytes.len() + read > limit {
                        reader_overflow.store(true, Ordering::Relaxed);
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..read]);
                }
                Err(_) => break,
            }
        }
        bytes
    });
    let deadline = Instant::now() + timeout;
    let mut status = None;
    loop {
        if overflow.load(Ordering::Relaxed) {
            let _ = child.kill();
            break;
        }
        match child.try_wait() {
            Ok(Some(exited)) => {
                status = Some(exited);
                break;
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(PROBE_POLL),
            _ => {
                let _ = child.kill();
                break;
            }
        }
    }
    let bytes = reader.join().unwrap_or_default();
    status
        .filter(|exited| exited.success())
        .map(|_| String::from_utf8_lossy(&bytes).into_owned())
}

/// One extracted icon: the bytes, and the media type a `data:` URL carries them under.
pub(super) struct IconData {
    pub(super) bytes: Vec<u8>,
    pub(super) mime: &'static str,
}

/// One Windows Uninstall record's fields relevant to launcher derivation.
pub(super) struct InstallRecord {
    pub(super) display_name: String,
    pub(super) install_location: Option<String>,
    pub(super) display_icon: Option<String>,
}

/// The Windows registry facts one resolution pass reads at most once.
pub(super) struct RegistryView {
    /// Lower-cased registered executable name to its `App Paths` default value.
    pub(super) app_paths: HashMap<String, PathBuf>,
    pub(super) install_records: Vec<InstallRecord>,
}

/// `App Paths` roots, user hive first (per-user installs shadow machine ones).
const APP_PATHS_ROOTS: &[&str] = &[
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
];

/// Uninstall-record roots: user hive, 64-bit machine hive, 32-bit machine view.
const UNINSTALL_ROOTS: &[&str] = &[
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

/// Read the registry facts for one resolution pass: one `reg.exe query /s` per root, and a root
/// that fails or is absent contributes nothing.
///
/// Every root is queried - and its dump parsed - on a thread of its own: the two machine hives
/// hold far more than the user one, so a serial read makes the view cost the sum of the roots
/// while a resolution pass only ever waits for the slowest. Merging then happens back on the
/// calling thread in root declaration order, which is what keeps a per-user registration ahead of
/// a machine-wide one.
pub(super) fn read_registry_view() -> RegistryView {
    thread::scope(|scope| {
        let app_paths: Vec<_> = APP_PATHS_ROOTS
            .iter()
            .map(|&root| scope.spawn(move || query_root(root, app_paths_from_dump)))
            .collect();
        let install_records: Vec<_> = UNINSTALL_ROOTS
            .iter()
            .map(|&root| scope.spawn(move || query_root(root, install_records_from_dump)))
            .collect();
        RegistryView {
            app_paths: merge_app_paths(app_paths.into_iter().map(joined_root).collect()),
            install_records: merge_install_records(
                install_records.into_iter().map(joined_root).collect(),
            ),
        }
    })
}

/// Query one registry root and parse its dump on this thread: `None` when the root fails or is
/// absent.
fn query_root<T>(root: &str, parse: fn(&str) -> T) -> Option<T> {
    run_bounded(
        "reg.exe",
        &["query", root, "/s"],
        PROBE_TIMEOUT,
        PROBE_OUTPUT_LIMIT,
    )
    .map(|dump| parse(&dump))
}

/// What one root's thread contributes: a parse that panicked counts as a root with nothing to say
/// rather than taking the resolution pass down with it, because a probe failing is not a failure
/// of the session that asked for it.
fn joined_root<T>(handle: thread::ScopedJoinHandle<'_, Option<T>>) -> Option<T> {
    handle.join().ok().flatten()
}

/// The `App Paths` registrations one root's dump carries: lower-cased executable name to its
/// registered target, keeping the first entry for an executable the dump names more than once.
fn app_paths_from_dump(dump: &str) -> HashMap<String, PathBuf> {
    let mut registered = HashMap::new();
    for (key, values) in parse_registry_dump(dump) {
        let leaf = match key.rsplit_once('\\') {
            Some((_, leaf)) => leaf,
            None => key.as_str(),
        };
        let exe = leaf.to_lowercase();
        if !exe.ends_with(".exe") || registered.contains_key(&exe) {
            continue;
        }
        let Some(target) = values.get("(Default)") else {
            continue;
        };
        let trimmed = target.trim().trim_matches('"');
        if let Some(expanded) = expand_registry_value(trimmed) {
            registered.insert(exe, PathBuf::from(expanded));
        }
    }
    registered
}

/// The Uninstall records one root's dump carries, in the order the parsed keys yield them.
fn install_records_from_dump(dump: &str) -> Vec<InstallRecord> {
    let mut records = Vec::new();
    for values in parse_registry_dump(dump).values() {
        let Some(display_name) = values.get("DisplayName") else {
            continue;
        };
        records.push(InstallRecord {
            display_name: display_name.clone(),
            install_location: values.get("InstallLocation").cloned(),
            display_icon: values.get("DisplayIcon").cloned(),
        });
    }
    records
}

/// Merge the per-root `App Paths` registrations in root declaration order: the first root to
/// register an executable keeps it, so a per-user registration shadows a machine-wide one.
fn merge_app_paths(roots: Vec<Option<HashMap<String, PathBuf>>>) -> HashMap<String, PathBuf> {
    let mut merged = HashMap::new();
    for registered in roots.into_iter().flatten() {
        for (exe, target) in registered {
            merged.entry(exe).or_insert(target);
        }
    }
    merged
}

/// Merge the per-root Uninstall records in root declaration order: the user hive's records first,
/// then the machine hives'.
fn merge_install_records(roots: Vec<Option<Vec<InstallRecord>>>) -> Vec<InstallRecord> {
    let total = roots.iter().flatten().map(Vec::len).sum();
    let mut merged = Vec::with_capacity(total);
    for records in roots.into_iter().flatten() {
        merged.extend(records);
    }
    merged
}

/// Parse `reg.exe query <root> /s` output into per-subkey string values.
///
/// `reg.exe` prints one key path line per subkey followed by indented value lines; the value's
/// name and data are told from the type token, because the default-value marker localizes
/// (`(Default)`, `(默认)`) and the columns are otherwise only whitespace-separated.
pub(super) fn parse_registry_dump(dump: &str) -> HashMap<String, HashMap<String, String>> {
    let mut keys: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut current: Option<String> = None;
    for line in dump.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.starts_with("HK") {
            let key = line.trim().to_owned();
            keys.entry(key.clone()).or_default();
            current = Some(key);
            continue;
        }
        let Some(values) = current.as_deref().and_then(|key| keys.get_mut(key)) else {
            continue;
        };
        let Some((name, data)) = parse_value_line(line) else {
            continue;
        };
        // Every locale wraps the default-value marker in parentheses.
        let name = if name.starts_with('(') && name.ends_with(')') {
            "(Default)".to_owned()
        } else {
            name
        };
        values.insert(name, data);
    }
    keys
}

/// One `reg.exe` value line as `(name, data)`: an indented line whose columns are separated by the
/// `REG_SZ` / `REG_EXPAND_SZ` type token. Other types are not values the catalog reads.
fn parse_value_line(line: &str) -> Option<(String, String)> {
    if !line.starts_with(' ') && !line.starts_with('\t') {
        return None;
    }
    for (index, _) in line.match_indices("REG_") {
        let rest = &line[index..];
        for token in ["REG_EXPAND_SZ", "REG_SZ"] {
            let Some(after) = rest.strip_prefix(token) else {
                continue;
            };
            let separated = line[..index]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
            if !separated || !(after.is_empty() || after.starts_with(char::is_whitespace)) {
                continue;
            }
            let name = line[..index].trim();
            if name.is_empty() {
                return None;
            }
            return Some((name.to_owned(), after.trim().to_owned()));
        }
    }
    None
}

/// The executable one Uninstall record proves, or `None` when it proves none.
///
/// The record's `InstallLocation` plus the entry's relative launcher is the exact path an
/// installer recorded; a record without one falls back to its `DisplayIcon`, which carries the
/// executable (sometimes with a `,<index>` suffix) of whatever the installer registered.
pub(super) fn record_launcher(
    record: &InstallRecord,
    relative_launcher: Option<&str>,
) -> Option<PathBuf> {
    if let (Some(relative), Some(location)) =
        (relative_launcher, record.install_location.as_deref())
    {
        if !location.is_empty() {
            let trimmed = location.trim().trim_matches('"');
            if let Some(expanded) = expand_registry_value(trimmed) {
                let candidate = Path::new(&expanded).join(relative);
                if is_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    let display_icon = record.display_icon.as_deref()?;
    let bare = match display_icon.rfind(',') {
        // `,<index>` names an icon inside the executable, not part of its path.
        Some(index)
            if display_icon[index + 1..]
                .trim_start_matches('-')
                .chars()
                .all(|character| character.is_ascii_digit()) =>
        {
            &display_icon[..index]
        }
        _ => display_icon,
    };
    let trimmed = bare.trim().trim_matches('"').trim();
    let expanded = expand_registry_value(trimmed)?;
    if !expanded.to_lowercase().ends_with(".exe") {
        return None;
    }
    let path = PathBuf::from(expanded);
    is_file(&path).then_some(path)
}

/// Fields of one parsed XDG desktop entry this resolver reads.
pub(super) struct DesktopEntry {
    pub(super) exec: Option<String>,
    pub(super) try_exec: Option<String>,
    pub(super) icon: Option<String>,
}

/// Parse the `[Desktop Entry]` section's `Exec`/`TryExec`/`Icon` keys.
pub(super) fn parse_desktop_entry(text: &str) -> DesktopEntry {
    let mut entry = DesktopEntry {
        exec: None,
        try_exec: None,
        icon: None,
    };
    let mut in_entry = false;
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_entry = trimmed == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        match key {
            "Exec" => entry.exec = Some(value.to_owned()),
            "TryExec" => entry.try_exec = Some(value.to_owned()),
            "Icon" => entry.icon = Some(value.to_owned()),
            _ => {}
        }
    }
    entry
}

/// XDG data directories in precedence order (`XDG_DATA_HOME`, then `XDG_DATA_DIRS`).
pub(super) fn xdg_data_dirs() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".local/share")));
    if let Some(data_home) = data_home {
        directories.push(data_home);
    }
    let data_dirs =
        std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".to_owned());
    directories.extend(
        data_dirs
            .split(':')
            .filter(|directory| !directory.is_empty())
            .map(PathBuf::from),
    );
    directories
}

/// Read one desktop entry by id from the XDG application directories.
pub(super) fn find_desktop_entry(desktop_id: &str) -> Option<DesktopEntry> {
    for directory in xdg_data_dirs() {
        let path = directory
            .join("applications")
            .join(format!("{desktop_id}.desktop"));
        if let Ok(text) = std::fs::read_to_string(&path) {
            return Some(parse_desktop_entry(&text));
        }
    }
    None
}

/// First token of an `Exec=` value: the quoted path, or the run up to whitespace.
pub(super) fn exec_command(exec: &str) -> Option<&str> {
    let trimmed = exec.trim();
    if let Some(rest) = trimmed.strip_prefix('"') {
        return rest.split('"').next().filter(|value| !value.is_empty());
    }
    trimmed.split_whitespace().next()
}

/// The executable one desktop entry proves: a `TryExec` when it carries one, otherwise `Exec`'s
/// first token. An absolute path verifies on disk; a bare name resolves against `PATH`.
pub(super) fn desktop_launcher(entry: &DesktopEntry) -> Option<PathBuf> {
    let candidate = entry
        .try_exec
        .as_deref()
        .or_else(|| entry.exec.as_deref().and_then(exec_command))?;
    if candidate.is_empty() {
        return None;
    }
    if Path::new(candidate).is_absolute() {
        return is_file(Path::new(candidate)).then(|| PathBuf::from(candidate));
    }
    resolve_executable(candidate)
}

/// Version-named directory names, newest first (`2024.1.10` outranks `2024.1.9`), keeping only
/// the ones carrying `prefix`.
pub(super) fn newest_first(names: Vec<String>, prefix: &str) -> Vec<String> {
    let mut matching: Vec<String> = names
        .into_iter()
        .filter(|name| name.starts_with(prefix))
        .collect();
    matching.sort_by(|left, right| natural_cmp(right, left));
    matching
}

/// Numeric-aware string comparison, so a version suffix orders by its numbers rather than by its
/// digits' byte values: plain lexical order puts `2024.1.9` after `2024.1.10`, which is backwards
/// for the versioned install directories an IDE leaves behind.
fn natural_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let left_runs = runs(left);
    let right_runs = runs(right);
    for (left_run, right_run) in left_runs.iter().zip(right_runs.iter()) {
        let ordering = match (left_run.numeric, right_run.numeric) {
            (true, true) => {
                let left_digits = left_run.text.trim_start_matches('0');
                let right_digits = right_run.text.trim_start_matches('0');
                left_digits
                    .len()
                    .cmp(&right_digits.len())
                    .then_with(|| left_digits.cmp(right_digits))
                    .then_with(|| left_run.text.len().cmp(&right_run.text.len()))
            }
            _ => left_run.text.cmp(right_run.text),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    left_runs.len().cmp(&right_runs.len())
}

/// One run of a string: maximal digits, or maximal everything else.
struct Run<'a> {
    text: &'a str,
    numeric: bool,
}

/// Split a string into alternating digit and non-digit runs.
fn runs(value: &str) -> Vec<Run<'_>> {
    let mut runs: Vec<Run<'_>> = Vec::new();
    let mut start = 0;
    let mut numeric: Option<bool> = None;
    for (index, character) in value.char_indices() {
        let is_digit = character.is_ascii_digit();
        match numeric {
            None => numeric = Some(is_digit),
            Some(current) if current != is_digit => {
                runs.push(Run {
                    text: &value[start..index],
                    numeric: current,
                });
                start = index;
                numeric = Some(is_digit);
            }
            Some(_) => {}
        }
    }
    if start < value.len() {
        runs.push(Run {
            text: &value[start..],
            numeric: numeric.unwrap_or(false),
        });
    }
    runs
}

/// Run one command with a deadline and return its stdout, or `None` on any failure.
pub(super) fn probe_output(program: &str, args: &[&str]) -> Option<String> {
    run_bounded(program, args, PROBE_TIMEOUT, PROBE_OUTPUT_LIMIT)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        app_paths_from_dump, install_records_from_dump, merge_app_paths, merge_install_records,
        natural_cmp, parse_desktop_entry, parse_registry_dump,
    };

    /// `reg.exe /s` output is parsed by the type token, not by column offsets: names carry
    /// spaces and the default marker is localized, so both have to survive the read.
    #[test]
    fn a_registry_dump_splits_keys_and_values() {
        let dump = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe\r\n    (Default)    REG_SZ    C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe\r\n\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1\r\n    DisplayName    REG_SZ    Git version 2.45.1\r\n    InstallLocation    REG_EXPAND_SZ    %ProgramFiles%\\Git\r\n    NoModify    REG_DWORD    0x1\r\n";
        let keys = parse_registry_dump(dump);
        let app_paths = &keys["HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe"];
        assert_eq!(
            app_paths["(Default)"],
            "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe"
        );
        let record = &keys["HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1"];
        assert_eq!(record["DisplayName"], "Git version 2.45.1");
        assert_eq!(record["InstallLocation"], "%ProgramFiles%\\Git");
        // A value type the catalog never reads is not a value it keeps.
        assert!(!record.contains_key("NoModify"));
    }

    /// The desktop entry reader takes the three keys it needs and ignores the rest of the file.
    #[test]
    fn a_desktop_entry_keeps_the_keys_the_launcher_needs() {
        let text = "[Desktop Entry]\nType=Application\nName=Zed\nExec=/usr/bin/zed %U\nTryExec=/usr/bin/zed\nIcon=dev.zed.Zed\n\n[Desktop Action New]\nExec=/usr/bin/zed --new\nIcon=ignored\n";
        let entry = parse_desktop_entry(text);
        assert_eq!(entry.exec.as_deref(), Some("/usr/bin/zed %U"));
        assert_eq!(entry.try_exec.as_deref(), Some("/usr/bin/zed"));
        assert_eq!(entry.icon.as_deref(), Some("dev.zed.Zed"));
    }

    /// Version directories order by their numbers, which is what picks the newest install.
    #[test]
    fn version_names_order_numerically() {
        assert_eq!(
            natural_cmp("2024.1.10", "2024.1.9"),
            std::cmp::Ordering::Greater
        );
        assert_eq!(
            natural_cmp("app-3.4.2", "app-3.10.1"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            natural_cmp("PyCharm2024.1", "PyCharm2024.1"),
            std::cmp::Ordering::Equal
        );
    }

    /// `App Paths` roots merge in declaration order: the first root to register an executable
    /// keeps it, a later root's duplicate never overwrites, and a non-`.exe` subkey is not a
    /// registration.
    #[test]
    fn app_paths_merge_keeps_the_first_root() {
        let user = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe\r\n    (Default)    REG_SZ    C:\\Users\\me\\AppData\\Local\\Programs\\Code\\Code.exe\r\n\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Toolbar\r\n    (Default)    REG_SZ    C:\\Users\\me\\AppData\\Local\\Toolbar\\bar.exe\r\n";
        let machine = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe\r\n    (Default)    REG_SZ    C:\\Program Files\\Code\\Code.exe\r\n\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Other.exe\r\n    (Default)    REG_SZ    C:\\Program Files\\Other\\Other.exe\r\n";
        let merged = merge_app_paths(vec![
            Some(app_paths_from_dump(user)),
            None,
            Some(app_paths_from_dump(machine)),
        ]);
        assert_eq!(
            merged["code.exe"],
            PathBuf::from("C:\\Users\\me\\AppData\\Local\\Programs\\Code\\Code.exe")
        );
        assert_eq!(
            merged["other.exe"],
            PathBuf::from("C:\\Program Files\\Other\\Other.exe")
        );
        assert_eq!(merged.len(), 2);
    }

    /// Uninstall records concatenate in root declaration order; a root that failed contributes
    /// nothing, and an entry without a `DisplayName` is not a record.
    #[test]
    fn install_records_merge_in_root_order() {
        let user = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Alpha_is1\r\n    DisplayName    REG_SZ    Alpha App\r\n    InstallLocation    REG_EXPAND_SZ    %ProgramFiles%\\Alpha\r\n";
        let machine = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Beta_is1\r\n    DisplayName    REG_SZ    Beta App\r\n    DisplayIcon    REG_SZ    C:\\Program Files\\Beta\\beta.exe\r\n\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Gamma_is1\r\n    DisplayName    REG_SZ    Gamma App\r\n\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Delta_is1\r\n    InstallLocation    REG_SZ    C:\\Program Files\\Delta\r\n";
        let merged = merge_install_records(vec![
            Some(install_records_from_dump(user)),
            None,
            Some(install_records_from_dump(machine)),
        ]);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].display_name, "Alpha App");
        assert_eq!(
            merged[0].install_location.as_deref(),
            Some("%ProgramFiles%\\Alpha")
        );
        assert_eq!(
            merged
                .iter()
                .find(|record| record.display_name == "Beta App")
                .and_then(|record| record.display_icon.as_deref()),
            Some("C:\\Program Files\\Beta\\beta.exe")
        );
        let mut machine_names: Vec<&str> = merged[1..]
            .iter()
            .map(|record| record.display_name.as_str())
            .collect();
        machine_names.sort_unstable();
        assert_eq!(machine_names, ["Beta App", "Gamma App"]);
    }
}

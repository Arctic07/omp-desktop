//! The checks a plugin page's own calls pass before this process acts for them (spec §6.2, §6.3).
//!
//! The bridge is where a page asks for something outside its own bundle - a file, the clipboard, a
//! network request - and this module is the part of that answer which is a *decision* rather than a
//! side effect: whether a permission is one this build serves, whether a requested path is one the
//! installation may read, whether a path lies inside a declared scope, and which grants the user has
//! given for the session. Keeping it apart from the bridge is what makes the whole gate testable
//! without a webview, a window or a host process.
//!
//! Three facts hold the design together:
//!
//! - **A permission is a switch and the manifest carries the range** (spec §6.1, §3.2). A plugin
//!   that declares `fs.read` and no scope is not a plugin with a narrow reach; it is one with none,
//!   and every read then falls to the user's answer.
//! - **Every gate can only refuse** (spec §6.3). The order is fixed - permission, containment,
//!   reject table, declared scope - and each gate is written as a filter rather than as a decision
//!   that could widen what an earlier one allowed.
//! - **The rules here are the host's rules** (`plugins-desktop.ts`). The host validates a manifest
//!   once and refuses a block it cannot read; this side re-checks the *shape* of what a row carried,
//!   with the same rule, because a row is an input like any other. Two implementations of one rule
//!   are only safe while they agree, so the shapes are spelled the same way in both files - a
//!   `/`-separated relative pattern in which `*` stands inside one segment and a whole `**` segment
//!   stands for one or more - and anything a second reading could disagree about is refused rather
//!   than guessed at.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Longest scope pattern this side accepts, mirroring the host's bound (`PLUGIN_FS_SCOPE_PATTERN_MAX`).
const SCOPE_PATTERN_MAX: usize = 256;
/// Most segments one scope pattern may have, mirroring the host's bound.
const SCOPE_SEGMENTS_MAX: usize = 16;
/// Most scope entries one installation may declare, mirroring the host's bound.
const SCOPE_ENTRIES_MAX: usize = 32;

/// The characters a scope pattern may never contain, mirroring the host's list.
const SCOPE_FORBIDDEN: [char; 18] = [
    '?', '[', ']', '{', '}', '!', '\\', ':', '<', '>', '"', '|', '\'', '`', ';', '&', '$', '%',
];

/// Whether one scope pattern is one both sides read the same way (spec §3.2).
///
/// The rule is about *segments*, which is why it is a loop rather than one expression: `*` inside a
/// segment is a star, a segment that is exactly `**` is the multi-segment star, and any other
/// spelling of a star (`panel**`, `a*b*c` is fine but `a**b` is not) is a pattern whose meaning two
/// implementations would have to agree on by convention. A pattern this side cannot read exactly is
/// refused, and the whole desktop block goes with it: a scope nobody can bound is not a narrow one.
pub(crate) fn validate_scope_pattern(pattern: &str) -> bool {
    // Counted in *characters*, not bytes: the host bounds the same string by code points, and a
    // bound two implementations read differently is a manifest the two sides disagree about.
    if pattern.is_empty() || pattern.chars().count() > SCOPE_PATTERN_MAX {
        return false;
    }
    if pattern.starts_with('/') || pattern.ends_with('/') {
        return false;
    }
    let segments: Vec<&str> = pattern.split('/').collect();
    if segments.len() > SCOPE_SEGMENTS_MAX {
        return false;
    }
    for segment in segments {
        if segment.is_empty() || segment == "." || segment == ".." {
            return false;
        }
        if segment == "**" {
            continue;
        }
        if segment.contains("**") {
            return false;
        }
        for character in segment.chars() {
            if character == '*' {
                continue;
            }
            // `is_control` covers C0 *and* the C1 range (U+0080-U+009F), which is the set the host
            // rejects too: a pattern one side accepts and the other refuses is a manifest whose
            // verdict depends on which side read it.
            if character.is_control() || SCOPE_FORBIDDEN.contains(&character) {
                return false;
            }
        }
    }
    true
}

/// Whether one list of patterns is one this side would honour: every entry readable, and no more of
/// them than the host would have carried.
pub(crate) fn validate_scope_list(scope: &[String]) -> bool {
    scope.len() <= SCOPE_ENTRIES_MAX && scope.iter().all(|pattern| validate_scope_pattern(pattern))
}

/// Whether one scope pattern names a whole tree (spec §3.2).
///
/// Only a *read* scope may be one: looking at everything inside a package is a reach a manifest can
/// declare, while changing or removing everything is not a range at all - which is why the same
/// patterns are refused for the two modes that write (`plugins-desktop.ts` refuses them too, with the
/// same list).
pub(crate) fn is_whole_tree_scope(pattern: &str) -> bool {
    matches!(pattern, "**" | "**/*" | "*/**" | "./*")
}

/// Whether a `/`-separated relative path lies inside one declared scope (spec §6.3, gate four).
///
/// The comparison is per segment and case-insensitive on Windows, which is how that filesystem
/// compares names too: a scope that read `Docs/**` would otherwise refuse the file the user sees as
/// `docs/readme.md` on the one platform where those are the same file. `**` stands for one or more
/// whole segments, so `desktop/**` names what is *under* `desktop` and not the directory itself -
/// which is the reading a file-granular gate wants, since only files are ever opened.
pub(crate) fn scope_matches(pattern: &str, path: &str) -> bool {
    let wanted: Vec<&str> = pattern.split('/').collect();
    let actual: Vec<&str> = path.split('/').collect();
    // A table rather than recursion: a long path with several `**` in the pattern would otherwise
    // re-walk the same suffix once per star, and the answer is one bit per (pattern, path) pair.
    let mut reached = vec![false; actual.len() + 1];
    reached[0] = true;
    for segment in wanted {
        let mut next = vec![false; actual.len() + 1];
        if segment == "**" {
            // One or more whole segments: every position *after* a reached one is reached, and the
            // position itself is not - `desktop/**` names what is under `desktop`, never `desktop`.
            let mut running = false;
            for index in 1..=actual.len() {
                if reached[index - 1] {
                    running = true;
                }
                next[index] = running;
            }
        } else {
            for index in 1..=actual.len() {
                if reached[index - 1] && segment_eq(segment, actual[index - 1]) {
                    next[index] = true;
                }
            }
        }
        reached = next;
    }
    reached[actual.len()]
}

/// Whether one pattern segment matches one path segment: `*` is any run of characters here.
fn segment_eq(pattern: &str, path: &str) -> bool {
    if !pattern.contains('*') {
        return same_name(pattern, path);
    }
    // Split on the stars: what is before the first one is a prefix, what follows the last one is a
    // suffix, and everything between is found in order. The split is over a `&str`, so every cut is
    // at a character boundary and a multi-byte name is compared as the user sees it.
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut rest = path;
    if let Some(head) = parts.first() {
        if !head.is_empty() {
            match strip_prefix_name(rest, head) {
                Some(tail) => rest = tail,
                None => return false,
            }
        }
    }
    for part in &parts[1..parts.len() - 1] {
        if part.is_empty() {
            continue;
        }
        match find_name(rest, part) {
            Some(tail) => rest = tail,
            None => return false,
        }
    }
    let tail_part = parts[parts.len() - 1];
    // A pattern that does not end in a star must have consumed the segment; one that does may leave
    // whatever it likes behind.
    tail_part.is_empty() || strip_suffix_name(rest, tail_part).is_some()
}

/// Whether `text` ends with `suffix`, compared the way this platform compares names.
fn strip_suffix_name<'a>(text: &'a str, suffix: &str) -> Option<&'a str> {
    let index = text.len().checked_sub(suffix.len())?;
    if !text.is_char_boundary(index) {
        return None;
    }
    let (head, tail) = text.split_at(index);
    same_name(tail, suffix).then_some(head)
}

/// The tail of `text` after a leading `prefix`, compared the way this platform compares names.
///
/// The length check is not enough on its own: `split_at` panics when the offset it is given is not
/// a character boundary, and both this and [`find_name`] walk a *path* whose characters are the
/// plugin's to choose - a scope like `a*` against a file named `文档.md` would otherwise take the
/// protocol handler down instead of refusing the call.
fn strip_prefix_name<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    if text.len() < prefix.len() || !text.is_char_boundary(prefix.len()) {
        return None;
    }
    let (head, tail) = text.split_at(prefix.len());
    same_name(head, prefix).then_some(tail)
}

/// The tail of `text` after the first occurrence of `needle`.
///
/// The search is over characters, so a multi-byte name is not cut in the middle of one: a byte-wise
/// search would be able to match at an offset that is not a character boundary.
fn find_name<'a>(text: &'a str, needle: &str) -> Option<&'a str> {
    let mut start = 0;
    while start <= text.len() {
        if let Some(tail) = strip_prefix_name(&text[start..], needle) {
            return Some(tail);
        }
        let character = text[start..].chars().next()?;
        start += character.len_utf8();
    }
    None
}

/// Whether two path components are the same name on this platform.
fn same_name(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

/// Whether one entry of `net.domains` is a host name this side is willing to compare against.
///
/// The rule is deliberately narrow: lowercase or uppercase ASCII letters, digits, `-` and `.`, with
/// labels of 1..63 characters that do not begin or end in a hyphen, 253 characters in all, and no
/// trailing dot. Anything else - a scheme, a path, a port, a wildcard, an internationalised name in
/// its Unicode form - is a declaration whose meaning this side would have to guess: the comparison
/// during egress is exact, so an entry that is not exactly a host name could never match one, and
/// keeping it would be publishing a rule nobody follows. Punycode (`xn--…`) is ASCII and passes.
pub(crate) fn is_host_name(domain: &str) -> bool {
    if domain.is_empty() || domain.len() > 253 || domain.ends_with('.') {
        return false;
    }
    domain.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
    })
}

/// Which of the file modes a path is being resolved for.
///
/// The mode picks the resolver - a read or a delete names something that is there, a write may name
/// something that is not, and an *inspection* names either a file or a directory - and nothing else:
/// the containment check, the reject table and the scope matching are the same for all four
/// (spec §6.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FsMode {
    Read,
    Write,
    Delete,
    /// `fs.stat` and `fs.list`: the same containment and reject gates as a read, but a directory is
    /// an answer rather than a `NotFound`. It is a mode of its own rather than a flag because the
    /// widening (`fs.anyPath`) reads it too, and one enum is one place to keep the four behaviours
    /// straight.
    Inspect,
}

/// The roots one page's file gates resolve against (spec §6.3).
///
/// Two, and in this order: the **workspace the page belongs to** (the shell tells this process which
/// one that is; a plugin that reads the user's project is reading what the user opened) and the
/// installation's **own package** (so a plugin can still read what it ships - a template, a schema, a
/// data file - without asking anyone). The first root that resolves wins, which is why the workspace
/// is first: a name that exists in both is the user's file.
#[derive(Debug, Clone)]
pub(crate) struct FsRoots {
    pub(crate) workspace: Option<PathBuf>,
    pub(crate) plugin: PathBuf,
}

impl FsRoots {
    /// The file one request names, resolved against the first root that has it.
    ///
    /// A refusal is the *first* root's when neither resolves: the workspace is the root a page is
    /// working in, so "not there" is an answer about it rather than about the plugin's own package.
    pub(crate) fn resolve(&self, requested: &str, mode: FsMode) -> Result<PathBuf, ReadRefusal> {
        let resolve = |root: &Path| match mode {
            FsMode::Write => resolve_write(root, requested),
            FsMode::Inspect => resolve_inspect(root, requested),
            FsMode::Read | FsMode::Delete => resolve_read(root, requested),
        };
        let mut first: Option<ReadRefusal> = None;
        for root in self.workspace.iter().chain(std::iter::once(&self.plugin)) {
            match resolve(root) {
                Ok(path) => return Ok(path),
                Err(refusal) => first = first.or(Some(refusal)),
            }
        }
        Err(first.unwrap_or(ReadRefusal::NotFound))
    }
}

/// Why a requested path may not be read, in the vocabulary the bridge answers with (spec §6.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadRefusal {
    /// Not a relative path this application resolves: absolute, climbing, or carrying control text.
    Relative,
    /// Nothing is there, or what is there is not a file.
    NotFound,
    /// The reject table names it: a credential file or a private directory (spec §6.3-3).
    DeniedByPolicy,
}

/// The file one read request names, after the containment and reject-table gates (spec §6.3-2/-3).
///
/// The order is the spec's - containment before the reject table - and both are applied twice where
/// they have to be: once to the path the page *asked for*, and once to the path the request actually
/// resolves to. The second pass is what makes the table hold through a link: a package can ship
/// `notes.md` as a link to `.env`, and a table that only read the requested name would hand the
/// credential file out under a name nobody would look for. Both the root and the target are
/// canonicalised, so a link whose target is outside the root is refused rather than followed.
///
/// A path that does not exist is `NotFound` rather than a permission answer (spec §6.3-2's stated
/// exception): the two facts are different, and the caller that asked for a file it can see on its
/// own disk should be told which one it hit.
pub(crate) fn resolve_read(root: &Path, requested: &str) -> Result<PathBuf, ReadRefusal> {
    resolve_entry(root, requested, false)
}

/// The file or directory one `fs.stat` / `fs.list` names, after the same containment and reject
/// gates a read passes.
///
/// The one difference from [`resolve_read`] is that a directory is an answer: a caller asking what is
/// at a path, or what is inside it, is asking a question a file already answers. Everything else -
/// the shape gate, the two reject-table passes over the requested and the resolved name, the
/// canonicalisation that makes a link out of the root a refusal rather than a read - is the same
/// check, which is why the two are one function with a flag rather than two copies that would drift.
pub(crate) fn resolve_inspect(root: &Path, requested: &str) -> Result<PathBuf, ReadRefusal> {
    resolve_entry(root, requested, true)
}

/// The one implementation of the read-shaped gates: `allow_directory` is the only difference between
/// a read and an inspection.
fn resolve_entry(
    root: &Path,
    requested: &str,
    allow_directory: bool,
) -> Result<PathBuf, ReadRefusal> {
    let trimmed = requested.trim();
    if !crate::services::plugins::pages::is_safe_relative(trimmed) {
        return Err(ReadRefusal::Relative);
    }
    let canonical_root = std::fs::canonicalize(root).map_err(|_| ReadRefusal::NotFound)?;
    let candidate = canonical_root.join(trimmed.replace('/', std::path::MAIN_SEPARATOR_STR));
    let resolved = std::fs::canonicalize(&candidate).map_err(|_| ReadRefusal::NotFound)?;
    if !crate::services::paths::is_within(&canonical_root, &resolved) {
        return Err(ReadRefusal::DeniedByPolicy);
    }
    if !allow_directory && !resolved.is_file() {
        return Err(ReadRefusal::NotFound);
    }
    if is_rejected_path(trimmed) {
        return Err(ReadRefusal::DeniedByPolicy);
    }
    // The resolved file as a `/`-separated path below the root: what the request *became*, which is
    // what a link changes. `strip_prefix` cannot fail here - the containment check above passed - and
    // a path it somehow cannot express is refused rather than read.
    let Ok(relative) = resolved.strip_prefix(&canonical_root) else {
        return Err(ReadRefusal::DeniedByPolicy);
    };
    let relative = relative
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR_STR, "/");
    if is_rejected_path(&relative) {
        return Err(ReadRefusal::DeniedByPolicy);
    }
    Ok(resolved)
}

/// The file one *write* request names, after the containment and reject-table gates (spec §6.3-2/-3).
///
/// A write is the one file mode whose target may not exist yet, so the containment check is about the
/// directory it would land in: the parent must be there and inside the root (which is what catches a
/// symlinked parent), and the leaf is then whatever the caller named - a name that is a directory
/// already is refused, because a write names a file. The reject table is applied to the requested path
/// *and* to the path the request resolves to, exactly as the read gate applies it, so a link cannot
/// carry a credential file's name past it.
pub(crate) fn resolve_write(root: &Path, requested: &str) -> Result<PathBuf, ReadRefusal> {
    let trimmed = requested.trim();
    if !crate::services::plugins::pages::is_safe_relative(trimmed) {
        return Err(ReadRefusal::Relative);
    }
    let canonical_root = std::fs::canonicalize(root).map_err(|_| ReadRefusal::NotFound)?;
    let candidate = canonical_root.join(trimmed.replace('/', std::path::MAIN_SEPARATOR_STR));
    let Some(name) = candidate.file_name() else {
        return Err(ReadRefusal::Relative);
    };
    let Some(parent) = candidate.parent() else {
        return Err(ReadRefusal::Relative);
    };
    let canonical_parent = std::fs::canonicalize(parent).map_err(|_| ReadRefusal::NotFound)?;
    if !crate::services::paths::is_within(&canonical_root, &canonical_parent) {
        return Err(ReadRefusal::DeniedByPolicy);
    }
    let target = canonical_parent.join(name);
    if target.is_dir() {
        return Err(ReadRefusal::NotFound);
    }
    if is_rejected_path(trimmed) {
        return Err(ReadRefusal::DeniedByPolicy);
    }
    let Ok(relative) = target.strip_prefix(&canonical_root) else {
        return Err(ReadRefusal::DeniedByPolicy);
    };
    let relative = relative
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR_STR, "/");
    if is_rejected_path(&relative) {
        return Err(ReadRefusal::DeniedByPolicy);
    }
    Ok(target)
}

/// The file one *unrestricted* request names (`fs.anyPath`).
///
/// The declared permission is the whole gate: an installation that holds it reaches any path the
/// user account can, in all three modes, with no root, no reject table and no question. It is the
/// file half of the same idea as `net.anyHost` (`rules.md#plugin-system`), and it exists for the
/// open plugin surface - a plugin that manages a user's projects, or a dotfile the user asked it to
/// own, is not helped by a gate that only ever sees the workspace.
///
/// A relative name is resolved against the installation's own package root, which is the one
/// directory a plugin can name without knowing where it was installed (and the worker's working
/// directory). The shape gate is dropped rather than kept, because an absolute path is the point;
/// the two facts that are *not* dropped are the ones that are about the file rather than about a
/// permission the installation holds - a read or a delete names something that is there, and a write
/// names a file whose parent is there - so a caller is still told `NotFound` rather than handed a
/// path nothing can open.
pub(crate) fn resolve_any(
    root: &Path,
    requested: &str,
    mode: FsMode,
) -> Result<PathBuf, ReadRefusal> {
    let trimmed = requested.trim();
    if trimmed.is_empty() {
        return Err(ReadRefusal::Relative);
    }
    let candidate = if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        root.join(trimmed.replace('/', std::path::MAIN_SEPARATOR_STR))
    };
    match mode {
        FsMode::Write => {
            let Some(name) = candidate.file_name() else {
                return Err(ReadRefusal::Relative);
            };
            let Some(parent) = candidate.parent() else {
                return Err(ReadRefusal::Relative);
            };
            let canonical_parent =
                std::fs::canonicalize(parent).map_err(|_| ReadRefusal::NotFound)?;
            let target = canonical_parent.join(name);
            if target.is_dir() {
                return Err(ReadRefusal::NotFound);
            }
            Ok(target)
        }
        FsMode::Inspect => {
            // An inspection names whatever is there: a file, a directory, or a link that resolves to
            // either. The only answer it still gives is `NotFound` for a path that is not.
            std::fs::canonicalize(&candidate).map_err(|_| ReadRefusal::NotFound)
        }
        FsMode::Read | FsMode::Delete => {
            let resolved = std::fs::canonicalize(&candidate).map_err(|_| ReadRefusal::NotFound)?;
            if !resolved.is_file() {
                return Err(ReadRefusal::NotFound);
            }
            Ok(resolved)
        }
    }
}

/// The file extensions this application never hands out, whatever the file is called.
const REJECTED_EXTENSIONS: [&str; 4] = [".pem", ".p12", ".pfx", ".keystore"];

/// The file names this application never hands out, exactly or by prefix.
const REJECTED_NAMES: [&str; 4] = [".npmrc", ".netrc", ".pypirc", ".git-credentials"];

/// The directory names this application never hands out, at any depth (spec §6.3-3).
const REJECTED_SEGMENTS: [&str; 6] = [".git", ".ssh", ".aws", ".gnupg", ".kube", ".docker"];

/// Whether one `/`-separated path names something this application never hands out.
///
/// The table is the spec's own (§6.3-3) and it covers *every* scope and every grant: a credential
/// file or a private directory is refused even inside the plugin that ships it, because a page that
/// can read one is a page that can post it the moment a network permission exists. Two families are
/// prefixes rather than exact names - `.env*` (`plugins-desktop.ts` writes `.env.local` as often as
/// `.env`) and `id_rsa*` (a key file carries its algorithm in the suffix) - and the directory names
/// are matched per segment so a nested `.git` is found at any depth.
///
/// One implementation serves both callers - the asset protocol and the bridge's read gate - because
/// two copies of a reject table drift, and the one that drifts is the one nobody re-reads.
pub(crate) fn is_rejected_path(requested: &str) -> bool {
    let path = requested.to_ascii_lowercase();
    let mut segments = path.split('/');
    let name = segments.next_back().unwrap_or_default();
    if path
        .split('/')
        .any(|segment| REJECTED_SEGMENTS.contains(&segment))
    {
        return true;
    }
    if name.starts_with(".env") || name.starts_with("id_rsa") {
        return true;
    }
    if REJECTED_NAMES.contains(&name) {
        return true;
    }
    REJECTED_EXTENSIONS
        .iter()
        .any(|extension| name.ends_with(extension))
}

/// The file extensions whose *default handler runs them*, in the two families that matter: what
/// Windows would execute or script, and the small set the other platforms treat as programs.
///
/// This is not the reject table. That one protects a *secret* and covers every file read; this one
/// protects the user's machine from the one thing `fs.openDefault` can do that a read cannot — hand
/// a path to a launcher that will *run* it. The list is closed and deliberately short: an author who
/// wants to open a text file, an image, a document or a folder is unaffected, and a file whose
/// extension is not here is displayed by whatever the platform has, which is the risk the permission
/// itself already discloses.
const EXECUTABLE_EXTENSIONS: [&str; 22] = [
    ".exe", ".com", ".scr", ".pif", ".bat", ".cmd", ".msi", ".msp", ".cpl", ".reg", ".lnk", ".ps1",
    ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta", ".jar", ".sh",
];

/// Whether one path names a program this application would never hand to the system's own opener.
///
/// The comparison is on the *resolved* file's name (`fs.openDefault` and `fs.reveal` call it after
/// the read gates, so a link cannot carry an extension past it), and it is the reason those two
/// methods have their own refusal: a permission that says "let the system open this" does not mean
/// "let the system run this".
pub(crate) fn is_executable_path(path: &str) -> bool {
    let name = path
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    EXECUTABLE_EXTENSIONS
        .iter()
        .any(|extension| name.ends_with(extension))
}

/// One grant the user gave for the rest of this process's life (spec §6.3-4: session authorization
/// is memory-only, and the process ending is what ends it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SessionGrant {
    /// A read of one file, granted for this session.
    Read(String),
    /// A write to one file, granted for this session.
    Write(String),
    /// A delete of one file, granted for this session.
    Delete(String),
    /// One clipboard direction, granted for this session.
    Clipboard(&'static str),
    /// One completion on this application's models, granted for this session: the question names
    /// the capability (it spends money, not a file), so one grant covers every later call.
    AgentComplete,
}

impl SessionGrant {
    /// The token this grant is stored and looked up under.
    fn token(&self) -> String {
        match self {
            // The resolved path, lowercased on Windows the way the filesystem compares it, so the
            // same file asked for twice does not ask twice.
            SessionGrant::Read(path) => granted_token("fs.read", path),
            SessionGrant::Write(path) => granted_token("fs.write", path),
            SessionGrant::Delete(path) => granted_token("fs.delete", path),
            SessionGrant::Clipboard(direction) => format!("clipboard.{direction}"),
            // One token for the capability, for the same reason: the question names the permission,
            // and there is no narrower value to remember.
            SessionGrant::AgentComplete => "agent.complete".to_owned(),
        }
    }
}

/// How many deletes one installation may make in a rolling window, and how long that window is.
///
/// A delete is bounded per call (one file, never a directory) but not per *loop*: a plugin can delete
/// a file, then the next, and the damage is a hundred calls that each looked reasonable. The brake is
/// what makes the series visible to the user as a series, and it is deliberately generous - it is a
/// brake, not a quota.
pub(crate) const DELETES_PER_WINDOW: u32 = 50;
pub(crate) const DELETE_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

/// The deletes one installation has made lately, so a series of them is answered as a series.
///
/// **Owner / bound / release.** Owned by `AppState`; bounded by the number of installations this
/// process serves (one entry per installation, cleared when its window passes); released by the
/// installation being re-published, exactly like the session grants beside it.
#[derive(Default)]
pub(crate) struct DeleteBudget {
    inner: Mutex<BTreeMap<String, (u32, std::time::Instant)>>,
}

impl DeleteBudget {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Whether one more delete may go ahead now, counting it when it may.
    ///
    /// The window is fixed rather than sliding: the first delete starts it, and the count resets when
    /// it has passed. That is enough to answer the question this brake exists for ("is this a series
    /// of them?"), and it keeps the state one number per installation.
    pub(crate) fn take(&self, key: &str) -> bool {
        let Ok(mut table) = self.inner.lock() else {
            // A poisoned lock refuses rather than guesses: the caller answers the plugin, and the
            // plugin can ask again.
            return false;
        };
        let now = std::time::Instant::now();
        let entry = table.entry(key.to_owned()).or_insert((0, now));
        if now.duration_since(entry.1) >= DELETE_WINDOW {
            *entry = (0, now);
        }
        if entry.0 >= DELETES_PER_WINDOW {
            return false;
        }
        entry.0 += 1;
        true
    }

    /// Forgets one installation's history, which is what a rebuilt registry means.
    pub(crate) fn forget(&self, key: &str) {
        if let Ok(mut table) = self.inner.lock() {
            table.remove(key);
        }
    }
}

/// The token one path grant is stored under: the mode, then the file, lowercased on Windows the way
/// the filesystem compares names - so the same file asked for twice does not ask twice.
fn granted_token(mode: &str, path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let path = if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    };
    format!("{mode}:{path}")
}

/// The grants the user has given this session, per installation.
///
/// Keyed by the installation's origin key - the same opaque identity the pages are served under -
/// so a grant names one installation and not an id that another scope also carries. The whole table
/// is cleared for a key whenever the registry is rebuilt for it (disable, uninstall, upgrade): a
/// package that changed under a window is a package the user has not answered for.
///
/// **Owner / bound / release.** Owned by `AppState`; bounded by the number of installations this
/// process serves times the grants a user can give (one clipboard direction per method and one path
/// per answered read, so it grows with user actions only, never with calls); released when the
/// installation is re-published or on process exit.
#[derive(Default)]
pub(crate) struct SessionGrants {
    inner: Mutex<BTreeMap<String, Vec<SessionGrant>>>,
}

impl SessionGrants {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Whether the user has already answered this installation's call for this grant.
    pub(crate) fn holds(&self, key: &str, grant: &SessionGrant) -> bool {
        let token = grant.token();
        self.inner
            .lock()
            .map(|table| {
                table
                    .get(key)
                    .is_some_and(|held| held.iter().any(|item| item.token() == token))
            })
            .unwrap_or(false)
    }

    /// Records one session grant, if it is not already held.
    pub(crate) fn remember(&self, key: &str, grant: SessionGrant) {
        let Ok(mut table) = self.inner.lock() else {
            return;
        };
        let entry = table.entry(key.to_owned()).or_default();
        let token = grant.token();
        if !entry.iter().any(|item| item.token() == token) {
            entry.push(grant);
        }
    }

    /// Forgets every grant of one installation, which is what a rebuilt registry means: the package
    /// those answers were given for is not the package the window now runs.
    pub(crate) fn forget(&self, key: &str) {
        if let Ok(mut table) = self.inner.lock() {
            table.remove(key);
        }
    }

    /// How many installations hold at least one grant; the only number here a caller may read.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.inner.lock().map(|table| table.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

use crate::models::{
    FileEntry, FileReadResult, ListWorkspaceEntriesResult, RevealWorkspaceFileResult,
};
use crate::services::{open_in_app, paths};

const TEXT_LIMIT: usize = 512 * 1024;
const IMAGE_LIMIT: usize = 5 * 1024 * 1024;
/// Ceiling on one path a command accepts. Windows' own long-path limit is the widest value that
/// can still name a file this desktop could read.
const PATH_LIMIT: usize = 4096;
const WORKSPACE_ENTRY_LIMIT: usize = 10_000;

static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
/// Names a browse never shows and never walks into: generated trees.
const IGNORED_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".DS_Store",
];

/// The repository's own metadata: hidden like an ignored name, and refused even when a path names
/// a file inside it. `.git/config` carries command lines (`core.sshCommand`, `core.fsmonitor`, a
/// hook path) that the next git operation runs, and `.git/hooks/*` is what the next commit runs, so
/// a write there is not a save this desktop performs for the page.
const VCS_NAMES: &[&str] = &[".git"];

fn matches_name(name: &OsStr, names: &[&str]) -> bool {
    match name.to_str() {
        Some(name) => names
            .iter()
            .any(|candidate| name.eq_ignore_ascii_case(candidate)),
        None => false,
    }
}

/// Whether a browse hides this name. The tree, the search, the `@` picker and a git path all ask
/// here, so `.git` is hidden exactly as a generated tree is.
pub(super) fn ignored_name(name: &OsStr) -> bool {
    matches_name(name, IGNORED_NAMES) || matches_name(name, VCS_NAMES)
}

/// Whether a directly named path is refused as repository metadata.
fn vcs_name(name: &OsStr) -> bool {
    matches_name(name, VCS_NAMES)
}

pub(crate) fn current_working_directory() -> Result<String, String> {
    std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

/// The shape every workspace-relative path must have: relative, and no segment that climbs out.
///
/// Both policies below start here; what they add is which names they refuse.
fn validate_relative_shape(path: &Path) -> Result<(), String> {
    if path.is_absolute() {
        return Err("Workspace path must be relative".to_owned());
    }

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(_) => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Workspace path escapes workspace root".to_owned());
            }
        }
    }

    Ok(())
}

/// The shape plus the browse policy: the tree, the search, the `@` picker and a launcher's target
/// stay out of every hidden name, generated trees and `.git` alike.
fn validate_browse_path(path: &Path) -> Result<(), String> {
    validate_relative_shape(path)?;
    if path
        .components()
        .any(|component| matches!(component, Component::Normal(name) if ignored_name(name)))
    {
        return Err("Workspace path is ignored".to_owned());
    }

    Ok(())
}

/// The shape plus the named-file policy: one file a page named outright is read, saved and revealed
/// where it sits inside the root, generated trees included — a transcript prints a path to a build
/// artefact and the click names that file, not the tree. Repository metadata stays refused, because
/// `.git` holds command lines rather than content.
fn validate_named_path(path: &Path) -> Result<(), String> {
    validate_relative_shape(path)?;
    if path
        .components()
        .any(|component| matches!(component, Component::Normal(name) if vcs_name(name)))
    {
        return Err("Workspace path is repository metadata".to_owned());
    }

    Ok(())
}

pub(crate) fn canonical_workspace_root(root: &str) -> Result<PathBuf, String> {
    let canonical = Path::new(root)
        .canonicalize()
        .map_err(|_| "Workspace root is invalid".to_owned())?;
    if !canonical.is_dir() {
        return Err("Workspace root is not a directory".to_owned());
    }
    Ok(canonical)
}

/// Resolve one workspace-relative path against its root under one policy: the canonical root, and
/// the canonical target it names.
///
/// Containment is the part both callers share — the target must canonicalize inside the root, so a
/// link cannot carry a path out — and the policy decides only which relative paths are admitted.
/// It runs on the spelling and again on the canonical path, so a link that resolves to a refused
/// name (an alias of `.git`, say) is refused by the same policy that refuses the name itself.
fn resolve_relative_under_root(
    root: &str,
    relative: &str,
    validate: fn(&Path) -> Result<(), String>,
) -> Result<(PathBuf, PathBuf), String> {
    let canonical_root = canonical_workspace_root(root)?;
    let relative_path = Path::new(relative);
    validate(relative_path)?;

    let target = canonical_root
        .join(relative_path)
        .canonicalize()
        .map_err(|_| "Workspace path does not exist".to_owned())?;
    if !target.starts_with(&canonical_root) {
        return Err("Workspace path escapes workspace root".to_owned());
    }
    let canonical_relative = target
        .strip_prefix(&canonical_root)
        .map_err(|_| "Workspace path escapes workspace root".to_owned())?;
    validate(canonical_relative)?;

    Ok((canonical_root, target))
}

/// Resolve one workspace-relative path a UI browses — a listing, a search, or a launcher's target
/// — against its root. A path a page named outright goes through `resolve_workspace_file` instead.
pub(crate) fn resolve_workspace_path(
    root: &str,
    relative: &str,
) -> Result<(PathBuf, PathBuf), String> {
    resolve_relative_under_root(root, relative, validate_browse_path)
}

/// Resolve one path a page named outright — a transcript's click on a printed path, and the read,
/// save and reveal that follow it — against its root.
///
/// A generated tree the tree and the search stay out of (`target/`, `node_modules/`, `dist/`) is
/// still a place an answer can print a path to, and a click on one names that file rather than
/// asking to browse the tree; refusing it drew a failed read over files that plainly exist.
/// Repository metadata is still refused (`validate_named_path`), and containment is unchanged.
fn resolve_workspace_file(root: &str, relative: &str) -> Result<(PathBuf, PathBuf), String> {
    resolve_relative_under_root(root, relative, validate_named_path)
}

pub(super) fn path_is_within_root(root: &Path, relative: &Path) -> bool {
    let candidate = root.join(relative);
    let mut probe = candidate.as_path();

    loop {
        if let Ok(canonical) = probe.canonicalize() {
            return canonical.starts_with(root);
        }

        if let Ok(metadata) = fs::symlink_metadata(probe) {
            if metadata.file_type().is_symlink() {
                return false;
            }
        }

        let Some(parent) = probe.parent() else {
            return false;
        };
        if parent == probe {
            return false;
        }
        probe = parent;
    }
}

pub(crate) fn safe_git_path(root: &Path, path: &str) -> bool {
    let relative = Path::new(path);
    validate_browse_path(relative).is_ok() && path_is_within_root(root, relative)
}

pub(super) fn image_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?;
    if extension.eq_ignore_ascii_case("png") {
        Some("image/png")
    } else if extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg") {
        Some("image/jpeg")
    } else if extension.eq_ignore_ascii_case("gif") {
        Some("image/gif")
    } else if extension.eq_ignore_ascii_case("webp") {
        Some("image/webp")
    } else if extension.eq_ignore_ascii_case("svg") {
        Some("image/svg+xml")
    } else if extension.eq_ignore_ascii_case("ico") {
        Some("image/x-icon")
    } else if extension.eq_ignore_ascii_case("bmp") {
        Some("image/bmp")
    } else if extension.eq_ignore_ascii_case("avif") {
        Some("image/avif")
    } else {
        None
    }
}

fn bytes_are_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0) || std::str::from_utf8(bytes).is_err()
}

fn read_file_limited(path: &Path, limit: usize) -> Result<(Vec<u8>, bool), String> {
    let file = File::open(path).map_err(|_| "Workspace file cannot be read".to_owned())?;
    let mut bytes = Vec::new();
    let mut limited = file.take((limit + 1) as u64);
    limited
        .read_to_end(&mut bytes)
        .map_err(|_| "Workspace file cannot be read".to_owned())?;
    let exceeded = bytes.len() > limit;
    if exceeded {
        bytes.truncate(limit);
    }
    Ok((bytes, exceeded))
}

fn read_result(kind: &str, size: u64) -> FileReadResult {
    FileReadResult {
        kind: kind.to_owned(),
        content: None,
        data_url: None,
        size,
    }
}

pub(crate) fn list_workspace_entries(
    root: String,
    path: String,
) -> Result<ListWorkspaceEntriesResult, String> {
    let (canonical_root, target) = resolve_workspace_path(&root, &path)?;
    let metadata =
        fs::metadata(&target).map_err(|_| "Workspace directory cannot be read".to_owned())?;
    if !metadata.is_dir() {
        return Err("Workspace path is not a directory".to_owned());
    }

    let mut entries = Vec::new();
    let directory =
        fs::read_dir(&target).map_err(|_| "Workspace directory cannot be read".to_owned())?;
    for entry in directory {
        if entries.len() >= WORKSPACE_ENTRY_LIMIT {
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.file_name();
        if ignored_name(&name) {
            continue;
        }
        let Some(name_string) = name.to_str() else {
            continue;
        };

        // The scan already carries each ordinary entry's type and size, so a plain entry costs no
        // call at all; only a link can name something outside the root, and only a link is
        // resolved. `DirEntry::metadata` does not follow a link, so a link keeps the follow that a
        // path-based `fs::metadata` performed before.
        let is_link = match entry.file_type() {
            Ok(file_type) => file_type.is_symlink(),
            Err(_) => continue,
        };
        let child_metadata = if is_link {
            let canonical_child = match entry.path().canonicalize() {
                Ok(path) => path,
                Err(_) => continue,
            };
            if !canonical_child.starts_with(&canonical_root) {
                continue;
            }
            match fs::metadata(&canonical_child) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            }
        } else {
            match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            }
        };
        let (kind, size) = if child_metadata.is_dir() {
            ("dir", 0)
        } else if child_metadata.is_file() {
            ("file", child_metadata.len())
        } else {
            continue;
        };
        entries.push(FileEntry {
            name: name_string.to_owned(),
            kind: kind.to_owned(),
            size,
        });
    }

    entries.sort_by(|left, right| {
        let left_directory = left.kind == "dir";
        let right_directory = right.kind == "dir";
        right_directory
            .cmp(&left_directory)
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(ListWorkspaceEntriesResult { entries })
}

pub(crate) fn read_workspace_file(root: String, path: String) -> Result<FileReadResult, String> {
    let (_canonical_root, target) = resolve_workspace_file(&root, &path)?;
    read_file_at(&target)
}

/// Read one file the page named by an absolute path outside every workspace root.
///
/// Deliberately outside the workspace rules: no ignored name and no root containment apply here,
/// because reading a file that is not in a workspace is exactly what this is for. What comes back
/// is still what a workspace read produces - the same limits and the same text/binary/image
/// decision, and the same "directory" answer for a folder - so such a path draws exactly as it
/// would inside a workspace.
pub(crate) fn read_external_file(path: String) -> Result<FileReadResult, String> {
    let target = external_file_path(&path)?;
    read_file_at(&target)
}

/// The canonical entry behind an absolute path the page named, or the refusal it gets.
///
/// It must refuse an empty or over-long path, a relative one, and something that is gone, so a path
/// that is safe to draw is one the read can answer for. A directory is deliberately not a refusal:
/// the click that reaches this names whatever the transcript printed, and `read_file_at` answering
/// "directory" is what lets the page open a folder instead of drawing "not a file" over it.
fn external_file_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.len() > PATH_LIMIT {
        return Err("That path is invalid.".to_owned());
    }
    let target = Path::new(path);
    if !target.is_absolute() {
        return Err("That path is not absolute.".to_owned());
    }
    target
        .canonicalize()
        .map_err(|_| "That file does not exist.".to_owned())
}

/// One path, from a path that is already resolved: an image, text inside the limits, a binary the
/// panel will not draw as text, tooLarge - or a directory, which is told apart from a file here
/// rather than refused, because the page has a surface for it (the tree, the file manager) and
/// "not a file" is not one.
fn read_file_at(target: &Path) -> Result<FileReadResult, String> {
    let metadata = fs::metadata(target).map_err(|_| "Workspace file cannot be read".to_owned())?;
    if metadata.is_dir() {
        return Ok(read_result("directory", 0));
    }
    if !metadata.is_file() {
        return Err("Workspace path is not a file".to_owned());
    }
    let size = metadata.len();

    if let Some(mime) = image_mime(target) {
        if size > IMAGE_LIMIT as u64 {
            return Ok(read_result("tooLarge", size));
        }
        let (bytes, exceeded) = read_file_limited(target, IMAGE_LIMIT)?;
        if exceeded {
            return Ok(read_result("tooLarge", size));
        }
        let actual_size = bytes.len() as u64;
        return Ok(FileReadResult {
            kind: "image".to_owned(),
            content: None,
            data_url: Some(format!("data:{mime};base64,{}", STANDARD.encode(&bytes))),
            size: actual_size,
        });
    }

    if size > TEXT_LIMIT as u64 {
        return Ok(read_result("tooLarge", size));
    }

    let (bytes, exceeded) = read_file_limited(target, TEXT_LIMIT)?;
    if exceeded {
        return if bytes_are_binary(&bytes) {
            Ok(read_result("binary", size))
        } else {
            Ok(read_result("tooLarge", size))
        };
    }
    let actual_size = bytes.len() as u64;
    if bytes_are_binary(&bytes) {
        Ok(read_result("binary", actual_size))
    } else {
        let content = String::from_utf8(bytes)
            .map_err(|_| "Workspace file cannot be read as text".to_owned())?;
        Ok(FileReadResult {
            kind: "text".to_owned(),
            content: Some(content),
            data_url: None,
            size: actual_size,
        })
    }
}

fn replace_file(temp: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::{iter::once, os::windows::ffi::OsStrExt};
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let source: Vec<u16> = temp.as_os_str().encode_wide().chain(once(0)).collect();
        let destination: Vec<u16> = target.as_os_str().encode_wide().chain(once(0)).collect();
        let result = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if result == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(temp, target)
    }
}

fn write_file_atomically(target: &Path, content: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Workspace file cannot be written".to_owned())?;
    let name = target
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "Workspace file cannot be written".to_owned())?;
    let sequence = WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(".{name}.omp-{}-{sequence}.tmp", std::process::id()));

    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(content)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, target)
    })();

    match result {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = fs::remove_file(&temporary);
            Err("Workspace file cannot be written".to_owned())
        }
    }
}

pub(crate) fn write_workspace_file(
    root: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let (_canonical_root, target) = resolve_workspace_file(&root, &path)?;
    if content.len() > TEXT_LIMIT {
        return Err("Workspace file content is too large".to_owned());
    }

    let metadata =
        fs::metadata(&target).map_err(|_| "Workspace file cannot be written".to_owned())?;
    if !metadata.is_file() {
        return Err("Workspace path is not a file".to_owned());
    }

    write_file_atomically(&target, content.as_bytes())
}

pub(crate) fn reveal_workspace_file(
    root: String,
    path: String,
) -> Result<RevealWorkspaceFileResult, String> {
    let (_canonical_root, target) = resolve_workspace_file(&root, &path)?;
    #[cfg(target_os = "windows")]
    let ok = {
        let mut select_argument = OsString::from("/select,");
        select_argument.push(target.as_os_str());
        Command::new("explorer.exe")
            .arg(select_argument)
            .spawn()
            .is_ok()
    };

    #[cfg(target_os = "macos")]
    let ok = Command::new("open")
        .arg("-R")
        .arg(&target)
        .status()
        .is_ok_and(|status| status.success());

    #[cfg(all(unix, not(target_os = "macos")))]
    let ok = {
        let reveal_target = if target.is_dir() {
            target.as_path()
        } else {
            match target.parent() {
                Some(parent) => parent,
                None => target.as_path(),
            }
        };
        Command::new("xdg-open")
            .arg(reveal_target)
            .status()
            .is_ok_and(|status| status.success())
    };

    Ok(RevealWorkspaceFileResult { ok })
}

/// The directory one path names, when it names one this machine could open.
///
/// The canonical, checked form of the path, so what a launcher receives is a real directory rather
/// than a string that looks like one: `None` for every path that is not one - a file, a path that
/// is gone, a path that is not absolute, or one longer than any path this desktop accepts.
fn directory_to_open(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.len() > PATH_LIMIT {
        return None;
    }
    let target = Path::new(path);
    if !target.is_absolute() {
        return None;
    }
    let target = target.canonicalize().ok()?;
    target.is_dir().then(|| paths::plain_process_path(&target))
}

/// Open one directory in this machine's file manager, when the path names one.
///
/// A path the file panel is asked for is two things at once - a file it previews, and a directory
/// it cannot, whose read would answer only that it is not a file - and which one it is, only the
/// filesystem knows. So the page offers the path here first: a directory opens in the file
/// manager's own window and answers `true`. Everything else answers `false`, which leaves the path
/// to the preview's own read, in its own words: a file, a path that is gone, a path that is not
/// absolute, one longer than any path this desktop accepts, or a shell that refused the open.
/// Nothing here is an error, because "not a directory this machine would open" is a whole answer.
pub(crate) fn open_directory_in_file_manager(path: String) -> bool {
    directory_to_open(&path).is_some_and(|target| open_in_app::open_directory(&target))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::{
        directory_to_open, list_workspace_entries, read_workspace_file, write_workspace_file,
    };

    fn scratch(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("omp-wslist-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src/nested")).expect("workspace scratch");
        fs::write(root.join("package.json"), "{}").expect("workspace file");
        fs::write(root.join("AGENTS.md"), "# agents").expect("workspace file");
        fs::write(root.join("src/main.ts"), "").expect("workspace file");
        fs::create_dir_all(root.join("node_modules/pkg")).expect("ignored directory");
        fs::write(root.join("node_modules/pkg/index.js"), "").expect("ignored file");
        fs::create_dir_all(root.join("target/release")).expect("build directory");
        fs::write(root.join("target/release/omp-host.json"), "{}").expect("build artefact");
        fs::create_dir_all(root.join(".git/hooks")).expect("repository metadata");
        fs::write(root.join(".git/config"), "[core]").expect("git config");
        fs::write(root.join(".git/hooks/pre-commit"), "").expect("git hook");
        root
    }

    fn names(root: &Path, path: &str) -> Vec<(String, String)> {
        list_workspace_entries(root.to_string_lossy().into_owned(), path.to_owned())
            .expect("listing")
            .entries
            .into_iter()
            .map(|entry| (entry.name, entry.kind))
            .collect()
    }

    /// The composer's `@` picker browses a directory at a time, and it starts at the workspace
    /// root, which it asks for as `.`: directories first (so the first rows walk somewhere), then
    /// files, each alphabetical, with the ignored names left out.
    #[test]
    fn the_root_listing_leads_with_directories() {
        let root = scratch("root");
        assert_eq!(
            names(&root, "."),
            vec![
                ("src".to_owned(), "dir".to_owned()),
                ("AGENTS.md".to_owned(), "file".to_owned()),
                ("package.json".to_owned(), "file".to_owned()),
            ]
        );
    }

    /// Descending is one more listing of the directory the picker walked into.
    #[test]
    fn a_subdirectory_lists_its_own_entries() {
        let root = scratch("nested");
        assert_eq!(
            names(&root, "src"),
            vec![
                ("nested".to_owned(), "dir".to_owned()),
                ("main.ts".to_owned(), "file".to_owned()),
            ]
        );
    }

    /// A conversation's tool row can name a file anywhere on the machine, and the file panel opens
    /// it from that absolute path: the read answers with the same text a workspace read would, from
    /// a path no workspace root holds - and it is the only read that may.
    #[test]
    fn an_absolute_path_outside_every_root_is_readable() {
        let root = std::env::temp_dir().join(format!("omp-wsread-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("workspace")).expect("workspace scratch");
        let outside = root.join("outside.txt");
        fs::write(&outside, "静夜思").expect("file outside the root");

        let result = super::read_external_file(outside.to_string_lossy().into_owned())
            .expect("an absolute file is read");
        assert_eq!(result.kind, "text");
        assert_eq!(result.content.as_deref(), Some("静夜思"));

        // The workspace-relative read refuses the very same path, which is why this one exists.
        let root = root.join("workspace");
        assert!(super::read_workspace_file(
            root.to_string_lossy().into_owned(),
            outside.to_string_lossy().into_owned(),
        )
        .is_err());

        assert!(super::read_external_file("outside.txt".to_owned()).is_err());
        // A folder is not refused: the read answers what it is, so the page can open it as one.
        let folder = super::read_external_file(root.to_string_lossy().into_owned())
            .expect("an absolute directory is answered, not refused");
        assert_eq!(folder.kind, "directory");
        let _ = fs::remove_dir_all(&root);
    }

    /// The same distinction inside a workspace: a folder path a transcript printed is answered as a
    /// folder, and a workspace read of that path is not an error the preview has to draw.
    #[test]
    fn a_workspace_directory_is_answered_as_a_directory() {
        let root = scratch("directory-read");
        let result = read_workspace_file(root.to_string_lossy().into_owned(), "src".to_owned())
            .expect("a workspace directory is answered, not refused");
        assert_eq!(result.kind, "directory");
        // A file still reads as one, so the two answers are told apart by more than a message.
        let file = read_workspace_file(
            root.to_string_lossy().into_owned(),
            "src/main.ts".to_owned(),
        )
        .expect("an empty file is still a text read");
        assert_eq!(file.kind, "text");
        let _ = fs::remove_dir_all(&root);
    }

    /// Which paths are offered to the file manager at all: only a directory that exists. The open
    /// itself is not covered here - a test that reached it would open this machine's own window.
    #[test]
    fn only_a_directory_is_offered_to_the_file_manager() {
        let root = scratch("directory-to-open");
        assert!(directory_to_open(&root.to_string_lossy()).is_some());
        assert!(directory_to_open(&root.join("package.json").to_string_lossy()).is_none());
        assert!(directory_to_open(&root.join("gone.txt").to_string_lossy()).is_none());
        assert!(directory_to_open("src/nested").is_none());
        assert!(directory_to_open("").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    /// An answer prints the path of a file the tree stays out of (`target/`, `node_modules/`,
    /// `dist/`), and a click on that path reads and saves that one file: the browse policy is not
    /// an access policy. Browsing the same directory is still refused, so the tree keeps its rule.
    #[test]
    fn a_named_file_under_a_hidden_directory_is_still_readable() {
        let root = scratch("hidden-file");
        let root_path = root.to_string_lossy().into_owned();
        let hidden = "target/release/omp-host.json";

        let read = read_workspace_file(root_path.clone(), hidden.to_owned())
            .expect("a named file is read wherever it sits inside the root");
        assert_eq!(read.kind, "text");

        write_workspace_file(
            root_path.clone(),
            hidden.to_owned(),
            "{\"built\":1}".to_owned(),
        )
        .expect("a named file is saved wherever it sits inside the root");
        let read = read_workspace_file(root_path.clone(), hidden.to_owned()).expect("re-read");
        assert_eq!(read.content.as_deref(), Some("{\"built\":1}"));

        // The tree never lists the directory, and the browse resolver refuses to walk into it.
        assert!(list_workspace_entries(root_path.clone(), "target".to_owned()).is_err());
        assert!(!names(&root, ".").iter().any(|(name, _)| name == "target"));

        assert!(read_workspace_file(root_path.clone(), "../outside.txt".to_owned()).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    /// Repository metadata is the one hidden name a directly named path may not reach: `.git/config`
    /// and a hook are command lines the next git operation runs, not content a page reads or saves.
    /// Every access it could take — read, save, reveal — is refused, and the file keeps its bytes.
    #[test]
    fn a_named_path_never_reaches_repository_metadata() {
        let root = scratch("git-metadata");
        let root_path = root.to_string_lossy().into_owned();

        for path in [".git/config", ".git/hooks/pre-commit", ".git/HEAD"] {
            assert!(
                read_workspace_file(root_path.clone(), path.to_owned()).is_err(),
                "{path} is not content"
            );
            assert!(
                write_workspace_file(root_path.clone(), path.to_owned(), "x".to_owned()).is_err(),
                "{path} is not writable"
            );
        }
        assert!(super::reveal_workspace_file(root_path.clone(), ".git/config".to_owned()).is_err());

        // The listing hides the directory exactly as an ignored name, so the tree cannot reach it.
        assert!(!names(&root, ".").iter().any(|(name, _)| name == ".git"));
        assert_eq!(
            fs::read_to_string(root.join(".git/config")).expect("git config"),
            "[core]"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// A link that resolves to repository metadata is refused as what it resolves to, not as the
    /// name it was spelled with. A junction is the one directory link a non-elevated Windows
    /// account can create — `symlink_dir` needs a privilege this suite does not hold — and Unix
    /// uses a symlink, skipping if the filesystem refuses one.
    #[test]
    fn a_link_to_repository_metadata_is_refused() {
        let root = scratch("git-alias");
        let link = root.join("alias");
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(root.join(".git"), &link).is_ok();
        #[cfg(windows)]
        let created = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(root.join(".git"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        #[cfg(windows)]
        assert!(created, "a junction requires no privilege on NTFS");

        if created {
            let root_path = root.to_string_lossy().into_owned();
            assert!(read_workspace_file(root_path.clone(), "alias/config".to_owned()).is_err());
            assert!(
                write_workspace_file(root_path, "alias/config".to_owned(), "x".to_owned()).is_err()
            );
            assert_eq!(
                fs::read_to_string(root.join(".git/config")).expect("git config"),
                "[core]"
            );
        }

        let _ = fs::remove_dir_all(&root);
    }

    /// The editor's save: the bytes the caller hands in are exactly what the next read answers,
    /// including the file's own CRLF endings, the temporary copy the swap goes through is gone, and
    /// a path that escapes the root or a payload past the read limit is refused before any write.
    #[test]
    fn a_save_replaces_the_file_and_leaves_no_temporary_copy() {
        let root = scratch("write");
        let root_path = root.to_string_lossy().into_owned();

        write_workspace_file(
            root_path.clone(),
            "src/main.ts".to_owned(),
            "const a = 1\r\n".to_owned(),
        )
        .expect("workspace write");
        let read = read_workspace_file(root_path.clone(), "src/main.ts".to_owned())
            .expect("workspace read");
        assert_eq!(read.kind, "text");
        assert_eq!(read.content.as_deref(), Some("const a = 1\r\n"));

        let leftovers = fs::read_dir(root.join("src"))
            .expect("workspace directory")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect::<Vec<_>>();
        assert!(
            leftovers.is_empty(),
            "temporary copies left behind: {leftovers:?}"
        );

        assert!(write_workspace_file(
            root_path.clone(),
            "../outside.txt".to_owned(),
            "x".to_owned(),
        )
        .is_err());
        assert!(write_workspace_file(
            root_path.clone(),
            "src/main.ts".to_owned(),
            "x".repeat(super::TEXT_LIMIT + 1),
        )
        .is_err());
        assert!(write_workspace_file(root_path, "src".to_owned(), "x".to_owned()).is_err());

        let _ = fs::remove_dir_all(&root);
    }
}

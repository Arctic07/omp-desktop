use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::models::agent::ChatAttachmentRef;
use crate::models::{ComposerAttachment, ComposerPasteFile, ImportComposerFilesResult};

const SAFE_SESSION_ID_MAX: usize = 64;
const MAX_FILE_BYTES: u64 = 24 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 48 * 1024 * 1024;
const OUTPUT_ATTEMPTS: usize = 8;
const INVALID_SESSION_ID: &str = "invalid session id";
const WRITE_FAILED: &str = "attachment file could not be written";

/// Ceiling for the whole copy store, across every scope.
const SCRATCH_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// Ceiling on how many copies it may hold, whatever their size.
const SCRATCH_MAX_FILES: usize = 2_000;
/// How long an untouched copy survives even while the store is nowhere near its ceilings.
const SCRATCH_MAX_AGE_SECS: u64 = 30 * 24 * 60 * 60;

static OUTPUT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const IMAGE_EXTENSIONS: &[&str] = &[
    ".avif", ".bmp", ".gif", ".heic", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp",
];

struct PreparedPaste {
    bytes: Vec<u8>,
    name: String,
    mime_type: String,
}

fn is_safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.chars().count() <= SAFE_SESSION_ID_MAX
        && session_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
}

/// Session scratch directory inside the host's attachment root (`<dataRoot>/scratch`, the
/// single owner of that location). `session_id` is validated before this is used, so the
/// joined path can never escape the root.
fn scratch_root(scratch: &Path, session_id: &str) -> PathBuf {
    scratch.join(session_id).join("pasted")
}

fn lowercase_extension(value: &str) -> Option<String> {
    Path::new(value)
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
        .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
}

fn extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/gif" => ".gif",
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/tiff" => ".tiff",
        "image/webp" => ".webp",
        "text/csv" => ".csv",
        "text/html" => ".html",
        "text/plain" => ".txt",
        "application/json" => ".json",
        "application/pdf" => ".pdf",
        "application/zip" => ".zip",
        _ => ".bin",
    }
}

fn mime_type_for_path(path: &Path) -> String {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_ascii_lowercase()));
    match extension.as_deref() {
        Some(".avif") => "image/avif",
        Some(".bmp") => "image/bmp",
        Some(".gif") => "image/gif",
        Some(".heic") => "image/heic",
        Some(".jpeg") | Some(".jpg") => "image/jpeg",
        Some(".png") => "image/png",
        Some(".tif") | Some(".tiff") => "image/tiff",
        Some(".webp") => "image/webp",
        Some(".csv") => "text/csv",
        Some(".html") => "text/html",
        Some(".txt") => "text/plain",
        Some(".json") => "application/json",
        Some(".pdf") => "application/pdf",
        Some(".zip") => "application/zip",
        _ => "application/octet-stream",
    }
    .to_owned()
}

fn normalize_mime_type(mime_type: Option<&str>) -> String {
    match mime_type.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_ascii_lowercase(),
        None => "application/octet-stream".to_owned(),
    }
}

fn has_image_extension(name: &str) -> bool {
    lowercase_extension(name)
        .is_some_and(|extension| IMAGE_EXTENSIONS.contains(&extension.as_str()))
}

fn attachment_kind(name: &str, mime_type: &str) -> String {
    if mime_type.starts_with("image/") || has_image_extension(name) {
        "image".to_owned()
    } else {
        "file".to_owned()
    }
}

/// Reduce renderer-provided metadata to a leaf name that cannot escape the
/// scratch directory or collide with another entry.
fn sanitize_file_name(name: Option<&str>, mime_type: &str, index: usize) -> String {
    let normalized = name.unwrap_or("").replace('\\', "/");
    let leaf = Path::new(&normalized)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let mut sanitized = String::with_capacity(leaf.len());
    for value in leaf.chars() {
        if value.is_alphanumeric() || value == '.' || value == '_' || value == '-' {
            sanitized.push(value);
        } else {
            sanitized.push('_');
        }
    }
    if !sanitized.is_empty() && sanitized.chars().all(|value| value == '.') {
        sanitized.clear();
    }
    let candidate = if sanitized.is_empty() {
        format!("pasted-file-{}", index + 1)
    } else {
        sanitized
    };
    if lowercase_extension(&candidate).is_some() {
        candidate
    } else {
        format!("{candidate}{}", extension_for_mime(mime_type))
    }
}

fn plain_path_string(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    if let Some(stripped) = value.strip_prefix("\\\\?\\") {
        return stripped.to_owned();
    }
    value
}

/// Create the attachment file under `root`, preferring the caller's leaf name.
/// `create_new` guarantees exclusivity, so an existing file is never
/// overwritten: a collision retries with the next sequence value appended
/// before the extension.
fn create_output_file(root: &Path, name: &str) -> Result<(PathBuf, File), String> {
    let direct = root.join(name);
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&direct)
    {
        Ok(file) => return Ok((direct, file)),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(_) => return Err(WRITE_FAILED.to_owned()),
    }
    for _ in 0..OUTPUT_ATTEMPTS {
        let sequence = OUTPUT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = match name.rsplit_once('.') {
            Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() => {
                format!("{stem}-{sequence}.{extension}")
            }
            _ => format!("{name}-{sequence}"),
        };
        let path = root.join(candidate);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(WRITE_FAILED.to_owned()),
        }
    }
    Err(WRITE_FAILED.to_owned())
}

/// Drop the files a failed paste already produced, so a refusal leaves no half-written set behind.
fn cleanup_written(paths: &[PathBuf]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

/// Whether `name` is the suffixed collision name `create_output_file` writes for `base`:
/// `stem-<digits><extension>`, with the base's own extension preserved.
fn is_collision_name(name: &str, base: &str) -> bool {
    let (base_stem, base_extension) = split_extension(base);
    let (candidate_stem, candidate_extension) = split_extension(name);
    if base_extension != candidate_extension {
        return false;
    }
    let Some(digits) = candidate_stem
        .strip_prefix(base_stem)
        .and_then(|suffix| suffix.strip_prefix('-'))
    else {
        return false;
    };
    !digits.is_empty() && digits.chars().all(|value| value.is_ascii_digit())
}

/// `("name", ".ext")` for `name.ext`, and `("name", "")` when the name has no extension.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() => {
            (stem, &name[stem.len()..])
        }
        _ => (name, ""),
    }
}

/// The already-staged file in this scope that holds exactly this content, if there is one.
///
/// Reuse is what keeps one paste one file. A reader who pastes the same bytes twice would otherwise
/// own two identical copies, and the copy the agent edits can be the one they are not looking at;
/// matching by content means the second paste lands on the path the first one already has. The name
/// must match too: a name held by *different* bytes is a different attachment and still gets its own
/// suffixed file.
fn staged_match<F>(root: &Path, base: &str, equals: F) -> Option<PathBuf>
where
    F: Fn(&Path) -> bool,
{
    let direct = root.join(base);
    if equals(&direct) {
        return Some(direct);
    }
    for entry in fs::read_dir(root).ok()?.flatten() {
        let candidate = entry.path();
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if is_collision_name(&file_name, base) && equals(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn prepare_root(scratch: &Path, session_id: &str) -> Result<PathBuf, String> {
    let root = scratch_root(scratch, session_id);
    fs::create_dir_all(&root)
        .map_err(|_| "attachment directory could not be created".to_owned())?;
    Ok(root)
}

/// What one sweep of the copy store reclaimed.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ScratchSweep {
    pub(crate) files: usize,
    pub(crate) bytes: u64,
}

impl ScratchSweep {
    fn add(&mut self, other: Self) {
        self.files += other.files;
        self.bytes = self.bytes.saturating_add(other.bytes);
    }
}

/// One staged copy the store holds: where it is, how big it is, when it was last touched.
struct ScratchEntry {
    path: PathBuf,
    size: u64,
    touched: u64,
}

/// How long a top-level directory that is not a paste scope survives.
///
/// `scratch` holds two shapes. `<session>/pasted/` is the copy store and is governed by the three
/// ceilings above. Everything else at the top level belongs to another feature that made a working
/// directory there and removes it itself - `open-in-app-<pid>-<sequence>`, which the icon extractor
/// drops on every path including its failures (`services::open_in_app::icons::WorkDir`). A `Drop`
/// does not run when the process is killed (measured: eight of them, the oldest ten to twelve days
/// at the time this rule was written), so the sweep is what reclaims those.
///
/// Seven days, not the copies' thirty: the directory holds a PowerShell script and a PNG from one
/// extraction that has long finished, and nothing in it is anything a reader ever sees - an
/// abandoned one is dead weight from the second the process died.
const ORPHAN_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;

/// How many entries one orphan directory may be walked over before its size is an estimate.
///
/// These carry two or three files, so the bound is only there to keep a pathological tree (a
/// directory an extractor filled and never cleaned) from holding the start-up path.
const ORPHAN_MAX_ENTRIES: usize = 4_096;

/// Reclaim the copies the store must not keep, and the working directories around it.
///
/// The store only grows through pastes, and nothing else in this process owns `scratch`, so it is
/// held to its own terms: copies untouched for [`SCRATCH_MAX_AGE_SECS`] go first, and if the
/// survivors still exceed a ceiling the oldest of them go too, oldest first, until the store fits.
/// A scope directory the sweep emptied goes with its last copy. In the same pass, a top-level
/// directory that is not a paste scope and has not been written to for [`ORPHAN_MAX_AGE_SECS`] goes
/// whole (`sweep_orphan`).
pub(crate) fn collect_scratch(scratch: &Path) -> ScratchSweep {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    sweep_scratch(
        scratch,
        now,
        SCRATCH_MAX_BYTES,
        SCRATCH_MAX_FILES,
        SCRATCH_MAX_AGE_SECS,
        ORPHAN_MAX_AGE_SECS,
    )
}

/// The sweep itself. Clock and ceilings are arguments so a test can drive it without waiting for
/// either.
fn sweep_scratch(
    scratch: &Path,
    now: u64,
    max_bytes: u64,
    max_files: usize,
    max_age_secs: u64,
    orphan_age_secs: u64,
) -> ScratchSweep {
    let Ok(scopes) = fs::read_dir(scratch) else {
        return ScratchSweep::default();
    };
    let mut entries: Vec<ScratchEntry> = Vec::new();
    let mut sweep = ScratchSweep::default();
    for scope in scopes.flatten() {
        // A directory with no `pasted` inside it is another feature's working directory, not the
        // copy store: `<scope>/pasted` is the only shape pastes ever write.
        if !scope.path().join("pasted").is_dir() {
            sweep.add(sweep_orphan(&scope.path(), now, orphan_age_secs));
            continue;
        }
        let Ok(files) = fs::read_dir(scope.path().join("pasted")) else {
            continue;
        };
        for file in files.flatten() {
            let Ok(metadata) = file.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let touched = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_secs())
                .unwrap_or_default();
            entries.push(ScratchEntry {
                path: file.path(),
                size: metadata.len(),
                touched,
            });
        }
    }
    // Oldest first; the path breaks a tie, so what gets evicted never depends on directory order.
    entries.sort_by(|left, right| {
        left.touched
            .cmp(&right.touched)
            .then_with(|| left.path.cmp(&right.path))
    });

    let mut kept_bytes: u64 = entries.iter().map(|entry| entry.size).sum();
    let mut kept: usize = entries.len();
    for entry in &entries {
        let past_retention = now.saturating_sub(entry.touched) > max_age_secs;
        // A later entry is always newer than this one, so once neither reason to reclaim applies
        // here, none of them applies to the rest either.
        if !past_retention && kept_bytes <= max_bytes && kept <= max_files {
            break;
        }
        if fs::remove_file(&entry.path).is_ok() {
            sweep.files += 1;
            sweep.bytes += entry.size;
            kept_bytes -= entry.size;
            kept -= 1;
        }
    }
    if sweep.files > 0 {
        remove_empty_scopes(scratch);
    }
    sweep
}

/// Removes one working directory that is past its age, answering what it reclaimed.
///
/// The age is the newest write anywhere inside it, not the directory's own stamp: creating a file
/// is what moves a directory's mtime, so an extraction that wrote its script and then spent a while
/// reading a bundle back would look older than it is. A directory that cannot be read is left alone
/// - it is not this sweep's to guess about.
fn sweep_orphan(dir: &Path, now: u64, max_age_secs: u64) -> ScratchSweep {
    let mut newest = 0;
    let mut bytes = 0u64;
    let mut files = 0usize;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        if files >= ORPHAN_MAX_ENTRIES {
            break;
        }
        let Ok(read) = fs::read_dir(&next) else {
            continue;
        };
        for entry in read.flatten() {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let touched = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_secs())
                .unwrap_or_default();
            newest = newest.max(touched);
            if metadata.is_dir() {
                stack.push(entry.path());
            } else {
                files += 1;
                bytes = bytes.saturating_add(metadata.len());
            }
        }
    }
    if now.saturating_sub(newest) <= max_age_secs {
        return ScratchSweep::default();
    }
    if fs::remove_dir_all(dir).is_err() {
        return ScratchSweep::default();
    }
    ScratchSweep { files, bytes }
}

/// Drop the directories a sweep emptied, so the store keeps no shell of a scope it cleared.
///
/// Two shapes: a scope whose `pasted` is now empty (the copy store's own), and a top-level
/// directory left with nothing in it at all.
fn remove_empty_scopes(scratch: &Path) {
    let Ok(scopes) = fs::read_dir(scratch) else {
        return;
    };
    for scope in scopes.flatten() {
        let path = scope.path();
        let pasted = path.join("pasted");
        if fs::read_dir(&pasted).is_ok_and(|mut files| files.next().is_none()) {
            let _ = fs::remove_dir(&pasted);
        }
        if fs::read_dir(&path).is_ok_and(|mut entries| entries.next().is_none()) {
            let _ = fs::remove_dir(&path);
        }
    }
}

/// Materialize renderer clipboard bytes in the session scratch directory.
/// Names are reduced to leaf names and every output receives a unique prefix,
/// so renderer-provided metadata cannot escape or overwrite another paste.
pub(crate) fn save_composer_paste(
    scratch: &Path,
    session_id: &str,
    files: Vec<ComposerPasteFile>,
) -> Result<Vec<ComposerAttachment>, String> {
    if !is_safe_session_id(session_id) {
        return Err(INVALID_SESSION_ID.to_owned());
    }
    if files.is_empty() {
        return Ok(Vec::new());
    }

    let mut total_bytes: u64 = 0;
    let mut prepared: Vec<PreparedPaste> = Vec::with_capacity(files.len());
    for (index, file) in files.into_iter().enumerate() {
        let bytes = STANDARD
            .decode(file.data.as_bytes())
            .map_err(|_| "pasted file data is invalid".to_owned())?;
        let size = bytes.len() as u64;
        if size > MAX_FILE_BYTES {
            return Err(format!(
                "pasted file is too large (maximum {MAX_FILE_BYTES} bytes)"
            ));
        }
        total_bytes = total_bytes.saturating_add(size);
        if total_bytes > MAX_TOTAL_BYTES {
            return Err(format!(
                "pasted files are too large (maximum {MAX_TOTAL_BYTES} bytes)"
            ));
        }
        let mime_type = normalize_mime_type(file.mime_type.as_deref());
        let name = sanitize_file_name(file.name.as_deref(), &mime_type, index);
        prepared.push(PreparedPaste {
            bytes,
            name,
            mime_type,
        });
    }

    let root = prepare_root(scratch, session_id)?;
    let mut written: Vec<PathBuf> = Vec::with_capacity(prepared.len());
    let mut attachments: Vec<ComposerAttachment> = Vec::with_capacity(prepared.len());
    for item in prepared {
        let kind = attachment_kind(&item.name, &item.mime_type);
        // The same bytes the same reader pasted before are already staged: reuse that file rather
        // than write a second copy of it, so the chip, the prompt and the agent all name one path.
        let path = match staged_match(&root, &item.name, |candidate| {
            fs::read(candidate).is_ok_and(|existing| existing == item.bytes)
        }) {
            Some(existing) => existing,
            None => {
                let (path, mut file) = match create_output_file(&root, &item.name) {
                    Ok(value) => value,
                    Err(error) => {
                        cleanup_written(&written);
                        return Err(error);
                    }
                };
                written.push(path.clone());
                if file.write_all(&item.bytes).is_err() {
                    cleanup_written(&written);
                    return Err(WRITE_FAILED.to_owned());
                }
                path
            }
        };
        attachments.push(ComposerAttachment {
            path: plain_path_string(&path),
            name: item.name,
            kind,
            mime_type: item.mime_type,
            size: item.bytes.len() as u64,
        });
    }
    // Growing the store is the moment to hold it to its ceilings; a copy written just now is the
    // newest entry in it and is evicted last.
    collect_scratch(scratch);
    Ok(attachments)
}

/// One file the prompt names, as the record a row reads: the file itself, where it lives.
///
/// The same three facts the picker's own import records (`import_composer_files`): the leaf name,
/// the MIME type the extension names, and the file's size - `0` when it cannot be read, which is a
/// file that is no longer there. A conversation read builds its attachments through this
/// (`services/runtime/history.rs`), so a message read back from the transcript names its files the
/// way the same message did while it was being written.
pub(crate) fn reference_for_path(path: &str) -> ChatAttachmentRef {
    let source = Path::new(path);
    let name = source
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    ChatAttachmentRef {
        name,
        mime_type: mime_type_for_path(source),
        bytes: fs::metadata(source).map(|value| value.len()).unwrap_or(0),
        path: plain_path_string(source),
    }
}

/// Resolve native-picker selections into attachment records that name the files themselves.
///
/// The engine reads a file mention from the path the prompt carries, and a tool that edits it
/// writes that same path back — so the record has to be the file the user picked. An earlier
/// revision copied every selection into the session scratch directory instead; the agent then
/// rewrote the copy and the user's own file never changed, while the tool reported success against
/// a path the user was not looking at. Clipboard bytes still get a scratch file (there is no path
/// behind them), but a file on disk is referenced where it lives.
///
/// The renderer's word is not evidence, so each path is re-checked here: absolute, existing,
/// a regular file, and within the size budget a model's context can carry.
pub(crate) fn import_composer_files(
    paths: Vec<String>,
) -> Result<ImportComposerFilesResult, String> {
    let mut skipped_directories: usize = 0;
    let mut total_bytes: u64 = 0;
    let mut files: Vec<ComposerAttachment> = Vec::with_capacity(paths.len());
    for (index, raw_path) in paths.iter().enumerate() {
        let requested = raw_path.trim();
        if requested.is_empty() {
            return Err("import file path is invalid".to_owned());
        }
        let source = Path::new(requested);
        if !source.is_absolute() {
            return Err("import file path must be absolute".to_owned());
        }
        let metadata = match fs::metadata(source) {
            Ok(value) => value,
            Err(_) => return Err("import file was not found".to_owned()),
        };
        if metadata.is_dir() {
            skipped_directories += 1;
            continue;
        }
        if !metadata.is_file() {
            return Err("selected path is not a file".to_owned());
        }
        let size = metadata.len();
        if size > MAX_FILE_BYTES {
            return Err(format!(
                "imported file is too large (maximum {MAX_FILE_BYTES} bytes)"
            ));
        }
        total_bytes = total_bytes.saturating_add(size);
        if total_bytes > MAX_TOTAL_BYTES {
            return Err(format!(
                "imported files are too large (maximum {MAX_TOTAL_BYTES} bytes)"
            ));
        }
        let mime_type = mime_type_for_path(source);
        // The label is the file's own name: the path is already a leaf of the user's selection,
        // and the synthetic extension `sanitize_file_name` adds for a clipboard payload has no
        // scratch file to match here - it would only relabel a file the user can see.
        let name = match source.file_name() {
            Some(value) => value.to_string_lossy().into_owned(),
            None => format!("attachment-{}", index + 1),
        };
        let kind = attachment_kind(&name, &mime_type);
        files.push(ComposerAttachment {
            path: plain_path_string(source),
            name,
            kind,
            mime_type,
            size,
        });
    }
    Ok(ImportComposerFilesResult {
        files,
        skipped_directories,
    })
}
#[cfg(test)]
mod output_name_tests {
    use base64::Engine as _;

    use super::{
        create_output_file, import_composer_files, is_collision_name, save_composer_paste, STANDARD,
    };

    /// A picked file is referenced where it lives. The record names the file the user chose, so the
    /// engine reads that path and a tool that edits it writes the user's own file - the copy this
    /// used to stage was the one the agent edited while the original stayed untouched. A folder is
    /// still refused as an attachment rather than failing the whole pick.
    #[test]
    fn picked_files_are_referenced_where_they_live() {
        let root = std::env::temp_dir().join(format!("omp-attach-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("folder")).expect("picked folder");
        let content = "123\n";
        std::fs::write(root.join("notes.md"), content).expect("picked file");
        // A dotfile has no extension for `mime_type_for_path` to match; the label stays the name.
        std::fs::write(root.join(".editorconfig"), "root = true\n").expect("picked dotfile");
        let picked = root.join("notes.md");

        let imported = import_composer_files(vec![
            picked.to_string_lossy().into_owned(),
            root.join(".editorconfig").to_string_lossy().into_owned(),
            root.join("folder").to_string_lossy().into_owned(),
        ])
        .expect("picked files");

        assert_eq!(imported.skipped_directories, 1);
        assert_eq!(imported.files.len(), 2);
        assert_eq!(imported.files[0].path, picked.to_string_lossy());
        assert_eq!(imported.files[0].name, "notes.md");
        assert_eq!(imported.files[0].size, content.len() as u64);
        assert_eq!(imported.files[1].name, ".editorconfig");
        // Untouched: the record points at the file, so no copy of it was made next to it.
        assert_eq!(
            std::fs::read(&picked).expect("readable"),
            content.as_bytes()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The same paste belongs to one file: attaching identical bytes again reuses the copy the
    /// first attach made, so the chip, the prompt and the agent name one path - while different
    /// bytes under the same name still get their own file.
    #[test]
    fn identical_pastes_share_one_staged_file() {
        let session = format!("dedupe-{}", std::process::id());
        let root = std::env::temp_dir().join(format!("omp-attach-dedupe-{}", std::process::id()));
        let paste = |text: &str| {
            vec![crate::models::ComposerPasteFile {
                name: Some("test.txt".to_owned()),
                mime_type: Some("text/plain".to_owned()),
                data: STANDARD.encode(text),
            }]
        };
        let first = save_composer_paste(&root, &session, paste("123")).expect("first paste");
        let second = save_composer_paste(&root, &session, paste("123")).expect("repeat paste");
        let third = save_composer_paste(&root, &session, paste("other")).expect("different paste");
        assert_eq!(first[0].path, second[0].path);
        assert_ne!(first[0].path, third[0].path);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A collision name is `<stem>-<digits><extension>` and nothing else, so a sibling that merely
    /// starts with the same stem is never mistaken for the same attachment.
    #[test]
    fn collision_names_are_recognised() {
        assert!(is_collision_name("test-0.txt", "test.txt"));
        assert!(is_collision_name("test-12.txt", "test.txt"));
        assert!(is_collision_name("noext-3", "noext"));
        assert!(!is_collision_name("test.txt", "test.txt"));
        assert!(!is_collision_name("test-0.md", "test.txt"));
        assert!(!is_collision_name("other-0.txt", "test.txt"));
        assert!(!is_collision_name("noext-", "noext"));
    }

    #[test]
    fn keeps_leaf_name_and_suffixes_collisions() {
        let root = std::env::temp_dir().join(format!("omp-attach-probe-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("probe dir");
        let (first, _) = create_output_file(&root, "image.png").expect("first");
        let (second, _) = create_output_file(&root, "image.png").expect("second");
        let (third, _) = create_output_file(&root, "image.png").expect("third");
        assert_eq!(first.file_name().unwrap(), "image.png");
        assert_ne!(second.file_name().unwrap(), "image.png");
        assert!(second.to_string_lossy().ends_with(".png"));
        assert_ne!(second.file_name().unwrap(), third.file_name().unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn accepts_more_files_than_the_old_count_limit() {
        let session = format!("probe-{}", std::process::id());
        let files = (0..40)
            .map(|index| crate::models::ComposerPasteFile {
                name: Some(format!("file-{index}.png")),
                mime_type: Some("image/png".to_owned()),
                data: "YWJj".to_owned(),
            })
            .collect::<Vec<_>>();
        let root = std::env::temp_dir().join(format!("omp-attach-root-{}", std::process::id()));
        let saved = super::save_composer_paste(&root, &session, files).expect("40 pasted files");
        assert_eq!(saved.len(), 40);
        assert!(saved
            .iter()
            .all(|attachment| attachment.path.contains("omp-attach-root-")));
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod scratch_tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::{sweep_scratch, ScratchSweep};

    /// Fixed clock so the sweep's arithmetic is the only thing under test.
    const NOW: u64 = 1_700_000_000;
    const DAY: u64 = 24 * 60 * 60;

    fn staged(root: &Path, scope: &str, name: &str, bytes: usize, touched_secs: u64) -> PathBuf {
        let dir = root.join(scope).join("pasted");
        fs::create_dir_all(&dir).expect("scope directory");
        let path = dir.join(name);
        fs::write(&path, vec![b'x'; bytes]).expect("staged copy");
        let handle = fs::File::options()
            .write(true)
            .open(&path)
            .expect("open copy");
        handle
            .set_modified(UNIX_EPOCH + Duration::from_secs(touched_secs))
            .expect("set mtime");
        path
    }

    /// A copy nobody has touched inside the retention window is reclaimed, and the scope directory
    /// it was the last occupant of goes with it - while a copy inside the window stays.
    #[test]
    fn copies_past_their_retention_are_reclaimed_with_their_scope() {
        let root = std::env::temp_dir().join(format!("omp-scratch-age-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let stale = staged(&root, "old-scope", "stale.txt", 64, NOW - 8 * DAY);
        let fresh = staged(&root, "live-scope", "fresh.txt", 64, NOW - 60);

        let sweep = sweep_scratch(&root, NOW, 1024, 100, 7 * DAY, 7 * DAY);

        assert_eq!(
            sweep,
            ScratchSweep {
                files: 1,
                bytes: 64
            }
        );
        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(!root.join("old-scope").exists(), "its empty scope goes too");
        assert!(root.join("live-scope").join("pasted").is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    /// The store is bounded: over its byte ceiling the oldest copies go first, so the newest copy -
    /// the one the conversation that just pasted it still refers to - survives.
    #[test]
    fn the_oldest_copies_go_first_when_the_store_is_over_its_ceiling() {
        let root = std::env::temp_dir().join(format!("omp-scratch-cap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let oldest = staged(&root, "scope", "oldest.txt", 100, NOW - 300);
        let middle = staged(&root, "scope", "middle.txt", 100, NOW - 200);
        let newest = staged(&root, "scope", "newest.txt", 100, NOW - 100);

        let sweep = sweep_scratch(&root, NOW, 100, 100, 365 * DAY, 7 * DAY);

        assert_eq!(
            sweep,
            ScratchSweep {
                files: 2,
                bytes: 200
            }
        );
        assert!(!oldest.exists());
        assert!(!middle.exists());
        assert!(newest.exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// A store inside every limit is left exactly as it is.
    #[test]
    fn a_store_within_its_limits_is_left_alone() {
        let root = std::env::temp_dir().join(format!("omp-scratch-clean-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        // The real clock here: the point of the case is that a recent store survives a sweep that
        // uses the same clock the application does.
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or_default();
        staged(&root, "scope", "one.txt", 32, now - 600);
        staged(&root, "scope", "two.txt", 32, now - 300);

        let sweep = sweep_scratch(&root, now, 1024, 100, 7 * DAY, 7 * DAY);

        assert_eq!(sweep, ScratchSweep::default());
        assert!(root.join("scope").join("pasted").join("one.txt").exists());
        assert!(root.join("scope").join("pasted").join("two.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// A working directory another feature left behind - no `pasted` in it - is reclaimed whole once
    /// it is past the orphan window, which is what a killed icon extraction leaves.
    #[test]
    fn a_working_directory_past_its_window_goes_whole() {
        let root = std::env::temp_dir().join(format!("omp-scratch-orphan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let stale = orphan(&root, "open-in-app-99-0", NOW - 9 * DAY, 128);
        let live = orphan(&root, "open-in-app-99-1", NOW - 3 * DAY, 128);

        let sweep = sweep_scratch(&root, NOW, 1024, 100, 30 * DAY, 7 * DAY);

        assert_eq!(
            sweep,
            ScratchSweep {
                files: 1,
                bytes: 128
            }
        );
        assert!(!stale.exists(), "the abandoned extraction is gone");
        assert!(
            live.exists(),
            "one this process could still be writing stays"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// A paste scope is judged by the copy rules alone: its `pasted` files survive however old the
    /// scope directory is, and a copy five days old stays.
    #[test]
    fn a_scope_inside_the_copy_rules_keeps_its_copies() {
        let root = std::env::temp_dir().join(format!("omp-scratch-draft-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let recent = staged(&root, "session-a", "five-days.txt", 64, NOW - 5 * DAY);

        let sweep = sweep_scratch(&root, NOW, 1024, 100, 30 * DAY, 7 * DAY);

        assert_eq!(sweep, ScratchSweep::default());
        assert!(recent.exists(), "inside the thirty-day window");
        assert!(root.join("session-a").join("pasted").is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    /// One directory of `bytes` at `name`, stamped `touched` in the epoch, with one file in it.
    fn orphan(root: &Path, name: &str, touched: u64, bytes: usize) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).expect("a working directory");
        let file = dir.join("icon.png");
        fs::write(&file, vec![b'x'; bytes]).expect("a file");
        fs::File::options()
            .write(true)
            .open(&file)
            .expect("open the file")
            .set_modified(UNIX_EPOCH + Duration::from_secs(touched))
            .expect("set mtime");
        dir
    }
}

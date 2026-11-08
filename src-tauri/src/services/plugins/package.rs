//! The local plugin package: what the user picked from disk (`.omp.zip`, or the compatible
//! `.piplug`), unpacked under this application's own `plugin-imports` directory and described as the
//! one-entry catalogue the engine's own marketplace channel installs from.
//!
//! The engine cannot install a package file: its install paths are a pasted source (npm spec, git
//! URL, local directory) and a marketplace entry (`PluginManager.install` / `MarketplaceManager`,
//! spec §2.3). The marketplace route is the one that needs no symlink privilege on Windows - it
//! copies the package into the engine's own cache and junctions it into `node_modules` - so a
//! package file is served through it: unpack, write a catalogue beside the unpacked package, let the
//! host add that catalogue as a marketplace, and install `name@catalogue`.
//!
//! The unpacked copy and its catalogue **stay** (`<dataRoot>/plugin-imports/<catalogue>`), because
//! they are the marketplace the plugin was installed from: deleting them would leave an installation
//! nobody can upgrade (spec §2.3). Keeping them is what makes the engine's own version rule apply to
//! an imported plugin at all - `plugins_check_updates` compares the catalogue's version against the
//! installed one, and an upgrade installs from that same catalogue. A re-import promotes the newer
//! unpack over the old one, so the catalogue always describes the last package the user picked.
//!
//! Nothing here re-decides what a plugin is. The manifest's `name`, `version` and `description` are
//! read as the engine reads them, and the catalogue this module writes is the engine's own format
//! (`MarketplaceCatalog`, `marketplace/fetcher.ts`), because the host hands it straight to the
//! engine's parser: `name` and `plugins[].name` are name segments, and `plugins[].source` is a
//! `./`-relative path (spec §2.3, §3.1).
//!
//! What the *file* has to satisfy is not this module's subject: the bounds, the path check on every
//! entry and the checksum list live in [`guards`], which the unpacking below calls before it writes
//! anything, and a refusal there removes what was written rather than leaving a half-unpacked tree
//! behind.
//!
//! **Unix permission bits.** An archive records each entry's own mode, and a package that ships an
//! executable (a skill's script, an MCP stdio binary) is installed broken without it, so [`unpack`]
//! restores `mode & 0o777` on every file and directory it writes. The mapping from an entry's mode
//! to the bits that are written is the cross-platform [`writable_mode`]; only the `chmod` syscall
//! itself is behind `#[cfg(unix)]` ([`apply_entry_mode`]). The assertion that the bits actually
//! landed is an integration check on the filesystem, so it lives in `#[cfg(unix)] mod unix_tests` and
//! does **not** run on a Windows development machine: the permission behaviour must be verified on a
//! Unix CI. Setuid, setgid and sticky bits are never written - the mode is masked to `0o777` - and
//! link entries are refused before this point.
//!
//! **Leftover staging directories.** A crashed import leaves a `.staging-*` directory behind; the
//! next import sweeps the ones older than [`STAGING_MAX_AGE`] on its way in (see
//! [`sweep_stale_staging`]), and the start-up path sweeps *all* of them once ([`sweep_staging`]),
//! which is what keeps them from accumulating across runs. A partial download
//! ([`download_staging_path`]) is named with the same prefix, so the same sweep covers it.
//!
//! **Promotion is ordered, not overwritten.** [`promote`] moves the staged tree to a temporary name
//! beside its target, removes the previous import, and gives the new one the target's name last
//! (`PromoteStep`/`PromoteRollback`): a failure at any step leaves either the previous import or a
//! named half-product the sweep will take, never a directory that is half old and half new.
//!
//! **A package can be read without being installed** ([`inspect`], in `package/inspect.rs`): the
//! preview the "install from file" confirmation card is drawn from unpacks into a staging directory,
//! reads what the manifest declares and what the guards found, and deletes the tree - nothing is
//! registered, promoted or installed.

mod guards;
mod inspect;

use std::fs::{self, File};
use std::io::{self, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use zip::ZipArchive;

use crate::errors::{IpcError, IpcResult, INVALID_PACKAGE_PATH, PLUGIN_PACKAGE_INVALID};

pub(crate) use guards::PackageRefusal;
use guards::{
    copy_bounded, digest_of, io_refusal, quoted, safe_relative, verify_checksums,
    MAX_ARCHIVE_BYTES, MAX_ENTRIES,
};
pub(crate) use inspect::{inspect, PackageInspection};

/// The suffixes a package file may carry: this application's own (`.omp.zip`) and the one the reference client
/// exports (`.piplug`), so a package can move between the two desktop clients.
pub(crate) const PACKAGE_SUFFIXES: [&str; 2] = [".omp.zip", ".piplug"];

/// The directory the archive's own tree is unpacked into, inside the staging directory.
const PACKAGE_ROOT_DIR: &str = "package";
/// Longest package name this layer forwards: the engine's name segment is far shorter, and the
/// catalogue name is built by appending a suffix to it.
const NAME_MAX_CHARS: usize = 60;
/// Who the generated catalogue names as its owner. It is this application's own catalogue, so the
/// owner is the application rather than the plugin's author.
const CATALOG_OWNER: &str = "OMP Desktop";
/// What is appended to a package name to name the catalogue it is installed from. Deterministic, so
/// a re-import always promotes into the same `<import_root>/<catalogue>` directory - the one the
/// engine's catalogue then reads - rather than into a directory named after that import. Read by
/// [`super::imports`] to recognise a marketplace this application named, rather than one a user
/// added under a name of their own.
pub(crate) const CATALOG_SUFFIX: &str = "-import";
/// The prefix every staging name carries: the directories an unpacking writes, the temporary name a
/// promotion moves through, and the partial file a download writes. Only a name with it is ever
/// swept (see [`sweep_stale_staging`] and [`sweep_staging`]); a promoted import is named after its
/// catalogue and never matches.
pub(crate) const STAGING_PREFIX: &str = ".staging-";
/// How old a leftover staging directory has to be before the next import sweeps it. A staging
/// directory being written by a concurrent import is younger than this and is left alone.
const STAGING_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// One package file, unpacked and described: what to write a catalogue around, and what to install.
#[derive(Debug, Clone)]
pub(crate) struct UnpackedPackage {
    /// `package.json#name`, as the engine reads it: the name in the catalog entry and the first half
    /// of the plugin id an install is recorded under.
    pub(crate) plugin_name: String,
    /// The marketplace name the generated catalogue declares.
    pub(crate) catalog_name: String,
    /// The install source the host is asked for: `name@catalogue`.
    pub(crate) install_spec: String,
    /// The catalog entry's `source`: the unpacked package as a `./`-relative path.
    package_source: String,
    /// `package.json#version`, when the manifest declares one. The desktop compares it with the
    /// installed version only to tell "the same package again" from "a different one"; whether a
    /// version is *newer* is the engine's own answer (spec §3.4).
    pub(crate) version: Option<String>,
    /// `package.json#description`, when the manifest declares one.
    description: Option<String>,
    /// The archive's own digest, for the audit line and the log.
    pub(crate) archive_sha256: String,
}

impl PackageRefusal {
    /// The refusal as an IPC error: one code, because "the file you picked is not a plugin package
    /// this application can install" is one answer, and the sentence says which rule it broke.
    pub(crate) fn into_ipc(self) -> IpcError {
        IpcError::from_message(PLUGIN_PACKAGE_INVALID, self.message)
    }
}

/// The one package file a staging directory holds.
type PackageResult<T> = Result<T, PackageRefusal>;

/// The absolute path of the package file the user picked, checked before anything is read.
///
/// The command is the only caller, and it forwards a path the native picker returned; this is where
/// that path stops being trusted: it has to be absolute, a file, carry one of the two suffixes, and
/// be no larger than `MAX_ARCHIVE_BYTES`.
pub(crate) fn archive_path(raw: &str) -> IpcResult<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(IpcError::new(
            INVALID_PACKAGE_PATH,
            "The package path is empty.",
        ));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(IpcError::new(
            INVALID_PACKAGE_PATH,
            "The package path must be absolute.",
        ));
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !PACKAGE_SUFFIXES
        .iter()
        .any(|suffix| file_name.ends_with(suffix))
    {
        return Err(IpcError::from_message(
            INVALID_PACKAGE_PATH,
            format!(
                "The package file must end in {}.",
                PACKAGE_SUFFIXES.join(" or ")
            ),
        ));
    }
    check_archive_file(&path)?;
    Ok(path)
}

/// The absolute path of an archive this application produced itself, checked the way a picked file
/// is but without the suffix rule.
///
/// The suffix is what tells a user's file apart from everything else in their downloads folder, and
/// it is the picker's rule rather than the archive's; a file this application named - a download's
/// `.staging-download-…` - carries the staging prefix instead, and refusing it for the missing
/// suffix would refuse this application's own work. What both paths share is the rest: absolute, a
/// regular file, inside the archive bound.
pub(crate) fn staged_archive_path(path: &Path) -> IpcResult<PathBuf> {
    check_archive_file(path)?;
    Ok(path.to_path_buf())
}

/// The checks a package file has to pass before a byte of it is read, whatever named it.
fn check_archive_file(path: &Path) -> IpcResult<()> {
    if !path.is_absolute() {
        return Err(IpcError::new(
            INVALID_PACKAGE_PATH,
            "The package path must be absolute.",
        ));
    }
    let metadata = fs::metadata(path)
        .map_err(|_| IpcError::new(INVALID_PACKAGE_PATH, "The package file could not be read."))?;
    if !metadata.is_file() {
        return Err(IpcError::new(
            INVALID_PACKAGE_PATH,
            "The package path is not a file.",
        ));
    }
    if metadata.len() > MAX_ARCHIVE_BYTES {
        return Err(IpcError::from_message(
            PLUGIN_PACKAGE_INVALID,
            format!(
                "The package is larger than {} MB.",
                MAX_ARCHIVE_BYTES / (1024 * 1024)
            ),
        ));
    }
    Ok(())
}

/// A fresh staging directory under the import root: `<import_root>/.staging-<stamp>-<sequence>`.
///
/// The root is created on demand, and leftover staging directories an earlier crashed import left
/// behind are swept on the way in (see [`sweep_stale_staging`]). The name carries a monotonic counter
/// as well as a timestamp, because two imports started in the same millisecond would otherwise pick
/// the same directory - and a directory that already exists is a state this function must never
/// reuse, since it would mix two packages. The leading dot keeps a staging directory from ever being
/// mistaken for a promoted one: every real import is named after the catalogue it serves.
pub(crate) fn staging_dir(import_root: &Path) -> io::Result<PathBuf> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    fs::create_dir_all(import_root)?;
    sweep_stale_staging(import_root, SystemTime::now());
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    for _ in 0..8 {
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = import_root.join(format!("{STAGING_PREFIX}{stamp}-{sequence}"));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no free staging directory",
    ))
}

/// Removes the staging directories an earlier crashed import left behind under `import_root`.
///
/// Best-effort by design: a leftover that cannot be read or removed is skipped rather than failing
/// the import that is about to start, and a directory a concurrent import is still writing is young
/// enough to survive (`STAGING_MAX_AGE`). `now` is a parameter so the age rule is testable without
/// waiting a day. Only names carrying [`STAGING_PREFIX`] are considered, and only directories: a
/// promoted import is named after its catalogue and is never swept.
fn sweep_stale_staging(import_root: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(import_root) else {
        return;
    };
    for entry in entries.flatten() {
        let is_staging = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(STAGING_PREFIX));
        if !is_staging {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_dir() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let age = now.duration_since(modified).unwrap_or_default();
        if age > STAGING_MAX_AGE {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Removes every staging name left under `import_root`, answering how many were removed.
///
/// This is the *start-up* sweep, and it is the one rule that differs from [`sweep_stale_staging`]:
/// that one runs on the way into every import and spares anything young enough to belong to a
/// concurrent import, while this one runs once, before this process has started an import of its own -
/// so every name carrying the staging prefix is a leftover from a previous run, whatever its age.
/// Both shapes a leftover can have are covered: the directory a crashed unpacking or promotion left,
/// and the partial file a crashed download left.
///
/// The bounds are the same as the import-time sweep's: only the direct children of `import_root` are
/// considered (depth 1, never a walk), only names carrying [`STAGING_PREFIX`], and a symbolic link is
/// skipped rather than followed - removing whatever it points at is not this function's business. The
/// count is what the caller logs, and a name that cannot be removed is skipped rather than failing
/// the start-up path.
pub(crate) fn sweep_staging(import_root: &Path) -> usize {
    let Ok(entries) = fs::read_dir(import_root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let is_staging = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(STAGING_PREFIX));
        if !is_staging {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let removed_entry = if file_type.is_dir() {
            fs::remove_dir_all(entry.path()).is_ok()
        } else {
            fs::remove_file(entry.path()).is_ok()
        };
        if removed_entry {
            removed += 1;
        }
    }
    removed
}

/// A fresh path for one download under `import_root`:
/// `<import_root>/.staging-download-<stamp>-<sequence>`.
///
/// The name is this application's own, which is why it carries the staging prefix rather than a
/// package suffix: a download that never finished is a leftover the next start sweeps
/// ([`sweep_staging`]), and a half-written file that ended in `.omp.zip` would look like a package
/// the user picked.
pub(crate) fn download_staging_path(import_root: &Path) -> io::Result<PathBuf> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    fs::create_dir_all(import_root)?;
    free_name(
        import_root,
        &format!("{STAGING_PREFIX}download-"),
        &SEQUENCE,
    )
}

/// A name that does not exist yet inside `parent`, as `<prefix><stamp>-<sequence>`.
///
/// The stamp alone is not enough: two calls in the same millisecond would pick the same name, and a
/// name that already exists is a state neither caller may reuse. The counter is the caller's own, so
/// two kinds of name never share a sequence.
fn free_name(parent: &Path, prefix: &str, sequence: &AtomicU64) -> io::Result<PathBuf> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    for _ in 0..8 {
        let candidate = parent.join(format!(
            "{prefix}{stamp}-{}",
            sequence.fetch_add(1, Ordering::Relaxed)
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no free name in this directory",
    ))
}

/// Which step of a promotion failed, so the rollback knows what is on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromoteStep {
    /// The staged tree could not be moved to its temporary name: nothing has moved.
    StageToTemporary,
    /// The previous import could not be removed: the new tree waits under its temporary name.
    RemovePrevious,
    /// The temporary tree could not be given the target's name: the previous import is gone.
    TemporaryToTarget,
}

/// What a failed promotion step leaves behind, and therefore what the rollback has to undo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromoteRollback {
    /// Nothing moved, so nothing is undone: the staging directory is where the caller left it.
    Nothing,
    /// The new import waits under its temporary name: it is the half-product, and it goes.
    DropTemporary,
}

/// The rollback one failed promotion step performs.
///
/// Pure, so the rule can be read - and tested - without a filesystem. Only a failure *before* the
/// staged tree moved leaves nothing to clean up; every later failure drops the temporary tree, which
/// is the half-written import. The old directory is deliberately never touched by the rollback: at
/// the first step it was never touched at all, and at the later two it is either still there or is
/// what the failed removal itself left - and reporting that state is the caller's job, not this
/// function's.
fn promote_rollback(step: PromoteStep) -> PromoteRollback {
    match step {
        PromoteStep::StageToTemporary => PromoteRollback::Nothing,
        PromoteStep::RemovePrevious | PromoteStep::TemporaryToTarget => {
            PromoteRollback::DropTemporary
        }
    }
}

/// Moves one staged import into place as `<import_root>/<catalogue>`, replacing any earlier one.
///
/// The replacement is what makes a re-import an upgrade rather than a second install: the catalogue
/// the engine reads is the one in this directory, so the newest package the user picked is the one
/// an install or an upgrade resolves against.
///
/// The three steps are ordered so that a failure at any of them leaves something usable behind. The
/// staged tree goes to a temporary name *beside* the target first, so nothing has touched the
/// directory an installed plugin is running from; the old directory goes next; and the temporary
/// tree takes the target's name last - the one step that is a rename into a free name, and therefore
/// the one that either happens or does not. A failure at either later step drops the temporary tree
/// ([`promote_rollback`]); a leftover that could not be removed carries the staging prefix, so the
/// next start's sweep takes it.
pub(crate) fn promote(staging: &Path, target: &Path) -> io::Result<()> {
    let temporary = temporary_target(target)?;
    if let Err(error) = fs::rename(staging, &temporary) {
        return Err(fail_promotion(PromoteStep::StageToTemporary, None, error));
    }
    if target.exists() {
        if let Err(error) = fs::remove_dir_all(target) {
            return Err(fail_promotion(
                PromoteStep::RemovePrevious,
                Some(&temporary),
                error,
            ));
        }
    }
    if let Err(error) = fs::rename(&temporary, target) {
        return Err(fail_promotion(
            PromoteStep::TemporaryToTarget,
            Some(&temporary),
            error,
        ));
    }
    Ok(())
}

/// Applies one step's rollback and answers the error the caller reads.
fn fail_promotion(step: PromoteStep, temporary: Option<&Path>, error: io::Error) -> io::Error {
    if let (PromoteRollback::DropTemporary, Some(temporary)) = (promote_rollback(step), temporary) {
        // A removal that fails is not turned into a second error: the name carries the staging
        // prefix, so the start-up sweep is what takes it.
        let _ = fs::remove_dir_all(temporary);
    }
    error
}

/// A temporary name beside the target, in the same directory so the rename into place is one
/// filesystem operation.
///
/// The name carries [`STAGING_PREFIX`], which is what makes a leftover from a crash the start-up
/// sweep's business, and never the target's name, which is the directory an installed plugin is
/// running from.
fn temporary_target(target: &Path) -> io::Result<PathBuf> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let parent = target.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "the import target has no parent directory",
        )
    })?;
    free_name(parent, &format!("{STAGING_PREFIX}promote-"), &SEQUENCE)
}

/// One unpacked package tree: where the archive's own tree was written, the package inside it, what
/// its manifest declares (both as parsed JSON, for the fields a catalogue does not carry, and as the
/// three facts a catalogue entry is built from), and the archive's own digest.
struct UnpackedTree {
    root: PathBuf,
    package_dir: PathBuf,
    manifest_value: Value,
    manifest: ManifestFacts,
    archive_sha256: String,
}

/// Unpacks `archive` into `staging` and reads the one package it holds.
///
/// The caller removes the whole staging directory whichever way this answers, so a refusal never
/// leaves an unpacked tree behind. Every entry is checked by `guards::safe_relative` before it is
/// created, links are refused rather than followed, and the unpacked bytes are bounded as they are
/// written. Each file and directory also gets the entry's own permission bits back, masked to
/// `0o777` (see [`writable_mode`]), so an executable a package ships stays executable on the
/// platforms that have that bit.
///
/// The checksum list is the one thing this step does *not* read: whether a package may be installed
/// is [`unpack`]'s decision, while the preview ([`inspect`]) reports the same list as a fact.
fn unpack_tree(archive: &Path, staging: &Path) -> PackageResult<UnpackedTree> {
    let archive_sha256 = digest_of(archive)?;
    let root = staging.join(PACKAGE_ROOT_DIR);
    fs::create_dir_all(&root).map_err(io_refusal("Could not create the extraction directory"))?;
    let file = File::open(archive).map_err(io_refusal("Could not open the package archive"))?;
    let mut zip = ZipArchive::new(BufReader::new(file)).map_err(|error| {
        PackageRefusal::new(format!(
            "The package is not a readable zip archive: {error}"
        ))
    })?;
    if zip.len() > MAX_ENTRIES {
        return Err(PackageRefusal::new(format!(
            "The package holds {} entries, above the {MAX_ENTRIES} limit.",
            zip.len()
        )));
    }
    let mut written: u64 = 0;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| {
            PackageRefusal::new(format!(
                "A package entry could not be read: {}",
                quoted(&error.to_string())
            ))
        })?;
        let entry_name = entry.name().to_owned();
        // The entry's own mode is read before anything is written: the zip reader borrows the entry,
        // and the mode has to be applied after the bytes are on disk.
        let entry_mode = entry.unix_mode();
        if entry.is_dir() {
            let relative = safe_relative(entry_name.trim_end_matches('/'))?;
            let directory = root.join(relative);
            fs::create_dir_all(&directory).map_err(io_refusal("Could not create a directory"))?;
            // A directory entry's own mode is worth keeping too (the archive's `0755` for a
            // directory a plugin walks into), and it is applied the same way a file's is.
            apply_entry_mode(&directory, entry_mode).map_err(io_refusal(
                "Could not set the extraction directory's permissions",
            ))?;
            continue;
        }
        // A link is refused rather than followed: the guards reason about plain files, and a package
        // that writes links would unpack into something this application cannot describe.
        if entry.is_symlink() {
            return Err(PackageRefusal::new(format!(
                "The package contains a link entry and was refused: {}",
                quoted(&entry_name)
            )));
        }
        let target = root.join(safe_relative(&entry_name)?);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io_refusal("Could not create a directory"))?;
        }
        let mut out =
            File::create(&target).map_err(io_refusal("Could not write an extracted file"))?;
        written = copy_bounded(&mut entry, &mut out, written)?;
        out.flush()
            .map_err(io_refusal("Could not write an extracted file"))?;
        // The file is on disk and closed for writing; its mode goes on last, so a read-only entry
        // does not stop its own bytes from being written.
        apply_entry_mode(&target, entry_mode)
            .map_err(io_refusal("Could not set an extracted file's permissions"))?;
    }

    let package_dir = locate_package(&root)?;
    let manifest_value = read_manifest_value(&package_dir)?;
    let manifest = manifest_facts(&manifest_value)?;
    Ok(UnpackedTree {
        root,
        package_dir,
        manifest_value,
        manifest,
        archive_sha256,
    })
}

/// Unpacks one package and describes it as the catalogue the engine installs from.
///
/// The checksum list is verified here rather than in [`unpack_tree`], because this is the step that
/// turns an archive into something installable: a package whose `checksums.json` does not match the
/// files it lists is refused, while the preview that reads the same package before installing it
/// reports that state as a fact instead (`guards::checksum_facts`).
pub(crate) fn unpack(archive: &Path, staging: &Path) -> PackageResult<UnpackedPackage> {
    let tree = unpack_tree(archive, staging)?;
    verify_checksums(&tree.package_dir)?;
    let catalog_name = format!("{}{CATALOG_SUFFIX}", tree.manifest.name);
    Ok(UnpackedPackage {
        install_spec: format!("{}@{catalog_name}", tree.manifest.name),
        catalog_name,
        plugin_name: tree.manifest.name,
        package_source: relative_source(&tree.root, &tree.package_dir)?,
        version: tree.manifest.version,
        description: tree.manifest.description,
        archive_sha256: tree.archive_sha256,
    })
}

/// The permission bits one entry's recorded mode contributes to the file it unpacks to.
///
/// A zip entry's mode carries the file type in its high bits (`0o100644` for a regular file,
/// `0o120777` for a link); only the low nine bits are permission bits, so the mode is masked to
/// `0o777`. The mask is also what keeps setuid, setgid and sticky off every unpacked file: an
/// archive is untrusted input and the unpacker must never hand it a privilege bit, whatever it
/// recorded. Cross-platform on purpose - it is a pure mapping, and only the `chmod` that applies it
/// is behind `#[cfg(unix)]`, so the mapping is asserted on Windows too (spec §0.4).
fn writable_mode(mode: Option<u32>) -> Option<u32> {
    mode.map(|mode| mode & 0o777)
}

/// Applies one entry's own permission bits to what it unpacked to.
///
/// The `chmod` is the only part of this that is platform-specific; on a platform without Unix
/// permissions the mode is read but there is nothing to set, which is why the non-Unix form is a
/// no-op rather than a refusal.
#[cfg(unix)]
fn apply_entry_mode(target: &Path, mode: Option<u32>) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    match writable_mode(mode) {
        Some(bits) => fs::set_permissions(target, fs::Permissions::from_mode(bits)),
        None => Ok(()),
    }
}

#[cfg(not(unix))]
fn apply_entry_mode(_target: &Path, mode: Option<u32>) -> io::Result<()> {
    // There is no permission bit to set on this platform, but the mode is still put through the same
    // mapping: the mapping is one rule, asserted on every platform, and only the syscall is Unix-only.
    let _ = writable_mode(mode);
    Ok(())
}

/// Writes the catalogue the host adds as a marketplace, beside the unpacked package.
///
/// The shape is the engine's own (`MarketplaceCatalog`): a catalogue `name`, an `owner.name`, and
/// one plugin entry whose `source` is a `./`-relative path inside this staging directory.
pub(crate) fn write_catalog(staging: &Path, package: &UnpackedPackage) -> io::Result<()> {
    let directory = staging.join(".omp-plugin");
    fs::create_dir_all(&directory)?;
    let mut entry = Map::new();
    entry.insert("name".to_owned(), json!(package.plugin_name));
    entry.insert("source".to_owned(), json!(package.package_source));
    if let Some(version) = &package.version {
        entry.insert("version".to_owned(), json!(version));
    }
    if let Some(description) = &package.description {
        entry.insert("description".to_owned(), json!(description));
    }
    let catalog = json!({
        "name": package.catalog_name,
        "owner": { "name": CATALOG_OWNER },
        "plugins": [ Value::Object(entry) ],
    });
    let text = serde_json::to_string_pretty(&catalog)?;
    fs::write(directory.join("marketplace.json"), format!("{text}\n"))
}

/// Whether a name is one the engine's catalogue accepts: a single segment, so no scope separator,
/// no whitespace and no path characters (`marketplace/types.ts` `isValidNameSegment`).
pub(crate) fn is_name_segment(name: &str) -> bool {
    let mut chars = name.chars();
    let first = match chars.next() {
        Some(character) => character,
        None => return false,
    };
    if name.chars().count() > NAME_MAX_CHARS {
        return false;
    }
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
}

/// The three manifest fields a catalogue entry carries, read from the unpacked package.
struct ManifestFacts {
    name: String,
    version: Option<String>,
    description: Option<String>,
}

/// The package directory inside the unpacked tree: the root itself when the archive holds the
/// manifest at its top level, or the single directory that holds it (the shape an archive of a
/// folder has).
fn locate_package(root: &Path) -> PackageResult<PathBuf> {
    if root.join("package.json").is_file() {
        return Ok(root.to_path_buf());
    }
    let mut directories: Vec<PathBuf> = Vec::new();
    for entry in
        fs::read_dir(root).map_err(io_refusal("Could not read the extraction directory"))?
    {
        let entry = entry.map_err(io_refusal("Could not read the extraction directory"))?;
        let file_type = entry
            .file_type()
            .map_err(io_refusal("Could not read the extraction directory"))?;
        if file_type.is_dir() {
            directories.push(entry.path());
        }
    }
    if directories.len() != 1 {
        return Err(PackageRefusal::new(
            "The package root must hold exactly one plugin package (with its package.json).",
        ));
    }
    let candidate = directories.remove(0);
    if !candidate.join("package.json").is_file() {
        return Err(PackageRefusal::new(
            "No package.json was found in the package.",
        ));
    }
    Ok(candidate)
}

/// One package's `package.json`, parsed. Kept apart from [`manifest_facts`] so a caller that needs
/// the rest of the manifest - the preview, which reads the `omp` block - parses the file once.
fn read_manifest_value(package_dir: &Path) -> PackageResult<Value> {
    let path = package_dir.join("package.json");
    let text = fs::read_to_string(&path).map_err(io_refusal("Could not read package.json"))?;
    serde_json::from_str(&text)
        .map_err(|error| PackageRefusal::new(format!("package.json is not valid JSON: {error}")))
}

/// The three manifest fields a catalogue entry carries, read from the parsed manifest.
fn manifest_facts(value: &Value) -> PackageResult<ManifestFacts> {
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if !is_name_segment(&name) {
        return Err(PackageRefusal::new(
            "The package.json name is not a valid package name (start with a letter or digit; only letters, digits, . _ -).",
        ));
    }
    let text_field = |key: &str| -> Option<String> {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    Ok(ManifestFacts {
        name,
        version: text_field("version"),
        description: text_field("description"),
    })
}

/// The catalog entry's `source`: the package as a `./`-relative path from the staging directory.
fn relative_source(root: &Path, package_dir: &Path) -> PackageResult<String> {
    let relative = package_dir
        .strip_prefix(root)
        .map_err(|_| PackageRefusal::new("The extraction directory has an unexpected shape."))?;
    let parts: Vec<String> = relative
        .components()
        .map(|component| match component {
            Component::Normal(part) => part
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| PackageRefusal::new("An extraction directory name is not UTF-8.")),
            _ => Err(PackageRefusal::new(
                "The extraction directory has an unexpected shape.",
            )),
        })
        .collect::<PackageResult<Vec<String>>>()?;
    if parts.is_empty() {
        return Ok(format!("./{PACKAGE_ROOT_DIR}"));
    }
    Ok(format!("./{PACKAGE_ROOT_DIR}/{}", parts.join("/")))
}

#[cfg(test)]
mod tests;

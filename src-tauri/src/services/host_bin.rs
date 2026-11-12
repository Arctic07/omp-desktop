//! Locating the shipped host and verifying it against its bundle manifest.
//!
//! There is exactly one shipped form: `bundle/` - a `manifest.json`, the vendor's runtime, one
//! plain JavaScript entry, and the addons the manifest lists - written by
//! `bun run host/build.ts`. The compiled self-extracting executable this project used to
//! ship is not a candidate at all: a stale copy of it beside an upgrade is how an application once
//! started a host built for the previous protocol.
//!
//! Every file the manifest names is hashed before the process is spawned, because a program this
//! application did not build is a different release than the one it was tested against; nothing is
//! started on the strength of the directory merely existing.
//!
//! Lookup order: the development override, then `bundle/` beside the application executable, then
//! the same name under the packaged resource directory (macOS and Linux do not place it beside the
//! executable), then the repository copy a development build runs from. The first candidate that
//! exists decides the answer: a located but unusable bundle is reported, never skipped in favour
//! of a later one, so a broken installation cannot silently fall back to whatever else is on disk.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::errors::{
    IpcError, IpcResult, ENGINE_CHECKSUM_MISMATCH, ENGINE_NOT_FOUND, ENGINE_PROTOCOL,
};
use crate::services::runtime::PROTOCOL_VERSION;

/// Development override: tried before the installed copies. A path that does not verify is reported
/// instead of falling through to another copy.
pub(crate) const ENV_OVERRIDE: &str = "OMP_DESKTOP_HOST_BIN";

/// The packaged application's resource directory, set once at start-up.
///
/// Only packaging knows this: on Windows it is the application directory, on macOS it is
/// `Contents/Resources` and on Linux `/usr/lib/<product>`, so a bundle shipped as a resource is
/// only reachable through the framework's answer. A `OnceLock` rather than a parameter because the
/// lookup runs from a blocking task with no `AppHandle` in hand.
static RESOURCE_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Records where this build's resources live. Ignored after the first call: the location cannot
/// change while the process runs, and a different answer later would be a different installation.
pub(crate) fn set_resource_dir(directory: PathBuf) {
    let _ = RESOURCE_DIR.set(directory);
}

/// Directory name of the non-compiled layout, and the manifest inside it.
const BUNDLE_DIR: &str = "bundle";
const BUNDLE_MANIFEST: &str = "manifest.json";

/// Ceiling on one bundle file, and on the bundle as a whole. The measured bundle is around two
/// hundred and sixty megabytes; a directory past a gigabyte is not the artifact this build ships,
/// and hashing it would only make the refusal slower.
const MAX_BUNDLE_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_BUNDLE_BYTES: u64 = 1024 * 1024 * 1024;

/// Digest reads happen in fixed chunks, so a two hundred megabyte artifact is never held whole.
const CHUNK_BYTES: usize = 64 * 1024;

/// One file a bundle manifest lists, with the size and digest it was written under.
#[derive(Debug, Clone, Deserialize)]
struct BundleFile {
    file: String,
    role: String,
    bytes: u64,
    sha256: String,
}

/// The bundle's manifest (`build.ts` writes it beside the files it describes).
#[derive(Debug, Clone, Deserialize)]
struct BundleManifest {
    layout: String,
    #[serde(rename = "sdkVersion")]
    sdk_version: String,
    protocol: u32,
    entry: String,
    /// Runtime flags, then the entry's file name: the invocation the build measured.
    argv: Vec<String>,
    files: Vec<BundleFile>,
}

/// A located, verified artifact.
#[derive(Debug, Clone)]
pub(crate) struct HostArtifact {
    /// The program to execute: the bundle's runtime.
    pub(crate) program: PathBuf,
    /// Runtime flags and the bundle's entry, rebuilt from its manifest.
    pub(crate) args: Vec<std::ffi::OsString>,
    /// What the runtime status shows: the bundle directory.
    pub(crate) path: PathBuf,
    /// SDK version the artifact was built against, as its manifest records it.
    pub(crate) sdk_version: String,
}

/// What the settings page is shown. Never fails: a missing or unverifiable artifact is data here,
/// because the runtime status still has to render.
#[derive(Debug, Clone)]
pub(crate) struct HostBinInfo {
    pub(crate) path: Option<PathBuf>,
    pub(crate) sdk_version: String,
    pub(crate) verified: bool,
    pub(crate) error: Option<&'static str>,
}

impl HostBinInfo {
    pub(crate) fn absent() -> Self {
        Self {
            path: None,
            sdk_version: String::new(),
            verified: false,
            error: Some(ENGINE_NOT_FOUND),
        }
    }
}

/// Absolute path of the host bundle, refusing anything that does not match its manifest.
///
/// Reads and hashes a large directory, so callers run it through `spawn_blocking`.
pub(crate) fn locate() -> IpcResult<HostArtifact> {
    match locate_bundle() {
        Some(directory) => verify_bundle(&directory),
        None => Err(IpcError::from_message(
            ENGINE_NOT_FOUND,
            missing_host_message(),
        )),
    }
}

/// The located host, as shown in the runtime status.
pub(crate) fn info() -> HostBinInfo {
    let Some(directory) = locate_bundle() else {
        return HostBinInfo::absent();
    };
    match verify_bundle(&directory) {
        Ok(artifact) => HostBinInfo {
            path: Some(artifact.path),
            sdk_version: artifact.sdk_version,
            verified: true,
            error: None,
        },
        Err(error) => HostBinInfo {
            path: Some(directory),
            sdk_version: String::new(),
            verified: false,
            // Only the artifact codes are ever reported here; anything else would be a programming
            // error rather than a state the settings page can render.
            error: Some(match error.code.as_ref() {
                ENGINE_NOT_FOUND => ENGINE_NOT_FOUND,
                ENGINE_PROTOCOL => ENGINE_PROTOCOL,
                _ => ENGINE_CHECKSUM_MISMATCH,
            }),
        },
    }
}

/// The first bundle directory that exists, in the documented order.
fn locate_bundle() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os(ENV_OVERRIDE) {
        if !value.is_empty() {
            // The override names a directory even when it does not exist: the refusal that follows
            // is what says so, and falling through to the installed copy would hide the mistake.
            return Some(PathBuf::from(value));
        }
    }
    let application = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    if let Some(directory) = application {
        let bundle = directory.join(BUNDLE_DIR);
        if bundle.join(BUNDLE_MANIFEST).is_file() {
            return Some(bundle);
        }
    }
    // A packaged bundle ships as a resource, which on macOS and Linux is not the exe's directory.
    if let Some(directory) = RESOURCE_DIR.get() {
        let bundle = directory.join(BUNDLE_DIR);
        if bundle.join(BUNDLE_MANIFEST).is_file() {
            return Some(bundle);
        }
    }
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let bundle = repository.join(BUNDLE_DIR);
    if bundle.join(BUNDLE_MANIFEST).is_file() {
        return Some(bundle);
    }
    None
}

/// What a reader is told when no bundle exists.
fn missing_host_message() -> String {
    format!("The engine host bundle is missing. {}", remedy())
}

/// What a reader is told when the bundle speaks another protocol.
fn protocol_mismatch_message(built_for: u32) -> String {
    format!(
        "The engine host bundle was built for protocol {built_for}, this build speaks protocol {PROTOCOL_VERSION}. {}",
        remedy()
    )
}

/// The one remedy that depends on what the reader can do: a packaged build reinstalls the release,
/// a development build rebuilds the artifact. One home for the branch.
fn remedy() -> &'static str {
    if cfg!(debug_assertions) {
        "Rebuild it with `pnpm host:install` and restart the application."
    } else {
        "Reinstall the latest release."
    }
}

/// The bundle directory as an absolute path. Split out so the relative-path rule is testable without
/// changing the process cwd.
fn absolute_bundle(directory: &Path) -> PathBuf {
    std::path::absolute(directory).unwrap_or_else(|_| directory.to_path_buf())
}

/// Reads the bundle's manifest and checks every file it lists.
///
/// The manifest itself is not hashed: it is the document that carries the digests and it ships
/// inside the same directory the installer wrote. What it *does* have to survive is arithmetic - a
/// name that leaves the directory is refused before it is read, and every file it lists is hashed
/// at its recorded size.
fn verify_bundle(directory: &Path) -> IpcResult<HostArtifact> {
    // Resolve a relative override against the process's own cwd before anything is read or
    // spawned: the child runs with `<data_root>/host` as its cwd, so a relative entry would name a
    // file nobody hashed (or none at all).
    let directory = absolute_bundle(directory);
    let directory = directory.as_path();
    let manifest_path = directory.join(BUNDLE_MANIFEST);
    let text = fs::read_to_string(&manifest_path).map_err(|_| {
        mismatch("The engine host bundle manifest is missing, so the program cannot be verified. Reinstall it.")
    })?;
    let manifest = serde_json::from_str::<BundleManifest>(&text).map_err(|_| {
        mismatch("The engine host bundle manifest is unreadable, so the program cannot be verified. Reinstall it.")
    })?;
    if manifest.layout != "bundle" {
        return Err(mismatch(
            "The engine host bundle describes another layout. Reinstall it.",
        ));
    }
    if manifest.protocol != PROTOCOL_VERSION {
        return Err(IpcError::from_message(
            ENGINE_PROTOCOL,
            protocol_mismatch_message(manifest.protocol),
        ));
    }
    // The invocation is rebuilt from the manifest rather than trusted as a shell string: the last
    // element must be the entry, and everything before it is a runtime flag. Anything else would
    // let a manifest name a different program than the one verified above.
    let Some((entry_argument, flags)) = manifest.argv.split_last() else {
        return Err(mismatch(
            "The engine host bundle records no invocation. Reinstall it.",
        ));
    };
    if entry_argument != &manifest.entry || flags.iter().any(|flag| !flag.starts_with("--")) {
        return Err(mismatch(
            "The engine host bundle records an invocation this build cannot reproduce. Reinstall it.",
        ));
    }

    let mut total: u64 = 0;
    let mut runtime: Option<PathBuf> = None;
    let mut entry_listed = false;
    for file in &manifest.files {
        // A plain name only: the manifest may not point outside the directory it ships in.
        // Counted in path components, not in characters: `Path::join` replaces the whole directory
        // for anything carrying a prefix (`C:host.js`) or a root (`/host.js`), so a string test for
        // separators lets both through while looking like it covers traversal.
        let mut components = Path::new(&file.file).components();
        let plain_name = matches!(components.next(), Some(std::path::Component::Normal(_)))
            && components.next().is_none();
        if !plain_name {
            return Err(mismatch(
                "The engine host bundle names a file outside itself. Reinstall it.",
            ));
        }
        let path = directory.join(&file.file);
        let metadata = fs::metadata(&path)
            .map_err(|_| mismatch("The engine host bundle is incomplete. Reinstall it."))?;
        if !metadata.is_file() || metadata.len() > MAX_BUNDLE_FILE_BYTES {
            return Err(mismatch(
                "The engine host bundle contains an unexpected entry. Reinstall it.",
            ));
        }
        total = total.saturating_add(metadata.len());
        if total > MAX_BUNDLE_BYTES {
            return Err(mismatch(
                "The engine host bundle is larger than any artifact this build ships. Reinstall it.",
            ));
        }
        if file.bytes != metadata.len() {
            return Err(mismatch(
                "The engine host bundle does not match the checksums recorded for it. Reinstall it.",
            ));
        }
        let digest = digest(&path).ok_or_else(|| {
            IpcError::new(
                ENGINE_NOT_FOUND,
                "The engine host program could not be read.",
            )
        })?;
        if !file.sha256.eq_ignore_ascii_case(&digest) {
            return Err(mismatch(
                "The engine host bundle does not match the checksums recorded for it. Reinstall it.",
            ));
        }
        if file.role == "runtime" {
            if runtime.is_some() {
                return Err(mismatch(
                    "The engine host bundle names more than one runtime. Reinstall it.",
                ));
            }
            runtime = Some(path);
        }
        if file.role == "bundle" && file.file == manifest.entry {
            entry_listed = true;
        }
    }
    if !entry_listed {
        return Err(mismatch(
            "The engine host bundle does not list its own entry. Reinstall it.",
        ));
    }
    let Some(program) = runtime else {
        return Err(mismatch(
            "The engine host bundle names no runtime. Reinstall it.",
        ));
    };

    let mut args: Vec<std::ffi::OsString> = flags.iter().map(std::ffi::OsString::from).collect();
    args.push(directory.join(&manifest.entry).into_os_string());
    Ok(HostArtifact {
        program,
        args,
        path: directory.to_path_buf(),
        sdk_version: manifest.sdk_version,
    })
}

fn mismatch(message: &'static str) -> IpcError {
    IpcError::new(ENGINE_CHECKSUM_MISMATCH, message)
}

/// Lowercase hex sha256 of the file, read in fixed chunks so the artifact never lands in memory
/// whole. Any I/O error is `None`, which the caller reads as "cannot be verified".
fn digest(path: &Path) -> Option<String> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut file = File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; CHUNK_BYTES];
    loop {
        // `read` may return a short read at any point, so only end of file stops the loop.
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let sum = hasher.finalize();
    let mut hex = String::with_capacity(sum.len() * 2);
    // Spelled out rather than `LowerHex`: the digest is compared against a hand-written manifest,
    // so its spelling must not depend on a formatter.
    for byte in sum.iter().copied() {
        hex.push(HEX[usize::from(byte >> 4)] as char);
        hex.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    Some(hex)
}

#[cfg(test)]
mod bundle_tests;

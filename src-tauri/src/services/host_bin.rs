//! Locating the host program and verifying it against the manifest shipped next to it.
//!
//! Two layouts are understood. The compiled layout is one artifact - `omp-host[-<triple>].exe`
//! plus the `omp-host.json` the build wrote beside it. The bundle layout is a directory -
//! `bundle/manifest.json` plus the runtime, the JavaScript entry and the addons it lists - which
//! is what `bun run host/build.ts --bundle` writes and what an antivirus engine sees as an
//! ordinary runtime with plain files instead of an unrecognized self-extracting executable.
//!
//! Either way the files are verified before the process is spawned, because a program this
//! application did not build is a different release than the one it was tested against. A bundle
//! names every file it needs, so each one is hashed; nothing is started on the strength of the
//! directory merely existing.
//!
//! Lookup order: the development override, then the directory of the application executable
//! (a `bundle/` directory there wins over a compiled executable, because its presence is the
//! deliberate choice of layout), then the repository path a development build runs from. The
//! first candidate that exists decides the answer: a located but unusable artifact is reported,
//! never skipped in favour of a later one, so a broken installation cannot silently fall back to
//! whatever else is on disk.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::errors::{
    IpcError, IpcResult, ENGINE_CHECKSUM_MISMATCH, ENGINE_NOT_FOUND, ENGINE_PROTOCOL,
};
use crate::services::runtime::PROTOCOL_VERSION;

/// Development override. Used only when it points at an existing file.
pub(crate) const ENV_OVERRIDE: &str = "OMP_DESKTOP_HOST_BIN";

/// Manifest the build writes next to the binary (contract §1.2).
const MANIFEST_FILE: &str = "omp-host.json";

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

/// Ceiling on the artifact this host is willing to hash. The shipped host is around two hundred
/// megabytes; anything far past that is not the file the manifest describes, and hashing it would
/// only make the refusal slower.
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

/// The manifest's own shape. `builtAt`, `target`, `bunVersion` and `entry` are written by the
/// build but not needed here, so they are simply not read.
#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    #[serde(rename = "sdkVersion")]
    sdk_version: String,
    bytes: u64,
    sha256: String,
    /// Protocol version the artifact was built for (`host/build.ts` writes it from the host's own
    /// `PROTOCOL_VERSION`). A required field on purpose: an artifact whose manifest does not state
    /// one is an artifact this build cannot vouch for, the same as a digest it does not match.
    protocol: u32,
}

/// One file a bundle manifest lists, with the size and digest it was written under.
#[derive(Debug, Clone, Deserialize)]
struct BundleFile {
    file: String,
    role: String,
    bytes: u64,
    sha256: String,
}

/// The bundle's manifest (`build.ts --bundle` writes it beside the files it describes).
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
    /// The program to execute: the compiled executable, or the bundle's runtime.
    pub(crate) program: PathBuf,
    /// Arguments that belong before the caller's own. A bundle names its entry here; a compiled
    /// artifact names none.
    pub(crate) args: Vec<std::ffi::OsString>,
    /// What the runtime status shows: the executable, or the bundle directory.
    pub(crate) path: PathBuf,
    /// SDK version the artifact was built against, as its manifest records it.
    pub(crate) sdk_version: String,
}

/// A place the host may be, before anything about it is trusted.
enum Candidate {
    Compiled(PathBuf),
    Bundle(PathBuf),
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

/// Absolute path of the host binary, refusing anything that does not match its manifest.
///
/// Reads and hashes a large file, so callers run it through `spawn_blocking`.
pub(crate) fn locate() -> IpcResult<HostArtifact> {
    match locate_candidate() {
        Some(Candidate::Compiled(path)) => verify(&path),
        Some(Candidate::Bundle(directory)) => verify_bundle(&directory),
        None => Err(IpcError::new(
            ENGINE_NOT_FOUND,
            "The engine host program was not found. Build it with the host build script and try again.",
        )),
    }
}

/// The located host, as shown in the runtime status.
pub(crate) fn info() -> HostBinInfo {
    let Some(candidate) = locate_candidate() else {
        return HostBinInfo::absent();
    };
    let (path, verified) = match &candidate {
        Candidate::Compiled(path) => (path.clone(), verify(path)),
        Candidate::Bundle(directory) => (directory.clone(), verify_bundle(directory)),
    };
    match verified {
        Ok(artifact) => HostBinInfo {
            path: Some(artifact.path),
            sdk_version: artifact.sdk_version,
            verified: true,
            error: None,
        },
        Err(error) => HostBinInfo {
            path: Some(path),
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

/// The first candidate that exists, in the documented order.
fn locate_candidate() -> Option<Candidate> {
    if let Some(value) = std::env::var_os(ENV_OVERRIDE) {
        if !value.is_empty() {
            // A development override names either layout: a directory is a bundle, a file is a
            // compiled artifact. Neither is checked for existence here beyond that shape, so the
            // refusal that follows can name what is wrong.
            let path = PathBuf::from(value);
            return Some(if path.is_dir() {
                Candidate::Bundle(path)
            } else {
                Candidate::Compiled(path)
            });
        }
    }
    let application = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    if let Some(directory) = application {
        // A shipped bundle is the deliberate choice of layout, so it wins over a compiled
        // executable that happened to survive an upgrade in the same directory.
        let bundle = directory.join(BUNDLE_DIR);
        if bundle.join(BUNDLE_MANIFEST).is_file() {
            return Some(Candidate::Bundle(bundle));
        }
        for name in host_file_names() {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(Candidate::Compiled(candidate));
            }
        }
    }
    // A packaged bundle ships as a resource, which on macOS and Linux is not the exe's directory.
    if let Some(directory) = RESOURCE_DIR.get() {
        let bundle = directory.join(BUNDLE_DIR);
        if bundle.join(BUNDLE_MANIFEST).is_file() {
            return Some(Candidate::Bundle(bundle));
        }
    }
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    if let Some(name) = target_file_name() {
        let candidate = repository.join(name);
        if candidate.is_file() {
            return Some(Candidate::Compiled(candidate));
        }
    }
    let bundle = repository.join(BUNDLE_DIR);
    if bundle.join(BUNDLE_MANIFEST).is_file() {
        return Some(Candidate::Bundle(bundle));
    }
    None
}

/// Names of the host binary as an installed bundle spells them: Tauri strips the triple from an
/// `externalBin` when it bundles, while the development tree keeps it.
fn host_file_names() -> Vec<&'static str> {
    let mut names = vec![match std::env::consts::EXE_SUFFIX {
        "" => "omp-host",
        _ => "omp-host.exe",
    }];
    if let Some(name) = target_file_name() {
        names.push(name);
    }
    names
}

/// Name of the installed artifact for this build's target, or `None` on a platform the product
/// does not ship.
fn target_file_name() -> Option<&'static str> {
    Some(match target_triple()? {
        "x86_64-pc-windows-msvc" => "omp-host-x86_64-pc-windows-msvc.exe",
        "aarch64-pc-windows-msvc" => "omp-host-aarch64-pc-windows-msvc.exe",
        "x86_64-pc-windows-gnu" => "omp-host-x86_64-pc-windows-gnu.exe",
        "x86_64-apple-darwin" => "omp-host-x86_64-apple-darwin",
        "aarch64-apple-darwin" => "omp-host-aarch64-apple-darwin",
        "x86_64-unknown-linux-gnu" => "omp-host-x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu" => "omp-host-aarch64-unknown-linux-gnu",
        "x86_64-unknown-linux-musl" => "omp-host-x86_64-unknown-linux-musl",
        "aarch64-unknown-linux-musl" => "omp-host-aarch64-unknown-linux-musl",
        _ => return None,
    })
}

/// The manifest key of the running build. Resolved from the compile target, so a cross build
/// looks for the artifact it actually ships, and `None` on a platform the product does not cover.
fn target_triple() -> Option<&'static str> {
    if cfg!(target_os = "windows") {
        if cfg!(target_env = "msvc") {
            return match (cfg!(target_arch = "x86_64"), cfg!(target_arch = "aarch64")) {
                (true, _) => Some("x86_64-pc-windows-msvc"),
                (_, true) => Some("aarch64-pc-windows-msvc"),
                _ => None,
            };
        }
        if cfg!(target_env = "gnu") && cfg!(target_arch = "x86_64") {
            return Some("x86_64-pc-windows-gnu");
        }
        return None;
    }
    if cfg!(target_os = "macos") {
        return match (cfg!(target_arch = "x86_64"), cfg!(target_arch = "aarch64")) {
            (true, _) => Some("x86_64-apple-darwin"),
            (_, true) => Some("aarch64-apple-darwin"),
            _ => None,
        };
    }
    if cfg!(target_os = "linux") {
        return match (
            cfg!(target_env = "musl"),
            cfg!(target_arch = "x86_64"),
            cfg!(target_arch = "aarch64"),
        ) {
            (true, true, _) => Some("x86_64-unknown-linux-musl"),
            (true, _, true) => Some("aarch64-unknown-linux-musl"),
            (_, true, _) => Some("x86_64-unknown-linux-gnu"),
            (_, _, true) => Some("aarch64-unknown-linux-gnu"),
            _ => None,
        };
    }
    None
}

/// Reads the manifest beside `path` and checks the file against it.
///
/// Every call reads the manifest and hashes the file, with no memoized verdict behind it: a check
/// that can be skipped is not a check, and the two things a weaker key would have to lean on - the
/// file's size and its modification time - are both attacker-controlled. A settings read and a
/// later spawn therefore each pay one hash of the artifact; that is the price of the guarantee that
/// nothing is ever started, and nothing is ever reported as verified, without being hashed first.
///
/// Nothing here reports a filesystem path: the message travels to the UI, and the remedy - rebuild
/// and reinstall the host artifact - is the same wherever it was found.
fn verify(path: &Path) -> IpcResult<HostArtifact> {
    let metadata = fs::metadata(path).map_err(|_| {
        IpcError::new(
            ENGINE_NOT_FOUND,
            "The engine host program could not be read.",
        )
    })?;
    if !metadata.is_file() {
        return Err(IpcError::new(
            ENGINE_NOT_FOUND,
            "The engine host program is not a file.",
        ));
    }
    if metadata.len() > MAX_ARTIFACT_BYTES {
        return Err(mismatch(
            "The engine host program is larger than any artifact this build ships. Reinstall it.",
        ));
    }
    let manifest = read_manifest(path)?;
    if manifest.bytes != metadata.len() {
        return Err(mismatch(
            "The engine host program does not match the checksum recorded for it. Reinstall it.",
        ));
    }
    let digest = digest(path).ok_or_else(|| {
        IpcError::new(
            ENGINE_NOT_FOUND,
            "The engine host program could not be read.",
        )
    })?;
    if !manifest.sha256.eq_ignore_ascii_case(&digest) {
        return Err(mismatch(
            "The engine host program does not match the checksum recorded for it. Reinstall it.",
        ));
    }
    // After the digest, because a file that is not the one its manifest describes has no version
    // worth reading, and before the spawn, because an artifact speaking another vocabulary accepts
    // the handshake and then absorbs the commands it does not know - the state this check exists to
    // report instead of leaving the user with pages that never fill in.
    if manifest.protocol != PROTOCOL_VERSION {
        return Err(IpcError::from_message(
            ENGINE_PROTOCOL,
            format!(
                "The engine host program was built for protocol {}, this build speaks protocol {}. Rebuild it with `bun run host/build.ts --install` and restart the application.",
                manifest.protocol, PROTOCOL_VERSION
            ),
        ));
    }
    Ok(HostArtifact {
        program: path.to_path_buf(),
        args: Vec::new(),
        path: path.to_path_buf(),
        sdk_version: manifest.sdk_version,
    })
}

/// Reads the bundle's manifest and checks every file it lists.
///
/// The manifest itself is not hashed: like `omp-host.json`, it is the document that carries the
/// digests, and it ships inside the same directory the installer wrote. What it *does* have to
/// survive is arithmetic - a name that leaves the directory is refused before it is read, and
/// every file it lists is hashed at its recorded size.
fn verify_bundle(directory: &Path) -> IpcResult<HostArtifact> {
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
            format!(
                "The engine host program was built for protocol {}, this build speaks protocol {}. Rebuild it with `bun run host/build.ts --bundle` and restart the application.",
                manifest.protocol, PROTOCOL_VERSION
            ),
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

/// Reads `omp-host.json` from the binary's own directory.
fn read_manifest(path: &Path) -> IpcResult<Manifest> {
    let manifest_path = path.with_file_name(MANIFEST_FILE);
    let text = fs::read_to_string(&manifest_path).map_err(|_| {
        mismatch(
            "The engine host manifest is missing, so the program cannot be verified. Reinstall it.",
        )
    })?;
    serde_json::from_str::<Manifest>(&text).map_err(|_| {
        mismatch("The engine host manifest is unreadable, so the program cannot be verified. Reinstall it.")
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
#[cfg(test)]
mod tests;

#[cfg(test)]
mod bundle_tests;

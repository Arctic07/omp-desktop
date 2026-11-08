//! Locating the shipped host artifact and vouching for it.
//!
//! This is the half of the harness that has nothing to do with processes: the application's own
//! locator decides *which* program is the host, and then this module re-derives the manifest here.
//! A passing test has to mean "these bytes are the ones the manifest describes", not "the code
//! that checked it said so" - so every digest, every size and the SDK version are recomputed from
//! disk. Both layouts are covered: a compiled artifact against `omp-host.json`, and a bundle
//! against the file list in `bundle/manifest.json`.

use std::io::Read;
use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::services::host_bin::{self, HostArtifact};
use crate::services::runtime::PROTOCOL_VERSION;

use super::field;

/// Where the repository's own artifact and manifest live, relative to this crate.
const ARTIFACT_DIR: &str = "binaries";
const MANIFEST_FILE: &str = "omp-host.json";

/// Locates the shipped artifact the way the application does, then verifies it independently.
pub(super) fn locate() -> HostArtifact {
    let artifact = host_bin::locate().unwrap_or_else(|error| {
        panic!(
            "the host artifact must be locatable and verified: [{}] {}",
            error.code, error.message
        )
    });
    if artifact.path.is_dir() {
        verify_bundle_independently(&artifact);
        return artifact;
    }
    let manifest = read_manifest(&artifact.path);
    let bytes = std::fs::metadata(&artifact.path)
        .unwrap_or_else(|error| panic!("the located artifact must be readable: {error}"))
        .len();
    assert_eq!(
        Some(bytes),
        field(&manifest, &["bytes"]).as_u64(),
        "the artifact's size must be the size its manifest records"
    );
    assert_eq!(
        digest(&artifact.path),
        field(&manifest, &["sha256"])
            .as_str()
            .expect("the manifest records a digest")
            .to_ascii_lowercase(),
        "the artifact's digest must be the digest its manifest records"
    );
    assert_eq!(
        Some(artifact.sdk_version.as_str()),
        field(&manifest, &["sdkVersion"]).as_str(),
        "the SDK version the locator reports comes from the manifest"
    );
    assert_eq!(
        field(&manifest, &["protocol"]).as_u64(),
        Some(u64::from(PROTOCOL_VERSION)),
        "the artifact must be built for the protocol this build speaks ({MANIFEST_FILE} records it)"
    );

    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join(ARTIFACT_DIR);
    let name = repository_artifact_name();
    let copy = repository.join(name);
    let copy_manifest = read_manifest(&copy);
    assert_eq!(
        digest(&copy),
        field(&copy_manifest, &["sha256"])
            .as_str()
            .expect("the repository manifest records a digest")
            .to_ascii_lowercase(),
        "the repository copy {name} must be the file {MANIFEST_FILE} describes"
    );
    assert_eq!(
        std::fs::metadata(&copy).map(|data| data.len()).ok(),
        field(&copy_manifest, &["bytes"]).as_u64(),
        "the repository copy's size must be the size {MANIFEST_FILE} records"
    );
    artifact
}

/// The manifest shipped beside an artifact.
fn read_manifest(artifact: &Path) -> Value {
    let path = artifact.with_file_name(MANIFEST_FILE);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} must be readable: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} must be a JSON manifest: {error}", path.display()))
}

/// Name of this build's installed artifact, resolved the way `host_bin` resolves it.
fn repository_artifact_name() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "omp-host-x86_64-pc-windows-msvc.exe",
        ("windows", "aarch64") => "omp-host-aarch64-pc-windows-msvc.exe",
        ("macos", "x86_64") => "omp-host-x86_64-apple-darwin",
        ("macos", "aarch64") => "omp-host-aarch64-apple-darwin",
        ("linux", "x86_64") => "omp-host-x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "omp-host-aarch64-unknown-linux-gnu",
        other => panic!("no host artifact is built for {other:?}"),
    }
}

/// Lowercase hex sha256 of a file, read in fixed chunks so a 170 MB artifact is never held whole.
fn digest(path: &Path) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut file = std::fs::File::open(path)
        .unwrap_or_else(|error| panic!("{} must open: {error}", path.display()));
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .unwrap_or_else(|error| panic!("{} must be readable: {error}", path.display()));
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let sum = hasher.finalize();
    let mut text = String::with_capacity(sum.len() * 2);
    for byte in sum {
        text.push(HEX[usize::from(byte >> 4)] as char);
        text.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    text
}

/// Re-derives a bundle's file list from disk, the way the compiled path re-derives its manifest.
fn verify_bundle_independently(artifact: &HostArtifact) {
    let manifest_path = artifact.path.join("manifest.json");
    let text = std::fs::read_to_string(&manifest_path)
        .unwrap_or_else(|error| panic!("{} must be readable: {error}", manifest_path.display()));
    let manifest: Value = serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} must be JSON: {error}", manifest_path.display()));
    assert_eq!(
        field(&manifest, &["sdkVersion"]).as_str(),
        Some(artifact.sdk_version.as_str()),
        "the SDK version the locator reports comes from the bundle manifest"
    );
    assert_eq!(
        field(&manifest, &["protocol"]).as_u64(),
        Some(u64::from(PROTOCOL_VERSION)),
        "the bundle must be built for the protocol this build speaks"
    );
    let files = field(&manifest, &["files"])
        .as_array()
        .expect("the bundle manifest lists its files");
    assert!(
        !files.is_empty(),
        "the bundle manifest lists at least one file"
    );
    for file in files {
        let name = field(file, &["file"])
            .as_str()
            .expect("every entry names a file");
        let path = artifact.path.join(name);
        assert_eq!(
            std::fs::metadata(&path).map(|data| data.len()).ok(),
            field(file, &["bytes"]).as_u64(),
            "{name} must be the size the bundle manifest records"
        );
        assert_eq!(
            digest(&path),
            field(file, &["sha256"])
                .as_str()
                .expect("every entry records a digest")
                .to_ascii_lowercase(),
            "{name} must be the file the bundle manifest describes"
        );
    }
    assert!(
        artifact.program.is_file(),
        "the located program must be a file in the bundle"
    );
    assert!(
        artifact
            .args
            .last()
            .is_some_and(|arg| Path::new(arg).is_file()),
        "the invocation must end at an existing entry file"
    );
}

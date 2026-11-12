//! Locating the shipped host artifact and vouching for it.
//!
//! This is the half of the harness that has nothing to do with processes: the application's own
//! locator decides *which* directory is the host, and then this module re-derives the manifest
//! here. A passing test has to mean "these bytes are the ones the manifest describes", not "the
//! code that checked it said so" - so every digest, every size and the SDK version are recomputed
//! from disk.

use std::io::Read;
use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::services::host_bin::{self, HostArtifact};
use crate::services::runtime::PROTOCOL_VERSION;

use super::field;

/// Locates the shipped artifact the way the application does, then verifies it independently.
pub(super) fn locate() -> HostArtifact {
    let artifact = host_bin::locate().unwrap_or_else(|error| {
        panic!(
            "the host artifact must be locatable and verified: [{}] {}",
            error.code, error.message
        )
    });
    assert!(
        artifact.path.is_dir(),
        "the shipped host is the bundle directory"
    );
    verify_bundle_independently(&artifact);
    artifact
}

/// Lowercase hex sha256 of a file, read in fixed chunks so a multi-hundred-megabyte bundle is
/// never held whole.
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

/// Re-derives a bundle's file list from disk, the way the manifest records it.
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

//! Unit tests for the compiled-artifact path.

pub(crate) use super::*;

/// One directory per case: two tests that share a path would read each other's manifest, and a
/// product check whose result depends on test ordering is not worth having.
fn workspace(case: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("omp-host-bin-{case}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let _ = fs::create_dir_all(&root);
    root
}

/// The regression this covers: a binary whose bytes do not match the digest recorded beside
/// it must be refused, not started.
#[test]
fn a_tampered_artifact_is_refused() {
    let root = workspace("tampered");
    let bin = root.join("omp-host.exe");
    fs::write(&bin, b"real host bytes").expect("write bin");
    let bytes = fs::metadata(&bin).expect("metadata").len();
    let digest = digest(&bin).expect("digest");
    fs::write(
            root.join(MANIFEST_FILE),
            format!(r#"{{"sdkVersion":"18.6.1","protocol":{PROTOCOL_VERSION},"bytes":{bytes},"sha256":"{digest}"}}"#),
        )
        .expect("write manifest");
    assert_eq!(verify(&bin).expect("verified").sdk_version, "18.6.1");

    fs::write(&bin, b"tampered host bytes").expect("rewrite bin");
    let error = verify(&bin).expect_err("tampered");
    assert_eq!(error.code, ENGINE_CHECKSUM_MISMATCH);
    assert!(!error.message.contains(&root.to_string_lossy().to_string()));

    // A missing manifest is the same refusal: nothing vouches for the file.
    fs::remove_file(root.join(MANIFEST_FILE)).expect("remove manifest");
    assert_eq!(
        verify(&bin).expect_err("no manifest").code,
        ENGINE_CHECKSUM_MISMATCH
    );
    let _ = fs::remove_dir_all(&root);
}

/// The regression this covers: a replacement that keeps the file's size *and* its modification
/// time must still be refused. A verdict remembered under either of those two facts would hand
/// back the previous answer and start a file nobody hashed.
#[test]
fn a_same_size_same_time_replacement_is_refused() {
    let root = workspace("sametime");
    let bin = root.join("omp-host.exe");
    fs::write(&bin, b"real host bytes").expect("write bin");
    let metadata = fs::metadata(&bin).expect("metadata");
    let modified = metadata.modified().expect("mtime");
    let digest = digest(&bin).expect("digest");
    fs::write(
            root.join(MANIFEST_FILE),
            format!(
                r#"{{"sdkVersion":"18.6.1","protocol":{PROTOCOL_VERSION},"bytes":{},"sha256":"{digest}"}}"#,
                metadata.len()
            ),
        )
        .expect("write manifest");
    assert!(verify(&bin).is_ok());

    // Same length, same timestamp, different bytes.
    fs::write(&bin, b"evil host bytes").expect("rewrite bin");
    fs::OpenOptions::new()
        .write(true)
        .open(&bin)
        .expect("open bin")
        .set_modified(modified)
        .expect("restore mtime");
    assert_eq!(fs::metadata(&bin).expect("metadata").len(), metadata.len());
    assert_eq!(
        verify(&bin).expect_err("swapped bytes").code,
        ENGINE_CHECKSUM_MISMATCH
    );
    let _ = fs::remove_dir_all(&root);
}

/// A manifest that records a different size is a mismatch on its own, without trusting either
/// value alone.
#[test]
fn a_size_mismatch_is_refused() {
    let root = workspace("size");
    let bin = root.join("omp-host.exe");
    fs::write(&bin, b"bytes").expect("write bin");
    let digest = digest(&bin).expect("digest");
    fs::write(
            root.join(MANIFEST_FILE),
            format!(r#"{{"sdkVersion":"18.6.1","protocol":{PROTOCOL_VERSION},"bytes":1,"sha256":"{digest}"}}"#),
        )
        .expect("write manifest");
    assert_eq!(
        verify(&bin).expect_err("size").code,
        ENGINE_CHECKSUM_MISMATCH
    );
    let _ = fs::remove_dir_all(&root);
}

/// The regression this covers: the artifact the desktop is about to start was built for another
/// command vocabulary. Its bytes are exactly the ones its manifest describes, so a digest check
/// alone vouches for it - and it would then accept the handshake and silently ignore every
/// command added since it was built, which is what the version in the manifest exists to
/// refuse. The refusal names the remedy, because nothing else about the file is wrong.
#[test]
fn an_artifact_built_for_another_protocol_is_refused() {
    let root = workspace("protocol");
    let bin = root.join("omp-host.exe");
    fs::write(&bin, b"real host bytes").expect("write bin");
    let bytes = fs::metadata(&bin).expect("metadata").len();
    let digest = digest(&bin).expect("digest");
    let other = PROTOCOL_VERSION + 1;
    fs::write(
        root.join(MANIFEST_FILE),
        format!(
            r#"{{"sdkVersion":"18.6.1","protocol":{other},"bytes":{bytes},"sha256":"{digest}"}}"#
        ),
    )
    .expect("write manifest");

    let error = verify(&bin).expect_err("another protocol");
    assert_eq!(error.code, ENGINE_PROTOCOL);
    assert!(
        error.message.contains(&other.to_string())
            && error.message.contains(&PROTOCOL_VERSION.to_string()),
        "the refusal states both protocols: {}",
        error.message
    );
    assert!(!error.message.contains(&root.to_string_lossy().to_string()));

    // A manifest that does not state a protocol at all is unreadable rather than trusted: an
    // artifact nothing can vouch for is not one this build starts.
    fs::write(
        root.join(MANIFEST_FILE),
        format!(r#"{{"sdkVersion":"18.6.1","bytes":{bytes},"sha256":"{digest}"}}"#),
    )
    .expect("write manifest");
    assert_eq!(
        verify(&bin).expect_err("no protocol").code,
        ENGINE_CHECKSUM_MISMATCH
    );
    let _ = fs::remove_dir_all(&root);
}

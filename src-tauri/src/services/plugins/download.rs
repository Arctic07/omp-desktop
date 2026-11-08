//! Fetching one package archive from an address the user pasted (R3 §2.1).
//!
//! The engine installs plugins; it does not download a `.zip` for this application. A URL source is
//! therefore fetched here, into this application's own import root, and then walked through the same
//! import path a picked file takes (`services::plugins::import_flow`): unpack, guards, catalogue,
//! promote, install or upgrade. What this module owns is the fetch and nothing else - no install, no
//! registry write, no engine call.
//!
//! The hardening is the posture `services::plugins::net` takes for a plugin page's `fetch`, applied
//! to one file:
//!
//! - **The scheme is the address's own half of the check.** `https` always; `http` only for this
//!   machine's loopback, which is what a developer's own file server is. Everything else - `file`,
//!   `ftp`, a data URL - is refused before a socket is opened.
//! - **Redirects are followed by hand** (`redirect::Policy::none()`), at most
//!   [`MAX_HOPS`] of them, and every hop is re-parsed and re-checked against that same rule: a
//!   redirect that leaves `https` is refused even to a loopback address, because a downgrade is not
//!   something a package's server gets to decide.
//! - **The request carries two headers.** `User-Agent` and `Accept`, both this build's. No cookie
//!   store is configured and no `authorization`, `cookie` or `proxy-authorization` header is ever
//!   set, so a URL a user pasted cannot hand this application's identity to whoever answers it.
//! - **The bytes are bounded while they arrive.** The body is streamed to disk through a
//!   [`MAX_DOWNLOAD_BYTES`] ceiling rather than buffered whole, and a body that crosses it is
//!   abandoned with the partial file removed.
//! - **The digest is computed as the bytes are written** and compared with the checksum the caller
//!   declared. A URL source has no local `checksums.json` to fall back on, so this comparison is the
//!   whole integrity check an install from a URL gets; a mismatch is a refusal with the file removed.
//! - **Nothing outlives a failure.** Every path out of [`download`] that is not a verified file
//!   removes the file it was writing, so a failed download never becomes an archive something else
//!   picks up.
//!
//! The whole call is blocking (`reqwest::blocking`) and is run on the blocking pool by its caller
//! (`services::plugins::import_flow`), which is the same split every other file- and network-heavy
//! step of an import uses.

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::errors::{IpcError, PLUGIN_DOWNLOAD_FAILED};

/// Ceiling on one downloaded archive, counted in the bytes that actually arrive rather than in a
/// declared length a server could lie about.
pub(crate) const MAX_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;

/// How many redirects one download may follow, each one re-checked against the address rule.
pub(crate) const MAX_HOPS: usize = 8;

/// How long the whole download may take, redirects included.
///
/// Spent by the loop below rather than by the client, because a client timeout applies to one
/// request: eight followed hops would otherwise each get their own budget and a slow chain could hold
/// a blocking thread for many minutes.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(120);

/// The `User-Agent` every download carries: this application's, never the caller's.
const USER_AGENT: &str = concat!("OmpDesktop/", env!("CARGO_PKG_VERSION"));

/// What this build says it accepts. A package is a zip; anything else is taken as the server's own
/// idea of a binary, and an HTML error page that arrives instead is refused by the unpacking rather
/// than by a content-type guess made here.
const ACCEPT: &str = "application/zip, application/octet-stream;q=0.9, */*;q=0.1";

/// The client every download is made with, or `None` when it could not be built at all.
///
/// Built once and shared, like the plugin page's own client: the bounds this module enforces are per
/// *download*, so sharing the connection pool is what makes a second download cheap rather than what
/// makes it different. Redirects are followed by hand, and no cookie store is configured - the
/// builder's default - so nothing this module fetches changes what the next call sends.
static CLIENT: LazyLock<Option<reqwest::blocking::Client>> = LazyLock::new(|| {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(USER_AGENT)
        .build()
        .ok()
});

/// One verified download: how many bytes arrived, and their digest.
#[derive(Debug, Clone)]
pub(crate) struct DownloadOutcome {
    pub(crate) bytes: u64,
    pub(crate) sha256: String,
}

/// Downloads one package archive to `dest`, with the hardening stated on the module.
///
/// `expected_sha256` is the digest the caller declared (64 hex digits, lowercase by the time it
/// reaches here - the command layer lowercases it). The answer is the verified digest, so the caller
/// can log what it installed without hashing the file a second time.
pub(crate) fn download(
    url: &str,
    dest: &Path,
    expected_sha256: &str,
) -> Result<DownloadOutcome, IpcError> {
    let expected = expected_sha256.trim().to_ascii_lowercase();
    let Some(client) = CLIENT.as_ref() else {
        return Err(refusal(
            "The download could not be started on this machine.",
        ));
    };
    let mut current = parse_address(url)?;
    let deadline = Instant::now() + TIMEOUT;
    let mut hops = 0;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(refusal("The download did not finish in time."));
        }
        let response = client
            .get(current.as_str())
            .header(reqwest::header::ACCEPT, ACCEPT)
            .timeout(left)
            .send()
            .map_err(|error| transport_refusal(&error))?;
        let status = response.status();
        if !is_redirect(status) {
            if !status.is_success() {
                return Err(refusal(format!(
                    "The package's server refused the download (HTTP {}).",
                    status.as_u16()
                )));
            }
            return write_verified(response, dest, &expected);
        }
        if hops == MAX_HOPS {
            return Err(refusal(
                "The download was redirected more times than this application follows.",
            ));
        }
        let Some(location) = header_text(&response, reqwest::header::LOCATION) else {
            return Err(refusal(
                "The download was answered with a redirect that names no target.",
            ));
        };
        let next = current.join(&location).map_err(|_| {
            refusal("The download was answered with a redirect to an address it cannot read.")
        })?;
        // The hop is checked exactly like the first address, and one thing more: an `https`
        // download never continues over `http`, not even to this machine's loopback, because a
        // package's own server does not get to decide that the rest of the fetch is unencrypted.
        let next = parse_address(next.as_str())?;
        if current.scheme() == "https" && next.scheme() != "https" {
            return Err(refusal(
                "The download was redirected to a less secure address, so it was stopped.",
            ));
        }
        current = next;
        hops += 1;
    }
}

/// One address this build will fetch, or the refusal that says why it will not.
///
/// `https` is always allowed; `http` only when the host is this machine's own loopback, which is the
/// development case the rule exists for. A host that names nothing is refused rather than left for
/// the transport to interpret.
fn parse_address(url: &str) -> Result<tauri::Url, IpcError> {
    let parsed = tauri::Url::parse(url.trim())
        .map_err(|_| refusal("The download address is not a URL this application can read."))?;
    let scheme = parsed.scheme();
    let allowed = match scheme {
        "https" => true,
        "http" => is_loopback_host(parsed.host_str().unwrap_or_default()),
        _ => false,
    };
    if !allowed || parsed.host_str().is_none() {
        return Err(refusal(
            "The package must be downloaded over https (or http from this machine itself).",
        ));
    }
    Ok(parsed)
}

/// Whether one host names the loopback interface of this machine.
///
/// The three spellings a URL can carry: the IPv4 address, the IPv6 address (with or without the
/// brackets `host_str` keeps) and the name. Deliberately not the whole `127.0.0.0/8` range: the rule
/// names the loopback address, and a range would be a second, looser rule to keep in step.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    host == "127.0.0.1" || host == "::1" || host.eq_ignore_ascii_case("localhost")
}

/// Streams one response body to `dest`, bounded and hashed, and verifies the digest.
///
/// A file that is not the one the caller asked for is removed rather than left behind: a half-written
/// archive in the import root is something a later step could pick up and read as a package.
fn write_verified(
    mut response: reqwest::blocking::Response,
    dest: &Path,
    expected: &str,
) -> Result<DownloadOutcome, IpcError> {
    // `reqwest::blocking::Response` is a reader, which is what the streaming loop below takes: the
    // loop is one rule whether the bytes come from a socket or from a fixture in the tests.
    let outcome = stream_to(&mut response, dest, expected);
    if outcome.is_err() {
        if let Err(error) = std::fs::remove_file(dest) {
            crate::services::log::warn(&format!(
                "a failed download's partial file could not be removed: {error}"
            ));
        }
    }
    outcome
}

/// Copies one body into `dest` under the size ceiling, hashing as it goes, and verifies the digest.
fn stream_to(
    body: &mut impl Read,
    dest: &Path,
    expected: &str,
) -> Result<DownloadOutcome, IpcError> {
    let mut file = File::create(dest).map_err(|_| {
        refusal("The download could not be written to this application's data directory.")
    })?;
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = body.read(&mut buffer).map_err(|_| {
            refusal("The download was interrupted before the package arrived in full.")
        })?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > MAX_DOWNLOAD_BYTES {
            return Err(refusal(format!(
                "The package is larger than {} MB.",
                MAX_DOWNLOAD_BYTES / (1024 * 1024)
            )));
        }
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read]).map_err(|_| {
            refusal("The download could not be written to this application's data directory.")
        })?;
    }
    file.flush().map_err(|_| {
        refusal("The download could not be written to this application's data directory.")
    })?;
    let sha256 = format!("{:x}", hasher.finalize());
    if sha256 != expected {
        return Err(refusal(
            "The downloaded package does not match the checksum it was requested with.",
        ));
    }
    Ok(DownloadOutcome {
        bytes: total,
        sha256,
    })
}

/// One response header as text, when the response carries it as text.
fn header_text(
    response: &reqwest::blocking::Response,
    name: reqwest::header::HeaderName,
) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

/// Whether one status is a redirect this module follows itself.
fn is_redirect(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

/// One transport failure, in this application's own words. The address is deliberately not quoted:
/// a URL a user pasted can carry a token in its query, and a refusal is not a place to publish one.
fn transport_refusal(error: &reqwest::Error) -> IpcError {
    if error.is_timeout() {
        refusal("The download did not finish in time.")
    } else if error.is_connect() {
        refusal("The package's server could not be reached.")
    } else {
        refusal("The download failed before the package arrived.")
    }
}

/// One refusal, in the code this application publishes for a download that did not happen.
fn refusal(message: impl Into<String>) -> IpcError {
    IpcError::from_message(PLUGIN_DOWNLOAD_FAILED, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The address rule: `https` anywhere, `http` only for this machine's own loopback, and nothing
    /// else at all. The three loopback spellings a URL can carry are the three accepted ones.
    #[test]
    fn only_https_and_loopback_http_addresses_are_fetched() {
        for allowed in [
            "https://example.com/pkg.omp.zip",
            "https://127.0.0.1/pkg.omp.zip",
            "http://127.0.0.1:8080/pkg.omp.zip",
            "http://localhost/pkg.omp.zip",
            "http://LOCALHOST/pkg.omp.zip",
            "http://[::1]:9000/pkg.omp.zip",
        ] {
            assert!(parse_address(allowed).is_ok(), "{allowed}");
        }
        for refused in [
            "http://example.com/pkg.omp.zip",
            "http://10.0.0.5/pkg.omp.zip",
            "file:///etc/passwd",
            "ftp://example.com/pkg.zip",
            "data:application/zip;base64,AAAA",
            "not a url",
            "https://",
        ] {
            let error = parse_address(refused).expect_err(refused);
            assert_eq!(error.code.as_ref(), PLUGIN_DOWNLOAD_FAILED, "{refused}");
        }
        // The loopback test is the host's own, exactly: a name that merely starts with one is not
        // this machine.
        assert!(!is_loopback_host("127.0.0.1.evil.test"));
        assert!(!is_loopback_host("localhost.evil.test"));
        assert!(!is_loopback_host("127.0.0.2"));
    }

    /// A redirect status is one this module follows itself; a body that arrives with any other status
    /// is written (or refused) where it lands.
    #[test]
    fn a_redirect_status_is_one_this_module_follows_itself() {
        for status in [301u16, 302, 303, 307, 308] {
            assert!(is_redirect(
                reqwest::StatusCode::from_u16(status).expect("a status")
            ));
        }
        for status in [200u16, 204, 400, 404, 500] {
            assert!(!is_redirect(
                reqwest::StatusCode::from_u16(status).expect("a status")
            ));
        }
    }

    /// A digest is computed over the bytes that arrive, and a body that does not hash to the
    /// declared checksum is refused with the file removed - which is the whole integrity check a URL
    /// install gets.
    #[test]
    fn a_body_that_does_not_hash_to_the_declared_checksum_is_refused() {
        let dest = std::env::temp_dir().join(format!("omp-download-{}", std::process::id()));
        let payload = b"a package, pretending";
        let digest = format!("{:x}", Sha256::digest(payload));

        let mut body: &[u8] = payload;
        let outcome = stream_to(&mut body, &dest, &digest).expect("verified");
        assert_eq!(outcome.bytes, payload.len() as u64);
        assert_eq!(outcome.sha256, digest);
        assert_eq!(std::fs::read(&dest).expect("written"), payload);

        // A digest that is not the body's is a refusal, and the file does not survive it.
        let mut body: &[u8] = payload;
        let error = stream_to(&mut body, &dest, &"0".repeat(64)).expect_err("mismatch");
        assert_eq!(error.code.as_ref(), PLUGIN_DOWNLOAD_FAILED);
        // `stream_to` leaves the file to its caller to remove; `write_verified` is what removes it,
        // so the assertion here is about the refusal rather than about the file.
        assert!(dest.is_file());
        let _ = std::fs::remove_file(&dest);
    }

    /// The ceiling is counted in the bytes that actually arrive, so a server that declares a small
    /// package and sends a large one is still stopped - and stopped before the whole body is read.
    #[test]
    fn a_body_over_the_ceiling_is_refused() {
        let dest = std::env::temp_dir().join(format!("omp-download-big-{}", std::process::id()));
        // One byte more than the ceiling, produced lazily so the test does not allocate it.
        struct Repeater(u64);
        impl Read for Repeater {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if self.0 == 0 {
                    return Ok(0);
                }
                let take = buffer.len().min(self.0 as usize);
                buffer[..take].fill(b'x');
                self.0 -= take as u64;
                Ok(take)
            }
        }
        let mut body = Repeater(MAX_DOWNLOAD_BYTES + 1);
        let error = stream_to(&mut body, &dest, &"0".repeat(64)).expect_err("over the ceiling");
        assert_eq!(error.code.as_ref(), PLUGIN_DOWNLOAD_FAILED);
        assert!(error.message.contains("MB"), "{}", error.message);
        let _ = std::fs::remove_file(&dest);
    }
}

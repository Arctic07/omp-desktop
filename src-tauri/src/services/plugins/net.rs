//! `net.fetch`: the one way a plugin page reaches the network (spec §6.4).
//!
//! The permission is the switch and `omp.desktop.net.domains` is the range: a manifest that declares
//! the permission and no domain reaches nothing at all, and a domain list is compared by *name*,
//! exactly. What makes this module more than a proxy is what it does with a redirect:
//!
//! - **Every hop is checked.** The client is built with redirect following *off*, so each `Location`
//!   is resolved here and re-asked against the same list. A request that leaves the allow-list
//!   half-way through is refused there, not followed and refused at the end - which is the whole
//!   reason the spec puts per-hop re-checking in the contract.
//! - **The bounds are the caller's, not the plugin's.** Method, headers and body size are this
//!   build's; a plugin asks for a URL and gets a body. Response headers other than the content type
//!   are dropped (a `set-cookie` from someone else's server has no business being handed to a page),
//!   the body is read through a cap rather than buffered to completion, and there is one timeout.
//! - **No state outlives the call.** The shared client keeps no cookie store and no cache: two calls
//!   are two requests, and nothing a plugin fetches changes what the next call receives.

use std::io::Read;

use base64::Engine;
use serde_json::{json, Value};

use crate::services::plugins::bridge::{
    Refusal, HOST_NOT_DECLARED, INTERNAL, INVALID_REQUEST, REDIRECT_REFUSED, REQUEST_TIMEOUT,
    SCHEME_NOT_FETCHABLE, TOO_LARGE,
};

/// How much of one response body this build reads before it gives up.
pub(crate) const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// How much of a request body this build will send.
pub(crate) const MAX_REQUEST_BYTES: usize = 256 * 1024;

/// How many redirects one call may follow, each one re-checked against the domain list.
pub(crate) const MAX_HOPS: usize = 8;

/// How long one *call* may take, redirects included.
///
/// The budget is spent by the loop below rather than by the client: a client timeout applies to one
/// request, so eight followed hops would each get their own thirty seconds and a slow chain could
/// hold a blocking thread for minutes. The deadline is computed once and each hop is given what is
/// left of it.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The methods a plugin may ask for. A plugin gets what a page could do with `fetch` and no more:
/// `DELETE`/`PATCH`/`PUT` are refused rather than forwarded, because nothing in the plugin contract
/// describes what they would mean to the server on the other side.
const ALLOWED_METHODS: [&str; 3] = ["GET", "HEAD", "POST"];

/// The `User-Agent` every plugin request carries: this application's, never the plugin's.
const USER_AGENT: &str = concat!("OmpDesktop/", env!("CARGO_PKG_VERSION"));

/// The client one call is made with, or `None` when it could not be built at all.
///
/// Built once and shared: a client per call would build a runtime and a connection pool per call,
/// and the bounds this module enforces are per *request*, so sharing the pool is what makes a
/// plugin's repeated calls cheap rather than what makes them different.
static CLIENT: std::sync::LazyLock<Option<reqwest::blocking::Client>> =
    std::sync::LazyLock::new(|| {
        reqwest::blocking::Client::builder()
            // Redirects are followed here, one hop at a time, because each one has to be checked against
            // the manifest's domain list before it is made (spec §6.4).
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT)
            .user_agent(USER_AGENT)
            .build()
            .ok()
    });

/// One `net.fetch` call, as the bridge read its parameters.
#[derive(Debug, Clone)]
pub(crate) struct FetchRequest {
    pub(crate) method: String,
    pub(crate) url: String,
    pub(crate) content_type: Option<String>,
    pub(crate) body: Option<Vec<u8>>,
}

/// Reads one call's parameters, or says which shape was wrong.
pub(crate) fn read_params(params: &Value) -> Result<FetchRequest, Refusal> {
    let url = params
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 2_048)
        .ok_or(INVALID_REQUEST)?;
    let method = params
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .to_ascii_uppercase();
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(INVALID_REQUEST);
    }
    let content_type = match params.get("contentType") {
        None => None,
        // A content type this build will not send is a call it refuses rather than a field it drops:
        // the plugin asked for a request that is not the one it would get.
        Some(Value::String(value))
            if value.len() <= 128 && !value.chars().any(char::is_control) =>
        {
            Some(value.clone())
        }
        Some(_) => return Err(INVALID_REQUEST),
    };
    let body = match params.get("body").and_then(Value::as_str) {
        Some(text) => {
            if text.len() > MAX_REQUEST_BYTES {
                return Err(TOO_LARGE);
            }
            Some(text.as_bytes().to_vec())
        }
        None => None,
    };
    Ok(FetchRequest {
        method,
        url: url.to_owned(),
        content_type,
        body,
    })
}

/// The range one installation's egress is held to: the hosts the manifest listed, and the second key
/// beside them (`omp.desktop.net.anyHost`).
///
/// It is a type rather than two arguments because the two facts are one policy: every gate that asks
/// "may this address be reached" asks this function, and a caller that carried only the list would be
/// able to answer the question for a plugin that declared the wider range by disagreeing with it
/// (`rules.md#plugin-system` - the decision lives here, never beside a bridge method).
#[derive(Debug, Clone, Copy)]
pub(crate) struct NetPolicy<'a> {
    /// `omp.desktop.net.domains`: the hosts an egress may name.
    pub(crate) domains: &'a [String],
    /// `omp.desktop.net.anyHost`: the permission-gated second key. Only ever true when the manifest
    /// declared `net.anyHost` *and* set the block's flag - both are checked before this is built
    /// (`pages::PageGrants`), so a `true` here is a reach the user was told about.
    pub(crate) any_host: bool,
}

impl<'a> NetPolicy<'a> {
    /// The policy of the domains alone - what a test builds, and what a caller with no second key
    /// would pass.
    #[cfg(test)]
    pub(crate) fn domains(domains: &'a [String]) -> Self {
        Self {
            domains,
            any_host: false,
        }
    }
}

/// Whether one URL's host is one the policy allows.
///
/// The comparison is exact and case-insensitive (a host name has no case) against the names the
/// manifest declared - never a suffix or a wildcard, which is the rule `gates::is_host_name` already
/// applied when the row arrived. A manifest that holds the `anyHost` key is allowed any host, which
/// is the whole of what that key means.
pub(crate) fn host_allowed(url: &tauri::Url, policy: NetPolicy<'_>) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if policy.any_host {
        return true;
    }
    policy
        .domains
        .iter()
        .any(|domain| domain.eq_ignore_ascii_case(host))
}

/// Whether one URL may be asked for: an `http(s)` address the policy allows.
pub(crate) fn ensure_allowed(url: &str, policy: NetPolicy<'_>) -> Result<(), Refusal> {
    let parsed = tauri::Url::parse(url).map_err(|_| INVALID_REQUEST)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(SCHEME_NOT_FETCHABLE);
    }
    if parsed.host_str().is_none() {
        return Err(INVALID_REQUEST);
    }
    if host_allowed(&parsed, policy) {
        return Ok(());
    }
    Err(HOST_NOT_DECLARED)
}

/// Performs one call: every hop checked, the body read through a cap, the answer as the page reads it.
pub(crate) fn fetch(policy: NetPolicy<'_>, request: FetchRequest) -> Result<Value, Refusal> {
    let Some(client) = CLIENT.as_ref() else {
        return Err(INTERNAL);
    };
    let deadline = std::time::Instant::now() + TIMEOUT;
    let mut current = request.url.clone();
    let mut method = request.method.clone();
    // A redirect is followed with the same method and body until a 303 says otherwise (the one
    // status whose meaning is "ask again with GET"), which is what a page's own `fetch` would do.
    let mut body = request.body.clone();
    for hop in 0..=MAX_HOPS {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Err(REQUEST_TIMEOUT);
        }
        ensure_allowed(&current, policy)?;
        let mut builder = client.request(
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| INVALID_REQUEST)?,
            current.as_str(),
        );
        if let Some(content_type) = request.content_type.as_deref() {
            builder = builder.header(reqwest::header::CONTENT_TYPE, content_type);
        }
        if let Some(payload) = body.clone() {
            builder = builder.body(payload);
        }
        let response = builder
            .timeout(left)
            .send()
            .map_err(|error| request_refusal(&error))?;
        let status = response.status();
        if is_redirect(status) {
            if hop == MAX_HOPS {
                return Err(REDIRECT_REFUSED);
            }
            let content_type = header_text(&response, reqwest::header::CONTENT_TYPE);
            let Some(location) = header_text(&response, reqwest::header::LOCATION) else {
                // A redirect without a target is a server answer, not a hop: it is returned as it
                // stands rather than refused, because that is what the caller asked about.
                return Ok(outcome(
                    &current,
                    status.as_u16(),
                    content_type.as_ref(),
                    &[],
                ));
            };
            let base = tauri::Url::parse(&current).map_err(|_| INVALID_REQUEST)?;
            let next = base.join(&location).map_err(|_| INVALID_REQUEST)?;
            current = next.to_string();
            if status.as_u16() == 303 {
                method = "GET".to_owned();
                body = None;
            }
            continue;
        }
        let content_type = header_text(&response, reqwest::header::CONTENT_TYPE);
        let bytes = read_capped(response)?;
        return Ok(outcome(
            &current,
            status.as_u16(),
            content_type.as_ref(),
            &bytes,
        ));
    }
    Err(REDIRECT_REFUSED)
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

/// The response, as the page receives it: the final URL, the status, the content type, and the body
/// in the encoding that fits it. Every other response header is dropped on purpose - a plugin is
/// handed bytes, not a session.
fn outcome(url: &str, status: u16, content_type: Option<&String>, bytes: &[u8]) -> Value {
    let (encoding, text) = match std::str::from_utf8(bytes) {
        Ok(text) => ("utf8", text.to_owned()),
        Err(_) => (
            "base64",
            base64::engine::general_purpose::STANDARD.encode(bytes),
        ),
    };
    json!({
        "ok": true,
        "result": {
            "url": url,
            "status": status,
            "contentType": content_type.cloned(),
            "bytes": bytes.len(),
            "encoding": encoding,
            "text": text,
        },
    })
}

/// The response body, read through the cap rather than buffered whole.
fn read_capped(mut response: reqwest::blocking::Response) -> Result<Vec<u8>, Refusal> {
    let mut body: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = response.read(&mut chunk).map_err(|_| INTERNAL)?;
        if read == 0 {
            return Ok(body);
        }
        if body.len() + read > MAX_RESPONSE_BYTES {
            return Err(TOO_LARGE);
        }
        body.extend_from_slice(&chunk[..read]);
    }
}

/// One transport failure, in the vocabulary the page branches on: a timeout is its own answer, and
/// anything else is this application's failure rather than the plugin's.
fn request_refusal(error: &reqwest::Error) -> Refusal {
    if error.is_timeout() {
        REQUEST_TIMEOUT
    } else if error.is_connect() {
        Refusal {
            code: "unreachable",
            message: "That host could not be reached.",
        }
    } else {
        INTERNAL
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn domains() -> Vec<String> {
        vec!["api.example.com".to_owned(), "Example.ORG".to_owned()]
    }

    fn policy(domains: &[String]) -> NetPolicy<'_> {
        NetPolicy::domains(domains)
    }

    #[test]
    fn only_http_addresses_on_the_declared_names_are_asked_for() {
        assert!(ensure_allowed("https://api.example.com/v1/x", policy(&domains())).is_ok());
        assert!(
            ensure_allowed("http://API.example.com/x", policy(&domains())).is_ok(),
            "a host name is case-insensitive"
        );
        assert!(ensure_allowed("https://example.org/x", policy(&domains())).is_ok());
        assert!(
            ensure_allowed("https://example.com/x", policy(&domains())).is_err(),
            "a parent name is not a listed name"
        );
        assert!(ensure_allowed("https://api.example.com.evil.test/x", policy(&domains())).is_err());
        assert!(
            ensure_allowed("file:///etc/passwd", policy(&domains())).is_err(),
            "another scheme is not a fetch"
        );
        assert!(
            ensure_allowed("https://127.0.0.1/x", policy(&domains())).is_err(),
            "an address is not a name"
        );
        assert!(ensure_allowed("not a url", policy(&domains())).is_err());
        assert!(
            ensure_allowed("https://api.example.com/x", policy(&[])).is_err(),
            "no list is no reach"
        );
    }

    /// The second key (`net.anyHost`): with it, a name nobody listed is reachable, and the scheme
    /// rule is untouched - the flag widens *which* hosts, never which protocols.
    #[test]
    fn the_any_host_key_reaches_an_unlisted_name_and_nothing_else() {
        let wide = NetPolicy {
            domains: &[],
            any_host: true,
        };
        assert!(ensure_allowed("https://anything.example/x", wide).is_ok());
        assert!(
            ensure_allowed("file:///etc/passwd", wide).is_err(),
            "the flag widens the host list, not the scheme"
        );
        assert!(
            ensure_allowed("not a url", wide).is_err(),
            "an address this build cannot parse is not a host it may reach"
        );
    }

    #[test]
    fn parameters_are_read_with_the_bounds_this_build_publishes() {
        let ok = read_params(&json!({
            "url": "https://api.example.com/x",
            "method": "post",
            "contentType": "application/json",
            "body": "{\"a\":1}",
        }))
        .expect("a well-formed call");
        assert_eq!(
            ok.method, "POST",
            "the method is normalized to the spelling this build serves"
        );
        assert_eq!(ok.content_type.as_deref(), Some("application/json"));
        assert_eq!(ok.body.as_deref(), Some(b"{\"a\":1}".as_slice()));

        assert!(read_params(&json!({})).is_err());
        assert!(read_params(&json!({ "url": "https://a.test", "method": "DELETE" })).is_err());
        assert!(read_params(
            &json!({ "url": "https://a.test", "body": "x".repeat(MAX_REQUEST_BYTES + 1) })
        )
        .is_err());
        assert!(
            read_params(&json!({ "url": "https://a.test", "contentType": "a\u{7}b" })).is_err()
        );
    }

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

    #[test]
    fn a_body_is_answered_in_the_encoding_that_fits_it() {
        let json_out = outcome(
            "https://api.example.com/x",
            200,
            Some(&"application/json".to_owned()),
            br#"{"a":1}"#,
        );
        assert_eq!(json_out["result"]["encoding"], json!("utf8"));
        assert_eq!(json_out["result"]["text"], json!("{\"a\":1}"));
        let binary = outcome("https://api.example.com/x", 200, None, &[0xff, 0xfe]);
        assert_eq!(binary["result"]["encoding"], json!("base64"));
        assert_eq!(binary["result"]["text"], json!("//4="));
        assert_eq!(binary["result"]["bytes"], json!(2));
    }
}

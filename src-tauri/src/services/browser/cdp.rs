//! The agent's way into one browser page: in-process DevTools, no port.
//!
//! One guest, one deny-by-default method table. This build reaches the guest through WebView2's own
//! `CallDevToolsProtocolMethod`, which needs no socket: the call is made from this process, on the
//! page of the conversation that asked, and the answer comes back to it.
//!
//! Three rules keep it useful and bounded:
//!
//! - **Deny by default.** [`ALLOWED_METHODS`] is the whole set the public `cdp` action may call;
//!   cookie, storage, network, target and debugger domains are absent.
//! - **A snapshot is the vocabulary.** `snapshot` flattens the accessibility tree into an outline
//!   whose nodes carry `eN` ids, and remembers each id's `backendNodeId` for that page. `click` and
//!   `fill` accept an id from a snapshot and nothing else.
//! - **Every call is bounded.** A page that opens a native dialog or runs a busy loop never answers;
//!   [`CALL_TIMEOUT`] detaches the protocol session and reports a timeout, so the model gets an
//!   answer it can act on rather than a turn that never ends.
//!
//! Windows is the only platform with this API. Every action reports `BROWSER_UNSUPPORTED` elsewhere;
//! the chrome itself keeps working.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Webview;

/// How long one DevTools round trip may take.
pub(crate) const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// The most console lines one page keeps, and the default/maximum a `console` action reads.
pub(crate) const MAX_CONSOLE_MESSAGES: usize = 100;
const DEFAULT_CONSOLE_LIMIT: usize = 50;

/// The most characters one `evaluate` answer carries before it is reported as truncated.
const MAX_EVALUATE_CHARS: usize = 64 * 1024;

/// Screenshot bounds applied to a full-page capture: the page is scaled into them.
const SCREENSHOT_MAX_WIDTH: f64 = 1280.0;
const SCREENSHOT_MAX_HEIGHT: f64 = 2048.0;

/// Deny-by-default CDP methods the public `cdp` action may send.
///
/// The table is deliberately small: reading the document's structure, looking at it, and typing
/// into what a snapshot showed. Cookie, storage, target and network-interception methods stay off
/// it.
pub(crate) const ALLOWED_METHODS: &[&str] = &[
    "Page.enable",
    "Page.reload",
    "Page.captureScreenshot",
    "Page.getLayoutMetrics",
    "Page.getFrameTree",
    "Page.getNavigationHistory",
    "Page.getResourceTree",
    "Page.bringToFront",
    "DOM.enable",
    "DOM.getDocument",
    "DOM.querySelector",
    "DOM.querySelectorAll",
    "DOM.getBoxModel",
    "DOM.describeNode",
    "DOM.scrollIntoViewIfNeeded",
    "DOM.getOuterHTML",
    "DOM.getAttributes",
    "Runtime.enable",
    "Runtime.evaluate",
    "Runtime.callFunctionOn",
    "Runtime.getProperties",
    "Runtime.awaitPromise",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
    "Accessibility.enable",
    "Accessibility.getFullAXTree",
    "Accessibility.getPartialAXTree",
    "Console.enable",
];

/// Whether one method is in the public table.
pub(crate) fn is_allowed(method: &str) -> bool {
    ALLOWED_METHODS.contains(&method.trim())
}

/// One refusal from the guest's protocol channel.
#[derive(Debug, Clone)]
pub(crate) struct CdpError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl CdpError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// One console line, as the page's own wrapper recorded it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct ConsoleMessage {
    #[serde(rename = "type")]
    pub(crate) kind: String,
    pub(crate) text: String,
    pub(crate) timestamp: u64,
}

/// One accessibility node, as the protocol returns it.
#[derive(Debug, Clone)]
pub(crate) struct AxNode {
    pub(crate) node_id: String,
    pub(crate) ignored: bool,
    pub(crate) role: String,
    pub(crate) name: String,
    pub(crate) backend_dom_node_id: Option<i64>,
    pub(crate) child_ids: Vec<String>,
}

/// The outline one accessibility tree flattens to, and the ids in it.
#[derive(Debug, Clone)]
pub(crate) struct Snapshot {
    pub(crate) tree: String,
    pub(crate) uids: HashMap<String, i64>,
}

/// Flatten an accessibility tree into indented text with stable `eN` uids.
///
/// Ignored nodes are skipped (their children are not), roots are nodes no other node lists as a
/// child, and every visible node gets an id even when it carries no backend node (a heading is
/// read, not acted on).
///
/// Two things differ from a plain recursive flatten, and both are about whose numbers the tree is:
/// the descent is an explicit stack (`MAX_AX_NODES`), because the tree's depth is the *page's* and a
/// stack overflow aborts the process rather than unwinding; and the answer stops at
/// [`MAX_AX_TEXT_BYTES`] with a last line saying so, because a page's own text sizes it. A tree the
/// walk stops descending is a tree the caller can still act on: the uids it lists are real.
pub(crate) fn flatten_ax_tree(nodes: &[AxNode]) -> Snapshot {
    let by_id: HashMap<&str, &AxNode> = nodes
        .iter()
        .map(|node| (node.node_id.as_str(), node))
        .collect();
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut claimed: HashSet<&str> = HashSet::new();
    for node in nodes {
        for child in &node.child_ids {
            children
                .entry(node.node_id.as_str())
                .or_default()
                .push(child.as_str());
            claimed.insert(child.as_str());
        }
    }
    let mut roots: Vec<&AxNode> = nodes
        .iter()
        .filter(|node| !claimed.contains(node.node_id.as_str()))
        .collect();
    roots.sort_by(|left, right| left.node_id.cmp(&right.node_id));

    let mut uids = HashMap::new();
    let mut lines: Vec<String> = Vec::new();
    let mut bytes = 0usize;
    let mut next = 1usize;
    let mut truncated = false;
    // Pushed in reverse so a pop visits children in the order the tree lists them, exactly as the
    // recursion this replaces did.
    let mut stack: Vec<(&AxNode, usize)> = roots.iter().rev().map(|root| (*root, 0)).collect();
    let mut visits = 0usize;
    while let Some((node, depth)) = stack.pop() {
        // Three ceilings, all of them the page's own numbers: how many nodes are looked at (which is
        // what makes a cycle finite), how many are listed, and how much text they carry. A node whose
        // line would cross the text ceiling is not listed at all, so the answer never ends mid-line.
        visits += 1;
        if visits > MAX_AX_VISITS || lines.len() >= MAX_AX_NODES {
            truncated = true;
            break;
        }
        let child_depth = if node.ignored { depth } else { depth + 1 };
        if !node.ignored {
            let role = if node.role.trim().is_empty() {
                "Generic"
            } else {
                node.role.trim()
            };
            let name = node.name.trim();
            let uid = format!("e{next}");
            let label = if name.is_empty() {
                role.to_owned()
            } else {
                format!("{role} {}", serde_json::to_string(name).unwrap_or_default())
            };
            let line = format!("{}- {uid} {label}", "  ".repeat(depth));
            if bytes + line.len() + 1 > MAX_AX_TEXT_BYTES {
                truncated = true;
                break;
            }
            // The id is recorded only once its line is: `remember` and `node_of` resolve ids from
            // this table rather than from the text, so an element the answer does not show must not
            // be one `click` or `fill` can name - and the id that would have been listed next is
            // exactly the id a truncated tree must not offer.
            if let Some(backend) = node.backend_dom_node_id {
                uids.insert(uid, backend);
            }
            bytes += line.len() + 1;
            next += 1;
            lines.push(line);
        }
        if let Some(kids) = children.get(node.node_id.as_str()) {
            for kid in kids.iter().rev() {
                if let Some(child) = by_id.get(kid) {
                    stack.push((child, child_depth));
                }
            }
        }
    }
    if truncated {
        // No number here: which ceiling stopped the walk is this side's bookkeeping, and what the
        // caller needs to know is that the tree continues past what it can see.
        lines.push("... (truncated)".to_owned());
    }
    Snapshot {
        tree: if lines.is_empty() {
            "(empty)".to_owned()
        } else {
            lines.join("\n")
        },
        uids,
    }
}

struct CdpInner {
    /// Whether the protocol domains this build needs have been enabled on the current guest.
    attached: bool,
    /// The snapshot ids of the current document.
    uids: HashMap<String, i64>,
}

/// The CDP session of one page.
pub(crate) struct CdpSession {
    inner: Mutex<CdpInner>,
}

impl CdpSession {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(CdpInner {
                attached: false,
                uids: HashMap::new(),
            }),
        }
    }

    pub(crate) fn detach(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.attached = false;
            inner.uids.clear();
        }
    }

    fn attached(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.attached)
            .unwrap_or(false)
    }

    fn remember(&self, uids: HashMap<String, i64>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.uids = uids;
        }
    }

    fn node_of(&self, uid: &str) -> Result<i64, CdpError> {
        let inner = self.inner.lock().map_err(|_| {
            CdpError::new("UNAVAILABLE", "The page's snapshot table is unavailable.")
        })?;
        inner.uids.get(uid.trim()).copied().ok_or_else(|| {
            CdpError::new(
                "INVALID_ARGUMENT",
                format!("unknown or stale uid \"{uid}\"; call snapshot first"),
            )
        })
    }

    /// Enable the domains this build reads, once per guest.
    pub(crate) fn attach(&self, webview: &Webview) -> Result<(), CdpError> {
        if self.attached() {
            return Ok(());
        }
        if !cfg!(windows) {
            return Err(CdpError::new(
                crate::errors::BROWSER_UNSUPPORTED,
                "Driving a page's DevTools channel is not supported on this platform.",
            ));
        }
        for (method, params) in [
            ("Runtime.enable", json!({})),
            ("Page.enable", json!({})),
            ("DOM.enable", json!({})),
            ("Accessibility.enable", json!({})),
            (
                "Emulation.setFocusEmulationEnabled",
                json!({ "enabled": true }),
            ),
        ] {
            self.call(webview, method, &params)?;
        }
        if let Ok(mut inner) = self.inner.lock() {
            inner.attached = true;
        }
        Ok(())
    }

    /// One public protocol call, after the allowlist.
    pub(crate) fn send(
        &self,
        webview: &Webview,
        method: &str,
        params: &Value,
    ) -> Result<Value, CdpError> {
        if !is_allowed(method) {
            return Err(CdpError::new(
                "PERMISSION_DENIED",
                format!("CDP method not allowed: {method}"),
            ));
        }
        self.attach(webview)?;
        self.call(webview, method, params)
    }

    /// One internal call (enable, resolve, input), bypassing the public allowlist.
    fn call(&self, webview: &Webview, method: &str, params: &Value) -> Result<Value, CdpError> {
        self.call_raw(webview, method, params).map_err(|error| {
            if error.code == "TIMEOUT" {
                self.detach();
            }
            error
        })
    }

    #[cfg(windows)]
    fn call_raw(&self, webview: &Webview, method: &str, params: &Value) -> Result<Value, CdpError> {
        use std::sync::mpsc;

        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::HSTRING;

        let (sender, receiver) = mpsc::channel::<Result<String, String>>();
        let method_name = method.to_owned();
        let arguments = params.to_string();
        webview
            .with_webview(move |platform| {
                let callback_sender = sender.clone();
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |result: windows::core::Result<()>, payload: String| {
                        let outcome = match result {
                            Ok(()) => Ok(payload),
                            Err(error) => Err(error.to_string()),
                        };
                        let _ = callback_sender.send(outcome);
                        Ok(())
                    },
                ));
                let call = (|| -> windows::core::Result<()> {
                    let core = unsafe { platform.controller().CoreWebView2()? };
                    unsafe {
                        core.CallDevToolsProtocolMethod(
                            &HSTRING::from(method_name.as_str()),
                            &HSTRING::from(arguments.as_str()),
                            &handler,
                        )
                    }
                })();
                if let Err(error) = call {
                    let _ = sender.send(Err(error.to_string()));
                }
            })
            .map_err(|error| {
                CdpError::new(
                    "UNAVAILABLE",
                    format!("The page's channel could not be reached: {error}"),
                )
            })?;
        let payload = match receiver.recv_timeout(CALL_TIMEOUT) {
            Ok(Ok(payload)) => payload,
            Ok(Err(error)) => {
                return Err(CdpError::new(
                    "UNAVAILABLE",
                    format!("The page's channel refused that call: {error}"),
                ))
            }
            Err(_) => {
                return Err(CdpError::new(
                    "TIMEOUT",
                    "The page did not answer that request in time.",
                ))
            }
        };
        let envelope: Value = serde_json::from_str(&payload)
            .map_err(|_| CdpError::new("UNAVAILABLE", "The page's answer was not readable."))?;
        if let Some(error) = envelope.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the page refused that protocol call");
            return Err(CdpError::new(
                "INVALID_ARGUMENT",
                format!("The page refused `{method}`: {message}"),
            ));
        }
        // WebView2's callback carries the method's result object itself, not a JSON-RPC envelope
        // (`Runtime.evaluate` answers `{result, exceptionDetails}`, `Page.captureScreenshot` answers
        // `{data}`). Stripping a `result` field here would turn every flat result into null.
        Ok(envelope)
    }

    #[cfg(not(windows))]
    fn call_raw(
        &self,
        _webview: &Webview,
        _method: &str,
        _params: &Value,
    ) -> Result<Value, CdpError> {
        Err(CdpError::new(
            crate::errors::BROWSER_UNSUPPORTED,
            "Driving a page's DevTools channel is not supported on this platform.",
        ))
    }

    /// The accessibility tree, as an outline with `eN` ids on what can be acted on.
    pub(crate) fn snapshot(&self, webview: &Webview) -> Result<(String, String), CdpError> {
        let raw = self.send(webview, "Accessibility.getFullAXTree", &json!({}))?;
        let nodes = raw
            .get("nodes")
            .and_then(Value::as_array)
            .map(|nodes| nodes.iter().filter_map(parse_ax_node).collect::<Vec<_>>())
            .unwrap_or_default();
        let snapshot = flatten_ax_tree(&nodes);
        self.remember(snapshot.uids);
        let url = webview.url().map(|url| url.to_string()).unwrap_or_default();
        Ok((snapshot.tree, url))
    }

    /// One JPEG of the page; a full-page capture is scaled into the screenshot bounds.
    pub(crate) fn screenshot(
        &self,
        webview: &Webview,
        full_page: bool,
    ) -> Result<(String, String), CdpError> {
        let mut params = json!({ "format": "jpeg", "quality": 70 });
        if full_page {
            let metrics = self.send(webview, "Page.getLayoutMetrics", &json!({}))?;
            let size = metrics
                .get("cssContentSize")
                .or_else(|| metrics.get("contentSize"))
                .cloned()
                .unwrap_or_else(|| json!({ "width": 0, "height": 0 }));
            let width = size
                .get("width")
                .and_then(Value::as_f64)
                .unwrap_or(1.0)
                .max(1.0);
            let height = size
                .get("height")
                .and_then(Value::as_f64)
                .unwrap_or(1.0)
                .max(1.0);
            let scale = (SCREENSHOT_MAX_WIDTH / width)
                .min(SCREENSHOT_MAX_HEIGHT / height)
                .min(1.0);
            params["clip"] =
                json!({ "x": 0, "y": 0, "width": width, "height": height, "scale": scale });
            params["captureBeyondViewport"] = json!(true);
        }
        let result = self.send(webview, "Page.captureScreenshot", &params)?;
        let data = result
            .get("data")
            .and_then(Value::as_str)
            .filter(|data| !data.is_empty())
            .ok_or_else(|| CdpError::new("TOOL_FAILED", "screenshot produced no data"))?;
        Ok(("image/jpeg".to_owned(), data.to_owned()))
    }

    /// Click the element one snapshot id names, through trusted input.
    pub(crate) fn click(&self, webview: &Webview, uid: &str) -> Result<(), CdpError> {
        let backend = self.node_of(uid)?;
        self.attach(webview)?;
        let _ = self.call(
            webview,
            "Emulation.setFocusEmulationEnabled",
            &json!({ "enabled": false }),
        );
        let _ = self.call(
            webview,
            "Emulation.setFocusEmulationEnabled",
            &json!({ "enabled": true }),
        );
        let resolved = self.call(
            webview,
            "DOM.resolveNode",
            &json!({ "backendNodeId": backend }),
        )?;
        let object_id = resolved
            .get("object")
            .and_then(|object| object.get("objectId"))
            .and_then(Value::as_str)
            .ok_or_else(|| CdpError::new("NOT_FOUND", format!("could not resolve {uid}")))?;
        let evaluated = self.call(
            webview,
            "Runtime.callFunctionOn",
            &json!({
                "objectId": object_id,
                "functionDeclaration": "function () {
                    const view = this.ownerDocument.defaultView;
                    let rect = this.getBoundingClientRect();
                    if (rect.left < 0 || rect.top < 0 || rect.right > view.innerWidth || rect.bottom > view.innerHeight) {
                        this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                    }
                    return new Promise(resolve => view.requestAnimationFrame(() => view.requestAnimationFrame(() => {
                        rect = this.getBoundingClientRect();
                        const left = Math.max(0, rect.left), right = Math.min(view.innerWidth, rect.right);
                        const top = Math.max(0, rect.top), bottom = Math.min(view.innerHeight, rect.bottom);
                        resolve(right > left && bottom > top ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null);
                    })));
                }",
                "awaitPromise": true,
                "returnByValue": true,
            }),
        )?;
        let Some(point) = evaluated
            .get("result")
            .and_then(|result| result.get("value"))
            .and_then(|value| value.as_object())
        else {
            return Err(CdpError::new(
                "NOT_FOUND",
                format!("no visible box for {uid}"),
            ));
        };
        let (Some(x), Some(y)) = (
            point.get("x").and_then(Value::as_f64),
            point.get("y").and_then(Value::as_f64),
        ) else {
            return Err(CdpError::new(
                "NOT_FOUND",
                format!("no visible box for {uid}"),
            ));
        };
        self.call(
            webview,
            "Input.dispatchMouseEvent",
            &json!({ "type": "mouseMoved", "x": x, "y": y, "button": "none", "buttons": 0 }),
        )?;
        self.call(
            webview,
            "Input.dispatchMouseEvent",
            &json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1 }),
        )?;
        self.call(
            webview,
            "Input.dispatchMouseEvent",
            &json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1 }),
        )?;
        Ok(())
    }

    /// Replace what a text field holds, by one snapshot id.
    pub(crate) fn fill(&self, webview: &Webview, uid: &str, text: &str) -> Result<(), CdpError> {
        let backend = self.node_of(uid)?;
        self.attach(webview)?;
        let resolved = self.call(
            webview,
            "DOM.resolveNode",
            &json!({ "backendNodeId": backend }),
        )?;
        let object_id = resolved
            .get("object")
            .and_then(|object| object.get("objectId"))
            .and_then(Value::as_str)
            .ok_or_else(|| CdpError::new("NOT_FOUND", format!("could not resolve {uid}")))?;
        self.call(
            webview,
            "Runtime.callFunctionOn",
            &json!({
                "objectId": object_id,
                "functionDeclaration": "function (value) {
                    this.focus({ preventScroll: true });
                    if ('value' in this) {
                        this.value = value;
                        this.dispatchEvent(new Event('input', { bubbles: true }));
                        this.dispatchEvent(new Event('change', { bubbles: true }));
                        return;
                    }
                    this.textContent = value;
                    this.dispatchEvent(new Event('input', { bubbles: true }));
                }",
                "arguments": [{ "value": text }],
            }),
        )?;
        Ok(())
    }

    /// Run one expression in the page and answer its value.
    pub(crate) fn evaluate(&self, webview: &Webview, expression: &str) -> Result<Value, CdpError> {
        self.attach(webview)?;
        let result = self.call(
            webview,
            "Runtime.evaluate",
            &json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
        )?;
        if let Some(details) = result.get("exceptionDetails") {
            let message = details
                .get("exception")
                .and_then(|exception| exception.get("description"))
                .and_then(Value::as_str)
                .or_else(|| details.get("text").and_then(Value::as_str))
                .unwrap_or("evaluation failed");
            return Err(CdpError::new("TOOL_FAILED", message.to_owned()));
        }
        let value = evaluated_value(&result);
        let serialized = serde_json::to_string(&value).unwrap_or_default();
        if serialized.chars().count() > MAX_EVALUATE_CHARS {
            return Ok(json!({
                "truncated": true,
                "value": serialized.chars().take(MAX_EVALUATE_CHARS).collect::<String>(),
            }));
        }
        Ok(value)
    }

    /// The page's console buffer, as its own wrapper recorded it.
    pub(crate) fn console(
        &self,
        webview: &Webview,
        limit: Option<usize>,
    ) -> Result<Vec<ConsoleMessage>, CdpError> {
        let cap = limit
            .unwrap_or(DEFAULT_CONSOLE_LIMIT)
            .clamp(1, MAX_CONSOLE_MESSAGES);
        let expression =
            format!("JSON.stringify((window.__ompBrowserConsole || []).slice(-{cap}))");
        let value = self.evaluate(webview, &expression)?;
        // `evaluate` answers a *string* when it can carry the whole result and an object when it hit
        // `MAX_EVALUATE_CHARS` (`{truncated: true, value}`). Reading that object as text made
        // `as_str` fall back to `"[]"`, so a page that logged a megabyte was reported as a page that
        // logged nothing. A buffer this read cannot carry is a refusal with its own name instead.
        let Some(raw) = value.as_str() else {
            return Err(CdpError::new(
                crate::errors::BROWSER_CONSOLE_TOO_LARGE,
                "This page's console buffer is past what one read can carry.",
            ));
        };
        serde_json::from_str::<Vec<ConsoleMessage>>(raw).map_err(|error| {
            CdpError::new(
                "TOOL_FAILED",
                format!("The console buffer this page kept is not readable: {error}"),
            )
        })
    }

    /// Reload the page without its cache, for the live preview of a local file.
    pub(crate) fn reload_ignoring_cache(&self, webview: &Webview) -> bool {
        self.attach(webview).is_ok()
            && self
                .call(webview, "Page.reload", &json!({ "ignoreCache": true }))
                .is_ok()
    }
}

/// The value of one `Runtime.evaluate` answer, whether it arrived as the method's result object
/// (`{result: RemoteObject}`) or as the `RemoteObject` itself.
pub(crate) fn evaluated_value(result: &Value) -> Value {
    result
        .get("result")
        .and_then(|inner| inner.get("value"))
        .cloned()
        .or_else(|| {
            result
                .get("result")
                .and_then(|inner| inner.get("description"))
                .cloned()
        })
        .or_else(|| result.get("value").cloned())
        .or_else(|| result.get("description").cloned())
        .unwrap_or(Value::Null)
}

fn parse_ax_node(node: &Value) -> Option<AxNode> {
    let node_id = node.get("nodeId").and_then(|id| {
        id.as_str()
            .map(str::to_owned)
            .or_else(|| id.as_i64().map(|id| id.to_string()))
    })?;
    let role = node
        .get("role")
        .and_then(|role| role.get("value"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let name = node
        .get("name")
        .and_then(|name| name.get("value"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let child_ids = node
        .get("childIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|id| {
                    id.as_str()
                        .map(str::to_owned)
                        .or_else(|| id.as_i64().map(|id| id.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(AxNode {
        node_id,
        ignored: node
            .get("ignored")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        role,
        name,
        backend_dom_node_id: node.get("backendDOMNodeId").and_then(Value::as_i64),
        child_ids,
    })
}

/// Most nodes one accessibility snapshot lists, and the most text it may carry.
///
/// Both numbers belong to the *page*: a component library can nest an element a thousand deep by
/// accident, and a page's accessible names are its own text. The tree is therefore never followed
/// without a ceiling - not even with a `catch_unwind` around it, because a Rust stack overflow is an
/// abort rather than a panic, and the process it aborts is this application (`flatten_ax_tree` walks
/// an explicit stack for the same reason).
const MAX_AX_NODES: usize = 4096;
const MAX_AX_TEXT_BYTES: usize = 256 * 1024;

/// How many nodes one walk may look at, listed or not.
///
/// A separate ceiling from [`MAX_AX_NODES`] because most nodes of a real tree are not listed (an
/// ignored node is stepped over), and because a tree that names an ancestor as its own child is not a
/// tree at all: the walk has to end even when it never reaches a line to count. This is the ceiling
/// that makes a cycle finite rather than an out-of-memory.
const MAX_AX_VISITS: usize = 65_536;

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, role: &str, name: &str, backend: Option<i64>, kids: &[&str]) -> AxNode {
        AxNode {
            node_id: id.to_owned(),
            ignored: false,
            role: role.to_owned(),
            name: name.to_owned(),
            backend_dom_node_id: backend,
            child_ids: kids.iter().map(|kid| (*kid).to_owned()).collect(),
        }
    }

    #[test]
    fn a_snapshot_names_what_can_be_acted_on() {
        let nodes = vec![
            node("1", "RootWebArea", "Example", None, &["2", "4"]),
            node("2", "heading", "Hello", Some(11), &[]),
            node("3", "button", "Submit", Some(12), &[]),
            node("4", "textbox", "Email", Some(13), &[]),
        ];
        let snapshot = flatten_ax_tree(&nodes);
        assert!(
            snapshot.tree.contains("RootWebArea \"Example\""),
            "{}",
            snapshot.tree
        );
        assert!(
            snapshot.tree.contains("heading \"Hello\""),
            "{}",
            snapshot.tree
        );
        assert!(
            snapshot.tree.contains("textbox \"Email\""),
            "{}",
            snapshot.tree
        );
        assert!(
            snapshot.tree.contains("button \"Submit\""),
            "{}",
            snapshot.tree
        );
        assert_eq!(snapshot.uids.len(), 3);
    }

    /// Every `eN` id the outline prints, as a set.
    fn printed_uids(snapshot: &Snapshot) -> std::collections::HashSet<&str> {
        snapshot
            .tree
            .split_whitespace()
            .filter(|token| {
                token.len() > 1
                    && token.starts_with('e')
                    && token[1..]
                        .chars()
                        .all(|character| character.is_ascii_digit())
            })
            .collect()
    }

    /// A page's nesting is the page's own number: a chain ten thousand deep must not be followed
    /// into a stack overflow (which aborts the process, uncatchable) or into unbounded output.
    #[test]
    fn a_deep_tree_is_walked_without_recursing() {
        let depth = 20_000usize;
        let nodes: Vec<AxNode> = (0..depth)
            .map(|index| AxNode {
                node_id: index.to_string(),
                ignored: false,
                role: "Generic".to_owned(),
                name: String::new(),
                backend_dom_node_id: Some(index as i64),
                child_ids: if index + 1 < depth {
                    vec![(index + 1).to_string()]
                } else {
                    Vec::new()
                },
            })
            .collect();

        let snapshot = flatten_ax_tree(&nodes);
        assert!(
            snapshot.tree.ends_with("... (truncated)"),
            "the walk stops at a ceiling"
        );
        assert!(
            snapshot.tree.len() <= MAX_AX_TEXT_BYTES + 64,
            "the answer is bounded by the text ceiling, not by the page: {}",
            snapshot.tree.len()
        );
        assert!(snapshot.uids.len() <= MAX_AX_NODES);
        assert!(snapshot
            .uids
            .values()
            .all(|backend| *backend < depth as i64));
        // Every id the table offers is one the outline printed. `remember`/`node_of` resolve ids from
        // that table rather than from the text, so an id the answer never showed is an element `click`
        // and `fill` could act on unseen - and the node the text ceiling cut is exactly the one whose
        // line was not printed.
        let printed = printed_uids(&snapshot);
        assert!(
            snapshot
                .uids
                .keys()
                .all(|uid| printed.contains(uid.as_str())),
            "an id the outline does not print is an element nobody was shown"
        );
    }

    /// A tree that names its own ancestor is not a tree: the walk has to end even when it never
    /// reaches a line to count, which is what the visit ceiling is for.
    #[test]
    fn a_cyclic_tree_ends_at_the_visit_ceiling() {
        let nodes = vec![
            node("1", "RootWebArea", "Example", Some(11), &["2"]),
            node("2", "group", "Panel", None, &["3"]),
            node("3", "group", "Inner", None, &["2"]),
        ];
        let snapshot = flatten_ax_tree(&nodes);
        assert!(
            snapshot.tree.ends_with("... (truncated)"),
            "{}",
            &snapshot.tree[..snapshot.tree.len().min(200)]
        );
        assert_eq!(
            snapshot.uids.len(),
            1,
            "only the root carries a backend node"
        );
    }

    #[test]
    fn an_ignored_node_is_skipped_but_its_children_are_not() {
        let mut hidden = node("2", "none", "", None, &["3"]);
        hidden.ignored = true;
        let nodes = vec![
            node("1", "RootWebArea", "Example", None, &["2"]),
            hidden,
            node("3", "link", "Docs", Some(21), &[]),
        ];
        let snapshot = flatten_ax_tree(&nodes);
        assert!(snapshot.tree.contains("link \"Docs\""), "{}", snapshot.tree);
    }

    #[test]
    fn an_evaluate_answer_is_read_from_either_shape() {
        assert_eq!(
            evaluated_value(&json!({ "result": { "type": "number", "value": 3 } })),
            json!(3)
        );
        assert_eq!(
            evaluated_value(&json!({ "type": "object", "value": { "ok": true } })),
            json!({ "ok": true })
        );
    }

    #[test]
    fn the_public_table_is_the_reference_desktops() {
        assert!(is_allowed("Page.captureScreenshot"));
        assert!(is_allowed("DOM.getOuterHTML"));
        assert!(!is_allowed("Cookie.getCookies"));
        assert!(!is_allowed("Storage.getLocalStorage"));
        assert!(!is_allowed("Target.createTarget"));
        assert!(!is_allowed("Network.enable"));
    }
}

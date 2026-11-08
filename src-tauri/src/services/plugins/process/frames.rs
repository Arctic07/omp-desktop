//! The plugin worker protocol's wire format, on the supervisor's side (`rules.md#plugin-system`).
//!
//! One frame is one NDJSON line, and this file is the only place a line becomes a frame or a frame
//! becomes a line. The vocabulary is the worker's (`host/src/plugin-worker/frames.ts`), and it is
//! deliberately *not* the host's: the worker's stdin/stdout carry `worker_*` frames only, a
//! `hello`/`rpc_chunk` on that pipe is a frame the other half does not speak, and the two protocols
//! are kept apart by argv (`--plugin-worker`) rather than by guessing at a line's shape.
//!
//! Three rules hold across the codec:
//!
//! - **A line is bounded.** [`MAX_FRAME_BYTES`] is the host's own ceiling mirrored
//!   (`host/src/constants.ts`), and a longer line is dropped and counted rather than read into
//!   memory ([`LineFramer`]). The worker refuses the same way, so neither side can make the other
//!   buffer a megabyte it did not agree to.
//! - **An id is a token.** A request id is echoed verbatim by both sides, so a frame whose id is
//!   empty, over [`FRAME_ID_MAX`] or carries a control character is a frame this side cannot settle
//!   - it is reported as [`Inbound::Unusable`] instead of being answered under a made-up key.
//! - **An unknown type is not fatal.** A worker from a newer build may say something this side has
//!   never heard of; it is logged once and ignored, never a reason to stop the process (the same
//!   posture the worker takes towards the supervisor).
//!
//! The log line cleaning is the bridge's (`MAX_LOG_LINE_CHARS`, control characters replaced): a
//! plugin's message is one line in this application's log, and a newline in it would be a line the
//! plugin wrote for a reader who believes otherwise.

use serde_json::{json, Value};

use super::Settlement;

/// Longest frame either side writes, newline included (`host/src/constants.ts` `MAX_FRAME_BYTES`).
///
/// Owner: one worker pipe. Limit: this many bytes of one encoded line. Release: the line leaves the
/// buffer when it is written; a longer one is refused before it is buffered at all.
pub(crate) const MAX_FRAME_BYTES: usize = 1_048_576;

/// Longest request id the worker echoes back (`host/src/constants.ts` `PLUGIN_WORKER_ID_MAX`).
pub(crate) const FRAME_ID_MAX: usize = 128;

/// Longest log line kept (`host/src/constants.ts` `PLUGIN_WORKER_LOG_CHARS_MAX`).
pub(crate) const LOG_CHARS_MAX: usize = 1_024;

/// One line the reader produced: a frame, an oversized line, or a line this protocol cannot read.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Line {
    /// A complete line without its newline, within [`MAX_FRAME_BYTES`].
    Frame(String),
    /// A line past the ceiling, dropped; the value is how many bytes it had.
    Oversized(usize),
}

/// Accumulates bytes into lines without ever holding more than one line's ceiling.
///
/// **Owner / bound / release.** Owned by one worker's reader thread; the buffer holds at most
/// [`MAX_FRAME_BYTES`] bytes plus the current read chunk, and it is emptied on every newline (or on
/// the newline that ends a dropped run). A worker that writes a gigabyte without a newline therefore
/// costs this process one fixed buffer and a count, never that gigabyte.
#[derive(Default)]
pub(crate) struct LineFramer {
    buffer: Vec<u8>,
    /// Bytes of the oversized line being discarded, `None` while a line is being collected.
    discarding: Option<usize>,
}

impl LineFramer {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Consumes one read chunk and appends every line it completed.
    pub(crate) fn push(&mut self, chunk: &[u8], out: &mut Vec<Line>) {
        for byte in chunk {
            if *byte == b'\n' {
                match self.discarding.take() {
                    Some(dropped) => out.push(Line::Oversized(dropped)),
                    None => {
                        let mut line = std::mem::take(&mut self.buffer);
                        // A CRLF writer is a legal line too: the worker writes `\n`, but a build that
                        // ran through a text-mode filter would leave the `\r` behind, and a trailing
                        // one is not part of the JSON.
                        if line.last() == Some(&b'\r') {
                            line.pop();
                        }
                        if line.is_empty() {
                            continue;
                        }
                        out.push(Line::Frame(String::from_utf8_lossy(&line).into_owned()));
                    }
                }
                continue;
            }
            if let Some(dropped) = self.discarding.as_mut() {
                *dropped += 1;
                continue;
            }
            if self.buffer.len() >= MAX_FRAME_BYTES {
                // One byte past the ceiling is enough to know the line is not one this protocol
                // carries: the rest is counted (so the log can say how much was dropped) and
                // forgotten, and the reader re-syncs on the next newline.
                let dropped = self.buffer.len();
                self.buffer = Vec::new();
                self.discarding = Some(dropped + 1);
                continue;
            }
            self.buffer.push(*byte);
        }
    }

    /// The bytes of a line the pipe ended without a newline: a truncated frame, never a frame.
    pub(crate) fn tail_bytes(&self) -> usize {
        match self.discarding {
            Some(dropped) => dropped,
            None => self.buffer.len(),
        }
    }
}

/// One frame the worker sent.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Inbound {
    /// `worker_hello`: the entry resolved and `onLoad` returned. It is the only frame that may
    /// arrive before this side has said anything, and the only place the protocol version is read.
    Hello {
        protocol: u32,
        plugin_id: String,
        install_id: String,
        entry: String,
    },
    /// `worker_result`: the answer to a `worker_load` or a `worker_call`, under that request's id.
    Result { id: String, settlement: Settlement },
    /// `worker_invoke`: the plugin calling a host API. It is answered by this side, always.
    Invoke {
        id: String,
        method: String,
        params: Value,
    },
    /// `worker_log`: one line for this application's log.
    Log { level: String, message: String },
    /// `worker_fatal`: a startup refusal. The process leaves with exit code 5 behind it.
    Fatal { code: String, message: String },
    /// A line that is JSON but names a frame this build does not read, or carries no usable id.
    Unusable { reason: String },
}

/// Why a line is not a frame this protocol reads; the caller logs it once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DecodeFailure {
    /// Not JSON, not an object, or no string `type`.
    NotAFrame,
    /// The shape of a frame this side serves, but not one it can settle or act on.
    Invalid(&'static str),
}

/// One encoded outbound frame, or the reason it cannot go out as one line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EncodeFailure {
    /// The encoded line is past [`MAX_FRAME_BYTES`].
    TooLarge,
}

/// One frame this side sends.
pub(crate) enum Outbound<'a> {
    /// `worker_load`: the activation event this process was woken by.
    Load { id: &'a str, activation: &'a str },
    /// `worker_unload`: run `onUnload`, answer, then leave.
    Unload { id: &'a str },
    /// `worker_call`: one method the plugin's own process serves.
    Call {
        id: &'a str,
        method: &'a str,
        params: &'a Value,
    },
    /// `worker_invoke_result`: this side's answer to a `pi.*` call.
    InvokeResult {
        id: &'a str,
        settlement: &'a Settlement,
    },
}

/// Serializes one frame as one line, or refuses one the ceiling cannot carry.
///
/// Refusing rather than truncating is the whole point: a truncated frame is a different frame, and
/// the far side would settle a request with a value nobody sent.
pub(crate) fn encode(frame: &Outbound<'_>) -> Result<String, EncodeFailure> {
    let value = match frame {
        Outbound::Load { id, activation } => json!({
            "type": "worker_load",
            "id": id,
            "activation": { "event": activation },
        }),
        Outbound::Unload { id } => json!({ "type": "worker_unload", "id": id }),
        Outbound::Call { id, method, params } => json!({
            "type": "worker_call",
            "id": id,
            "method": method,
            "params": params,
        }),
        Outbound::InvokeResult { id, settlement } => {
            let mut frame =
                json!({ "type": "worker_invoke_result", "id": id, "ok": settlement.ok });
            let object = frame
                .as_object_mut()
                .expect("a JSON object was just built from one");
            // The worker's own settlement shape: a value only on success, a code and message only on
            // failure (`host/src/plugin-worker/frames.ts::settlementFrame`).
            if settlement.ok {
                if let Some(value) = settlement.value.as_ref() {
                    object.insert("value".to_owned(), value.clone());
                }
            } else {
                if let Some(code) = settlement.code.as_ref() {
                    object.insert("code".to_owned(), Value::String(code.clone()));
                }
                if let Some(message) = settlement.message.as_ref() {
                    object.insert("message".to_owned(), Value::String(message.clone()));
                }
            }
            frame
        }
    };
    let line = value.to_string();
    if line.len() + 1 > MAX_FRAME_BYTES {
        return Err(EncodeFailure::TooLarge);
    }
    Ok(line)
}

/// Decodes one line into a frame, or says why it is not one.
pub(crate) fn decode(line: &str) -> Result<Inbound, DecodeFailure> {
    let parsed: Value = serde_json::from_str(line).map_err(|_| DecodeFailure::NotAFrame)?;
    let object = parsed.as_object().ok_or(DecodeFailure::NotAFrame)?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or(DecodeFailure::NotAFrame)?;
    match kind {
        "worker_hello" => {
            let protocol = object
                .get("protocol")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or(DecodeFailure::Invalid("protocol"))?;
            Ok(Inbound::Hello {
                protocol,
                plugin_id: text(object.get("pluginId"), 256),
                install_id: text(object.get("installId"), 256),
                entry: text(object.get("entry"), 1_024),
            })
        }
        "worker_result" => {
            let id = frame_id(object.get("id")).ok_or(DecodeFailure::Invalid("id"))?;
            let settlement = settlement_of(object).ok_or(DecodeFailure::Invalid("settlement"))?;
            Ok(Inbound::Result { id, settlement })
        }
        "worker_invoke" => {
            let id = frame_id(object.get("id")).ok_or(DecodeFailure::Invalid("id"))?;
            let method = object
                .get("method")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|method| !method.is_empty() && method.len() <= 128)
                .ok_or(DecodeFailure::Invalid("method"))?;
            Ok(Inbound::Invoke {
                id,
                method: method.to_owned(),
                params: object.get("params").cloned().unwrap_or(Value::Null),
            })
        }
        "worker_log" => {
            let level = object
                .get("level")
                .and_then(Value::as_str)
                .unwrap_or("info");
            let message = object
                .get("message")
                .and_then(Value::as_str)
                .map(clean_log_line)
                .unwrap_or_default();
            Ok(Inbound::Log {
                level: level.to_owned(),
                message,
            })
        }
        "worker_fatal" => Ok(Inbound::Fatal {
            code: text(object.get("code"), 64),
            message: text(object.get("message"), 1_024),
        }),
        other => Ok(Inbound::Unusable {
            reason: format!("unknown_frame:{other}"),
        }),
    }
}

/// One `worker_result` / `worker_invoke_result` payload, in the worker's own shape.
fn settlement_of(object: &serde_json::Map<String, Value>) -> Option<Settlement> {
    let ok = object.get("ok").and_then(Value::as_bool)?;
    Some(if ok {
        Settlement {
            ok: true,
            value: Some(object.get("value").cloned().unwrap_or(Value::Null)),
            code: None,
            message: None,
        }
    } else {
        Settlement::refused(
            object
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("internal"),
            object
                .get("message")
                .and_then(Value::as_str)
                .map(clean_log_line)
                .unwrap_or_else(|| "The plugin refused the call.".to_owned()),
        )
    })
}

/// One string field, cleaned and bounded; a missing or non-string field is empty.
fn text(value: Option<&Value>, max: usize) -> String {
    value
        .and_then(Value::as_str)
        .map(clean_log_line)
        .map(|value| value.chars().take(max).collect())
        .unwrap_or_default()
}

/// One request id this protocol can echo: a bounded token with no control characters.
pub(crate) fn frame_id(value: Option<&Value>) -> Option<String> {
    let id = value.and_then(Value::as_str)?;
    if id.is_empty() || id.len() > FRAME_ID_MAX || id.chars().any(char::is_control) {
        return None;
    }
    Some(id.to_owned())
}

/// A worker's words as one log line: control characters become spaces, and the line is bounded.
pub(crate) fn clean_log_line(message: &str) -> String {
    let cleaned: String = message
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    let points: Vec<char> = trimmed.chars().take(LOG_CHARS_MAX).collect();
    points.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every frame this side writes is one line of the exact shape the worker reads, and every frame
    /// the worker writes is decoded back to the same values.
    #[test]
    fn the_frames_round_trip_between_the_two_halves() {
        let params = json!({ "commandId": "demo.open" });
        let load = encode(&Outbound::Load {
            id: "l1",
            activation: "onCommand:demo.open",
        })
        .expect("a line");
        assert!(!load.contains('\n'), "one frame is one line");
        let parsed: Value = serde_json::from_str(&load).expect("JSON");
        assert_eq!(parsed["type"], "worker_load");
        assert_eq!(parsed["id"], "l1");
        assert_eq!(parsed["activation"]["event"], "onCommand:demo.open");

        let call = encode(&Outbound::Call {
            id: "h7",
            method: "command.execute",
            params: &params,
        })
        .expect("a line");
        let parsed: Value = serde_json::from_str(&call).expect("JSON");
        assert_eq!(parsed["type"], "worker_call");
        assert_eq!(parsed["method"], "command.execute");
        assert_eq!(parsed["params"]["commandId"], "demo.open");

        let unload = encode(&Outbound::Unload { id: "u1" }).expect("a line");
        assert_eq!(
            serde_json::from_str::<Value>(&unload).expect("JSON")["type"],
            "worker_unload"
        );

        let result = decode(r#"{"type":"worker_result","id":"h7","ok":true,"value":{"ran":true}}"#)
            .expect("a frame");
        match result {
            Inbound::Result { id, settlement } => {
                assert_eq!(id, "h7");
                assert!(settlement.ok);
                assert_eq!(settlement.value, Some(json!({ "ran": true })));
            }
            other => panic!("decoded {other:?}"),
        }

        let refusal = decode(
            r#"{"type":"worker_result","id":"h8","ok":false,"code":"not_found","message":"No such command."}"#,
        )
        .expect("a frame");
        match refusal {
            Inbound::Result { settlement, .. } => {
                assert!(!settlement.ok);
                assert_eq!(settlement.code.as_deref(), Some("not_found"));
                assert_eq!(settlement.message.as_deref(), Some("No such command."));
            }
            other => panic!("decoded {other:?}"),
        }

        let invoke = decode(
            r#"{"type":"worker_invoke","id":"i1","method":"fs.read","params":{"path":"a.txt"}}"#,
        )
        .expect("a frame");
        match invoke {
            Inbound::Invoke { id, method, params } => {
                assert_eq!(id, "i1");
                assert_eq!(method, "fs.read");
                assert_eq!(params["path"], "a.txt");
            }
            other => panic!("decoded {other:?}"),
        }

        let hello = decode(
            r#"{"type":"worker_hello","protocol":1,"pluginId":"demo","installId":"demo@m","entry":"main.js"}"#,
        )
        .expect("a frame");
        assert_eq!(
            hello,
            Inbound::Hello {
                protocol: 1,
                plugin_id: "demo".to_owned(),
                install_id: "demo@m".to_owned(),
                entry: "main.js".to_owned(),
            }
        );
    }

    /// A frame whose answer would not fit the ceiling is refused before anything is written; a line
    /// the worker sent past it is dropped and counted, and the next line is read normally.
    #[test]
    fn an_oversized_frame_is_refused_rather_than_cut() {
        let huge = Value::String("x".repeat(MAX_FRAME_BYTES));
        let refused = encode(&Outbound::Call {
            id: "h1",
            method: "command.execute",
            params: &huge,
        });
        assert_eq!(refused, Err(EncodeFailure::TooLarge));

        let mut framer = LineFramer::new();
        let mut out = Vec::new();
        let big = vec![b'x'; MAX_FRAME_BYTES + 10];
        framer.push(&big, &mut out);
        assert!(out.is_empty(), "nothing is emitted before the newline");
        framer.push(
            b"\n{\"type\":\"worker_log\",\"level\":\"info\",\"message\":\"ok\"}\n",
            &mut out,
        );
        assert_eq!(out.len(), 2, "the dropped line is reported once: {out:?}");
        assert!(matches!(out[0], Line::Oversized(bytes) if bytes > MAX_FRAME_BYTES));
        assert!(matches!(&out[1], Line::Frame(line) if line.contains("worker_log")));

        // A chunk that carries several frames hands them back in order.
        let mut several = LineFramer::new();
        let mut frames = Vec::new();
        several.push(b"one\ntwo\nthr", &mut frames);
        several.push(b"ee\n", &mut frames);
        assert_eq!(
            frames,
            vec![
                Line::Frame("one".to_owned()),
                Line::Frame("two".to_owned()),
                Line::Frame("three".to_owned()),
            ]
        );
    }

    /// An unknown frame type and a missing id are facts the caller logs, never a crash and never a
    /// guessed settlement: a worker from a newer build must not be able to stop this side by saying
    /// something it does not know.
    #[test]
    fn an_unknown_type_and_a_bad_id_are_reported_not_guessed() {
        assert_eq!(
            decode(r#"{"type":"worker_future","payload":1}"#),
            Ok(Inbound::Unusable {
                reason: "unknown_frame:worker_future".to_owned(),
            })
        );
        assert_eq!(
            decode(r#"{"type":"worker_result","id":"","ok":true}"#),
            Err(DecodeFailure::Invalid("id"))
        );
        assert_eq!(
            decode(r#"{"type":"worker_result","id":"a\nb","ok":true}"#),
            Err(DecodeFailure::Invalid("id"))
        );
        assert_eq!(decode("not json"), Err(DecodeFailure::NotAFrame));
        assert_eq!(decode("[1,2]"), Err(DecodeFailure::NotAFrame));
        assert_eq!(
            decode(r#"{"id":"x"}"#),
            Err(DecodeFailure::NotAFrame),
            "a frame without a type is not a frame"
        );
    }

    /// A log line is one line: control characters are replaced (a plugin cannot forge a second line
    /// in this application's log) and the text is bounded.
    #[test]
    fn a_log_line_cannot_become_two() {
        assert_eq!(clean_log_line("a\nb\tc"), "a b c");
        assert_eq!(clean_log_line("   "), "");
        let long = clean_log_line(&"x".repeat(LOG_CHARS_MAX + 10));
        assert_eq!(long.chars().count(), LOG_CHARS_MAX);
    }
}

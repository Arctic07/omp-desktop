//! NDJSON framing for the engine host's stdout stream.
//!
//! Protocol v1 writes one JSON object per physical line. A protocol v2 server may split an
//! oversized logical frame into a run of `rpc_chunk` frames carrying base64 segments; the
//! decoder validates that run strictly and only hands back the original object once the run
//! is complete. Line splitting stays with the caller: `push_line` receives exactly one
//! physical line without its newline.

use std::fmt;
use std::io::BufRead;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::Value;

use super::PROTOCOL_VERSION;

/// Physical stdout frame ceiling advertised by the engine (1 MiB).
const DEFAULT_MAX_FRAME_BYTES: usize = 1_048_576;
/// Reassembly ceiling advertised by the engine (64 MiB).
const DEFAULT_MAX_REASSEMBLED_BYTES: usize = 67_108_864;
/// Longest `chunkId` retained for an in-flight sequence; the reference client uses the same cap.
const MAX_CHUNK_ID_BYTES: usize = 128;

/// Outcome of reading one physical line from an engine stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LineRead {
    /// One line, without its trailing newline, now in the caller's buffer.
    Line,
    /// The stream ended; nothing more will arrive.
    Eof,
    /// The line exceeded the ceiling. Its bytes were drained, so the caller must report this as
    /// exactly one rejected frame and keep reading from the start of the next line.
    Overflow,
}

/// Reads one physical line into `buffer`, never holding more than `limit` bytes of its content.
///
/// A buffer-until-newline read cannot be used for this: it grows the buffer until a newline
/// arrives, so an engine that never sends one - or a compromised one streaming gigabytes - would
/// decide how much memory the host allocates for a single line. `fill_buf`/`consume` instead let
/// the read stop appending at the ceiling while still draining the rest of that oversized line.
/// Draining keeps the stream framed: the caller reports one overflow for the whole line instead
/// of one overflow per chunk, and the next line is still read from its own first byte.
///
/// The ceiling counts the line's own bytes: the newline is consumed as framing and never stored,
/// so a line of exactly `limit` bytes is a line and one byte past that is an overflow.
pub(crate) fn read_line(
    reader: &mut impl BufRead,
    buffer: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<LineRead> {
    buffer.clear();
    let mut overflowed = false;
    loop {
        let chunk = match reader.fill_buf() {
            Ok(chunk) => chunk,
            // A signal between the bytes of a line must not be mistaken for the end of the stream.
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if chunk.is_empty() {
            return Ok(if overflowed {
                LineRead::Overflow
            } else if buffer.is_empty() {
                LineRead::Eof
            } else {
                // A final line the engine wrote without a newline is still a line.
                LineRead::Line
            });
        }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let content = newline.unwrap_or(chunk.len());
        let take = newline.map_or(chunk.len(), |index| index + 1);
        let appended = content.min(limit.saturating_sub(buffer.len()));
        buffer.extend_from_slice(&chunk[..appended]);
        if appended < content {
            overflowed = true;
        }
        reader.consume(take);
        if newline.is_some() {
            return Ok(if overflowed {
                LineRead::Overflow
            } else {
                LineRead::Line
            });
        }
    }
}

/// Transport limits of one engine connection.
///
/// `max_frame_bytes` is the physical line ceiling the host must respect when writing commands;
/// `max_reassembled_bytes` caps how much base64 payload may be accumulated for one logical frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct FrameLimits {
    pub protocol_version: u32,
    pub max_frame_bytes: usize,
    pub max_reassembled_bytes: usize,
}

impl Default for FrameLimits {
    fn default() -> Self {
        Self {
            // What this desktop speaks, until a host's `hello` pins the connection. The settings
            // card reports this value for a host that never greeted, so it is the desktop's own
            // protocol rather than a literal that would go stale on the next bump.
            protocol_version: PROTOCOL_VERSION,
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            max_reassembled_bytes: DEFAULT_MAX_REASSEMBLED_BYTES,
        }
    }
}

/// Outcome of feeding one physical line to [`FrameDecoder`].
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Decoded {
    /// A complete logical frame: an unchunked object, or a fully reassembled chunk sequence, with
    /// the number of bytes it occupied on the wire.
    ///
    /// The size is what the inbound queue charges its byte budget with (`host::InboundBudget`): a
    /// count of frames is not a memory ceiling, because one frame may be a reassembled payload of
    /// tens of megabytes (`MAX_REASSEMBLED_LIMIT`).
    Frame(Value, usize),
    /// The line was not a usable frame. The message carries the physical line number and the
    /// reason, never the raw payload, so protocol noise cannot leak prompts into logs.
    Malformed(String),
    /// A blank line, or a chunk that belongs to a sequence that is still incomplete.
    Skipped,
}

/// Metadata of one `rpc_chunk` frame.
///
/// Deserialized from the already parsed line so a wrong shape is reported as a bad chunk rather
/// than forcing a second pass over the raw bytes.
#[derive(Debug, Deserialize)]
struct ChunkFrame {
    #[serde(rename = "chunkId")]
    chunk_id: String,
    index: u64,
    count: u64,
    #[serde(rename = "byteLength")]
    byte_length: u64,
    data: String,
}

/// A partially received chunk sequence. Segments are kept as separate buffers because a chunk of
/// base64 text is not guaranteed to end on a UTF-8 boundary; the join happens once, at the end.
#[derive(Debug)]
struct PendingChunks {
    chunk_id: String,
    count: u64,
    byte_length: u64,
    next_index: u64,
    received: usize,
    segments: Vec<Vec<u8>>,
}

/// Stateful decoder for the engine's stdout stream.
pub(crate) struct FrameDecoder {
    limits: FrameLimits,
    line_number: u64,
    pending: Option<PendingChunks>,
}

impl fmt::Debug for FrameDecoder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FrameDecoder")
            .field("limits", &self.limits)
            .field("line_number", &self.line_number)
            .field(
                "pending",
                &self.pending.as_ref().map(|pending| {
                    (
                        pending.chunk_id.as_str(),
                        pending.next_index,
                        pending.count,
                        pending.received,
                        pending.byte_length,
                    )
                }),
            )
            .finish()
    }
}

impl FrameDecoder {
    pub(crate) fn new(limits: FrameLimits) -> Self {
        Self {
            limits,
            line_number: 0,
            pending: None,
        }
    }

    /// Applies freshly negotiated limits. An in-flight sequence is kept; it is re-checked against
    /// the new ceiling as it keeps arriving.
    pub(crate) fn limits(&self) -> FrameLimits {
        self.limits
    }

    pub(crate) fn set_limits(&mut self, limits: FrameLimits) {
        self.limits = limits;
    }

    /// Feeds one physical line (without the trailing newline) and reports what it completed.
    pub(crate) fn push_line(&mut self, line: &[u8]) -> Decoded {
        self.line_number += 1;
        let line_number = self.line_number;

        if line.iter().all(u8::is_ascii_whitespace) {
            return Decoded::Skipped;
        }

        // Second line of defence: the reader already bounds what it buffers, but a line handed
        // to this decoder from anywhere else must not be parsed either. Comparing lengths (and
        // never the payload) keeps prompt text out of the reported reason.
        let frame_limit = self.limits.max_frame_bytes;
        if line.len() > frame_limit {
            return self.fail(format!(
                "line {line_number}: frame is {} bytes, above the {frame_limit} byte frame limit",
                line.len()
            ));
        }

        let value: Value = match serde_json::from_slice(line) {
            Ok(value) => value,
            Err(error) => {
                return self.fail(format!(
                    "line {line_number}: frame is not valid JSON ({error})"
                ))
            }
        };

        if value.get("type").and_then(Value::as_str) == Some("rpc_chunk") {
            return self.push_chunk(value);
        }

        if !value.is_object() {
            return self.fail(format!("line {line_number}: frame must be a JSON object"));
        }

        if self.pending.is_some() {
            return self.fail(format!(
                "line {line_number}: interrupted chunk sequence: a non-chunk frame arrived before the \
                 sequence completed, so the arriving frame and the partial sequence were dropped"
            ));
        }

        Decoded::Frame(value, line.len())
    }

    /// Validates one `rpc_chunk` frame and appends it to the in-flight sequence.
    fn push_chunk(&mut self, value: Value) -> Decoded {
        let line_number = self.line_number;
        let limit = self.limits.max_reassembled_bytes;

        let chunk: ChunkFrame = match serde_json::from_value(value) {
            Ok(chunk) => chunk,
            Err(_) => {
                return self.fail(format!(
                    "line {line_number}: rpc_chunk frame carries missing or mistyped chunk metadata"
                ))
            }
        };

        if chunk.chunk_id.is_empty() || chunk.chunk_id.len() > MAX_CHUNK_ID_BYTES {
            return self.fail(format!(
                "line {line_number}: rpc_chunk frame has an unusable chunkId"
            ));
        }
        if chunk.count == 0 || chunk.index >= chunk.count {
            return self.fail(format!(
                "line {line_number}: rpc_chunk frame declares index {} of {}",
                chunk.index, chunk.count
            ));
        }
        if chunk.count > chunk.byte_length {
            return self.fail(format!(
                "line {line_number}: rpc_chunk frame declares {} chunks for {} bytes",
                chunk.count, chunk.byte_length
            ));
        }
        if chunk.byte_length == 0 {
            return self.fail(format!(
                "line {line_number}: rpc_chunk frame declares an empty payload"
            ));
        }

        match self.pending.as_ref() {
            None => {
                if chunk.index != 0 {
                    return self.fail(format!(
                        "line {line_number}: chunk sequence must start at index 0"
                    ));
                }
                // The declared length bounds the whole sequence before any payload is retained.
                if chunk.byte_length > limit as u64 {
                    return self.fail(format!(
                        "line {line_number}: rpc_chunk frame declares a byteLength of {} bytes, \
                         above the {limit} byte limit",
                        chunk.byte_length
                    ));
                }
            }
            Some(pending) => {
                if pending.chunk_id != chunk.chunk_id {
                    return self.fail(format!(
                        "line {line_number}: chunkId does not match the in-flight sequence"
                    ));
                }
                if pending.count != chunk.count || pending.byte_length != chunk.byte_length {
                    return self.fail(format!(
                        "line {line_number}: chunk metadata disagrees with the in-flight sequence"
                    ));
                }
                if pending.next_index != chunk.index {
                    return self.fail(format!(
                        "line {line_number}: expected chunk index {} but received {}",
                        pending.next_index, chunk.index
                    ));
                }
            }
        }

        if chunk.data.is_empty() {
            return self.fail(format!("line {line_number}: chunk payload is empty"));
        }
        let bytes = match STANDARD.decode(chunk.data.as_bytes()) {
            Ok(bytes) => bytes,
            Err(_) => {
                return self.fail(format!(
                    "line {line_number}: chunk payload is not valid base64"
                ))
            }
        };

        // Every check above passed, so this chunk continues (or opens) the current sequence.
        let mut pending = match self.pending.take() {
            Some(pending) => pending,
            None => PendingChunks {
                chunk_id: chunk.chunk_id.clone(),
                count: chunk.count,
                byte_length: chunk.byte_length,
                next_index: 0,
                received: 0,
                segments: Vec::new(),
            },
        };

        pending.received += bytes.len();
        // Checks the cumulative ceiling on every chunk, so a negotiation that lowers the limit
        // mid-sequence is caught before more payload is retained.
        if pending.received > limit {
            return self.fail(format!(
                "line {line_number}: reassembled payload exceeds the {limit} byte limit"
            ));
        }
        if pending.received as u64 > pending.byte_length {
            return self.fail(format!(
                "line {line_number}: chunk sequence exceeds its declared length of {} bytes",
                pending.byte_length
            ));
        }
        pending.segments.push(bytes);
        pending.next_index += 1;

        if pending.next_index < pending.count {
            self.pending = Some(pending);
            return Decoded::Skipped;
        }

        if pending.received as u64 != pending.byte_length {
            return self.fail(format!(
                "line {line_number}: chunk sequence declared {} bytes but delivered {}",
                pending.byte_length, pending.received
            ));
        }

        let mut joined = Vec::with_capacity(pending.received);
        for segment in &pending.segments {
            joined.extend_from_slice(segment);
        }
        let text = match std::str::from_utf8(&joined) {
            Ok(text) => text,
            Err(_) => {
                return self.fail(format!(
                    "line {line_number}: reassembled chunk sequence is not valid UTF-8"
                ))
            }
        };
        let frame: Value = match serde_json::from_str(text) {
            Ok(frame) => frame,
            Err(error) => {
                return self.fail(format!(
                    "line {line_number}: reassembled chunk sequence is not valid JSON ({error})"
                ))
            }
        };
        if !frame.is_object() {
            return self.fail(format!(
                "line {line_number}: reassembled chunk sequence must be a JSON object"
            ));
        }

        Decoded::Frame(frame, pending.received)
    }

    /// Reports a protocol violation and drops any in-flight sequence. A sequence is never
    /// resumable after an error, so a corrupt run cannot poison the frames that follow it.
    fn fail(&mut self, message: String) -> Decoded {
        self.pending = None;
        Decoded::Malformed(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push(decoder: &mut FrameDecoder, line: &str) -> Decoded {
        decoder.push_line(line.as_bytes())
    }

    fn malformed(decoded: Decoded) -> String {
        match decoded {
            Decoded::Malformed(message) => message,
            other => panic!("expected a malformed frame, got {other:?}"),
        }
    }

    fn frame(decoded: Decoded) -> Value {
        match decoded {
            Decoded::Frame(value, _) => value,
            other => panic!("expected a frame, got {other:?}"),
        }
    }

    /// A frame and the wire size it carries, which is what the inbound queue budgets with.
    fn sized(decoded: Decoded) -> (Value, usize) {
        match decoded {
            Decoded::Frame(value, bytes) => (value, bytes),
            other => panic!("expected a frame, got {other:?}"),
        }
    }

    fn chunk_line(chunk_id: &str, index: u64, count: u64, byte_length: u64, data: &[u8]) -> String {
        serde_json::json!({
            "type": "rpc_chunk",
            "chunkId": chunk_id,
            "index": index,
            "count": count,
            "byteLength": byte_length,
            "data": base64::Engine::encode(&STANDARD, data),
        })
        .to_string()
    }

    #[test]
    fn decodes_plain_frames_and_skips_blank_lines() {
        let mut decoder = FrameDecoder::new(FrameLimits::default());

        assert_eq!(push(&mut decoder, ""), Decoded::Skipped);
        assert_eq!(push(&mut decoder, "   "), Decoded::Skipped);

        let line = r#"{"type":"agent_start"}"#;
        let (value, bytes) = sized(push(&mut decoder, line));
        assert_eq!(value["type"], "agent_start");
        // The size the queue budgets with is the line as it arrived, newline aside.
        assert_eq!(bytes, line.len());

        assert_eq!(push(&mut decoder, "\t"), Decoded::Skipped);
    }

    #[test]
    fn reports_the_physical_line_number_without_echoing_content() {
        let mut decoder = FrameDecoder::new(FrameLimits::default());

        frame(push(&mut decoder, r#"{"type":"agent_start"}"#));

        let message = malformed(push(&mut decoder, "\"secret prompt text\""));
        assert!(message.starts_with("line 2:"), "{message}");
        assert!(message.contains("JSON object"), "{message}");
        assert!(!message.contains("secret"), "{message}");

        let message = malformed(push(&mut decoder, "{not json"));
        assert!(message.starts_with("line 3:"), "{message}");
        assert!(message.contains("not valid JSON"), "{message}");
    }

    #[test]
    fn reassembles_a_two_chunk_sequence() {
        let mut decoder = FrameDecoder::new(FrameLimits::default());
        let payload = serde_json::json!({
            "type": "message_end",
            "message": { "role": "assistant", "content": "x".repeat(4096) },
        });
        let encoded = payload.to_string();
        let bytes = encoded.as_bytes();
        let middle = bytes.len() / 2;
        let byte_length = bytes.len() as u64;

        assert_eq!(
            push(
                &mut decoder,
                &chunk_line("rpc-1", 0, 2, byte_length, &bytes[..middle])
            ),
            Decoded::Skipped
        );
        let (reassembled, reassembled_bytes) = sized(push(
            &mut decoder,
            &chunk_line("rpc-1", 1, 2, byte_length, &bytes[middle..]),
        ));

        assert_eq!(reassembled, payload);
        // A reassembled frame is budgeted by what it reassembled to, not by the last line that
        // completed it: the lines were each a fraction of the payload.
        assert_eq!(reassembled_bytes, bytes.len());
        // The sequence ended, so the next line is decoded on its own again.
        assert_eq!(
            frame(push(&mut decoder, r#"{"type":"agent_end"}"#))["type"],
            "agent_end"
        );
    }

    #[test]
    fn rejects_a_sequence_that_does_not_start_at_index_zero() {
        let mut decoder = FrameDecoder::new(FrameLimits::default());

        let message = malformed(push(
            &mut decoder,
            &chunk_line("rpc-1", 1, 2, 16, b"abcdefgh"),
        ));
        assert!(message.contains("index 0"), "{message}");
    }

    #[test]
    fn rejects_a_chunk_that_does_not_continue_the_sequence() {
        let mut decoder = FrameDecoder::new(FrameLimits::default());
        assert_eq!(
            push(&mut decoder, &chunk_line("rpc-1", 0, 2, 16, b"abcdefgh")),
            Decoded::Skipped
        );

        let message = malformed(push(
            &mut decoder,
            &chunk_line("rpc-2", 1, 2, 16, b"ijklmnop"),
        ));
        assert!(message.contains("chunkId"), "{message}");

        // The partial sequence is gone, so index 1 can no longer be accepted.
        let message = malformed(push(
            &mut decoder,
            &chunk_line("rpc-1", 1, 2, 16, b"ijklmnop"),
        ));
        assert!(message.contains("index 0"), "{message}");
    }

    #[test]
    fn rejects_a_duplicate_index() {
        let mut decoder = FrameDecoder::new(FrameLimits::default());
        assert_eq!(
            push(&mut decoder, &chunk_line("rpc-1", 0, 3, 24, b"abcdefgh")),
            Decoded::Skipped
        );

        let message = malformed(push(
            &mut decoder,
            &chunk_line("rpc-1", 0, 3, 24, b"abcdefgh"),
        ));
        assert!(message.contains("expected chunk index 1"), "{message}");
    }

    #[test]
    fn a_missing_chunk_is_reported_when_a_new_frame_arrives() {
        let mut decoder = FrameDecoder::new(FrameLimits::default());
        let bytes = br#"{"type":"message_end","message":{"role":"assistant","content":"hi"}}"#;
        let (head, _tail) = bytes.split_at(bytes.len() / 2);
        let byte_length = bytes.len() as u64;

        assert_eq!(
            push(&mut decoder, &chunk_line("rpc-7", 0, 2, byte_length, head)),
            Decoded::Skipped
        );

        // The second chunk never arrives.
        let message = malformed(push(&mut decoder, r#"{"type":"agent_end"}"#));
        assert!(message.contains("interrupted chunk sequence"), "{message}");
        assert!(message.contains("dropped"), "{message}");

        // State was reset, so a fresh sequence for the same chunk id is accepted.
        assert_eq!(
            push(&mut decoder, &chunk_line("rpc-7", 0, 2, byte_length, head)),
            Decoded::Skipped
        );
    }

    #[test]
    fn a_non_chunk_frame_interrupts_a_sequence_without_being_surfaced() {
        let mut decoder = FrameDecoder::new(FrameLimits::default());
        assert_eq!(
            push(&mut decoder, &chunk_line("rpc-1", 0, 2, 16, b"abcdefgh")),
            Decoded::Skipped
        );

        let message = malformed(push(&mut decoder, r#"{"type":"notice"}"#));
        assert!(message.contains("interrupted chunk sequence"), "{message}");

        // The interrupting frame itself was dropped, not delivered as a frame; the following
        // identical line is decoded normally because the sequence state was reset.
        assert_eq!(
            frame(push(&mut decoder, r#"{"type":"notice"}"#))["type"],
            "notice"
        );
    }

    #[test]
    fn enforces_the_reassembly_ceiling() {
        let limits = FrameLimits {
            protocol_version: 2,
            max_frame_bytes: 1024,
            max_reassembled_bytes: 32,
        };
        let mut decoder = FrameDecoder::new(limits);
        assert_eq!(decoder.limits(), limits);

        // A sequence may not even declare more bytes than the ceiling allows.
        let oversized = vec![b'a'; 64];
        let message = malformed(push(
            &mut decoder,
            &chunk_line("rpc-1", 0, 2, 64, &oversized),
        ));
        assert!(message.contains("byteLength"), "{message}");

        // The ceiling also holds when a later negotiation lowers it mid-sequence.
        assert_eq!(
            push(&mut decoder, &chunk_line("rpc-1", 0, 2, 8, b"abcd")),
            Decoded::Skipped
        );
        decoder.set_limits(FrameLimits {
            max_reassembled_bytes: 4,
            ..limits
        });
        let message = malformed(push(&mut decoder, &chunk_line("rpc-1", 1, 2, 8, b"efgh")));
        assert!(message.contains("4 byte limit"), "{message}");
        assert_eq!(decoder.limits().max_reassembled_bytes, 4);

        // And a fresh sequence must respect the tightened ceiling from its first chunk.
        let message = malformed(push(&mut decoder, &chunk_line("rpc-1", 0, 2, 8, b"abcd")));
        assert!(message.contains("byteLength"), "{message}");
    }

    #[test]
    fn rejects_a_sequence_that_overshoots_its_declared_length() {
        let mut decoder = FrameDecoder::new(FrameLimits::default());
        assert_eq!(
            push(&mut decoder, &chunk_line("rpc-1", 0, 2, 8, b"abcdef")),
            Decoded::Skipped
        );

        let message = malformed(push(&mut decoder, &chunk_line("rpc-1", 1, 2, 8, b"ghijkl")));
        assert!(message.contains("exceeds its declared length"), "{message}");
    }

    #[test]
    fn rejects_a_reassembled_payload_that_is_not_utf8() {
        let mut decoder = FrameDecoder::new(FrameLimits::default());

        let message = malformed(push(
            &mut decoder,
            &chunk_line("rpc-1", 0, 1, 2, &[0xff, 0xfe]),
        ));
        assert!(message.contains("UTF-8"), "{message}");
    }

    #[test]
    fn rejects_a_reassembled_payload_that_is_not_an_object() {
        let mut decoder = FrameDecoder::new(FrameLimits::default());

        let message = malformed(push(&mut decoder, &chunk_line("rpc-1", 0, 1, 5, b"[1,2]")));
        assert!(message.contains("must be a JSON object"), "{message}");
    }

    #[test]
    fn rejects_a_chunk_sequence_with_a_length_mismatch() {
        let mut decoder = FrameDecoder::new(FrameLimits::default());
        assert_eq!(
            push(&mut decoder, &chunk_line("rpc-1", 0, 2, 32, b"abcdefgh")),
            Decoded::Skipped
        );

        let message = malformed(push(
            &mut decoder,
            &chunk_line("rpc-1", 1, 2, 32, b"ijklmnop"),
        ));
        assert!(message.contains("declared 32 bytes"), "{message}");
    }

    #[test]
    fn read_line_reports_an_oversized_line_once_after_its_end() {
        let limit = 32;
        let mut data = vec![b'a'; 40];
        data.extend_from_slice(b"\n{\"type\":\"agent_end\"}\n");
        let mut reader: &[u8] = &data;
        let mut buffer = Vec::new();

        // The oversized line is drained and reported once; the short line behind it decodes
        // normally, so the oversized line did not eat the framing of the stream.
        assert_eq!(
            read_line(&mut reader, &mut buffer, limit).unwrap(),
            LineRead::Overflow
        );
        assert_eq!(
            read_line(&mut reader, &mut buffer, limit).unwrap(),
            LineRead::Line
        );
        assert_eq!(buffer, br#"{"type":"agent_end"}"#);
        assert_eq!(
            read_line(&mut reader, &mut buffer, limit).unwrap(),
            LineRead::Eof
        );
    }

    #[test]
    fn read_line_accepts_a_line_exactly_at_the_limit() {
        let mut reader: &[u8] = b"12345678\nnext\n";
        let mut buffer = Vec::new();

        assert_eq!(
            read_line(&mut reader, &mut buffer, 8).unwrap(),
            LineRead::Line
        );
        assert_eq!(buffer, b"12345678");
        assert_eq!(
            read_line(&mut reader, &mut buffer, 8).unwrap(),
            LineRead::Line
        );
        assert_eq!(buffer, b"next");
    }

    #[test]
    fn read_line_reports_the_end_of_the_stream() {
        let mut buffer = Vec::new();

        let mut empty: &[u8] = b"";
        assert_eq!(
            read_line(&mut empty, &mut buffer, 64).unwrap(),
            LineRead::Eof
        );

        // A final line without a newline is handed over as a line, and the read after it is
        // where the end of the stream shows up - the trailing frame is not lost.
        let mut reader: &[u8] = br#"{"type":"agent_end"}"#;
        assert_eq!(
            read_line(&mut reader, &mut buffer, 64).unwrap(),
            LineRead::Line
        );
        assert_eq!(buffer, br#"{"type":"agent_end"}"#);
        assert_eq!(
            read_line(&mut reader, &mut buffer, 64).unwrap(),
            LineRead::Eof
        );

        // An oversized final line is still reported as an overflow rather than as content.
        let mut oversized: &[u8] = b"aaaaaaaaaa";
        assert_eq!(
            read_line(&mut oversized, &mut buffer, 4).unwrap(),
            LineRead::Overflow
        );
    }

    #[test]
    fn rejects_a_physical_line_above_the_frame_limit() {
        let mut decoder = FrameDecoder::new(FrameLimits {
            max_frame_bytes: 64,
            ..FrameLimits::default()
        });

        let message = malformed(push(&mut decoder, &"x".repeat(65)));
        assert!(message.contains("65 bytes"), "{message}");
        assert!(message.contains("64 byte frame limit"), "{message}");

        // Rejecting the line left the decoder usable for the frame behind it.
        assert_eq!(
            frame(push(&mut decoder, r#"{"type":"agent_end"}"#))["type"],
            "agent_end"
        );
    }

    #[test]
    fn rejects_invalid_chunk_metadata_and_payloads() {
        let mut decoder = FrameDecoder::new(FrameLimits::default());

        let message = malformed(push(
            &mut decoder,
            r#"{"type":"rpc_chunk","chunkId":"rpc-1","index":0,"count":2,"byteLength":8}"#,
        ));
        assert!(message.contains("chunk metadata"), "{message}");

        let message = malformed(push(&mut decoder, &chunk_line("", 0, 2, 8, b"abcd")));
        assert!(message.contains("chunkId"), "{message}");

        // The payload itself is not valid base64 once the frame is on the wire.
        let message = malformed(push(
            &mut decoder,
            r#"{"type":"rpc_chunk","chunkId":"rpc-1","index":0,"count":2,"byteLength":8,"data":"!!!!"}"#,
        ));
        assert!(message.contains("base64"), "{message}");

        let message = malformed(push(&mut decoder, &chunk_line("rpc-empty", 0, 1, 4, b"")));
        assert!(message.contains("payload is empty"), "{message}");
    }

    /// Deterministic byte source: a generated failure names a seed, not a rerun.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            let mut value = self.0;
            value ^= value << 13;
            value ^= value >> 7;
            value ^= value << 17;
            self.0 = value;
            value
        }

        fn below(&mut self, bound: usize) -> usize {
            (self.next() % bound as u64) as usize
        }
    }

    /// Reads a stream with one transport capacity, recording every framed line it reports.
    fn read_all(data: &[u8], limit: usize, capacity: usize) -> Vec<(LineRead, Vec<u8>)> {
        let mut reader = std::io::BufReader::with_capacity(capacity.max(1), data);
        let mut buffer = Vec::new();
        let mut seen = Vec::new();
        loop {
            match read_line(&mut reader, &mut buffer, limit).unwrap() {
                LineRead::Eof => break,
                kind => seen.push((kind, buffer.clone())),
            }
        }
        seen
    }

    /// The wire vectors `host/src/protocol/frames.test.ts` decodes with the TypeScript decoder.
    ///
    /// One file, two decoders: a change to either side that disagrees on these bytes fails a test
    /// on the side that moved.
    #[test]
    fn decodes_the_wire_vectors_the_typescript_decoder_also_reads() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../host/src/protocol/frames.vectors.json"
        ))
        .expect("frames.vectors.json is valid JSON");
        let vectors = fixture["vectors"].as_array().expect("vectors array");

        for vector in vectors {
            let name = vector["name"].as_str().expect("vector name");
            let mut decoder = FrameDecoder::new(FrameLimits::default());
            let mut last = Decoded::Skipped;
            for line in vector["lines"].as_array().expect("lines array") {
                last = push(&mut decoder, line.as_str().expect("line text"));
            }

            if let Some(expected) = vector.get("expect") {
                match last {
                    Decoded::Frame(value, _) => assert_eq!(&value, expected, "{name}"),
                    other => panic!("{name}: expected a frame, got {other:?}"),
                }
            } else {
                let needle = vector["error"].as_str().expect("error text");
                let message = malformed(last);
                assert!(message.contains(needle), "{name}: {message}");
            }
        }
    }

    #[test]
    fn arbitrary_lines_never_panic_the_decoder() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for _ in 0..300 {
            let length = rng.below(260);
            let mut line = Vec::with_capacity(length);
            for _ in 0..length {
                line.push((rng.next() & 0xff) as u8);
            }

            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut decoder = FrameDecoder::new(FrameLimits {
                    max_frame_bytes: 64,
                    max_reassembled_bytes: 128,
                    ..FrameLimits::default()
                });
                decoder.push_line(&line)
            }));
            assert!(outcome.is_ok(), "panicked on {line:?}");
        }
    }

    #[test]
    fn reassembles_a_run_split_at_arbitrary_byte_boundaries() {
        let payload = serde_json::json!({
            "type": "message_end",
            "text": "😀".repeat(40),
        });
        let encoded = payload.to_string();
        let bytes = encoded.as_bytes();
        let mut rng = Rng(42);

        for _ in 0..40 {
            let mut cuts: Vec<usize> = (0..1 + rng.below(4))
                .map(|_| 1 + rng.below(bytes.len() - 1))
                .collect();
            cuts.sort_unstable();
            cuts.dedup();
            let mut starts = vec![0];
            starts.extend(cuts.iter().copied());
            starts.push(bytes.len());

            let count = (starts.len() - 1) as u64;
            let mut decoder = FrameDecoder::new(FrameLimits::default());
            let mut last = Decoded::Skipped;
            for (index, pair) in starts.windows(2).enumerate() {
                last = push(
                    &mut decoder,
                    &chunk_line(
                        "split",
                        index as u64,
                        count,
                        bytes.len() as u64,
                        &bytes[pair[0]..pair[1]],
                    ),
                );
            }

            match last {
                Decoded::Frame(value, _) => assert_eq!(value, payload, "cuts {starts:?}"),
                other => panic!("cuts {starts:?}: expected a frame, got {other:?}"),
            }
        }
    }

    #[test]
    fn read_line_is_independent_of_the_transport_chunk_size() {
        let sample = b"one\n\nthree\r\nfour\nlast without newline";

        // Under the ceiling, a line is the same bytes no matter how the reader's buffer cut them.
        let baseline = read_all(sample, 64, sample.len());
        for capacity in [1, 2, 3, 5, 7, 16] {
            assert_eq!(
                read_all(sample, 64, capacity),
                baseline,
                "capacity {capacity}"
            );
        }

        // With a limit that truncates, the overflow/line sequence is also transport-independent.
        let baseline = read_all(sample, 5, sample.len());
        for capacity in [1, 2, 3, 5, 7] {
            assert_eq!(
                read_all(sample, 5, capacity),
                baseline,
                "capacity {capacity}"
            );
        }
    }

    #[test]
    fn rejects_a_chunk_run_whose_bytes_are_not_utf8() {
        let mut decoder = FrameDecoder::new(FrameLimits::default());
        let message = malformed(push(
            &mut decoder,
            &chunk_line("rpc-utf8", 0, 1, 2, &[0xff, 0xfe]),
        ));
        assert!(message.contains("UTF-8"), "{message}");
    }
}

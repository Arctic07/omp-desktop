/**
 * NDJSON framing: encoding with `rpc_chunk` splitting, a bounded line scanner for stdin, and
 * reassembly of inbound chunk runs.
 *
 * Wire-compatible with `src-tauri/src/services/runtime/protocol.rs` (§2.1): encoding emits
 * `chunkId`/`index`/`count`/`byteLength`/`data`, and every validation the decoder performs on
 * that run is enforced here for outbound frames of the same shape.
 */

import { Buffer } from 'node:buffer'

import {
  CHUNK_PAYLOAD_BYTES,
  MAX_CHUNK_ID_BYTES,
  MAX_FRAME_BYTES,
  MAX_REASSEMBLED_BYTES,
} from '../constants.ts'
import { HostError, invalidInput } from './errors.ts'

/** Longest chunk run the encoder will ever produce for one logical frame. */
const MAX_CHUNKS = BigInt(MAX_REASSEMBLED_BYTES) / BigInt(CHUNK_PAYLOAD_BYTES)

/**
 * Canonical base64, the alphabet `base64::engine::STANDARD` decodes on the Rust side.
 *
 * `Buffer.from(text, 'base64')` is deliberately lenient - it drops characters outside the alphabet
 * and accepts missing padding - so it would accept a chunk the Rust decoder rejects, then reassemble
 * a shorter payload and report a different reason. The shape is checked before decoding instead.
 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

let chunkSequence = 0

/** Splits a serialized frame into UTF-8-safe pieces no larger than the chunk payload budget. */
function splitByBytes(text: string, limit: number): Buffer[] {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= limit) return [bytes]
  const pieces: Buffer[] = []
  let offset = 0
  while (offset < bytes.length) {
    let end = Math.min(offset + limit, bytes.length)
    // A piece may not end inside a UTF-8 sequence. A continuation byte is `10xxxxxx`, so backing
    // off over them lands on the lead byte of the character straddling the boundary - at most three
    // bytes back, and never past `offset` because a character is at most four bytes.
    while (end < bytes.length && (bytes[end] as number) >= 0x80 && (bytes[end] as number) < 0xc0) {
      end -= 1
    }
    pieces.push(bytes.subarray(offset, end))
    offset = end
  }
  return pieces
}

/**
 * Serializes one logical frame into the physical lines to write.
 *
 * A frame that fits in one physical line is written verbatim; a larger one becomes a chunk run
 * so no reader ever has to hold an oversized line.
 */
export function encodeFrame(frame: unknown): string[] {
  return encodeLine(JSON.stringify(frame))
}

/**
 * One already-serialized frame into the physical lines to write.
 *
 * Split out of [`encodeFrame`] because a session frame is serialized once, where it is prepared
 * (`events.ts`'s `#prepare`), and the line is what travels from there to the sink: the number such a
 * frame goes out under is assigned when it is written, so the stamped frame does not exist at
 * serialization time, and re-serializing it here would copy a payload that runs to hundreds of
 * kilobytes on the stream that runs for minutes. The physical-line ceiling and the chunk run are
 * enforced here, on the same bytes as before - whether they were serialized one step earlier or just
 * now.
 */
export function encodeLine(line: string): string[] {
  const bytes = Buffer.byteLength(line, 'utf8')
  if (bytes <= MAX_FRAME_BYTES) return [line]
  if (bytes > MAX_REASSEMBLED_BYTES) {
    throw new HostError('invalid_input', `Refusing to send a ${bytes} byte frame: above the reassembly ceiling.`)
  }

  const pieces = splitByBytes(line, CHUNK_PAYLOAD_BYTES)
  if (pieces.length === 0 || pieces.length > Number(MAX_CHUNKS)) {
    throw new HostError('invalid_input', `Refusing to send a frame in ${pieces.length} chunks.`)
  }
  chunkSequence += 1
  const chunkId = `h${chunkSequence}`
  return pieces.map((piece, index) =>
    JSON.stringify({
      type: 'rpc_chunk',
      chunkId,
      index,
      count: pieces.length,
      byteLength: bytes,
      data: piece.toString('base64'),
    }),
  )
}

/**
 * One session frame's line: the identity it goes out under, ahead of its serialized body.
 *
 * The body is serialized once, where the frame is prepared (`events.ts`'s `#prepare`), and the two
 * fields are written in front of it here instead of serializing the stamped frame a second time.
 * They cannot be part of the body: a frame's sequence number is assigned when it is written, not when
 * it is queued, because a frame the outbound budget takes must leave no hole behind - so the stamped
 * frame does not exist yet when the body is measured against that budget.
 *
 * `body` is `JSON.stringify` of a frame object that carries at least one member - every frame this
 * process emits is named by its `type`, which is what the far side's routing table addresses it by -
 * and that is a plain object rather than one with a `toJSON`. It therefore opens with `{` and is
 * longer than that, and the result is the same JSON
 * `JSON.stringify({ ...frame, sessionId, seq })` would have produced.
 */
export function stampFrameLine(body: string, sessionId: string, seq: number): string {
  return `{"sessionId":${JSON.stringify(sessionId)},"seq":${seq},${body.slice(1)}`
}

/** Bytes of an oversized line kept as a probe for best-effort request-id recovery. */
const OVERFLOW_PROBE_BYTES = 4 * 1024

/**
 * The head and tail of an oversized line, as an opaque bounded probe.
 *
 * `previousTail` carries what a partial read already contributed, so the tail stays the tail of
 * the whole line no matter how the transport chunked it.
 */
function probeOf(buffer: Buffer, previousTail = ''): { head: string; tail: string } {
  const head = buffer.subarray(0, Math.min(buffer.length, OVERFLOW_PROBE_BYTES)).toString('utf8')
  const appended = previousTail + buffer.subarray(Math.max(0, buffer.length - OVERFLOW_PROBE_BYTES)).toString('utf8')
  return { head, tail: appended.length > OVERFLOW_PROBE_BYTES ? appended.slice(appended.length - OVERFLOW_PROBE_BYTES) : appended }
}

/** The request id an oversized line named, when the probe can still see one. */
const PROBE_ID = /"id"\s*:\s*"([^"\\]{1,128})"/g

/**
 * Recovers the request id of a line too large to parse.
 *
 * Best effort by construction: the line is refused either way, and a response is only worth
 * sending when it can be addressed. The probe holds the line's head and tail, so both the
 * transport's own shape (id written last) and a hand-written frame (id written first) are covered.
 * An id that cannot be recovered costs the caller a timeout, never a wrong answer: the value is a
 * raw field of an unparsed line and is treated as opaque.
 */
export function oversizedLineRequestId(probe: string): string | null {
  let found: string | null = null
  for (const match of probe.matchAll(PROBE_ID)) found = match[1] as string
  return found
}

/** One physical line, an oversized-line overflow, or the end of the stream. */
export type ScanEvent =
  | { readonly kind: 'line'; readonly text: string }
  | { readonly kind: 'overflow'; readonly bytes: number; readonly text: string }

/**
 * Bounded NDJSON scanner.
 *
 * Lines are handed back one at a time. A line longer than the physical ceiling is reported once as
 * an overflow and then drained, so the stream stays framed and the next line still starts at its
 * own first byte. The ceiling is enforced on the line's total length, not on how the reads that
 * carried it were sized: whether a 1 MiB+ line arrives in one chunk or arrives split is a
 * transport accident and never decides whether the frame is refused.
 */
export class LineScanner {
  #pending: Buffer = Buffer.alloc(0)
  #overflowing = false
  #overflowBytes = 0
  #overflowHead = ''
  #overflowTail = ''

  /** Feeds one stream chunk and returns every event it completed. */
  push(chunk: Uint8Array): ScanEvent[] {
    const events: ScanEvent[] = []
    let buffer = this.#pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#pending, chunk])
    for (;;) {
      const newline = buffer.indexOf(0x0a)
      if (newline === -1) break
      const line = buffer.subarray(0, newline)
      buffer = buffer.subarray(newline + 1)
      if (this.#overflowing) {
        const tail = probeOf(line, this.#overflowTail).tail
        this.#overflowTail = tail
        events.push({ kind: 'overflow', bytes: this.#overflowBytes + line.length, text: this.#overflowHead + tail })
        this.#clear()
        continue
      }
      if (line.length > MAX_FRAME_BYTES) {
        const probe = probeOf(line)
        this.#overflowHead = probe.head
        this.#overflowTail = probe.tail
        events.push({ kind: 'overflow', bytes: line.length, text: probe.head + probe.tail })
        this.#clear()
        continue
      }
      events.push({ kind: 'line', text: line.toString('utf8').replace(/\r$/, '') })
    }

    if (this.#overflowing) {
      this.#overflowTail = probeOf(buffer, this.#overflowTail).tail
      this.#overflowBytes += buffer.length
      buffer = Buffer.alloc(0)
    } else if (buffer.length > MAX_FRAME_BYTES) {
      // The ceiling counts the line's own bytes, so the excess is drained and counted.
      const probe = probeOf(buffer)
      this.#overflowing = true
      this.#overflowBytes = buffer.length
      this.#overflowHead = probe.head
      this.#overflowTail = probe.tail
      buffer = Buffer.alloc(0)
    }
    this.#pending = buffer
    return events
  }

  #clear(): void {
    this.#overflowing = false
    this.#overflowBytes = 0
    this.#overflowHead = ''
    this.#overflowTail = ''
  }

  /** True when a line reached the ceiling and its remainder is still being drained. */
  get overflowing(): boolean {
    return this.#overflowing
  }
}

interface PendingChunks {
  chunkId: string
  count: number
  byteLength: number
  nextIndex: number
  segments: Buffer[]
  received: number
}

/**
 * Reassembles an inbound `rpc_chunk` run.
 *
 * Returns `null` while the run is incomplete, the decoded frame once it completes, and throws a
 * coded error for a malformed run - mirroring the Rust decoder so both ends reject the same
 * sequences.
 */
export class ChunkReassembler {
  #pending: PendingChunks | null = null

  accept(frame: Record<string, unknown>): Record<string, unknown> | null {
    const chunkId = frame.chunkId
    const index = frame.index
    const count = frame.count
    const byteLength = frame.byteLength
    const data = frame.data
    if (
      typeof chunkId !== 'string' ||
      typeof index !== 'number' ||
      typeof count !== 'number' ||
      typeof byteLength !== 'number' ||
      typeof data !== 'string' ||
      !Number.isInteger(index) ||
      !Number.isInteger(count) ||
      !Number.isInteger(byteLength)
    ) {
      return this.#fail('rpc_chunk frame carries missing or mistyped chunk metadata')
    }
    if (chunkId === '' || Buffer.byteLength(chunkId, 'utf8') > MAX_CHUNK_ID_BYTES) {
      return this.#fail('rpc_chunk frame has an unusable chunkId')
    }
    if (count === 0 || index >= count) {
      return this.#fail(`rpc_chunk frame declares index ${index} of ${count}`)
    }
    if (count > byteLength) {
      return this.#fail(`rpc_chunk frame declares ${count} chunks for ${byteLength} bytes`)
    }
    if (byteLength === 0) {
      return this.#fail('rpc_chunk frame declares an empty payload')
    }

    if (this.#pending === null) {
      if (index !== 0) return this.#fail('chunk sequence must start at index 0')
      if (byteLength > MAX_REASSEMBLED_BYTES) {
        return this.#fail(`rpc_chunk frame declares a byteLength of ${byteLength} bytes, above the ceiling`)
      }
      this.#pending = { chunkId, count, byteLength, nextIndex: 0, segments: [], received: 0 }
    } else {
      const pending = this.#pending
      if (pending.chunkId !== chunkId) return this.#fail('chunkId does not match the in-flight sequence')
      if (pending.count !== count || pending.byteLength !== byteLength) {
        return this.#fail('chunk metadata does not match the in-flight sequence')
      }
      if (pending.nextIndex !== index) {
        return this.#fail(`expected chunk index ${pending.nextIndex} but received ${index}`)
      }
    }

    const pending = this.#pending as PendingChunks
    // Mirrors the Rust decoder's order: an empty payload is refused before decoding, and a
    // non-canonical one is refused rather than silently decoded to fewer bytes.
    if (data === '') return this.#fail('rpc_chunk frame payload is empty')
    if (!BASE64.test(data) || data.length % 4 !== 0) {
      return this.#fail('rpc_chunk frame payload is not valid base64')
    }
    const segment = Buffer.from(data, 'base64')
    // The declared length is checked before the segment is retained, exactly as the Rust decoder
    // does (`protocol.rs`, the cumulative `received > byte_length` guard): a run whose metadata
    // understates its payload is refused on the chunk that crossed the promise, instead of staying
    // in memory until the sequence ends - which a lying `count` may never do.
    if (pending.received + segment.length > pending.byteLength) {
      return this.#fail(`chunk sequence exceeds its declared length of ${pending.byteLength} bytes`)
    }
    pending.segments.push(segment)
    pending.received += segment.length
    pending.nextIndex += 1
    if (pending.nextIndex < pending.count) return null

    this.#pending = null
    if (pending.received !== pending.byteLength) {
      return this.#fail(`reassembled ${pending.received} bytes but the sequence declared ${pending.byteLength}`)
    }
    const payload = Buffer.concat(pending.segments, pending.received)
    // The Rust decoder parses the joined bytes as UTF-8 with `str::from_utf8`; `toString('utf8')`
    // replaces an invalid sequence with U+FFFD and would let a payload neither side can parse reach
    // `JSON.parse` inside a string literal. The fatal decoder refuses the same bytes.
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(payload)
    } catch {
      return this.#fail('reassembled chunk payload is not valid UTF-8')
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(text)
    } catch {
      return this.#fail('reassembled chunk payload is not a JSON object')
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      return this.#fail('reassembled chunk payload is not a JSON object')
    }
    return decoded as Record<string, unknown>
  }

  #fail(message: string): never {
    this.#pending = null
    throw invalidInput(message)
  }
}

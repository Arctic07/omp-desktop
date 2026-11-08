import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { CHUNK_PAYLOAD_BYTES, MAX_FRAME_BYTES } from '../constants.ts'
import { HostError } from './errors.ts'
import { ChunkReassembler, LineScanner, encodeFrame, type ScanEvent } from './frames.ts'

/**
 * Framing properties and the wire vectors shared with `src-tauri/src/services/runtime/protocol.rs`.
 *
 * The examples a codec needs are boundary ones: the byte at the physical ceiling, a chunk cut inside
 * a multi-byte character, and the same line arriving in a different transport split. The generated
 * cases below cover those, and `frames.vectors.json` pins the two decoders to one another: the Rust
 * test includes the same file, so a change to either side that disagrees on these bytes fails one.
 */

/** One physical stream split, decoded end to end. */
function decodeStream(parts: Uint8Array[]): { frames: unknown[]; overflows: ScanEvent[] } {
  const scanner = new LineScanner()
  const chunks = new ChunkReassembler()
  const frames: unknown[] = []
  const overflows: ScanEvent[] = []
  for (const part of parts) {
    for (const event of scanner.push(part)) {
      if (event.kind === 'overflow') {
        overflows.push(event)
        continue
      }
      const frame = JSON.parse(event.text) as Record<string, unknown>
      if (frame.type !== 'rpc_chunk') {
        frames.push(frame)
        continue
      }
      const reassembled = chunks.accept(frame)
      if (reassembled !== null) frames.push(reassembled)
    }
  }
  return { frames, overflows }
}

function scan(parts: Uint8Array[]): ScanEvent[] {
  const scanner = new LineScanner()
  return parts.flatMap(part => scanner.push(part))
}

/** Deterministic PRNG, so a failing case is a fixed seed rather than a flaky rerun. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** Characters that stress JSON escaping, the line scanner, and UTF-8 segmentation. */
const ALPHABET = ['a', 'Z', '0', ' ', '"', '\\', '\n', '\r', '\t', '中', 'é', '😀', '🧪', '\u0001']

function randomText(rng: () => number, max: number): string {
  const length = Math.floor(rng() * (max + 1))
  let text = ''
  for (let index = 0; index < length; index += 1) {
    text += ALPHABET[Math.floor(rng() * ALPHABET.length)] as string
  }
  return text
}

function randomSplits(wire: Buffer, rng: () => number): Buffer[] {
  const cuts = Array.from({ length: 1 + Math.floor(rng() * 5) }, () => Math.floor(rng() * (wire.length + 1)))
  const bounds = [0, ...cuts.sort((left, right) => left - right), wire.length]
  const parts: Buffer[] = []
  for (let index = 1; index < bounds.length; index += 1) {
    const from = bounds[index - 1] as number
    const to = bounds[index] as number
    if (to > from) parts.push(wire.subarray(from, to))
  }
  return parts
}

/** A frame whose JSON line is exactly `bytes` long, so the ceilings can be hit exactly. */
const PLAIN_OVERHEAD = Buffer.byteLength(JSON.stringify({ type: 'x', data: '' }))
function frameWithLineBytes(bytes: number): { type: string; data: string } {
  return { type: 'x', data: 'a'.repeat(bytes - PLAIN_OVERHEAD) }
}

test('round-trips frames around the physical ceiling and the chunk boundary', () => {
  const sizes = [
    PLAIN_OVERHEAD,
    PLAIN_OVERHEAD + 1,
    MAX_FRAME_BYTES - 1,
    MAX_FRAME_BYTES,
    MAX_FRAME_BYTES + 1,
    MAX_FRAME_BYTES + CHUNK_PAYLOAD_BYTES - 1,
    MAX_FRAME_BYTES + CHUNK_PAYLOAD_BYTES,
  ]
  for (const size of sizes) {
    const frame = frameWithLineBytes(size)
    const wire = Buffer.concat(encodeFrame(frame).map(line => Buffer.from(line + '\n')))
    const { frames, overflows } = decodeStream([wire])
    assert.deepEqual(overflows, [], `${size} byte line overflowed`)
    assert.deepEqual(frames, [frame], `${size} byte line did not round-trip`)
  }
})

test('generated frames survive arbitrary transport splits', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const rng = makeRng(seed)
    const frame = { type: 'generated', text: randomText(rng, 1_200) }
    const wire = Buffer.concat(encodeFrame(frame).map(line => Buffer.from(line + '\n')))
    const { frames, overflows } = decodeStream(randomSplits(wire, rng))
    assert.deepEqual(overflows, [], `seed ${seed} overflowed`)
    assert.deepEqual(frames, [frame], `seed ${seed} did not round-trip`)
  }
})

test('the scanner reports the same events however the transport split the bytes', () => {
  const wire = Buffer.from('{"a":"😀"}\r\n\r\n{"b":2}\nlast\n')
  const baseline = scan([wire])
  assert.deepEqual(
    baseline.map(event => event.kind),
    ['line', 'line', 'line', 'line'],
  )
  for (let cut = 0; cut <= wire.length; cut += 1) {
    assert.deepEqual(scan([wire.subarray(0, cut), wire.subarray(cut)]), baseline, `split at ${cut}`)
  }
})

test('a chunked frame is byte-reassembled, not text-reassembled', () => {
  const frame = { type: 'large', text: ('a'.repeat(4_096) + '😀').repeat(300) }
  const lines = encodeFrame(frame)
  assert.ok(lines.length > 1, 'the payload must exceed the physical ceiling')

  const encoded = Buffer.byteLength(JSON.stringify(frame))
  const chunks = lines.map(line => JSON.parse(line) as Record<string, unknown>)
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.index, index)
    assert.equal(chunk.count, chunks.length)
    assert.equal(chunk.byteLength, encoded)
    assert.equal(chunk.chunkId, chunks[0]?.chunkId)
    assert.ok(Buffer.byteLength(lines[index] as string) <= MAX_FRAME_BYTES)
  }

  const { frames, overflows } = decodeStream([Buffer.from(lines.join('\n') + '\n')])
  assert.deepEqual(overflows, [])
  assert.deepEqual(frames, [frame])
})

test('rejects every chunk shape the Rust decoder rejects, with the same reason', () => {
  const chunk = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'rpc_chunk',
    chunkId: 'v',
    index: 0,
    count: 1,
    byteLength: 3,
    data: Buffer.from('abc').toString('base64'),
    ...overrides,
  })
  const cases: Array<{ name: string; frames: Record<string, unknown>[]; reason: RegExp }> = [
    { name: 'a run that does not start at index 0', frames: [chunk({ index: 1, count: 2 })], reason: /index 0/ },
    {
      name: 'a chunkId change mid-run',
      frames: [
        chunk({ count: 2, byteLength: 6 }),
        chunk({ chunkId: 'other', index: 1, count: 2, byteLength: 6, data: Buffer.from('def').toString('base64') }),
      ],
      reason: /chunkId/,
    },
    {
      name: 'metadata that disagrees with the run',
      frames: [chunk({ count: 2, byteLength: 6 }), chunk({ index: 1, count: 3, byteLength: 6 })],
      reason: /metadata/,
    },
    { name: 'an empty payload', frames: [chunk({ data: '' })], reason: /payload is empty/ },
    { name: 'a payload outside the base64 alphabet', frames: [chunk({ data: '!!!!' })], reason: /base64/ },
    {
      name: 'payload bytes that are not UTF-8',
      frames: [chunk({ byteLength: 2, data: Buffer.from([0xff, 0xfe]).toString('base64') })],
      reason: /UTF-8/,
    },
    {
      name: 'a reassembled payload that is not a JSON object',
      frames: [chunk({ byteLength: 2, data: Buffer.from('[]').toString('base64') })],
      reason: /JSON object/,
    },
    {
      name: 'a run that delivers fewer bytes than declared',
      frames: [chunk({ byteLength: 4 })],
      reason: /declared/,
    },
    { name: 'a zero chunk count', frames: [chunk({ count: 0 })], reason: /index/ },
  ]

  for (const { name, frames, reason } of cases) {
    assert.throws(
      () => decodeStream([Buffer.from(frames.map(frame => JSON.stringify(frame) + '\n').join(''))]),
      (error: unknown) =>
        error instanceof HostError && error.code === 'invalid_input' && reason.test(error.message),
      name,
    )
  }
})

test('decodes the wire vectors the Rust decoder also includes', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./frames.vectors.json', import.meta.url), 'utf8'),
  ) as { vectors: Array<{ name: string; lines: string[]; expect?: unknown; error?: string }> }

  for (const vector of fixture.vectors) {
    const wire = Buffer.from(vector.lines.map(line => line + '\n').join(''))
    if (vector.expect !== undefined) {
      assert.deepEqual(decodeStream([wire]).frames, [vector.expect], vector.name)
      continue
    }
    assert.throws(
      () => decodeStream([wire]),
      (error: unknown) =>
        error instanceof HostError && error.code === 'invalid_input' && error.message.includes(vector.error as string),
      vector.name,
    )
  }
})

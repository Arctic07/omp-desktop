import assert from 'node:assert/strict'
import { test } from 'node:test'

import { zstdFrameBounds } from './provenance.ts'

/**
 * What the frame walk owes its caller: the size the frame really expands to, and an extent that
 * `Bun.zstdDecompressSync` accepts as one whole frame.
 *
 * The size is what `verifyHostProvenance` matches an embedded frame to a published addon by, so a
 * frame whose declared size is off by its header's bias would silently match nothing.
 */

/** One compressed frame and the payload it must expand to. */
function frameOf(size: number): { frame: Buffer; payload: Uint8Array } {
  const payload = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) payload[index] = index % 251
  return { frame: Bun.zstdCompressSync(payload), payload }
}

for (const size of [100, 1000, 65_000, 300_000]) {
  test(`a ${size}-byte frame reports its payload size and expands whole`, () => {
    const { frame, payload } = frameOf(size)
    const bounds = zstdFrameBounds(frame, 0)
    assert.notEqual(bounds, null)
    assert.equal(bounds?.contentSize, size, 'the declared size is the decompressed size')
    assert.equal(bounds?.end, frame.length, 'the frame ends where the last block ends')
    assert.equal(Bun.zstdDecompressSync(frame.subarray(0, bounds?.end)).length, payload.length)
  })
}

test('the two-byte size field is stored 256 below the payload size', () => {
  // Pins the encoding itself, not just our arithmetic: RFC 8878 §3.1.1.1.4 stores `size - 256` in
  // the two-byte form, and Bun writes that header for payloads this size.
  const { frame } = frameOf(1000)
  assert.equal(frame[4] >> 6, 1, 'the header uses the two-byte form')
  assert.equal(frame.readUInt16LE(5), 744)
  assert.equal(zstdFrameBounds(frame, 0)?.contentSize, 1000)
})

test('a frame header that runs past the buffer is not a frame', () => {
  const { frame } = frameOf(1000)
  assert.equal(zstdFrameBounds(frame.subarray(0, 6), 0), null)
  assert.equal(zstdFrameBounds(Buffer.alloc(0), 0), null)
})

test('a magic that is not a frame is rejected instead of guessed at', () => {
  const { frame } = frameOf(1000)
  const embedded = Buffer.concat([Buffer.from('text'), frame.subarray(0, 8)])
  assert.equal(zstdFrameBounds(embedded, 4), null, 'the block header claims more than the buffer holds')
})

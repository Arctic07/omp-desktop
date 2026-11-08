import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatImage } from '../api/session-types.ts'
import { imageBox } from './image-box.ts'

/**
 * The size a picture's own header carries.
 *
 * This is what lets a row reserve the box a picture will take before its bytes are decoded — an
 * `<img>` with no size is zero high until it loads, so without it every picture that scrolls into
 * the window grows its row by up to the viewer's ceiling (2026-11-05).
 */

function dataUrl(mime: string, bytes: number[]): string {
  return `data:${mime};base64,${Buffer.from(Uint8Array.from(bytes)).toString('base64')}`
}

function image(url: string): ChatImage {
  return { mimeType: url.slice(5, url.indexOf(';')), bytes: url.length, dataUrl: url }
}

function png(width: number, height: number): number[] {
  return [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // the IHDR chunk
    (width >> 24) & 0xff, (width >> 16) & 0xff, (width >> 8) & 0xff, width & 0xff,
    (height >> 24) & 0xff, (height >> 16) & 0xff, (height >> 8) & 0xff, height & 0xff,
  ]
}

test('a PNG answers the size in its own header', () => {
  assert.deepEqual(imageBox(image(dataUrl('image/png', png(1600, 900)))), {
    width: 1600,
    height: 900,
  })
})

test('a GIF answers the little-endian pair', () => {
  const url = dataUrl('image/gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02])
  assert.deepEqual(imageBox(image(url)), { width: 800, height: 600 })
})

test('a JPEG is walked to its frame header, past the segments before it', () => {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Array.from({ length: 14 }, () => 0x00)]
  const frame = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xc2, 0x02, 0x80]
  const url = dataUrl('image/jpeg', [0xff, 0xd8, ...app0, ...frame])
  assert.deepEqual(imageBox(image(url)), { width: 640, height: 450 })
})

test('a JPEG whose frame header sits past the small window is still read', () => {
  // Chrome's own screenshots carry their `SOF` at byte 632 (an ICC profile ahead of it), and 55 of
  // the 56 screenshots of the picture-heavy conversation were past the 512-byte window the first
  // read used — every one of them fell back to a guessed aspect, which put 105 px where a narrow
  // 181 × 2560 capture draws 416 (2026-11-05).
  const filler = Array.from({ length: 990 }, (_, index) => index & 0xff)
  const app2 = [0xff, 0xe2, 0x03, 0xe0, ...filler]
  const frame = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x0a, 0x00, 0x00, 0xb5]
  const url = dataUrl('image/jpeg', [0xff, 0xd8, ...app2, ...frame])
  assert.ok(app2.length + 2 > 512, 'the fixture must put the frame header past the small window')
  assert.deepEqual(imageBox(image(url)), { width: 181, height: 2560 })
})

test('a WebP answers its canvas size', () => {
  // `VP8X`: the canvas is the two 24-bit fields minus one.
  const url = dataUrl('image/webp', [
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x3f, 0x02, 0x00, // width 576 - 1
    0x2b, 0x01, 0x00, // height 300 - 1
  ])
  assert.deepEqual(imageBox(image(url)), { width: 576, height: 300 })
})

test('a format this side does not read answers nothing', () => {
  const url = dataUrl('image/avif', [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70])
  assert.equal(imageBox(image(url)), null)
  assert.equal(imageBox(image('not a data url')), null)
})

test('the same picture is read once', () => {
  const url = dataUrl('image/png', png(10, 20))
  const first = imageBox(image(url))
  const second = imageBox({ mimeType: 'image/png', bytes: 1, dataUrl: url })
  assert.deepEqual(first, { width: 10, height: 20 })
  assert.equal(second, first, 'the second read answers the same object')
})

/**
 * How big a picture is, before it has been decoded.
 *
 * The transcript's pictures arrive as data URLs (`ChatImage`), and a row that draws one has to know
 * the box it will take *before* the bytes are decoded: an `<img>` with no size is zero high until it
 * loads, so a row that holds one grows by up to the viewer's ceiling the moment the picture lands —
 * under a reader who is scrolling, that is a layout correction per picture (2026-11-05, user report:
 * 只有那个图片多的会话滚动会回弹). The header carries the size, so it is read from the header.
 *
 * Only the formats an engine puts in a transcript are read (PNG, JPEG, GIF, WebP); anything else
 * answers `null`, and the row falls back to its own layout (the picture then takes its box from its
 * own aspect once loaded, exactly as before).
 */

import type { ChatImage } from '@/api/session-types'

export interface ImageBox {
  width: number
  height: number
}

/** How much of a data URL is decoded to find the header: every format's size sits in the first bytes. */
const HEADER_BYTES = 512
/**
 * How far a JPEG's segment walk may look for its frame header.
 *
 * A JPEG's size is not at a fixed offset: the segments before the frame header — JFIF, Exif, an ICC
 * profile, a thumbnail — are of variable length. Chrome's own screenshots carry theirs at byte 632,
 * so a 512-byte window missed 55 of the 56 screenshots of the picture-heavy conversation: the rows
 * fell back to a guessed aspect, which for a narrow 181 × 2560 capture put 105 px where the row
 * drew 416 — and every up-scroll past one was a correction (2026-11-05, 「各个图片之间往上翻是集中
 * 出问题的地方」).
 */
const JPEG_HEADER_BYTES = 65536

/** The sizes already read, by data URL. A picture's header never changes. */
const boxes = new Map<string, ImageBox | null>()

function bytesOf(dataUrl: string, limit: number): Uint8Array | null {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const payload = dataUrl.slice(comma + 1)
  const base64 = payload.slice(0, Math.ceil((limit / 3) * 4))
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function u16be(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!
}

/** PNG: the `IHDR` chunk is the first one, and its width and height are big-endian 32-bit. */
function pngBox(bytes: Uint8Array): ImageBox | null {
  if (bytes.length < 24) return null
  const width = view(bytes).getUint32(16)
  const height = view(bytes).getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/** GIF: a little-endian 16-bit pair at offset 6. */
function gifBox(bytes: Uint8Array): ImageBox | null {
  if (bytes.length < 10) return null
  const width = bytes[6]! | (bytes[7]! << 8)
  const height = bytes[8]! | (bytes[9]! << 8)
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * JPEG: walk the segments to the frame header.
 *
 * The size is not at a fixed offset — the segments before it (JFIF, Exif, a thumbnail) are of
 * variable length — so the marker chain is followed to the first `SOFn`.
 */
function jpegBox(bytes: Uint8Array): ImageBox | null {
  let at = 2
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]!
    // A standalone marker carries no payload; the frame markers carry the size.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    if (marker === 0xda) return null
    const length = u16be(bytes, at + 2)
    if (length < 2) return null
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      const height = u16be(bytes, at + 5)
      const width = u16be(bytes, at + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    at += 2 + length
  }
  return null
}

/** WebP: `VP8X` carries the canvas size minus one, `VP8 ` the lossy frame's, `VP8L` the lossless'. */
function webpBox(bytes: Uint8Array): ImageBox | null {
  if (bytes.length < 30) return null
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
    return { width, height }
  }
  if (chunk === 'VP8 ') {
    const width = ((bytes[27]! << 8) | bytes[26]!) & 0x3fff
    const height = ((bytes[29]! << 8) | bytes[28]!) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (chunk === 'VP8L') {
    const bits = view(bytes).getUint32(21, true)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    return width > 0 && height > 0 ? { width, height } : null
  }
  return null
}

/**
 * The pixel size one picture carries, or null when this side cannot read it.
 *
 * Read once per data URL: a transcript redraws its rows on every frame of a turn, and a header read
 * per draw would be work for a fact that never changes.
 */
function readBox(dataUrl: string, mime: string, limit: number): ImageBox | null {
  const bytes = bytesOf(dataUrl, limit)
  if (bytes === null || bytes.length === 0) return null
  if (mime === 'image/png') return pngBox(bytes)
  if (mime === 'image/gif') return gifBox(bytes)
  if (mime === 'image/jpeg' || mime === 'image/jpg') return jpegBox(bytes)
  if (mime === 'image/webp') return webpBox(bytes)
  return null
}

export function imageBox(image: ChatImage): ImageBox | null {
  const cached = boxes.get(image.dataUrl)
  if (cached !== undefined) return cached
  const mime = image.mimeType === '' ? image.dataUrl.slice(5, image.dataUrl.indexOf(';')) : image.mimeType
  const jpeg = mime === 'image/jpeg' || mime === 'image/jpg'
  let box = readBox(image.dataUrl, mime, HEADER_BYTES)
  // Only a JPEG needs the deep window: the other three formats put their size at a fixed offset.
  if (box === null && jpeg) box = readBox(image.dataUrl, mime, JPEG_HEADER_BYTES)
  boxes.set(image.dataUrl, box)
  return box
}

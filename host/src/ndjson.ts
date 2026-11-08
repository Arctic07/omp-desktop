/**
 * One transcript read: every line of a session file, in chunks.
 *
 * A conversation file is unbounded — a long session with large tool results is tens of megabytes —
 * so a host read of one must cost a fixed amount per step: one chunk plus the line being carried.
 * The visitor answers whether to keep going, which is what lets a caller stop at the first line it
 * cares about (a turn count still visits every line; a written-ness probe stops at the first message).
 *
 * The owner's bound is the chunk and the line being built. A line is kept as the pieces the reads
 * delivered it in and joined once, when it is handed over: appending to one growing string copies it
 * per chunk, which makes a single huge line — one large tool result is tens of megabytes — quadratic
 * in the host that serves every conversation.
 */

import * as fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

/** How many bytes one read takes from a session file. A conversation is read in chunks, never whole. */
const READ_CHUNK_BYTES = 1 << 20

/**
 * Visits every line of one session file, in chunks.
 *
 * `line` is raw: no trimming and no filtering, so a caller decides what a usable line is.
 *
 * Bytes are decoded as one stream, never chunk by chunk: a character whose bytes straddle a chunk
 * boundary would otherwise arrive as two replacement characters, and the text the caller shows would
 * carry them (2026-11-03, review of the rewound-conversation fix).
 *
 * Answers whether the file could be read. An unreadable file visits nothing and answers `false` —
 * a caller that has to tell "no such line" from "could not look" is the reason this is not silent.
 */
export function readLines(file: string, visit: (line: string) => boolean): boolean {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    // ENOENT or a permission error: the caller is told it could not look, never that the file is empty.
    return false
  }
  try {
    return readOpen(fd, visit)
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // A close failure says nothing about the lines this read already delivered.
    }
  }
}

/**
 * The read itself, over an open descriptor: every line, in chunks.
 *
 * One chunk is one `fs.readSync`; a failure there ends the read with `false` rather than half a
 * file's lines, and a visitor's own exception is not caught — that is a caller's bug, not a fact
 * about the file.
 */
function readOpen(fd: number, visit: (line: string) => boolean): boolean {
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  const decoder = new StringDecoder('utf8')
  // The pieces of the line being built: dropped as soon as they are joined and handed over, so
  // nothing outlives the line the caller is reading.
  let pieces: string[] = []
  /** Hands over every complete line in `text`; `false` when the visitor asked to stop. */
  const handOver = (text: string): boolean => {
    let start = 0
    for (;;) {
      const index = text.indexOf('\n', start)
      if (index < 0) {
        if (start < text.length) pieces.push(text.slice(start))
        return true
      }
      pieces.push(text.slice(start, index))
      const line = pieces.join('')
      pieces = []
      if (!visit(line)) return false
      start = index + 1
    }
  }
  for (;;) {
    const read = readChunk(fd, buffer)
    if (read === null) return false
    if (read === 0) break
    if (!handOver(decoder.write(buffer.subarray(0, read)))) return true
  }
  // The decoder's own tail (a truncated character at the end of the file) belongs to whatever line
  // is being built, and a last line without its newline is still a line.
  if (!handOver(decoder.end())) return true
  if (pieces.length > 0) visit(pieces.join(''))
  return true
}

/** One chunk from an open transcript, or `null` when the read itself failed. */
function readChunk(fd: number, buffer: Buffer): number | null {
  try {
    return fs.readSync(fd, buffer, 0, buffer.length, null)
  } catch {
    // An I/O error on an open file (a device, a file truncated under the read) ends the pass: the
    // caller hears that it could not look rather than receiving the lines read so far.
    return null
  }
}

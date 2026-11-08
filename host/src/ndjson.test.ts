import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { readLines } from './ndjson.ts'
import { MESSAGE as MESSAGE_LINE, transcriptFixture } from './transcript-fixture.ts'

/**
 * What a chunked transcript read owes its callers: the lines it delivers are the file's lines.
 *
 * A conversation is read in 1 MiB chunks, so text that a read boundary cuts through is the case that
 * matters — the readers that take whole lines from it (`session-lifecycle.ts`'s removal guard,
 * `plugin-sessions.ts`'s counters and rows) hand the text on, and a character turned into replacement
 * bytes mid-file corrupts what the reader sees. Content here is UTF-8 Chinese for exactly that
 * reason: three bytes, so a boundary can land inside one.
 */

/** Every line the reader delivers for one file. */
function collect(file: string): string[] {
  const seen: string[] = []
  assert.equal(readLines(file, (line) => seen.push(line) > 0), true)
  return seen
}

test('a character a chunk boundary cuts through arrives whole', () => {
  // The head is padded so the first byte of `中` is the last byte of the first chunk: per-chunk
  // decoding turns those three bytes into replacement characters.
  const head = '{"type":"message","content":"'
  const pad = (1 << 20) - 1 - head.length
  const line = `${head}${'x'.repeat(pad)}中"`
  const { file, root } = transcriptFixture('boundary', [line])
  const [delivered] = collect(file)
  assert.equal(delivered, line, 'the line is delivered byte for byte')
  assert.equal(delivered.includes('\uFFFD'), false, 'and holds no replacement character')
  fs.rmSync(root, { recursive: true, force: true })
})

test('a line longer than one chunk is delivered once, in order', () => {
  const long = `{"content":"${'x'.repeat(2 << 20)}"}`
  const { file, root } = transcriptFixture('long', ['first', long, 'last'])
  assert.deepEqual(collect(file), ['first', long, 'last'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('a file the reader cannot open delivers nothing and says so', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-ndjson-missing-'))
  const seen: string[] = []
  assert.equal(readLines(path.join(root, 'gone.jsonl'), (line) => seen.push(line) > 0), false)
  assert.deepEqual(seen, [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('a last line without its newline is still a line', () => {
  // A killed writer leaves the tail unterminated, and the entry in it is the reader's newest.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-ndjson-tail-'))
  const file = path.join(root, 'session.jsonl')
  fs.writeFileSync(file, 'first\nsecond')
  assert.deepEqual(collect(file), ['first', 'second'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('a boundary that falls exactly on a newline splits nothing', () => {
  // The newline is the last byte of the first chunk: the line before it is whole, and the next line
  // starts with the second read.
  const head = `{"a":"${'x'.repeat((1 << 20) - 9)}"}`
  assert.equal(head.length, (1 << 20) - 1, 'the newline lands on the seam')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-ndjson-seam-'))
  const file = path.join(root, 'session.jsonl')
  fs.writeFileSync(file, `${head}\n${MESSAGE_LINE}\n`)
  assert.deepEqual(collect(file), [head, MESSAGE_LINE])
  fs.rmSync(root, { recursive: true, force: true })
})

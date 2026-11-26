#!/usr/bin/env node
// Gate: the updater secret key matches the public key the application verifies against.
//
// `tauri build` only *warns* when the secret key's key number differs from
// `plugins.updater.pubkey` (`tauri:crates/tauri-cli/src/bundle.rs`), and only after the whole build
// has finished. A rotated key that missed one half therefore publishes a release every installed
// copy rejects at runtime, while the release log carries a warning nobody reads. The release
// workflow signs a probe with the same secret it builds with and runs this check on that signature
// before the build starts, so both a key that will not decrypt and a key the client would reject
// fail in seconds.
//
// Both sides are minisign boxes: `untrusted comment: …` followed by a base64 payload whose first
// two bytes are the signature algorithm and next eight are the key number. Comparing those eight
// bytes is the same test tauri applies to the decoded keys, without needing the private key here.
//
// Usage: node scripts/check-signing-key.mjs <signature file>

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CONFIG = fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url))
const KEYNUM_OFFSET = 2
const KEYNUM_BYTES = 8

function fail(message) {
  console.error(`\nsigning key: ${message}`)
  process.exit(1)
}

/** The eight key-number bytes of a base64-encoded minisign box, as minisign stores them. */
function keyNumberOf(encoded, what) {
  const text = Buffer.from(encoded, 'base64').toString('utf8')
  const lines = text.split(/\r?\n/).filter((line) => line !== '')
  if (lines.length < 2 || !lines[0].startsWith('untrusted comment:')) {
    fail(`${what} is not a minisign box: no "untrusted comment" header`)
  }
  const payload = Buffer.from(lines[1], 'base64')
  if (payload.length < KEYNUM_OFFSET + KEYNUM_BYTES) {
    fail(`${what} is not a minisign box: ${payload.length} payload byte(s)`)
  }
  return payload.subarray(KEYNUM_OFFSET, KEYNUM_OFFSET + KEYNUM_BYTES)
}

/** minisign prints the key number least-significant byte first; match that for a readable message. */
function keyNumberString(bytes) {
  return Buffer.from(bytes).reverse().toString('hex')
}

const signaturePath = process.argv[2]
if (!signaturePath) fail('usage: node scripts/check-signing-key.mjs <signature file>')

const configured = JSON.parse(readFileSync(CONFIG, 'utf8')).plugins?.updater?.pubkey
if (typeof configured !== 'string' || configured === '') {
  fail(`${CONFIG} has no plugins.updater.pubkey`)
}

let signature
try {
  signature = readFileSync(signaturePath, 'utf8')
} catch (error) {
  fail(`cannot read ${signaturePath}: ${error.message}`)
}

const publicNumber = keyNumberOf(configured, 'plugins.updater.pubkey')
const secretNumber = keyNumberOf(signature.trim(), signaturePath)

if (!publicNumber.equals(secretNumber)) {
  fail(
    `the secret key ${keyNumberString(secretNumber)} does not match plugins.updater.pubkey ` +
      `${keyNumberString(publicNumber)}: every published update would be rejected`,
  )
}

console.log(
  `signing key: the secret key matches plugins.updater.pubkey (${keyNumberString(publicNumber)})`,
)

#!/usr/bin/env node
// Gate: the public surface (`rules.md#security` — nothing from this machine enters a commit).
//
// The repository is public and its history is permanent, so this runs on exactly what the next
// `git add -A` would take: tracked files plus untracked files git does not ignore. A hit is a
// refusal, not a warning: a credential that reached one commit is public and is rotated, not deleted.
//
// Three kinds of finding:
// - a path that must never be tracked — environment files, key material, session transcripts, logs,
//   the SQLite store, the local-only note tier, build output, and the `%SystemDrive%` directory a bad
//   environment recipe created;
// - content that is a credential, in the forms providers actually print;
// - a Windows user-profile path naming a person rather than a placeholder (`C:\Users\someone` is a
//   fixture; a segment that is not a placeholder word is a machine path).
//
// Internal project names and sample projects cannot be detected mechanically; `rules.md#security`
// keeps them out by review, and a consumer that copies a tree in must run this before pushing.

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const ROOT = process.cwd()

const FORBIDDEN_PATHS = [
  { test: /(^|\/)\.env(\.|$)/, allow: /(^|\/)\.env\.example$/, why: 'environment file' },
  { test: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i, why: 'private key file' },
  { test: /\.(pem|p12|pfx|key|jks|keystore)$/i, why: 'key material' },
  { test: /\.(log|jsonl|sqlite|sqlite3|db)$/i, why: 'machine data (log, session transcript, application store)' },
  { test: /^notes\//, why: 'the local-only note tier' },
  { test: /^host\/(\.dev-data|evidence|\.build|dist)\//, why: 'host build or development output' },
  { test: /^src-tauri\/(binaries|target[^/]*)\//, why: 'Tauri build output' },
  { test: /^src\/dist\//, why: 'frontend build output' },
  { test: /(^|\/)(probe-|\.probe-|perf-|\.perf-)/, why: 'measurement scaffold' },
  { test: /^%SystemDrive%/, why: 'a directory a bad environment recipe created' },
]

// The header is split so this file does not match itself.
const PRIVATE_KEY = new RegExp('-----BEGIN ' + '(?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----')

const CONTENT = [
  { test: PRIVATE_KEY, why: 'private key block' },
  { test: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS access key' },
  { test: /\bgh[pousr]_[A-Za-z0-9]{36,}/, why: 'GitHub token' },
  { test: /\bgithub_pat_[A-Za-z0-9_]{60,}/, why: 'GitHub fine-grained token' },
  { test: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, why: 'Slack token' },
  { test: /\bAIza[0-9A-Za-z_-]{35}\b/, why: 'Google API key' },
  // Real provider keys run 48+ characters after the prefix; the shorter `sk-…` strings in tests are
  // redaction fixtures and must stay publishable.
  { test: /\bsk-[A-Za-z0-9_-]{48,}/, why: 'provider API key' },
]

const PROFILE_PATH = /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]([^\\/"'\s`),;]+)/gi
// A segment carrying `<…>`, a `*` wildcard, a dot (a composed file such as `me.txt`) or one of these
// words is a fixture. Anything else is a person's profile directory.
const PLACEHOLDER_SEGMENTS = new Set(['user', 'users', 'me', 'a', 'b', 'x', 'someone', 'example', 'team', 'test', 'name'])

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return out.split('\0').filter((entry) => entry !== '')
}

const failures = []
let scanned = 0

for (const relative of trackedFiles()) {
  for (const rule of FORBIDDEN_PATHS) {
    if (!rule.test.test(relative)) continue
    if (rule.allow !== undefined && rule.allow.test(relative)) continue
    failures.push(`${relative}: ${rule.why} must not be tracked`)
    break
  }

  const absolute = path.join(ROOT, relative)
  // A tracked file may be deleted in the working tree before the deletion is committed.
  if (!existsSync(absolute)) continue
  const buffer = readFileSync(absolute)
  scanned += 1
  // git decides text versus binary by NUL bytes; fonts and images carry no credential line.
  if (buffer.subarray(0, 8192).includes(0)) continue

  const lines = buffer.toString('utf8').split('\n')
  for (const [index, line] of lines.entries()) {
    for (const rule of CONTENT) {
      if (rule.test.test(line)) {
        failures.push(`${relative}:${index + 1}: ${rule.why} — remove it and rotate the credential`)
      }
    }
    PROFILE_PATH.lastIndex = 0
    for (const match of line.matchAll(PROFILE_PATH)) {
      const segment = match[1]
      if (/[<>*…]/.test(segment) || segment.includes('.') || PLACEHOLDER_SEGMENTS.has(segment.toLowerCase())) continue
      failures.push(
        `${relative}:${index + 1}: machine path "${match[0]}" — use a placeholder such as C:\\Users\\<user>`,
      )
    }
  }
}

if (failures.length > 0) {
  console.error(`\npublic surface: ${failures.length} finding(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`\npublic surface: ${scanned} files, no credential, machine data, or profile path`)

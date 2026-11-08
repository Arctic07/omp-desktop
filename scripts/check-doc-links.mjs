#!/usr/bin/env node
// Gate: documentation references resolve (AGENTS.md "Where a fact lives", `rules.md#comments-state-contracts-not-transcripts`).
//
// Two reference forms are checked in every tracked .md file:
//   1. Markdown links `[text](target)` — local targets must exist, relative to the file.
//   2. Inline code spans that name a repository file, e.g. `host/src/constants.ts`,
//      `services/runtime/session.rs::build_prompt`, `state/session-lists.ts:42`.
//      A token resolves when some tracked path equals it or ends with "/<token>", so a
//      module-relative citation (`services/store/schema.rs`) is accepted while a renamed
//      or deleted file is caught.
//
// Skipped on purpose: URLs, anchors, globs/patterns (`*{}[]<>()|,$` or spaces),
// generated or untracked output (assets/, dist/, binaries/, target/, probe-*/perf-*/.tmp-*
// scaffolding that `rules.md#verification-scaffolding` keeps out of the repository), placeholder names
// (NNNN, yyyy, MM-DD) and refs prefixed with their owner (`oh-my-pi:task/executor.ts`,
// `deepseek-harness:docs/testing.md`, `beui:…`, `tauri:…`, `vue:…`, `removed:…`) — the
// prefix is how a standing document cites another repository or a deleted file.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const ROOT = process.cwd()
const EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs|rs|css|html|md|json|toml|ya?ml)$/
const GENERATED = ['assets/', 'src/dist/', 'host/dist/', 'src-tauri/binaries/', 'src-tauri/target/', 'probe-', 'perf-', '.tmp-']
const DISALLOWED = /[*{}[\]<>()|,$\\%\s]/
const PLACEHOLDER = /N{3,}|y{4}|M{2}-D{2}|x\.y\.z/

// Scope: the standing-document tier plus the record tiers. Proposal, handoff and design
// documents written before this gate, and the three frozen `*HANDOFF.md` files, have all been
// deleted from the repository (their history is in git); LEGACY is what remains to be skipped, and
// it is empty for that reason. The list and the "listed as legacy but missing" check stay so a
// migration that leaves one behind is caught in the same run that adds it.
const IN_SCOPE = [
  /^AGENTS\.md$/,
  /^rules\.md$/,
  /^README\.md$/,
  /^src\/(?:AGENTS|rules|README)\.md$/,
  /^notes\//,
  /^postmortems\//,
]
const LEGACY = []

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return out.split('\0').filter((entry) => entry !== '')
}

const tracked = trackedFiles()
const suffix = new Set()
for (const file of tracked) {
  const parts = file.split('/')
  for (let i = 0; i < parts.length; i += 1) suffix.add(parts.slice(i).join('/'))
}

function resolves(token) {
  return tracked.includes(token) || suffix.has(token)
}

function candidateFromCodeSpan(raw) {
  const token = raw
    .trim()
    .replace(/::.*$/, '')
    .replace(/:\d+(-\d+)?$/, '')
    .replace(/\/+$/, '')
  if (!token.includes('/')) return null
  if (!EXTENSIONS.test(token)) return null
  if (DISALLOWED.test(token)) return null
  if (PLACEHOLDER.test(token)) return null
  if (/^[A-Za-z][A-Za-z0-9_.-]+:/.test(token)) return null // another repository's path
  if (GENERATED.some((prefix) => token.startsWith(prefix) || token.includes(`/${prefix}`))) return null
  return token
}

const failures = []
let checkedLinks = 0
let checkedRefs = 0
let scanned = 0
let skipped = 0

for (const legacy of LEGACY) {
  if (!tracked.includes(legacy)) failures.push(`${legacy}: listed as legacy but missing — drop the entry`)
}

for (const file of tracked) {
  if (!file.endsWith('.md')) continue
  if (!IN_SCOPE.some((pattern) => pattern.test(file))) {
    if (LEGACY.includes(file)) skipped += 1
    continue
  }
  if (LEGACY.includes(file)) failures.push(`${file}: in both IN_SCOPE and LEGACY`)
  scanned += 1
  const absolute = path.join(ROOT, file)
  const text = readFileSync(absolute, 'utf8')
  const dir = path.dirname(absolute)

  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1].split('#')[0]
    if (target === '' || /^(https?|mailto|tel):/i.test(target)) continue
    checkedLinks += 1
    const decoded = decodeURIComponent(target)
    if (!existsSync(path.resolve(dir, decoded))) failures.push(`${file}: broken link -> ${target}`)
  }

  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = candidateFromCodeSpan(match[1])
    if (token === null) continue
    checkedRefs += 1
    if (!resolves(token)) failures.push(`${file}: unknown file reference -> ${token}`)
  }
}

if (failures.length > 0) {
  console.error(`doc links: ${failures.length} violation(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`doc links: ${checkedLinks} local link(s) and ${checkedRefs} file reference(s) resolve`)

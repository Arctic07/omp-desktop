#!/usr/bin/env node
// Gate: single-file size limit (`rules.md#single-file-line-limit` — no source file above 1000 lines,
// 300–600 recommended).
//
// Files already over the limit are pinned in scripts/file-size-allowlist.json at their
// current size: they may shrink but never grow, and the entry must disappear once the
// file is at or below the limit. That freezes the existing debt instead of blocking
// every build on it.

import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const ROOT = process.cwd()
const LIMIT = 1000
const ALLOWLIST = 'scripts/file-size-allowlist.json'
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.rs', '.css', '.html'])

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return out.split('\0').filter((entry) => entry !== '')
}

function lineCount(file) {
  const text = readFileSync(file, 'utf8')
  if (text === '') return 0
  let lines = 1
  for (const char of text) if (char === '\n') lines += 1
  return text.endsWith('\n') ? lines - 1 : lines
}

const allowlistPath = path.join(ROOT, ALLOWLIST)
if (!existsSync(allowlistPath)) throw new Error(`${ALLOWLIST} is missing`)
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
delete allowlist._note

const failures = []
const seen = new Set()
let overLimit = 0

for (const relative of trackedFiles()) {
  if (!CODE_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue
  // A file can be tracked and deleted in the working tree at the same time (a deletion is only staged
  // when someone commits it, and the gates run before that): there is no size to measure.
  if (!existsSync(path.join(ROOT, relative))) continue
  const lines = lineCount(path.join(ROOT, relative))
  if (lines <= LIMIT && !(relative in allowlist)) continue

  if (lines > LIMIT) overLimit += 1
  const pinned = allowlist[relative]
  if (pinned === undefined) {
    failures.push(
      `${relative}: ${lines} lines exceeds ${LIMIT} — split it, or pin today's size in ${ALLOWLIST} while it only shrinks`,
    )
    continue
  }
  seen.add(relative)
  if (!Number.isInteger(pinned) || pinned <= LIMIT) {
    failures.push(`${ALLOWLIST}: "${relative}" must pin a size above ${LIMIT}`)
    continue
  }
  if (lines > pinned) {
    failures.push(`${relative}: grew to ${lines} lines (pinned ${pinned}) — an over-limit file may only shrink`)
  } else if (lines <= LIMIT) {
    failures.push(`${relative}: now ${lines} lines, at or below the limit — remove its allowlist entry`)
  } else {
    console.log(`ok    ${String(lines).padStart(5)} <= ${pinned} (pinned)  ${relative}`)
  }
}

for (const entry of Object.keys(allowlist)) {
  if (!seen.has(entry)) failures.push(`${ALLOWLIST}: stale entry "${entry}" — the file is gone or no longer needs it`)
}

if (failures.length > 0) {
  console.error(`\nfile size: ${failures.length} violation(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`\nfile size: no file above ${LIMIT} lines outside the ${Object.keys(allowlist).length}-entry allowlist (${overLimit} pinned)`)

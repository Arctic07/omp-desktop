#!/usr/bin/env node
// Gate: the installer's Windows surface (`rules.md#updates-and-upgrades` — a per-user install that
// writes no firewall rule, and nothing this repository ships binding an inbound port).
//
// Three properties, each measured where it would first break:
// - `tauri.conf.json` names the per-user install explicitly. Tauri's default happens to be
//   `currentUser`, but a default is not a decision: the rule says the installer never elevates, so
//   the configuration has to say it.
// - No installer script writes a firewall rule — neither the hooks this repository configures, nor
//   the template it would replace, nor any other script in `src-tauri/nsis`.
// - Nothing in the Rust or host sources binds a non-loopback address, and every `Bun.serve` call
//   carries a loopback hostname (the call binds `0.0.0.0` without one). Loopback binds stay legal,
//   which is what keeps test endpoints honest without an allowlist.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const ROOT = process.cwd()
const failures = []

const readJson = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'))

const config = readJson('src-tauri/tauri.conf.json')
const nsis = config.bundle?.windows?.nsis ?? {}
if (nsis.installMode !== 'currentUser') {
  failures.push(
    `src-tauri/tauri.conf.json: bundle.windows.nsis.installMode is ${JSON.stringify(nsis.installMode)} — write "currentUser": an elevated or machine-wide install is a UAC prompt`,
  )
}
if (config.bundle?.externalBin !== undefined) {
  failures.push(
    'src-tauri/tauri.conf.json: bundle.externalBin ships a compiled host — the installer carries the bundle resource instead',
  )
}

// A firewall rule is written by an installer script. The configured hooks and template are the two
// this repository chooses; the directory walk catches a third one nobody pointed the config at, and
// a configured path that does not exist fails instead of silently shrinking the check.
const FIREWALL = /netsh\s+(?:advfirewall|firewall)|New-NetFirewallRule|Set-NetFirewallRule|Enable-NetFirewallRule/i
const scripts = []
for (const [key, value] of [
  ['installerHooks', nsis.installerHooks],
  ['template', nsis.template],
]) {
  if (typeof value !== 'string') continue
  const relative = path.posix.join('src-tauri', value)
  if (!existsSync(path.join(ROOT, relative))) {
    failures.push(`src-tauri/tauri.conf.json: bundle.windows.nsis.${key} names ${value}, which does not exist`)
    continue
  }
  scripts.push(relative)
}
const NSIS_DIR = 'src-tauri/nsis'
function walk(dir) {
  const out = []
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(relative))
    else out.push(relative)
  }
  return out
}
if (existsSync(path.join(ROOT, NSIS_DIR))) scripts.push(...walk(NSIS_DIR))
for (const file of new Set(scripts)) {
  if (FIREWALL.test(readFileSync(path.join(ROOT, file), 'utf8'))) {
    failures.push(`${file}: writes a Windows firewall rule — nothing this build ships opens an inbound port`)
  }
}

// Sources that could bind a socket. Tracked and untracked-but-not-ignored files both count: a new
// listener is exactly the change this gate must see before it is committed.
const BIND = new RegExp(
  [
    String.raw`\bbind\(\s*["'](?:0\.0\.0\.0|\[::\]|::)`, // bind("0.0.0.0:8080")
    String.raw`\bbind\(\s*\(\s*["'](?:0\.0\.0\.0|::)`, // bind(("0.0.0.0", 8080))
    String.raw`\blisten\(\s*[^)]*["'](?:0\.0\.0\.0|::)["']`, // listen(8080, "0.0.0.0")
    String.raw`host(?:name)?:\s*["'](?:0\.0\.0\.0|::)["']`, // Bun.serve({ hostname: "0.0.0.0" })
  ].join('|'),
)
const BUN_SERVE = /\bBun\.serve\s*\(/g
const LOOPBACK_HOSTNAME = /hostname:\s*['"](?:127\.0\.0\.1|localhost|::1|\[::1\])['"]/
const SOURCES = ['.rs', '.ts']
const SOURCE_DIRS = ['src-tauri/src/', 'host/src/', 'host/scripts/']

/** The text from one opening paren to its match, so a call is judged on its own arguments. */
function callArguments(text, open) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1
    else if (text[index] === ')') {
      depth -= 1
      if (depth === 0) return text.slice(open, index + 1)
    }
  }
  return text.slice(open)
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return out.split('\0').filter((entry) => entry !== '')
}

for (const relative of trackedFiles()) {
  if (!SOURCES.includes(path.extname(relative))) continue
  if (!SOURCE_DIRS.some((dir) => relative.startsWith(dir))) continue
  const absolute = path.join(ROOT, relative)
  if (!existsSync(absolute)) continue
  const text = readFileSync(absolute, 'utf8')
  for (const [index, line] of text.split('\n').entries()) {
    if (BIND.test(line)) {
      failures.push(
        `${relative}:${index + 1}: binds a non-loopback address — a listener binds 127.0.0.1 (or ::1) and says in its note why it exists`,
      )
    }
  }
  for (const match of text.matchAll(BUN_SERVE)) {
    const open = match.index + match[0].length - 1
    if (!LOOPBACK_HOSTNAME.test(callArguments(text, open))) {
      failures.push(
        `${relative}:${lineAt(text, match.index)}: Bun.serve without a loopback hostname — it binds 0.0.0.0; pass hostname: '127.0.0.1'`,
      )
    }
  }
}

if (failures.length > 0) {
  console.error(`\ninstaller surface: ${failures.length} finding(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('installer surface: per-user install, no firewall rule, no non-loopback bind')

/**
 * Session storage identity and file-level store operations.
 *
 * Everything here is filesystem-level: how a session file maps to the routing `sessionId`, and
 * which paths are allowed in. No engine object is created.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { SESSION_SCAN_MAX_DEPTH } from './constants.ts'
import type { HostPaths } from './env.ts'
import { ERROR_CODES, HostError } from './protocol/errors.ts'

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const UINT64_MASK = 0xffffffffffffffffn

/** FNV-1a over the UTF-8 bytes of `text`, as 16 lowercase hex digits. */
function fnv1a64Hex(text: string): string {
  let hash = FNV_OFFSET_BASIS
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & UINT64_MASK
  }
  return hash.toString(16).padStart(16, '0')
}

/** Windows verbatim spelling of an already-absolute path. */
function verbatimPath(absolute: string): string {
  if (absolute.startsWith('\\\\?\\')) return absolute
  return absolute.startsWith('\\\\') ? `\\\\?\\UNC\\${absolute.slice(2)}` : `\\\\?\\${absolute}`
}

/**
 * The one spelling a session path is addressed by (contract §2.5-1, ruling A16).
 *
 * `realpath` when the file exists, otherwise the verbatim form of the resolved path; then the
 * verbatim prefix is stripped (`\\?\UNC\server\share` back to `\\server\share`) and the drive
 * letter is upper-cased. The digest and every `sessionFile` this host returns use this form, so
 * the same file cannot produce two ids depending on how the caller spelled it.
 */
export function canonicalSessionPath(file: string): string {
  let resolved: string
  try {
    resolved = fs.realpathSync.native(file)
  } catch {
    resolved = verbatimPath(path.resolve(file))
  }
  const plain = resolved.startsWith('\\\\?\\UNC\\')
    ? `\\\\${resolved.slice('\\\\?\\UNC\\'.length)}`
    : resolved.startsWith('\\\\?\\')
      ? resolved.slice('\\\\?\\'.length)
      : resolved
  return plain.replace(/^([a-z]):/, (_match, letter: string) => `${letter.toUpperCase()}:`)
}

/** The exact path spelling a session id is derived from. */
export function identityPath(file: string): string {
  return canonicalSessionPath(file)
}

/**
 * Routing id of a session file.
 *
 * The digest is taken over the canonical path, so the same file yields the same id across host
 * restarts and across the plain/verbatim spellings a Windows caller may hand back.
 */
export function sessionIdFor(file: string): string {
  return `s${fnv1a64Hex(identityPath(file))}`
}

/** True when `candidate` is `root` itself or lies underneath it. */
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Resolves a caller-supplied session path to the canonical file inside the host session
 * directory.
 *
 * A path that does not exist yet is resolved through its parent, and only when that parent is
 * inside the session directory; this keeps a `session_open` from creating a file anywhere else
 * while still allowing the "new conversation at this path" case.
 */
export function resolveSessionFile(paths: HostPaths, requested: unknown): string {
  if (typeof requested !== 'string' || requested === '') {
    throw new HostError(ERROR_CODES.invalid_session_path, 'A session file path is required.')
  }
  if (requested.includes('\n') || requested.includes('\r')) {
    throw new HostError(ERROR_CODES.invalid_session_path, 'The session file path is invalid.')
  }
  if (!path.isAbsolute(requested)) {
    throw new HostError(ERROR_CODES.invalid_session_path, 'A session file path must be absolute.')
  }
  const sessionsRoot = canonicalSessionPath(paths.sessionDir)
  let resolved: string
  try {
    resolved = fs.realpathSync.native(requested)
  } catch {
    const parent = path.dirname(requested)
    let realParent: string
    try {
      realParent = fs.realpathSync.native(parent)
    } catch {
      throw new HostError(ERROR_CODES.invalid_session_path, 'The session directory does not exist.')
    }
    resolved = path.join(realParent, path.basename(requested))
  }
  const canonical = canonicalSessionPath(resolved)
  if (!isWithin(sessionsRoot, canonical)) {
    throw new HostError(ERROR_CODES.invalid_session_path, 'The session file is outside the host session directory.')
  }
  return canonical
}

/** Every `.jsonl` file directly inside one directory; an unreadable directory contributes none. */
function jsonlFilesIn(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory)
      .filter(name => name.toLowerCase().endsWith('.jsonl'))
      .map(name => path.join(directory, name))
  } catch {
    return []
  }
}

/**
 * Candidate session files under the host session directory: the flat store plus its buckets.
 *
 * The universe matches the running application's session index
 * (`src-tauri/src/services/session_index/scan.rs`), which looks in the store itself *and* in its
 * bucket subdirectories. The engine's older layout writes one directory per working directory, so a
 * reader that only saw the flat store would miss most of the history - R4 measured 85.5% of the
 * usage cost sitting in those buckets.
 *
 * The walk is recursive, because the engine's own session layout is: a session at
 * `<dir>/<name>.jsonl` keeps its subagent transcripts beside it at `<dir>/<name>/<AgentId>.jsonl`,
 * and *their* children nest the same way under `<dir>/<name>/<AgentId>/<SubId>.jsonl`
 * (`session/…` — `collectSubSessions`, and the engine's stats parser scans the session directory
 * recursively for exactly this reason). A two-level scan knew the flat store and the per-directory
 * buckets but dropped every transcript deeper than a subagent's own, so those tokens never reached
 * the totals. `SESSION_SCAN_MAX_DEPTH` keeps a pathological tree from paying an unbounded
 * traversal; it is far deeper than any parent chain the `task` tool can build.
 *
 * Only `.jsonl` counts, and deliberately so: the index classifies `*.jsonl.gz` as an archive (a
 * different format the entry visitor does not stream) and refuses backup-style names outright, so
 * counting either would report numbers this reader cannot derive from the files it opens.
 */
export function listSessionFiles(paths: HostPaths): string[] {
  const files: string[] = []
  const walk = (directory: string, depth: number): void => {
    files.push(...jsonlFilesIn(directory))
    if (depth >= SESSION_SCAN_MAX_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // `isDirectory()` is false for a symlink even when it points at one, so a link cycle cannot
      // make this walk run away.
      if (!entry.isDirectory()) continue
      walk(path.join(directory, entry.name), depth + 1)
    }
  }
  walk(paths.sessionDir, 0)
  return files
}

/**
 * Cross-conversation `history://` reads for desktop session ids.
 *
 * The engine's `history://<id>` resolves agent ids (a live or parked subagent, or an on-disk agent
 * transcript) and its own system prompt states that unregistered top-level sessions are not
 * discovered from persisted session files. A desktop conversation is exactly such a top-level
 * session, and its routing id (`s` + sixteen hex digits) is a digest of its file path, not a name
 * the engine knows. Without this wrapper, `read history://sb…` in another conversation answers
 * "Unknown agent".
 *
 * The wrapper keeps the engine's handler as the delegate and only takes over ids that name a file
 * inside this host's session store. Everything else - live subagents, parked agents, `current/full`
 * - stays the engine's answer, byte for byte.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { listSessionFiles, sessionIdFor } from './store.ts'
import type { HostPaths } from './env.ts'
import type {
  InternalResourceLike,
  InternalUrlHandlerLike,
  InternalUrlLike,
  SdkBundle,
} from './sdk.ts'

/** A desktop routing id: `s` plus the sixteen lowercase hex digits `sessionIdFor` produces. */
const DESKTOP_SESSION_ID = /^s[0-9a-f]{16}$/i

/** One conversation row the bare index publishes. */
export interface ConversationRow {
  readonly id: string
  readonly file: string
  readonly title: string | null
  readonly cwd: string | null
  readonly updatedAt: number
}

/** What one session file's header says, read from its first few KiB only. */
interface SessionHead {
  readonly title: string | null
  readonly cwd: string | null
}

/** Bytes read from a file's head: the 256-byte title slot plus the header behind it. */
const HEAD_BYTES = 8 * 1024

/** Reads the first lines of a session file and keeps its current title and cwd. */
function readSessionHead(file: string): SessionHead {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0)
    const text = buffer.subarray(0, read).toString('utf8')
    let title: string | null = null
    let cwd: string | null = null
    for (const line of text.split('\n').slice(0, 4)) {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof value !== 'object' || value === null) continue
      const record = value as Record<string, unknown>
      // The physical first line is the fixed-width title slot; legacy files start with the
      // session header instead. Both carry a `title`, and only the header carries `cwd`.
      if (record.type === 'title' && typeof record.title === 'string' && title === null) {
        title = record.title
      } else if (record.type === 'session') {
        if (title === null && typeof record.title === 'string') title = record.title
        if (typeof record.cwd === 'string') cwd = record.cwd
        break
      }
    }
    return { title, cwd }
  } catch {
    return { title: null, cwd: null }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // A close failure says nothing about the header this read already answered.
      }
    }
  }
}

/**
 * The titles and cwds of a conversation list, cached per file because the completion list runs per
 * keystroke.
 *
 * Owner: this module (one host process). Bound: [`HEAD_CACHE_LIMIT`] entries, the least recently
 * read dropped first; each entry is a title, a cwd and the mtime it was read at. Release: an entry
 * is replaced when the file's mtime moves, and a path that no longer exists is simply never asked
 * for again - its entry leaves on the same eviction. `readSessionHead` reads at most
 * [`HEAD_BYTES`] of any file, so the cache's cost is a title and a path per session.
 */
const HEAD_CACHE_LIMIT = 4096
const headCache = new Map<string, { mtimeMs: number; head: SessionHead }>()

function cachedHead(file: string, mtimeMs: number): SessionHead {
  const cached = headCache.get(file)
  if (cached !== undefined) {
    // Re-inserting makes the map's insertion order a recency order, so the entry evicted at
    // capacity is the least recently read one.
    headCache.delete(file)
    if (cached.mtimeMs === mtimeMs) {
      headCache.set(file, cached)
      return cached.head
    }
  }
  const head = readSessionHead(file)
  headCache.set(file, { mtimeMs, head })
  while (headCache.size > HEAD_CACHE_LIMIT) {
    const oldest = headCache.keys().next().value
    if (oldest === undefined) break
    headCache.delete(oldest)
  }
  return head
}

/**
 * Every `.jsonl` file under the host session store, keyed by the id the desktop lists it under.
 *
 * Recursive because the store has both the flat layout and the engine's per-cwd buckets, and a
 * subagent transcript lives beside its parent rather than in a separate tree. Recomputing the id
 * from the canonical path is deliberate: the id is never stored, so the filesystem is the index.
 */
export function sessionsById(paths: HostPaths): Map<string, string> {
  const found = new Map<string, string>()
  for (const file of listSessionFiles(paths)) found.set(sessionIdFor(file), file)
  return found
}

/**
 * The conversations a reader can open: top-level session files, not their subagent transcripts.
 *
 * The top level is the store root plus one bucket level (the engine's `<encoded-cwd>` directory).
 * A directory named exactly like a sibling session file is that session's artifact directory and
 * holds subagent transcripts, so it is not a bucket.
 */
export function conversationFiles(paths: HostPaths): string[] {
  const files: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(paths.sessionDir, { withFileTypes: true })
  } catch {
    return files
  }
  const sessionDirs = new Set<string>()
  const jsonl = (entry: fs.Dirent): boolean => entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')
  for (const entry of entries) {
    if (!jsonl(entry)) continue
    files.push(path.join(paths.sessionDir, entry.name))
    sessionDirs.add(entry.name.slice(0, -'.jsonl'.length))
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || sessionDirs.has(entry.name)) continue
    const bucket = path.join(paths.sessionDir, entry.name)
    let bucketEntries: fs.Dirent[]
    try {
      bucketEntries = fs.readdirSync(bucket, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of bucketEntries) {
      if (jsonl(child)) files.push(path.join(bucket, child.name))
    }
  }
  return files
}

/**
 * The transcript one routing id names, when the conversation index lists it.
 *
 * The same reach {@link conversationRows} publishes and nothing wider: an id that names an agent
 * transcript (`{@link sessionsById}` finds those too, they are not conversations) answers nothing
 * here, which is what keeps a caller that addresses a conversation by id - rather than by the path a
 * list row carried - inside the set a reader could have seen.
 */
export function conversationFileById(paths: HostPaths, sessionId: string): string | undefined {
  return conversationFiles(paths).find(file => sessionIdFor(file) === sessionId)
}

/** The conversation index, newest first. An unreadable or vanished file contributes no row. */
export function conversationRows(paths: HostPaths): ConversationRow[] {
  const rows: ConversationRow[] = []
  for (const file of conversationFiles(paths)) {
    let updatedAt: number
    try {
      updatedAt = fs.statSync(file).mtimeMs
    } catch {
      continue
    }
    const head = cachedHead(file, updatedAt)
    rows.push({ id: sessionIdFor(file), file, title: head.title, cwd: head.cwd, updatedAt })
  }
  return rows.sort((left, right) => right.updatedAt - left.updatedAt)
}

/**
 * How many conversations a bare `history://` listing prints.
 *
 * The listing is read into a model's context, so it is bounded like every other answer the host
 * gives: the newest entries, then a line saying how many were left out. (A completion list is
 * bounded for the same reason, by `COMPLETION_LIMIT` below.)
 */
export const INDEX_LIMIT = 200

/** Markdown for the desktop section of a bare `history://` listing. */
function renderConversationIndex(rows: readonly ConversationRow[]): string {
  if (rows.length === 0) return ''
  const shown = rows.slice(0, INDEX_LIMIT)
  const lines = [
    '## Desktop conversations',
    '',
    '| session id | title | cwd | updated |',
    '|---|---|---|---|',
  ]
  for (const row of shown) {
    const title = (row.title ?? 'Untitled').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
    const cwd = (row.cwd ?? '—').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
    lines.push(`| ${row.id} | ${title} | ${cwd} | ${new Date(row.updatedAt).toISOString()} |`)
  }
  lines.push('', 'Read one conversation with `read history://<session id>`.')
  if (rows.length > shown.length) {
    lines.push(
      `Listing the ${shown.length} most recent of ${rows.length} conversations; the rest are not shown.`,
    )
  }
  return `${lines.join('\n')}\n`
}

/** How many rows autocomplete offers: enough for recent work, small enough for every keystroke. */
const COMPLETION_LIMIT = 40

/**
 * How long the completion list is reused.
 *
 * `complete` is asked on every keystroke and `conversationRows` stats every session file on disk -
 * thousands of syscalls per key on a long-lived store. One entry, expiring on its own, is enough:
 * a conversation written in the last couple of seconds joining the list on the next keystroke is
 * not a difference a reader can see in an autocomplete popup.
 */
const COMPLETION_TTL_MS = 2_000

/**
 * A `history` handler that answers desktop session ids from this host's session store and hands
 * every other id to the engine's own handler.
 */
export class DesktopHistoryHandler implements InternalUrlHandlerLike {
  readonly scheme = 'history'
  readonly spec: unknown

  readonly #delegate: InternalUrlHandlerLike
  readonly #paths: HostPaths
  readonly #sdk: SdkBundle
  /** The last scan the completion list was built from, with the moment it was taken. */
  #rows: { at: number; rows: ConversationRow[] } | null = null

  constructor(delegate: InternalUrlHandlerLike, paths: HostPaths, sdk: SdkBundle) {
    this.#delegate = delegate
    this.#paths = paths
    this.#sdk = sdk
    this.spec = delegate.spec
  }

  /**
   * The conversation list for autocomplete, scanned at most once per [`COMPLETION_TTL_MS`].
   *
   * Owner: this handler, which lives as long as the host's history router. Bound: one list, dropped
   * and rebuilt when it expires. Release: the host process exiting; there is nothing else to free.
   */
  #recentConversations(): ConversationRow[] {
    const now = Date.now()
    if (this.#rows !== null && now - this.#rows.at < COMPLETION_TTL_MS) return this.#rows.rows
    const rows = conversationRows(this.#paths)
    this.#rows = { at: now, rows }
    return rows
  }

  promptDoc(host?: string): string {
    // The engine's doc says bare `history://` lists agents and explicitly excludes persisted
    // top-level sessions; with this wrapper that sentence is no longer the whole answer, so the
    // material the model is given names the desktop route directly.
    const delegate = this.#delegate as { promptDoc?: (host: string) => string | undefined }
    const base = delegate.promptDoc?.(host ?? 'desktop')?.trim() ?? ''
    const desktop =
      '`history://<session id>`: read-only desktop conversation transcript; bare `history://` ' +
      'lists desktop conversations beside agents.'
    return base === '' ? desktop : `${base} ${desktop}`
  }

  /**
   * The session file behind a desktop id, for link renderers that locate without resolving.
   *
   * Engine-owned ids keep the engine's answer; a desktop id has exactly one backing file. An
   * unknown desktop id locates to null, matching the engine's `locate` contract for a miss.
   */
  async locate(url: InternalUrlLike, context?: unknown, options?: unknown): Promise<string | null> {
    const id = url.rawHost || url.hostname
    if (DESKTOP_SESSION_ID.test(id)) return sessionsById(this.#paths).get(id.toLowerCase()) ?? null
    const delegate = this.#delegate as {
      locate?: (url: unknown, context?: unknown, options?: unknown) => Promise<string | null>
    }
    return (await delegate.locate?.(url, context, options)) ?? null
  }

  async resolve(url: InternalUrlLike, context?: unknown): Promise<InternalResourceLike> {
    const id = url.rawHost || url.hostname
    if (id === '') {
      const base = await this.#delegate.resolve(url, context)
      const section = renderConversationIndex(conversationRows(this.#paths))
      if (section === '') return base
      const content = `${base.content.trimEnd()}\n\n${section}`
      return { ...base, content, size: Buffer.byteLength(content, 'utf8') }
    }
    if (!DESKTOP_SESSION_ID.test(id)) return this.#delegate.resolve(url, context)

    const file = sessionsById(this.#paths).get(id.toLowerCase())
    if (file === undefined) {
      throw new Error(
        `Unknown desktop conversation: ${id}\nList conversations with \`read history://\`.`,
      )
    }
    const messages = await this.#sdk.loadSessionMessagesReadOnly(file)
    let head: SessionHead = { title: null, cwd: null }
    try {
      head = cachedHead(file, fs.statSync(file).mtimeMs)
    } catch {
      // The file vanished between the id lookup and the read; the loader has already answered
      // with its own error by this point, and a missing title is not a second one.
    }
    const content = this.#sdk.formatSessionHistoryMarkdown([...messages], {
      title: `${head.title ?? 'Desktop conversation'} (${id}, read-only)`,
    })
    return {
      url: url.href,
      content,
      contentType: 'text/markdown',
      size: Buffer.byteLength(content, 'utf8'),
      sourcePath: file,
      notes: ['Source: desktop conversation session file (read-only)'],
    }
  }

  async complete(
    query?: string,
    context?: unknown,
  ): Promise<{ value: string; label?: string; description?: string }[]> {
    // The engine's own completions (live and parked agents, plus its artifact scan) stay first;
    // replacing the scheme must not silently take agents out of the autocomplete list.
    const delegate = this.#delegate as {
      complete?: (
        query?: string,
        context?: unknown,
      ) => Promise<{ value: string; label?: string; description?: string }[]>
    }
    const base = (await delegate.complete?.(query, context)) ?? []
    const seen = new Set(base.map(candidate => candidate.value.toLowerCase()))
    const sessions = this.#recentConversations()
      .slice(0, COMPLETION_LIMIT)
      .filter(row => !seen.has(row.id))
      .map(row => ({
        value: row.id,
        label: row.title ?? row.id,
        description: row.cwd ?? 'desktop conversation',
      }))
    return [...base, ...sessions]
  }
}

/**
 * Installs the desktop `history` handler over the engine's own.
 *
 * Called once, after `loadSdk()` has evaluated the engine module graph. Replacing the scheme is
 * safe because the wrapper keeps the engine handler as its delegate; a missing engine handler is
 * a broken seam, not a state to paper over.
 */
export function registerSessionHistory(paths: HostPaths, sdk: SdkBundle): void {
  const router = sdk.InternalUrlRouter.instance()
  const engine = router.getHandler('history')
  if (engine === undefined) {
    throw new Error('The engine registered no history:// handler; desktop conversation reads are unavailable.')
  }
  router.register(new DesktopHistoryHandler(engine, paths, sdk))
}

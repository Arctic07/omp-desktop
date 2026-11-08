/**
 * The persisted index behind `usage_summary`: one row set per session file, so the usage page costs
 * a stat per file instead of a re-read of the whole history.
 *
 * The engine owns the session format and this host only reads it, so the index is derived state and
 * never a second source of truth: a file whose length or modification time moved is parsed again
 * whole and its rows replace the ones it had. That is the same bargain the desktop's own session
 * index makes (`src-tauri/src/services/session_index/projection.rs`), and it is why deleting this
 * file costs one scan and nothing else.
 *
 * Two row sets per file. `models` holds one row per provider/model over the file's whole history and
 * is what the lifetime totals, the model breakdown and the per-session table read, so those figures
 * stay exact however long the history is. `days` holds one row per local day and model, newest kept
 * up to {@link USAGE_FILE_DAY_ROWS_MAX} rows, and is what the day tables read - the tables a
 * published cap already cuts. A file that outgrows the row cap drops its earliest days and says so
 * (`daysTruncated`), so a cut is reported rather than silently shrinking a total.
 *
 * Owner: this host process, one index per data root. Bound: `USAGE_MAX_FILES` files, each holding
 * one row per model it ever used plus one row per day and model. Release: a file that leaves the
 * store has its rows dropped on the next read, and the whole index is rebuilt when its version or
 * shape does not match.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { mapLimit } from './capabilities.ts'
import { USAGE_FILE_DAY_ROWS_MAX, USAGE_MAX_FILES, USAGE_SCAN_CONCURRENCY } from './constants.ts'
import type { HostPaths } from './env.ts'
import { logLine } from './log.ts'
import type { FileEntry, SdkBundle } from './sdk.ts'
import { listSessionFiles } from './store.ts'

/** The index's own shape version: a file written by another shape is rebuilt, never migrated. */
export const USAGE_INDEX_VERSION = 1

const DAY_MS = 86_400_000

/**
 * One row's counters, in a fixed column order so the persisted form is an array: input, output,
 * cacheRead, cacheWrite, reasoning, costUsd, calls.
 *
 * `reasoning` is a subset of `output` and never enters the billable total (ruling C9); `costUsd` is
 * a float sum the frontend rounds for display.
 */
export type UsageCounters = [input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number, costUsd: number, calls: number]

/** One file's rows, plus what the next read compares against to know it is current. */
export interface IndexedFile {
  len: number
  mtimeMs: number
  firstMs: number
  lastMs: number
  /** Keyed `provider\0model`: the file's whole history, exact. */
  models: Record<string, UsageCounters>
  /** Keyed `YYYY-MM-DD\0provider\0model`, in this machine's local time. */
  days: Record<string, UsageCounters>
  /** Set when `days` hit its row cap, so the day tables are known to be a window. */
  daysTruncated: boolean
}

/** The persisted index: a shape version and one entry per session file, keyed by its full path. */
export interface UsageIndex {
  version: number
  files: Record<string, IndexedFile>
}

/** What one read of the store did, so a shortened answer is visible rather than silent. */
export interface UsageRefresh {
  /**
   * The rows this answer is built from, as one snapshot: the live index object is replaced whole by
   * a later read, and a caller that held the index itself would publish its two table loops from
   * two different stores.
   */
  readonly files: Record<string, IndexedFile>
  /** Session files the store holds, up to the file cap. */
  readonly listed: number
  /** Files whose rows the index now holds. */
  readonly sessions: number
  /** Files or entries this pass could not count; they are missing from every table. */
  readonly skipped: number
  /** Files re-read by this pass; zero when every file was already current. */
  readonly parsed: number
  readonly elapsedMs: number
  /** The file cap or any row cap cut this answer. */
  readonly truncated: boolean
}

/** The engine's usage object, read structurally (the same reasoning as `models.ts`). */
export interface EngineUsage {
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly reasoningTokens?: number
  readonly cost?: {
    readonly input?: number
    readonly output?: number
    readonly cacheRead?: number
    readonly cacheWrite?: number
    readonly total?: number
  }
}

/** The two file entry kinds this index reads; every other entry type is ignored. */
interface UsageEntry {
  readonly type?: string
  readonly timestamp?: string
  readonly message?: {
    readonly usage?: EngineUsage
    readonly provider?: string
    readonly model?: string
  }
  readonly usage?: EngineUsage
  readonly provider?: string
  readonly model?: string
}

/** The calendar day an instant falls on, in this machine's local time. */
export function localDay(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** An empty index, as one shape so a rebuild and a first run cannot differ. */
export function emptyUsageIndex(): UsageIndex {
  return { version: USAGE_INDEX_VERSION, files: {} }
}

/** Empty counters, in `UsageCounters`' own column order. */
export function emptyCounters(): UsageCounters {
  return [0, 0, 0, 0, 0, 0, 0]
}

/** Adds one entry's usage to a row. */
function addUsage(target: UsageCounters, usage: EngineUsage): void {
  target[0] += usage.input ?? 0
  target[1] += usage.output ?? 0
  target[2] += usage.cacheRead ?? 0
  target[3] += usage.cacheWrite ?? 0
  target[4] += usage.reasoningTokens ?? 0
  const cost = usage.cost
  target[5] +=
    typeof cost?.total === 'number' && Number.isFinite(cost.total)
      ? cost.total
      : (cost?.input ?? 0) + (cost?.output ?? 0) + (cost?.cacheRead ?? 0) + (cost?.cacheWrite ?? 0)
  target[6] += 1
}

/** One row of a file's parse, before it is folded into that file's two row sets. */
interface ParsedRow {
  readonly atMs: number
  readonly day: string
  readonly modelKey: string
  readonly usage: EngineUsage
}

/** The provider/model an entry named, as one key; `\0` cannot occur in either. */
function modelKeyOf(entry: UsageEntry): string {
  const isMessage = entry.type === 'message'
  const provider = (isMessage ? entry.message?.provider : entry.provider) ?? ''
  const model = (isMessage ? entry.message?.model : entry.model) ?? ''
  return `${provider}\u0000${model}`
}

/** Reads one file's entries into the rows this index keeps for it. */
async function parseFile(
  sdk: SdkBundle,
  file: string,
  malformed: { count: number },
): Promise<IndexedFile | null> {
  // Stated before the bytes are read, never after: an append that lands during the read then leaves
  // the stored size behind the file's, so the next pass reads it again. The other order would record
  // a size the read never reached and lose that append for good.
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  const rows: ParsedRow[] = []
  try {
    await sdk.visitSessionEntries(
      file,
      (entry: FileEntry) => {
        const value = entry as UsageEntry
        // Only these two kinds carry usage, and they are mutually exclusive: a `message` entry is an
        // assistant turn in the transcript, a `model_usage` entry a call kept out of it (§4.5).
        const isMessage = value.type === 'message'
        if (!isMessage && value.type !== 'model_usage') return
        const usage = isMessage ? value.message?.usage : value.usage
        if (usage === undefined) return
        // An entry whose timestamp cannot be parsed has no day to belong to, and inventing one
        // would put tokens on a date they were not spent on (contract §4.5's bad-data rule).
        const atMs = value.timestamp === undefined ? Number.NaN : Date.parse(value.timestamp)
        if (!Number.isFinite(atMs)) {
          malformed.count += 1
          return
        }
        rows.push({ atMs, day: localDay(atMs), modelKey: modelKeyOf(value), usage })
      },
      { onMalformedRecord: () => (malformed.count += 1) },
    )
  } catch (error) {
    logLine(`usage index skipped ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }

  const models: Record<string, UsageCounters> = {}
  const days: Record<string, UsageCounters> = {}
  let firstMs = Number.POSITIVE_INFINITY
  let lastMs = Number.NEGATIVE_INFINITY
  for (const row of rows) {
    const modelRow = (models[row.modelKey] ??= emptyCounters())
    addUsage(modelRow, row.usage)
    const dayRow = (days[`${row.day}\u0000${row.modelKey}`] ??= emptyCounters())
    addUsage(dayRow, row.usage)
    firstMs = Math.min(firstMs, row.atMs)
    lastMs = Math.max(lastMs, row.atMs)
  }

  let daysTruncated = false
  const dayKeys = Object.keys(days)
  if (dayKeys.length > USAGE_FILE_DAY_ROWS_MAX) {
    // The row cap is a file's own day/model pairs: the earliest days go whole, so what survives is a
    // window of its recent history rather than a scattering of rows.
    daysTruncated = true
    dayKeys.sort()
    for (const key of dayKeys.slice(0, dayKeys.length - USAGE_FILE_DAY_ROWS_MAX)) delete days[key]
  }

  return {
    len: stat.size,
    mtimeMs: stat.mtimeMs,
    firstMs: Number.isFinite(firstMs) ? firstMs : 0,
    lastMs: Number.isFinite(lastMs) ? lastMs : 0,
    models,
    days,
    daysTruncated,
  }
}

/** One session file with the size and modification time the change check compares. */
interface SessionFileRef {
  readonly file: string
  readonly len: number
  readonly mtimeMs: number
}

/**
 * The files one read looks at, newest first: the cap keeps one request from walking a directory
 * that has grown without bound. A stat that fails drops the file, because a file that is gone has
 * nothing to count.
 */
function listedFiles(paths: HostPaths): { files: SessionFileRef[]; truncated: boolean } {
  const listed: SessionFileRef[] = []
  for (const file of listSessionFiles(paths)) {
    try {
      const stats = fs.statSync(file)
      if (stats.isFile()) listed.push({ file, len: stats.size, mtimeMs: stats.mtimeMs })
    } catch {
      continue
    }
  }
  listed.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return { files: listed.slice(0, USAGE_MAX_FILES), truncated: listed.length > USAGE_MAX_FILES }
}

/** Reads the persisted index, or an empty one when it is absent, unreadable, or another shape. */
function readIndex(indexFile: string): UsageIndex {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  } catch {
    return emptyUsageIndex()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyUsageIndex()
  const candidate = parsed as Partial<UsageIndex>
  if (candidate.version !== USAGE_INDEX_VERSION) return emptyUsageIndex()
  if (typeof candidate.files !== 'object' || candidate.files === null) return emptyUsageIndex()
  for (const entry of Object.values(candidate.files)) {
    if (typeof entry !== 'object' || entry === null) return emptyUsageIndex()
    const file = entry as Partial<IndexedFile>
    if (typeof file.len !== 'number' || typeof file.mtimeMs !== 'number') return emptyUsageIndex()
    if (typeof file.models !== 'object' || file.models === null) return emptyUsageIndex()
    if (typeof file.days !== 'object' || file.days === null) return emptyUsageIndex()
  }
  return candidate as UsageIndex
}

/** Writes the index whole and atomically: a torn write would be read as an absent index anyway. */
function writeIndex(indexFile: string, index: UsageIndex): void {
  const temporary = `${indexFile}.tmp`
  try {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify(index), 'utf8')
    fs.renameSync(temporary, indexFile)
  } catch (error) {
    logLine(`usage index not written: ${error instanceof Error ? error.message : String(error)}`)
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      // A leftover temporary is harmless: the next write replaces it.
    }
  }
}

/** The index this process holds for one data root, loaded on first use. */
let loaded: { readonly root: string; readonly index: UsageIndex } | null = null

/** The read already in flight for a data root, so two requests cost one pass. */
let pending: { readonly root: string; readonly read: Promise<UsageRefresh> } | null = null

/** One full read: what the store holds now, and which of it had to be parsed again. */
async function readStore(paths: HostPaths, sdk: SdkBundle): Promise<UsageRefresh> {
  const startedAt = performance.now()
  const root = paths.sessionDir
  const indexFile = paths.usageIndexFile
  if (loaded === null || loaded.root !== root) {
    loaded = { root, index: readIndex(indexFile) }
  }
  const index = loaded.index
  const listing = listedFiles(paths)
  const malformed = { count: 0 }
  let parsed = 0
  const files: Record<string, IndexedFile> = {}
  let sessions = 0

  await mapLimit(listing.files, USAGE_SCAN_CONCURRENCY, async entry => {
    const known = index.files[entry.file]
    if (known !== undefined && known.len === entry.len && known.mtimeMs === entry.mtimeMs) {
      files[entry.file] = known
      sessions += 1
      return
    }
    const fresh = await parseFile(sdk, entry.file, malformed)
    if (fresh === null) return
    // A file the parse could read but that holds no usage still counts as current: re-reading it
    // would answer the same nothing.
    files[entry.file] = fresh
    parsed += 1
    sessions += 1
  })

  index.files = files
  if (parsed > 0 || Object.keys(index.files).length !== Object.keys(files).length) {
    writeIndex(indexFile, index)
  }

  const daysTruncated = Object.values(files).some(file => file.daysTruncated)
  return {
    files: index.files,
    listed: listing.files.length,
    sessions,
    skipped: listing.files.length - sessions + malformed.count,
    parsed,
    elapsedMs: Math.round(performance.now() - startedAt),
    truncated: listing.truncated || daysTruncated,
  }
}

/**
 * This data root's index, brought up to date with the store.
 *
 * Concurrent callers share one pass: the usage page asks for the whole history and for a window at
 * the same time, and answering those from two walks of the same files would double the cost of the
 * one thing on this page that is expensive.
 */
export function refreshUsageIndex(paths: HostPaths, sdk: SdkBundle): Promise<UsageRefresh> {
  if (pending !== null && pending.root === paths.sessionDir) return pending.read
  const read = readStore(paths, sdk).finally(() => {
    if (pending !== null && pending.read === read) pending = null
  })
  pending = { root: paths.sessionDir, read }
  return read
}

/** Drops the in-memory index, so the next read starts from the file on disk (tests and resets). */
export function forgetUsageIndex(): void {
  loaded = null
  pending = null
}

/** The window's first day, for a range in days; `null` means the whole history. */
export function firstDayOfRange(rangeDays: number | null, nowMs: number): string | null {
  return rangeDays === null ? null : localDay(nowMs - rangeDays * DAY_MS)
}

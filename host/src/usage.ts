/**
 * `usage_summary`: token and cost totals over this application's own session files.
 *
 * The engine parses the session format, not this host: `usage-index.ts` streams one file at a time
 * and keeps nothing but counters, and this module only sums the rows it publishes. That is what
 * keeps memory flat across a history of any size and what makes the page cost a stat per file -
 * a file whose length and modification time are unchanged is never read again.
 *
 * Two entry kinds carry usage and they are mutually exclusive: a `message` entry (an assistant turn
 * recorded in the transcript) and a `model_usage` entry (a call kept out of the transcript, such as
 * a title generation). Counting both therefore counts every call once.
 *
 * A lifetime answer takes its totals, its model breakdown and its per-session rows from each file's
 * whole-history rows, so those figures are exact; its day tables come from the files' day rows,
 * which the published caps cut anyway. A window is whole local days: it starts at the first local
 * day the range reaches, so no day is counted by half. The billable token total is
 * `input + output + cacheRead + cacheWrite`; `reasoning` is a subset of `output`, published
 * separately and never added to or subtracted from anything (ruling C9).
 */

import * as path from 'node:path'

import {
  USAGE_DAY_MODEL_ROWS_MAX,
  USAGE_DAY_ROWS_MAX,
  USAGE_MODEL_ROWS_MAX,
  USAGE_RANGE_DAYS_MAX,
  USAGE_SESSION_ROWS_MAX,
} from './constants.ts'
import type { HostPaths } from './env.ts'
import { invalidInput } from './protocol/errors.ts'
import type { SdkBundle } from './sdk.ts'
import { sessionIdFor } from './store.ts'
import {
  emptyCounters,
  firstDayOfRange,
  refreshUsageIndex,
  type UsageCounters,
  type UsageRefresh,
} from './usage-index.ts'

/** One bucket set, in the order the payload publishes it. The frontend mirrors these field names. */
interface PublishedTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  costUsd: number
  calls: number
}

/** One model's published row; `provider`/`model` are null for calls the engine did not name. */
interface PublishedModelRow extends PublishedTotals {
  provider: string | null
  model: string | null
}

/** One day's published row, the day being `YYYY-MM-DD` in this machine's local time. */
interface PublishedDayRow extends PublishedTotals {
  day: string
}

/** One (day, model) published row: what the trend chart draws. */
interface PublishedDayModelRow extends PublishedDayRow {
  provider: string | null
  model: string | null
}

/** One session file's published row. */
interface PublishedSessionRow extends PublishedTotals {
  sessionId: string
  fileName: string
  firstActivityMs: number
  lastActivityMs: number
}

/** The page's whole payload. */
interface PublishedView {
  generatedAtMs: number
  rangeDays: number | null
  scanned: {
    files: number
    sessions: number
    skipped: number
    elapsedMs: number
    truncated: boolean
  }
  totals: PublishedTotals
  byModel: PublishedModelRow[]
  byDay: PublishedDayRow[]
  byDayModel: PublishedDayModelRow[]
  bySession: PublishedSessionRow[]
}

/** Adds one row's counters onto a running total, column by column. */
function addCounters(target: UsageCounters, source: UsageCounters): void {
  for (let index = 0; index < target.length; index += 1) {
    target[index] += source[index] as number
  }
}

/** One row's counters as the published buckets, which name each column. */
function totalsOf(counters: UsageCounters): PublishedTotals {
  return {
    input: counters[0],
    output: counters[1],
    cacheRead: counters[2],
    cacheWrite: counters[3],
    reasoning: counters[4],
    costUsd: counters[5],
    calls: counters[6],
  }
}

/** One model's bucket while the tables are built. */
interface ModelBucket {
  readonly provider: string | null
  readonly model: string | null
  readonly counters: UsageCounters
}

/** One (day, model) bucket while the tables are built. */
interface DayModelBucket {
  readonly day: string
  readonly provider: string | null
  readonly model: string | null
  readonly counters: UsageCounters
}

/** Splits a `provider\0model` or `day\0provider\0model` key back into its fields. */
function splitKey(key: string): string[] {
  return key.split('\u0000')
}

/** The three tables, each capped, plus the totals they were built from. */
function publish(refresh: UsageRefresh, rangeDays: number | null): PublishedView {
  const startDay = firstDayOfRange(rangeDays, Date.now())
  // The window's own first instant, so a session row's start is not earlier than the window it is in.
  const windowStartMs = startDay === null ? 0 : new Date(`${startDay}T00:00:00`).getTime()
  const totals = emptyCounters()
  const byModel = new Map<string, ModelBucket>()
  const byDay = new Map<string, UsageCounters>()
  const byDayModel = new Map<string, DayModelBucket>()
  const bySession: { file: string; firstMs: number; lastMs: number; counters: UsageCounters }[] = []

  const modelBucket = (provider: string | null, model: string | null): UsageCounters => {
    const key = `${provider ?? ''}\u0000${model ?? ''}`
    const existing = byModel.get(key)
    if (existing !== undefined) return existing.counters
    const created: ModelBucket = { provider, model, counters: emptyCounters() }
    byModel.set(key, created)
    return created.counters
  }
  const dayBucket = (day: string): UsageCounters => {
    const existing = byDay.get(day) ?? emptyCounters()
    byDay.set(day, existing)
    return existing
  }
  const dayModelBucket = (day: string, provider: string | null, model: string | null): UsageCounters => {
    const key = `${day}\u0000${provider ?? ''}\u0000${model ?? ''}`
    const existing = byDayModel.get(key)
    if (existing !== undefined) return existing.counters
    const created: DayModelBucket = { day, provider, model, counters: emptyCounters() }
    byDayModel.set(key, created)
    return created.counters
  }

  for (const [file, entry] of Object.entries(refresh.files)) {
    const session = emptyCounters()
    if (startDay === null) {
      // Lifetime: each model row is that file's whole history, so nothing here can be cut by a cap.
      for (const [key, counters] of Object.entries(entry.models)) {
        const [provider, model] = splitKey(key)
        addCounters(totals, counters)
        addCounters(modelBucket(provider ?? null, model ?? null), counters)
        addCounters(session, counters)
      }
    } else {
      for (const [key, counters] of Object.entries(entry.days)) {
        const [day, provider, model] = splitKey(key)
        if (day === undefined || day < startDay) continue
        addCounters(totals, counters)
        addCounters(modelBucket(provider ?? null, model ?? null), counters)
        addCounters(session, counters)
      }
    }
    if (session[6] > 0) {
      // A window's row starts where the window does: the file's own first activity may sit before it.
      const firstMs = startDay === null ? entry.firstMs : Math.max(entry.firstMs, windowStartMs)
      bySession.push({ file, firstMs, lastMs: entry.lastMs, counters: session })
    }
  }

  // The day tables read the day rows in both answers: a lifetime table is a window of the newest
  // `USAGE_DAY_ROWS_MAX` days by construction, and a range's days are its own.
  for (const entry of Object.values(refresh.files)) {
    for (const [key, counters] of Object.entries(entry.days)) {
      const [day, provider, model] = splitKey(key)
      if (day === undefined) continue
      if (startDay !== null && day < startDay) continue
      addCounters(dayBucket(day), counters)
      addCounters(dayModelBucket(day, provider ?? null, model ?? null), counters)
    }
  }

  const models: PublishedModelRow[] = [...byModel.values()]
    .sort((left, right) => {
      const difference = right.counters[0] + right.counters[1] - (left.counters[0] + left.counters[1])
      if (difference !== 0) return difference
      return `${left.provider ?? ''}/${left.model ?? ''}`.localeCompare(`${right.provider ?? ''}/${right.model ?? ''}`)
    })
    .slice(0, USAGE_MODEL_ROWS_MAX)
    .map(bucket => ({ provider: bucket.provider, model: bucket.model, ...totalsOf(bucket.counters) }))

  const days: PublishedDayRow[] = [...byDay.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    // The newest days are the ones a caller wants: the cap drops from the earliest end.
    .slice(-USAGE_DAY_ROWS_MAX)
    .map(([day, counters]) => ({ day, ...totalsOf(counters) }))

  // The day-by-model table, ordered the way a chart reads it: by day, heaviest series first inside
  // a day. The cap keeps the newest days, exactly like `byDay`.
  const dayModels: PublishedDayModelRow[] = [...byDayModel.values()]
    .sort((left, right) => {
      if (left.day !== right.day) return left.day < right.day ? -1 : 1
      return right.counters[0] + right.counters[1] - (left.counters[0] + left.counters[1])
    })
    .slice(-USAGE_DAY_MODEL_ROWS_MAX)
    .map(bucket => ({ day: bucket.day, provider: bucket.provider, model: bucket.model, ...totalsOf(bucket.counters) }))

  const sessions: PublishedSessionRow[] = bySession
    .sort((left, right) => right.lastMs - left.lastMs)
    .slice(0, USAGE_SESSION_ROWS_MAX)
    .map(bucket => ({
      sessionId: sessionIdFor(bucket.file),
      fileName: path.basename(bucket.file),
      firstActivityMs: bucket.firstMs,
      lastActivityMs: bucket.lastMs,
      ...totalsOf(bucket.counters),
    }))

  // One flag for "this answer is smaller than the history": the file cap and any of the three row
  // caps. It belongs under `scanned`, the only field the Rust DTO and the page read - a top-level
  // flag would silently drop rows (ruling C21).
  const truncated =
    refresh.truncated ||
    byModel.size > models.length ||
    byDay.size > days.length ||
    byDayModel.size > dayModels.length ||
    bySession.length > sessions.length

  return {
    generatedAtMs: Date.now(),
    rangeDays,
    scanned: {
      files: refresh.listed,
      sessions: refresh.sessions,
      skipped: refresh.skipped,
      elapsedMs: refresh.elapsedMs,
      truncated,
    },
    totals: totalsOf(totals),
    byModel: models,
    byDay: days,
    byDayModel: dayModels,
    bySession: sessions,
  }
}

/** Range in days: absent or `null` means the whole history. */
function rangeDaysField(value: unknown): number | null {
  if (value === undefined || value === null) return null
  const valid = typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= USAGE_RANGE_DAYS_MAX
  if (!valid) throw invalidInput(`rangeDays must be a positive integer of at most ${USAGE_RANGE_DAYS_MAX}.`)
  return value
}

/**
 * `usage_summary`: one read of the session store's usage index, published as the page's payload.
 *
 * A read re-examines every file's length and modification time and parses only the ones that moved,
 * so a page that re-renders, a range switch and a refresh all cost a stat per file rather than a
 * pass over the history; `refresh` therefore asks for nothing a plain read does not already do and
 * is accepted only as a field the caller may still send.
 */
export async function summary(
  paths: HostPaths,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rangeDays = rangeDaysField(frame.rangeDays)
  const refresh = await refreshUsageIndex(paths, sdk)
  return publish(refresh, rangeDays) as unknown as Record<string, unknown>
}

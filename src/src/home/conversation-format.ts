/**
 * The small pure conversions the conversation rows need: a millisecond span into something
 * readable, and a tool call's arguments into a one-line summary.
 *
 * Nothing here reads state or reaches the engine; it is the formatting half of the transcript, kept
 * apart so the components stay about layout. A unified diff's rows are not here: they are the diff
 * card's own shape (`components/agents/diff-lines.ts`).
 */

import type { ToolMinimized } from "@/api/session-types"
import { formatBytes } from "../lib/bytes.ts"

/** A span the way a tool row reports it: milliseconds under a second, seconds under a minute. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

/**
 * `git 120.4KB → 3.2KB`: the minimizer filter that ran and the bytes it took the output from and to.
 *
 * A label the engine reported empty takes no leading space: the byte counts are the part that must
 * always read.
 */
export function formatMinimized(minimized: ToolMinimized): string {
  const sizes = `${formatBytes(minimized.inputBytes)} → ${formatBytes(minimized.outputBytes)}`
  const filter = minimized.filter.trim()
  return filter === "" ? sizes : `${filter} ${sizes}`
}

/** `HH:MM` on the reader's own clock. */
export function formatClock(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** The words one relative-time bucket reads as, one entry per bucket. */
export interface RelativeTimeCopy {
  now: string
  minutes: (n: number) => string
  hours: (n: number) => string
  days: (n: number) => string
  months: (n: number) => string
  years: (n: number) => string
}

/**
 * How long ago something happened, in the same buckets the desktop app uses.
 *
 * The buckets live here and the words live in the copy, so two surfaces naming the same conversation
 * cannot disagree about it. `now` is a parameter rather than read here: the caller decides when the
 * clock was taken, which keeps the render pure.
 */
export function formatRelativeTime(at: number, now: number, copy: RelativeTimeCopy): string {
  const MINUTE = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const diff = Math.max(0, now - at)
  if (diff < MINUTE) return copy.now
  if (diff < HOUR) return copy.minutes(Math.floor(diff / MINUTE))
  if (diff < DAY) return copy.hours(Math.floor(diff / HOUR))
  if (diff < 30 * DAY) return copy.days(Math.floor(diff / DAY))
  if (diff < 365 * DAY) return copy.months(Math.floor(diff / (30 * DAY)))
  return copy.years(Math.floor(diff / (365 * DAY)))
}

/** The argument fields worth putting on a tool row, in the order they are tried. */
const SUMMARY_KEYS = [
  'command',
  'path',
  'file_path',
  'filePath',
  'query',
  // A `task` call is described by what it was asked to do, not by the agent type it ran as: its
  // arguments are `{agent, prompt}`, and neither field is the reader's own sentence otherwise.
  'prompt',
  'task',
  'pattern',
  'url',
  'description',
  'name',
  'id',
]

/**
 * One line describing what a call is doing.
 *
 * The arguments arrive as the engine's own text, which is usually JSON and occasionally truncated
 * mid-token while the call is still streaming — so an unparseable payload falls back to its first
 * non-empty line rather than being reported as an error.
 */
export function summarizeToolArgs(argsText: string, limit = 96): string {
  const trimmed = argsText.trim()
  if (!trimmed) return ''
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      for (const key of SUMMARY_KEYS) {
        const value = record[key]
        if (typeof value === 'string' && value.trim()) return clamp(value.trim(), limit)
        if (Array.isArray(value) && value.length > 0) {
          return clamp(value.map((item) => String(item)).join(', '), limit)
        }
      }
    }
  } catch {
    // Mid-stream JSON: the first line is the best available summary.
  }
  const firstLine = trimmed.split('\n').find((line) => line.trim()) ?? ''
  return clamp(firstLine.trim(), limit)
}

function clamp(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

/**
 * A paragraph as the one line an annotation can hold, cut at `limit`.
 *
 * The engine's own terminal draws the idle recap with the same bargain (`previewLine(reply,
 * TRUNCATE_LENGTHS.RECAP)`, 280 columns): the recap is the first sentence of a summary, and the
 * summary stays whole in the engine's history database. Newlines and runs of spaces collapse first,
 * because a recap that broke into a paragraph would push the work it describes off screen.
 */
export function oneLinePreview(text: string, limit = 280): string {
  const line = text.replace(/\s+/g, " ").trim()
  if (line.length <= limit) return line
  return `${line.slice(0, limit - 1).trimEnd()}…`
}

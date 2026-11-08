import type {
  EngineUsageDayModelRow,
  EngineUsageDayRow,
  EngineUsageModelRow,
  EngineUsageSessionRow,
  EngineUsageTotals,
} from '@/api/capabilities-types'

/**
 * The derived shapes the usage page draws.
 *
 * Everything here is pure arithmetic over one host answer: the host owns what a token is (the
 * engine's own accounting) and this module only decides how the page reads it — which day was the
 * busiest, how a run of active days is counted, how many models fit in the list. Nothing here reads
 * a file, caches, or knows about React, so the page and its grid are both composed from it.
 */

/**
 * The tokens one bucket counts: the engine's billable buckets.
 *
 * `reasoning` is not added: it is a subset of `output` (`host/src/usage.ts` states the same rule,
 * and the providers fold thinking tokens into completion tokens — `pi-ai`'s Google mapping is
 * `output: candidates + thinking`), so summing it would count the same tokens twice.
 */
export function tokensOf(totals: EngineUsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite
}

/** One day, with what was counted on it. */
export interface DayPoint {
  readonly day: string
  readonly tokens: number
}

/** The most active day of a table, or null when nothing was counted. */
export function busiestDay(byDay: readonly EngineUsageDayRow[]): DayPoint | null {
  let best: DayPoint | null = null
  for (const row of byDay) {
    const tokens = tokensOf(row)
    if (best === null || tokens > best.tokens) {
      best = { day: row.day, tokens }
    }
  }
  return best === null || best.tokens === 0 ? null : best
}

/** The longest wall-clock span one session's entries cover, or 0 when none carries both ends. */
export function longestSessionMs(bySession: readonly EngineUsageSessionRow[]): number {
  let longest = 0
  for (const row of bySession) {
    if (row.firstActivityMs === null || row.lastActivityMs === null) continue
    longest = Math.max(longest, row.lastActivityMs - row.firstActivityMs)
  }
  return longest
}

/**
 * Runs of consecutive active days, as the strip reports them: the longest run in the table, and the
 * run the newest active day ends. Both count calendar days, and a day with no entry breaks a run —
 * which is why the table has to be dense enough to contain every day of the run (`byDay` drops the
 * earliest days first when it is capped, so a shortened history can shorten a streak).
 */
export function streaks(
  byDay: readonly EngineUsageDayRow[],
  today: Date,
): { current: number; longest: number } {
  const active = byDay
    .filter((row) => tokensOf(row) > 0)
    .map((row) => row.day)
    .sort()
  if (active.length === 0) {
    return { current: 0, longest: 0 }
  }
  let longest = 1
  let run = 1
  for (let index = 1; index < active.length; index += 1) {
    run = isNextDay(active[index - 1], active[index]) ? run + 1 : 1
    longest = Math.max(longest, run)
  }
  // The current streak is the run the last active day ends, and only while that day is today or
  // yesterday: a history that stopped a week ago has no streak now, however long it once ran.
  const last = active[active.length - 1]
  const todayKey = localDayKey(today)
  const current = last === todayKey || isNextDay(last, todayKey) ? run : 0
  return { current, longest }
}

/** The calendar key of one instant in this machine's local time, `YYYY-MM-DD`. */
function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * What today has counted so far, from the same day table the strip's other figures read: a day the
 * table does not carry yet has counted nothing, so the answer is zero rather than a hole. The cap
 * keeps the newest days, so a shortened history still holds today.
 */
export function todayTokens(byDay: readonly EngineUsageDayRow[], today: Date): number {
  const key = localDayKey(today)
  for (const row of byDay) {
    if (row.day === key) {
      return tokensOf(row)
    }
  }
  return 0
}

/** True when `right` is the calendar day after `left`. */
function isNextDay(left: string, right: string): boolean {
  const date = new Date(`${left}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) {
    return false
  }
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10) === right
}

/** One cell of the activity grid: a date and how it ranks, or a hole past the end of the window. */
export interface HeatCell {
  readonly date: string | null
  /** 0 for a day with nothing, 1..4 for a day's tokens against the busiest one. */
  readonly level: number
}

/** Four steps between "nothing" and the busiest day, the reference grid's own ladder. */
function levelFor(value: number, busiest: number): number {
  if (value <= 0 || busiest <= 0) {
    return 0
  }
  return Math.min(4, Math.max(1, Math.ceil((value / busiest) * 4)))
}

/**
 * The activity grid, flattened to the order the grid draws in: columns of seven days, oldest column
 * first, ending on the week that contains `today` (weeks start on Sunday). Cells past `today` are
 * holes rather than zeros — the window has not happened yet.
 */
export function heatmapCells(
  byDay: readonly EngineUsageDayRow[],
  weeks: number,
  today: Date,
): readonly HeatCell[] {
  const counted: Record<string, number> = {}
  let busiest = 0
  for (const row of byDay) {
    const tokens = tokensOf(row)
    counted[row.day] = tokens
    busiest = Math.max(busiest, tokens)
  }
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const lastStart = new Date(end)
  lastStart.setDate(lastStart.getDate() - lastStart.getDay())
  const first = new Date(lastStart)
  first.setDate(first.getDate() - (weeks - 1) * 7)

  const cells: HeatCell[] = []
  for (let at = 0; at < weeks; at += 1) {
    for (let offset = 0; offset < 7; offset += 1) {
      const day = new Date(first)
      day.setDate(day.getDate() + at * 7 + offset)
      if (day > end) {
        cells.push({ date: null, level: 0 })
        continue
      }
      const key = localDayKey(day)
      cells.push({ date: key, level: levelFor(counted[key] ?? 0, busiest) })
    }
  }
  return cells
}

/** Where one month begins in the activity grid: the column its label sits over, and the month. */
export interface HeatMonth {
  readonly column: number
  readonly month: number
}

/**
 * How many columns apart two month labels must be. A column is twelve pixels wide, so a month that
 * starts less than three columns after the previous label would print on top of it.
 */
const MONTH_LABEL_COLUMNS = 3

/**
 * The grid's month axis, one entry per month the window touches: a label sits over the column the
 * month's first day falls in, which is how a reader counts the columns back to a month. The window
 * opens mid-month, so its first label is the month it opens in; when the next month starts in that
 * same column the opening label yields, because a month of one column is not a span worth naming
 * and the label that follows would otherwise land on top of it.
 */
export function heatmapMonths(cells: readonly HeatCell[]): readonly HeatMonth[] {
  const months: HeatMonth[] = []
  let previous = -1
  for (let index = 0; index < cells.length; index += 1) {
    const date = cells[index].date
    if (date === null) {
      continue
    }
    const month = Number(date.slice(5, 7))
    if (month === previous) {
      continue
    }
    previous = month
    const column = Math.floor(index / 7)
    const last = months[months.length - 1]
    if (last !== undefined && column - last.column < MONTH_LABEL_COLUMNS) {
      months.pop()
    }
    months.push({ column, month })
  }
  return months
}

/** The window's days, oldest first, as `YYYY-MM-DD` in this machine's local time. */
export function windowDays(rangeDays: number, today: Date): readonly string[] {
  const days: string[] = []
  for (let back = rangeDays - 1; back >= 0; back -= 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    day.setDate(day.getDate() - back)
    days.push(localDayKey(day))
  }
  return days
}

/** One bar of the trend chart: a day of the window and its height against the busiest one. */
export interface TrendBar {
  readonly day: string
  readonly tokens: number
  /** Percentage of the chart's height; 0 for a day with nothing. */
  readonly height: number
}

/**
 * The window's bars, one per day in it.
 *
 * The axis is the window itself rather than the days that happen to have entries, so a quiet day
 * shows as an empty slot instead of disappearing and squeezing its neighbours together.
 */
export function trendBars(
  byDay: readonly EngineUsageDayRow[],
  days: readonly string[],
): readonly TrendBar[] {
  const counted: Record<string, number> = {}
  for (const row of byDay) {
    counted[row.day] = tokensOf(row)
  }
  const values = days.map((day) => counted[day] ?? 0)
  const busiest = values.reduce((max, value) => Math.max(max, value), 0)
  return days.map((day, at) => ({
    day,
    tokens: values[at],
    height: busiest <= 0 ? 0 : (values[at] / busiest) * 100,
  }))
}

/** One row of the model breakdown: a model, its tokens, and its share of the window. */
export interface ModelRow {
  readonly key: string
  /** `provider/model`, or the copy's own name for the folded tail of the ranking. */
  readonly label: string
  readonly tokens: number
  readonly share: number
}

/** How the list names one entry: `provider/model`, or the bare half it has. */
function modelLabel(row: EngineUsageModelRow): string {
  if (row.provider === null && row.model === null) {
    return 'unknown'
  }
  return `${row.provider ?? ''}/${row.model ?? ''}`
}

/**
 * The window's models, heaviest first, capped at `limit` with the tail folded into one row.
 *
 * The cap is this page's own: the host answers with every model the history holds, and a card of
 * dozens of hairline bars states nothing. Folding the tail keeps the shares adding up to the whole
 * instead of pretending the missing models spent nothing.
 */
export function modelRows(
  byModel: readonly EngineUsageModelRow[],
  limit: number,
  othersLabel: string,
): readonly ModelRow[] {
  const ranked = byModel
    .filter((row) => tokensOf(row) > 0)
    .sort((left, right) => tokensOf(right) - tokensOf(left))
  const total = ranked.reduce((sum, row) => sum + tokensOf(row), 0)
  if (total === 0) {
    return []
  }
  const rows: ModelRow[] = ranked.slice(0, limit).map((row) => ({
    key: `${row.provider ?? ''}/${row.model ?? ''}`,
    label: modelLabel(row),
    tokens: tokensOf(row),
    share: tokensOf(row) / total,
  }))
  const tail = ranked.slice(limit)
  if (tail.length > 0) {
    const tokens = tail.reduce((sum, row) => sum + tokensOf(row), 0)
    rows.push({ key: 'others', label: othersLabel, tokens, share: tokens / total })
  }
  return rows
}

/** One model's part of one day, as the activity grid's tooltip lists it. */
export interface DayModelRow {
  readonly key: string
  readonly label: string
  readonly tokens: number
}

/**
 * The models that wrote one day's tokens, heaviest first, capped at `limit` with the tail folded
 * into one row — the same shape the breakdown card uses, for a card a reader opens one day at a
 * time.
 */
export function dayModelRows(
  byDayModel: readonly EngineUsageDayModelRow[],
  day: string,
  limit: number,
  othersLabel: string,
): readonly DayModelRow[] {
  const ranked = byDayModel
    .filter((row) => row.day === day && tokensOf(row) > 0)
    .sort((left, right) => tokensOf(right) - tokensOf(left))
  const rows: DayModelRow[] = ranked.slice(0, limit).map((row) => ({
    key: `${row.provider ?? ''}/${row.model ?? ''}`,
    label: modelLabel(row),
    tokens: tokensOf(row),
  }))
  const tail = ranked.slice(limit)
  if (tail.length > 0) {
    rows.push({
      key: 'others',
      label: othersLabel,
      tokens: tail.reduce((sum, row) => sum + tokensOf(row), 0),
    })
  }
  return rows
}

import type { Language } from '@/lib/i18n'

/**
 * "Updated at" wording for the memory viewer's file rows.
 *
 * The rules are the reference page's (`src/utils/memoryUpdatedAt.ts`), kept whole because they are
 * what the row's second line reads like at every distance: under a minute is `刚刚`, under half an
 * hour counts minutes, the current day and the day before print a clock time, anything inside the
 * current (Monday-first) week prints a weekday and a clock time, and everything older prints a date
 * with the clock time — plus a year when the file is not from this year.
 *
 * The one difference from the reference is the missing timestamp: that page says `刚刚` for a file
 * the platform would not date, and this one prints a dash, because "just now" is a claim the engine
 * never made.
 *
 * The words come in as `copy`, so the ladder itself is language-agnostic; the clock and date shapes
 * are the platform's (`Intl`), which is why the language is a second argument.
 */
export interface MemoryUpdatedCopy {
  justNow: string
  minutesAgo: (count: number) => string
  today: (time: string) => string
  yesterday: (time: string) => string
  weekday: (weekday: string, time: string) => string
  /** Chinese weekdays are written 周一…周日, so the day name itself is a word rather than a format. */
  weekdayZh: (weekday: string) => string
  date: (date: string, time: string) => string
  monthDay: (month: number, day: number) => string
  yearMonthDay: (year: number, month: number, day: number) => string
}

const MINUTE_MS = 60_000
/** Distances past this many minutes stop counting and start naming a day. */
const RELATIVE_MINUTES_LIMIT = 30

const LOCALES: Readonly<Record<Language, string>> = { en: 'en-US', zh: 'zh-CN' }
const WEEKDAY_ZH = '日一二三四五六'

/** What the row says when the host reported no modification time for the file. */
const NO_MODIFIED_TIME = '—'

type FormatterKind = 'time' | 'weekday' | 'monthDay' | 'yearMonthDay'

const SHAPE_OPTIONS: Readonly<Record<FormatterKind, Intl.DateTimeFormatOptions>> = {
  // The reference prints a 24-hour clock in both languages.
  time: { hour: '2-digit', hourCycle: 'h23', minute: '2-digit' },
  weekday: { weekday: 'short' },
  monthDay: { day: 'numeric', month: 'short' },
  yearMonthDay: { day: 'numeric', month: 'short', year: 'numeric' },
}

/**
 * One formatter per (language, kind). Creating an `Intl.DateTimeFormat` is by far the expensive part
 * of formatting a timestamp, and a file list renders one row per file on every clock tick, so the
 * table is built once and reused.
 */
const formatters: Record<Language, Partial<Record<FormatterKind, Intl.DateTimeFormat>>> = {
  en: {},
  zh: {},
}

function formatter(language: Language, kind: FormatterKind): Intl.DateTimeFormat {
  const cached = formatters[language][kind]
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat(LOCALES[language], SHAPE_OPTIONS[kind])
  formatters[language][kind] = created
  return created
}

/** Local midnight of the day a timestamp falls in. */
function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function weekdayText(timestamp: number, language: Language, copy: MemoryUpdatedCopy): string {
  if (language === 'zh') {
    return copy.weekdayZh(WEEKDAY_ZH.charAt(new Date(timestamp).getDay()))
  }
  return formatter(language, 'weekday').format(timestamp)
}

function dateText(
  timestamp: number,
  language: Language,
  includeYear: boolean,
  copy: MemoryUpdatedCopy,
): string {
  const date = new Date(timestamp)
  if (language === 'zh') {
    const year = date.getFullYear()
    const month = date.getMonth() + 1
    const day = date.getDate()
    return includeYear ? copy.yearMonthDay(year, month, day) : copy.monthDay(month, day)
  }
  return formatter(language, includeYear ? 'yearMonthDay' : 'monthDay').format(timestamp)
}

/**
 * One file row's timestamp line.
 *
 * `now` is passed in rather than read here so a list renders every row against the same clock, and
 * so the section's own tick is the one thing that decides when the wording moves on.
 */
export function formatMemoryUpdatedAt(
  copy: MemoryUpdatedCopy,
  language: Language,
  now: number,
  modifiedAtMs: number | null,
): string {
  if (modifiedAtMs === null || !Number.isFinite(modifiedAtMs)) {
    return NO_MODIFIED_TIME
  }
  const elapsedMs = now - modifiedAtMs
  if (elapsedMs < MINUTE_MS) {
    return copy.justNow
  }
  const elapsedMinutes = Math.floor(elapsedMs / MINUTE_MS)
  if (elapsedMinutes < RELATIVE_MINUTES_LIMIT) {
    return copy.minutesAgo(elapsedMinutes)
  }

  const todayStart = startOfLocalDay(now)
  const updatedDayStart = startOfLocalDay(modifiedAtMs)
  const time = formatter(language, 'time').format(modifiedAtMs)
  if (updatedDayStart === todayStart) {
    return copy.today(time)
  }
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(yesterdayStart.getDate() - 1)
  if (updatedDayStart === yesterdayStart.getTime()) {
    return copy.yesterday(time)
  }

  const today = new Date(todayStart)
  const weekStart = new Date(todayStart)
  // Monday-first, matching the reference's week.
  weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  if (updatedDayStart >= weekStart.getTime()) {
    return copy.weekday(weekdayText(modifiedAtMs, language, copy), time)
  }

  const includeYear = new Date(modifiedAtMs).getFullYear() !== today.getFullYear()
  return copy.date(dateText(modifiedAtMs, language, includeYear, copy), time)
}

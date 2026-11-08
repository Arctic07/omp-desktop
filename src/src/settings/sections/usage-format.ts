import type { Language } from '@/lib/i18n'

/**
 * Number, date and duration formatting for the usage page.
 *
 * It sits beside the section because the page and its grid both print engine-reported numbers for
 * the reader, and the same value has to read the same way in the strip, in a cell's tooltip and in
 * a model row.
 *
 * `Intl` is the only formatter used: tokens are compact the way the reference page prints them —
 * `notation: "compact"`, so a Chinese reader sees 万/亿 and an English one K/M — and a share is a
 * percentage with the digits its size deserves. Instances are cached per language and shape, because
 * one render formats hundreds of cells and constructing an `Intl` instance is by far the expensive
 * part of formatting one. The cache is a fixed table — two languages times the shapes below — filled
 * on first use, so it cannot grow with the data.
 */

/** Copy languages to locales; the app ships exactly these two. */
const LOCALES: Readonly<Record<Language, string>> = { en: 'en-US', zh: 'zh-CN' }

/** Digit policy of every number this page prints. The shape is the contract, not the call site. */
type NumberShape = 'count' | 'compact' | 'percent' | 'percent-fine'

const SHAPE_OPTIONS: Readonly<Record<NumberShape, Intl.NumberFormatOptions>> = {
  count: { maximumFractionDigits: 0 },
  compact: { notation: 'compact', maximumFractionDigits: 1 },
  percent: { style: 'percent', maximumFractionDigits: 0 },
  'percent-fine': { style: 'percent', maximumFractionDigits: 1 },
}

const NUMBER_FORMATS: Record<Language, Partial<Record<NumberShape, Intl.NumberFormat>>> = {
  en: {},
  zh: {},
}

/** Date policy of the same two axes: a calendar day, and a month of the grid's own axis. */
type DateShape = 'day' | 'month'

const DATE_OPTIONS: Readonly<Record<DateShape, Intl.DateTimeFormatOptions>> = {
  day: { timeZone: 'UTC', month: 'short', day: 'numeric' },
  month: { timeZone: 'UTC', month: 'short' },
}

const DATE_FORMATS: Record<Language, Partial<Record<DateShape, Intl.DateTimeFormat>>> = {
  en: {},
  zh: {},
}

function numberFormat(language: Language, shape: NumberShape): Intl.NumberFormat {
  const cached = NUMBER_FORMATS[language][shape]
  if (cached !== undefined) {
    return cached
  }
  const created = new Intl.NumberFormat(LOCALES[language], SHAPE_OPTIONS[shape])
  NUMBER_FORMATS[language][shape] = created
  return created
}

function dateFormat(language: Language, shape: DateShape): Intl.DateTimeFormat {
  const cached = DATE_FORMATS[language][shape]
  if (cached !== undefined) {
    return cached
  }
  const created = new Intl.DateTimeFormat(LOCALES[language], DATE_OPTIONS[shape])
  DATE_FORMATS[language][shape] = created
  return created
}

/** JSON cannot carry `NaN`, but a value this page did not expect must not take it down. */
function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

/** A token count as the page prints it: `517`, `12.4K`, `184.6M` — and `1.2 万` in Chinese. */
export function formatTokens(value: number, language: Language): string {
  const count = finite(value)
  if (Math.abs(count) < 1_000) {
    return numberFormat(language, 'count').format(count)
  }
  const compact = numberFormat(language, 'compact').format(count)
  // Chinese compact notation writes the unit straight after the digits, so a space goes back in
  // before 万/亿 to keep the strip's cells alike.
  return language === 'zh' ? compact.replace(/(?<=\d)(?=[万亿])/u, ' ') : compact
}

/** A share of the window's tokens: `42%`, or `4.2%` when it is that small. */
export function formatShare(share: number, language: Language): string {
  const value = finite(share)
  return numberFormat(language, Math.abs(value) >= 0.1 ? 'percent' : 'percent-fine').format(value)
}

/**
 * A session's own length in one compact token per unit: `2d21h42m`. A strip cell is one line wide,
 * and three spelled-out units (`2 天 21 小时 42 分钟`) wrap inside it, so the units are Latin
 * letters in both languages and sit flush against their numbers.
 *
 * The leading units are dropped when they are zero, and a length under a minute still says `0m`, so
 * the cell is never empty.
 */
export function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(finite(milliseconds) / 60_000))
  const days = Math.floor(minutes / (24 * 60))
  const hours = Math.floor((minutes % (24 * 60)) / 60)
  const rest = minutes % 60
  let text = ''
  if (days > 0) text += `${days}d`
  if (hours > 0) text += `${hours}h`
  if (rest > 0 || text === '') text += `${rest}m`
  return text
}

/** A run of active days, as the strip prints it: `12d` / `12 天`. */
export function formatDayCount(value: number, language: Language): string {
  const count = finite(value)
  return language === 'zh' ? `${count} 天` : `${count}d`
}

/** A month of the activity grid's axis: `Sep` / `9月`. */
export function formatMonthLabel(month: number, language: Language): string {
  return dateFormat(language, 'month').format(new Date(Date.UTC(2020, month - 1, 1)))
}

/** A local calendar date as the chart's axis labels it: `Sep 12` / `9月12日`. */
export function formatDayLabel(dayKey: string, language: Language): string {
  const date = new Date(`${dayKey}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) {
    return dayKey
  }
  return dateFormat(language, 'day').format(date)
}

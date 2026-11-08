import { useEffect, useMemo, useRef, useState } from 'react'

import type { EngineUsageDayRow } from '@/api/capabilities-types'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { useCopy, useLanguage, type Language, type Localized } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  SettingsCard,
  SettingsChoice,
  SettingsEmpty,
  SettingsGroup,
  SettingsLoadState,
  SettingsRow,
  SettingsStats,
} from '@/settings/parts'
import {
  formatDayCount,
  formatDayLabel,
  formatDuration,
  formatMonthLabel,
  formatShare,
  formatTokens,
} from '@/settings/sections/usage-format'
import {
  busiestDay,
  dayModelRows,
  heatmapCells,
  heatmapMonths,
  longestSessionMs,
  modelRows,
  streaks,
  tokensOf,
  todayTokens,
  trendBars,
  windowDays,
  type DayModelRow,
} from '@/settings/sections/usage-series'
import { useResourceState } from '@/state/resource'
import { lifetimeResource, readUsage, refreshUsage, windowResource } from '@/state/usage-store'

/**
 * The desktop app's usage page: the strip's lifetime and today figures, the activity grid, the
 * window control and the window's two charts.
 *
 * Every figure on it is arithmetic over what the host scanned in the session history — the engine's
 * own accounting, a day at a time — so nothing here pretends to know something the host has not
 * answered. Two answers are read: all history for the strip and the grid (a lifetime figure only
 * means something over everything), and the selected window for the two charts. The labels and the
 * sentences are `usageCopy.ts` verbatim; the chart-shaped blocks are drawn as plain grids and bars
 * over the same figures.
 */

/** `usageCopy.ts`'s wording, the part this page shows, in both languages. */
interface UsageCopy {
  loadFailed: string
  retry: string
  loading: string
  tokenUnit: string
  rangeTitle: string
  rangeLabels: Readonly<Record<7 | 30, string>>
  refresh: string
  refreshing: string
  lifetimeTotalTokens: string
  todayTokens: string
  longestSession: string
  currentStreak: string
  longestStreak: string
  /** What one day's call count is labelled with in the grid's tooltip. */
  heatmapCalls: string
  /** The grid's tooltip for a day nothing was counted on. */
  heatmapNoUsage: string
  heatmapTitle: string
  heatmapDescription: (day: string, tokens: string) => string
  heatmapLess: string
  heatmapMore: string
  dailyChartTitle: string
  dailyChartDescription: (days: number) => string
  modelChartTitle: string
  modelChartDescription: (model: string, share: string) => string
  otherModels: string
  emptyTitle: string
  empty: string
  truncated: string
}

const COPY: Localized<UsageCopy> = {
  en: {
    loadFailed: 'Could not read the usage history.',
    retry: 'Retry',
    loading: 'Reading the local session history…',
    tokenUnit: 'tokens',
    rangeTitle: 'Time range',
    rangeLabels: { 7: 'Last 7 days', 30: 'Last 30 days' },
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    lifetimeTotalTokens: 'Total tokens',
    todayTokens: "Today's tokens",
    longestSession: 'Longest session',
    currentStreak: 'Current streak',
    longestStreak: 'Longest streak',
    heatmapCalls: 'calls',
    heatmapNoUsage: 'No usage that day.',
    heatmapTitle: 'Token activity',
    heatmapDescription: (day, tokens) => `Most active day is ${day}, about ${tokens} tokens.`,
    heatmapLess: 'Less',
    heatmapMore: 'More',
    dailyChartTitle: 'Daily token trend',
    dailyChartDescription: (days) => `Token usage by day, ${days} days in total.`,
    modelChartTitle: 'Model usage',
    modelChartDescription: (model, share) => `${model} has the largest share right now, about ${share}.`,
    otherModels: 'Others',
    emptyTitle: 'Nothing to show yet',
    empty: 'No usage data in this range.',
    truncated: 'The host capped this answer: the numbers cover the most recent data only.',
  },
  zh: {
    loadFailed: '无法读取用量历史。',
    retry: '重试',
    loading: '正在读取本地应用会话历史，可能需要一点时间。',
    tokenUnit: 'tokens',
    rangeTitle: '时间范围',
    rangeLabels: { 7: '近 7 日', 30: '近 30 日' },
    refresh: '刷新',
    refreshing: '刷新中…',
    lifetimeTotalTokens: '累计 Token 数',
    todayTokens: '今日 Token 数',
    longestSession: '最长聊天时长',
    currentStreak: '当前连续天数',
    longestStreak: '最长连续天数',
    heatmapCalls: '次调用',
    heatmapNoUsage: '当日无用量。',
    heatmapTitle: 'Token 活动',
    heatmapDescription: (day, tokens) => `最活跃日期是 ${day}，约 ${tokens} Tokens。`,
    heatmapLess: '少',
    heatmapMore: '多',
    dailyChartTitle: '每日 Token 趋势图',
    dailyChartDescription: (days) => `按天展示 Token 用量变化，共 ${days} 天。`,
    modelChartTitle: '模型用量',
    modelChartDescription: (model, share) => `${model} 当前占比最高，约 ${share}。`,
    otherModels: '其他',
    emptyTitle: '还没有可展示的数据',
    empty: '当前区间暂无可展示的用量数据。',
    truncated: '宿主已按下限裁剪：以下数字只覆盖最近的数据。',
  },
}

/** What a cell reads while the host has answered nothing yet. */
const NO_VALUE = '--'

/** The grid's own width: a year is 53 weeks, the reference's own. */
const HEATMAP_WEEKS = 53

/**
 * The grid's column template: one nine-pixel day per column, three pixels between them. The month
 * axis reuses it, so a label starts exactly over the cell it names.
 */
const HEAT_GRID_COLUMNS = `repeat(${HEATMAP_WEEKS}, 9px)`

/** The five levels the grid's legend names, from the empty cell to the busiest one. */
const HEAT_LEVELS = [
  'bg-muted',
  'bg-foreground/15',
  'bg-foreground/30',
  'bg-foreground/55',
  'bg-foreground/80',
] as const

/**
 * One cell's classes, computed once per level: the grid re-renders on every pointer move across it,
 * and resolving hundreds of class strings per frame is what makes that drag. The hover ring is the
 * only feedback a nine-pixel square can give for which day is being read.
 */
const HEAT_CELL_CLASSES = HEAT_LEVELS.map((level) =>
  cn('size-[9px] rounded-[2px] hover:ring-1 hover:ring-foreground/50', level),
)

/** How many models the breakdown names before the rest is folded into one row. */
const MODEL_ROWS = 6

/** How many models one day's tooltip names before the rest is folded into one row. */
const DAY_DETAIL_MODELS = 4

/**
 * What a grid cell opens: the date, what that day spent, and which models spent it.
 *
 * The grid itself carries no text — a year of cells is a picture — so the card is where a day is
 * read. It stays a card rather than a sentence because the models are what the day is made of, and
 * a reader comparing two days compares those rows.
 */
function DayDetail({
  day,
  tokens,
  calls,
  models,
  language,
  copy,
}: {
  day: string
  tokens: number
  calls: number
  models: readonly DayModelRow[]
  language: Language
  copy: UsageCopy
}) {
  return (
    <span className="flex flex-col gap-1">
      <span className="font-medium">{day}</span>
      {tokens === 0 ? (
        <span className="font-normal text-muted-foreground">{copy.heatmapNoUsage}</span>
      ) : (
        <span className="font-normal text-muted-foreground">
          {formatTokens(tokens, language)} {copy.tokenUnit}
          {calls === 0 ? null : ` · ${formatTokens(calls, language)} ${copy.heatmapCalls}`}
        </span>
      )}
      {models.length === 0 ? null : (
        <span className="flex flex-col gap-0.5 border-t border-border/60 pt-1">
          {models.map((model) => (
            <span key={model.key} className="flex items-baseline justify-between gap-3 font-normal">
              <span className="min-w-0 truncate text-muted-foreground">{model.label}</span>
              <span className="shrink-0 tabular-nums">{formatTokens(model.tokens, language)}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

/** The two windows the control offers: the chip's own value, and the days it stands for. */
type RangeKey = '7' | '30'

const RANGE_KEYS: readonly RangeKey[] = ['7', '30']

const RANGE_DAYS: Readonly<Record<RangeKey, 7 | 30>> = { '7': 7, '30': 30 }

export default function UsageSection() {
  const copy = useCopy(COPY)
  const { language } = useLanguage()
  const [range, setRange] = useState<RangeKey>('30')
  const rangeDays = RANGE_DAYS[range]
  const history = useResourceState(lifetimeResource)
  const windowRead = useResourceState(windowResource)
  /** The day this page is drawn for: a page left open across midnight stays the day it opened on. */
  const [today] = useState(() => new Date())

  useEffect(() => {
    readUsage(rangeDays)
  }, [rangeDays])

  const snapshot = history.value
  const view = windowRead.value
  const busiest = snapshot === null ? null : busiestDay(snapshot.byDay)
  const runs = snapshot === null ? { current: 0, longest: 0 } : streaks(snapshot.byDay, today)
  const cells = useMemo(() => heatmapCells(snapshot?.byDay ?? [], HEATMAP_WEEKS, today), [snapshot, today])
  /** The grid's own axis: one label per month the window touches, over that month's first column. */
  const months = useMemo(() => heatmapMonths(cells), [cells])
  const days = windowDays(rangeDays, today)
  const bars = trendBars(view?.byDay ?? [], days)
  const rows = modelRows(view?.byModel ?? [], MODEL_ROWS, copy.otherModels)

  /** The day whose cell the pointer is on, and the element the card points at. */
  const [hoveredDay, setHoveredDay] = useState<string | null>(null)
  const hoverAnchor = useRef<HTMLElement | null>(null)
  /** One lookup for the whole grid: a cell names its day, and the day's counters live in `byDay`. */
  const dayRows = useMemo(() => {
    const table = new Map<string, EngineUsageDayRow>()
    for (const row of snapshot?.byDay ?? []) {
      table.set(row.day, row)
    }
    return table
  }, [snapshot])
  const hoveredRow = hoveredDay === null ? undefined : dayRows.get(hoveredDay)
  const hoveredModels = useMemo(
    () =>
      hoveredDay === null
        ? []
        : dayModelRows(snapshot?.byDayModel ?? [], hoveredDay, DAY_DETAIL_MODELS, copy.otherModels),
    [hoveredDay, snapshot, copy.otherModels],
  )

  const failure =
    history.status === 'error' ? history.error : windowRead.status === 'error' ? windowRead.error : null
  const status =
    failure !== null
      ? 'error'
      : history.status === 'ready' && windowRead.status === 'ready'
        ? 'ready'
        : 'loading'
  const loading = history.status === 'loading' || windowRead.status === 'loading'
  const hasData = view !== null && tokensOf(view.totals) > 0

  const figures = [
    {
      value: snapshot === null ? NO_VALUE : formatTokens(tokensOf(snapshot.totals), language),
      label: copy.lifetimeTotalTokens,
    },
    {
      value: snapshot === null ? NO_VALUE : formatTokens(todayTokens(snapshot.byDay, today), language),
      label: copy.todayTokens,
    },
    {
      value: snapshot === null ? NO_VALUE : formatDuration(longestSessionMs(snapshot.bySession)),
      label: copy.longestSession,
    },
    {
      value: snapshot === null ? NO_VALUE : formatDayCount(runs.current, language),
      label: copy.currentStreak,
    },
    {
      value: snapshot === null ? NO_VALUE : formatDayCount(runs.longest, language),
      label: copy.longestStreak,
    },
  ]

  const heatmapDescription =
    busiest === null
      ? copy.empty
      : copy.heatmapDescription(busiest.day, formatTokens(busiest.tokens, language))
  const modelDescription =
    rows.length === 0
      ? copy.empty
      : copy.modelChartDescription(rows[0].label, formatShare(rows[0].share, language))
  const axisLabels = [
    formatDayLabel(days[0], language),
    formatDayLabel(days[Math.floor((days.length - 1) / 2)], language),
    formatDayLabel(days[days.length - 1], language),
  ]

  /** Both answers, asked again past the host's memo: what a refresh and a retry both mean. */
  const reload = () => {
    refreshUsage(rangeDays)
  }

  return (
    <>
      <SettingsCard>
        <SettingsStats items={figures} />
      </SettingsCard>

      {snapshot?.scanned.truncated === true ? (
        <p className="text-[13px] leading-[19px] text-muted-foreground">{copy.truncated}</p>
      ) : null}

      <SettingsLoadState
        status={status}
        error={failure}
        loadingLabel={copy.loading}
        failedLabel={copy.loadFailed}
        retryLabel={copy.retry}
        onRetry={reload}
      />

      {snapshot === null ? null : (
        <SettingsGroup title={copy.heatmapTitle} description={heatmapDescription}>
          <SettingsCard>
            <div className="flex flex-col gap-3 px-5 py-4">
              {/* One handler for the whole grid rather than a listener per cell: the grid carries
                  its day in a data attribute, so a pointer moving across it re-renders the section
                  once per cell entered and the card follows the cell under the pointer. */}
              <div
                className="grid grid-flow-col grid-rows-7 gap-[3px]"
                onPointerOver={(event) => {
                  const cell = (event.target as Element).closest<HTMLElement>('[data-day]')
                  if (cell === null || cell.dataset.day === hoveredDay) {
                    return
                  }
                  hoverAnchor.current = cell
                  setHoveredDay(cell.dataset.day ?? null)
                }}
                onPointerLeave={() => {
                  hoverAnchor.current = null
                  setHoveredDay(null)
                }}
              >
                {cells.map((cell, index) => (
                  <span
                    key={index}
                    data-day={cell.date ?? undefined}
                    className={HEAT_CELL_CLASSES[cell.level]}
                    aria-hidden="true"
                  />
                ))}
              </div>
              {/* The grid's month axis: a label starts over the column that month's first day falls
                  in, and the template is the cells' own, so a label and its column line up exactly. */}
              <div
                className="grid gap-x-[3px] text-xs leading-[18px] text-muted-foreground"
                style={{ gridTemplateColumns: HEAT_GRID_COLUMNS }}
              >
                {months.map((month) => (
                  <span
                    key={month.column}
                    className="whitespace-nowrap"
                    style={{ gridColumnStart: month.column + 1, gridRowStart: 1 }}
                  >
                    {formatMonthLabel(month.month, language)}
                  </span>
                ))}
              </div>
              <p className="flex items-center gap-1.5 text-xs leading-[18px] text-muted-foreground">
                <span>{copy.heatmapLess}</span>
                {HEAT_LEVELS.map((level) => (
                  <span
                    key={level}
                    className={cn('size-[9px] rounded-[2px]', level)}
                    aria-hidden="true"
                  />
                ))}
                <span>{copy.heatmapMore}</span>
              </p>
              <Tooltip
                anchorRef={hoverAnchor}
                open={hoveredDay !== null}
                onOpenChange={(open) => {
                  if (!open) {
                    hoverAnchor.current = null
                    setHoveredDay(null)
                  }
                }}
                className="w-[260px]"
                content={
                  hoveredDay === null || hoveredRow === undefined ? null : (
                    <DayDetail
                      day={hoveredDay}
                      tokens={tokensOf(hoveredRow)}
                      calls={hoveredRow.calls}
                      models={hoveredModels}
                      language={language}
                      copy={copy}
                    />
                  )
                }
              />
            </div>
          </SettingsCard>
        </SettingsGroup>
      )}

      <SettingsCard>
        <SettingsRow
          title={copy.rangeTitle}
          control={
            <SettingsChoice
              label={copy.rangeTitle}
              value={range}
              onChange={setRange}
              options={RANGE_KEYS.map((key) => ({
                value: key,
                label: copy.rangeLabels[RANGE_DAYS[key]],
              }))}
            />
          }
        />
      </SettingsCard>

      {view === null ? null : hasData ? (
        <>
          <SettingsGroup
            title={copy.dailyChartTitle}
            description={copy.dailyChartDescription(days.length)}
          >
            <SettingsCard>
              <div className="flex flex-col gap-2 px-5 py-4">
                <div className="flex h-32 items-end gap-[3px]">
                  {bars.map((bar) => (
                    <span
                      key={bar.day}
                      title={`${bar.day}: ${formatTokens(bar.tokens, language)} ${copy.tokenUnit}`}
                      className="flex-1 rounded-t-[3px] bg-foreground/60"
                      style={{ height: `${bar.height}%` }}
                    />
                  ))}
                </div>
                <div className="flex justify-between text-xs leading-[18px] text-muted-foreground">
                  <span>{axisLabels[0]}</span>
                  <span>{axisLabels[1]}</span>
                  <span>{axisLabels[2]}</span>
                </div>
              </div>
            </SettingsCard>
          </SettingsGroup>

          <SettingsGroup title={copy.modelChartTitle} description={modelDescription}>
            <SettingsCard>
              {rows.length === 0 ? (
                <SettingsEmpty>{copy.empty}</SettingsEmpty>
              ) : (
                rows.map((row) => (
                  <SettingsRow
                    key={row.key}
                    stack
                    title={row.label}
                    description={`${formatTokens(row.tokens, language)} ${copy.tokenUnit} · ${formatShare(row.share, language)}`}
                    control={
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-foreground/70"
                          style={{ width: `${row.share * 100}%` }}
                        />
                      </div>
                    }
                  />
                ))
              )}
            </SettingsCard>
          </SettingsGroup>
        </>
      ) : (
        <SettingsGroup title={copy.emptyTitle}>
          <SettingsCard>
            <SettingsEmpty>{copy.empty}</SettingsEmpty>
          </SettingsCard>
        </SettingsGroup>
      )}

      <div className="flex justify-end">
        <Button variant="outline" size="sm" ripple disabled={loading} onClick={reload}>
          {loading ? copy.refreshing : copy.refresh}
        </Button>
      </div>
    </>
  )
}

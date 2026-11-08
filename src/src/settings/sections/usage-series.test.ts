import assert from 'node:assert/strict'
import { test } from 'node:test'

import { heatmapCells, heatmapMonths, tokensOf } from './usage-series.ts'

/**
 * The activity grid's month axis.
 *
 * The grid is a year of cells with no text on it; the axis is what tells a reader which months the
 * year covers. A label must sit over the first column its own month owns, and two labels must never
 * be printed on top of each other — the one failure a reader would see as a defect rather than as
 * a denser axis.
 */

test('every label sits over a column of its own month, and no two labels collide', () => {
  for (let offset = 0; offset < 400; offset += 1) {
    const today = new Date(2026, 0, 1 + offset)
    const cells = heatmapCells([], 53, today)
    const months = heatmapMonths(cells)

    assert.ok(months.length >= 12, `only ${months.length} labels for ${today.toDateString()}`)
    assert.equal(months.at(-1)?.month, today.getMonth() + 1)
    for (let at = 0; at < months.length; at += 1) {
      const start = months[at].column * 7
      const column = cells.slice(start, start + 7).map((cell) => cell.date)
      const first = column.findIndex(
        (date) => date !== null && Number(date.slice(5, 7)) === months[at].month,
      )
      assert.ok(first >= 0, `${today.toDateString()}: ${months[at].month} starts outside its column`)
      const before = cells[start + first - 1]?.date
      if (before !== undefined && before !== null) {
        assert.notEqual(Number(before.slice(5, 7)), months[at].month)
      }
      if (at > 0) {
        assert.ok(
          months[at].column - months[at - 1].column >= 3,
          `${today.toDateString()}: labels ${at - 1} and ${at} are too close`,
        )
      }
    }
  }
})

test('a month the window barely covers yields to the month that follows it', () => {
  // 2026-11-01 is a Sunday; 53 weeks before it is 2025-10-26, so the grid opens with six days of
  // October and November's first day is already inside that same column.
  const cells = heatmapCells([], 53, new Date(2026, 10, 1))
  const months = heatmapMonths(cells)
  assert.deepEqual(months[0], { column: 0, month: 11 })
})

test('reasoning is counted once, because it is already inside output', () => {
  // The engine reports `reasoning` as a subset of `output` (`host/src/usage.ts`'s billable rule,
  // and every provider mapping that folds thinking tokens into completion tokens). A total that
  // adds it again bills the same tokens twice.
  const totals = {
    input: 100,
    output: 1_000,
    cacheRead: 500,
    cacheWrite: 0,
    reasoning: 800,
    costUsd: 0,
    calls: 1,
  }
  assert.equal(tokensOf(totals), 1_600)
})

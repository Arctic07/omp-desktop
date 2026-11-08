#!/usr/bin/env node
// Gate: documentation budgets (AGENTS.md "Budgets", rules.md#documentation-discipline).
//
// The numbers live in the budget table of AGENTS.md — one home, no second manifest.
// Throws when a standing document exceeds its ceiling; a ceiling that no longer fits
// is raised in that table with its reason stated in the delivery note.
//
// Counting is whitespace-delimited words, matching the reference project's doc budgets:
// a character count silently changes meaning between a CJK and a Latin document, so a
// translation would rewrite every budget it touched.

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const TABLE_HOME = 'AGENTS.md'
const HEADING = '## Budgets'

function readBudgetTable() {
  const md = readFileSync(path.join(ROOT, TABLE_HOME), 'utf8')
  const start = md.indexOf(HEADING)
  if (start < 0) throw new Error(`${TABLE_HOME}: no "${HEADING}" block`)

  const rows = []
  let inTable = false
  for (const line of md.slice(start).split('\n').slice(1)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('|')) {
      inTable = true
      rows.push(trimmed)
      continue
    }
    if (inTable && trimmed !== '') break
  }
  if (rows.length === 0) throw new Error(`${TABLE_HOME}: "${HEADING}" block has no table`)

  return rows.slice(2).map((row) => {
    const cells = row.split('|').map((cell) => cell.trim())
    const [name, ceiling] = [cells[1] ?? '', cells[2] ?? '']
    const target = /`([^`]+)`/.exec(name)?.[1]
    const limit = Number((/([\d,]+)/.exec(ceiling)?.[1] ?? '').replace(/,/g, ''))
    if (!target || !Number.isInteger(limit)) {
      throw new Error(`${TABLE_HOME}: unreadable budget row "${row}" (want | \`path\` | 12,345 |)`)
    }
    return { target, limit }
  })
}

const words = (text) => text.split(/\s+/).filter((word) => word !== '').length

const failures = []
const budgets = readBudgetTable()
for (const { target, limit } of budgets) {
  const file = path.join(ROOT, target)
  if (!existsSync(file)) {
    failures.push(`${target}: listed in the budget table but missing on disk`)
    continue
  }
  const count = words(readFileSync(file, 'utf8'))
  const pct = Math.round((count / limit) * 100)
  const mark = count > limit ? 'OVER' : 'ok'
  console.log(`${mark.padEnd(4)} ${String(count).padStart(7)} / ${String(limit).padStart(7)} (${String(pct).padStart(3)}%)  ${target}`)
  if (count > limit) {
    failures.push(`${target}: ${count} words exceeds the ${limit} ceiling — relocate to the owning tier, condense, then raise the ceiling with a reason`)
  }
}

if (failures.length > 0) {
  console.error(`\ndoc budget: ${failures.length} violation(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`\ndoc budget: ${budgets.length} documents within budget`)

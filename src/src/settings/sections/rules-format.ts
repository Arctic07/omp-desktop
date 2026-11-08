/**
 * The rules toolbar's own reading of the file: how big the engine's `RULES.md` is.
 *
 * The timestamp beside it is the shared ladder (`settings/sections/memory-updated.ts`), because both
 * pages name the same moments — `rulesCopy.ts` says so in as many words, and two ladders would drift.
 */

/**
 * Byte sizes as the file's own line states them: `512 B`, `12.4 KiB`, `1.3 MiB`.
 *
 * The units are the binary ones the filesystem counts in, and the decimals are worth showing for
 * small multiples while large ones read better without them. Hex/decimal ambiguity is the reason the
 * unit says `KiB` rather than `KB`.
 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let amount = value / 1024
  let unitIndex = 0
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024
    unitIndex += 1
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

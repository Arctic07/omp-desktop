/**
 * Token counts, written the one way the composer reads them.
 *
 * Ported from the desktop app's own `utils/conversationMetrics.ts` (`formatTokenCount`), so the two
 * front ends spell the same count the same way: a scaled figure keeps one decimal below 100 and is
 * a whole number from 100 up, so the unit suffix always carries the precision the value is worth.
 * The ladder is the fixed 1e3 / 1e6 one — a 1M window reads `1M`, and larger counts stay in M
 * rather than introducing a third unit — and a value that is not a positive count reads `0` rather
 * than a unit it never earned.
 */

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1_000) return String(Math.round(value))
  const unit = value < 1_000_000 ? 1_000 : 1_000_000
  const scaled = value / unit
  const shown = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10
  return `${shown}${unit === 1_000 ? 'K' : 'M'}`
}

/**
 * A decode rate, as the turn's footer prints it: whole tokens from ten up, one decimal below.
 *
 * A rate is read as a magnitude rather than a measurement — a reader comparing two turns is asking
 * "was this one much faster" — so the figure carries a decimal only while it is small enough for
 * one to mean something. A negative rate clamps to zero, the same way every other reading here does.
 */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

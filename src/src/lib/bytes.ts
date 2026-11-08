/**
 * A byte count as a size a reader compares at a glance.
 *
 * One spelling for the whole application, because two of them already existed: the tool row's
 * minimizer line (which states the engine's own numbers, so it must read like the engine's card —
 * `git 120.4KB → 3.2KB`) and the workspace file viewer (`1.2 KB`). One capture shown twice with two
 * different spellings is the kind of drift a reader notices as an inconsistency in the product, not
 * as two contexts.
 *
 * The thresholds are the engine's (`@oh-my-pi/pi-utils`'s `formatBytes`): 1024 steps, one decimal.
 * Restated here rather than imported because the frontend never imports engine code
 * (`rules.md#layering`), and this file is the one place that restatement lives.
 */

/** `0B`, `1023B`, `1.0KB`, `120.4KB`, `1.0MB`, `3.0GB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

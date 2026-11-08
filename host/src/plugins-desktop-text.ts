/**
 * The `omp.desktop` primitives two halves of the validator share: an entry id's shape, a
 * package-relative path, and one localised label.
 *
 * They live here rather than in `plugins-desktop.ts` for one reason: the process block's validator
 * (`plugins-desktop-process.ts`) needs exactly these three rules, and importing them back from the
 * file that imports the validator would be a cycle. Nothing here reads a manifest or decides a
 * refusal - the callers do - so the direction stays one-way: text primitives ← both validators.
 */

import * as path from 'node:path'

import { PLUGIN_DESKTOP_I18N_LOCALES_MAX, PLUGIN_DESKTOP_I18N_TEXT_MAX } from './constants.ts'
import { isRecord } from './plugins-manifest.ts'

/** A plugin id inside a directory entry id, per spec §3.2. */
export const DESKTOP_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/

/**
 * Whether a declared package-relative path is one both halves of the contract read the same way.
 *
 * This is the rule the Rust boundary re-checks (`pages::is_safe_relative`) for page entries and, from
 * this stage on, for a theme's `css`/`assets` and a process's `main`: no absolute path, no backslash,
 * no control character, no `:`, no empty/`.`/`..` segment, and a bounded length. A path that passes
 * is still just a path - the caller decides whether the file must exist, or whether the other side
 * stats it.
 */
export function safeRelativePath(value: string, maxLength: number): boolean {
  if (value.length === 0 || value.length > maxLength) return false
  if (path.isAbsolute(value) || /\\|\p{Cc}|:/u.test(value)) return false
  return !value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
}

/**
 * One localised label: locale → text, bounded and sorted the way every other localised text is.
 *
 * Shared by every place a manifest names a thing in more than one language - a theme, a page entry,
 * a contributed command - because they are the same shape and the same rules: non-empty strings of a
 * bounded length, the first keys in sorted order kept, and a value that is not one of those dropped
 * rather than refusing the block (a missing translation is what a missing field means everywhere
 * else).
 *
 * `invalid` is reserved for a `label`/`title` that is present in a shape this host cannot read at
 * all, which refuses the entry it belongs to: there is nothing to fall back to then.
 */
export function desktopLabels(value: unknown): { readonly labels: Record<string, string> | null; readonly invalid: boolean } {
  if (value === undefined || value === null) return { labels: null, invalid: false }
  if (!isRecord(value)) return { labels: null, invalid: true }
  const kept: Array<[string, string]> = []
  for (const key of Object.keys(value).sort()) {
    const text = value[key]
    if (typeof text !== 'string') continue
    const trimmed = text.trim()
    if (trimmed === '' || trimmed.length > PLUGIN_DESKTOP_I18N_TEXT_MAX) continue
    kept.push([key, trimmed])
  }
  if (kept.length === 0) return { labels: null, invalid: false }
  const labels: Record<string, string> = {}
  for (const [key, text] of kept.slice(0, PLUGIN_DESKTOP_I18N_LOCALES_MAX)) labels[key] = text
  return { labels, invalid: false }
}

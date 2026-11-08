/**
 * Which copy of the theme a start trusts.
 *
 * The choice exists twice: `next-themes` keeps it in the webview's storage and puts the palette
 * class on the document, and the shell keeps a second copy in `app.sqlite` (`startup_theme_set`) so
 * it can paint the window before any document exists. This module is the rule that ties them
 * together - which one a start believes, and which one a start may write.
 *
 * It has no imports so the rules can be tested without a document: what they decide is a string
 * comparison, and a test that needed `next-themes` to reproduce it would be testing the library.
 */

/**
 * The key `next-themes` stores the theme under: its default, which `src/main.tsx`'s provider uses,
 * and which `src/index.html`'s start-up shell reads before the provider exists.
 */
export const THEME_STORAGE_KEY = 'theme'

/** The three settings the window, the document and the settings page all speak. */
export type StartupTheme = 'light' | 'dark' | 'system'

/** The setting a stored or recorded string names, or `null` for anything else. */
function asTheme(value: string | null | undefined): StartupTheme | null {
  return value === 'light' || value === 'dark' || value === 'system' ? value : null
}

/**
 * The theme a start should draw with: the shell's record, or the document's own storage when the
 * shell has none.
 *
 * The record is the owner and the storage is its cache. That order is not arbitrary: the record
 * lives in `app.sqlite`, which this application owns, while the storage lives in a WebView2 profile
 * directory it does not. A profile can be evicted, and a storage database whose last write was
 * interrupted is recovered by dropping every write after the damaged record - measured here on
 * 2026-11-04, where the log's framing broke at sequence 323 and the user's `light` write (sequence
 * 324) was discarded on every open afterwards. A start that read that recovered state drew `dark`
 * and, because nothing compared the two copies, recorded `dark` over the choice as well.
 *
 * Reading the record first is what repairs that: a stale storage is corrected at start-up instead of
 * being believed, and a first run (no record) still takes whatever the storage holds.
 */
export function themeToAdopt(
  stored: string | null,
  recorded: string | null,
): StartupTheme | null {
  return asTheme(recorded) ?? asTheme(stored)
}

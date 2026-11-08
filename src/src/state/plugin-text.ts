/**
 * How a plugin's own words reach a page: the display name, the description, and the title of one
 * page it contributes.
 *
 * The rules are the engine's and the manifest's, not this page's: `omp.desktop.i18n` may translate
 * what `omp.name` / `omp.description` said, a language this build does not write falls back to
 * English, and a page entry that wrote no title of its own is named by the plugin that contributed
 * it. They live here rather than in one settings view because the plugin list, the plugin detail
 * view and the work panel's own tabs all need the same three answers, and a second implementation
 * would be a second set of fallbacks.
 */

import type { EngineDesktopPage, JsonObject, PluginRow } from '../api/plugins-types'
import type { Language } from '../lib/i18n'

/** One manifest string as the wire may carry it: anything that is not a string is not text. */
function manifestText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** The plugin's own i18n block for one language, or null when the manifest carries none. */
function manifestLocale(row: PluginRow, language: Language): Record<string, unknown> | null {
  const i18n = row.desktop?.i18n
  if (i18n === null || i18n === undefined) {
    return null
  }
  const locale = i18n[language]
  return typeof locale === 'object' && locale !== null ? (locale as Record<string, unknown>) : null
}

/** The name to show for one row: the manifest's own translation, else the package name. */
export function pluginDisplayName(row: PluginRow, language: Language): string {
  const localized = manifestText(manifestLocale(row, language)?.name)
  return localized === '' ? row.name : localized
}

/** The description to show for one row: the manifest's own translation, else the manifest's own. */
export function pluginDisplayDescription(row: PluginRow, language: Language): string {
  const localized = manifestText(manifestLocale(row, language)?.description)
  if (localized !== '') {
    return localized
  }
  return manifestText(row.description)
}

/** One page title from its locale map, or '' when the entry wrote none this build can read. */
export function pageTitle(title: JsonObject | null, language: Language): string {
  if (title === null) return ''
  const preferred = manifestText(title[language])
  if (preferred !== '') return preferred
  return manifestText(title.en)
}

/** The title a page is drawn under: its own, or the name of the plugin that contributed it. */
export function pluginPageTitle(
  page: Pick<EngineDesktopPage, 'title'>,
  row: PluginRow,
  language: Language,
): string {
  const own = pageTitle(page.title, language)
  return own === '' ? pluginDisplayName(row, language) : own
}

/**
 * The themes installed plugins contribute, and which one is in effect.
 *
 * A theme is token values, plus - when its author ships one - a stylesheet the Rust boundary has
 * already sanitised and rewritten. The host validates the declared shape, the Rust side reads the
 * bytes and cleans the text, and applying a theme writes both onto the document: the tokens first,
 * then the stylesheet, so a contributed rule of equal specificity can override a token-based one.
 * No plugin code runs to draw a theme — which is the whole point of the feature, and why this module
 * never touches a plugin's own pages.
 *
 * The choice is stored with what it paints, not just with the theme's id, so the selection survives a
 * start in which the plugin list has not been read yet: the document is painted with the right theme
 * before anything asks the host what is installed. Reconciling with the list afterwards is what drops
 * a choice whose plugin is gone.
 */

import type { EnginePluginTheme, JsonObject, PluginRow } from '@/api/plugins-types'
import type { Language } from '@/lib/i18n'
import { createStore } from './store.ts'
import { contrastIssues, type ContrastIssue } from './theme-contrast.ts'

/** One theme as the appearance page lists it. */
export interface PluginThemeEntry {
  /** Stable across a list read: the installation and the theme it contributes. */
  key: string
  pluginId: string
  pluginName: string
  themeId: string
  label: string
  /** The mode the theme declares, or null when it declares none. */
  dark: boolean | null
  tokens: Record<string, string>
  /**
   * The sanitised stylesheet, or null when the theme declares none. Already rewritten by the Rust
   * boundary, and still untrusted text: it is assigned to a `<style>` text node, never parsed as HTML.
   */
  css: string | null
  /**
   * `theme_css_invalid` when the theme declared a stylesheet (or assets) the Rust boundary refused;
   * null when nothing it declared failed. A theme with this set paints its tokens only, and the page
   * says so rather than showing a theme that looks like it applied.
   */
  cssError: string | null
  /**
   * The painted pairs this theme leaves under the contrast threshold (`state/theme-contrast.ts`).
   * Empty for a theme that only repaints chrome, or whose values this build cannot parse.
   */
  contrast: readonly ContrastIssue[]
}

/** What a theme row states about its stylesheet: nothing, one applied, or one that was refused. */
export type ThemeStylesheetState =
  | { readonly kind: 'none' }
  | { readonly kind: 'stylesheet' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * The badge a theme row draws, projected from what the theme carries.
 *
 * The refusal is checked before the absence, and after the text: a stylesheet that reached the page
 * is applied, whatever else the row says; a declared one that did not is the case the page has to
 * name, because a theme painting tokens only looks exactly like a theme that never shipped CSS.
 */
export function themeStylesheetState(theme: Pick<PluginThemeEntry, 'css' | 'cssError'>): ThemeStylesheetState {
  if (theme.css !== null) return { kind: 'stylesheet' }
  if (theme.cssError !== null) return { kind: 'unavailable', reason: theme.cssError }
  return { kind: 'none' }
}

interface PluginThemeState {
  /** The theme in effect, or null for the client's own default. */
  selected: PluginThemeEntry | null
}

const STORAGE_KEY = 'omp-desktop.plugin-theme'
/** The token declarations, written first. */
const STYLE_ELEMENT_ID = 'omp-plugin-theme'
/** The contributed stylesheet, written after the token element so it can override it. */
const CSS_STYLE_ELEMENT_ID = 'omp-plugin-theme-css'

export const pluginThemeStore = createStore<PluginThemeState>({ selected: null })

/** The locale a plugin's own label is read in, with the engine's usual fallbacks. */
function labelOf(label: JsonObject | null, themeId: string, language: Language): string {
  if (label === null) return themeId
  const preferred = label[language]
  if (typeof preferred === 'string' && preferred.length > 0) return preferred
  const fallback = label.en
  if (typeof fallback === 'string' && fallback.length > 0) return fallback
  return themeId
}

/** Every theme the installed plugins contribute, in list order. */
export function pluginThemes(plugins: readonly PluginRow[], language: Language): PluginThemeEntry[] {
  const entries: PluginThemeEntry[] = []
  for (const plugin of plugins) {
    for (const theme of plugin.desktop?.themes ?? []) {
      entries.push(toEntry(plugin, theme, language))
    }
  }
  return entries
}

function toEntry(
  plugin: PluginRow,
  theme: EnginePluginTheme,
  language: Language,
): PluginThemeEntry {
  return {
    key: `${plugin.id}\u0000${plugin.scope}\u0000${theme.id}`,
    pluginId: plugin.id,
    pluginName: plugin.name,
    themeId: theme.id,
    label: labelOf(theme.label, theme.id, language),
    dark: theme.dark,
    tokens: theme.tokens,
    // A row from a Rust build that predates the field has no `css` at all: that is a theme without
    // a stylesheet, not a theme whose stylesheet is the string "undefined".
    css: typeof theme.css === 'string' && theme.css.length > 0 ? theme.css : null,
    // The same tolerance for the refusal token: absent, null or empty all mean "nothing failed".
    cssError: typeof theme.cssError === 'string' && theme.cssError.length > 0 ? theme.cssError : null,
    // A report, not a gate: the theme still applies, and the appearance row names the pairs.
    contrast: contrastIssues(theme.tokens),
  }
}

/**
 * Write one theme on the document — its tokens, then its stylesheet — or remove both for the default.
 *
 * The two elements are one lifecycle, not two: a theme owns exactly what it paints, so a stale
 * stylesheet without its tokens (or the reverse) is never left behind — the failure mode would be
 * rules from the previous theme still applying to the new one's palette.
 *
 * Ordering is part of the contract: the token element is appended first and the stylesheet second, so
 * a contributed rule of equal specificity wins over the `:root` token block. Nothing is reordered on
 * a repaint; appending the newer element after the older one preserves the invariant.
 *
 * Owner / lifetime (`rules.md#resource-bounds-and-release-points`): the two `<style>` elements in `document.head` are process
 * singletons owned by this module. They hold at most one theme's text each — a bounded, single-entry
 * slot, not a cache — and their release point is this function's `null` branch, which every caller
 * that drops a theme (default selection, reconcile) reaches.
 *
 * The stylesheet text is untrusted: it is assigned with `textContent`, never `innerHTML`, so a
 * `<script>` or `</style>` in it never becomes markup — it is only ever CSS source text this
 * document's style engine reads.
 */
function paint(entry: PluginThemeEntry | null): void {
  const existingTokens = document.getElementById(STYLE_ELEMENT_ID)
  const existingCss = document.getElementById(CSS_STYLE_ELEMENT_ID)
  if (entry === null) {
    existingTokens?.remove()
    existingCss?.remove()
    return
  }
  const declarations = Object.entries(entry.tokens)
    .map(([name, value]) => `${name}:${value};`)
    .join('')
  const tokens = existingTokens ?? document.createElement('style')
  tokens.id = STYLE_ELEMENT_ID
  tokens.textContent = `:root{${declarations}}`
  // Moved to the end every time, not only when created: the palette this overrides is declared at
  // the same specificity (`:root` and `.dark` both name the document), so the later rule wins and a
  // node left where a start-up script put it - before the application's own stylesheet arrives -
  // would lose to the shipped palette on every token whose default it means to replace.
  document.head.append(tokens)
  if (entry.css === null) {
    existingCss?.remove()
    return
  }
  const css = existingCss ?? document.createElement('style')
  css.id = CSS_STYLE_ELEMENT_ID
  css.textContent = entry.css
  document.head.append(css)
}

function readStored(): PluginThemeEntry | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const stored = parsed as Partial<PluginThemeEntry>
    if (
      typeof stored.key !== 'string' ||
      typeof stored.pluginId !== 'string' ||
      typeof stored.pluginName !== 'string' ||
      typeof stored.themeId !== 'string' ||
      typeof stored.label !== 'string' ||
      typeof stored.tokens !== 'object' ||
      stored.tokens === null
    ) {
      return null
    }
    return {
      key: stored.key,
      pluginId: stored.pluginId,
      pluginName: stored.pluginName,
      themeId: stored.themeId,
      label: stored.label,
      dark: typeof stored.dark === 'boolean' ? stored.dark : null,
      tokens: stored.tokens as Record<string, string>,
      // A stored entry from before stylesheets existed has no `css`: that is a token-only theme,
      // which is exactly what it was when it was chosen.
      css: typeof stored.css === 'string' && stored.css.length > 0 ? stored.css : null,
      cssError: typeof stored.cssError === 'string' && stored.cssError.length > 0 ? stored.cssError : null,
      // The report is computed from the tokens, not stored: a value typed into an older build is
      // judged by this one. A stored array (a build that wrote one) is ignored for the same reason.
      contrast: contrastIssues((stored.tokens ?? {}) as Record<string, string>),
    }
  } catch {
    return null
  }
}

function store(entry: PluginThemeEntry | null): void {
  try {
    if (entry === null) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entry))
  } catch {
    // A choice that cannot be stored still applies to this session.
  }
}

/**
 * The stored theme, painted.
 *
 * Called once at startup, before anything reads the plugin list: the document is already wearing the
 * theme the reader chose, so a slow host read cannot make the window flash the default palette.
 */
export function startPluginTheme(): void {
  const selected = readStored()
  pluginThemeStore.set({ selected })
  paint(selected)
}

export function selectPluginTheme(entry: PluginThemeEntry | null): void {
  pluginThemeStore.set({ selected: entry })
  store(entry)
  paint(entry)
}

/**
 * Drop a choice whose plugin is no longer installed.
 *
 * A theme whose installation has gone is not a theme any more — keeping it would leave the document
 * painted with tokens and a stylesheet nothing declares, and the list would offer a "Default" row
 * that is not the one in effect. Reaching [`selectPluginTheme`] with null is also the one release
 * point for both style elements: disabling, uninstalling or upgrading a plugin ends here, with the
 * document back on the default palette and no orphan `<style>` behind.
 */
export function reconcilePluginTheme(entries: readonly PluginThemeEntry[]): void {
  const selected = pluginThemeStore.get().selected
  if (selected === null) return
  if (entries.some((entry) => entry.key === selected.key)) return
  selectPluginTheme(null)
}

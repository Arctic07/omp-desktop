/**
 * The `omp.desktop` manifest block, validated and projected for the page (spec §3.2, §5.5).
 *
 * The engine does not read this block at all, so this host is its only validator and the rules are
 * the spec's: a schema version it knows, an id of the declared shape, an `entry` that is a
 * relative path inside the plugin root and exists, a permission the manifest grants, and localised
 * text of a bounded length. A block that fails a rule is refused as a whole and keeps its declared
 * permissions - the consent gate needs those facts - while its entry lists are emptied, so nothing
 * about a refused block can load. A manifest that declares no block is the ordinary case for an
 * engine-only plugin and projects to `null`; a `package.json` this host cannot read is
 * reported by the row's `desktopError` instead (`plugins-facts.ts`, spec §3.3).
 */

import * as path from 'node:path'

import {
  PLUGIN_DESKTOP_API_VERSION,
  PLUGIN_DESKTOP_ENGINES_MAX,
  PLUGIN_DESKTOP_ENTRIES_MAX,
  PLUGIN_DESKTOP_ENTRY_ORDER_DEFAULT,
  PLUGIN_DESKTOP_ENTRY_ORDER_MAX,
  PLUGIN_DESKTOP_ENTRY_PATH_MAX,
  PLUGIN_DESKTOP_I18N_LOCALES_MAX,
  PLUGIN_DESKTOP_I18N_SETTINGS_MAX,
  PLUGIN_DESKTOP_I18N_TEXT_MAX,
  PLUGIN_DESKTOP_ICON_TOKEN,
  PLUGIN_DESKTOP_PANEL_HEIGHT_MAX,
  PLUGIN_DESKTOP_PANEL_HEIGHT_MIN,
  PLUGIN_DESKTOP_PANEL_WIDTH_MAX,
  PLUGIN_DESKTOP_PANEL_WIDTH_MIN,
  PLUGIN_DESKTOP_PERMISSIONS,
  PLUGIN_DESKTOP_RENDERER_TOKEN,
  PLUGIN_FS_SCOPE_MAX,
  PLUGIN_FS_SCOPE_PATTERN_MAX,
  PLUGIN_FS_SCOPE_SEGMENTS_MAX,
  PLUGIN_THEME_ASSET_EXTENSIONS,
  PLUGIN_THEME_ASSET_PATH_MAX,
  PLUGIN_THEME_ASSETS_MAX,
  PLUGIN_THEME_COUNT_MAX,
  PLUGIN_THEME_CSS_PATH_MAX,
  PLUGIN_THEME_TOKEN_MAX,
  PLUGIN_THEME_TOKEN_NAME,
  PLUGIN_THEME_TOKEN_VALUE,
  PLUGIN_THEME_VALUE_FORBIDDEN,
  PLUGIN_THEME_VALUE_MAX,
} from './constants.ts'
import { isWithin } from './capabilities.ts'
import { isRecord, manifestList, pathIsFile, realRoot } from './plugins-manifest.ts'
import { desktopProcess, type DesktopProcessView } from './plugins-desktop-process.ts'
import { desktopRenderer, type DesktopRendererView } from './plugins-desktop-renderer.ts'
import { DESKTOP_ID, desktopLabels, safeRelativePath } from './plugins-desktop-text.ts'
import { satisfiesRange } from './semver.ts'

export type { DesktopRendererView } from './plugins-desktop-renderer.ts'
export type { DesktopProcessCommand, DesktopProcessView } from './plugins-desktop-process.ts'

/** Whether one declared theme asset names an extension this build serves. */
function themeAssetExtension(file: string): boolean {
  const dot = file.lastIndexOf('.')
  if (dot < 0) return false
  const extension = file.slice(dot + 1).toLowerCase()
  return (PLUGIN_THEME_ASSET_EXTENSIONS as readonly string[]).includes(extension)
}

/** The fields one locale may override, in the order the spec lists them. */
const DESKTOP_I18N_FIELDS = ['name', 'description', 'safetyNotes'] as const

/** Desktop permissions P1 knows, as a lookup: the manifest is checked against exactly this list. */
const DESKTOP_PERMISSIONS: Record<string, true> = Object.fromEntries(
  PLUGIN_DESKTOP_PERMISSIONS.map(name => [name, true] as const),
)

/** One locale's display overrides (spec §3.2): the fields a page may localise, each optional. */
interface DesktopLocale {
  name?: string
  description?: string
  safetyNotes?: string
  /**
   * `i18n.<locale>.settings`: a display label per setting key (spec §3.2/§5.5). It renames a
   * control and never a value, so a key the schema does not declare is kept rather than refused -
   * the page aligns the two when it renders the form.
   */
  settings?: Record<string, string>
}

/** One theme a plugin contributes: its id, its label per locale, and what it paints. */
interface ThemeView {
  readonly id: string
  /** `label`, keyed by locale; `null` when the manifest gives none (the id is then the name). */
  readonly label: Record<string, string> | null
  /** Whether the plugin says this theme belongs to the dark base theme; `null` when it says nothing. */
  readonly dark: boolean | null
  /** The design tokens it sets, keyed by token name. */
  readonly tokens: Record<string, string>
  /**
   * `css`: the package-relative stylesheet the theme declares, as the manifest wrote it; `null` when
   * it declares none. The name is a path on this side of the contract only - the Rust boundary reads
   * the file, sanitises it, and replaces this field with the stylesheet text on the row the page sees.
   */
  readonly css: string | null
  /**
   * `assets`: the package-relative files that stylesheet may reference, in declared order; empty when
   * the theme names none. Rewritten to `omp-plugin://` URLs by the Rust boundary before a page sees
   * them, which is also why this host checks only the shape and the count, not the bytes.
   */
  readonly assets: string[]
}

/** One page a plugin contributes: a panel, a work-panel view, a settings page or a sidebar tab. */
interface DesktopPageEntry {
  readonly id: string
  /** `title`, keyed by locale; `null` when the manifest gives none (the id is then the name). */
  readonly title: Record<string, string> | null
  /** The file the page loads: a `/`-separated path inside the plugin root, checked to exist. */
  readonly entry: string
  /** Where the entry sorts among its own list: the manifest's order, or the default. */
  readonly order: number
  /** A panel's window size in logical pixels; `null` for the lists that host no window. */
  readonly width: number | null
  readonly height: number | null
  /** Whether a panel's window may be resized; `null` for the lists that host no window. */
  readonly resizable: boolean | null
  /**
   * The icon token the entry asks for, as the manifest wrote it; `null` when it wrote none. The
   * name is the page's own vocabulary - this host checks only the shape.
   */
  readonly icon: string | null
}

/**
 * One work-panel tab a plugin contributes (spec §3.2).
 *
 * Unlike every other entry list, this one names no `entry`: the surface is the application's own -
 * a terminal needs a pty and a character grid that a plugin page's sandboxed document cannot reach -
 * so the manifest declares where the tab sits and which of this build's renderers draws it, and the
 * application draws it there. That is also why the renderer's vocabulary is closed on this side
 * rather than on the manifest's.
 */
interface WorkPanelTabEntry {
  readonly id: string
  /** `title`, keyed by locale; `null` when the manifest gives none (the id is then the name). */
  readonly title: Record<string, string> | null
  /** Where the tab sorts among the work panel's own tabs: the manifest's order, or the default. */
  readonly order: number
  readonly icon: string | null
  /** The renderer token this entry asks for, as the manifest wrote it. */
  readonly renderer: string
}

/**
 * The standing reach a block declares for each file mode (spec §3.2, §6.3).
 *
 * One entry per mode rather than one list: a read scope says where a plugin may *look*, a write scope
 * where it may *change*, and a delete scope where it may *remove* - and the three are answered by
 * different gates, so a manifest that declares one and not the others declares exactly that.
 */
export interface DesktopFsScopes {
  readonly read: string[]
  readonly write: string[]
  readonly delete: string[]
}

/** The desktop manifest as the page renders it (spec §3.2). */
export interface DesktopView {
  readonly schemaVersion: number
  readonly valid: boolean
  readonly reason: string | null
  readonly panels: DesktopPageEntry[]
  readonly views: DesktopPageEntry[]
  readonly settingsDestinations: DesktopPageEntry[]
  /** `omp.desktop.sidebarTabs`: pages the sidebar offers as its own entries (spec §4.2). */
  readonly sidebarTabs: DesktopPageEntry[]
  /**
   * `omp.desktop.workPanelTabs`: tabs the work panel draws with a renderer of its own (spec §4.2).
   * The built-in terminal is the one this build ships, declared by the plugin that carries it.
   */
  readonly workPanelTabs: WorkPanelTabEntry[]
  /**
   * `omp.desktop.main` / `activationEvents` / `contributes.commands` (plan §6.1); `null` when the
   * block declares neither a process entry nor a command. The worker protocol mirrors these field
   * names exactly (`plugin-worker/*`), and Rust resolves `main` against the row's `rootPath`.
   */
  readonly process: DesktopProcessView | null
  /**
   * `omp.desktop.renderer` / `rendererActions` / `rendererCallMethods` (plan §7.1): the slot module
   * the plugin contributes, whose code runs in the application document, and the two dispatch
   * whitelists that say what it may ask for. `null` when the block declares none. The `path` is the
   * package-relative entry - Rust resolves it and adds the `url` the page imports (plan §D2); this
   * side never produces a URL, a resolution result or a runnability verdict.
   */
  readonly renderer: DesktopRendererView | null
  readonly permissions: string[]
  readonly netDomains: string[]
  /**
   * `omp.desktop.net.anyHost`: the second key beside `net.domains` (API 0.2.0). It is *reported*,
   * not applied here: the egress decision is the Rust side's (`services::plugins::net::NetPolicy`),
   * and this flag is one half of what that decision reads.
   *
   * Besides the flag, the block has to declare the `net.anyHost` permission. A block that sets the
   * flag without it is refused whole - two keys, deliberately, so a manifest cannot widen its own
   * reach by writing one boolean.
   */
  readonly netAnyHost: boolean
  /**
   * `omp.desktop.fs.read.scope`: the standing reach the plugin declares for reading files, as the
   * `entries`-style patterns this host and the Rust side both read (spec §3.2, §6.3). Empty means no
   * standing reach - every read then falls to the user's answer, and a plugin that declares no scope
   * is not a plugin with a narrower one.
   */
  readonly fsScopes: DesktopFsScopes
  /** `omp.desktop.themes`: what the plugin contributes to the appearance page (spec §4.2). */
  readonly themes: ThemeView[]
  /** `omp.desktop.i18n`, keyed by locale; `null` when the manifest declares none. */
  readonly i18n: Record<string, DesktopLocale> | null
  /**
   * `omp.desktop.engines.ompDesktop`: the desktop range the plugin says it needs, or `null` - and
   * evaluated, not merely reported (spec §3.2): a range this build does not satisfy refuses the
   * whole block, because a desktop UI written against another contract is not one to load.
   */
  readonly enginesOmpDesktop: string | null
}

/**
 * One desktop entry list, as the entries the page renders - or the reason the whole block is
 * refused.
 *
 * The engine does not read `omp.desktop` at all (spec §3.2), so this host is the only validator and
 * the rules are the spec's: an id of the declared shape, an `entry` that is a relative path inside
 * the plugin root and exists, a title of the localised shape, a bounded `order`, an `icon` token of
 * the declared shape (every list may carry one, and the name it stands for is the page's own), a
 * permission the manifest grants, and - for panels, the one list that becomes a window - a bounded
 * size. A failure refuses the whole block rather than the entry, because a panel that would need
 * `ui.panel` while the manifest grants nothing is a privilege the plugin did not declare.
 *
 * The window fields are refused on a list that hosts no window rather than ignored: a view that
 * declares a width is an author who expected a window, and loading half of what they described is
 * the one outcome neither of us can act on.
 */
function desktopEntries(
  source: Record<string, unknown>,
  key: string,
  root: string,
  permission: string,
  granted: ReadonlySet<string>,
  windowed: boolean,
): { readonly entries: DesktopPageEntry[]; readonly reason: string | null } {
  const value = source[key]
  if (value === undefined || value === null) return { entries: [], reason: null }
  if (!Array.isArray(value)) return { entries: [], reason: `${key} must be a list.` }
  if (value.length > PLUGIN_DESKTOP_ENTRIES_MAX) return { entries: [], reason: 'invalid_entries' }
  const entries: DesktopPageEntry[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return { entries: [], reason: `${key} entries must be objects.` }
    const id = item.id
    if (typeof id !== 'string' || !DESKTOP_ID.test(id)) return { entries: [], reason: 'invalid_entry_id' }
    if (seen.has(id)) return { entries: [], reason: 'duplicate_entry_id' }
    seen.add(id)
    const entry = item.entry
    if (typeof entry !== 'string' || entry === '' || entry.length > PLUGIN_DESKTOP_ENTRY_PATH_MAX) {
      return { entries: [], reason: 'invalid_entry_field' }
    }
    // The entry is a URL path: an absolute one, a `..`, a backslash or a control character is a
    // path the page renderer would resolve differently than the filesystem did. Only the lexical
    // rule is checked here; the realpath check below is what catches a symlink out of root. This is
    // the same rule the Rust boundary re-checks (`pages::is_safe_relative`), and the same helper the
    // theme path fields use, so a manifest this parser accepts is one the other side accepts too.
    if (!safeRelativePath(entry, PLUGIN_DESKTOP_ENTRY_PATH_MAX)) {
      return { entries: [], reason: 'entry_out_of_root' }
    }
    // Checked twice on purpose: lexically (a `..` that climbs out) and by realpath, because a
    // symlink inside the plugin root is itself a way out of it (spec §3.3).
    const resolved = path.resolve(root, entry)
    if (!isWithin(root, realRoot(resolved)) || !pathIsFile(resolved)) return { entries: [], reason: 'entry_out_of_root' }
    if (!granted.has(permission)) return { entries: [], reason: 'entry_permission_missing' }
    const order = item.order
    if (order !== undefined && order !== null) {
      if (typeof order !== 'number' || !Number.isInteger(order) || order < 0 || order > PLUGIN_DESKTOP_ENTRY_ORDER_MAX) {
        return { entries: [], reason: 'invalid_entry_field' }
      }
    }
    const width = item.width
    const height = item.height
    const resizable = item.resizable
    if (!windowed && (width !== undefined && width !== null || height !== undefined && height !== null || resizable !== undefined && resizable !== null)) {
      return { entries: [], reason: 'invalid_entry_field' }
    }
    if (width !== undefined && width !== null && !panelSize(width, PLUGIN_DESKTOP_PANEL_WIDTH_MIN, PLUGIN_DESKTOP_PANEL_WIDTH_MAX)) {
      return { entries: [], reason: 'invalid_entry_field' }
    }
    if (height !== undefined && height !== null && !panelSize(height, PLUGIN_DESKTOP_PANEL_HEIGHT_MIN, PLUGIN_DESKTOP_PANEL_HEIGHT_MAX)) {
      return { entries: [], reason: 'invalid_entry_field' }
    }
    if (resizable !== undefined && resizable !== null && typeof resizable !== 'boolean') {
      return { entries: [], reason: 'invalid_entry_field' }
    }
    // The icon is optional on every list - a view, a settings page or a sidebar tab carries one just
    // as a panel does - and only its shape is checked here: the name belongs to the page's own icon
    // table, so a token this build has never heard of is still a token and the page falls back to
    // that entry's default. A value outside the shape is an icon its author meant, so it refuses the
    // block rather than being dropped quietly.
    const icon = item.icon
    if (icon !== undefined && icon !== null && (typeof icon !== 'string' || !PLUGIN_DESKTOP_ICON_TOKEN.test(icon))) {
      return { entries: [], reason: 'invalid_entry_field' }
    }
    const title = desktopLabels(item.title)
    if (title.invalid) return { entries: [], reason: 'invalid_entry_field' }
    entries.push({
      id,
      title: title.labels,
      entry,
      order: typeof order === 'number' ? order : PLUGIN_DESKTOP_ENTRY_ORDER_DEFAULT,
      width: windowed && typeof width === 'number' ? width : null,
      height: windowed && typeof height === 'number' ? height : null,
      resizable: windowed && typeof resizable === 'boolean' ? resizable : null,
      icon: typeof icon === 'string' ? icon : null,
    })
  }
  return { entries, reason: null }
}

/**
 * The work-panel tabs one block contributes (spec §3.2, §4.2), as the entries the page renders - or
 * the reason the whole block is refused.
 *
 * Every rule is the one [`desktopEntries`] applies except the two that cannot: there is no `entry`
 * to resolve (the application draws these tabs itself), and a `renderer` takes its place - a token
 * of the same shape as an icon token, whose name this host does not judge because the vocabulary
 * belongs to the side that draws it. The permission is `ui.view`, the work panel's own: a tab of
 * this panel is the same reach a docked view asks for.
 */
function desktopWorkPanelTabs(
  source: Record<string, unknown>,
  granted: ReadonlySet<string>,
): { readonly tabs: WorkPanelTabEntry[]; readonly reason: string | null } {
  const value = source.workPanelTabs
  if (value === undefined || value === null) return { tabs: [], reason: null }
  if (!Array.isArray(value)) return { tabs: [], reason: 'workPanelTabs must be a list.' }
  if (value.length > PLUGIN_DESKTOP_ENTRIES_MAX) return { tabs: [], reason: 'invalid_entries' }
  const tabs: WorkPanelTabEntry[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return { tabs: [], reason: 'workPanelTabs entries must be objects.' }
    const id = item.id
    if (typeof id !== 'string' || !DESKTOP_ID.test(id)) return { tabs: [], reason: 'invalid_entry_id' }
    if (seen.has(id)) return { tabs: [], reason: 'duplicate_entry_id' }
    seen.add(id)
    if (!granted.has('ui.view')) return { tabs: [], reason: 'entry_permission_missing' }
    const renderer = item.renderer
    if (typeof renderer !== 'string' || !PLUGIN_DESKTOP_RENDERER_TOKEN.test(renderer)) {
      return { tabs: [], reason: 'invalid_entry_field' }
    }
    // A tab is not a window: the fields that describe one are refused here rather than ignored, the
    // same way they are on every other non-windowed list.
    if (
      (item.width !== undefined && item.width !== null) ||
      (item.height !== undefined && item.height !== null) ||
      (item.resizable !== undefined && item.resizable !== null)
    ) {
      return { tabs: [], reason: 'invalid_entry_field' }
    }
    const order = item.order
    if (order !== undefined && order !== null) {
      if (typeof order !== 'number' || !Number.isInteger(order) || order < 0 || order > PLUGIN_DESKTOP_ENTRY_ORDER_MAX) {
        return { tabs: [], reason: 'invalid_entry_field' }
      }
    }
    const icon = item.icon
    if (icon !== undefined && icon !== null && (typeof icon !== 'string' || !PLUGIN_DESKTOP_ICON_TOKEN.test(icon))) {
      return { tabs: [], reason: 'invalid_entry_field' }
    }
    const title = desktopLabels(item.title)
    if (title.invalid) return { tabs: [], reason: 'invalid_entry_field' }
    tabs.push({
      id,
      title: title.labels,
      order: typeof order === 'number' ? order : PLUGIN_DESKTOP_ENTRY_ORDER_DEFAULT,
      icon: typeof icon === 'string' ? icon : null,
      renderer,
    })
  }
  return { tabs, reason: null }
}

/** Whether one declared window dimension is a whole number inside its bounds. */
function panelSize(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/**
 * One locale's `settings` overrides: setting key → the label a form shows for it (spec §5.5).
 *
 * The keys are the engine's own setting keys, so nothing here compares them with the schema: a
 * manifest may name a key the plugin does not declare, and the page aligns the two when it renders
 * the form rather than the projection inventing a refusal. The text follows the same rule as the
 * other localised fields, and the keys are sorted and capped, so one manifest always produces one
 * payload.
 */
function desktopI18nSettings(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null
  const kept: Array<[string, string]> = []
  for (const key of Object.keys(value).sort()) {
    const text = value[key]
    if (typeof text !== 'string') continue
    const trimmed = text.trim()
    if (trimmed === '' || trimmed.length > PLUGIN_DESKTOP_I18N_TEXT_MAX) continue
    kept.push([key, trimmed])
  }
  if (kept.length === 0) return null
  const settings: Record<string, string> = {}
  for (const [key, text] of kept.slice(0, PLUGIN_DESKTOP_I18N_SETTINGS_MAX)) settings[key] = text
  return settings
}

/**
 * The desktop block's locale overrides, in a deterministic order.
 *
 * Only declarative text is read: a locale key that maps to an object, and the fields of that object
 * that are non-empty strings of a bounded length (`settings` is the same text one level down, a
 * label per setting key - `desktopI18nSettings`). Anything else inside a locale is dropped rather
 * than refused - a page falls back to `omp.name` / `omp.description` for a field the manifest does
 * not translate, which is exactly what a missing field means everywhere else - and locales are
 * sorted and capped, so one manifest always produces one payload.
 *
 * `invalid` is reserved for the shape the host cannot read at all: an `i18n` that is a list, a
 * scalar or a string. There is no field to fall back to there, so the block is refused like a
 * malformed permissions list is; guessing at what the author meant would be inventing a manifest.
 */
function desktopI18n(source: Record<string, unknown>): {
  readonly locales: Record<string, DesktopLocale> | null
  readonly invalid: boolean
} {
  const raw = source.i18n
  if (raw === undefined || raw === null) return { locales: null, invalid: false }
  if (!isRecord(raw)) return { locales: null, invalid: true }
  const kept: Array<[string, DesktopLocale]> = []
  for (const key of Object.keys(raw).sort()) {
    const value = raw[key]
    if (!isRecord(value)) continue
    const locale: DesktopLocale = {}
    for (const field of DESKTOP_I18N_FIELDS) {
      const text = value[field]
      if (typeof text !== 'string') continue
      const trimmed = text.trim()
      if (trimmed === '' || trimmed.length > PLUGIN_DESKTOP_I18N_TEXT_MAX) continue
      locale[field] = trimmed
    }
    const settings = desktopI18nSettings(value.settings)
    if (settings !== null) locale.settings = settings
    if (Object.keys(locale).length === 0) continue
    kept.push([key, locale])
  }
  const locales: Record<string, DesktopLocale> = {}
  for (const [key, locale] of kept.slice(0, PLUGIN_DESKTOP_I18N_LOCALES_MAX)) locales[key] = locale
  return { locales, invalid: false }
}

/**
 * The desktop range one block declares (`omp.desktop.engines.ompDesktop`, spec §3.2).
 *
 * `invalid` means the field is present in a shape this host cannot read at all - a non-object
 * `engines`, or a range that is not a non-empty bounded string - which refuses the block like a
 * malformed permissions list does. A block that names no range is the ordinary case and reports
 * `null`.
 */
function desktopEngines(raw: Record<string, unknown>): { readonly value: string | null; readonly invalid: boolean } {
  const engines = raw.engines
  if (engines === undefined || engines === null) return { value: null, invalid: false }
  if (!isRecord(engines)) return { value: null, invalid: true }
  const range = engines.ompDesktop
  if (range === undefined || range === null) return { value: null, invalid: false }
  if (typeof range !== 'string') return { value: null, invalid: true }
  const trimmed = range.trim()
  if (trimmed === '' || trimmed.length > PLUGIN_DESKTOP_ENGINES_MAX) return { value: null, invalid: true }
  return { value: trimmed, invalid: false }
}

/**
 * The themes one block contributes (spec §3.2, §4.2): a declared id, optional labels, the tokens
 * the theme sets, and the stylesheet + assets it may paint with.
 *
 * The token half is this application's own design tokens: both halves are checked against the shapes
 * the application publishes - a token name outside `--dsw-*` / `--omp-*` is an unknown property, and
 * a value outside the allow-list is a declaration the token was never meant to carry. The stylesheet
 * half is only shaped here (`css` is one package-relative `.css`, `assets` are bounded unique paths
 * with a served extension); the Rust boundary reads the bytes, sanitises the text and rewrites the
 * asset URLs. One bad field refuses the whole block rather than dropping the theme, for the same
 * reason a bad entry refuses a panel: a theme half applied is not the theme its author wrote.
 *
 * Two permissions, checked the way a panel's is: a manifest that contributes a theme without asking
 * for `ui.theme` is a privilege it did not declare, and a theme that injects a stylesheet or declares
 * assets without `ui.theme.css` is the content reach it did not declare either. The ids are unique
 * inside the list, and the list itself is capped (`PLUGIN_THEME_COUNT_MAX`) because the appearance
 * page draws one row per theme; over the cap the block is refused as `too_many_themes`.
 */
function desktopThemes(
  source: Record<string, unknown>,
  granted: ReadonlySet<string>,
): { readonly themes: ThemeView[]; readonly reason: string | null } {
  const value = source.themes
  if (value === undefined || value === null) return { themes: [], reason: null }
  if (!Array.isArray(value)) return { themes: [], reason: 'themes must be a list.' }
  // The count is a bound of its own (plan §5.1): the appearance page offers one row per theme, and a
  // list over the cap is refused whole rather than cut, the same answer every other over-cap list
  // here gets - the first eight of a nine-theme manifest is not what its author declared.
  if (value.length > PLUGIN_THEME_COUNT_MAX) return { themes: [], reason: 'too_many_themes' }
  if (value.length > 0 && !granted.has('ui.theme')) {
    return { themes: [], reason: 'entry_permission_missing' }
  }
  const themes: ThemeView[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return { themes: [], reason: 'themes entries must be objects.' }
    const id = item.id
    if (typeof id !== 'string' || !DESKTOP_ID.test(id)) return { themes: [], reason: 'invalid_entry_id' }
    if (seen.has(id)) return { themes: [], reason: 'duplicate_entry_id' }
    seen.add(id)
    const tokens = item.tokens
    if (!isRecord(tokens)) return { themes: [], reason: 'invalid_theme_tokens' }
    const entries = Object.keys(tokens).sort()
    if (entries.length === 0 || entries.length > PLUGIN_THEME_TOKEN_MAX) {
      return { themes: [], reason: 'invalid_theme_tokens' }
    }
    const kept: Record<string, string> = {}
    for (const name of entries) {
      const token = tokens[name]
      if (!PLUGIN_THEME_TOKEN_NAME.test(name)) return { themes: [], reason: 'invalid_theme_token_name' }
      if (typeof token !== 'string') return { themes: [], reason: 'invalid_theme_tokens' }
      const trimmed = token.trim()
      if (trimmed.length === 0 || trimmed.length > PLUGIN_THEME_VALUE_MAX) {
        return { themes: [], reason: 'invalid_theme_tokens' }
      }
      // A value that names a fetchable resource is refused outright rather than reasoned about: the
      // pattern already excludes the functions that could carry one, and this is the belt to that
      // brace - a token is a colour or a length, never a place to load something from.
      if (PLUGIN_THEME_VALUE_FORBIDDEN.test(trimmed)) return { themes: [], reason: 'invalid_theme_tokens' }
      if (!PLUGIN_THEME_TOKEN_VALUE.test(trimmed)) return { themes: [], reason: 'invalid_theme_tokens' }
      kept[name] = trimmed
    }
    const labels = desktopLabels(item.label)
    if (labels.invalid) return { themes: [], reason: 'invalid_themes' }
    const dark = item.dark
    if (dark !== undefined && dark !== null && typeof dark !== 'boolean') {
      return { themes: [], reason: 'invalid_themes' }
    }
    // `css`: one package-relative stylesheet. The shape is all this side can judge - the Rust
    // boundary reads the file, bounds its bytes and sanitises it, and replaces the field with the
    // text on the row a page sees (plan §5.2). A value outside the shape refuses the theme, because
    // a stylesheet the author meant is not one to drop quietly and leave a token-only theme.
    const css = item.css
    let stylesheet: string | null = null
    if (css !== undefined && css !== null) {
      if (typeof css !== 'string' || !safeRelativePath(css, PLUGIN_THEME_CSS_PATH_MAX) || !css.toLowerCase().endsWith('.css')) {
        return { themes: [], reason: 'invalid_theme_css' }
      }
      stylesheet = css
    }
    // `assets`: the files that stylesheet may reference, declared one by one. Unique, bounded, and
    // extensions this build serves - a duplicate or an extension the other half cannot serve is
    // refused rather than deduplicated, the same posture every other list here takes.
    const assets = item.assets
    const assetPaths: string[] = []
    if (assets !== undefined && assets !== null) {
      if (!Array.isArray(assets) || assets.length > PLUGIN_THEME_ASSETS_MAX) {
        return { themes: [], reason: 'invalid_theme_assets' }
      }
      const seenAssets = new Set<string>()
      for (const asset of assets) {
        if (
          typeof asset !== 'string' ||
          !safeRelativePath(asset, PLUGIN_THEME_ASSET_PATH_MAX) ||
          !themeAssetExtension(asset) ||
          seenAssets.has(asset)
        ) {
          return { themes: [], reason: 'invalid_theme_assets' }
        }
        seenAssets.add(asset)
        assetPaths.push(asset)
      }
    }
    // A theme that injects content asks for the content permission, separately from the token one
    // (spec §6.2): tokens are values this build understands, a stylesheet is content it has to
    // review. The whole block is refused rather than the theme, so a manifest that did not declare
    // the reach cannot have half of it honoured - the same answer a panel without `ui.panel` gets.
    if ((stylesheet !== null || assetPaths.length > 0) && !granted.has('ui.theme.css')) {
      return { themes: [], reason: 'entry_permission_missing' }
    }
    themes.push({
      id,
      label: labels.labels,
      dark: typeof dark === 'boolean' ? dark : null,
      tokens: kept,
      css: stylesheet,
      assets: assetPaths,
    })
  }
  return { themes, reason: null }
}

/**
 * The file scope one block declares (`omp.desktop.fs.read.scope`, spec §3.2).
 *
 * The patterns are the one part of a manifest this host does not resolve itself - the reading
 * happens in Rust, behind the bridge - so the rule here and the matcher there are *the same rule*
 * written twice: a `/`-separated relative pattern of at most `PLUGIN_FS_SCOPE_SEGMENTS_MAX`
 * segments, in which `*` stands inside one segment for any run of characters and a segment that is
 * exactly `**` stands for one or more whole segments, and nothing else is a wildcard. Everything a
 * second implementation could read differently is refused rather than guessed at: `?`, `[`, `{`,
 * `!`, a `.` or `..` segment, a leading or trailing `/`, `\`, `:`, control characters, and a `**`
 * that is not a segment of its own (`panel**` is refused, not read as "one star").
 *
 * A scope without the matching permission is refused too (spec §3.2): the permission is the switch
 * and the scope is the range, so a range nobody can use is a manifest this host cannot honour -
 * and a read with no scope is not "no reach", it is an undeclared reach.
 */
function desktopFsScope(
  raw: Record<string, unknown>,
  granted: Set<string>,
): { readonly scopes: DesktopFsScopes; readonly reason: string | null } {
  const empty: DesktopFsScopes = { read: [], write: [], delete: [] }
  const fs = raw.fs
  if (fs === undefined || fs === null) return { scopes: empty, reason: null }
  if (!isRecord(fs)) return { scopes: empty, reason: 'invalid_fs_scope' }
  const kept: { read: string[]; write: string[]; delete: string[] } = { read: [], write: [], delete: [] }
  for (const mode of ['read', 'write', 'delete'] as const) {
    const declared = fs[mode]
    if (declared === undefined || declared === null) continue
    if (!isRecord(declared)) return { scopes: empty, reason: 'invalid_fs_scope' }
    // `delete.own: true` narrows a delete to the files the plugin wrote itself, which needs a write
    // ledger this build does not keep. A declaration this host cannot honour is refused rather than
    // read as a plain scope: the plugin would otherwise be granted a reach it did not ask for.
    if (mode === 'delete' && declared.own !== undefined && declared.own !== null && declared.own !== false) {
      return { scopes: empty, reason: 'unsupported_fs_own' }
    }
    const list = declared.scope
    if (list === undefined || list === null) continue
    if (!Array.isArray(list)) return { scopes: empty, reason: 'invalid_fs_scope' }
    // The permission is the switch and the scope is the range, so a range nobody can use is a
    // manifest this host cannot honour (spec §3.2).
    if (!granted.has(`fs.${mode}`)) return { scopes: empty, reason: 'fs_permission_missing' }
    for (const item of list) {
      if (typeof item !== 'string') return { scopes: empty, reason: 'invalid_fs_scope' }
      const pattern = item.trim()
      if (!fsScopePattern(pattern)) return { scopes: empty, reason: 'invalid_fs_scope' }
      // Changing or removing a whole tree is not a range (spec §3.2): a plugin that may do that has
      // no scope at all, and the pattern that says so is refused rather than honoured.
      if (mode !== 'read' && FS_SCOPE_WHOLE_TREE[pattern] === true) {
        return { scopes: empty, reason: 'whole_tree_fs_scope' }
      }
      if (!kept[mode].includes(pattern)) kept[mode].push(pattern)
    }
    if (kept[mode].length > PLUGIN_FS_SCOPE_MAX) return { scopes: empty, reason: 'invalid_fs_scope' }
  }
  return { scopes: { read: kept.read, write: kept.write, delete: kept.delete }, reason: null }
}

/** The patterns that name a whole tree, which only a *read* scope may be (spec §3.2). */
const FS_SCOPE_WHOLE_TREE: Record<string, true> = {
  '**': true,
  '**/*': true,
  '*/**': true,
  './*': true,
}

/** The characters a scope pattern may never contain: path syntax, glob syntax the matcher lacks, and shell punctuation. */
const FS_SCOPE_FORBIDDEN: Record<string, true> = Object.fromEntries(
  ['?', '[', ']', '{', '}', '!', '\\', ':', '<', '>', '"', '|', "'", '`', ';', '&', '$', '%'].map(character => [character, true] as const),
)

/**
 * Whether one entry of `net.domains` is a host name this build would compare against.
 *
 * The rule is the Rust side's (`services::plugins::gates::is_host_name`), written the same way on
 * purpose: ASCII letters, digits, `-` and `.`, labels of 1..63 characters that do not begin or end in
 * a hyphen, 253 characters in all, and no trailing dot. A scheme, a path, a port, a wildcard or a
 * Unicode name is an entry the exact comparison at egress could never match.
 */
function isHostName(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253 || domain.endsWith('.')) return false
  return domain.split('.').every(label =>
    label.length > 0
    && label.length <= 63
    && !label.startsWith('-')
    && !label.endsWith('-')
    && /^[A-Za-z0-9-]+$/.test(label),
  )
}

/**
 * Whether one scope pattern is one both sides read the same way (see [`desktopFsScope`]).
 *
 * The check is a loop rather than a regular expression because the rule is about *segments*: `*`
 * alone is a star, `**` alone is the multi-segment star, and any other spelling of a star is a
 * pattern whose meaning two implementations would have to agree on by convention.
 */
function fsScopePattern(pattern: string): boolean {
  // Counted in code points, not UTF-16 units: the Rust side bounds the same string by characters,
  // and two bounds that disagree are a manifest whose verdict depends on which side read it.
  if (pattern.length === 0 || [...pattern].length > PLUGIN_FS_SCOPE_PATTERN_MAX) return false
  if (pattern.startsWith('/') || pattern.endsWith('/')) return false
  const segments = pattern.split('/')
  if (segments.length > PLUGIN_FS_SCOPE_SEGMENTS_MAX) return false
  for (const segment of segments) {
    if (segment === '') return false
    if (segment === '**') continue
    if (segment === '.' || segment === '..') return false
    if (segment.includes('**')) return false
    for (const character of segment) {
      if (character === '*') continue
      const code = character.codePointAt(0) ?? 0
      // C0, DEL and the C1 range (U+0080-U+009F): `char::is_control` on the Rust side rejects all
      // three, so this side does too.
      if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false
      if (FS_SCOPE_FORBIDDEN[character] === true) return false
    }
  }
  return true
}

/**
 * The desktop block, projected for the page.
 *
 * `null` means the manifest declares none - the ordinary case for an engine-only plugin. A block
 * that could not be parsed at all is reported through the row's `desktopError`, and a block that
 * parsed but failed a rule keeps every declared permission (the consent gate needs those facts)
 * while its entry lists are emptied: nothing about a refused block may load.
 */
export function desktopOf(manifest: Record<string, unknown>, root: string): { desktop: DesktopView | null; error: string | null } {
  const raw = manifest.desktop
  if (raw === undefined || raw === null) return { desktop: null, error: null }
  if (!isRecord(raw)) return { desktop: null, error: 'The omp.desktop block is not an object.' }

  const schemaVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  const declaredPermissions = raw.permissions
  const permissions = manifestList(raw, 'permissions')
  const net = isRecord(raw.net) ? manifestList(raw.net, 'domains').filter(isHostName) : []
  // `net.anyHost` is read before the rules run so a refused block still reports it, exactly like the
  // domain list: a flag of the wrong shape is a value this host cannot read, and a flag this host
  // cannot read is refused rather than read as false (a manifest whose widening was silently dropped
  // would be a plugin whose calls fail for a reason nobody can see).
  const declaredAnyHost = isRecord(raw.net) ? raw.net.anyHost : undefined
  const netAnyHost = declaredAnyHost === true
  // Parsed before the rules are applied: a refused block still reports its display text, which is
  // what a reader needs to recognise the plugin they are looking at, and nothing about it can load.
  const i18n = desktopI18n(raw)
  const engines = desktopEngines(raw)
  const refused = (reason: string): DesktopView => ({
    schemaVersion,
    valid: false,
    reason,
    panels: [],
    views: [],
    settingsDestinations: [],
    sidebarTabs: [],
    workPanelTabs: [],
    process: null,
    renderer: null,
    permissions,
    netDomains: net,
    netAnyHost,
    fsScopes: { read: [], write: [], delete: [] },
    themes: [],
    i18n: i18n.locales,
    enginesOmpDesktop: engines.value,
  })

  if (schemaVersion !== 1) return { desktop: refused('unsupported_desktop_schema'), error: null }
  // A permissions field that is present but not a list is refused rather than read as "none": the
  // page would otherwise show a plugin that says it asks for something as asking for nothing.
  if (declaredPermissions !== undefined && declaredPermissions !== null && !Array.isArray(declaredPermissions)) {
    return { desktop: refused('invalid_permissions'), error: null }
  }
  if (permissions.some(name => DESKTOP_PERMISSIONS[name] !== true)) {
    return { desktop: refused('unknown_permission'), error: null }
  }
  // The domain list has two failures with two answers. A `net` block - or a `domains` field - of a
  // shape this host cannot read is refused whole, like a malformed permissions list: the plugin
  // would otherwise be listed as asking for a reach this build cannot even describe. An *entry*
  // that is not a host name is dropped instead, and the rest of the list stands: egress compares
  // names exactly (`host/src/constants.ts`), so an entry that is not one could never match, and
  // dropping it loses reach rather than adding any - the same answer the Rust side gives the same
  // entry when the row reaches it (`services::plugins::gates::is_host_name`).
  if (raw.net !== undefined && raw.net !== null && !isRecord(raw.net)) {
    return { desktop: refused('invalid_net_domains'), error: null }
  }
  const declaredDomains = isRecord(raw.net) ? raw.net.domains : undefined
  if (declaredDomains !== undefined && declaredDomains !== null && !Array.isArray(declaredDomains)) {
    return { desktop: refused('invalid_net_domains'), error: null }
  }
  // The second key is two keys: the flag has to be a boolean, and the block has to declare
  // `net.anyHost`. A flag of another type is refused rather than read as false, and a flag without
  // the permission is refused rather than honoured - a widening nobody declared is exactly what this
  // permission exists to make impossible to write by accident.
  if (declaredAnyHost !== undefined && declaredAnyHost !== null && typeof declaredAnyHost !== 'boolean') {
    return { desktop: refused('invalid_net_any_host'), error: null }
  }
  if (netAnyHost && !permissions.includes('net.anyHost')) {
    return { desktop: refused('invalid_net_any_host'), error: null }
  }
  // `locales` is null exactly when the shape was unusable, so this refusal reports no localisation.
  if (i18n.invalid) return { desktop: refused('invalid_i18n'), error: null }
  if (engines.invalid) return { desktop: refused('invalid_engines'), error: null }
  // The one place the desktop range decides anything (spec §3.2): a range this build does not
  // satisfy - or one it cannot read, which is the same answer on purpose - refuses the block, and
  // the plugin's engine part is untouched by that. Failing open here would load a desktop UI whose
  // author asked for a contract this build never claimed to have.
  if (engines.value !== null && satisfiesRange(engines.value, PLUGIN_DESKTOP_API_VERSION) !== true) {
    return { desktop: refused('unsupported_engine_range'), error: null }
  }
  const granted = new Set(permissions)
  // The scope is checked after the permission set is known, because a scope without `fs.read` is a
  // reach this host cannot honour (see [`desktopFsScope`]).
  const fsScope = desktopFsScope(raw, granted)
  if (fsScope.reason !== null) return { desktop: refused(fsScope.reason), error: null }
  const panels = desktopEntries(raw, 'panels', root, 'ui.panel', granted, true)
  const views = desktopEntries(raw, 'views', root, 'ui.view', granted, false)
  const destinations = desktopEntries(raw, 'settingsDestinations', root, 'ui.settings', granted, false)
  const tabs = desktopEntries(raw, 'sidebarTabs', root, 'ui.tab', granted, false)
  for (const failure of [panels, views, destinations, tabs]) {
    if (failure.reason !== null) return { desktop: refused(failure.reason), error: null }
  }
  const workPanelTabs = desktopWorkPanelTabs(raw, granted)
  if (workPanelTabs.reason !== null) return { desktop: refused(workPanelTabs.reason), error: null }
  const themes = desktopThemes(raw, granted)
  if (themes.reason !== null) return { desktop: refused(themes.reason), error: null }
  // The process block is parsed after the permission set is known only so the cost is paid once;
  // it declares no host-enforced permission (see [`desktopProcess`]).
  const processBlock = desktopProcess(raw)
  if (processBlock.reason !== null) return { desktop: refused(processBlock.reason), error: null }
  // The slot module (plan §7.1) is the one declaration whose code runs in the application document,
  // so its shapes and its permission are decided before anything else is projected: a manifest that
  // declared a module without asking for `renderer.extension` has no half of it honoured.
  const rendererBlock = desktopRenderer(raw, granted)
  if (rendererBlock.reason !== null) return { desktop: refused(rendererBlock.reason), error: null }
  // An id names one entry inside one plugin: a duplicate would make two panels indistinguishable to
  // every later message that addresses one of them.
  const ids = [
    ...panels.entries.map(entry => entry.id),
    ...views.entries.map(entry => entry.id),
    ...destinations.entries.map(entry => entry.id),
    ...tabs.entries.map(entry => entry.id),
    ...workPanelTabs.tabs.map(entry => entry.id),
    ...themes.themes.map(theme => theme.id),
  ]
  if (new Set(ids).size !== ids.length) return { desktop: refused('duplicate_entry_id'), error: null }

  return {
    desktop: {
      schemaVersion,
      valid: true,
      reason: null,
      panels: panels.entries,
      views: views.entries,
      settingsDestinations: destinations.entries,
      sidebarTabs: tabs.entries,
      workPanelTabs: workPanelTabs.tabs,
      process: processBlock.view,
      renderer: rendererBlock.view,
      permissions,
      netDomains: net,
      netAnyHost,
      fsScopes: fsScope.scopes,
      themes: themes.themes,
      i18n: i18n.locales,
      enginesOmpDesktop: engines.value,
    },
    error: null,
  }
}

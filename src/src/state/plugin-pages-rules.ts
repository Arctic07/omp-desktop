/**
 * Pure projection rules for plugin-contributed desktop surfaces.
 *
 * This file deliberately has no React, resource store or IPC dependency. The host list is the input;
 * the output is the stable page identity and the placement lists. Keeping that seam pure makes the
 * compatibility rules testable without starting the desktop shell.
 */

import type {
  EngineDesktopPage,
  EngineWorkPanelTab,
  PluginRow,
} from '../api/plugins-types'
import type { Language } from '../lib/i18n'
import { pluginDisplayName, pluginPageTitle } from './plugin-text.ts'

/** Where one declared page lands. */
export type PluginPageKind = 'view' | 'sidebar' | 'settings' | 'panel'

/** One page a plugin contributes, as every surface addresses it. */
export interface PluginPageRef {
  key: string
  kind: PluginPageKind
  pluginKey: string
  pluginId: string
  scope: string
  pluginName: string
  pageId: string
  title: string
  icon: string | null
  url: string
  order: number
  width: number | null
  height: number | null
  resizable: boolean
  /** Whether the row is a plugin this application ships with (the host's verified mark). */
  builtin: boolean
}

/** One host-rendered work-panel contribution. */
export interface PluginWorkTabRef {
  key: string
  pluginKey: string
  pluginId: string
  scope: string
  pluginName: string
  pageId: string
  title: string
  icon: string | null
  order: number
  renderer: string
}

/** All page kinds and host-rendered entries for one list read. */
export interface PluginPages {
  sidebar: PluginPageRef[]
  views: PluginPageRef[]
  settings: PluginPageRef[]
  panels: PluginPageRef[]
  workTabs: PluginWorkTabRef[]
}

/**
 * Which plugin-contributed tools this build can offer right now.
 *
 * The terminal's tab exists while a `workPanelTabs[]` entry names the `terminal` renderer (the page
 * the host validated), read from the same projection the surfaces are drawn from, so a switch in
 * Settings and a menu row cannot disagree. The browser is a first-party surface of this
 * application, not a plugin contribution, so it is always available.
 */
export function toolAvailability(pages: PluginPages): { terminal: boolean; browser: boolean } {
  return {
    terminal: pages.workTabs.some((tab) => tab.renderer === 'terminal'),
    browser: true,
  }
}

/** The plugin renderers this build serves; unknown renderers are additive and safely ignored. The
 * browser is not one of them: its tab is first-party, so a plugin declaration cannot claim it. */
const SERVED_RENDERERS: Readonly<Record<string, true>> = { terminal: true }
const KEY_SEPARATOR = '\u0000'

/** The page identity used by panel-store and the page registry. */
export function pluginPageKey(pluginKey: string, kind: PluginPageKind, pageId: string): string {
  return `${pluginKey}${KEY_SEPARATOR}${kind}${KEY_SEPARATOR}${pageId}`
}

/** Resolve a stored page key against the current list; a removed page returns null. */
export function pageForKey(pages: PluginPages, key: string): PluginPageRef | null {
  for (const page of pages.views) if (page.key === key) return page
  for (const page of pages.sidebar) if (page.key === key) return page
  for (const page of pages.settings) if (page.key === key) return page
  for (const page of pages.panels) if (page.key === key) return page
  return null
}

function byOrder(left: { order: number; title: string }, right: { order: number; title: string }): number {
  return left.order - right.order || left.title.localeCompare(right.title)
}

/** Convert one host page entry to a loadable page, or null when the host withheld its URL. */
function pageOf(
  row: PluginRow,
  kind: PluginPageKind,
  page: EngineDesktopPage,
  language: Language,
): PluginPageRef | null {
  if (page.url === null) return null
  const pluginKey = row.id + KEY_SEPARATOR + row.scope
  return {
    key: pluginPageKey(pluginKey, kind, page.id),
    kind,
    pluginKey,
    pluginId: row.id,
    scope: row.scope,
    pluginName: pluginDisplayName(row, language),
    pageId: page.id,
    title: pluginPageTitle(page, row, language),
    icon: page.icon,
    url: page.url,
    order: page.order,
    width: page.width,
    height: page.height,
    resizable: page.resizable === true,
    builtin: row.builtin,
  }
}

/** Project one page list and sort it by the manifest's order, then its resolved title. */
function pagesOf(
  row: PluginRow,
  kind: PluginPageKind,
  declared: readonly EngineDesktopPage[],
  language: Language,
): PluginPageRef[] {
  return declared
    .map((page) => pageOf(row, kind, page, language))
    .filter((page): page is PluginPageRef => page !== null)
    .sort(byOrder)
}

/** Keep only renderer tokens this build can draw. */
function workTabsOf(row: PluginRow, declared: readonly EngineWorkPanelTab[], language: Language): PluginWorkTabRef[] {
  const pluginKey = row.id + KEY_SEPARATOR + row.scope
  const rows: PluginWorkTabRef[] = []
  for (const tab of declared) {
    if (SERVED_RENDERERS[tab.renderer] !== true) continue
    rows.push({
      key: pluginPageKey(pluginKey, 'view', tab.id),
      pluginKey,
      pluginId: row.id,
      scope: row.scope,
      pluginName: pluginDisplayName(row, language),
      pageId: tab.id,
      title: pluginPageTitle(tab, row, language),
      icon: tab.icon,
      order: tab.order,
      renderer: tab.renderer,
    })
  }
  return rows.sort(byOrder)
}

/**
 * Project all enabled, valid desktop contributions. A disabled or invalid plugin never offers a
 * URL, and a missing URL never becomes a clickable entry; engine-side capabilities remain intact.
 */
export function pluginPagesOf(rows: readonly PluginRow[], language: Language): PluginPages {
  const pages: PluginPages = { sidebar: [], views: [], settings: [], panels: [], workTabs: [] }
  for (const row of rows) {
    const desktop = row.desktop
    if (!row.enabled || desktop === null || !desktop.valid) continue
    pages.sidebar.push(...pagesOf(row, 'sidebar', desktop.sidebarTabs, language))
    pages.views.push(...pagesOf(row, 'view', desktop.views, language))
    pages.settings.push(...pagesOf(row, 'settings', desktop.settingsDestinations, language))
    pages.panels.push(...pagesOf(row, 'panel', desktop.panels, language))
    pages.workTabs.push(...workTabsOf(row, desktop.workPanelTabs, language))
  }
  return pages
}

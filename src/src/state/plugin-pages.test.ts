import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PluginRow } from '../api/plugins-types'
import { pageForKey, pluginPagesOf, toolAvailability } from './plugin-pages-rules.ts'

function row(overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: 'sample',
    installId: 'sample@local',
    name: 'Sample',
    description: 'A sample plugin',
    version: '1.0.0',
    scope: 'user',
    enabled: true,
    builtin: false,
    toggleable: true,
    shadowedBy: null,
    source: {
      kind: 'marketplace',
      label: 'sample@local',
      gitCommitSha: null,
      marketplace: 'local',
      installId: 'sample@local',
      installed: true,
    },
    sources: [
      { marketplace: 'local', version: '1.0.0', sourceLabel: 'local', installed: true },
    ],
    installedAt: null,
    lastUpdated: null,
    consent: { required: false, reasons: [] },
    code: {
      extensions: 0,
      baseTools: false,
      baseHooks: false,
      hooksDir: false,
      toolsDir: false,
      mcpConfig: false,
      skillsDir: false,
      commandsDir: false,
      agentsDir: false,
      rulesDir: false,
      promptsDir: false,
      lspConfig: false,
      dapConfig: false,
    },
    settings: { keys: [], hasSecret: false },
    features: [],
    desktop: {
      schemaVersion: 1,
      valid: true,
      reason: null,
      panels: [],
      views: [],
      settingsDestinations: [],
      sidebarTabs: [],
      workPanelTabs: [],
      permissions: ['ui.panel', 'ui.view', 'ui.settings', 'ui.tab'],
      netDomains: [],
      fsScopes: { read: [], write: [], delete: [] },
      themes: [],
      enginesOmpDesktop: null,
      i18n: {
        zh: { name: '示例插件', description: '示例说明' },
      },
    },
    desktopError: null,
    ...overrides,
  }
}

function page(id: string, title: string, url: string) {
  return {
    id,
    title: { en: title, zh: `中${title}` },
    entry: `desktop/${id}.html`,
    order: 10,
    width: null,
    height: null,
    resizable: null,
    icon: 'folder',
    url,
  }
}

test('projects enabled page entries once, with locale titles and stable installation keys', () => {
  const input = row({
    desktop: {
      ...row().desktop!,
      sidebarTabs: [page('sidebar', 'Sidebar', 'omp-plugin://key/sidebar.html')],
      views: [page('view', 'View', 'omp-plugin://key/view.html')],
      settingsDestinations: [page('settings', 'Settings', 'omp-plugin://key/settings.html')],
      panels: [page('panel', 'Panel', 'omp-plugin://key/panel.html')],
      workPanelTabs: [
        { id: 'terminal', title: { en: 'Terminal', zh: '终端' }, order: 20, icon: 'terminal', renderer: 'terminal' },
        { id: 'unknown', title: { en: 'Unknown' }, order: 30, icon: null, renderer: 'future' },
      ],
    },
  })

  const projected = pluginPagesOf([input], 'zh')
  assert.equal(projected.sidebar[0]?.title, '中Sidebar')
  assert.equal(projected.views[0]?.pluginName, '示例插件')
  assert.equal(projected.settings[0]?.title, '中Settings')
  assert.equal(projected.panels[0]?.title, '中Panel')
  assert.deepEqual(projected.workTabs.map((entry) => entry.renderer), ['terminal'])
  const view = projected.views[0]
  assert.ok(view)
  assert.equal(pageForKey(projected, view.key), view)
  assert.equal(view.key.includes('sample\u0000user\u0000view\u0000view'), true)
})

test('disabled, invalid and URL-less desktop pages contribute no UI entry', () => {
  const disabled = row({ enabled: false })
  const invalid = row({ desktop: { ...row().desktop!, valid: false } })
  const noUrl = row({
    desktop: {
      ...row().desktop!,
      views: [{ ...page('view', 'View', 'omp-plugin://key/view.html'), url: null }],
    },
  })

  assert.deepEqual(pluginPagesOf([disabled, invalid, noUrl], 'en'), {
    sidebar: [],
    views: [],
    settings: [],
    panels: [],
    workTabs: [],
  })
})

test('availability follows the served contributions, not the build', () => {
  const terminal = row({
    id: 'omp.terminal',
    installId: 'omp.terminal@omp-desktop-builtin',
    builtin: true,
    toggleable: false,
    desktop: {
      ...row().desktop!,
      permissions: ['ui.view'],
      workPanelTabs: [
        { id: 'terminal', title: { en: 'Terminal' }, order: 30, icon: 'terminal', renderer: 'terminal' },
      ],
    },
  })
  const unavailableRenderer = row({
    id: 'future',
    installId: 'future@local',
    desktop: {
      ...row().desktop!,
      permissions: ['ui.view'],
      workPanelTabs: [
        { id: 'future', title: { en: 'Future' }, order: 30, icon: null, renderer: 'future' },
      ],
    },
  })

  assert.deepEqual(toolAvailability(pluginPagesOf([terminal], 'en')), {
    terminal: true,
    browser: true,
  })
  // A renderer this build does not serve is dropped, so it must not report the terminal as present.
  // The browser does not live behind a plugin at all, so it stays served in every projection.
  assert.deepEqual(toolAvailability(pluginPagesOf([unavailableRenderer], 'en')), {
    terminal: false,
    browser: true,
  })
  assert.deepEqual(toolAvailability(pluginPagesOf([], 'en')), { terminal: false, browser: true })
})

test('page keys follow the plugin and its scope, never the marketplace it came from', () => {
  const view = page('view', 'View', 'omp-plugin://key/view.html')
  const fromMarketA = row({
    installId: 'sample@market-a',
    source: {
      kind: 'marketplace',
      label: 'sample@market-a',
      gitCommitSha: null,
      marketplace: 'market-a',
      installId: 'sample@market-a',
      installed: true,
    },
    desktop: { ...row().desktop!, views: [view] },
  })
  const fromMarketB = row({
    installId: 'sample@market-b',
    source: {
      kind: 'marketplace',
      label: 'sample@market-b',
      gitCommitSha: null,
      marketplace: 'market-b',
      installId: 'sample@market-b',
      installed: true,
    },
    desktop: { ...row().desktop!, views: [view] },
  })

  // The host merges one plugin id into one row per scope, so a switch of marketplace cannot make
  // the shell believe a second page appeared (or lose the one the reader had open).
  assert.equal(
    pluginPagesOf([fromMarketA], 'en').views[0]?.key,
    pluginPagesOf([fromMarketB], 'en').views[0]?.key,
  )
  assert.equal(pluginPagesOf([fromMarketA], 'en').views[0]?.pluginId, 'sample')
})

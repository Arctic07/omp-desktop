import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EngineMarketplaceRow, MarketplacePluginRow, PluginRow } from '../api/plugins-types'
import {
  BUILTIN_MARKETPLACE_NAME,
  BUILTIN_MARKETPLACE_SOURCE,
  filterMarketEntries,
  installedForEntry,
  isBuiltinMarketplace,
  marketEntryView,
  marketplaceEntries,
  orderMarketplaces,
} from './plugin-market.ts'

/**
 * The market page's pure rules.
 *
 * What is pinned down here: the built-in marketplace is the first source whatever order the registry
 * reports, a marketplace name is a unique key, a query searches the four published fields, and an
 * entry's "installed" state is the user-scope installation its `name@marketplace` handle names —
 * not a project copy that shadows it.
 */

function marketplace(
  name: string,
  sourceUri = name === BUILTIN_MARKETPLACE_NAME ? BUILTIN_MARKETPLACE_SOURCE : `owner/${name}`,
): EngineMarketplaceRow {
  return { name, sourceUri }
}

function entry(overrides: Partial<MarketplacePluginRow> = {}): MarketplacePluginRow {
  return {
    name: 'sample',
    marketplace: 'market-a',
    description: 'A sample plugin',
    version: '1.0.0',
    author: 'Sample Author',
    homepage: null,
    repository: null,
    license: null,
    category: 'development',
    tags: ['testing'],
    source: './sample',
    ...overrides,
  }
}

function row(overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: 'sample',
    installId: 'sample@market-a',
    name: 'sample',
    description: null,
    version: '1.0.0',
    scope: 'user',
    enabled: true,
    builtin: false,
    toggleable: true,
    shadowedBy: null,
    source: {
      kind: 'marketplace',
      label: 'sample@market-a',
      gitCommitSha: null,
      marketplace: 'market-a',
      installId: 'sample@market-a',
      installed: true,
    },
    sources: [],
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
    desktop: null,
    desktopError: null,
    ...overrides,
  }
}

test('the built-in marketplace is the first source and names are unique', () => {
  const ordered = orderMarketplaces([
    marketplace('market-a'),
    marketplace(BUILTIN_MARKETPLACE_NAME),
    marketplace('market-b'),
    marketplace('market-a'),
  ])
  assert.deepEqual(
    ordered.map((item) => item.name),
    [BUILTIN_MARKETPLACE_NAME, 'market-a', 'market-b'],
  )
  assert.equal(
    isBuiltinMarketplace({ name: BUILTIN_MARKETPLACE_NAME, sourceUri: BUILTIN_MARKETPLACE_SOURCE }),
    true,
  )
  assert.equal(
    isBuiltinMarketplace({
      name: BUILTIN_MARKETPLACE_NAME,
      sourceUri: `https://github.com/${BUILTIN_MARKETPLACE_SOURCE}.git`,
    }),
    true,
  )
  assert.equal(
    isBuiltinMarketplace({
      name: BUILTIN_MARKETPLACE_NAME,
      sourceUri: 'https://github.com/someone/else',
    }),
    false,
  )
  assert.equal(isBuiltinMarketplace({ name: 'market-a', sourceUri: 'owner/market-a' }), false)
})

test('the reserved bundle marketplace and missing local sources are not browsable', () => {
  const rows = [
    marketplace('omp-desktop-builtin', 'C:\\bundle'),
    { ...marketplace('market-a', 'D:\\gone\\market-a'), available: false },
    { ...marketplace('market-b', 'D:\\present\\market-b'), available: true },
    marketplace('claude-plugins-official'),
  ]
  assert.deepEqual(
    orderMarketplaces(rows).map((item) => item.name),
    ['claude-plugins-official', 'market-b'],
  )
})

test('a marketplace keeps the registry order when it is already first', () => {
  const ordered = orderMarketplaces([marketplace('market-a'), marketplace('market-b')])
  assert.deepEqual(
    ordered.map((item) => item.name),
    ['market-a', 'market-b'],
  )
})

test('the query searches the four published fields and stays inside one marketplace', () => {
  const entries = [
    entry({ name: 'alpha', marketplace: 'market-a', description: 'First', tags: [] }),
    entry({ name: 'beta', marketplace: 'market-a', category: 'testing' }),
    entry({ name: 'gamma', marketplace: 'market-a', tags: ['security'] }),
    entry({ name: 'delta', marketplace: 'market-b' }),
  ]
  assert.deepEqual(
    marketplaceEntries(entries, 'market-a', 'SECURITY').map((item) => item.name),
    ['gamma'],
  )
  assert.deepEqual(
    marketplaceEntries(entries, 'market-a', 'testing').map((item) => item.name),
    ['beta'],
  )
  assert.deepEqual(
    marketplaceEntries(entries, 'market-a', '').map((item) => item.name),
    ['alpha', 'beta', 'gamma'],
  )
  assert.deepEqual(
    filterMarketEntries(entries, 'first').map((item) => item.name),
    ['alpha'],
  )
})

test('an entry view trims what it publishes and spells the install handle', () => {
  const view = marketEntryView(
    entry({
      description: '  words  ',
      version: '  1.2.3 ',
      tags: [' ok ', ''],
      category: null,
    }),
  )
  assert.equal(view.description, 'words')
  assert.equal(view.version, '1.2.3')
  assert.equal(view.category, '')
  assert.deepEqual(view.tags, [' ok '])
  assert.equal(view.installId, 'sample@market-a')
})

test('a retired built-in entry never reaches a card', () => {
  const entries = [
    entry({ name: 'omp.browser', marketplace: 'omp-desktop-builtin' }),
    entry({ name: 'omp.terminal', marketplace: 'omp-desktop-builtin' }),
  ]
  assert.deepEqual(
    marketplaceEntries(entries, 'omp-desktop-builtin', '').map((item) => item.name),
    ['omp.terminal'],
  )
  assert.deepEqual(
    filterMarketEntries(entries, 'browser').map((item) => item.name),
    [],
  )
})

test('installed state is the install handle at the scope the page is showing', () => {
  const project = row({ scope: 'project' })
  const user = row()
  assert.equal(installedForEntry(entry(), [project]), null)
  assert.equal(installedForEntry(entry(), [project, user]), user)
  assert.equal(installedForEntry(entry(), [project, user], 'project'), project)
  assert.equal(installedForEntry(entry({ name: 'other' }), [user]), null)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CodeFacts, PluginCandidate } from './plugins-rows.ts'
import { mergeCandidates, pluginIdOf } from './plugins-rows.ts'
import type { PluginCatalog } from './plugins-market.ts'

/**
 * Row identity and the source projection (plan §4.1): the engine's `name@marketplace` becomes the
 * install handle, the plugin's own id becomes the row key, and every other record of the same plugin
 * stays visible as a source.
 *
 * These tests do not load the engine - they cannot, the seam check forbids it - so `parse` is the
 * engine's documented rule (`marketplace/types.ts::parsePluginId`: split at the last `@`, reject an
 * empty segment on either side). The production caller passes `sdk.parsePluginId` itself, so the
 * rule under test is the contract, and the id shapes here are the ones the engine's registry holds.
 */

/** The engine's `parsePluginId`, restated for a test that must stay free of the engine. */
function parsePluginId(id: string): { name: string; marketplace: string } | null {
  const at = id.lastIndexOf('@')
  if (at <= 0 || at === id.length - 1) return null
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) }
}

/** A plugin that ships no code: the facts a merge never changes, and nothing that runs. */
const NO_CODE: CodeFacts = {
  extensions: 0,
  baseTools: false,
  baseHooks: false,
  hooksDir: false,
  toolsDir: false,
  mcpConfig: false,
  lspConfig: false,
  dapConfig: false,
  skillsDir: false,
  commandsDir: false,
  agentsDir: false,
  rulesDir: false,
  promptsDir: false,
}

/** One install record as `plugins-facts.ts` builds it, with only the fields a merge depends on. */
function candidate(fields: {
  pluginId: string
  installId: string | null
  marketplace: string | null
  scope?: 'user' | 'project'
  enabled?: boolean
  lastUpdated?: string | null
  version?: string
}): PluginCandidate {
  const scope = fields.scope ?? 'user'
  const version = fields.version ?? '1.0.0'
  return {
    pluginId: fields.pluginId,
    installId: fields.installId,
    scope,
    name: fields.pluginId,
    description: null,
    version,
    enabled: fields.enabled ?? true,
    shadowedBy: null,
    installedAt: null,
    lastUpdated: fields.lastUpdated ?? null,
    rootPath: `/plugins/${fields.installId ?? fields.pluginId}`,
    consent: { required: false, reasons: [] },
    code: NO_CODE,
    settings: { keys: [], hasSecret: false },
    desktop: null,
    desktopError: null,
    source: {
      kind: fields.marketplace === null ? 'npm' : 'marketplace',
      label: fields.installId ?? fields.pluginId,
      gitCommitSha: null,
      marketplace: fields.marketplace,
      installId: fields.installId,
      installed: true,
    },
  }
}

/** A catalog as `readPluginCatalog` returns it: one entry per marketplace that lists the plugin. */
function catalogOf(entries: Record<string, Array<[string, string]>>): PluginCatalog {
  const catalog = new Map<string, Array<{ marketplace: string; version: string }>>()
  for (const [pluginId, versions] of Object.entries(entries)) {
    catalog.set(
      pluginId,
      versions.map(([marketplace, version]) => ({ marketplace, version })),
    )
  }
  return catalog
}

test('an install handle collapses to the plugin id and stays as the handle', () => {
  assert.equal(pluginIdOf(parsePluginId, 'demo-plugin@market-a'), 'demo-plugin')
  assert.equal(pluginIdOf(parsePluginId, 'demo-plugin'), 'demo-plugin')
  // A scoped package name is not a handle: the engine's parser rejects an empty first segment.
  assert.equal(pluginIdOf(parsePluginId, '@scope/pkg'), '@scope/pkg')

  const rows = mergeCandidates(
    [candidate({ pluginId: 'demo-plugin', installId: 'demo-plugin@market-a', marketplace: 'market-a', version: '0.4.2' })],
    catalogOf({}),
  )
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row?.id, 'demo-plugin')
  assert.equal(row?.installId, 'demo-plugin@market-a')
  assert.equal(row?.source.kind, 'marketplace')
  assert.equal(row?.source.marketplace, 'market-a')
  assert.equal(row?.source.installId, 'demo-plugin@market-a')
  assert.equal(row?.source.installed, true)
  assert.equal(row?.version, '0.4.2')
})

test('two marketplaces supplying one plugin produce one row and two sources', () => {
  const rows = mergeCandidates(
    [
      candidate({ pluginId: 'demo', installId: 'demo@market-a', marketplace: 'market-a', lastUpdated: '2026-01-01T00:00:00Z', version: '0.4.2' }),
      candidate({ pluginId: 'demo', installId: 'demo@market-b', marketplace: 'market-b', lastUpdated: '2026-02-01T00:00:00Z', version: '0.5.0' }),
    ],
    catalogOf({ demo: [['market-b', '0.5.0'], ['market-a', '0.4.2']] }),
  )

  assert.equal(rows.length, 1)
  const row = rows[0]
  // The newest enabled record is the row; the older one is a source that is not the active install.
  assert.equal(row?.installId, 'demo@market-b')
  assert.equal(row?.version, '0.5.0')
  assert.deepEqual(row?.sources, [
    { marketplace: 'market-a', version: '0.4.2', sourceLabel: 'demo@market-a', installed: false },
    { marketplace: 'market-b', version: '0.5.0', sourceLabel: 'demo@market-b', installed: true },
  ])
})

test('the active record is enabled first, newest next, marketplace over npm, then the first handle', () => {
  // An older enabled record beats a newer disabled one.
  const enabledWins = mergeCandidates(
    [
      candidate({ pluginId: 'demo', installId: 'demo@market-a', marketplace: 'market-a', lastUpdated: '2026-01-01T00:00:00Z' }),
      candidate({ pluginId: 'demo', installId: 'demo@market-b', marketplace: 'market-b', enabled: false, lastUpdated: '2026-03-01T00:00:00Z' }),
    ],
    catalogOf({}),
  )
  assert.equal(enabledWins[0]?.installId, 'demo@market-a')

  // Same stamp, both enabled: a marketplace install is preferred over an npm one.
  const marketplaceWins = mergeCandidates(
    [
      candidate({ pluginId: 'demo', installId: null, marketplace: null, lastUpdated: '2026-03-01T00:00:00Z' }),
      candidate({ pluginId: 'demo', installId: 'demo@market-a', marketplace: 'market-a', lastUpdated: '2026-03-01T00:00:00Z' }),
    ],
    catalogOf({}),
  )
  assert.equal(marketplaceWins[0]?.installId, 'demo@market-a')
  assert.equal(marketplaceWins[0]?.source.kind, 'marketplace')

  // Two marketplace records with the same stamp: the lexicographically first handle wins.
  const firstHandleWins = mergeCandidates(
    [
      candidate({ pluginId: 'demo', installId: 'demo@market-b', marketplace: 'market-b', lastUpdated: '2026-03-01T00:00:00Z' }),
      candidate({ pluginId: 'demo', installId: 'demo@market-a', marketplace: 'market-a', lastUpdated: '2026-03-01T00:00:00Z' }),
    ],
    catalogOf({}),
  )
  assert.equal(firstHandleWins[0]?.installId, 'demo@market-a')

  // Nothing enabled: the same order still picks one, because a disabled row is rendered too.
  const nothingEnabled = mergeCandidates(
    [
      candidate({ pluginId: 'demo', installId: 'demo@market-a', marketplace: 'market-a', enabled: false, lastUpdated: '2026-01-01T00:00:00Z' }),
      candidate({ pluginId: 'demo', installId: 'demo@market-b', marketplace: 'market-b', enabled: false, lastUpdated: '2026-02-01T00:00:00Z' }),
    ],
    catalogOf({}),
  )
  assert.equal(nothingEnabled[0]?.installId, 'demo@market-b')
  assert.equal(nothingEnabled[0]?.enabled, false)
})

test('sources include every registered marketplace that lists the plugin, ordered by marketplace', () => {
  const rows = mergeCandidates(
    [candidate({ pluginId: 'demo', installId: 'demo@market-a', marketplace: 'market-a', version: '0.4.2' })],
    // Deliberately not sorted and not limited to the installed marketplace: `sources` must be the
    // union of what is installed and what the catalogs declare, deterministic on every read.
    catalogOf({
      demo: [
        ['market-c', '0.3.0'],
        ['market-a', '0.5.0'],
        ['market-b', '0.4.2'],
      ],
    }),
  )

  assert.deepEqual(rows[0]?.sources, [
    // The installed record and the same marketplace's newer catalog version are both shown, because
    // they answer different questions ("what do you run" / "what is offered here").
    { marketplace: 'market-a', version: '0.4.2', sourceLabel: 'demo@market-a', installed: true },
    { marketplace: 'market-a', version: '0.5.0', sourceLabel: 'demo@market-a', installed: false },
    { marketplace: 'market-b', version: '0.4.2', sourceLabel: 'demo@market-b', installed: false },
    { marketplace: 'market-c', version: '0.3.0', sourceLabel: 'demo@market-c', installed: false },
  ])
})

test('an npm row has no install handle and no installed source', () => {
  const rows = mergeCandidates(
    [candidate({ pluginId: 'demo', installId: null, marketplace: null, version: '1.2.3' })],
    catalogOf({ demo: [['market-a', '0.4.2']] }),
  )

  assert.equal(rows[0]?.id, 'demo')
  assert.equal(rows[0]?.installId, null)
  assert.equal(rows[0]?.source.kind, 'npm')
  assert.equal(rows[0]?.source.marketplace, null)
  assert.deepEqual(rows[0]?.sources, [{ marketplace: 'market-a', version: '0.4.2', sourceLabel: 'demo@market-a', installed: false }])
})

test('rows are one per plugin id and scope, sorted by id then scope', () => {
  const rows = mergeCandidates(
    [
      candidate({ pluginId: 'zeta', installId: 'zeta@market-a', marketplace: 'market-a' }),
      candidate({ pluginId: 'alpha', installId: null, marketplace: null, scope: 'user' }),
      candidate({ pluginId: 'alpha', installId: 'alpha@market-a', marketplace: 'market-a', scope: 'project' }),
    ],
    catalogOf({}),
  )

  assert.deepEqual(
    rows.map(row => `${row.id}/${row.scope}`),
    ['alpha/project', 'alpha/user', 'zeta/user'],
  )
})

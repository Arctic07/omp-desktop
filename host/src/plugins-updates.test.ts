import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PluginCatalog } from './plugins-market.ts'
import { parsePluginId } from './harness.ts'
import type { EngineUpdate, InstalledMarketRecord } from './plugins-updates.ts'
import { classifyPluginUpdates, isNewerVersion } from './plugins-updates.ts'

/**
 * The update answer (plan §4.2): the engine's own rows renamed into the plugin identity, plus the
 * cross-market scan it does not perform.
 *
 * The comparison has to be the engine's rule, not a similar one, so the shared fixture set below is
 * checked twice: against explicit expectations, and against the engine's literal expression
 * (`Bun.semver.order(candidate, installed) > 0`, falling back to inequality when either tag cannot be
 * parsed). `parse` is the engine's documented `parsePluginId` rule, restated here because the seam
 * check keeps the engine out of this file.
 */

/** The engine's comparison, spelled out: the reference `isNewerVersion` must agree with. */
function engineRule(candidate: string, installed: string): boolean {
  try {
    return Bun.semver.order(candidate, installed) > 0
  } catch {
    return candidate !== installed
  }
}

/** A catalog as `readPluginCatalog` returns it. */
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

/** One installed marketplace record as `plugins.ts` reads it from the summary's active entry. */
function installed(installId: string, version: string, extra: Partial<InstalledMarketRecord> = {}): InstalledMarketRecord {
  return { installId, scope: 'user', version, enabled: true, lastUpdated: '2026-01-01T00:00:00Z', ...extra }
}

/** The pairs the comparison is pinned on: semver, a `v` prefix, a prerelease, and unparsable tags. */
const VERSION_PAIRS: Array<[string, string, boolean]> = [
  ['0.5.0', '0.4.2', true],
  ['0.4.2', '0.5.0', false],
  ['0.4.2', '0.4.2', false],
  ['v1.0.0', '0.9.9', true],
  ['1.0.0-beta', '1.0.0', false],
  ['1.0.0', '1.0.0-beta', true],
  // Neither side parses: the engine's fallback treats any difference as an update.
  ['next', '0.4.2', true],
  ['0.4.2', 'next', true],
  ['nightly', 'nightly', false],
]

test('the version comparison is the engine rule on the same fixture set', () => {
  for (const [candidate, base, expected] of VERSION_PAIRS) {
    assert.equal(isNewerVersion(candidate, base), expected, `${candidate} vs ${base}`)
    assert.equal(isNewerVersion(candidate, base), engineRule(candidate, base), `${candidate} vs ${base} (engine)`)
  }
})

test('a newer version in another marketplace is a switch-source update', () => {
  const answer = classifyPluginUpdates({
    parse: parsePluginId,
    engine: [],
    installed: [installed('demo@market-a', '0.4.2')],
    catalog: catalogOf({
      demo: [
        ['market-a', '0.4.2'],
        ['market-b', '0.5.0'],
      ],
    }),
  })

  assert.deepEqual(answer.updates, [
    {
      pluginId: 'demo',
      installId: 'demo@market-a',
      scope: 'user',
      from: '0.4.2',
      to: '0.5.0',
      marketplace: 'market-b',
      kind: 'switch-source',
    },
  ])
  assert.deepEqual(answer.candidates, [
    {
      pluginId: 'demo',
      scope: 'user',
      sources: [
        { marketplace: 'market-a', version: '0.4.2' },
        { marketplace: 'market-b', version: '0.5.0' },
      ],
    },
  ])
})

test('a newer version in the installed marketplace is an in-place update', () => {
  const answer = classifyPluginUpdates({
    parse: parsePluginId,
    engine: [],
    installed: [installed('demo@market-a', '0.4.2')],
    catalog: catalogOf({
      demo: [
        ['market-a', '0.5.0'],
        ['market-b', '0.4.9'],
      ],
    }),
  })

  assert.equal(answer.updates.length, 1)
  assert.equal(answer.updates[0]?.kind, 'in-place')
  assert.equal(answer.updates[0]?.marketplace, 'market-a')
  assert.equal(answer.updates[0]?.to, '0.5.0')
})

test('the engine row wins and the scan never duplicates it', () => {
  const engine: EngineUpdate[] = [{ pluginId: 'demo@market-a', scope: 'user', from: '0.4.2', to: '0.5.0' }]
  const answer = classifyPluginUpdates({
    parse: parsePluginId,
    engine,
    installed: [installed('demo@market-a', '0.4.2')],
    // The scan would report the same version from the same marketplace; one row is the answer.
    catalog: catalogOf({ demo: [['market-a', '0.5.0']] }),
  })

  assert.deepEqual(answer.updates, [
    {
      pluginId: 'demo',
      installId: 'demo@market-a',
      scope: 'user',
      from: '0.4.2',
      to: '0.5.0',
      marketplace: 'market-a',
      kind: 'in-place',
    },
  ])
})

test('a newer version in another marketplace replaces the engine row instead of being dropped', () => {
  // The engine sees only market-a, which offers 1.1.0; market-b offers 2.0.0. Reporting just the
  // in-place 1.0.0 -> 1.1.0 is the cross-market gap T0 exists to close, so the switch wins.
  const answer = classifyPluginUpdates({
    parse: parsePluginId,
    engine: [{ pluginId: 'demo@market-a', scope: 'user', from: '1.0.0', to: '1.1.0' }],
    installed: [installed('demo@market-a', '1.0.0')],
    catalog: catalogOf({
      demo: [
        ['market-a', '1.1.0'],
        ['market-b', '2.0.0'],
      ],
    }),
  })

  assert.deepEqual(answer.updates, [
    {
      pluginId: 'demo',
      installId: 'demo@market-a',
      scope: 'user',
      from: '1.0.0',
      to: '2.0.0',
      marketplace: 'market-b',
      kind: 'switch-source',
    },
  ])
})

test('another marketplace that is not newer than the engine target keeps the in-place row', () => {
  // `1.05` would parse as 1.5.0 under the engine's own semver, so the older and equal fixtures are
  // written the unambiguous way: 1.0.5 is older than 1.1.0, and 1.1.0 is the engine's target.
  for (const version of ['1.0.5', '1.1.0']) {
    const answer = classifyPluginUpdates({
      parse: parsePluginId,
      engine: [{ pluginId: 'demo@market-a', scope: 'user', from: '1.0.0', to: '1.1.0' }],
      installed: [installed('demo@market-a', '1.0.0')],
      catalog: catalogOf({
        demo: [
          ['market-a', '1.1.0'],
          ['market-b', version],
        ],
      }),
    })

    assert.deepEqual(
      answer.updates,
      [
        {
          pluginId: 'demo',
          installId: 'demo@market-a',
          scope: 'user',
          from: '1.0.0',
          to: '1.1.0',
          marketplace: 'market-a',
          kind: 'in-place',
        },
      ],
      version,
    )
  }
})

test('candidates carry every visible version even when nothing is newer', () => {
  const answer = classifyPluginUpdates({
    parse: parsePluginId,
    engine: [],
    installed: [installed('demo@market-b', '0.5.0')],
    catalog: catalogOf({
      demo: [
        ['market-b', '0.5.0'],
        ['market-a', '0.4.2'],
      ],
    }),
  })

  assert.deepEqual(answer.updates, [])
  assert.deepEqual(answer.candidates, [
    {
      pluginId: 'demo',
      scope: 'user',
      sources: [
        { marketplace: 'market-a', version: '0.4.2' },
        { marketplace: 'market-b', version: '0.5.0' },
      ],
    },
  ])
})

test('an npm or linked install has nothing to scan and nothing to switch', () => {
  // The engine's marketplace registry never holds npm/link rows, so a plugin installed only that way
  // has no record here: no candidate list, and no update that could move it between marketplaces.
  const answer = classifyPluginUpdates({ parse: parsePluginId, engine: [], installed: [], catalog: catalogOf({ demo: [['market-a', '0.5.0']] }) })

  assert.deepEqual(answer.updates, [])
  assert.deepEqual(answer.candidates, [])
})

test('one plugin in one scope yields one candidate row, for the record the list would act on', () => {
  const answer = classifyPluginUpdates({
    parse: parsePluginId,
    engine: [],
    installed: [
      installed('demo@market-a', '0.4.2', { enabled: false, lastUpdated: '2026-01-01T00:00:00Z' }),
      installed('demo@market-b', '0.4.0', { enabled: true, lastUpdated: '2025-12-01T00:00:00Z' }),
    ],
    catalog: catalogOf({
      demo: [
        ['market-a', '0.4.2'],
        ['market-b', '0.6.0'],
      ],
    }),
  })

  assert.equal(answer.candidates.length, 1)
  // The enabled record is the one the list shows, so it is the one an update is reported against -
  // and the newer version lives in the other marketplace, which is a source switch for it.
  assert.deepEqual(answer.updates, [
    {
      pluginId: 'demo',
      installId: 'demo@market-b',
      scope: 'user',
      from: '0.4.0',
      to: '0.6.0',
      marketplace: 'market-b',
      kind: 'in-place',
    },
  ])
})

test('an engine row without a readable id is dropped, not guessed at', () => {
  const answer = classifyPluginUpdates({
    parse: parsePluginId,
    engine: [{ pluginId: 'demo', scope: 'user', from: '0.4.2', to: '0.5.0' }],
    installed: [],
    catalog: catalogOf({}),
  })

  assert.deepEqual(answer.updates, [])
})

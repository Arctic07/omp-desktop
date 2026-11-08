import assert from 'node:assert/strict'
import { test } from 'node:test'

import type {
  EnginePluginSource,
  EnginePluginSourceOption,
  EnginePluginUpdate,
} from '../../../api/plugins-types'
import {
  formatMarketplaceSource,
  installedPluginSource,
  pluginSourceList,
  pluginSourceViews,
  pluginReachesAnyHost,
  pluginReachesAnyPath,
  pluginTargetId,
  pluginUpdateActionLabel,
  pluginUpdateBadgeLabel,
  pluginUpdateConfirmation,
} from './rows.ts'

/**
 * The plugin page's identity and source rules.
 *
 * What is pinned down here: a plugin id is never sent to an engine command in place of the
 * installation handle, a marketplace row that reports no handle is refused rather than guessed at,
 * the detail view's source list has one stable order, and an update is classified into the ordinary
 * engine reinstall or the destructive switch before any button is drawn.
 */

function source(overrides: Partial<EnginePluginSource> = {}): EnginePluginSource {
  return {
    kind: 'marketplace',
    label: 'sample@market-a',
    gitCommitSha: null,
    marketplace: 'market-a',
    installId: 'sample@market-a',
    installed: true,
    ...overrides,
  }
}

function option(overrides: Partial<EnginePluginSourceOption> = {}): EnginePluginSourceOption {
  return {
    marketplace: 'market-a',
    version: '1.2.3',
    sourceLabel: 'market a',
    installed: false,
    ...overrides,
  }
}

test('an engine write is addressed by the installation handle, not the plugin id', () => {
  assert.equal(pluginTargetId({ id: 'sample', installId: 'sample@market-a', source: source() }), 'sample@market-a')
  assert.equal(pluginTargetId({ id: 'sample', installId: 'sample@market-b', source: source() }), 'sample@market-b')

  // npm packages and linked directories have no marketplace handle: the package name is the handle.
  const npm = source({ kind: 'npm', label: 'sample', marketplace: null, installId: null })
  assert.equal(pluginTargetId({ id: 'sample', installId: null, source: npm }), 'sample')
  const link = source({ kind: 'link', label: './sample', marketplace: null, installId: null })
  assert.equal(pluginTargetId({ id: 'sample', installId: null, source: link }), 'sample')

  // A handle the host did report wins, whatever the source kind says it should be.
  assert.equal(pluginTargetId({ id: 'sample', installId: 'sample@cached', source: npm }), 'sample@cached')
})

test('a marketplace row without an install handle has no target at all', () => {
  // The contract makes `installId` mandatory on a marketplace row. Falling back to the plugin id
  // would send the engine a name that may belong to a different installation, so the answer is null
  // and every call site refuses the write instead.
  assert.equal(pluginTargetId({ id: 'sample', installId: null, source: source() }), null)
  assert.equal(pluginTargetId({ id: 'sample', installId: '  ', source: source() }), null)
  assert.equal(
    pluginTargetId({ id: '', installId: null, source: source({ kind: 'npm' }) }),
    null,
  )
})

test('the source list puts the installed marketplace first and is otherwise stable', () => {
  const views = pluginSourceViews(
    [
      option({ marketplace: 'market-c', version: '3.0.0' }),
      option({ marketplace: 'market-b', version: '2.0.0', installed: true }),
      option({ marketplace: 'market-a', version: '1.2.3' }),
    ],
    'market-b',
  )

  assert.deepEqual(
    views.map((view) => [view.marketplace, view.installed]),
    [
      ['market-b', true],
      ['market-a', false],
      ['market-c', false],
    ],
  )
  assert.equal(formatMarketplaceSource(views[0]!), 'market-b · v2.0.0')
})

test('the installed source is the host\'s own mark, or the row\'s marketplace', () => {
  const fromSources = pluginSourceViews(
    [option({ marketplace: 'market-b', installed: true }), option({ marketplace: 'market-a' })],
    'market-b',
  )
  assert.equal(fromSources[0]?.installed, true)

  // A source the host did not mark reads as installed when it is the row's own marketplace.
  const markedByRow = pluginSourceViews([option({ marketplace: 'market-a', installed: false })], 'market-a')
  assert.equal(markedByRow[0]?.installed, true)

  // Repeated entries for one marketplace collapse onto the installed one.
  const repeated = pluginSourceViews(
    [
      option({ marketplace: 'market-a', installed: false, version: '1.0.0' }),
      option({ marketplace: 'market-a', installed: true, version: '2.0.0' }),
    ],
    'market-a',
  )
  assert.deepEqual(repeated, [
    { marketplace: 'market-a', version: '2.0.0', sourceLabel: 'market a', installed: true },
  ])

  // A source with no marketplace name draws no line at all.
  assert.deepEqual(pluginSourceViews([option({ marketplace: '  ' })], null), [])
})

test('the installed source names the row\'s own marketplace and installed version', () => {
  assert.deepEqual(
    installedPluginSource({ version: '1.0.0', source: source() }),
    {
      marketplace: 'market-a',
      version: '1.0.0',
      sourceLabel: '',
      installed: true,
    },
  )

  // What a marketplace publishes is the candidate list's number, not the installed one.
  assert.equal(
    pluginSourceList({
      sources: [option({ marketplace: 'market-a', installed: true, version: '2.0.0' })],
      source: source(),
    })[0]?.version,
    '2.0.0',
  )

  // npm and link rows come from no marketplace, so there is no marketplace line to draw.
  assert.equal(
    installedPluginSource({
      version: '1.0.0',
      source: source({ kind: 'npm', label: 'sample', marketplace: null, installId: null }),
    }),
    null,
  )
  assert.deepEqual(pluginSourceList({ sources: undefined, source: source() }), [])
})

test('an update is classified before any button is drawn', () => {
  const inPlace: EnginePluginUpdate = {
    pluginId: 'sample',
    installId: 'sample@market-a',
    scope: 'user',
    from: '1.0.0',
    to: '1.1.0',
    marketplace: 'market-a',
    kind: 'in-place',
  }
  const switchSource: EnginePluginUpdate = {
    ...inPlace,
    to: '2.0.0',
    marketplace: 'market-b',
    kind: 'switch-source',
  }

  assert.equal(pluginUpdateConfirmation(inPlace), 'in-place')
  assert.equal(pluginUpdateConfirmation(switchSource), 'switch-card')

  // A switch with no target marketplace cannot be stated or addressed, so it is not offered as one.
  assert.equal(pluginUpdateConfirmation({ ...switchSource, marketplace: null }), 'in-place')
  assert.equal(pluginUpdateConfirmation({ ...switchSource, marketplace: ' ' }), 'in-place')

  // A kind this build does not know reads as the engine's own reinstall.
  const future = { ...inPlace, kind: 'future' as EnginePluginUpdate['kind'] }
  assert.equal(pluginUpdateConfirmation(future), 'in-place')
})

test('the update action and badge say which write they start', () => {
  const inPlace = { kind: 'in-place' as const, marketplace: 'market-a' }
  const switching = { kind: 'switch-source' as const, marketplace: 'market-b' }
  const copy = {
    updateAction: 'Update',
    switchSourceAction: 'Switch source',
    updateBadge: 'Update available',
    switchSourceBadge: 'Source switch',
  }

  assert.equal(pluginUpdateActionLabel(inPlace, copy), copy.updateAction)
  assert.equal(pluginUpdateActionLabel(switching, copy), copy.switchSourceAction)
  assert.equal(pluginUpdateBadgeLabel(inPlace, copy), copy.updateBadge)
  assert.equal(pluginUpdateBadgeLabel(switching, copy), copy.switchSourceBadge)
  // A switch the host could not name a target for keeps the ordinary update's wording.
  assert.equal(
    pluginUpdateActionLabel({ ...switching, marketplace: null }, copy),
    copy.updateAction,
  )
})

test('the any-host widening is shown only when both keys hold', () => {
  // Both keys: the permission and the block's own flag.
  assert.equal(pluginReachesAnyHost(['net.fetch', 'net.anyHost'], true), true)
  // The permission alone reaches nothing, and the display must not claim otherwise.
  assert.equal(pluginReachesAnyHost(['net.fetch', 'net.anyHost'], false), false)
  assert.equal(pluginReachesAnyHost(['net.fetch', 'net.anyHost'], undefined), false)
  // The flag alone is a block the host's re-check refuses; nothing is shown as a reach either.
  assert.equal(pluginReachesAnyHost(['net.fetch'], true), false)
})

test('the any-path widening is one key, and it is the permission itself', () => {
  // One key, unlike `net.anyHost`: a permission token cannot be read as "listed a scope", so the
  // declaration alone is the reach - and the three file modes then state no range of their own.
  assert.equal(pluginReachesAnyPath(['fs.read', 'fs.anyPath']), true)
  // The modes without the widening keep their own scope line.
  assert.equal(pluginReachesAnyPath(['fs.read', 'fs.write', 'fs.delete']), false)
  assert.equal(pluginReachesAnyPath([]), false)
})

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { parsePluginId } from './harness.ts'
import {
  configView,
  resetKeysFor,
  resolveConfigTarget,
  settingSchemaFor,
} from './plugins-settings.ts'
import type { InstalledPlugin, InstalledPluginSummary } from './sdk.ts'

/**
 * The settings command's identity rule and the answers it owes two kinds of installation.
 *
 * A marketplace entry is installed when its registry record exists, whether or not its directory
 * carries a `package.json`: a Claude-format package ships `.claude-plugin/plugin.json` instead,
 * which the engine's `PluginManager` does not load. The settings commands used to answer
 * `plugin_not_found` for exactly those entries - every such plugin's settings page opened with a
 * host refusal - so the cases below pin the two halves: an installation the manager can resolve
 * keeps its package name, and an installation it cannot resolve is still installed, with an empty
 * schema rather than an error. A registry record whose directory is gone is not that case: it is a
 * stale row, and `plugin_not_found` stays the honest answer.
 *
 * The command's own answers are asserted where they are composed: the read view (`configView`), the
 * write's schema check (`settingSchemaFor`), and the keys a reset deletes (`resetKeysFor`). A
 * target with no package declares nothing, and it must not fall back to the name-keyed store the
 * engine shares between installations.
 */

/** The engine's `parsePluginId` is restated once in `harness.ts`. */

/** One install record, with only the fields the resolution reads. */
function summary(id: string, installPath: string): InstalledPluginSummary {
  return {
    id,
    scope: 'user',
    entries: [
      {
        scope: 'user',
        installPath,
        version: '1.0.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    ],
  }
}

/** A manager that resolves one package name at one path, and nothing else. */
function manager(
  known: InstalledPlugin | undefined,
  pathName?: string,
  path?: string,
) {
  return {
    async getPlugin(name: string, options?: { path?: string }) {
      if (known !== undefined && name === known.name && options?.path === undefined) return known
      if (known !== undefined && name === pathName && options?.path === path) return known
      return undefined
    },
    async getPluginSettings() {
      return {}
    },
    async setPluginSetting() {},
    async deletePluginSetting() {},
  }
}

/** The plugin the manager can resolve: a package that carries an engine manifest. */
const PLUGIN: InstalledPlugin = {
  name: 'demo',
  version: '1.0.0',
  path: 'C:\\plugins\\demo',
  manifest: { version: '1.0.0', settings: { level: { type: 'number' } } },
  enabledFeatures: null,
  enabled: true,
}

/** One empty directory standing in for a cached install. */
function installDir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-settings-target-'))
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** One registry entry whose directory cannot be read as an installed package. */
async function manifestlessTarget(dir: string) {
  return resolveConfigTarget(
    parsePluginId,
    manager(undefined),
    { listInstalledPlugins: async () => [summary('probe-claude@market-a', dir)] },
    'probe-claude@market-a',
  )
}

test('a plugin the manager resolves is addressed by its package name', async () => {
  const target = await resolveConfigTarget(
    parsePluginId,
    manager(PLUGIN),
    { listInstalledPlugins: async () => [] },
    'demo',
  )
  assert.equal(target.id, 'demo')
  assert.equal(target.key, 'demo')
  assert.equal(target.plugin, PLUGIN)
})

test('a registry entry whose package cannot be read is installed with no settings', async () => {
  const dir = installDir()
  try {
    const target = await manifestlessTarget(dir.root)
    assert.equal(target.id, 'probe-claude@market-a')
    assert.equal(target.key, 'probe-claude')
    assert.equal(target.plugin, null)
  } finally {
    dir.cleanup()
  }
})

test('a manifest-less installation reads as an empty schema and writes no setting', async () => {
  const dir = installDir()
  try {
    const target = await manifestlessTarget(dir.root)
    const reader = {
      ...manager(undefined),
      async getPluginSettings() {
        return { level: 3 }
      },
    }
    const view = await configView(reader, target)
    assert.equal(view.id, target.id)
    assert.deepEqual(view.schema, {})
    assert.deepEqual(view.values, { level: 3 })
    assert.throws(
      () => settingSchemaFor(target, 'level'),
      (error: unknown) => {
        if (!(error instanceof Error) || !('code' in error)) return false
        return typeof error.code === 'string' && error.code === 'invalid_input'
      },
    )
    // A reset has nothing of its own to delete, so it must not clear a namesake's values.
    assert.deepEqual(resetKeysFor(target, '', { level: 3 }), [])
    assert.deepEqual(resetKeysFor(target, 'level', { level: 3 }), [])
  } finally {
    dir.cleanup()
  }
})

test('a stale registry entry is still a missing plugin', async () => {
  const dir = installDir()
  dir.cleanup()
  await assert.rejects(
    resolveConfigTarget(
      parsePluginId,
      manager(undefined),
      { listInstalledPlugins: async () => [summary('gone@market-a', dir.root)] },
      'gone',
    ),
    (error: unknown) => {
      if (!(error instanceof Error) || !('code' in error)) return false
      return typeof error.code === 'string' && error.code === 'plugin_not_found'
    },
  )
})

test('a registry entry whose install path is a file is a missing plugin', async () => {
  const dir = installDir()
  const file = path.join(dir.root, 'not-a-directory')
  fs.writeFileSync(file, '')
  try {
    await assert.rejects(
      resolveConfigTarget(
        parsePluginId,
        manager(undefined),
        { listInstalledPlugins: async () => [summary('file@market-a', file)] },
        'file',
      ),
      (error: unknown) => {
        if (!(error instanceof Error) || !('code' in error)) return false
        return typeof error.code === 'string' && error.code === 'plugin_not_found'
      },
    )
  } finally {
    dir.cleanup()
  }
})

test('a registry entry with no install record is a missing plugin', async () => {
  await assert.rejects(
    resolveConfigTarget(
      parsePluginId,
      manager(undefined),
      { listInstalledPlugins: async () => [{ id: 'empty@market-a', scope: 'user', entries: [] }] },
      'empty',
    ),
    (error: unknown) => {
      if (!(error instanceof Error) || !('code' in error)) return false
      return typeof error.code === 'string' && error.code === 'plugin_not_found'
    },
  )
})

test('a bare id finds its marketplace record, and the key is the catalogue name', async () => {
  const dir = installDir()
  try {
    const target = await resolveConfigTarget(
      parsePluginId,
      manager(PLUGIN, 'other-name', dir.root),
      { listInstalledPlugins: async () => [summary('other-name@market-a', dir.root)] },
      'other-name',
    )
    assert.equal(target.key, 'demo')
    assert.equal(target.plugin, PLUGIN)
  } finally {
    dir.cleanup()
  }
})

/**
 * A scope the caller named is the scope that answers: a project-scope write must never be served by
 * the user-scope copy of the same plugin, and the refusal names the scope it looked in.
 */
test('a named scope is never traded for the other installation', async () => {
  const dir = installDir()
  const project = path.join(dir.root, 'project')
  fs.mkdirSync(project, { recursive: true })
  const userOnly: InstalledPluginSummary = {
    id: 'demo@market-a',
    scope: 'user',
    entries: [
      {
        scope: 'user' as const,
        installPath: dir.root,
        version: '1.0.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    ],
  }
  try {
    // The user copy is installed; asking for the project one is a refusal, not a substitution.
    await assert.rejects(
      resolveConfigTarget(parsePluginId, manager(undefined), { listInstalledPlugins: async () => [userOnly] }, 'demo@market-a', 'project'),
      (error: unknown) => {
        if (!(error instanceof Error) || !('code' in error)) return false
        return typeof error.code === 'string' && error.code === 'plugin_not_found' && error.message.includes('project scope')
      },
    )
    // With both installed, the project copy is the one resolved.
    const both: InstalledPluginSummary = {
      ...userOnly,
      entries: [
        ...userOnly.entries,
        {
          scope: 'project' as const,
          installPath: project,
          version: '2.0.0',
          installedAt: '2026-01-01T00:00:00.000Z',
          lastUpdated: '2026-01-01T00:00:00.000Z',
        },
      ],
    }
    const target = await resolveConfigTarget(
      parsePluginId,
      manager(undefined),
      { listInstalledPlugins: async () => [both] },
      'demo@market-a',
      'project',
    )
    assert.equal(target.plugin, null)
    assert.equal(target.key, 'demo')
  } finally {
    dir.cleanup()
  }
})

test('a declared setting resolves its schema, and an undeclared key is refused', () => {
  const target = {
    id: 'demo',
    key: 'demo',
    plugin: PLUGIN,
  }
  assert.equal(settingSchemaFor(target, 'level').type, 'number')
  assert.throws(
    () => settingSchemaFor(target, 'missing'),
    (error: unknown) => {
      if (!(error instanceof Error) || !('code' in error)) return false
      return typeof error.code === 'string' && error.code === 'invalid_input'
    },
  )
  assert.deepEqual(resetKeysFor(target, '', { level: 1, other: 2 }), ['level', 'other'])
  assert.deepEqual(resetKeysFor(target, 'level', {}), ['level'])
})

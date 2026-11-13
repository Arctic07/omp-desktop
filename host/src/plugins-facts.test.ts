import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { pluginFacts, type PluginFacts } from './plugins-facts.ts'

/**
 * The consent half of the plugin facts (plan §5.4/§6.1/§7.1, spec §9.2-②).
 *
 * Each case is one real package directory read by the same function the row uses - no engine, no
 * registry - because what is under test is exactly this host's reading of a manifest: which
 * declarations it counts as code that runs, and which one it answers fail-closed. The desktop
 * reasons exist so the consent chain can confirm (or quarantine) a plugin whose code arrives as a
 * resident process or a slot module instead of an engine extension.
 */

/** One package directory with the given `package.json` text, removed by the caller. */
function packageRoot(text: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-plugin-facts-'))
  fs.writeFileSync(path.join(root, 'package.json'), text, 'utf8')
  return root
}

/** One manifest whose `omp` block is the object under test, plus the facts it produced. */
function facts(omp: unknown): PluginFacts {
  const root = packageRoot(`${JSON.stringify({ name: 'facts-fixture', version: '1.0.0', omp })}\n`)
  try {
    return pluginFacts(root, null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('a `main` alone is code that runs: the gate asks, and says why', () => {
  const row = facts({ desktop: { schemaVersion: 1, main: 'desktop/main.js' } })
  assert.equal(row.desktop?.valid, true)
  assert.deepEqual(row.consent, { required: true, reasons: ['process-main'] })
})

test('a `renderer` alone is code that runs in the application document', () => {
  const row = facts({ desktop: { schemaVersion: 1, permissions: ['renderer.extension'], renderer: 'desktop/renderer.mjs' } })
  assert.equal(row.desktop?.valid, true)
  assert.deepEqual(row.consent, { required: true, reasons: ['renderer-module'] })
})

test('a block with neither declaration keeps the old answer: no code, no consent', () => {
  const row = facts({ desktop: { schemaVersion: 1, permissions: ['ui.theme'], themes: [{ id: 't', tokens: { '--omp-bg': '#000' } }] } })
  assert.equal(row.desktop?.valid, true)
  assert.deepEqual(row.consent, { required: false, reasons: [] })
})

test('both desktop surfaces join the engine reasons rather than replacing them', () => {
  const row = facts({
    extensions: ['index.js'],
    desktop: { schemaVersion: 1, main: 'desktop/main.js', renderer: 'desktop/renderer.mjs', permissions: ['renderer.extension'] },
  })
  assert.deepEqual(row.consent.reasons, ['extension-modules', 'process-main', 'renderer-module'])
  assert.equal(row.consent.required, true)
})

test('a manifest that cannot be read stays `manifest-unreadable`, whatever it may declare', () => {
  const root = packageRoot('{ not json')
  try {
    const row = pluginFacts(root, null)
    assert.deepEqual(row.consent, { required: true, reasons: ['manifest-unreadable'] })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  // The same answer for an `omp` block that is not an object - the engine's own rule never required
  // one, so the row says "there may be code here" instead of reporting none.
  const blockless = facts('nonsense')
  assert.equal(blockless.desktop, null)
  assert.deepEqual(blockless.consent, { required: true, reasons: ['manifest-unreadable'] })
})

test('a Claude-format package is identified by `.claude-plugin/plugin.json`, not called unreadable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-plugin-facts-'))
  try {
    fs.mkdirSync(path.join(root, '.claude-plugin'))
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'claude-fixture', version: '2.3.4', description: 'A Claude plugin' }),
      'utf8',
    )
    fs.mkdirSync(path.join(root, 'skills', 'review'), { recursive: true })
    fs.writeFileSync(path.join(root, 'skills', 'review', 'SKILL.md'), '---\ndescription: x\n---\n', 'utf8')
    const row = pluginFacts(root, null)
    assert.equal(row.displayName, 'claude-fixture')
    assert.equal(row.description, 'A Claude plugin')
    assert.equal(row.version, '2.3.4')
    assert.equal(row.desktopError, null)
    assert.deepEqual(row.consent, { required: false, reasons: [] })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an Agent Plugins root `plugin.json` identifies the package and its mcp.json still gates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-plugin-facts-'))
  try {
    fs.writeFileSync(
      path.join(root, 'plugin.json'),
      JSON.stringify({ $schema: 'https://agent-plugins.org/schema/1.0.0.json', name: 'agent-fixture', description: 'Agent package', version: '1.0.0' }),
      'utf8',
    )
    fs.writeFileSync(path.join(root, 'mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf8')
    // `mcp.json` is the standard's own file, and the engine loads it whether or not `mcpServers` is
    // inside a manifest: the probe reads the file, so the empty document is not a server declaration.
    const row = pluginFacts(root, null)
    assert.equal(row.displayName, 'agent-fixture')
    assert.equal(row.version, '1.0.0')
    assert.equal(row.code.mcpConfig, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a broken package.json beside a readable plugin.json reports the failure without demanding consent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-plugin-facts-'))
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{ not json', 'utf8')
    fs.mkdirSync(path.join(root, '.claude-plugin'))
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'broken-pkg' }), 'utf8')
    fs.mkdirSync(path.join(root, 'hooks', 'pre'), { recursive: true })
    fs.writeFileSync(path.join(root, 'hooks', 'pre', 'guard.ts'), 'export default () => {}\n', 'utf8')
    const row = pluginFacts(root, null)
    assert.equal(row.displayName, 'broken-pkg')
    assert.equal(row.desktopError, 'package.json is not valid JSON')
    // The directory probes still say what may run, which is the fact the gate needs.
    assert.deepEqual(row.consent, { required: true, reasons: ['hooks-dir'] })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('`omp.features` reports the engine’s resolution, not a second default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-plugin-facts-'))
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'features-fixture',
        version: '1.0.0',
        omp: {
          features: {
            search: { description: 'Web search', default: true },
            web: { description: 'Fetch pages' },
          },
        },
      }),
      'utf8',
    )
    const defaults = pluginFacts(root, null)
    assert.deepEqual(
      defaults.features.map(feature => [feature.name, feature.default, feature.enabled]),
      [
        ['search', true, true],
        ['web', false, false],
      ],
    )
    const explicit = pluginFacts(root, ['web'])
    assert.deepEqual(
      explicit.features.map(feature => [feature.name, feature.enabled]),
      [
        ['search', false],
        ['web', true],
      ],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

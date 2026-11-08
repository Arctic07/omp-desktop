import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EnginePluginRenderer, PluginRow } from '../api/plugins-types.ts'
import {
  MAX_REGISTRATIONS_PER_PLUGIN,
  codeBlockEntryFor,
  dispatchRefusal,
  parsePluginFenceLanguage,
  planSlotReconcile,
  pluginSlotStore,
  registerSlot,
  releaseSlot,
  rendererTargetOf,
  slotEntriesFor,
  slotEntryFor,
  toolCardEntryFor,
  toolCardNameOf,
  type PluginSlotEntry,
  type SlotOwnerIdentity,
} from './plugin-slot-rules.ts'

/**
 * The renderer-slot contract, decided from data (plan §7.3 / §7.4).
 *
 * What is pinned here is everything that happens before a component is mounted: which registrations
 * are accepted and bounded, which fence tags and tool names reach a renderer, which dispatch words
 * pass the whitelist, and which list answers start or end a module. The React boundary and the
 * module fetch are exercised by the app, not here.
 */

const OWNER: SlotOwnerIdentity = {
  pluginKey: 'sample\u0000user',
  pluginId: 'sample',
  scope: 'user',
}

const OTHER: SlotOwnerIdentity = {
  pluginKey: 'other\u0000user',
  pluginId: 'other',
  scope: 'user',
}

/** Minimal function component: the registry only checks that a component is callable. */
const Component = () => null

/** The entry a registration produced, failing the test with the rule's own token when it was refused. */
function entryOf(value: PluginSlotEntry | string): PluginSlotEntry {
  if (typeof value === 'string') assert.fail(`registration refused: ${value}`)
  return value
}

const RENDERER: EnginePluginRenderer = {
  path: 'desktop/renderer.mjs',
  url: 'http://omp-renderer.localhost/key/renderer.mjs',
  actions: ['plugin.call', 'composer.insertText'],
  callMethods: ['insertSnippet', 'listSnippets'],
  available: true,
  reason: null,
}

function desktop(renderer: EnginePluginRenderer | null) {
  return {
    schemaVersion: 1,
    valid: true,
    reason: null,
    panels: [],
    views: [],
    settingsDestinations: [],
    sidebarTabs: [],
    workPanelTabs: [],
    permissions: ['renderer.extension'],
    netDomains: [],
    fsScopes: { read: [], write: [], delete: [] },
    themes: [],
    enginesOmpDesktop: null,
    i18n: null,
    process: null,
    renderer,
  }
}

function row(overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: 'sample',
    installId: 'sample@local',
    name: 'Sample',
    description: null,
    version: '1.0.0',
    scope: 'user',
    enabled: true,
    builtin: false,
    shadowedBy: null,
    source: {
      kind: 'marketplace',
      label: 'sample@local',
      gitCommitSha: null,
      marketplace: 'local',
      installId: 'sample@local',
      installed: true,
    },
    sources: [],
    installedAt: null,
    lastUpdated: '2026-10-20T10:00:00Z',
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
    desktop: desktop(RENDERER),
    desktopError: null,
    ...overrides,
  }
}

/* ---------------------------------------------------------------- the registry */

test('a registration is mounted on its slot and its disposer unmounts it', () => {
  const outcome = registerSlot(OWNER, {
    slot: 'message.extra',
    component: Component,
  })
  if (!('entry' in outcome)) assert.fail(`registration refused: ${outcome.refusal}`)
  assert.equal(outcome.entry.pluginId, 'sample')
  assert.ok(pluginSlotStore.get().entries.some((entry) => entry.id === outcome.entry.id))

  releaseSlot(outcome.entry.id)
  assert.equal(
    pluginSlotStore.get().entries.some((entry) => entry.id === outcome.entry.id),
    false,
  )
})

test('a registration outside the closed set, or without a component, is refused', () => {
  assert.equal(
    slotEntryFor(OWNER, { slot: 'composer.trigger', component: Component }, [], 1),
    'renderer_slot_unknown',
  )
  assert.equal(
    slotEntryFor(OWNER, { slot: 'message.extra', component: 'not a component' }, [], 1),
    'renderer_slot_invalid_component',
  )
  assert.equal(slotEntryFor(OWNER, null, [], 1), 'renderer_slot_invalid_component')
})

test('positions belong to the composer toolbar, and are a closed pair of sides', () => {
  const both = entryOf(slotEntryFor(OWNER, { slot: 'composer.toolbar', component: Component }, [], 1))
  assert.equal(both.positions, null)

  assert.equal(
    slotEntryFor(OWNER, { slot: 'composer.toolbar', component: Component, positions: ['top'] }, [], 2),
    'renderer_slot_invalid_position',
  )
  assert.equal(
    slotEntryFor(OWNER, { slot: 'message.extra', component: Component, positions: ['left'] }, [], 2),
    'renderer_slot_invalid_position',
  )
})

test('one installation may hold at most the declared number of registrations', () => {
  const existing: PluginSlotEntry[] = []
  for (let index = 0; index < MAX_REGISTRATIONS_PER_PLUGIN; index += 1) {
    existing.push(entryOf(slotEntryFor(OWNER, { slot: 'message.extra', component: Component }, existing, index)))
  }
  assert.equal(
    slotEntryFor(OWNER, { slot: 'message.extra', component: Component }, existing, 999),
    'renderer_slot_limit',
  )
  // The bound is per installation: another plugin's entries do not count against it.
  entryOf(slotEntryFor(OTHER, { slot: 'message.extra', component: Component }, existing, 1000))
})

test('a toolbar control renders on the sides it asks for, and on both when it asks for neither', () => {
  const right = entryOf(
    slotEntryFor(OWNER, { slot: 'composer.toolbar', component: Component, positions: ['right'] }, [], 1),
  )
  const both = entryOf(slotEntryFor(OWNER, { slot: 'composer.toolbar', component: Component }, [], 2))
  const entries = [right, both]

  assert.deepEqual(slotEntriesFor(entries, 'composer.toolbar', 'left').map((entry) => entry.id), [2])
  assert.deepEqual(slotEntriesFor(entries, 'composer.toolbar', 'right').map((entry) => entry.id), [1, 2])
})

/* ------------------------------------------------------------- fenced blocks */

test('a fence tag is parsed as <pluginId>:<lang>, and only those shapes parse', () => {
  assert.deepEqual(parsePluginFenceLanguage('omp.charts:timeline'), {
    pluginId: 'omp.charts',
    language: 'timeline',
  })
  assert.deepEqual(parsePluginFenceLanguage('  OMP.Charts:Mermaid '), {
    pluginId: 'omp.charts',
    language: 'mermaid',
  })
  assert.equal(parsePluginFenceLanguage('timeline'), null, 'no colon is not a plugin fence')
  assert.equal(parsePluginFenceLanguage(':timeline'), null)
  assert.equal(parsePluginFenceLanguage('omp.charts:'), null)
  assert.equal(parsePluginFenceLanguage('a:b:c'), null)
  assert.equal(parsePluginFenceLanguage('omp charts:timeline'), null)
})

test('a code block mounts only its own plugin, and only for the language it registered', () => {
  const entry = entryOf(
    slotEntryFor(OWNER, { slot: 'code.block', component: Component, language: 'mermaid' }, [], 1),
  )
  const entries = [entry]

  assert.equal(codeBlockEntryFor(entries, 'sample:mermaid'), entry)
  assert.equal(codeBlockEntryFor(entries, 'SAMPLE:Mermaid'), entry)
  assert.equal(codeBlockEntryFor(entries, 'other:mermaid'), null, "another plugin's fence is not ours")
  assert.equal(codeBlockEntryFor(entries, 'mermaid'), null, 'no plugin id means no plugin block')
  assert.equal(codeBlockEntryFor(entries, 'sample:timeline'), null, 'an unregistered language stays code')
})

test('a registration may name its own full tag, but never another plugin id', () => {
  const own = entryOf(
    slotEntryFor(OWNER, { slot: 'code.block', component: Component, language: 'sample:mermaid' }, [], 1),
  )
  assert.equal(own.language, 'mermaid')

  assert.equal(
    slotEntryFor(OTHER, { slot: 'code.block', component: Component, language: 'sample:mermaid' }, [], 2),
    'renderer_slot_not_owned',
  )
  assert.equal(
    slotEntryFor(OWNER, { slot: 'code.block', component: Component, language: 'bad lang' }, [], 2),
    'renderer_slot_invalid_key',
  )
  assert.equal(
    slotEntryFor(OWNER, { slot: 'code.block', component: Component, language: 'mermaid' }, [own], 2),
    'renderer_slot_duplicate',
  )
})

/* ---------------------------------------------------------------- tool cards */

test('a tool card may not name an engine tool, and one name belongs to one plugin at a time', () => {
  assert.equal(
    slotEntryFor(OWNER, { slot: 'tool.card', component: Component, toolName: 'bash' }, [], 1),
    'renderer_slot_not_owned',
  )
  // The list is a plain object; `constructor` is its prototype's key, not a built-in name. The
  // guard reads own keys only, so a plugin's own `constructor` tool is not mistaken for one.
  entryOf(slotEntryFor(OWNER, { slot: 'tool.card', component: Component, toolName: 'constructor' }, [], 1))
  assert.equal(
    slotEntryFor(OWNER, { slot: 'tool.card', component: Component, toolName: '  ' }, [], 1),
    'renderer_slot_invalid_key',
  )

  const mine = entryOf(
    slotEntryFor(OWNER, { slot: 'tool.card', component: Component, toolName: 'insert_snippet' }, [], 1),
  )
  assert.equal(toolCardEntryFor([mine], 'insert_snippet'), mine)
  assert.equal(toolCardEntryFor([mine], 'read'), null, 'a built-in call keeps the default card')
  assert.equal(toolCardEntryFor([mine], 'other_tool'), null)

  assert.equal(
    slotEntryFor(OTHER, { slot: 'tool.card', component: Component, toolName: 'insert_snippet' }, [mine], 2),
    'renderer_slot_duplicate',
  )
  // Not a latch: once the first plugin's load ends, the name is free again.
  const later = entryOf(
    slotEntryFor(OTHER, { slot: 'tool.card', component: Component, toolName: 'insert_snippet' }, [], 2),
  )
  assert.equal(later.pluginId, 'other')
})

test('a plugin tool is looked up by the device it ran, not by its carrier', () => {
  // The carrier: a plugin tool runs as an `xd://<name>` call on `read` (its docs) or `write` (the
  // call itself), so the row's own name would never match a registration.
  assert.equal(toolCardNameOf({ name: 'write', argsText: '{"path":"xd://insert_snippet"}' }), 'insert_snippet')
  assert.equal(toolCardNameOf({ name: 'read', argsText: '{"path":"xd://insert_snippet"}' }), 'insert_snippet')
  assert.equal(
    toolCardNameOf({ name: 'write', argsText: '{"content":"{}","path":"xd://insert_snippet"}' }),
    'insert_snippet',
  )

  // Everything a card must not claim keeps the name the row has.
  assert.equal(toolCardNameOf({ name: 'read', argsText: '{"path":"src/index.ts"}' }), 'read')
  assert.equal(toolCardNameOf({ name: 'read', argsText: '{"path":"skill://omp-demo"}' }), 'read')
  assert.equal(toolCardNameOf({ name: 'read', argsText: '{"path":"rule://omp-demo"}' }), 'read')
  assert.equal(toolCardNameOf({ name: 'write', argsText: '' }), 'write')
  assert.equal(toolCardNameOf({ name: 'write', argsText: 'not json' }), 'write')
  assert.equal(toolCardNameOf({ name: 'write', argsText: '{"path":"xd://"}' }), 'write')
  assert.equal(toolCardNameOf({ name: 'write', argsText: '{"path":42}' }), 'write')
  assert.equal(toolCardNameOf({ name: 'bash', argsText: '{"path":"xd://insert_snippet"}' }), 'bash')

  // The name a row derives is the one a registration answers, so the pair lines up end to end.
  const mine = entryOf(
    slotEntryFor(OWNER, { slot: 'tool.card', component: Component, toolName: 'insert_snippet' }, [], 1),
  )
  const name = toolCardNameOf({ name: 'write', argsText: '{"path":"xd://insert_snippet"}' })
  assert.equal(toolCardEntryFor([mine], name), mine)
})

/* ------------------------------------------------------------------ dispatch */

test('the dispatch whitelist is vocabulary first, manifest second', () => {
  const declaration = { actions: ['composer.readDraft'], callMethods: ['insertSnippet'] }

  // Declared and in the vocabulary: the action may run.
  assert.equal(dispatchRefusal('composer.readDraft', declaration), null)
  // In the vocabulary, absent from the manifest.
  assert.equal(dispatchRefusal('composer.insertText', declaration), 'PLUGIN_ACTION_UNDECLARED')
  // Not a word this build has at all.
  assert.equal(dispatchRefusal('clipboard.read', declaration), 'PLUGIN_ACTION_UNKNOWN')
  assert.equal(dispatchRefusal(undefined, declaration), 'PLUGIN_ACTION_UNKNOWN')
  assert.equal(
    dispatchRefusal('constructor', { actions: ['constructor'], callMethods: [] }),
    'PLUGIN_ACTION_UNKNOWN',
  )
})

test('plugin.call is refused unless the method is one the row declared', () => {
  const declared = { actions: ['plugin.call'], callMethods: ['insertSnippet'] }

  assert.equal(dispatchRefusal('plugin.call', declared, 'insertSnippet'), null)
  assert.equal(dispatchRefusal('plugin.call', declared, 'deleteEverything'), 'PLUGIN_ACTION_UNDECLARED')
  assert.equal(dispatchRefusal('plugin.call', declared, undefined), 'PLUGIN_ACTION_UNDECLARED')
  assert.equal(
    dispatchRefusal('plugin.call', { actions: ['plugin.call'], callMethods: [] }, 'insertSnippet'),
    'PLUGIN_ACTION_UNDECLARED',
  )
  // The action itself still has to be declared before the method is even read.
  assert.equal(
    dispatchRefusal('plugin.call', { actions: [], callMethods: ['insertSnippet'] }, 'insertSnippet'),
    'PLUGIN_ACTION_UNDECLARED',
  )
})

/* ------------------------------------------------------------------- loading */

test('a row is loadable only when enabled, valid, available and served', () => {
  const target = rendererTargetOf(row())
  assert.ok(target !== null)
  assert.equal(target.url, RENDERER.url)
  assert.deepEqual(target.actions, RENDERER.actions)
  assert.deepEqual(target.callMethods, RENDERER.callMethods)

  assert.equal(rendererTargetOf(row({ enabled: false })), null)
  assert.equal(rendererTargetOf(row({ desktop: null })), null)
  assert.equal(
    rendererTargetOf(row({ desktop: { ...desktop(RENDERER), valid: false } })),
    null,
  )
  assert.equal(rendererTargetOf(row({ desktop: desktop(null) })), null, 'a pre-T3 host')
  assert.equal(
    rendererTargetOf(row({ desktop: desktop({ ...RENDERER, available: false, reason: 'renderer_module_missing' }) })),
    null,
  )
  assert.equal(rendererTargetOf(row({ desktop: desktop({ ...RENDERER, url: null }) })), null)
  assert.equal(rendererTargetOf(row({ desktop: desktop({ ...RENDERER, url: '  ' }) })), null)
})

test('a list refresh keeps the load, an upgrade, disable or removal ends it', () => {
  const target = rendererTargetOf(row())
  assert.ok(target !== null)
  const live = [{ pluginKey: target.pluginKey, revision: target.revision }]

  const unchanged = planSlotReconcile(live, [row()])
  assert.deepEqual(unchanged, { unload: [], load: [] }, 'a plain refresh does not reload the module')

  const disabled = planSlotReconcile(live, [row({ enabled: false })])
  assert.deepEqual(disabled, { unload: [target.pluginKey], load: [] })

  const removed = planSlotReconcile(live, [])
  assert.deepEqual(removed, { unload: [target.pluginKey], load: [] })

  const upgraded = planSlotReconcile(live, [row({ version: '1.1.0', lastUpdated: '2026-10-21T10:00:00Z' })])
  assert.deepEqual(upgraded.unload, [target.pluginKey])
  assert.equal(upgraded.load.length, 1)
  assert.notEqual(upgraded.load[0]?.revision, target.revision)

  const first = planSlotReconcile([], [row()])
  assert.deepEqual(first.unload, [])
  assert.deepEqual(first.load.map((load) => load.pluginKey), [target.pluginKey])

  // `available: false` on a live installation is the boundary withdrawing it: end the load.
  const withdrawn = planSlotReconcile(
    live,
    [row({ desktop: desktop({ ...RENDERER, available: false, reason: 'renderer_module_missing' }) })],
  )
  assert.deepEqual(withdrawn, { unload: [target.pluginKey], load: [] })
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pluginSettingsKey, pluginSettingsTarget } from './plugin-settings-key.ts'

/**
 * The settings resource's scope key.
 *
 * The key is a resource identity, not a request shape: the plugin settings page reads one
 * installation per workspace, and the machine-wide scope is the absence of a workspace. Encoding
 * that absence as the empty string and parsing it back as a number turned `null` into workspace
 * `0`, a workspace no registry holds — so every user-scope plugin's settings read was answered
 * `WORKSPACE_NOT_FOUND` (user report, 2026-11-11). The round trip below is the contract the keyed
 * resource relies on: a key always names the scope it was built from.
 */

test('a machine-wide settings key parses back to no workspace, never zero', () => {
  const key = pluginSettingsKey(null, 'omp.terminal')
  assert.deepEqual(pluginSettingsTarget(key), { workspaceId: null, id: 'omp.terminal' })
})

test('a workspace settings key round-trips the id it was built with', () => {
  const key = pluginSettingsKey(7, 'demo@market-a')
  assert.deepEqual(pluginSettingsTarget(key), { workspaceId: 7, id: 'demo@market-a' })
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PluginGrantRow, PluginRow } from '../api/plugins-types'
import { installationsToConfirm, pluginRowKey as pluginKey } from './plugin-grant-rules.ts'

/**
 * What an install may grant: its own additions, and nothing else.
 *
 * The rule used to be "every unconfirmed row in the workspace", which re-granted and re-enabled an
 * installation the user had withdrawn, and reversed the host's widening reconciliation after an
 * upgrade. Both cases are pinned here as refusals, beside the case the rule exists for.
 */

/** The fields the rule reads, with everything else at a harmless default. */
function row(id: string, scope: string, consent: boolean, enabled = false): PluginRow {
  return {
    id,
    name: id,
    description: null,
    version: '1.0.0',
    scope: scope as PluginRow['scope'],
    enabled,
    builtin: false,
    toggleable: true,
    shadowedBy: null,
    installId: `${id}@market`,
    source: {
      kind: 'marketplace',
      label: `${id}@market`,
      gitCommitSha: null,
      marketplace: 'market',
      installId: `${id}@market`,
      installed: true,
    },
    sources: [],
    installedAt: null,
    lastUpdated: null,
    consent: { required: consent, reasons: consent ? ['extension-modules'] : [] },
    code: {
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
    },
    settings: { keys: [], hasSecret: false },
    features: [],
    desktop: null,
    desktopError: null,
  }
}

function grant(pluginId: string, scope: string): PluginGrantRow {
  return { pluginId, scope, grantedAt: '2026-01-01T00:00:00.000Z' } as PluginGrantRow
}

test('a newly installed plugin that runs code is granted', () => {
  const fresh = row('fresh', 'user', true)
  const picked = installationsToConfirm([fresh], [], new Set())
  assert.deepEqual(
    picked.map((candidate) => candidate.id),
    ['fresh'],
  )
})

test('a plugin the user withdrew is never re-granted by a later install', () => {
  // Withdrawal disables the row and deletes its grant, so it is unconfirmed and switched off - the
  // exact shape the old sweep mistook for "needs granting".
  const withdrawn = row('withdrawn', 'user', true, false)
  const fresh = row('fresh', 'user', true)
  const before = new Set([pluginKey(withdrawn)])
  const picked = installationsToConfirm([withdrawn, fresh], [], before)
  assert.deepEqual(
    picked.map((candidate) => candidate.id),
    ['fresh'],
  )
})

test('a plugin that brings no code needs no grant, and one already granted is left alone', () => {
  const plain = row('plain', 'user', false)
  const already = row('already', 'user', true)
  const picked = installationsToConfirm([plain, already], [grant('already', 'user')], new Set())
  assert.deepEqual(picked, [])
})

test('a widening is not a new installation: the host answers for it, and a later install leaves it alone', () => {
  // The row was in the list before the upgrade, so it is `before`. The host carries the existing
  // confirmation over to the new code (`renew_widened_grants`); a later install of something else
  // must not touch it either way.
  const widened = row('widened', 'project', true, false)
  const picked = installationsToConfirm([widened], [], new Set([pluginKey(widened)]))
  assert.deepEqual(picked, [])
})

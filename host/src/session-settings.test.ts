import assert from 'node:assert/strict'
import { test } from 'node:test'

import { desktopSessionSettings } from './session-activate.ts'

/**
 * The settings a session is created with, as the overlay rule sees them.
 *
 * `createAgentSession` captures `tools.intentTracing` at creation, so neither branch may be
 * decided later: a configured reader hands their own settings through, an unconfigured one gets a
 * session-local overlay carrying the pin.
 */

interface FakeSettings {
  configured: boolean
  overlayRecord?: Record<string, unknown>
  overlay(overrides: Record<string, unknown>): FakeSettings
}

function fakeSettings(configured: boolean, overlayRecord?: Record<string, unknown>): FakeSettings {
  return {
    configured,
    overlayRecord,
    overlay: overrides => fakeSettings(true, overrides),
  }
}

const intentSetting = { isConfigured: (scope: FakeSettings) => scope.configured }

test('an unconfigured session gets a local intent overlay', () => {
  const settings = desktopSessionSettings(fakeSettings(false), intentSetting)
  assert.equal(settings.overlayRecord?.['tools.intentTracing'], true)
})

test('an explicitly configured session keeps its own settings', () => {
  const base = fakeSettings(true)
  const settings = desktopSessionSettings(base, intentSetting)
  assert.equal(settings, base)
  assert.equal(settings.overlayRecord, undefined)
})

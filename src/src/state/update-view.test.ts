import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { UpdatePhase, UpdateStatus } from '../api/update.ts'
import { clampedPercent, updateAction, updatePillVisible } from './update-view.ts'

/** One status with the fields the rules read; the rest is the shape's own empty value. */
function status(phase: UpdatePhase, overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    phase,
    version: null,
    notes: null,
    progress: null,
    error: null,
    ...overrides,
  }
}

test('the title bar pill is drawn only while a release is announced or in hand', () => {
  assert.equal(updatePillVisible(status('available', { version: '0.2.0' })), true)
  assert.equal(updatePillVisible(status('downloading', { version: '0.2.0', progress: 40 })), true)
  assert.equal(updatePillVisible(status('ready', { version: '0.2.0' })), true)
  assert.equal(updatePillVisible(status('error', { version: '0.2.0', error: 'offline' })), true)

  // Nothing to press, or nothing this build can do: the About page carries the sentence.
  assert.equal(updatePillVisible(null), false)
  assert.equal(updatePillVisible(status('idle')), false)
  assert.equal(updatePillVisible(status('checking')), false)
  assert.equal(updatePillVisible(status('current')), false)
  assert.equal(updatePillVisible(status('unsupported')), false)
  assert.equal(updatePillVisible(status('error', { error: 'offline' })), false)
})

test('a failed download retries that download; a failed check asks the feed again', () => {
  assert.equal(updateAction(status('available', { version: '0.2.0' })), 'install')
  assert.equal(updateAction(status('ready', { version: '0.2.0' })), 'relaunch')
  assert.equal(updateAction(status('idle')), 'check')
  assert.equal(updateAction(status('current')), 'check')

  // The announced version is still held after a download failure, so the retry is the download.
  assert.equal(updateAction(status('error', { version: '0.2.0', error: 'network' })), 'install')
  // A check that never announced a version has nothing to download.
  assert.equal(updateAction(status('error', { error: 'network' })), 'check')

  // A check or download in flight is not a second press, and a development build has no feed.
  assert.equal(updateAction(status('checking')), null)
  assert.equal(updateAction(status('downloading', { version: '0.2.0' })), null)
  assert.equal(updateAction(status('unsupported')), null)
  assert.equal(updateAction(null), null)
})

test('a download percentage stays inside the range a progress reading may claim', () => {
  assert.equal(clampedPercent(null), null)
  assert.equal(clampedPercent(Number.NaN), null)
  assert.equal(clampedPercent(-4), 0)
  assert.equal(clampedPercent(42.4), 42)
  assert.equal(clampedPercent(100), 100)
  assert.equal(clampedPercent(140), 100)
})

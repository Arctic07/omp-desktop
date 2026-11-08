import assert from 'node:assert/strict'
import { test } from 'node:test'

import { themeToAdopt } from './startup-theme.ts'

/**
 * Which copy of the theme a start draws with.
 *
 * The case pinned here is the reported one (2026-11-04): the theme was set to light, the next launch
 * opened dark with the settings page claiming dark, and the choice never came back. The cause was in
 * the webview's profile: `EBWebView/Default/Local Storage/leveldb/000003.log` had intact record
 * framing up to sequence 323 and a damaged record after it, and LevelDB recovers by dropping
 * everything written past the damage - the `theme = light` write was sequence 324. Every launch then
 * read `dark` from the recovered state and, because the storage was the only copy the app consulted,
 * painted dark and recorded dark over the shell's copy.
 *
 * The record in `app.sqlite` is the copy this application owns, so a start trusts it over the
 * storage. This is the rule that decides that, and it is a string comparison - which is why it is
 * here, without a document, rather than in an effect.
 */

test('the recorded theme is the one a start draws with', () => {
  assert.equal(themeToAdopt('dark', 'light'), 'light')
  assert.equal(themeToAdopt('light', 'dark'), 'dark')
  assert.equal(themeToAdopt('light', 'system'), 'system')
})

test('a first run, with no record, takes what the storage holds', () => {
  assert.equal(themeToAdopt('light', null), 'light')
  assert.equal(themeToAdopt('system', null), 'system')
})

test('nothing recorded and nothing stored leaves the provider default', () => {
  assert.equal(themeToAdopt(null, null), null)
  assert.equal(themeToAdopt('', ''), null)
})

test('a value outside the three settings is not adopted', () => {
  assert.equal(themeToAdopt('sepia', 'sepia'), null)
  assert.equal(themeToAdopt('light', 'sepia'), 'light')
  assert.equal(themeToAdopt('sepia', 'dark'), 'dark')
})

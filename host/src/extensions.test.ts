import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extensionIdField } from './extensions.ts'
import { ERROR_CODES, HostError } from './protocol/errors.ts'

/**
 * The extension id's two rules, asserted without a host.
 *
 * The field name is the first half of the contract: the Rust host writes its correlation id into
 * the envelope's `id` before encoding, so an id sent there arrives as `h7` and every toggle fails
 * (ruling C14). The prefix check is the second: `disabledExtensions` is one setting shared by every
 * capability loader, and an id outside the gated prefixes would be written and then ignored.
 */

/** The refusal an id earns, or `null` when it is accepted. */
function refusal(value: unknown): string | null {
  try {
    extensionIdField(value)
    return null
  } catch (error) {
    if (!(error instanceof HostError)) throw error
    return error.code
  }
}

test('an id is read from targetId, and the envelope key is not accepted', () => {
  assert.equal(extensionIdField('skill:review'), 'skill:review')
  assert.equal(extensionIdField('  hook:pre:bash:guard  '), 'hook:pre:bash:guard')
  // A frame that carries only `id` is refused rather than silently addressing the correlation key.
  assert.equal(refusal(undefined), ERROR_CODES.invalid_input)
})

test('only the prefixes disabledExtensions gates are accepted', () => {
  for (const id of [
    'skill:review',
    'rule:style',
    'tool:deploy',
    'hook:pre:bash:guard',
    'prompt:commit',
    'slash-command:ship',
    'context-file:AGENTS',
    'extension-module:index',
  ]) {
    assert.equal(extensionIdField(id), id)
  }
  for (const id of ['review', 'mcp:server', 'skill:', 'Skill:review', 'skill:a\u0000b']) {
    assert.equal(refusal(id), ERROR_CODES.invalid_input, id)
  }
})

test('an id is bounded by the host constant, not by the caller', () => {
  const atLimit = `skill:${'a'.repeat(512 - 'skill:'.length)}`
  assert.equal(extensionIdField(atLimit), atLimit)
  assert.equal(refusal(`${atLimit}a`), ERROR_CODES.invalid_input)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseReminder, sameReminder } from './reminder.ts'

/**
 * The reminder a rule check writes into the conversation.
 *
 * The reader is the only place that decides what a reminder *is*; the row draws what this returns.
 * What is pinned down here is the reading: the engine's attributes, its body, and the one tolerance
 * that keeps prose *about* a reminder from being read as one.
 */

/** A rule violation, as the harness writes it into a developer message. */
const RULE_VIOLATION = `<system-reminder reason="rule_violation" rule="ts-no-tiny-functions" path="builtin-defaults:ts-no-tiny-functions.md">
User-defined rule matched tool-call arguments.

MUST comply: inline functions whose whole body one expression are not allowed.
</system-reminder>`

test('a rule reminder is read as its attributes and its body', () => {
  assert.deepEqual(parseReminder(RULE_VIOLATION), {
    reason: 'rule_violation',
    rule: 'ts-no-tiny-functions',
    path: 'builtin-defaults:ts-no-tiny-functions.md',
    text:
      'User-defined rule matched tool-call arguments.\n\nMUST comply: inline functions whose whole body one expression are not allowed.',
  })
})

test('a reminder about nothing in particular keeps its body and names no rule', () => {
  // Older harnesses, and reminders that are not rule checks, carry no attributes: the row still
  // draws, and the rule it cannot name stays null rather than a guessed string.
  assert.deepEqual(parseReminder('<system-reminder>\n3 todo items still open.\n</system-reminder>'), {
    reason: null,
    rule: null,
    path: null,
    text: '3 todo items still open.',
  })
})

test('prose about a reminder is not a reminder', () => {
  // The block opens the message, which is where the harness writes it; a sentence that quotes one
  // stays a sentence.
  assert.equal(parseReminder('the engine wrote <system-reminder>3 left</system-reminder> here'), null)
  assert.equal(parseReminder(''), null)
})

test('two reminders are the same when they name the same rule', () => {
  const first = parseReminder(RULE_VIOLATION)
  const same = parseReminder(RULE_VIOLATION.replace('MUST comply: inline', 'MUST comply: 且 inline'))
  const other = parseReminder(RULE_VIOLATION.replace('ts-no-tiny-functions', 'ts-no-any'))

  assert.ok(first !== null && same !== null && other !== null)
  assert.equal(sameReminder(first, same), true)
  assert.equal(sameReminder(first, other), false)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveRewindEntry } from './session-branch.ts'
import type { SessionEntry } from './sdk.ts'

/**
 * Which message a rewind addresses.
 *
 * A transcript read names the entry directly; a row the live stream wrote has no entry id of its
 * own, and the engine's message timestamp is the one fact both paths carry. That fallback is what
 * makes "撤回" work on the prompt the reader just sent, so it is worth checking without an engine.
 */

function userEntry(id: string, stamp: number): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(stamp).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: stamp },
  }
}

/** The engine's own type tag, spelled here so a unit test need not load the engine bundle. */
const SKILL_PROMPT = 'skill-prompt'

/** The entry the engine writes for a `/skill:<name>` invocation: the body, and the draft beside it. */
function skillEntry(id: string, stamp: number): SessionEntry {
  return {
    type: 'custom_message',
    id,
    parentId: null,
    timestamp: new Date(stamp).toISOString(),
    customType: SKILL_PROMPT,
    display: true,
    attribution: 'user',
    content: '# Deploy\nRun the script in scripts/.',
    details: { name: 'deploy', args: '--now', prompt: '/skill:deploy --now' },
  } as unknown as SessionEntry
}

test('an entry id from the transcript is used as it is', () => {
  assert.equal(resolveRewindEntry([userEntry('e1', 1000)], 'e1', undefined, SKILL_PROMPT), 'e1')
})

test('a live row is found by its own message timestamp', () => {
  const branch = [userEntry('e1', 1000), userEntry('e2', 2000)]
  assert.equal(resolveRewindEntry(branch, undefined, 2000, SKILL_PROMPT), 'e2')
})

test('an ISO timestamp in the entry matches the same millisecond', () => {
  const branch: SessionEntry[] = [userEntry('e1', 1000)]
  // An older journal writes the message's own stamp as ISO; the engine's type only names milliseconds.
  const stamped = {
    type: 'message',
    id: 'e2',
    parentId: 'e1',
    timestamp: '2026-10-21T09:00:00.123Z',
    message: { role: 'user', content: 'hello', timestamp: '2026-10-21T09:00:00.123Z' },
  } as unknown as SessionEntry
  branch.push(stamped)
  assert.equal(resolveRewindEntry(branch, undefined, Date.parse('2026-10-21T09:00:00.123Z'), SKILL_PROMPT), 'e2')
})

test('two prompts at one millisecond resolve to the newest', () => {
  const branch = [userEntry('e1', 1500), userEntry('e2', 1500)]
  assert.equal(resolveRewindEntry(branch, undefined, 1500, SKILL_PROMPT), 'e2')
})

/**
 * The regression this covers (2026-10-31): the row of a `/skill:` invocation carried the engine's
 * timestamp, the host looked for a user *message* carrying it, found none - the engine stores the
 * invocation as a custom message - and answered "No user message of this conversation was written
 * at that time." The invocation is the reader's own turn, and the engine's rewind reads it as one.
 */
test('a skill invocation is a rewind point', () => {
  const branch = [userEntry('e1', 1000), skillEntry('e2', 2000)]
  // Its stamp is the entry's own: a custom message wraps no message to carry one.
  assert.equal(resolveRewindEntry(branch, undefined, 2000, SKILL_PROMPT), 'e2')
  assert.equal(resolveRewindEntry(branch, 'e2', undefined, SKILL_PROMPT), 'e2')
})

test('a custom message the reader did not write is not a rewind point', () => {
  const delivery = {
    type: 'custom_message',
    id: 'e3',
    parentId: 'e2',
    timestamp: new Date(3000).toISOString(),
    customType: 'async-result',
    display: true,
    content: 'Job 3 finished.',
  } as unknown as SessionEntry
  assert.throws(
    () => resolveRewindEntry([userEntry('e1', 1000), delivery], undefined, 3000, SKILL_PROMPT),
    /No user message/,
  )
})

test('a timestamp no user message carries is refused', () => {
  assert.throws(() => resolveRewindEntry([userEntry('e1', 1000)], undefined, 999, SKILL_PROMPT), /No user message/)
})

test('neither address is refused', () => {
  assert.throws(() => resolveRewindEntry([], undefined, undefined, SKILL_PROMPT), /entry id or the message timestamp/)
})

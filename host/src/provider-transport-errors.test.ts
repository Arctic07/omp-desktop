/**
 * The provider-transport classification this build depends on, held at the reading the two
 * `patches/@oh-my-pi__*` files put in place.
 *
 * The gateway this desktop talks to is Go-based and forwards its own `net.OpError` text verbatim
 * ("Error reading stream: read tcp a:b->c:d: read: connection reset by peer"). Neither published
 * `@oh-my-pi` package classifies that wording, so a stream cut mid-turn ended the turn with no
 * retry and no resume — the engine's whole recovery path is gated behind
 * `AIError.retriable(classifyMessage(...))` and `turn-recovery.ts`'s mid-stream transport class.
 *
 * The tests read the classifier rather than the patch files, so a version bump that drops
 * `pnpm.patchedDependencies`, or a re-resolve that installs an unpatched copy, fails here instead of
 * quietly ending turns again. The second half of the fix — the same pattern added to the engine's
 * private `#isMidStreamTransportFailure` — has no exported seam to read; its tripwire is
 * `pnpm install` refusing to apply `patches/@oh-my-pi__pi-coding-agent@<version>.patch` once the
 * code it edits moves.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyMessage, retriable } from '@oh-my-pi/pi-ai/error'

/** What the gateway printed when it died reading its own upstream. */
const GO_READ_FAILURE =
  'Error reading stream: read tcp 10.20.101.233:45282->3.173.21.63:443: read: connection reset by peer'

/** The same `net.OpError` shape on the write side, which a proxy reports as a broken pipe. */
const GO_WRITE_FAILURE = 'write tcp 10.0.0.2:1234->1.2.3.4:443: write: broken pipe'

/** The control: a rejected request must never be retried into the same answer. */
const REJECTED_REQUEST = '400 Bad Request: invalid model'

function isRetriable(errorMessage: string): boolean {
  return retriable(classifyMessage({ errorMessage }))
}

test('a Go relay cutting the stream is retriable', () => {
  assert.equal(isRetriable(GO_READ_FAILURE), true)
  assert.equal(isRetriable(GO_WRITE_FAILURE), true)
})

test('a rejected request stays unretriable', () => {
  assert.equal(isRetriable(REJECTED_REQUEST), false)
})

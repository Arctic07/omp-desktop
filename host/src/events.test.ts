/**
 * The outbound side of one session, against the budget it has to survive.
 *
 * The property under test is the one a reader's cursor rests on: the frames it receives carry every
 * sequence number exactly once, in order. The budget may take frames when a consumer falls behind
 * (`SessionEvents`'s own shedding), and that is only sound if a frame the reader never sees was never
 * numbered - the journal's window is no larger than the queue's budget, so a numbered frame the
 * budget took could not be replayed back either, and the reader answered every one of them with a
 * resync, a warning line and a full re-read of the conversation.
 *
 * Run: `pnpm --filter omp-host test` (bun is the host's runtime, so bun runs these).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SessionEvents, withoutSnapshot } from './events.ts'

/** A writer reduced to what the pipe reads: what went out, and whether the consumer is behind. */
class RecordingWriter {
  readonly sent: number[] = []
  /** The session identity every line carried, as the reader parses it back. */
  readonly sessions: string[] = []
  congested = true
  sendLine(line: string): void {
    const frame = JSON.parse(line) as { sessionId: string; seq: number }
    this.sent.push(frame.seq)
    this.sessions.push(frame.sessionId)
  }
  async flush(): Promise<void> {}
}

/** More frames, and larger ones, than the outbound budget can hold. */
const FLOOD_FRAMES = 6_000
const FRAME_BYTES = 2_000

/** Where a run of published numbers stops being "one, then every next one", or -1 when it never does. */
function firstBreak(sent: readonly number[]): number {
  for (let index = 0; index < sent.length; index += 1) {
    if (sent[index] !== index + 1) return index
  }
  return -1
}

test('a flood the budget takes frames from still publishes every sequence number once, in order', async () => {
  const writer = new RecordingWriter()
  let shed = 0
  const events = new SessionEvents('flood', writer, count => (shed += count), () => undefined)
  for (let index = 0; index < FLOOD_FRAMES; index += 1) {
    events.emit({ type: 'tool_execution_update', toolCallId: 'call-1', resultText: 'x'.repeat(FRAME_BYTES) })
  }
  // The first pass sheds down to the budget and holds, because the consumer is behind; the second
  // runs after it caught up, and is what puts the frames that survived on the wire.
  await events.flush()
  writer.congested = false
  await events.flush()

  assert.ok(shed > 0, 'the budget took no frames, so the run proves nothing')
  assert.ok(writer.sent.length > 0, 'nothing was published at all')
  assert.ok(writer.sent.length < FLOOD_FRAMES, 'the whole flood went out, so the budget never bound')
  assert.equal(firstBreak(writer.sent), -1, `the published stream skips a number at ${String(firstBreak(writer.sent))}`)
  // The identity is spliced into the serialized body rather than serialized with it, so the line
  // every frame went out on is the one place that can be checked: a frame that lost it, or that
  // arrived as anything other than one JSON object, would be refused by the reader.
  assert.ok(
    writer.sessions.every(sessionId => sessionId === 'flood'),
    'a published line did not carry the session identity it was numbered under',
  )
  events.dispose()
})

test('a report the encoder raises while publishing is not swept away with the batch it interrupted', async () => {
  const sent: number[] = []
  let events: SessionEvents
  const writer = {
    congested: false,
    sendLine(line: string): void {
      const frame = JSON.parse(line) as { seq: number; type: string }
      sent.push(frame.seq)
      if (frame.type === 'unencodable') events.emitProtected({ type: 'notice', message: 'frame encoding failed' })
    },
    async flush(): Promise<void> {},
  }
  events = new SessionEvents('encode', writer, () => undefined, () => undefined)
  events.emit({ type: 'unencodable' })
  await events.flush()
  await events.flush()

  assert.deepEqual(sent, [1, 2], 'the report raised while publishing did not go out behind the frame that raised it')
  events.dispose()
})

/**
 * The cumulative snapshot in a `message_update` is dropped even when the engine message carries no
 * id: the desktop pairs the increment with the row its opening frame announced, and the id is not
 * what it reads here. Requiring one left every update carrying the whole answer again (the
 * quadratic transport cost this trim exists to prevent).
 */
test('a streaming update is trimmed whether or not its message has an id', () => {
  const withId = withoutSnapshot({
    type: 'message_update',
    message: { id: 'm1', role: 'assistant', timestamp: 5, content: 'the whole answer so far' },
    assistantMessageEvent: { type: 'text_delta', delta: 'so', partial: 'the whole answer so' },
  })
  assert.deepEqual(withId.message, { id: 'm1', role: 'assistant', timestamp: 5 })
  assert.deepEqual(withId.assistantMessageEvent, { type: 'text_delta', delta: 'so' })

  const withoutId = withoutSnapshot({
    type: 'message_update',
    message: { role: 'assistant', timestamp: 5, content: 'the whole answer so far' },
    assistantMessageEvent: { type: 'text_delta', delta: 'so', partial: 'the whole answer so' },
  })
  assert.deepEqual(withoutId.message, { role: 'assistant', timestamp: 5 })
  assert.deepEqual(withoutId.assistantMessageEvent, { type: 'text_delta', delta: 'so' })
})

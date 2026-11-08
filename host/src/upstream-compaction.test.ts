/**
 * The rules that adopt an endpoint's own compaction, exercised without a live engine.
 *
 * The real arrival is a transcript fact - a summary document where a tool result should have been
 * answered - so the table below is built from transcripts: which entry preceded the reply, what the
 * reply carried, and whether a turn was still running. The adoption itself is decided by order
 * (compaction before continuation) and by what the armed text does at the engine's own hook, both
 * observable through a fake record.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type {
  ExtensionAPI,
  ExtensionHandler,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionEntry,
} from './sdk.ts'
import type { LiveSession } from './sessions.ts'
import {
  adoptUpstreamCompaction,
  forgetUpstreamCompaction,
  upstreamCompactionExtension,
  upstreamSummaryBody,
  upstreamSummaryOf,
} from './upstream-compaction.ts'

const BODY = `## Goal\n${'Adopt the endpoint summary and continue the work.\n'.repeat(12)}`

/** The summary document the endpoint returned, per the transcript. */
const SUMMARY_REPLY = `<analysis>
Let me work through the conversation chronologically.
</analysis>
<summary>
${BODY}
</summary>`

/** A reply shaped the way the endpoint writes one. */
function reply(text: string, overrides: Record<string, unknown> = {}) {
  return { role: 'assistant', stopReason: 'stop', content: [{ type: 'text' as const, text }], ...overrides }
}

/** One branch entry holding `message`. */
function entry(id: string, role: string, message: object = { role, content: [] }): SessionEntry {
  return { type: 'message', id, message } as unknown as SessionEntry
}

/** A branch whose last entry is the reply, preceded by one entry of `before`. */
function branchOf(before: string, last: object): SessionEntry[] {
  return [entry('a', before), entry('b', 'assistant', last)]
}

test('the summary envelope is read out of a compaction reply', () => {
  assert.equal(upstreamSummaryBody(SUMMARY_REPLY), BODY.trim())
})

test('numbered sections without an analysis block still read as a summary', () => {
  const text = `<summary>
Primary Request and Intent: the import feature.
Key Technical Concepts: NDJSON frames.
Optional Next Step: fix the fixture.
${'x'.repeat(300)}
</summary>`
  assert.equal(upstreamSummaryBody(text)?.startsWith('Primary Request'), true)
})

test('an answer that is not a summary document is left alone', () => {
  // Prose, no envelope at all.
  assert.equal(upstreamSummaryBody('The fixture writes nothing to disk, so the second apply imports again.'), undefined)
  // The tag pair with nothing worth compacting under it.
  assert.equal(upstreamSummaryBody('<summary>done</summary>'), undefined)
  // One heading mentioned in passing is not a summary document.
  const passage = `<summary>Optional Next Step is the section I would read next. ${'y'.repeat(400)}</summary>`
  assert.equal(upstreamSummaryBody(passage), undefined)
  // An analysis block alone, with no summary, is not one either.
  assert.equal(upstreamSummaryBody(`<analysis>${'z'.repeat(400)}</analysis>`), undefined)
})

test('a summary that answers a tool result is an endpoint compaction', () => {
  assert.equal(upstreamSummaryOf(branchOf('toolResult', reply(SUMMARY_REPLY))), BODY.trim())
})

test('a summary the user asked for is never adopted', () => {
  const asked = { role: 'user', content: [{ type: 'text', text: '帮我总结一下这次改动' }] }
  assert.equal(upstreamSummaryOf([entry('a', 'user', asked), entry('b', 'assistant', reply(SUMMARY_REPLY))]), undefined)
  // The same request in another spelling the reader might type.
  for (const text of ['summarize this conversation', '给个摘要', 'recap please', '/compact']) {
    const message = { role: 'user', content: text }
    assert.equal(
      upstreamSummaryOf([entry('a', 'user', message), entry('b', 'assistant', reply(SUMMARY_REPLY))]),
      undefined,
      text,
    )
  }
})

test('a follow-up prompt answered with a summary is an endpoint compaction', () => {
  const prompt = { role: 'user', content: [{ type: 'text', text: '那继续把 mcp 导入做完' }] }
  const entries = [entry('a', 'user', prompt), entry('b', 'assistant', reply(SUMMARY_REPLY))]
  assert.equal(upstreamSummaryOf(entries), BODY.trim())
})

test('a reply that still carries a tool call is work, not a compaction', () => {
  const working = {
    ...reply(SUMMARY_REPLY),
    stopReason: 'toolUse',
    content: [
      { type: 'text' as const, text: SUMMARY_REPLY },
      { type: 'toolCall' as const, id: 'call_1', name: 'bash', arguments: {} },
    ],
  }
  assert.equal(upstreamSummaryOf(branchOf('toolResult', working)), undefined)
})

test('a summary in the middle of a turn is not the turn ending', () => {
  const entries = [...branchOf('toolResult', reply(SUMMARY_REPLY)), entry('c', 'toolResult')]
  assert.equal(upstreamSummaryOf(entries), undefined)
})

/** What one adoption run needs from a record, recording the calls it makes and in what order. */
interface FakeRun {
  readonly live: LiveSession
  readonly order: string[]
  readonly notices: string[]
}

/** What a `session_before_compact` handler is, at the one event the fake registers. */
type BeforeCompactHandler = ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>

/** A fake record whose `compact` runs the registered hook, as the engine's own pass would. */
function fakeLive(
  summaryText: string,
  state: { streaming?: boolean; compactFails?: Error } = {},
): FakeRun {
  const order: string[] = []
  const notices: string[] = []
  let beforeCompact: BeforeCompactHandler | undefined
  // The engine's registration is one object with an overload per event; the fake keeps the one
  // this module registers, which is the only handler it ever asks for.
  const pi = {
    on: (event: string, handler: unknown) => {
      if (event === 'session_before_compact') beforeCompact = handler as BeforeCompactHandler
    },
  }
  upstreamCompactionExtension('session-1')(pi as unknown as ExtensionAPI)
  const last = reply(summaryText)
  const branch = branchOf('toolResult', last)
  const live = {
    sessionId: 'session-1',
    // The engine's own nudge, as `sdk.ts` carries it onto the record.
    autoContinuePrompt: 'Resume the user\'s latest intent.',
    manager: { getBranch: () => branch },
    agent: {
      isStreaming: state.streaming ?? false,
      isCompacting: false,
      hasPostPromptWork: false,
      getLastAssistantMessage: () => last,
      emitNotice: (_level: string, message: string) => {
        notices.push(message)
      },
      compact: async () => {
        order.push('compact')
        if (state.compactFails !== undefined) throw state.compactFails
        const event = { preparation: { firstKeptEntryId: 'a', tokensBefore: 500_000 } }
        const armed = await beforeCompact?.(event as SessionBeforeCompactEvent, undefined as never)
        assert.equal(armed?.compaction?.summary, BODY.trim(), 'the armed summary reaches the hook')
      },
      prompt: async () => {
        order.push('continue')
      },
    },
  } as unknown as LiveSession
  return { live, order, notices }
}

test('an adopted compaction lands before the continuation turn', async () => {
  forgetUpstreamCompaction('session-1')
  const run = fakeLive(SUMMARY_REPLY)
  assert.equal(await adoptUpstreamCompaction(run.live, { settleMs: 0 }), true)
  assert.deepEqual(run.order, ['compact', 'continue'])
  assert.equal(run.notices.length, 1)
})

test('the adoption is spent once', async () => {
  forgetUpstreamCompaction('session-1')
  const run = fakeLive(SUMMARY_REPLY)
  assert.equal(await adoptUpstreamCompaction(run.live, { settleMs: 0 }), true)
  // A second pass inside the cooldown adopts nothing, so the hook never sees a stale arm.
  assert.equal(await adoptUpstreamCompaction(run.live, { settleMs: 0 }), false)
  assert.deepEqual(run.order, ['compact', 'continue'])
})

test('a conversation that never settles is not compacted into', async () => {
  forgetUpstreamCompaction('session-1')
  const run = fakeLive(SUMMARY_REPLY, { streaming: true })
  assert.equal(await adoptUpstreamCompaction(run.live, { settleMs: 0 }), false)
  assert.deepEqual(run.order, [])
})

test('a failed adoption reports instead of continuing on the same history', async () => {
  forgetUpstreamCompaction('session-1')
  const run = fakeLive(SUMMARY_REPLY, { compactFails: new Error('the summarizer exploded') })
  assert.equal(await adoptUpstreamCompaction(run.live, { settleMs: 0 }), false)
  assert.deepEqual(run.order, ['compact'])
  assert.match(run.notices[0] ?? '', /the summarizer exploded/)
})

test('a conversation the engine will not cut is not a failure', async () => {
  forgetUpstreamCompaction('session-1')
  const run = fakeLive(SUMMARY_REPLY, { compactFails: new Error('Nothing to compact (session too small)') })
  assert.equal(await adoptUpstreamCompaction(run.live, { settleMs: 0 }), false)
  // Nothing was adopted, so nothing is reported and no turn is started on the unchanged history.
  assert.deepEqual(run.order, ['compact'])
  assert.deepEqual(run.notices, [])
})

test('a turn paused for background work is compacted without a second continuation', async () => {
  forgetUpstreamCompaction('session-1')
  const run = fakeLive(SUMMARY_REPLY)
  assert.equal(await adoptUpstreamCompaction(run.live, { settleMs: 0, continueAfter: false }), true)
  // The engine already holds the continuation for this turn - the job it is waiting on - and a
  // nudge here would start a second turn beside it.
  assert.deepEqual(run.order, ['compact'])
  assert.equal(run.notices.length, 1)
  assert.match(run.notices[0] ?? '', /pending background work continues the turn/)
})

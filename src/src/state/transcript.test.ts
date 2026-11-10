import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatMessage, SessionEvent } from '../api/session-types.ts'
import type { SessionNotice } from './transcript.ts'
import { canRewindMessage, clearReclaimNotices, foldTranscript, isUnwritten, mergeTranscript, pushNotice, rewindCutIndex, withdrawLocalPrompts, EMPTY_TRANSCRIPT } from './transcript.ts'

/**
 * What one frame does to one conversation's rows.
 *
 * The transcript is folded from two sources — the rows on disk and the frames a live turn streams —
 * and this file pins down the seam between them: a frame lands in the row it is about, a frame that
 * arrives twice would show its words twice, and a walk that meets rows already on screen merges
 * with them instead of seeding the conversation again.
 *
 * The shape it guards against is the one a reader reported: an answer drawn with every word
 * repeated, because two listeners on one conversation's channel each folded every frame.
 */

function user(id: string, text: string, at = 1): ChatMessage {
  return { kind: 'user', id, at, text, attachments: [] }
}

function assistant(id: string, text: string, thinking = '', at = 2): ChatMessage {
  return {
    kind: 'assistant',
    id,
    at,
    text,
    thinking,
    error: null,
    startedAt: null,
    endedAt: null,
    usage: null,
    modelProvider: null,
    modelId: null,
  }
}

function tool(id: string, name: string, at = 3): ChatMessage {
  return {
    kind: 'tool',
    id,
    toolCallId: id,
    at,
    name,
    state: 'success',
    argsText: '',
    resultText: '',
    startedAt: at,
    endedAt: at + 1,
    intent: null,
  }
}

function delta(messageId: string, text: string | null, thinking: string | null = null): SessionEvent {
  return { type: 'delta', messageId, textDelta: text, thinkingDelta: thinking }
}

test('a message streams into one row, and the row reads exactly what the engine sent', () => {
  let state = foldTranscript(EMPTY_TRANSCRIPT, {
    type: 'message_started',
    messageId: 'm1',
    role: 'assistant',
    at: 10,
  })
  state = foldTranscript(state, delta('m1', '真不真'))
  state = foldTranscript(state, delta('m1', '看产出：'))
  state = foldTranscript(state, delta('m1', null, '用户说'))

  assert.equal(state.messages.length, 1)
  const row = state.messages[0]
  assert.equal(row.kind, 'assistant')
  assert.equal(row.kind === 'assistant' ? row.text : '', '真不真看产出：')
  assert.equal(row.kind === 'assistant' ? row.thinking : '', '用户说')
})

test('a message whose opening frame was missed is drawn when it finishes', () => {
  // A listener that attached mid-message sees no opening frame and possibly no delta (an answer
  // that is only a picture). The closing frame is a complete statement of the row.
  const state = foldTranscript(EMPTY_TRANSCRIPT, {
    type: 'message_finished',
    messageId: 'm9',
    startedAt: 1_700,
    endedAt: 1_900,
    usage: null,
    modelProvider: 'moonshot',
    modelId: 'kimi-k2',
    images: [{ mimeType: 'image/png', bytes: 3, dataUrl: 'data:image/png;base64,AAAA' }],
  })
  assert.equal(state.messages.length, 1)
  const row = state.messages[0]
  assert.equal(row.kind, 'assistant')
  if (row.kind === 'assistant') {
    assert.equal(row.id, 'm9')
    assert.equal(row.startedAt, 1_700)
    assert.equal(row.images?.length, 1)
  }
})

test('a delta for a message this process never saw opened still opens its own row', () => {
  // Attaching to a turn already running: the start frame is behind us, the text is not.
  const state = foldTranscript(EMPTY_TRANSCRIPT, delta('m9', 'half an answer'))

  assert.equal(state.messages.length, 1)
  const row = state.messages[0]
  assert.equal(row.kind === 'assistant' ? row.text : '', 'half an answer')
})

test('folding a frame leaves every row it did not touch with its own identity', () => {
  // What makes the transcript cheap to redraw while it streams: the rows a frame did not change are
  // the same objects, so the memoized row components are not asked to render again.
  const first = assistant('m1', 'one')
  const second = tool('t1', 'grep')
  const before = { ...EMPTY_TRANSCRIPT, messages: [user('u1', 'go'), first, second] }

  const after = foldTranscript(before, {
    type: 'tool_updated',
    toolCallId: 't1',
    resultText: 'a hit',
  })

  assert.equal(after.messages[0], before.messages[0])
  assert.equal(after.messages[1], before.messages[1])
  assert.notEqual(after.messages[2], before.messages[2])
  assert.equal(after.messages[2].kind === 'tool' ? after.messages[2].resultText : '', 'a hit')
})

test("the engine's own id claims the row the reader's prompt was written under", () => {
  const local = user('local:1', 'hello')
  const started: SessionEvent = {
    type: 'message_started',
    messageId: 'u-engine',
    role: 'user',
    at: 42,
  }
  const state = foldTranscript({ ...EMPTY_TRANSCRIPT, messages: [local] }, started)

  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].id, 'u-engine')
})

test("a command the engine never records does not take the prompt's id", () => {
  // `/compact` is run by the host: no engine message will ever claim its echo, so it waits ahead of
  // the next real prompt. Claiming "the first pending row" would hand the command the answer's id
  // and leave the prompt waiting forever (2026-10-22).
  const local = [user('local:1', '/compact', 1_000), user('local:2', 'fix the panel tab', 3_000)]
  const started: SessionEvent = {
    type: 'message_started',
    messageId: 'u-engine',
    role: 'user',
    at: 3_010,
  }

  const state = foldTranscript({ ...EMPTY_TRANSCRIPT, messages: local }, started)

  assert.deepEqual(
    state.messages.map((row) => row.id),
    ['local:1', 'u-engine'],
  )
  assert.equal(state.messages[1].kind === 'user' ? state.messages[1].text : '', 'fix the panel tab')
})

test('a claim without a timestamp takes the prompt written last', () => {
  const local = [user('local:1', '/compact', 1_000), user('local:2', 'and then this', 3_000)]
  const started: SessionEvent = {
    type: 'message_started',
    messageId: 'u-engine',
    role: 'user',
    at: null,
  }

  const state = foldTranscript({ ...EMPTY_TRANSCRIPT, messages: local }, started)

  assert.deepEqual(
    state.messages.map((row) => row.id),
    ['local:1', 'u-engine'],
  )
})

test('a walk that meets rows on screen keeps them and adds what the file has', () => {
  const local = [user('u1', 'go'), assistant('m1', 'an answer')]
  const fromFile = [user('u1', 'go'), assistant('m1', 'an answer'), tool('t1', 'read')]

  const merged = mergeTranscript(local, fromFile)

  assert.equal(merged.length, 3)
  assert.deepEqual(
    merged.map((row) => row.id),
    ['u1', 'm1', 't1'],
  )
})

test('a row the file has not caught up with is kept at the end of the walk', () => {
  const local = [user('u1', 'go'), assistant('m1', 'an answer'), assistant('m2', 'more')]
  const fromFile = [user('u1', 'go'), assistant('m1', 'an answer')]

  const merged = mergeTranscript(local, fromFile)

  assert.deepEqual(
    merged.map((row) => row.id),
    ['u1', 'm1', 'm2'],
  )
})

test('a row the file will never carry keeps the place it was written in', () => {
  // `/compact` is a command the host runs itself: no engine message claims the row and the file
  // never holds it, so it survives every walk. The answer written after it must stay below it -
  // appending the leftover would show a message from minutes ago under a newer answer, as though
  // the conversation had sent it again (2026-10-22).
  const local = [
    user('u1', 'go', 1_000),
    user('local:2', '/compact', 2_000),
    assistant('m1', 'the new head image is built', '', 5_000),
  ]
  const fromFile = [user('u1', 'go', 1_000), assistant('m1', 'the new head image is built', '', 5_000)]

  const merged = mergeTranscript(local, fromFile)

  assert.deepEqual(
    merged.map((row) => row.id),
    ['u1', 'local:2', 'm1'],
  )
})

test('leftovers of one moment stay together, in the order they were written', () => {
  const local = [
    user('u1', 'go', 1_000),
    user('local:2', '/compact', 2_000),
    user('local:3', 'the panel keeps failing', 2_010),
    assistant('m1', 'later answer', '', 5_000),
  ]
  const fromFile = [user('u1', 'go', 1_000), assistant('m1', 'later answer', '', 5_000)]

  const merged = mergeTranscript(local, fromFile)

  assert.deepEqual(
    merged.map((row) => row.id),
    ['u1', 'local:2', 'local:3', 'm1'],
  )
})

test('a prompt the file already carries is not drawn twice', () => {
  // The reader's own row is written here under a local id; a prompt sent just before the listener
  // was released is one the file already holds under the engine's own id.
  const local = [user('local:7', 'run the tests'), assistant('m1', 'ok')]
  const fromFile = [user('u-engine', 'run the tests'), assistant('m1', 'ok')]

  const merged = mergeTranscript(local, fromFile)

  assert.equal(merged.length, 2)
  assert.deepEqual(
    merged.map((row) => row.id),
    ['u-engine', 'm1'],
  )
})

test('a delivery the file writes under another id is not drawn twice', () => {
  // The live path announces an injected custom message under a host-generated id; the file carries
  // the entry's own id, which the read back hashes. Same moment and same words are what pair them.
  const local = [assistant('m12', '<system-notice>done</system-notice>', '', 1_700)]
  const fromFile = [assistant('m0a1b2c3', '<system-notice>done</system-notice>', '', 1_700)]

  const merged = mergeTranscript(local, fromFile)

  assert.deepEqual(
    merged.map((row) => row.id),
    ['m0a1b2c3'],
  )
})

test('a skill prompt the file writes under another id is not drawn twice', () => {
  const local = [user('m17', '/skill:demo --fast', 1_700)]
  const fromFile = [user('m0d4e5f6', '/skill:demo --fast', 1_700)]

  const merged = mergeTranscript(local, fromFile)

  assert.deepEqual(
    merged.map((row) => row.id),
    ['m0d4e5f6'],
  )
})

test('a local row whose words the file does not carry is kept', () => {
  const local = [user('local:7', 'run the tests')]
  const fromFile = [user('u-engine', 'something else')]

  const merged = mergeTranscript(local, fromFile)

  assert.equal(merged.length, 2)
})

test('a conversation is unwritten only while the engine says so and nothing is in it', () => {
  assert.equal(isUnwritten(true, []), true)
  assert.equal(isUnwritten(true, [user('u1', 'hi')]), false)
  // The engine's own reading is what decides: a conversation it reports as holding messages is
  // never drawn as an empty one, however few rows this process has read yet.
  assert.equal(isUnwritten(false, []), false)
})

test('a stopped answer says so on the row the live stream closes', () => {
  // The live path used to learn a stop reason only by reading the transcript back from disk, so a
  // turn the reader stopped drew as an empty answer until the conversation was reopened.
  const opened = foldTranscript(EMPTY_TRANSCRIPT, {
    type: 'message_started',
    messageId: 'm1',
    role: 'assistant',
    at: 10,
  })
  const finished = foldTranscript(opened, {
    type: 'message_finished',
    messageId: 'm1',
    startedAt: 10,
    endedAt: 20,
    usage: null,
    modelProvider: 'p',
    modelId: 'm',
    stopReason: 'aborted',
    error: 'Interrupted by user',
  })
  const row = finished.messages[0]
  assert.equal(row.kind === 'assistant' ? row.stopReason : undefined, 'aborted')
  assert.equal(row.kind === 'assistant' ? row.error : undefined, 'Interrupted by user')
})

/**
 * The reported loss, pinned at the fold: a turn ended green with only its tool calls on screen and
 * the answer appeared only after the app was reopened. The closing frame now carries the message's
 * whole record, so the row is completed from it however much (or little) of the stream arrived.
 */
test('the closing frame completes the row with the whole answer', () => {
  const opened = foldTranscript(EMPTY_TRANSCRIPT, {
    type: 'message_started',
    messageId: 'm1',
    role: 'assistant',
    at: 10,
  })
  // A stream cut short: two fragments arrived, the rest never did.
  const streamed = foldTranscript(foldTranscript(opened, delta('m1', 'the ')), delta('m1', 'ans'))
  const finished = foldTranscript(streamed, {
    type: 'message_finished',
    messageId: 'm1',
    startedAt: 10,
    endedAt: 20,
    usage: null,
    modelProvider: 'p',
    modelId: 'm',
    text: 'the answer',
    thinking: 'checked',
  })
  const row = finished.messages[0]
  assert.equal(row.kind === 'assistant' ? row.text : '', 'the answer')
  assert.equal(row.kind === 'assistant' ? row.thinking : '', 'checked')
})

test('an answer whose deltas never arrived is drawn whole by its closing frame', () => {
  const opened = foldTranscript(EMPTY_TRANSCRIPT, {
    type: 'message_started',
    messageId: 'm1',
    role: 'assistant',
    at: 10,
  })
  const finished = foldTranscript(opened, {
    type: 'message_finished',
    messageId: 'm1',
    startedAt: 10,
    endedAt: 20,
    usage: null,
    modelProvider: 'p',
    modelId: 'm',
    text: 'the whole answer',
  })
  const row = finished.messages[0]
  assert.equal(row.kind === 'assistant' ? row.text : '', 'the whole answer')
})

test('a closing frame under a row of another kind draws the answer and frees the name', () => {
  // A retained record can hold an older row under the same name; the answer is the one the frame is
  // about, so the older row moves aside instead of the answer going undrawn.
  const held = { ...EMPTY_TRANSCRIPT, messages: [user('m1', 'the reader wrote this')] }
  const finished = foldTranscript(held, {
    type: 'message_finished',
    messageId: 'm1',
    startedAt: 10,
    endedAt: 20,
    usage: null,
    modelProvider: 'p',
    modelId: 'm',
    text: 'the answer',
  })
  assert.equal(finished.messages.length, 2)
  assert.equal(finished.messages[0]?.kind === 'user' ? finished.messages[0].id : '', 'm1#1')
  assert.equal(finished.messages[1]?.kind === 'assistant' ? finished.messages[1].text : '', 'the answer')
})

test('a closing frame with no text keeps the delta behaviour of an older host', () => {
  const opened = foldTranscript(EMPTY_TRANSCRIPT, {
    type: 'message_started',
    messageId: 'm1',
    role: 'assistant',
    at: 10,
  })
  const streamed = foldTranscript(opened, delta('m1', 'what arrived'))
  const finished = foldTranscript(streamed, {
    type: 'message_finished',
    messageId: 'm1',
    startedAt: 10,
    endedAt: 20,
    usage: null,
    modelProvider: 'p',
    modelId: 'm',
  })
  const row = finished.messages[0]
  assert.equal(row.kind === 'assistant' ? row.text : '', 'what arrived')
})

test('the turn that ended keeps its outcome, and a new turn does not inherit it', () => {
  const ended = foldTranscript(EMPTY_TRANSCRIPT, {
    type: 'turn_finished',
    turnId: 'turn-1',
    outcome: 'failed',
    error: 'rate limited',
    at: 30,
  })
  assert.equal(ended.turnId, null)
  assert.deepEqual(ended.lastTurn, {
    turnId: 'turn-1',
    outcome: 'failed',
    error: 'rate limited',
    at: 30,
    stopped: false,
  })

  const next = foldTranscript(ended, { type: 'turn_started', turnId: 'turn-2', at: 40 })
  assert.equal(next.turnId, 'turn-2')
  assert.equal(next.lastTurn?.turnId, 'turn-1', 'the last ending stays readable while the next runs')
})

test('a confirmed stop is carried onto the ending the same frame writes', () => {
  // The record's live flag is cleared by the frame that ends the turn, so the ending has to carry
  // it — read before the clear, in the same write.
  const ended = foldTranscript(
    EMPTY_TRANSCRIPT,
    { type: 'turn_finished', turnId: 'turn-1', outcome: 'failed', error: 'rate limited', at: 30 },
    { stopRequested: true },
  )
  assert.equal(ended.lastTurn?.stopped, true)
})

test('an eval call folds into a tool row and settles where it started', () => {
  // A call's arguments are the row's own detail and its end changes only its state; nothing in the
  // shell watches an eval call for anything beyond that.
  const state = foldTranscript(EMPTY_TRANSCRIPT, {
    type: 'tool_started',
    toolCallId: 't1',
    name: 'eval',
    argsText: '({ text: await read("a.txt") })',
    startedAt: 10,
    intent: null,
  })
  assert.equal(state.messages.length, 1)
  const started = state.messages[0]
  assert.equal(started?.kind, 'tool')
  assert.equal(started?.kind === 'tool' ? started.state : null, 'running')
  const settled = foldTranscript(state, {
    type: 'tool_finished',
    toolCallId: 't1',
    name: 'eval',
    state: 'success',
    resultText: '{}',
    endedAt: 20,
  })
  assert.equal(settled.messages[0]?.kind, 'tool')
  const settledRow = settled.messages[0]
  assert.equal(settledRow?.kind === 'tool' ? settledRow.state : null, 'success')
})

function runtimeState(isStreaming: boolean, lastEventAt = 0): SessionEvent {
  return {
    type: 'state',
    state: {
      sessionId: 's1',
      modelProvider: 'provider',
      modelId: 'model',
      thinkingLevel: null,
      thinkingLevels: [],
      isStreaming,
      messageCount: 0,
      contextTokens: 0,
      contextWindow: 0,
      contextPercent: 0,
      autoCompactPercent: null,
      contextAnchored: false,
      contextCategories: {
        systemPrompt: 0,
        systemTools: 0,
        systemContext: 0,
        skills: 0,
        messages: 0,
      },
      sessionUsage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      commands: [],
      pendingAsyncWork: false,
      cancellableSubagents: 0,
      lastEventAt,
    },
  }
}

test('a snapshot taken mid-turn does not outlive the ending that disproves it', () => {
  // The host republishes the state view on an edge inside a turn - a model change, a stop, a child
  // settling - and never at the ending, so the snapshot is still the mid-turn one when
  // `turn_finished` arrives. Left alone it keeps the conversation reading as streaming with no turn
  // in flight, which is what the user saw as the rail's newest card stuck on "Working…" and the
  // send control stuck on stop (2026-10-22).
  let state = foldTranscript(EMPTY_TRANSCRIPT, { type: 'turn_started', turnId: 't1', at: 10 })
  state = foldTranscript(state, runtimeState(true))
  // A screen attaching mid-turn has no `turn_started` of its own; the snapshot is all it has.
  assert.equal(foldTranscript(EMPTY_TRANSCRIPT, runtimeState(true)).runtime?.isStreaming, true)
  state = foldTranscript(state, {
    type: 'turn_finished',
    turnId: 't1',
    outcome: 'completed',
    error: null,
    at: 20,
  })
  assert.equal(state.turnId, null)
  assert.equal(state.runtime?.isStreaming, false)
  assert.equal(state.lastTurn?.outcome, 'completed')
})

test('an ending with no snapshot at all folds cleanly', () => {
  const state = foldTranscript(EMPTY_TRANSCRIPT, {
    type: 'turn_finished',
    turnId: 't1',
    outcome: 'completed',
    error: null,
    at: 20,
  })
  assert.equal(state.runtime, null)
  assert.equal(state.turnId, null)
})

test('a snapshot built before the ending cannot re-assert streaming after it', () => {
  // The reader's report (2026-10-26): an answer finished, the screen kept drawing 「工作中… 31m
  // 29.7s」, and every stop press answered there was nothing to stop. The host's snapshot is fetched
  // by round trip, so the one built inside the turn can be published after the ending that disproves
  // it; its own clock says so (`lastEventAt` is when the host last heard from the engine, and the
  // ending's `at` is later), and that is the fact this fold reads.
  let state = foldTranscript(EMPTY_TRANSCRIPT, runtimeState(true, 5))
  state = foldTranscript(state, {
    type: 'turn_finished',
    turnId: 't1',
    outcome: 'completed',
    error: null,
    at: 20,
  })
  state = foldTranscript(state, runtimeState(true, 5))
  assert.equal(state.runtime?.isStreaming, false)
})

test('a snapshot built after the ending is applied as it comes', () => {
  // The opposite case, and the reason the rule reads the clock rather than the turn: a new turn's
  // snapshot is newer than the ending behind it and has to be believed.
  let state = foldTranscript(EMPTY_TRANSCRIPT, {
    type: 'turn_finished',
    turnId: 't1',
    outcome: 'completed',
    error: null,
    at: 20,
  })
  state = foldTranscript(state, runtimeState(true, 30))
  assert.equal(state.runtime?.isStreaming, true)
})

test('a snapshot at the same instant as the ending is the older reading', () => {
  // Both stamps come from the host, so an equal one is a snapshot whose last engine event is the
  // ending's own: it cannot carry anything the ending did not already state.
  let state = foldTranscript(EMPTY_TRANSCRIPT, {
    type: 'turn_finished',
    turnId: 't1',
    outcome: 'completed',
    error: null,
    at: 20,
  })
  state = foldTranscript(state, runtimeState(true, 20))
  assert.equal(state.runtime?.isStreaming, false)
})

test('a snapshot with no ending behind it is believed, whoever asks', () => {
  // A conversation attached mid-turn has no ending in this process, and the snapshot is the only
  // reading there is.
  const state = foldTranscript(EMPTY_TRANSCRIPT, runtimeState(true, 5))
  assert.equal(state.runtime?.isStreaming, true)
})

test('the guard leaves every other field of the snapshot alone', () => {
  let state = foldTranscript(EMPTY_TRANSCRIPT, {
    type: 'turn_finished',
    turnId: 't1',
    outcome: 'completed',
    error: null,
    at: 20,
  })
  state = foldTranscript(state, runtimeState(true, 5))
  assert.equal(state.runtime?.sessionId, 's1')
  assert.equal(state.runtime?.messageCount, 0)
  assert.equal(state.runtime?.pendingAsyncWork, false)
})

test('an id an older row still holds moves that row aside instead of swallowing the answer', () => {
  // The reader's report of 2026-10-27: an answer was on screen as tools and reasoning only, and
  // reopening the app showed the words were there all along. A record keeps its rows across the
  // sessions that announced them, so a host that named a new message after an old row had its
  // frames land in that row - and where the row was of another kind (here: the reader's own
  // prompt), `applyDelta` had nowhere to write them and dropped the words outright.
  const prompt = user('m2', 'go', 10)
  let state = { ...EMPTY_TRANSCRIPT, messages: [prompt] }

  state = foldTranscript(state, { type: 'message_started', messageId: 'm2', role: 'assistant', at: 20 })
  state = foldTranscript(state, delta('m2', 'the answer'))
  state = foldTranscript(state, {
    type: 'message_finished',
    messageId: 'm2',
    startedAt: 20,
    endedAt: 30,
    stopReason: 'stop',
    error: null,
    usage: null,
    modelProvider: null,
    modelId: null,
  })

  const answered = state.messages.find((message) => message.kind === 'assistant')
  assert.equal(answered?.text, 'the answer', 'the words belong to the message the frame named')
  assert.equal(state.messages[0]?.id, 'm2#1', 'the older row keeps its words under a name of its own')
  assert.equal(state.messages.length, 2)
  assert.deepEqual(
    state.messages.map((message) => message.id),
    ['m2#1', 'm2'],
    'and the id the frames address answers to the message they are about',
  )

  // The row the engine claimed keeps taking its own frames, and the displaced row is never written
  // into: the rest of the answer lands where it started.
  state = foldTranscript(state, delta('m2', ' continues'))
  const [earlier, later] = state.messages
  assert.equal(later?.kind === 'assistant' ? later.text : '', 'the answer continues')
  assert.equal(earlier?.kind === 'user' ? earlier.text : '', 'go')
})

test('a delta with no row of its own draws one, whatever an id collision left behind', () => {
  // The same loss with the row already on hand under another kind: no opening frame arrived (a
  // listener attached late), so the delta is all the words there will ever be.
  const state = foldTranscript(
    { ...EMPTY_TRANSCRIPT, messages: [tool('m4', 'bash')] },
    delta('m4', 'from a late listener'),
  )
  const [kept, drawn] = state.messages
  assert.equal(state.messages.length, 2)
  assert.equal(drawn?.kind === 'assistant' ? drawn.text : '', 'from a late listener')
  assert.equal(kept?.id, 'm4#1', 'the row that was holding the name moved aside')
})

test('the same notice about the same state replaces itself instead of stacking', () => {
  // Sixteen presses of a stop that could not end anything (2026-10-27, user report): one line is the
  // whole answer, and a row per press grew the composer's stack until it had eaten the window.
  let notices: SessionNotice[] = []
  for (let press = 0; press < 16; press += 1) {
    notices = pushNotice(notices, 'info', 'stop_found_nothing', 'There was nothing left to stop.')
  }
  assert.equal(notices.length, 1)
  const [only] = notices
  assert.equal(only?.code, 'stop_found_nothing')

  // A different line after it is a new row: only the identical repeat collapses.
  const mixed = pushNotice(notices, 'error', 'host_failed', 'The host exited while answering.')
  assert.equal(mixed.length, 2)
  assert.equal(mixed[1]?.code, 'host_failed')

  // A press after the reader dismissed the row is answered again: the surviving row carries a fresh
  // id, so the composer's dismiss list (kept by id) does not swallow it.
  const again = pushNotice(notices, 'info', 'stop_found_nothing', 'There was nothing left to stop.')
  assert.equal(again.length, 1)
  assert.notEqual(again[0]?.id, only?.id)
})

test('a new ask drops the notice that the conversation was reclaimed', () => {
  const notices: SessionNotice[] = [
    {
      id: 1,
      level: 'info',
      code: 'stalled_reclaimed',
      message: 'The conversation stopped responding and was reclaimed.',
      at: 1,
    },
    {
      id: 2,
      level: 'error',
      code: 'stalled_reclaim_failed',
      message: 'Could not reclaim the conversation: the host refused.',
      at: 2,
    },
    {
      id: 3,
      level: 'info',
      code: 'force_stopped',
      message: 'The conversation was force-stopped. Its history is still here.',
      at: 3,
    },
    { id: 4, level: 'warning', code: null, message: 'The host exited while answering.', at: 4 },
  ]
  // The two notices that say the previous turn was taken down are the ones the new ask answers; a
  // reclaim that failed is still a fact the reader may have to act on.
  assert.deepEqual(
    clearReclaimNotices(notices).map((notice) => notice.code),
    ['stalled_reclaim_failed', null],
  )
})

test('a row the engine never wrote cannot be rewound', () => {
  // A `/` command this host runs itself: the row exists here and nowhere else, so the only address it
  // has is this side's own id. Rewinding it asks the host to cut at a message the session never wrote,
  // which is answered "No user message of this conversation was written at that time."
  assert.equal(canRewindMessage(user('local:7', '/vibe')), false)
  // The engine's own row, live from the frames: no entry id yet, but its timestamp is a real address
  // the host resolves against the messages it wrote.
  assert.equal(canRewindMessage(user('entry-x', 'ship it')), true)
  // A row a transcript read named: the entry id is the address itself.
  assert.equal(canRewindMessage({ ...user('entry-y', 'ship it'), entryId: 'e1' } as ChatMessage), true)
  // Nothing to address at all is not a message the reader can cut at either.
  assert.equal(canRewindMessage(user('entry-z', 'ship it', 0)), false)
})

test('a rewind cuts the rows before the message it names, addressed as the host does', () => {
  const rows = [
    user('u1', 'first', 10),
    assistant('a1', 'answer', '', 11),
    { ...user('u2', 'second', 12), entryId: 'e2' } as ChatMessage,
    assistant('a2', 'answer', '', 13),
    user('u3', 'third', 14),
  ]
  // A live row has no entry id yet: its own stamp is the address the host resolves.
  assert.equal(rewindCutIndex(rows, { at: 12 }), 2)
  // A row a transcript read named carries the entry id, the address itself.
  assert.equal(rewindCutIndex(rows, { entryId: 'e2', at: 12 }), 2)
  // The prefix is what stays on screen: the message and everything after it leave.
  const cut = rewindCutIndex(rows, { at: 12 })
  assert.deepEqual(
    rows.slice(0, cut ?? 0).map((row) => row.id),
    ['u1', 'a1'],
  )
  // Nothing to cut at is answered as nothing: an answer's stamp is not a user turn, and a message
  // the rows no longer carry has no prefix this screen could paint.
  assert.equal(rewindCutIndex(rows, { at: 11 }), null)
  assert.equal(rewindCutIndex(rows, { at: 99 }), null)
  assert.equal(rewindCutIndex(rows, { entryId: 'missing' }), null)
})

/**
 * What a stop's withdrawal does to the transcript: the local echo of a prompt the model never
 * received leaves the screen, and the engine-claimed prompt beside it stays - it reached the model,
 * so it is not something the stop took back.
 */
test('a withdrawn prompt takes its local row and its files, and nothing else', () => {
  const echo = {
    ...user('local:4', 'look at the other file'),
    attachments: [{ name: 'a.png', path: 'C:/tmp/a.png', mimeType: 'image/png', bytes: 3 }],
  }
  const messages = [user('entry-1', 'first'), echo, assistant('m1', 'working')]
  const withdrawn = withdrawLocalPrompts(messages, ['look at the other file'])
  assert.deepEqual(withdrawn.messages, [messages[0], messages[2]])
  assert.deepEqual(withdrawn.paths, ['C:/tmp/a.png'])
})

test('two identical steers are withdrawn one per prompt, newest first', () => {
  const messages = [user('local:1', 'same words'), user('local:2', 'same words'), assistant('m1', 'x')]
  const once = withdrawLocalPrompts(messages, ['same words'])
  assert.deepEqual(once.messages.map((row) => row.id), ['local:1', 'm1'])
  const twice = withdrawLocalPrompts(messages, ['same words', 'same words'])
  assert.deepEqual(twice.messages.map((row) => row.id), ['m1'])
})

test('a withdrawn prompt with no local echo leaves the transcript alone', () => {
  // The engine already claimed the message (it was delivered before the stop), so there is nothing
  // to withdraw from this side - the words stay where they are.
  const messages = [user('entry-1', 'delivered'), assistant('m1', 'x')]
  const withdrawn = withdrawLocalPrompts(messages, ['delivered'])
  assert.deepEqual(withdrawn.messages, messages)
  assert.deepEqual(withdrawn.paths, [])
})

test('a reminder frame is a row of its own, and the same frame twice is one row', () => {
  // A reminder arrives whole — the engine writes it as one finished developer message — so there is
  // no stream to fold. A frame replayed after a read must replace its row rather than stack a second
  // copy of the same rule check.
  const frame: SessionEvent = {
    type: 'reminder',
    messageId: 'r1',
    at: 10,
    text: '<system-reminder reason="rule_violation" rule="ts-no-any">\nfix the annotation\n</system-reminder>',
  }
  const once = foldTranscript(EMPTY_TRANSCRIPT, frame)
  const twice = foldTranscript(once, frame)

  assert.equal(twice.messages.length, 1)
  const [row] = twice.messages
  assert.ok(row !== undefined && row.kind === 'reminder')
  assert.equal(row.id, 'r1')
  assert.equal(row.at, 10)
  assert.ok(row.text.includes('rule="ts-no-any"'))
})

test('the transcript notices become rows, and every other notice stays out of it', () => {
  // Two notices are about the conversation rather than the machinery - the idle recap and the
  // report a compaction prints - so they are drawn where the conversation is (`ConversationPane`
  // routes the row by the message kind) instead of in the strip above the composer. A retry notice
  // describes the machinery and stays there.
  const recap: SessionEvent = {
    type: 'notice',
    level: 'info',
    code: 'engine_recap',
    message: 'The parser is fixed; the smoke still fails on the second scenario.',
    seq: 12,
  }
  const withRecap = foldTranscript(EMPTY_TRANSCRIPT, recap)
  assert.equal(withRecap.messages.length, 1)

  const [row] = withRecap.messages
  assert.ok(row !== undefined && row.kind === 'notice')
  assert.equal(row.id, 'engine_recap-12')
  assert.equal(row.code, 'engine_recap')
  assert.equal(row.text, 'The parser is fixed; the smoke still fails on the second scenario.')

  // A second stretch is a second line: the recap is a journal of where things stood, not a state
  // that replaces the last one.
  const again = foldTranscript(withRecap, { ...recap, seq: 30, message: 'Waiting on the review.' })
  assert.equal(again.messages.length, 2)

  // The compaction's own report is the second: the engine's sentence with the tokens it saved.
  const compaction: SessionEvent = {
    type: 'notice',
    level: 'info',
    code: 'engine_compaction_report',
    message: 'Compaction complete. Tokens: 43483 -> 22044 (saved 21439).',
    seq: 31,
  }
  const withCompaction = foldTranscript(again, compaction)
  assert.equal(withCompaction.messages.length, 3)
  const report = withCompaction.messages[2]
  assert.ok(report !== undefined && report.kind === 'notice')
  assert.equal(report.id, 'engine_compaction_report-31')
  assert.equal(report.code, 'engine_compaction_report')
  assert.equal(report.text, 'Compaction complete. Tokens: 43483 -> 22044 (saved 21439).')

  const retry: SessionEvent = {
    type: 'notice',
    level: 'warning',
    code: 'engine_retrying',
    message: 'The engine is retrying the last request.',
    seq: 32,
  }
  // A notice about the machinery is not a row; it belongs to the record's own strip
  // (`state/session-record.ts`).
  const withRetry = foldTranscript(withCompaction, retry)
  assert.equal(withRetry.messages.length, 3)
})

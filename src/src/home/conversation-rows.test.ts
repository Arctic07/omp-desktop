import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatMessage } from '../api/session-types.ts'
import type { TurnEnding } from '../state/transcript.ts'
import {
  buildRows,
  hasSearchCard,
  isUserRow,
  rowEnding,
} from './conversation-rows.ts'
import {
  createRailCache,
  railItems,
  rowText,
  selectRailItems,
  type RailCopy,
} from './rail-rows.ts'

/**
 * The transcript's rows, and the list the navigation rail is built from.
 *
 * Two things are pinned down here. The first is the fold: a run of tool calls is one row, a `task`
 * call keeps its own, and an assistant turn that carries nothing but calls is not a row at all —
 * which is what stops a bare avatar appearing above every call. The second is what the rail is
 * handed: one entry per *turn* — the reader's prompt as the title, the agent's last answer body as
 * the content — the same entries again when nothing about them changed (that identity is what keeps
 * a streamed delta from redrawing every tick on the list), and the marks the rail has room for when
 * the conversation has more turns than its box.
 */

const COPY: RailCopy = {
  message: 'Message',
  thinking: 'Thinking',
  working: 'Working…',
  reminder: 'Rule reminder',
  toolCalls: (count) => `${count} calls`,
  toolSucceeded: (count) => `${count} succeeded`,
  toolFailedCount: (count) => `${count} failed`,
  railItemLabel: (sender, index, total) => `${sender} ${index}/${total}`,
}

let clock = 1_700_000_000_000

function user(id: string, text: string): ChatMessage {
  clock += 1000
  return { kind: 'user', id, at: clock, text, attachments: [] }
}

function assistant(id: string, text: string, thinking = ''): ChatMessage {
  clock += 1000
  return {
    kind: 'assistant',
    id,
    at: clock,
    text,
    thinking,
    error: null,
    startedAt: null,
    endedAt: null,
    usage: null,
    modelProvider: 'moonshot',
    modelId: 'kimi-k2',
  }
}

/** One assistant row with the ending it carried, as the engine reports it on the wire. */
function ended(
  id: string,
  ending: { stopReason?: string; error?: string },
): ChatMessage {
  return { ...assistant(id, ''), ...ending } as ChatMessage
}

function tool(id: string, name: string, state = 'success'): ChatMessage {
  clock += 1000
  return {
    kind: 'tool',
    id,
    at: clock,
    toolCallId: `call-${id}`,
    name,
    state,
    argsText: '{}',
    resultText: 'ok',
    startedAt: null,
    endedAt: null,
    intent: null,
  }
}

test('a run of tool calls is one row, a task call is its own, and a silent turn is no row', () => {
  const rows = buildRows([
    user('u1', 'go'),
    assistant('a1', ''), // calls only: the running row stands in for it
    tool('t1', 'read'),
    tool('t2', 'grep'),
    tool('t3', 'task'),
    tool('t4', 'bash'),
    assistant('a2', 'done'),
  ])
  assert.deepEqual(
    rows.map((row) => row.id),
    // A lone call after the task is a row of its own, not a folded run.
    ['u1', 'tools-t1', 't3', 't4', 'a2'],
  )
  const folded = rows[1]
  assert.equal(folded.kind, 'tools')
  assert.equal(folded.kind === 'tools' ? folded.tools.length : 0, 2)
})

test('a search call keeps its own row so its sources are not behind a count', () => {
  // The search card is the evidence an answer is judged by. A folded run draws a count and the
  // latest intent, so a search inside one reached the reader with no query, answer or sources.
  const rows = buildRows([
    user('u1', 'find out'),
    tool('t1', 'read'),
    tool('t1b', 'grep'),
    tool('t2', 'web_search'),
    tool('t3', 'bash'),
    tool('t3b', 'bash'),
    assistant('a1', 'done'),
  ])
  assert.deepEqual(
    rows.map((row) => row.id),
    ['u1', 'tools-t1', 't2', 'tools-t3', 'a1'],
  )
})

test('a search card is a source list or a provider answer, never whitespace', () => {
  // This is the predicate `ConversationToolRow` opens its row on. Opening while the call is still
  // working would be a flash of JSON, which is the fold's whole reason (2026-10-24). The row's own
  // default-open is not asserted here: it is component state, and no test in this suite renders.
  assert.equal(hasSearchCard(undefined, undefined), false)
  assert.equal(hasSearchCard([], ''), false)
  assert.equal(
    hasSearchCard([{ title: 'a', url: 'https://example.com', snippet: 's' }], ''),
    true,
  )
  // A provider that writes prose may answer without a source list.
  assert.equal(hasSearchCard(undefined, 'it is so'), true)
  // Whitespace is no card: the row would draw a heading with nothing under it.
  assert.equal(hasSearchCard(undefined, '  \n '), false)
})

test('a call that produced pictures keeps its own row', () => {
  // The picture is the output, and a folded run draws only a count: a screenshot a browser run
  // just took must not be behind the group's disclosure (or behind the call's own one).
  const pictured: ChatMessage = {
    ...(tool('t2', 'browser') as Extract<ChatMessage, { kind: 'tool' }>),
    images: [{ mimeType: 'image/png', bytes: 3, dataUrl: 'data:image/png;base64,AAAA' }],
  }
  const rows = buildRows([
    user('u1', 'look'),
    tool('t1', 'read'),
    tool('t1b', 'grep'),
    pictured,
    tool('t3', 'bash'),
    tool('t3b', 'bash'),
  ])
  assert.deepEqual(
    rows.map((row) => row.id),
    ['u1', 'tools-t1', 't2', 'tools-t3'],
  )
})

test('a step the reader stopped is a row, even with no words of its own', () => {
  // The engine can end a turn on a step that wrote nothing (a stop that landed before the answer
  // started). Dropping it as blank is what left a stopped turn with no line at all.
  const stopped = ended('a1', { stopReason: 'aborted', error: 'Interrupted by user' })
  const rows = buildRows([user('u1', 'go'), stopped])
  assert.deepEqual(
    rows.map((row) => row.id),
    ['u1', 'a1'],
  )

  // A step whose only ending is the generic abort sentinel is the same stop, stated by the engine
  // rather than by the reason field.
  const sentinel = ended('a2', { error: 'Request was aborted' })
  assert.deepEqual(
    buildRows([user('u2', 'go'), sentinel]).map((row) => row.id),
    ['u2', 'a2'],
  )

  // An ordinary step that only called tools is still no row: the running row stands in for it.
  assert.deepEqual(buildRows([user('u3', 'go'), assistant('a3', '')]).map((row) => row.id), ['u3'])
})

test('the ending is stated once, on the row the turn ended on', () => {
  // A retried attempt's failure is the reason the retry happened, not the turn's outcome: only the
  // turn's own ending is drawn, and only after the turn is over.
  const failed = ended('a1', { stopReason: 'error', error: 'rate limited' })
  const answered = assistant('a2', 'here it is')
  const stopped: TurnEnding = { turnId: 't1', outcome: 'aborted', error: null, at: 9, stopped: false }

  const running = buildRows([user('u1', 'go'), failed, answered], { streaming: true, turn: stopped })
  assert.ok(running.every((row) => row.kind !== 'single' || row.ending === null))

  const endedRows = buildRows([user('u1', 'go'), failed, answered], { turn: stopped })
  const singles = endedRows.filter((row) => row.kind === 'single')
  assert.equal(singles.at(-1)?.ending?.outcome, 'aborted')
  assert.equal(
    singles.filter((row) => row.ending !== null).length,
    1,
    'one turn, one ending',
  )
})

test('an earlier turn keeps its failure after a later turn runs', () => {
  // `lastTurn` describes the turn that just ended in this process. It cannot speak for the one
  // before it, and the live rows must not lose that turn's own ending when a new prompt arrives
  // (the reopened conversation reads it from the message record either way).
  const failed = ended('a1', { stopReason: 'error', error: 'rate limited' })
  const rows = buildRows([user('u1', 'go'), failed, user('u2', 'try again'), assistant('a2', 'ok')], {
    turn: { turnId: 't2', outcome: 'completed', error: null, at: 9, stopped: false },
  })
  const first = rows.find((row) => row.kind === 'single' && row.id === 'a1')
  assert.equal(first?.kind === 'single' ? first.ending?.outcome : undefined, 'failed')
  assert.equal(first?.kind === 'single' ? first.ending?.error : undefined, 'rate limited')
})

test('a turn stopped before it drew any answer states its ending under the prompt', () => {
  // A stop that lands while the engine waits out a retry has no message of its own; the row it
  // belongs under is the prompt that started the turn.
  const rows = buildRows([user('u1', 'go')], {
    turn: { turnId: 't1', outcome: 'aborted', error: null, at: 9, stopped: false },
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind === 'single' ? rows[0].ending?.outcome : undefined, 'aborted')
})

test('a conversation read back from disk states each ended turn’s own ending', () => {
  // No turn was recorded in this process, so the record on the message is the only account there
  // is. Dropping it is what left a stopped answer with an empty sender line and nothing else.
  const stopped = ended('a1', { stopReason: 'aborted', error: 'Interrupted by user' })
  const failed = ended('a2', { stopReason: 'error', error: 'rate limited' })

  const rows = buildRows([user('u1', 'go'), stopped, user('u2', 'again'), failed])
  const singles = rows.filter((row) => row.kind === 'single')
  assert.deepEqual(
    singles.map((row) => row.ending?.outcome ?? null),
    [null, 'aborted', null, 'failed'],
  )
  assert.equal(singles[3]?.ending?.error, 'rate limited', 'the engine’s reason survives a reload')
})

test('an attempt the engine retried away is no row at all', () => {
  // Three socket failures while the engine retried were three red rows, each with the same
  // provider sentence. Once the turn-level ending cleared them they stayed on screen as measured
  // blank heights, and the next prompt made their message-level endings visible again.
  const first = ended('a1', { stopReason: 'error', error: 'socket closed' })
  const second = ended('a2', { stopReason: 'error', error: 'socket closed' })
  const answered = assistant('a3', 'all good')

  const succeeded = buildRows([user('u1', 'go'), first, second, answered])
  assert.deepEqual(succeeded.map((row) => row.id), ['u1', 'a3'])

  // The reader stops while the last attempt is being retried: the stop is the turn's one ending,
  // and the attempts before it draw nothing.
  const aborted = ended('a4', { stopReason: 'aborted', error: 'Request was aborted' })
  const stopped = buildRows([user('u2', 'go'), first, second, aborted])
  assert.deepEqual(stopped.map((row) => row.id), ['u2', 'a4'])
  const last = stopped.at(-1)
  const ending = last?.kind === 'single' ? last.ending : null
  assert.equal(ending?.outcome, 'aborted')

  // The live stop carries a turn-level ending. It lands on the aborted row, and none of the
  // attempts before it survives as a measured row with no content — the blank height the reader
  // saw after pressing stop.
  const live = buildRows([user('u3', 'go'), first, second, aborted], {
    turn: { turnId: 't1', outcome: 'aborted', error: null, at: 1, stopped: true },
  })
  assert.deepEqual(live.map((row) => row.id), ['u3', 'a4'])
  const blanks = live.filter(
    (row) =>
      row.kind === 'single' &&
      row.message.kind === 'assistant' &&
      !row.message.text.trim() &&
      !row.message.thinking.trim() &&
      row.ending === null,
  )
  assert.deepEqual(blanks, [], 'a stopped turn leaves no empty measured row behind')
})

test('a step that finished by calling a tool is not a failure after a reload', () => {
  // `toolUse` is the engine's own word for a step that ended in a call. Reading every reason but
  // `stop` as a failure put a red line under every tool-calling step of a reopened conversation.
  for (const reason of ['toolUse', 'stop', 'length']) {
    const step = ended('a1', { stopReason: reason })
    const row = buildRows([user('u1', 'go'), step]).find(
      (candidate) => candidate.kind === 'single' && candidate.id === 'a1',
    )
    assert.equal(row?.kind === 'single' ? (row.ending ?? null) : null, null, `${reason} is not an ending`)
  }
})

test('an ending never lands on a row of another turn', () => {
  // The turn ended on a step that drew nothing (a `toolUse` step), so the last row it actually put
  // on screen is the one before it — not whatever row happened to be last in the transcript.
  const callStep = ended('a1', { stopReason: 'toolUse' })
  const rows = buildRows([
    user('u1', 'go'),
    assistant('a0', 'an earlier answer'),
    callStep,
    tool('t1', 'read'),
  ], {
    turn: { turnId: 't1', outcome: 'aborted', error: null, at: 9, stopped: false },
  })
  const withEnding = rows.filter((row) => row.kind === 'single' && row.ending !== null)
  assert.equal(withEnding.length, 1)
  assert.equal(withEnding[0]?.id, 'a0', 'the ending sits under the turn’s own last visible row')
})

test('a turn that ends on a tool row states its ending on the prompt', () => {
  // A single tool row draws no ending (`SingleToolRow` has no `TurnEndingNote`), so handing it one
  // makes a stop or a failure invisible. With no answer in the turn, the prompt is the last row
  // that can state it.
  const rows = buildRows([user('u1', 'go'), tool('t1', 'web_search')], {
    turn: { turnId: 't1', outcome: 'aborted', error: null, at: 9, stopped: false },
  })
  const endingRows = rows.filter((row) => row.kind === 'single' && row.ending !== null)
  assert.equal(endingRows.length, 1)
  assert.equal(endingRows[0]?.id, 'u1', 'the ending sits under the prompt, not the call')
})

test('a turn the host confirmed stopping reads as stopped, whatever the engine called it', () => {
  // The engine was waiting out a retry when the press landed, so its own ending carries the failure
  // it was retrying. The host's answer to the stop is what the reader did.
  assert.deepEqual(
    rowEnding({ turnId: 't', outcome: 'failed', error: 'rate limited', at: 1, stopped: true }),
    { outcome: 'aborted', error: null },
  )
  assert.deepEqual(
    rowEnding({ turnId: 't', outcome: 'failed', error: 'rate limited', at: 1, stopped: false }),
    { outcome: 'failed', error: 'rate limited' },
  )
  assert.equal(rowEnding({ turnId: 't', outcome: 'completed', error: null, at: 1, stopped: false }), null)
  assert.equal(rowEnding(null), null)
})

test('a turn whose first drawn row is a call names the agent on that call', () => {
  // A step that only calls a tool draws no row of its own, so a turn that starts with calls used to
  // have no avatar and no sender line anywhere: every call row is a placeholder, and the answer
  // after the calls was no longer the turn's first row. The first row the turn actually draws names
  // the speaker, whatever kind it is — including a turn the reader stopped mid-call.
  const rows = buildRows([
    user('u1', 'go'),
    assistant('a1', ''), // calls only: no row
    tool('t1', 'read'),
    tool('t2', 'grep'),
    assistant('a2', 'here it is'),
  ])
  assert.deepEqual(
    rows.map((row) => (row.kind === 'tools' ? `tools:${row.namesSender}` : row.kind === 'single' ? row.namesSender : null)),
    [true, 'tools:true', false],
  )

  // The same turn with a single call: the call is a row of its own and carries the name.
  const single = buildRows([user('u2', 'go'), assistant('b1', ''), tool('t3', 'read')])
  assert.deepEqual(
    single.map((row) => (row.kind === 'single' ? row.namesSender : null)),
    [true, true],
  )

  // A stop that lands mid-call draws the call row and nothing else, and it is named.
  const stopped = buildRows([user('u3', 'go'), assistant('c1', ''), tool('t4', 'bash')])
  assert.deepEqual(
    stopped.map((row) => (row.kind === 'single' ? row.namesSender : null)),
    [true, true],
  )
})

test('one turn names the agent once, however many answers it was written in', () => {
  // The engine writes an assistant message per step: one before a tool call, one after. Naming the
  // agent in each of them is what put two avatars over one turn's output.
  const rows = buildRows([
    user('u1', 'go'),
    assistant('a1', '', '第一段'),
    tool('t1', 'read'),
    assistant('a2', 'here is the answer', '第二段'),
    // A second turn names the agent again: it is a different thing said by the same agent, and the
    // reader needs the sender line to see where the first turn ended.
    user('u2', 'again'),
    assistant('a3', 'second answer'),
    // A turn whose first drawn row is a call names the agent on that call, not on the answer after
    // it: the step that reasoned is the turn's first row, and the call below it belongs to it.
    user('u3', 'third'),
    assistant('a4', '', '第三轮的思考'),
    tool('t2', 'bash'),
    assistant('a5', 'third answer'),
  ])
  assert.deepEqual(
    rows.map((row) => (row.kind === 'single' ? row.namesSender : null)),
    [true, true, false, false, true, true, true, true, false, false],
  )
  // Each step's reasoning is its own block: a thought the engine wrote and then acted on is a
  // thought of its own, and concatenating the steps of a turn is what turned a turn into one wall of
  // planning. The row that carries no words of its own still carries the reasoning it thought.
  assert.deepEqual(
    rows.map((row) => (row.kind === "single" ? row.thinking : null)),
    ['', '第一段', '', '第二段', '', '', '', '第三轮的思考', '', ''],
  )
  assert.ok(rows.every((row) => row.kind !== "single" || row.thinkingLive === false))
})

test('reasoning is grouped by the run it belongs to, not by the turn', () => {
  // Adjacent steps with nothing between them are one stretch of thinking: the engine carried the
  // thought on, and drawing it as two blocks would split one thought in two.
  const joined = buildRows([
    user('u1', 'go'),
    assistant('a1', '', '先看这里'),
    assistant('a2', '', '再看那里'),
    assistant('a3', '答案'),
  ])
  assert.equal(joined[1].kind === 'single' ? joined[1].thinking : null, '先看这里\n\n再看那里')
  assert.equal(joined[2].kind === 'single' ? joined[2].thinking : null, '')

  // A call ends the stretch: whatever the next step thinks is a new thought, and it is drawn where
  // it was thought.
  const separated = buildRows([
    user('u1', 'go'),
    assistant('a1', '', '第一段'),
    tool('t1', 'read'),
    assistant('a2', '', '第二段'),
    assistant('a3', '答案'),
  ])
  assert.deepEqual(
    separated.map((row) => (row.kind === 'single' ? row.thinking : null)),
    ['', '第一段', '', '第二段', ''],
  )
})

test('the live turn reports its reasoning as still arriving until an answer starts', () => {
  const reasoning = [
    user('u1', 'go'),
    assistant('a1', '', '还在想'),
    tool('t1', 'read'),
    assistant('a2', '', '继续想'),
  ]
  const live = buildRows(reasoning, { streaming: true })
  assert.deepEqual(
    live.map((row) => (row.kind === 'single' ? row.thinking : null)),
    ['', '还在想', '', '继续想'],
  )
  // The reasoning still arriving is the one of the step being written, which is the last one: the
  // block above it belongs to a step that has already gone to work.
  assert.equal(live[1].kind === 'single' ? live[1].thinkingLive : null, false)
  assert.equal(live[3].kind === 'single' ? live[3].thinkingLive : null, true)
  // The answer starting is what ends the live stretch.
  const answered = buildRows([...reasoning, assistant('a3', '答案', '收尾')], { streaming: true })
  assert.equal(answered[3].kind === 'single' ? answered[3].thinkingLive : null, false)
  assert.equal(answered[4].kind === 'single' ? answered[4].thinkingLive : null, false)
  // A finished turn is never live, whatever it holds.
  const settled = buildRows(reasoning, { streaming: false })
  assert.ok(settled.every((row) => row.kind !== 'single' || row.thinkingLive === false))
  // A step that only reasoned is a row of its own: that is where its thought is drawn.
  assert.deepEqual(
    buildRows([
      user('u2', 'go again'),
      assistant('b1', '', 'r1'),
      tool('t2', 'read'),
      assistant('b2', '', 'r2'),
      assistant('b3', 'the answer'),
    ]).map((row) => row.id),
    // A single call is a row of its own; only a run of two or more folds.
    ['u2', 'b1', 't2', 'b2', 'b3'],
  )
})

test('a turn’s footer goes on the last row the turn drew', () => {
  // One turn, written in three steps: the footer belongs to the turn, so only its last row carries
  // it. A footer after each step is a conversation that looks finished five times.
  const rows = buildRows([
    user('u1', 'go'),
    assistant('a1', 'let me look'),
    tool('t1', 'read'),
    assistant('a2', '', '想一下'),
    tool('t2', 'grep'),
    assistant('a3', 'here it is'),
  ])
  assert.deepEqual(
    rows.map((row) => (row.kind === 'single' ? row.tail !== null : false)),
    [false, false, false, false, false, true],
  )

  // A step that only reasoned is a row of its own, and it is the last row the turn drew — the
  // footer follows the turn rather than the turn's prose.
  const reasoningLast = buildRows([
    user('u1', 'go'),
    assistant('a1', 'the answer'),
    tool('t1', 'read'),
    assistant('a2', '', '又被叫去干活'),
  ])
  assert.deepEqual(
    reasoningLast.map((row) => (row.kind === 'single' ? row.tail !== null : false)),
    [false, false, false, true],
  )

  // A turn does not end at its prose: the calls of its last step come after the answer that made
  // them, and a footer drawn with the answer would sit inside the turn it closes.
  const callsLast = buildRows([
    user('u1', 'go'),
    assistant('a1', 'let me look'),
    tool('t1', 'read'),
    tool('t2', 'grep'),
  ])
  const lastRow = callsLast[callsLast.length - 1]
  assert.equal(lastRow.kind === 'tools' && lastRow.tail !== null, true)

  // Two turns, two footers, one each — and the turn in flight has none, because nothing on a screen
  // with a turn running is a finished answer (`ConversationPane`).
  const twoTurns = buildRows([
    user('u1', 'first'),
    assistant('a1', 'first answer'),
    user('u2', 'second'),
    assistant('a2', 'second answer'),
  ])
  assert.deepEqual(
    twoTurns.map((row) => (row.kind === 'single' ? row.tail !== null : false)),
    [false, true, false, true],
  )
  assert.equal(twoTurns[1].kind === 'single' ? twoTurns[1].tail?.latest : null, false)
  assert.equal(twoTurns[3].kind === 'single' ? twoTurns[3].tail?.latest : null, true)

  // A prompt with nothing answered behind it is not a turn: there is nothing to state.
  const unanswered = buildRows([user('u1', 'go'), assistant('a1', 'the answer'), user('u2', 'again')])
  assert.deepEqual(
    unanswered.map((row) => (row.kind === 'single' ? row.tail !== null : false)),
    [false, true, false],
  )
  // The turn above the prompt is no longer the newest one, so its footer waits for the reader.
  assert.equal(unanswered[1].kind === 'single' ? unanswered[1].tail?.latest : null, false)
})

test('a turn’s footer reads what the engine reported about it', () => {
  type AssistantMessage = Extract<ChatMessage, { kind: 'assistant' }>
  /** One step of a turn, with the window and the usage the engine reports for it. */
  function step(
    id: string,
    text: string,
    startedAt: number,
    endedAt: number,
    usage: AssistantMessage['usage'],
    stopReason?: string,
  ): AssistantMessage {
    return {
      kind: 'assistant',
      id,
      at: startedAt,
      text,
      thinking: '',
      error: null,
      startedAt,
      endedAt,
      usage,
      modelProvider: 'moonshot',
      modelId: 'kimi-k2',
      stopReason,
    }
  }

  const prompt: ChatMessage = { kind: 'user', id: 'u1', at: 1_000, text: 'go', attachments: [] }
  const rows = buildRows([
    prompt,
    step('a1', 'first', 1_000, 3_000, {
      input: 100,
      output: 40,
      cacheRead: 10,
      cacheWrite: 5,
      reasoning: null,
      costUsd: 0,
    }),
    tool('t1', 'read'),
    // A step that drew nothing of its own still spent tokens and still took time: the footer under
    // the turn states what the whole turn cost, not what its last answer did.
    step(
      'a2',
      '',
      3_000,
      5_000,
      { input: 20, output: 60, cacheRead: 0, cacheWrite: 0, reasoning: 12, costUsd: 0 },
      'toolUse',
    ),
    tool('t2', 'grep'),
  ])
  const last = rows[rows.length - 1]
  assert.equal(last.kind, 'tools')
  const tail = last.kind === 'tools' ? last.tail : null
  assert.ok(tail !== null)
  assert.equal(tail.usage?.input, 120)
  assert.equal(tail.usage?.output, 100)
  assert.equal(tail.usage?.cacheRead, 10)
  assert.equal(tail.usage?.reasoning, 12)
  // The prompt opened the turn and its last step closed it.
  assert.equal(tail.durationMs, 4_000)
  // 100 output over the two steps' own windows (2s + 2s), not over the turn's wall clock.
  assert.equal(tail.tps, 25)
  assert.equal(tail.text, 'first')
  assert.equal(tail.model?.id, 'kimi-k2')
  assert.equal(tail.at, 5_000)
  // The run of calls ends with `t2`, which names no entry of its own — and the host's tip names a
  // point only for the turn that settled in this process.
  assert.equal(tail.continueEntryId, null)

  // A turn whose steps never reported usage states none rather than a zero, and a step that
  // reported no window makes the rate fall back to the turn's own wall clock.
  const bare = buildRows([user('u1', 'go'), assistant('a1', 'answer')])
  const bareTail = bare[1].kind === 'single' ? bare[1].tail : null
  assert.ok(bareTail !== null)
  assert.equal(bareTail.usage, null)
  assert.equal(bareTail.tps, null)
  assert.equal(bareTail.durationMs, 1_000)
})

test('a fork is offered only where an entry names the point to continue from', () => {
  const written = {
    ...(assistant('a1', 'answer') as Extract<ChatMessage, { kind: 'assistant' }>),
    entryId: 'e1',
  }
  const readBack = buildRows([user('u1', 'go'), written])
  assert.equal(readBack[1].kind === 'single' ? readBack[1].tail?.continueEntryId : null, 'e1')

  // A row built from live frames names no entry of its own, so the host's own tip is what lets the
  // turn that just settled offer one — and only the newest turn can use it.
  const live = buildRows([user('u1', 'go'), assistant('a1', 'answer')], { tipEntryId: 'tip' })
  assert.equal(live[1].kind === 'single' ? live[1].tail?.continueEntryId : null, 'tip')
  const earlier = buildRows(
    [user('u1', 'go'), assistant('a1', 'answer'), user('u2', 'again'), assistant('a2', 'done')],
    { tipEntryId: 'tip' },
  )
  assert.equal(earlier[1].kind === 'single' ? earlier[1].tail?.continueEntryId : null, null)
  assert.equal(earlier[3].kind === 'single' ? earlier[3].tail?.continueEntryId : null, 'tip')
})

test('a row reads as the text its own row draws', () => {  const rows = buildRows([    user('u1', 'run the tests'),
    assistant('a1', '## Result\n\nTwo failures.'),
    tool('t1', 'read'),
    tool('t2', 'bash', 'error'),
  ])
  assert.equal(rowText(rows[0], COPY), 'run the tests')
  assert.equal(rowText(rows[1], COPY), '## Result Two failures.')
  assert.equal(rowText(rows[2], COPY), '2 calls · 1 succeeded · 1 failed')
  // A run with nothing failed states no split: the counts exist to keep a mixed run from reading as
  // all failed, not to repeat the total when every call answered.
  const allAnswered = buildRows([user('u2', 'go'), tool('t3', 'read'), tool('t4', 'read')])
  assert.equal(rowText(allAnswered[1], COPY), '2 calls')
  const allFailed = buildRows([
    user('u3', 'go'),
    tool('t5', 'read', 'error'),
    tool('t6', 'read', 'error'),
  ])
  assert.equal(rowText(allFailed[1], COPY), '2 calls · 2 failed')
  assert.ok(isUserRow(rows[0]))
  assert.ok(!isUserRow(rows[1]))
})

test("the engine's notices are not part of the reader's own words", () => {
  const rows = buildRows([
    user('u1', '<system-notice>Reminder: be brief.</system-notice>\n\nship it'),
  ])
  assert.equal(rowText(rows[0], COPY), 'ship it')
})

test('a step that thought in its own words draws that thinking, and answers with the rest', () => {
  // A model that streams its reasoning through the text channel wraps it in an envelope
  // (`splitReasoningEcho`). The words inside it are a thought: the row draws them as its reasoning,
  // and only what it says outside them — here and in the footer's copy — is the answer.
  const rows = buildRows([
    user('u1', 'split page.rs'),
    assistant(
      'a1',
      '<previous_reasoning_empty/>move `backing_window` to platform.rs\n\nDo it.</previous_reasoning>\n\nMoved it.',
    ),
  ])
  const row = rows[1]
  assert.ok(row.kind === 'single' && row.message.kind === 'assistant')
  assert.equal(row.thinking, 'move `backing_window` to platform.rs\n\nDo it.')
  assert.equal(row.message.text, 'Moved it.')
  assert.equal(row.tail?.text, 'Moved it.')
})

test('the envelope a model wraps its answer in reaches neither the bubble nor the footer', () => {
  // `me/deepseek-v4.1-flash` wraps its whole answer in `<final>` (2026-11-08). The row keeps the
  // engine's text as recorded, and every surface that reads it as words takes the envelope off:
  // the bubble and the rail's preview (`stripModelTags`), and the footer's copy, which is handed
  // to a plugin as the message's content.
  const rows = buildRows([
    user('u1', 'ship it'),
    assistant('a1', '<final>\nMoved it to `platform.rs`.\n\nDO NOT REFACTOR. </final>'),
  ])
  const row = rows[1]
  assert.ok(row.kind === 'single' && row.message.kind === 'assistant')
  assert.equal(row.tail?.text, 'Moved it to `platform.rs`.\n\nDO NOT REFACTOR.')
})

test('a step that wrote its answer into its reasoning draws that answer in the bubble', () => {
  // `me/deepseek-v4.1-flash` streams every token into the reasoning channel and writes `</thinking>`
  // where the answer begins (`splitThinkingMarker`), so the engine records the answer as the tail of
  // the thinking. The row draws the reasoning up to the marker, the answer in the bubble, and the
  // marker nowhere — including the rail's preview and the footer's copy, which read the row.
  const rows = buildRows([
    user('u1', 'why did the sweep say nothing'),
    assistant('a1', '', 'The sweep found no windows.\n\nLet me say so.</thinking>The sweep found no windows, and no window flashed.'),
  ])
  const row = rows[1]
  assert.ok(row.kind === 'single' && row.message.kind === 'assistant')
  assert.equal(row.thinking, 'The sweep found no windows.\n\nLet me say so.')
  assert.equal(row.message.text, 'The sweep found no windows, and no window flashed.')
  assert.equal(rowText(row, COPY), 'The sweep found no windows, and no window flashed.')
})

test('an answer that is only an envelope reads as its own prose, never as its brackets', () => {
  // The rail's card is the reader's preview of the turn, so it reads what the row draws. An IRC
  // envelope has no prose beside it, and the row draws a card: the preview falls back to the row's
  // own label rather than to `<irc>Incoming IRC message from agent …`.
  const envelope = [
    '<irc>',
    'Incoming IRC message from agent `peer`:',
    '',
    'the migration is applied',
    '',
    'If response expected, reply via `write` (`path: "agent://peer"`, `content: "…"`); may finish current step first. No one replies on your behalf.',
    '</irc>',
  ].join('\n')
  const rows = buildRows([user('u1', 'go'), assistant('a1', envelope)])
  assert.equal(rowText(rows[1], COPY), COPY.message)

  const mixed = buildRows([user('u1', 'go'), assistant('a2', `${envelope}\n\nand the rest is mine`)])
  assert.equal(rowText(mixed[1], COPY), 'and the rest is mine')
})

test('an answer that is only an emphasized line reads as those words, never as its brackets', () => {
  // The model marks a status line `<important>`; the row draws it as a block, but the words in it
  // are what the turn said — so the rail's card reads them rather than falling back to its label.
  const rows = buildRows([
    user('u1', 'check the stop path'),
    assistant('a1', '<important>\nthe stop path matches the terminal\n</important>'),
  ])
  assert.equal(rowText(rows[1], COPY), 'the stop path matches the terminal')
})

test("a prompt's card reads its words, not the characters that stand for its files", () => {
  // A file is one private-use character of the prompt it was written into, and the card draws the
  // words: the character is an address, and no font has a glyph for it.
  const rows = buildRows([user('u1', '\ue000看看这张图')])
  assert.equal(rowText(rows[0], COPY), '看看这张图')
})

test('a conversation the rail can draw whole is handed over as it is, and re-uses what did not change', () => {
  const messages = [
    user('u1', 'first prompt'),
    assistant('a1', 'first answer'),
    user('u2', 'second prompt'),
    assistant('a2', 'second answer'),
  ]
  const cache = createRailCache()
  const built = railItems(buildRows(messages), false, COPY, cache)
  // One entry per turn: room for ten marks and two turns to draw leaves the array as it is.
  const first = selectRailItems(built, 10)
  assert.equal(first, built)
  assert.equal(first.length, 2)
  assert.equal(first[0].label, 'first prompt')
  // A turn's card is its prompt and the last body the agent wrote in answer to it.
  assert.equal(first[0].description, 'first answer')
  assert.equal(first[1].label, 'second prompt')
  assert.equal(first[1].description, 'second answer')
  assert.equal(typeof first[0].ariaLabel, 'function')

  // A delta into the last answer: only the last turn's entry is new, and the one above it is the
  // entry it was — which is what keeps a streamed frame off the rest of the rail.
  const grown = [...messages]
  grown[3] = assistant('a2', 'second answer, still arriving')
  const second = railItems(buildRows(grown), false, COPY, cache)
  assert.equal(second[0], first[0])
  assert.notEqual(second[1], first[1])
  assert.equal(second[1].description, 'second answer, still arriving')

  // Nothing changed at all: the very array is handed back, so nothing on the rail redraws.
  const third = railItems(buildRows(grown), false, COPY, cache)
  assert.equal(third, second)

  // A turn in flight says so instead of following its streamed sentences: the card's content is
  // the *final* answer, and there is no final answer until the turn ends (2026-10-20).
  const running = railItems(buildRows(grown), true, COPY, cache)
  assert.equal(running.length, 2)
  assert.equal(running[1].description, 'Working…')

  // The turn ends, and the card takes the answer it finished with.
  const settled = railItems(buildRows(grown), false, COPY, cache)
  assert.equal(settled[1].description, 'second answer, still arriving')

  // A turn that has not written anything yet reads as the work it is doing.
  const waiting = railItems(
    buildRows([user('u3', 'third prompt')]),
    true,
    COPY,
    createRailCache(),
  )
  assert.equal(waiting.length, 1)
  assert.equal(waiting[0].label, 'third prompt')
  assert.equal(waiting[0].description, 'Working…')
})

test('a conversation longer than its rail is described end to end by the marks that fit', () => {
  const messages: ChatMessage[] = []
  for (let turn = 1; turn <= 12; turn += 1) {
    messages.push(user(`u${turn}`, `prompt ${turn}`))
    messages.push(assistant(`a${turn}`, `answer ${turn}`))
  }
  const rows = buildRows(messages)
  const items = railItems(rows, false, COPY, createRailCache())
  assert.equal(items.length, 12, 'one entry per turn is what the conversation is')
  assert.equal(items.length, rows.length / 2, 'the answer rows are the turn, not marks of their own')

  const kept = selectRailItems(items, 7)
  const keptIds = kept.map((item) => item.id)
  const turnIds = messages.filter((message) => message.kind === 'user').map((message) => message.id)
  assert.equal(kept.length, 7, 'the marks fit the room they were given')
  assert.deepEqual(
    keptIds,
    turnIds.filter((id) => keptIds.includes(id)),
    'the marks stay in the conversation’s own order',
  )
  assert.equal(keptIds.at(-1), turnIds.at(-1), 'the newest turn is always a mark')
  assert.equal(keptIds[0], turnIds[0], 'and the marks still start at the conversation’s first turn')
  // The positions are the ones the rail draws at, not the conversation's own numbering.
  const last = kept[kept.length - 1]
  assert.equal(
    typeof last.ariaLabel === 'function' ? last.ariaLabel(7, 7) : last.ariaLabel,
    'user 7/7',
  )
})

test('a turn reads as the prompt and the last answer body, never as a call', () => {
  const rows = buildRows([
    user('u1', 'first'),
    assistant('m1', 'let me look'),
    tool('t1', 'read'),
    user('u2', 'second'),
    ended('a2', { stopReason: 'aborted' }),
    user('u3', 'third'),
    tool('t2', 'bash', 'error'),
    assistant('a3', 'done'),
  ])
  assert.deepEqual(
    rows.map((row) => row.id),
    ['u1', 'm1', 't1', 'u2', 'a2', 'u3', 't2', 'a3'],
  )
  const kept = railItems(rows, false, COPY, createRailCache())
  assert.deepEqual(
    kept.map((item) => item.id),
    ['u1', 'u2', 'u3'],
  )
  assert.equal(kept[0].description, 'let me look')
  // A turn that stopped without words has nothing to show under its prompt; the failed call's
  // result is not the agent's answer.
  assert.equal(kept[1].description, undefined)
  assert.equal(kept[2].description, 'done')

  // A transcript read back from the middle of a turn has no prompt for its leading rows; its one
  // record is still named, and its body is still what the agent wrote.
  const leading = railItems(
    buildRows([assistant('a0', 'resumed answer')]),
    false,
    COPY,
    createRailCache(),
  )
  assert.equal(leading.length, 1)
  assert.equal(leading[0].label, 'Message')
  assert.equal(leading[0].description, 'resumed answer')
})

test('a turn’s card is one line of the ask and the answer under it, never the ask’s own tail', () => {
  // The card's emphasis is the answer: a prompt past its budget loses its tail, and the body is
  // only ever the answer. Budgets are the characters the one 13px title line and the three 12px
  // answer lines hold at the rail's 300px width (50 / 120).
  const prompt =
    '把这段话整理成三条要点，说明为什么会这样，以及接下来应该先做哪一步，需要注意什么，还有哪些地方需要确认，最后给出结论'
  const asked = railItems(buildRows([user('u1', prompt)]), false, COPY, createRailCache())
  assert.equal(asked.length, 1)
  assert.equal(asked[0].label, `${prompt.slice(0, 50)}…`, 'the title line is cut at its budget')
  assert.equal(asked[0].description, undefined, 'a turn with no answer has no body, not the ask’s tail')

  const answer = '先确认现状：读取相关文件与最近提交，找出不一致的地方。'.repeat(6)
  const answered = railItems(
    buildRows([user('u2', 'short ask'), assistant('a2', answer)]),
    false,
    COPY,
    createRailCache(),
  )
  assert.equal(answered[0].label, 'short ask')
  assert.equal(answered[0].description, `${answer.slice(0, 120)}…`, 'the body is the answer, cut at its budget')
})

test('a turn’s accessible name is composed from where the rail draws it', () => {
  const cache = createRailCache()
  const rows = buildRows([user('u1', 'one'), assistant('a1', 'two')])
  const items = railItems(rows, false, COPY, cache)
  const name = items[0].ariaLabel
  assert.equal(typeof name === 'function' ? name(1, 1) : name, 'user 1/1')
  // The name is a function of the position, so the entry itself does not change when a turn is
  // appended: only the numbers it is handed when the rail draws it.
  const grown = railItems(
    buildRows([user('u1', 'one'), assistant('a1', 'two'), user('u2', 'three')]),
    false,
    COPY,
    cache,
  )
  assert.equal(grown.length, 2)
  assert.equal(grown[0], items[0])
  assert.equal(
    typeof grown[0].ariaLabel === 'function' ? grown[0].ariaLabel(1, 2) : grown[0].ariaLabel,
    'user 1/2',
  )
})

test('the rail is rebuilt when the wording moves, not only when its text does', () => {
  // A language switch changes every word the card can draw - the empty-row label, the in-flight
  // line and the accessible name - while the conversation itself has not changed a character. A
  // cache that compared only the text would hand the rail the entries it built in the old language.
  const rows = buildRows([user('u1', 'ship it')])
  const cache = createRailCache()
  const english = railItems(rows, false, COPY, cache)
  const chinese: RailCopy = {
    ...COPY,
    reminder: '规则提醒',
    message: '消息',
    working: '工作中…',
    railItemLabel: (sender, index, total) => `前往第 ${index} 条${sender}消息，共 ${total} 条`,
  }
  const localized = railItems(rows, false, chinese, cache)
  assert.notEqual(localized, english, 'the rail is handed new entries for a new language')
  const name = localized[0].ariaLabel
  assert.equal(typeof name === 'function' ? name(1, 1) : name, '前往第 1 条user消息，共 1 条')
  // The same wording again is the same list, so the switch costs one rebuild rather than a new one
  // on every frame.
  assert.equal(railItems(rows, false, chinese, cache), localized)
})

/** One reminder, as the harness writes it into a developer message. */
function reminder(id: string, rule: string, body = 'User-defined rule matched tool-call arguments.'): ChatMessage {
  clock += 1000
  return {
    kind: 'reminder',
    id,
    at: clock,
    text: `<system-reminder reason="rule_violation" rule="${rule}" path="builtin-defaults:${rule}.md">\n${body}\n</system-reminder>`,
  }
}

test('a reminder is a row of its own, where it happened, and never the turn’s row', () => {
  const rows = buildRows([
    user('u1', 'fix the types'),
    assistant('a1', '', ''),
    tool('t1', 'bash'),
    reminder('r1', 'ts-no-any'),
    assistant('a2', 'both are annotation problems'),
  ])

  assert.deepEqual(
    rows.map((row) => row.kind),
    ['single', 'single', 'reminders', 'single'],
  )
  const reminderRow = rows[2]
  assert.ok(reminderRow.kind === 'reminders')
  assert.deepEqual(
    reminderRow.reminders.map((entry) => entry.id),
    ['r1'],
  )
  // The reminder is an annotation: it names nobody, so the name is still the call's (the turn's
  // first drawn row) and the answer after the reminder does not name the agent a second time.
  const call = rows[1]
  assert.ok(call.kind === 'single' && call.namesSender === true)
  assert.ok(!('namesSender' in reminderRow))
})

test('consecutive firings of one rule are one row with a count, and two rules are two rows', () => {
  const rows = buildRows([
    user('u1', 'fix the types'),
    reminder('r1', 'ts-no-any'),
    reminder('r2', 'ts-no-any'),
    reminder('r3', 'ts-no-tiny-functions'),
  ])

  assert.deepEqual(
    rows.map((row) => (row.kind === 'reminders' ? row.reminders.length : 0)),
    [0, 2, 1],
  )
  const [first, second] = rows.filter((row) => row.kind === 'reminders')
  assert.ok(first !== undefined && second !== undefined)
  assert.deepEqual(
    first.reminders.map((entry) => entry.id),
    ['r1', 'r2'],
  )
  assert.deepEqual(
    second.reminders.map((entry) => entry.id),
    ['r3'],
  )
})

test('a reminder never takes the footer or the ending the turn states', () => {
  const rows = buildRows(
    [user('u1', 'go'), assistant('a1', 'done'), reminder('r1', 'ts-no-any')],
    { turn: { turnId: 'T1', outcome: 'completed', error: null } as never },
  )

  const reminderRow = rows.find((row) => row.kind === 'reminders')
  assert.ok(reminderRow !== undefined)
  assert.ok(!('tail' in reminderRow) && !('ending' in reminderRow))
  const answer = rows.find((row) => row.kind === 'single' && row.message.kind === 'assistant')
  assert.ok(answer !== undefined && answer.kind === 'single')
  assert.equal(answer.tail !== null, true)
})

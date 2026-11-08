import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatMessage } from '../api/session-types.ts'
import { buildRows } from './conversation-rows.ts'
import { estimateRowHeight } from './row-height.ts'

/**
 * What the window thinks a row is worth before it has measured it.
 *
 * The rule is the row's own words at the width they are drawn in: a paragraph wraps, a blank line is
 * a line, the reader's own message is drawn collapsed, a picture is a box, and a run of calls is one
 * line. These are the shapes a transcript is made of, and the estimate has to be close to all of
 * them — a flat number was a third of the smallest row and an eighth of a picture's, which is what
 * made scrolling into unmeasured space a screenful of corrections (2026-11-05).
 */

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

function call(id: string, resultText: string, images = 0): ChatMessage {
  clock += 1000
  return {
    kind: 'tool',
    id,
    at: clock,
    toolCallId: `call-${id}`,
    name: 'read',
    state: 'success',
    argsText: '{"path":"src/index.ts"}',
    resultText,
    startedAt: null,
    endedAt: null,
    intent: 'Read a file',
    ...(images === 0
      ? {}
      : {
          images: Array.from({ length: images }, () => ({
            mimeType: 'image/png',
            bytes: 1000,
            dataUrl: 'data:image/png;base64,AAAA',
          })),
        }),
  }
}

/** The one row a single message folds into. */
function heightOf(message: ChatMessage, lane = 768): number {
  const rows = buildRows([message], { streaming: false, turn: null, tipEntryId: null })
  assert.equal(rows.length, 1)
  return estimateRowHeight(rows[0]!, lane)
}

const LINE_PX = 24
/** The gap between two blocks (`mt-3`). */
const BLOCK_GAP_PX = 12

test('a blank line starts a new block, a soft wrap does not', () => {
  // Markdown joins consecutive source lines into one paragraph and starts a new one at a blank line:
  // the wrapped lines cost one paragraph, the blank line costs the gap plus the new block's line.
  const wrapped = heightOf(assistant('a1', 'One line.\nTwo.\nThree.'))
  const oneLine = heightOf(assistant('a2', 'One line. Two. Three.'))
  assert.equal(wrapped, oneLine)
  const one = heightOf(assistant('a3', 'One line.'))
  const two = heightOf(assistant('a4', 'One line.\n\nSecond.'))
  assert.equal(two - one, LINE_PX + BLOCK_GAP_PX)
})

test('a fenced block costs its own header and its own line height', () => {
  const code = heightOf(assistant('b1', '```ts\nconst a = 1\nconst b = 2\n```'))
  const prose = heightOf(assistant('b2', 'const a = 1\nconst b = 2'))
  // Two code lines at 20 px plus the card's own chrome, against one paragraph of prose.
  assert.equal(code, prose + 2 * 20 - LINE_PX + 40)
})

test('a paragraph wider than the lane wraps', () => {
  const text = 'x'.repeat(300)
  const wide = heightOf(assistant('c1', text), 1000)
  const narrow = heightOf(assistant('c2', text), 250)
  assert.ok(narrow > wide, `${narrow} should exceed ${wide}`)
  // A quarter of the lane is several times the lines.
  assert.ok(narrow - wide >= 6 * LINE_PX, `${narrow - wide} should exceed six lines`)
})

test('a settled answer’s reasoning is a collapsed disclosure, however long it is', () => {
  const short = heightOf(assistant('d1', 'Answer.', 'Weighing it.'))
  const long = heightOf(assistant('d2', 'Answer.', 'Weighing it.'.repeat(60)))
  const without = heightOf(assistant('d3', 'Answer.'))
  assert.equal(short, long, 'a closed fold costs the same whatever it holds')
  assert.ok(short > without, 'the fold itself is a row')
})

test('reasoning still arriving is drawn open', () => {
  const message = assistant('d4', '', 'One.\nTwo.')
  const live = buildRows([message], { streaming: true, turn: null, tipEntryId: null })
  const settled = buildRows([message], { streaming: false, turn: null, tipEntryId: null })
  assert.equal(live.length, 1)
  assert.equal(settled.length, 1)
  const liveRow = live[0]!
  assert.equal(liveRow.kind === 'single' ? liveRow.thinkingLive : null, true)
  assert.ok(
    estimateRowHeight(liveRow, 768) > estimateRowHeight(settled[0]!, 768),
    'the live block is open, the settled one is a fold',
  )
})

test("the reader's own message is drawn collapsed, however long it is", () => {
  const long = heightOf(user('e1', Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')))
  const short = heightOf(user('e2', 'One.\nTwo.\nThree.\nFour.\nFive.'))
  assert.equal(long, short)
})

test('a picture costs a box, and the box stops growing at the viewer’s ceiling', () => {
  const none = heightOf(call('f1', '480 lines'))
  const narrow = heightOf(call('f2', '480 lines', 1), 400)
  const wide = heightOf(call('f3', '480 lines', 1), 1200)
  const wider = heightOf(call('f4', '480 lines', 1), 2400)
  assert.ok(narrow > none)
  assert.ok(wide > narrow, 'a wider lane draws a wider picture')
  assert.equal(wider, wide, 'past the ceiling the picture stops growing')
})

test('a call that opens a turn carries the sender line', () => {
  // A turn whose first step is a tool call names its speaker on that call's row — 23 px on a lone
  // call's card, 19 px over a run's own header — which is what the estimate used to leave out.
  const opening = buildRows([user('u1', 'go'), call('k1', 'ok'), assistant('a1', 'answer')], {
    streaming: false,
    turn: null,
    tipEntryId: null,
  })
  // The call sits before an answer, so neither row carries the turn's footer: what is compared is
  // the sender line alone.
  const later = buildRows([user('u1', 'go'), assistant('a2', 'answer'), call('k2', 'ok'), assistant('a3', 'done')], {
    streaming: false,
    turn: null,
    tipEntryId: null,
  })
  const openingCall = opening[1]!
  const laterCall = later[2]!
  assert.equal(openingCall.kind === 'single' ? openingCall.namesSender : null, true)
  assert.equal(laterCall.kind === 'single' ? laterCall.namesSender : null, false)
  assert.equal(
    estimateRowHeight(openingCall, 768) - estimateRowHeight(laterCall, 768),
    23,
    'the sender line and its gap',
  )
})

test('a run of calls is one line, however many calls it holds', () => {
  const two = buildRows([call('g1', 'ok'), call('g2', 'ok')], {
    streaming: false,
    turn: null,
    tipEntryId: null,
  })
  const five = buildRows(
    [call('g3', 'ok'), call('g4', 'ok'), call('g5', 'ok'), call('g6', 'ok'), call('g7', 'ok')],
    { streaming: false, turn: null, tipEntryId: null },
  )
  assert.equal(two.length, 1)
  assert.equal(five.length, 1)
  assert.equal(estimateRowHeight(five[0]!, 768), estimateRowHeight(two[0]!, 768))
})

test('CJK wraps at half the latin count', () => {
  const latin = heightOf(assistant('h1', 'x'.repeat(200)), 400)
  const cjk = heightOf(assistant('h2', '汉'.repeat(200)), 400)
  assert.ok(cjk > latin, `${cjk} should exceed ${latin}`)
})

test('a lane narrower than a glyph is still one line', () => {
  const height = heightOf(assistant('i1', 'x'.repeat(400)), 1)
  assert.ok(Number.isFinite(height) && height > 0)
})

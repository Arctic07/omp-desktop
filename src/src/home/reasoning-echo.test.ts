import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readModelReasoning, splitReasoningEcho, splitThinkingMarker } from './reasoning-echo.ts'

/**
 * A step's reasoning envelope, read out of the words a model streamed it into.
 *
 * What is pinned down here is the reading: which writer counts as an opening, where the reasoning
 * ends and the answer begins, and the shapes a still-streaming message takes while its envelope is
 * half written. The vocabulary is a model's, not this application's, so every case below is a
 * message as the engine recorded it (2026-10-29: the shipped transcript of a step that planned in
 * the text channel).
 */

/** The message the reader saw, tags and all, as the engine recorded it. */
const PLANNED_IN_TEXT = `<previous_reasoning_empty/>page.rs 1002 — split 3 lines. Move \`prepare_capture\`/\`finish_capture\` (about 25 lines) to navigation.rs? They belong page; but navigation.rs is document events. Better move \`backing_window\` (20 lines) to platform.rs. Easy and drops ~18 lines.

Do it.</previous_reasoning>`

test('an envelope moves its reasoning out of the answer', () => {
  const read = splitReasoningEcho(PLANNED_IN_TEXT)
  assert.equal(read.reasoning.includes('page.rs 1002'), true)
  // The closing tag ends the envelope at the end of the message, so the step said nothing outside
  // it: what it wrote was all thinking, and it went on to call a tool.
  assert.equal(read.answer, '')
  assert.equal(read.reasoning.includes('previous_reasoning'), false)
})

test('words outside the envelope are the answer', () => {
  const read = splitReasoningEcho(
    '<previous_reasoning>weighing the two files</previous_reasoning>\n\nMoved it: `platform.rs`.',
  )
  assert.equal(read.reasoning, 'weighing the two files')
  assert.equal(read.answer, 'Moved it: `platform.rs`.')
})

test('an envelope with no closing tag yet is reasoning still arriving', () => {
  const streaming = splitReasoningEcho('<previous_reasoning_empty/>page.rs 1002 — split 3 li')
  assert.equal(streaming.reasoning, 'page.rs 1002 — split 3 li')
  // No answer yet: the tags never reach the bubble, and the reasoning fold fills instead.
  assert.equal(streaming.answer, '')
})

test('several envelopes are one stretch of reasoning, and the answer is the text between them', () => {
  const read = splitReasoningEcho(
    '<previous_reasoning>first thought</previous_reasoning>\nanswer so far\n<previous_reasoning_empty/>second thought</previous_reasoning>',
  )
  assert.equal(read.reasoning, 'first thought\n\nsecond thought')
  assert.equal(read.answer, 'answer so far')
})

test('a closing tag nothing opened is dropped', () => {
  const read = splitReasoningEcho('Moved it: `platform.rs`.</previous_reasoning>')
  assert.equal(read.answer, 'Moved it: `platform.rs`.')
})

test('a message that merely quotes the vocabulary keeps it', () => {
  // Mid-sentence: prose about the tag, which is not an envelope.
  const quoted = 'The model writes it as <previous_reasoning>x</previous_reasoning> in the text channel.'
  assert.deepEqual(splitReasoningEcho(quoted), { reasoning: '', answer: quoted })
  // And a fenced block spelling it out is code, whatever line it starts on.
  const fenced = 'The envelope looks like this:\n\n```text\n<previous_reasoning>thought</previous_reasoning>\n```\n'
  assert.deepEqual(splitReasoningEcho(fenced), { reasoning: '', answer: fenced })
})

test('a message with no envelope at all is returned as it was', () => {
  const plain = 'Moved it: `platform.rs`.\n\nOne more line.'
  assert.deepEqual(splitReasoningEcho(plain), { reasoning: '', answer: plain })
})

/**
 * The other channel's envelope: a model that streams its answer into the reasoning channel and
 * writes `</thinking>` where the answer begins.
 *
 * Every case below is a step as the engine recorded it (`me/deepseek-v4.1-flash` through
 * `openai-completions`, 2026-10-26 to 2026-10-31): the marker closes reasoning that ended at the end
 * of the message, or reasoning whose answer followed it in the same channel.
 */

test('a marker with nothing after it leaves the reasoning and no answer', () => {
  const thinking = "Sweep the cache, then rerun the suite.\n\nLet me write and run.</thinking>"
  const read = splitThinkingMarker(thinking)
  assert.equal(read.reasoning, 'Sweep the cache, then rerun the suite.\n\nLet me write and run.')
  assert.equal(read.answer, '')
})

test('the answer a model left in its reasoning channel is its answer', () => {
  // The reported shape (2026-11-01): the step reasoned, closed the block, and wrote its answer
  // after the closer — the engine recorded both as thinking, so the fold held the answer and the
  // bubble under it stayed empty.
  const thinking = [
    'The recorder ended with no windows, so the flag is the thing to re-test.',
    'Let me reply briefly and wait.</thinking>是。你现在什么都不用做，我继续推进。',
  ].join('\n')
  const read = splitThinkingMarker(thinking)
  assert.equal(
    read.reasoning,
    'The recorder ended with no windows, so the flag is the thing to re-test.\nLet me reply briefly and wait.',
  )
  assert.equal(read.answer, '是。你现在什么都不用做，我继续推进。')
})

test('markers after the first one are dropped, and their words stay the answer', () => {
  const thinking = 'Plan it.\n\nApply.</thinking>## Verifying build</thinking>'
  const read = splitThinkingMarker(thinking)
  assert.equal(read.reasoning, 'Plan it.\n\nApply.')
  assert.equal(read.answer, '## Verifying build')
})

test('a marker inside code is the example it shows, not an envelope', () => {
  const inline = 'The provider leaks `</thinking>` into reasoning_content.'
  assert.deepEqual(splitThinkingMarker(inline), { reasoning: inline, answer: '' })
  const fenced = 'Recorded shape:\n\n```text\nreasoning</thinking>answer\n```'
  assert.deepEqual(splitThinkingMarker(fenced), { reasoning: fenced, answer: '' })
})

test('a step writing about the marker keeps its mention and all of its thinking', () => {
  // Quoted, spaced or bracketed neighbours are a model discussing the vocabulary — reporting this
  // very defect — and reading one as a transition would publish the rest of its thinking as an
  // answer.
  for (const quoted of [
    'The model writes </thinking> in the reasoning channel.',
    'A closer reads as `</thinking>` there.',
    'So the row ends with "</thinking>" and nothing after it.',
  ]) {
    assert.deepEqual(splitThinkingMarker(quoted), { reasoning: quoted, answer: '' }, quoted)
  }
  // A closer that ends a line and whose words carry on below is left where it is for the same
  // reason: the answer after a transition never begins on a new line in the recorded steps.
  const wrapped = 'Close it here.</thinking>\n\nAnd the sentence goes on.'
  assert.equal(splitThinkingMarker(wrapped).answer, '')
})

test('a channel with no transition reads as it was written', () => {
  // An opener with no closer says nothing this side can act on, and altering the step's words for a
  // marker nobody emits is how a reading starts rewriting what a model said.
  assert.deepEqual(splitThinkingMarker('<thinking>Weighing it'), {
    reasoning: '<thinking>Weighing it',
    answer: '',
  })
  assert.deepEqual(splitThinkingMarker('Weighing it.'), { reasoning: 'Weighing it.', answer: '' })
})

test('both channels are read together, and an untouched step keeps its own bytes', () => {
  // The answer channel's own stray closer (`me/deepseek-v4.1-flash` closed an answer with one) is
  // markup too, and the reasoning behind it is the step's thinking.
  const read = readModelReasoning(
    'The migration is applied.</thinking>',
    'Check the schema first.',
  )
  assert.equal(read.reasoning, 'Check the schema first.')
  assert.equal(read.answer, 'The migration is applied.')

  // A step whose answer channel is nothing but a closer answers with what it wrote after the
  // marker in its thinking, not with an empty bubble.
  const onlyMarker = readModelReasoning('</thinking>', 'Fetch the frames.</thinking>Fetched: three frames.')
  assert.equal(onlyMarker.reasoning, 'Fetch the frames.')
  assert.equal(onlyMarker.answer, 'Fetched: three frames.')

  const plain = readModelReasoning('Moved it.', 'Weighing the two files.')
  assert.deepEqual(plain, { reasoning: 'Weighing the two files.', answer: 'Moved it.' })
})

/**
 * The model's own `<thought>` block: the plan it wrote into the answer channel.
 *
 * Measured 2026-11-04 on `me/deepseek-v4.1-flash`: a step's whole answer was one `<thought>` block,
 * so the transcript drew the plan as the reply and the reasoning fold stayed empty.
 */

test('a thought envelope moves its reasoning out of the answer', () => {
  const read = splitReasoningEcho(
    '<thought>Now the file panel rewrite. Read the current file, then write it.</thought>',
  )
  assert.equal(read.reasoning, 'Now the file panel rewrite. Read the current file, then write it.')
  assert.equal(read.answer, '')
})

test('words outside a thought envelope are the answer', () => {
  const read = splitReasoningEcho(
    '<thought>weighing the two files</thought>\n\nMoved it: `platform.rs`.',
  )
  assert.equal(read.reasoning, 'weighing the two files')
  assert.equal(read.answer, 'Moved it: `platform.rs`.')
})

test('an unclosed thought envelope is reasoning still arriving', () => {
  const read = splitReasoningEcho('<thought>Now the file panel rewrite')
  assert.equal(read.reasoning, 'Now the file panel rewrite')
  assert.equal(read.answer, '')
})

test('a thought envelope mentioned in prose or shown in code is not one', () => {
  const quoted = 'The model writes <thought>x</thought> in the text channel.'
  assert.deepEqual(splitReasoningEcho(quoted), { reasoning: '', answer: quoted })
  const fenced = 'The shape is:\n\n```text\n<thought>plan</thought>\n```\n'
  assert.deepEqual(splitReasoningEcho(fenced), { reasoning: '', answer: fenced })
})

test('a thought block joins the reasoning channel the step already wrote', () => {
  const read = readModelReasoning(
    '<thought>weighing the two files</thought>\n\nMoved it.',
    'Checked the schema first.',
  )
  assert.equal(read.reasoning, 'Checked the schema first.\n\nweighing the two files')
  assert.equal(read.answer, 'Moved it.')
})

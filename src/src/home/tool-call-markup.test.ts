import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readStrayToolCall, stripToolCallMarkup } from './tool-call-markup.ts'

/**
 * A tool call the engine never parsed, read out of a step's words.
 *
 * The negatives matter as much as the hits: a step that reports this defect, quotes one of these
 * fragments, or shows it in a code fence is answering in prose, and its words are its answer. Every
 * shape below is one the 2026-10-26…2026-11-01 recordings hold, or a sentence written about one.
 */

test('the shapes the recordings hold are one fact: an envelope, not an answer', () => {
  // The unfinished one: the model stopped after its argument, mid-fragment.
  const half = readStrayToolCall('<parameter name="i">Checking VS 2022 layout')
  assert.equal(half?.name, null)
  // The duplicated closers the model wrote after a lost opener.
  const dupes = readStrayToolCall(
    '<parameter name="i">Verifying the fold and bubble split</parameter>\n</parameter>\n</invoke>',
  )
  assert.equal(dupes?.name, null)
  assert.match(dupes?.raw ?? '', /Verifying the fold and bubble split$|<\/invoke>/)
})

test('an envelope that kept its opener names the tool, whatever dialect wrote it', () => {
  const dsml = readStrayToolCall(
    '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="Browser">\n<｜DSML｜parameter name="i" string="true">Verifying</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
  )
  assert.equal(dsml?.name, 'Browser')
  const bare = readStrayToolCall(
    '<function_calls>\n<invoke name="bash"><parameter name="command">ls -la</parameter></invoke>\n</function_calls>',
  )
  assert.equal(bare?.name, 'bash')
})

test('an argument body is text like any other, so a command with angle brackets is still a call', () => {
  const hit = readStrayToolCall(
    '<invoke name="bash"><parameter name="command">grep "<a>" file.txt</parameter></invoke>',
  )
  assert.equal(hit?.name, 'bash')
})

test('a step talking about the markup answers in prose', () => {
  assert.equal(
    readStrayToolCall('The model wrote <parameter name="i">x</parameter> as plain text today.'),
    null,
  )
  assert.equal(
    readStrayToolCall('Fixed: the `<parameter name="i">` fragment no longer reaches the bubble.'),
    null,
  )
  assert.equal(
    readStrayToolCall(
      'A fragment reads like this:\n\n```\n<parameter name="i">Verifying</parameter>\n```\n',
    ),
    null,
  )
  assert.equal(readStrayToolCall('The fix is applied.'), null)
  assert.equal(readStrayToolCall(''), null)
})

test('a fragment with no element in it is not one', () => {
  assert.equal(readStrayToolCall('</invoke>\n</parameter>'), null)
  assert.equal(readStrayToolCall('<3 and other prose'), null)
})

test('the legacy spelling names the tool and reads its child elements as arguments', () => {
  const hit = readStrayToolCall(
    '<Browser> <action>screenshot</action> <i>Capturing 375 FAQ</i> </Browser>',
  )
  assert.equal(hit?.name, 'Browser')
  assert.deepEqual(hit?.args, { action: 'screenshot', i: 'Capturing 375 FAQ' })
  assert.deepEqual(hit?.calls, [
    { name: 'Browser', args: { action: 'screenshot', i: 'Capturing 375 FAQ' } },
  ])
})

test('a dialect call keeps the arguments it wrote as parameters', () => {
  const hit = readStrayToolCall(
    '<invoke name="bash"><parameter name="command">ls -la</parameter></invoke>',
  )
  assert.equal(hit?.name, 'bash')
  assert.deepEqual(hit?.args, { command: 'ls -la' })
})

test('several legacy calls are several calls', () => {
  const hit = readStrayToolCall(
    '<Browser><action>screenshot</action></Browser>\n<bash><command>ls -la</command></bash>',
  )
  assert.deepEqual(
    hit?.calls.map((call) => call.name),
    ['Browser', 'bash'],
  )
})

test('a dialect wrapper around the legacy spelling is still one envelope', () => {
  const hit = readStrayToolCall(
    '<tool_calls><Browser><action>screenshot</action></Browser></tool_calls>',
  )
  assert.equal(hit?.name, 'Browser')
  assert.deepEqual(hit?.args, { action: 'screenshot' })
})

test('the legacy `<parameters>` wrapper is read as the call it wraps', () => {
  const hit = readStrayToolCall(
    '<Browser><parameters><action>screenshot</action></parameters></Browser>',
  )
  assert.equal(hit?.name, 'Browser')
  assert.deepEqual(hit?.args, { action: 'screenshot' })
})

test('an unknown root with arguments is the fallback the unexpected tags need', () => {
  const hit = readStrayToolCall('<SomeTool><action>screenshot</action></SomeTool>')
  assert.equal(hit?.name, 'SomeTool')
  assert.deepEqual(hit?.args, { action: 'screenshot' })
})

test('a legacy shape that is prose, code, or an element of the page stays prose', () => {
  // A sentence beside the envelope is an answer that mentions a call.
  assert.equal(
    readStrayToolCall('The call was <Browser><action>screenshot</action></Browser> in the text.'),
    null,
  )
  // A fenced block is showing the markup.
  assert.equal(
    readStrayToolCall('```\n<Browser><action>screenshot</action></Browser>\n```'),
    null,
  )
  // A page element is not a tool, and a model tag is not one either.
  assert.equal(readStrayToolCall('<div><span>hello</span></div>'), null)
  assert.equal(readStrayToolCall('<important><b>read this</b></important>'), null)
  assert.equal(readStrayToolCall('<thought><i>weighing it</i></thought>'), null)
  // A body of bare text is not an argument list: nothing says this is a call.
  assert.equal(readStrayToolCall('<Browser>screenshot</Browser>'), null)
})

/**
 * The spelling whose arguments are attributes: `<ask i="…" questions="[…]">`.
 *
 * The 2026-11-09 recording is the fixture: a finished answer, then a call the model appended and cut
 * before its `>`. The engine healed the call on the next step, so the ask dialog ran, and the
 * fragment still sat in the step's words — the bubble drew the tag over the answer.
 */

test('a call cut before its `>` is read as the call it was writing', () => {
  const hit = readStrayToolCall(
    '<ask i="Confirming merge and notices follow-up" questions="[{"id": "merge", "question": "合并吗？"}]',
  )
  assert.equal(hit?.name, 'ask')
  assert.equal(hit?.args.i, 'Confirming merge and notices follow-up')
  // The value is the JSON the model wrote with its own quote character reused inside it.
  assert.equal(hit?.args.questions, '[{"id": "merge", "question": "合并吗？"}]')
})

test('the attribute spelling names its tool the same way the other spellings do', () => {
  const selfClosed = readStrayToolCall('<bash i="Listing the tree" command="ls -la"/>')
  assert.equal(selfClosed?.name, 'bash')
  assert.deepEqual(selfClosed?.args, { i: 'Listing the tree', command: 'ls -la' })
  const paired = readStrayToolCall('<read i="Reading the parser" path="home/markdown.ts"></read>')
  assert.equal(paired?.name, 'read')
  assert.deepEqual(paired?.args, { i: 'Reading the parser', path: 'home/markdown.ts' })
  // Words beside the element are an answer that mentions a call.
  assert.equal(readStrayToolCall('<ask i="x"> beside a sentence'), null)
  // A page element keeps being a page element even with an attribute.
  assert.equal(readStrayToolCall('<meta property="og:image" content="/media/og.png" />'), null)
  assert.equal(readStrayToolCall('<div i="not a tool">hello</div>'), null)
})

test('the fragment beside a finished answer is markup, not one of the words', () => {
  const answer = '已完成，分支 `chore/mit-license`，未合并。\n\n**结论：允许。**\n\n<ask i="Confirming merge" questions="[{"id": "merge"}]'
  assert.equal(stripToolCallMarkup(answer), '已完成，分支 `chore/mit-license`，未合并。\n\n**结论：允许。**\n\n')
})

test('a call on its own line takes the line, and one mid-sentence takes a space', () => {
  assert.equal(
    stripToolCallMarkup('The tree is clean.\n<read i="Reading" path="a.ts"/>\nNext: the patch.'),
    'The tree is clean.\nNext: the patch.',
  )
  assert.equal(
    stripToolCallMarkup('Fixed it <edit i="Patching" path="a.ts"/> and reran the suite.'),
    'Fixed it and reran the suite.',
  )
})

test('a call the answer is talking about keeps its brackets', () => {
  const span = 'The model wrote `<ask i="x" questions="[]">` and the engine ran it.'
  assert.equal(stripToolCallMarkup(span), span)
  const fence = '```\n<ask i="x" questions="[]">\n```'
  assert.equal(stripToolCallMarkup(fence), fence)
  // A tag with attributes but no argument is prose about markup, and stays.
  const prose = 'Write <link rel="canonical" href="/a"> in the head.'
  assert.equal(stripToolCallMarkup(prose), prose)
})

test('a legacy call that carries an attribute still reads its child elements', () => {
  // The root has one attribute, but its arguments are children: the body decides which spelling it is.
  const hit = readStrayToolCall('<Browser i="Capturing"><action>screenshot</action></Browser>')
  assert.equal(hit?.name, 'Browser')
  assert.deepEqual(hit?.args, { action: 'screenshot' })
})

test('a dialect fragment appended at the head of a line goes with the line', () => {
  const answer =
    'Fixed the drop path.\n<tool_invoke>\n<parameter name="i">Anchoring</parameter>\n<parameter name="path">a.ts\n\nnext paragraph'
  assert.equal(stripToolCallMarkup(answer), 'Fixed the drop path.\nnext paragraph')
  // Mid-sentence it is a sentence about the markup, and stays.
  const sentence = 'The engine wrote <parameter name="i">x</parameter> as text.'
  assert.equal(stripToolCallMarkup(sentence), sentence)
})

test('a fragment cut inside an argument value is still the call it was writing', () => {
  // The model stopped mid-JSON and mid-string: the line is where its value stopped.
  assert.equal(
    stripToolCallMarkup('答案在下面。\n<ask i="x" questions="[{"id": "merge'),
    '答案在下面。\n',
  )
  assert.equal(stripToolCallMarkup('答案在下面。\n<read i="x" path="a.ts'), '答案在下面。\n')
})

test('a call that never said where it ends is only claimed at the head of a line', () => {
  // Mid-sentence the same bytes are a sentence about the markup, and it keeps its words.
  const sentence = 'The engine wrote <ask i="x"> for that.'
  assert.equal(stripToolCallMarkup(sentence), sentence)
  // Closed where it stands, it goes wherever it is.
  assert.equal(
    stripToolCallMarkup('Fixed it <edit i="Patching" path="a.ts" /> and reran.'),
    'Fixed it and reran.',
  )
})

test('only the element with that exact name closes a call', () => {
  // `</askers>` is a different element, so the opener is unfinished — and mid-sentence an
  // unfinished opener is a sentence about the markup.
  assert.equal(readStrayToolCall('<ask i="x"></askers>'), null)
  const sentence = 'prose <ask i="x"></askers> more'
  assert.equal(stripToolCallMarkup(sentence), sentence)
})

test('a legacy envelope beside prose goes when its body is the arguments a call carries', () => {
  assert.equal(
    stripToolCallMarkup(
      'Fixed it.\n<Browser><action>screenshot</action><i>Capturing</i></Browser>\nDone.',
    ),
    'Fixed it.\nDone.',
  )
  // A block of prose inside a closing tag is not a call.
  const prose = 'See:\n<example><details>x</details></example>'
  assert.equal(stripToolCallMarkup(prose), prose)
})

test('a fence still being streamed is code to its end, not prose', () => {
  const streaming = 'Look:\n```ts\n<ask i="x" questions="[1]"/>'
  assert.equal(stripToolCallMarkup(streaming), streaming)
})

test('a pretty-printed argument is one value, and the call ends with its line', () => {
  const answer = '答案：\n<ask i="x" questions="[\n  {"id": "a"},\n  {"id": "b"}\n]">\n后续'
  assert.equal(stripToolCallMarkup(answer), '答案：\n后续')
})

test('a fragment first in the step leaves the answer under it', () => {
  // The write stopped inside the argument, and the answer follows on the next line: the step is
  // prose plus a fragment, never a whole-message call — its answer must survive.
  const step = '<ask i="x" questions="[{"id": "a"\n这是答案。'
  assert.equal(readStrayToolCall(step), null)
  assert.equal(stripToolCallMarkup(step), '这是答案。')
})

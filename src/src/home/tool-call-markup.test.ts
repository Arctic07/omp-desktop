import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readStrayToolCall } from './tool-call-markup.ts'

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

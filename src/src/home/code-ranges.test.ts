import assert from 'node:assert/strict'
import { test } from 'node:test'

import { codeRanges, codeSegments } from './code-ranges.ts'

/**
 * Where a message's code runs — the one fact the reasoning reader, the model-tag stripper and the
 * tool-call stripper all need, so that a message showing markup inside code keeps showing it.
 *
 * The shapes below are the ones the three readers disagreed on before they shared this module: a
 * fence opened with tildes, and a fence whose closer has not arrived yet (the block is still being
 * streamed, and its tags are code already).
 */

test('a fenced block is code, in either fence, and an unclosed one runs to the end', () => {
  assert.deepEqual(codeRanges('a\n```\nx\n```\nb'), [
    [2, 11],
  ])
  assert.deepEqual(codeRanges('a\n~~~\nx\n~~~'), [
    [2, 11],
  ])
  // The closer never arrived: everything from the fence on is the block still being written.
  assert.deepEqual(codeRanges('a\n```\n<ask i="x">'), [[2, 17]])
})

test('a one-line span is code, and a span inside a fence is the fence’s', () => {
  assert.deepEqual(codeRanges('a `x` b'), [
    [2, 5],
  ])
  assert.deepEqual(codeRanges('```\n`x`\n```'), [
    [0, 11],
  ])
})

test('the segments alternate, so the odd ones are code byte for byte', () => {
  const text = 'a `<b>` c\n```\nd\n```\ne'
  const segments = codeSegments(text)
  assert.deepEqual(segments, ['a ', '`<b>`', ' c\n', '```\nd\n```', '\ne'])
  assert.equal(segments.join(''), text)
  assert.equal(segments.length % 2, 1)
})

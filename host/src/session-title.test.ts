import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sessionTitleText } from './session-title.ts'

/** The name a `Fork of …` title starts from: the words, never the marker a model wrapped them in. */

test('a translated title envelope is taken off', () => {
  assert.equal(
    sessionTitleText('<标题>修复浏览器 agent 蒙版错位与 GPU 卡顿</标题>'),
    '修复浏览器 agent 蒙版错位与 GPU 卡顿',
  )
})

test('the ASCII marker and its attributes are taken off too', () => {
  assert.equal(sessionTitleText('<title>Fix flaky park tests</title>'), 'Fix flaky park tests')
  assert.equal(sessionTitleText('<title lang="zh">修复卡顿</title>'), '修复卡顿')
  assert.equal(sessionTitleText('<TITLE>Fix</tItLe>'), 'Fix')
})

test('nested envelopes are peeled one layer at a time', () => {
  assert.equal(sessionTitleText('<标题><title>修复卡顿</title></标题>'), '修复卡顿')
})

test('markup the title quotes is content, not an envelope', () => {
  assert.equal(
    sessionTitleText('修复嵌套的 <div></div> 渲染'),
    '修复嵌套的 <div></div> 渲染',
  )
  assert.equal(sessionTitleText('<div> 是怎么工作的'), '<div> 是怎么工作的')
  // A mismatched pair is text like any other.
  assert.equal(sessionTitleText('<标题>修复</title>'), '<标题>修复</title>')
})

test('an empty marker names nothing', () => {
  assert.equal(sessionTitleText('<标题/>'), '')
  assert.equal(sessionTitleText('<title/>'), '')
  assert.equal(sessionTitleText('   '), '')
  assert.equal(sessionTitleText(null), '')
})

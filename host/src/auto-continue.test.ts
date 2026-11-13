/**
 * The built-in auto-continue plugin's decision, read from the package this build ships.
 *
 * The extension itself runs inside the engine, so the half worth pinning is the one that decides
 * whether a failed turn deserves a continuation: the wrong answer costs the user quota and answers a
 * request they never made. The file is imported from `src-tauri/resources/builtin-browser-marketplace`
 * rather than copied, so a change to the shipped package is what these assertions read.
 *
 * Each class is asserted on its own, because the four ways a turn can end without continuing are
 * different facts that must not collapse into one: a normal finish, the operator's own stop (or a
 * process that died), a reconnection the engine is performing, and a failure no new turn can repair.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classifyTurn,
  continueText,
  deliveredText,
  isOperatorPrompt,
  lastOperatorText,
  runDeliveredText,
} from '../../src-tauri/resources/builtin-browser-marketplace/package/omp.auto-continue/extensions/auto-continue.ts'

/** An assistant turn that ended with `error` and the given body. */
function failed(errorMessage: string, content: { type: string; text?: string }[] = []) {
  return { role: 'assistant', stopReason: 'error', errorMessage, content }
}

/** A Go gateway cutting its own upstream, as this desktop's provider prints it. */
const GO_CUT =
  'Error reading stream: read tcp 10.20.101.233:45282->3.173.21.63:443: read: connection reset by peer'

test('a remote transport cut before any answer is the one class that continues', () => {
  assert.equal(classifyTurn(failed(GO_CUT)), 'remote')
  // Thinking is not an answer: the reader has seen no text yet.
  assert.equal(classifyTurn(failed(GO_CUT, [{ type: 'thinking' }])), 'remote')
  assert.equal(classifyTurn(failed('ECONNRESET: The socket connection was closed unexpectedly')), 'remote')
  assert.equal(classifyTurn(failed('Upstream response stream ended before completion')), 'remote')
  assert.equal(classifyTurn(failed('OpenAI completions stream stalled while waiting for the next event')), 'remote')
  assert.equal(classifyTurn(failed('Upstream HTTP/2 stream failed')), 'remote')
  assert.equal(classifyTurn(failed('Provider finish_reason: content_filter')), 'remote')
  assert.equal(classifyTurn(failed('An internal error occurred. (internal_error)')), 'remote')
  assert.equal(classifyTurn(failed('503 Service temporarily unavailable (type=api_error)')), 'remote')
})

test('a turn that already answered is left to the engine', () => {
  // Committed text is the engine's own mid-stream transport class to resume; resending would
  // duplicate what the reader already has.
  assert.equal(classifyTurn(failed(GO_CUT, [{ type: 'text', text: '分析完了，接下来' }])), 'normal')
  // Whitespace is not an answer.
  assert.equal(classifyTurn(failed(GO_CUT, [{ type: 'text', text: '   \n ' }])), 'remote')
  // Leaked tool-call markup is not an answer either.
  assert.equal(classifyTurn(failed(GO_CUT, [{ type: 'text', text: '<|DSML|tool_calls>{"a":1}' }])), 'remote')
})

test('a normal ending is never continued', () => {
  assert.equal(classifyTurn({ role: 'assistant', stopReason: 'stop', content: [] }), 'normal')
  assert.equal(classifyTurn({ role: 'assistant', stopReason: 'toolUse', content: [] }), 'normal')
  assert.equal(classifyTurn({ role: 'assistant', stopReason: 'length', content: [] }), 'normal')
  // An error with no text is not evidence of anything.
  assert.equal(classifyTurn({ role: 'assistant', stopReason: 'error', content: [] }), 'normal')
})

test("the operator's own stop is never overridden", () => {
  // Esc during a turn.
  assert.equal(classifyTurn({ role: 'assistant', stopReason: 'aborted', content: [] }), 'user-stop')
  // The application or the process went away mid-turn: there is no session left to continue in.
  assert.equal(
    classifyTurn(failed('Previous OMP process exited before completing the turn.')),
    'user-stop',
  )
})

test('a reconnection the engine is performing is not continued', () => {
  // The engine's own retry loop is the reconnection; a prompt sent into it races the resume.
  assert.equal(classifyTurn(failed('reconnecting to provider (attempt 2 of 5)')), 'reconnect')
  assert.equal(classifyTurn(failed('Upstream stream failed; will retry in 2s')), 'reconnect')
  // The engine announced the retry itself, whatever the error text says — including a budget that
  // ran out, because those attempts already were the reconnect.
  assert.equal(classifyTurn(failed(GO_CUT), true), 'reconnect')
  assert.equal(classifyTurn(failed('429 rate limit'), true), 'reconnect')
})

test('failures a new turn cannot repair are not continued', () => {
  for (const message of [
    '401 Invalid token (request id: abc)',
    '429 WorkBuddy AI: usage exceeds frequency limit',
    '402 insufficient_balance: Coding Plan quota is exhausted',
    '400 [code=tier_limit_exceeded] membership concurrency limit exceeded',
    "Couldn't connect to 127.0.0.1:3425 (connection refused). Check that the server is running",
    'context window exceeded: prompt is too long',
    'invalid model: deepseek-v9',
    // An error this build cannot read as transport is not a reason to spend another request.
    'something nobody has seen before',
  ]) {
    assert.equal(classifyTurn(failed(message)), 'unrepairable', message)
  }
})

test('the continuation follows the language of the operator prompt', () => {
  assert.equal(continueText('机构查询页面table优化一下'), '继续')
  assert.equal(continueText('优化一下这个表格'), '继续')
  assert.equal(continueText('fix the paste position'), 'continue')
  assert.equal(continueText(''), 'continue')
  // A mixed prompt is read as the operator writes it: Han text means Chinese.
  assert.equal(continueText('fix 粘贴'), '继续')
})

test('leaked tool markup is cut out of what a message delivered', () => {
  assert.equal(deliveredText({ role: 'assistant', content: [{ type: 'text', text: '正文' }] }), '正文')
  assert.equal(
    deliveredText({
      role: 'assistant',
      content: [{ type: 'text', text: '正文<|DSML|tool_calls><|DSML|invoke name="read">x' }],
    }),
    '正文',
  )
  // A leaked envelope with no prose before it delivered no answer at all.
  assert.equal(
    deliveredText({
      role: 'assistant',
      content: [{ type: 'text', text: '<function_calls><invoke name="bash"/></function_calls>' }],
    }),
    '',
  )
  // Prose before a leaked envelope is still an answer.
  assert.equal(
    deliveredText({
      role: 'assistant',
      content: [
        { type: 'text', text: '先做完了。<parameter name="i">继续等待后端架构报告</parameter>' },
      ],
    }),
    '先做完了。',
  )
})

test('markup inside code is an example, not an envelope', () => {
  const body = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
  // A fenced block is where a message shows markup on purpose.
  assert.equal(deliveredText(body('示例：\n```\n<invoke name="x"/>\n```\n以上')), '示例：\n```\n<invoke name="x"/>\n```\n以上')
  // An inline span too.
  assert.equal(deliveredText(body('使用 `<invoke>` 语法')), '使用 `<invoke>` 语法')
  // An unterminated fence is still being streamed, so it is code to the end.
  assert.equal(deliveredText(body('示例：\n```\n<invoke name="x"/>')), '示例：\n```\n<invoke name="x"/>')
  // A body that opens with a fenced example is prose, not an envelope.
  assert.equal(deliveredText(body('```\n<invoke/>\n```')), '```\n<invoke/>\n```')
})

test('prose that mentions a tag keeps its words', () => {
  const body = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
  // The tag goes, the sentence stays: this is the case a cut-at-the-first-tag rule broke.
  assert.equal(deliveredText(body('修好了 <div> 的样式')), '修好了   的样式')
  // A comparison is not a tag at all.
  assert.equal(deliveredText(body('a < b 且 c > d')), 'a < b 且 c > d')
  // A leaked call still ends the answer where it starts.
  assert.equal(deliveredText(body('正文<|DSML|tool_calls><|DSML|invoke name="read">x')), '正文')
})

test('a run that already printed prose is not resumed, whichever step failed', () => {
  // The reviewer's case, measured on this machine's sessions (75 occurrences; the operator typed
  // 继续 after 20 of them and a new instruction after 27): the run is the unit, not the step.
  const run = [
    { role: 'user', content: [{ type: 'text', text: '把表格做完' }] },
    { role: 'assistant', content: [{ type: 'text', text: '先看了一遍现有实现。' }] },
    { role: 'assistant', stopReason: 'error', errorMessage: 'ECONNRESET: socket closed', content: [] },
  ]
  assert.equal(runDeliveredText(run), '先看了一遍现有实现。')
  assert.equal(classifyTurn(run[2], false, runDeliveredText(run)), 'normal')
  // The same failure in a run that printed nothing is the one this plugin exists for.
  const silent = [run[0], run[2]]
  assert.equal(classifyTurn(run[2], false, runDeliveredText(silent)), 'remote')
  // Prose before the operator's own prompt belongs to an earlier run.
  assert.equal(runDeliveredText([run[1], run[0]]), '')
})

test('an operator prompt is a user turn this plugin did not send', () => {
  assert.equal(isOperatorPrompt({ role: 'user' }), true)
  assert.equal(isOperatorPrompt({ role: 'user', attribution: 'agent' }), false)
  assert.equal(isOperatorPrompt({ role: 'user', synthetic: true }), false)
  assert.equal(isOperatorPrompt({ role: 'assistant' }), false)
})

test('the language is read from the last prompt the operator wrote', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first request' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    // Another extension's prompt is not the operator's.
    { role: 'user', attribution: 'agent' as const, content: [{ type: 'text', text: '继续' }] },
    { role: 'user', content: [{ type: 'text', text: '把剩下的做完' }] },
  ]
  assert.equal(lastOperatorText(messages), '把剩下的做完')
  assert.equal(lastOperatorText([{ role: 'assistant', content: [] }]), '')
})

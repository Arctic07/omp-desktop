import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  hasSystemNotices,
  messageProse,
  parseJobDelivery,
  splitSystemNotices,
  stripModelTags,
  type ParsedJobDelivery,
  type SystemNoticePart,
} from './system-notice.ts'

/**
 * The engine's own wrapper blocks and the deliveries it writes inside them, read back into the facts
 * they carry.
 *
 * The engine hands a finished background job back as message text — a headline, a `<task-result>`
 * element per `task`, and a closing sentence about where the payload lives — and the only thing a
 * reader ever sees is the shape this module returns. What is pinned down here is therefore the
 * reading, not the drawing: the text a block sits between, the tolerances that keep a quotation from
 * being read as a delivery, and the empty fields a missing element leaves behind. Every case below
 * was checked against the Vue front end's own parser when this was ported, so a case that starts
 * failing means the two front ends have parted company.
 */

/** A `task`'s delivery, exactly as the engine writes it into the conversation. */
const TASK_DELIVERY = `<system-notice>
Background job ContentEgret has completed. Resume your work using the result below.
<task-result id="ContentEgret" agent="sonic" status="completed" duration="5.2s">
<meta lines="4" size="43B" />
<output>
{ "file": "package.json", "lines": 40 }
</output>
</task-result>
ContentEgret is now idle — message it via \`write agent://ContentEgret\` to follow up; transcript at history://ContentEgret
</system-notice>`

/** A background shell: a headline and its own result, with no element of its own. */
const SHELL_DELIVERY = `Background job bg_18 has completed.
$ echo hi
hi`

/** One notice part, narrowed — the shape a test asserting on a block's own fields needs. */
type NoticePart = Extract<SystemNoticePart, { kind: 'notice' }>

/** The notice parts of a text, in the order the engine wrote them. */
function notices(text: string): NoticePart[] {
  return splitSystemNotices(text).filter(
    (part): part is NoticePart => part.kind === 'notice',
  )
}

/** The one delivery a text is expected to be, so a test can assert on it without a null check. */
function delivery(text: string): ParsedJobDelivery {
  const parsed = parseJobDelivery(text)
  assert.ok(parsed !== null, 'expected this text to read as a delivery')
  return parsed
}

test('a message is read as the prose around a block and the block itself', () => {
  // The engine puts a user's own words after a notice it wrapped, so the text on either side is
  // text — trimmed of the separator line breaks, which would otherwise draw as empty paragraphs.
  const parts = splitSystemNotices(
    'here is what I did\n<system-notice>\nBe careful with this.\n</system-notice>\nand here is what I mean',
  )

  assert.deepEqual(parts, [
    { kind: 'text', text: 'here is what I did' },
    { kind: 'notice', tag: 'system-notice', text: 'Be careful with this.', delivery: null, irc: null },
    { kind: 'text', text: 'and here is what I mean' },
  ])
})

test('several blocks in one message are read in the order the engine wrote them', () => {
  const parts = splitSystemNotices(
    'a\n<system-notice>one</system-notice>\nb\n<system-reminder>two</system-reminder>\nc',
  )

  assert.deepEqual(
    parts.map((part) => (part.kind === 'notice' ? part.tag : `text:${part.text}`)),
    ['text:a', 'system-notice', 'text:b', 'system-reminder', 'text:c'],
  )
})

test('a block that is never closed stays the text it was', () => {
  // An unclosed tag is not a block: the reader sees the engine's own line, brackets and all, rather
  // than a card that swallowed the rest of the message.
  const parts = splitSystemNotices('<system-notice>\nnever closed, this is prose')

  assert.deepEqual(parts, [{ kind: 'text', text: '<system-notice>\nnever closed, this is prose' }])
})

test('an unclosed opening tag is swallowed by the block that follows it', () => {
  // The reading the Vue front end makes, kept here rather than invented again: the pattern runs from
  // the *first* opening tag to the first matching close, so the unclosed tag lands inside the block.
  const parts = splitSystemNotices('<system-notice>first\n<system-notice>second</system-notice>')

  assert.equal(parts.length, 1)
  const [part] = notices('<system-notice>first\n<system-notice>second</system-notice>')
  assert.equal(part.text, 'first\n<system-notice>second')
  assert.equal(part.delivery, null)
})

test('a task-result outside a delivery is not a delivery', () => {
  // A message *about* one of these deliveries — a transcript pasted into the conversation, an answer
  // quoting the element it saw — is prose, and the delivery reading has to leave it alone.
  assert.equal(
    parseJobDelivery('here is the element I saw: <task-result id="x" status="completed" />\nnothing else'),
    null,
  )
  assert.equal(
    parseJobDelivery(
      '<system-notice>\nhere is the element I saw: <task-result id="x" status="completed" />\nnothing else\n</system-notice>',
    ),
    null,
  )
  // The block is still a block: it draws as a notice, with no delivery in it.
  assert.deepEqual(notices('<system-notice>\njust a nudge\n</system-notice>'), [
    { kind: 'notice', tag: 'system-notice', text: 'just a nudge', delivery: null, irc: null },
  ])
})

test('a delivery headline that is quoted mid-sentence is not a delivery', () => {
  assert.equal(parseJobDelivery('the engine writes\nBackground job x has completed.\nthat is the headline'), null)
})

test('a headline with nothing under it is not a delivery', () => {
  assert.equal(parseJobDelivery('Background job x has completed.'), null)
  assert.equal(parseJobDelivery('<system-notice>\nBackground job x has completed.\n</system-notice>'), null)
})

test('a notice that is not a delivery keeps the block’s own reading', () => {
  // An aside, an advisor card, a nudge: the wrapper is the whole structure, and the frame around it
  // is what the reader gets.
  const [part] = notices('<system-notice>\nYou have been idle for a while.\n</system-notice>')

  assert.equal(part.delivery, null)
  assert.equal(part.text, 'You have been idle for a while.')
})

test('a task-result with no attributes leaves every field empty rather than dropping the job', () => {
  const parsed = delivery(
    '<system-notice>\nBackground job JobAlpha has completed. Resume.\n<task-result>\n<output>plain</output>\n</task-result>\nJobAlpha is now idle.\n</system-notice>',
  )

  assert.equal(parsed.summary, 'Background job JobAlpha has completed. Resume.')
  assert.equal(parsed.jobs.length, 1)
  // The element is the only thing that can name the job, and this one has no `id` — so the job has
  // no name, rather than being named after the headline that sits above it as the summary.
  assert.equal(parsed.jobs[0].id, '')
  assert.equal(parsed.jobs[0].agent, '')
  assert.equal(parsed.jobs[0].status, '')
  assert.equal(parsed.jobs[0].duration, '')
  assert.equal(parsed.jobs[0].abortReason, null)
  assert.equal(parsed.jobs[0].output, 'plain')
  assert.equal(parsed.jobs[0].meta, null)
  assert.equal(parsed.jobs[0].note, 'JobAlpha is now idle.')
})

test('an empty output block answers an empty output, not its whitespace', () => {
  const parsed = delivery(
    '<system-notice>\nBackground job JobBeta has completed.\n<task-result id="JobBeta" agent="sonic" status="cancelled" duration="0.4s">\n<meta lines="1" size="0B" />\n<output></output>\n</task-result>\nJobBeta is now idle.\n</system-notice>',
  )

  assert.equal(parsed.jobs[0].output, '')
  assert.equal(parsed.jobs[0].meta, 'lines=1 size=0B')
  // Whitespace inside the element is not a payload either.
  const blank = delivery(
    'Background job J has completed.\n<task-result id="J">\n<output>   \n  </output>\n</task-result>',
  )
  assert.equal(blank.jobs[0].output, '')
})

test('a batch of jobs is read apart by its separators, in either dash form', () => {
  const boxed = delivery(`<system-notice>
3 background jobs have completed.
── Job BackendScout (BackendScout) ──
<task-result id="BackendScout" agent="sonic" status="completed" duration="12.7s">
<meta lines="1" size="0B" />
<output></output>
</task-result>
── Job bg_17 ──
$ ls -la
total 3
── Job bg_18 ──
Background job bg_18 has completed. Nothing else to say.
</system-notice>`)

  assert.equal(boxed.summary, '3 background jobs have completed.')
  assert.deepEqual(
    boxed.jobs.map((job) => job.id),
    ['BackendScout', 'bg_17', 'bg_18'],
  )
  // A job the engine wrote without an element carries nothing but its result.
  assert.equal(boxed.jobs[1].status, '')
  assert.equal(boxed.jobs[1].output, '$ ls -la\ntotal 3')
  assert.equal(boxed.jobs[2].output, 'Background job bg_18 has completed. Nothing else to say.')

  const ascii = delivery(`Background jobs completed.
-- Job bg_1 (sonic) --
<task-result status="failed">
<abort-reason>timed out after 30s</abort-reason>
<output>boom</output>
</task-result>
-- Job bg_2 --
plain shell output`)

  assert.equal(ascii.summary, 'Background jobs completed.')
  assert.deepEqual(
    ascii.jobs.map((job) => job.id),
    ['bg_1', 'bg_2'],
  )
  // The separator's own name is the fallback when the element carries no `id` of its own.
  assert.equal(ascii.jobs[0].id, 'bg_1')
  assert.equal(ascii.jobs[0].status, 'failed')
  assert.equal(ascii.jobs[0].abortReason, 'timed out after 30s')
  assert.equal(ascii.jobs[0].output, 'boom')
  assert.equal(ascii.jobs[1].output, 'plain shell output')
})

test('a background shell with no element is its own output', () => {
  const parsed = delivery(SHELL_DELIVERY)

  assert.equal(parsed.summary, 'Background job bg_18 has completed.')
  assert.equal(parsed.jobs.length, 1)
  assert.equal(parsed.jobs[0].id, 'bg_18')
  assert.equal(parsed.jobs[0].agent, '')
  assert.equal(parsed.jobs[0].status, '')
  assert.equal(parsed.jobs[0].duration, '')
  assert.equal(parsed.jobs[0].meta, null)
  assert.equal(parsed.jobs[0].output, '$ echo hi\nhi')
  assert.equal(parsed.jobs[0].note, '')

  // The same delivery wrapped in a notice reads the same: the wrapper is stripped before the reading
  // starts, which is why a single-job delivery may arrive with or without it.
  assert.deepEqual(delivery(`<system-notice>\n${SHELL_DELIVERY}\n</system-notice>`), parsed)
})

test('the closing sentence is read with the code spans the engine wrote in backticks', () => {
  const [job] = delivery(TASK_DELIVERY).jobs

  assert.equal(
    job.note,
    'ContentEgret is now idle — message it via `write agent://ContentEgret` to follow up; transcript at history://ContentEgret',
  )
  assert.deepEqual(job.noteSpans, [
    { kind: 'text', text: 'ContentEgret is now idle — message it via ' },
    { kind: 'code', text: 'write agent://ContentEgret' },
    { kind: 'text', text: ' to follow up; transcript at history://ContentEgret' },
  ])
})

test('a delivery inside a wrapper is read with the block that carries it', () => {
  // What the notice card branches on: the block is read once, and the delivery comes with it.
  const parts = splitSystemNotices(TASK_DELIVERY)

  assert.equal(parts.length, 1)
  const [notice] = notices(TASK_DELIVERY)
  assert.equal(notice.tag, 'system-notice')
  assert.equal(notice.delivery?.summary, 'Background job ContentEgret has completed. Resume your work using the result below.')
  const [job] = notice.delivery.jobs
  assert.equal(job.id, 'ContentEgret')
  assert.equal(job.agent, 'sonic')
  assert.equal(job.status, 'completed')
  assert.equal(job.duration, '5.2s')
  assert.equal(job.meta, 'lines=4 size=43B')
  assert.equal(job.output, '{ "file": "package.json", "lines": 40 }')
  assert.equal(job.abortReason, null)
})

test('the fence a preview introduces is dropped from the note, and the path it named kept', () => {
  // An empty payload drawn as an empty code card is what this reading exists to stop. The `preview:`
  // line only leaves with the fence when the fence was the last thing the engine wrote; when more
  // text follows it the word survives, which is the Vue front end's reading too.
  const [job] = delivery(
    '<system-notice>\nBackground job JobGamma has completed.\n<task-result id="JobGamma" status="completed">\n<output>{"ok":true}</output>\n</task-result>\npreview:\n```json\n{}\n```\nJobGamma is now idle — message it via `write agent://JobGamma`.\n</system-notice>',
  ).jobs

  assert.equal(job.output, '{"ok":true}')
  assert.equal(job.note, 'preview:\nJobGamma is now idle — message it via `write agent://JobGamma`.')
  assert.deepEqual(job.noteSpans, [
    { kind: 'text', text: 'preview:\nJobGamma is now idle — message it via ' },
    { kind: 'code', text: 'write agent://JobGamma' },
    { kind: 'text', text: '.' },
  ])
})

test('a block the engine wrapped around nothing carries no body', () => {
  assert.deepEqual(splitSystemNotices('<system-notice></system-notice>'), [
    { kind: 'notice', tag: 'system-notice', text: '', delivery: null, irc: null },
  ])
  assert.deepEqual(notices('<system-notice>\n</system-notice>'), [
    { kind: 'notice', tag: 'system-notice', text: '', delivery: null, irc: null },
  ])
})

test('a message with no block at all is one text part, untouched', () => {
  // Byte for byte: a caller that finds no block draws the message exactly as it always did, so the
  // reading cannot trim a message it is not going to redraw.
  assert.deepEqual(splitSystemNotices('plain prose'), [{ kind: 'text', text: 'plain prose' }])
  assert.deepEqual(splitSystemNotices('  hi\n\n'), [{ kind: 'text', text: '  hi\n\n' }])
  assert.deepEqual(splitSystemNotices('   \n\t  '), [{ kind: 'text', text: '   \n\t  ' }])
  assert.deepEqual(splitSystemNotices(''), [])
})

test('hasSystemNotices answers for the blocks a message actually has', () => {
  assert.equal(hasSystemNotices('<system-notice>x</system-notice>'), true)
  assert.equal(hasSystemNotices('a\n<system-reminder>x</system-reminder>'), true)
  assert.equal(hasSystemNotices('just prose'), false)
  assert.equal(hasSystemNotices('<system-notice>never closed'), false)
  assert.equal(hasSystemNotices(''), false)
})

test('an irc envelope is read as the peer message it carries', () => {
  // The engine's own template, byte for byte (`prompts/system/irc-incoming.md`): the header, the
  // peer's words, the interrupt notice, and the instruction about how to answer. Only the peer's
  // words and the fact that it interrupted are the reader's business.
  const parts = splitSystemNotices(`<irc>
Incoming IRC message from agent \`activate-ui-2\`:

Restored enginePluginProcess + enginePluginProcessRestart.

Sent while waiting/working. Active interruptible wait stopped early for immediate reading.

If response expected, reply via \`write\` (\`path: "agent://activate-ui-2"\`, \`content: "…"\`); may finish current step first. No one replies on your behalf.
</irc>`)

  assert.equal(parts.length, 1)
  const [part] = notices(`<irc>
Incoming IRC message from agent \`activate-ui-2\`:

Restored enginePluginProcess + enginePluginProcessRestart.

Sent while waiting/working. Active interruptible wait stopped early for immediate reading.

If response expected, reply via \`write\` (\`path: "agent://activate-ui-2"\`, \`content: "…"\`); may finish current step first. No one replies on your behalf.
</irc>`)
  assert.equal(part.tag, 'irc')
  assert.equal(part.delivery, null)
  assert.deepEqual(part.irc, {
    from: 'activate-ui-2',
    replyTo: null,
    body: 'Restored enginePluginProcess + enginePluginProcessRestart.',
    interrupting: true,
  })
})

test('a reply and the relay-on-stop instruction are read off the same envelope', () => {
  const [part] = notices(`<irc>
Incoming IRC message from agent \`worker-1\` (reply to msg-42):

Done — the migration is applied.

If response expected, reply via \`write\` (\`path: "agent://worker-1"\`, \`content: "…"\`), when available; otherwise what you \`yield\` or say last this turn is delivered to \`worker-1\` when you stop.
</irc>`)

  assert.equal(part.irc?.from, 'worker-1')
  assert.equal(part.irc?.replyTo, 'msg-42')
  assert.equal(part.irc?.body, 'Done — the migration is applied.')
  // The engine writes that sentence only for a turn that was not streaming, so nothing interrupted.
  assert.equal(part.irc?.interrupting, false)
})

test('a peer message that quotes an instruction keeps it', () => {
  // The engine's sentences only leave from a paragraph of their own at the envelope's ends; a peer
  // writing about one is quoting it, and a quotation is the peer's words.
  const [part] = notices(`<irc>
Incoming IRC message from agent \`peer\`:

Sent while waiting/working. Active interruptible wait stopped early for immediate reading.

That sentence is what the engine writes when it cuts in.
</irc>`)

  // The quoted sentence is its own paragraph, so it is read as the engine's — the shape is the
  // shape, and a peer cannot make the card say something the envelope does not.
  assert.equal(part.irc?.interrupting, true)
  assert.equal(part.irc?.body, 'That sentence is what the engine writes when it cuts in.')
})

test('an irc block whose first line is not the header stays text the card can still draw', () => {
  const [part] = notices('<irc>\nsomething else entirely\n</irc>')

  assert.equal(part.tag, 'irc')
  // No sender and no body were read, so the caller draws the block's own text rather than a card
  // claiming a peer said something it never said.
  assert.equal(part.irc, null)
  assert.equal(part.text, 'something else entirely')
})

test("the escapes the engine put on a peer's words come back off", () => {
  // The body is agent-authored, so the engine escapes the `<` of every harness tag in it before
  // wrapping it (`harness-tags.ts`). The reader is not the model: `&lt;irc>` in a peer's sentence is
  // that peer writing about the tag, not an entity the card should quote.
  const [part] = notices(`<irc>
Incoming IRC message from agent \`peer\`:

I tried a &lt;system-notice> of my own and it was ignored. Nothing about &lt;b>bold&lt;/b> changed.
</irc>`)

  assert.equal(
    part.irc?.body,
    'I tried a <system-notice> of my own and it was ignored. Nothing about &lt;b>bold&lt;/b> changed.',
  )
})

test('an emphasized line is read as a block of the message’s own words', () => {
  // A model marks a line it wants read as more than prose by wrapping it in `<important>`. The tag
  // is the model's, not the engine's: no delivery and no peer message is read out of it, and the
  // body is what the message says.
  const parts = splitSystemNotices('<important>\nthe stop path matches the terminal\n</important>')

  assert.deepEqual(parts, [
    { kind: 'notice', tag: 'important', text: 'the stop path matches the terminal', delivery: null, irc: null },
  ])
})

test('a closing tag written twice belongs to the one block it closes', () => {
  // Real output: the model closed the tag, then closed it again on the next line. The repeats are
  // whitespace apart, so they are the block's own punctuation — the reader is shown the words, not
  // a second `</important>`.
  const parts = splitSystemNotices(
    '<important>\n循环停止路径已经与 TUI 一致。\n</important>\n</important>',
  )

  assert.equal(parts.length, 1)
  const [part] = notices('<important>\nthe paths agree\n</important>\n</important>')
  assert.equal(part.text, 'the paths agree')
})

test('a tag written mid-sentence is prose about the tag, not a block', () => {
  // The block opens at the start of a line; a sentence naming one is the reader's own text.
  const text = 'prose about a `<important>` block stays prose'
  assert.deepEqual(splitSystemNotices(text), [{ kind: 'text', text }])
})

test('an emphasized block that is never closed stays the text it was', () => {
  const text = '<important>\nnever closed, this is prose'
  assert.deepEqual(splitSystemNotices(text), [{ kind: 'text', text }])
})

test('a message’s prose keeps an emphasized block’s words and drops the engine’s wrappers', () => {
  // The two wrapper kinds are opposite: a reminder is context around the message and leaves the
  // prose, while an emphasized block *is* the prose with a tag on it.
  assert.equal(
    messageProse(
      'first\n<system-reminder>be brief</system-reminder>\n<important>the paths agree</important>\nlast',
    ),
    'first\n\nthe paths agree\n\nlast',
  )
})

test('every emphasis tag outside code is punctuation, and code keeps what it quotes', () => {
  // A block still being written (opener, no closer), a closer with no opener, and a pair written
  // inline in a sentence — three shapes, one fact: the tag is markup, not words.
  assert.equal(
    stripModelTags('a finding\n<important>\nthe words so far'),
    'a finding\nthe words so far',
  )
  assert.equal(stripModelTags('the words\n</important>\nafter'), 'the words\nafter')
  assert.equal(
    stripModelTags('inline <important>the point</important> of it'),
    'inline the point of it',
  )
  // Code is an example of the markup, not markup: a span and a fence keep the tag they show.
  const span = 'prose about a `<important>` block stays prose'
  assert.equal(stripModelTags(span), span)
  const fence = '```\n<important>\nx\n</important>\n```'
  assert.equal(stripModelTags(fence), fence)
})

test('a block still arriving reads as its words until its closer arrives', () => {
  const streaming = 'the stop path is done\n<important>\nnext: check plan mode'
  assert.deepEqual(splitSystemNotices(streaming), [{ kind: 'text', text: streaming }])
  assert.equal(stripModelTags(streaming), 'the stop path is done\nnext: check plan mode')
  // …and the same message once the closer lands is a block, whose body the card draws.
  const [part] = notices(`${streaming}\n</important>`)
  assert.equal(part.tag, 'important')
  assert.equal(part.text, 'next: check plan mode')
})

test('a prompt typed with the tag inline reads as its sentence', () => {
  // The reported shape: the reader wrapped a sentence in the tag on one line, so nothing reads it
  // as a block — and the bubble they typed into must not show the brackets either.
  const prompt = 'important未用beui适配输出 <important> 循环停止路径已经与 TUI 一致。 </important> </important>'
  assert.deepEqual(splitSystemNotices(prompt), [{ kind: 'text', text: prompt }])
  const prose = messageProse(prompt)
  assert.ok(!prose.includes('important>'))
  assert.equal(prose.trim(), 'important未用beui适配输出 循环停止路径已经与 TUI 一致。')
})

/** The shape measured on 2026-11-08: the answer inside `<final>`, the opener on its own line. */
const FINAL_ANSWER = `<final>
答案已经给完，没有待执行的工具动作。

结论汇总：

1. 证书路线关闭。
2. 改形态 + 报哈希白名单。 </final>`

test('the envelope a model wraps its answer in is unwrapped, never framed', () => {
  // The model closes the envelope inline at the end of the last line, so the closer takes the blank
  // before it and nothing else. No block is read: the message body already frames the answer, and a
  // card would draw a second frame around the whole bubble to say what the bubble says.
  assert.deepEqual(splitSystemNotices(FINAL_ANSWER), [{ kind: 'text', text: FINAL_ANSWER }])
  assert.equal(
    stripModelTags(FINAL_ANSWER),
    '答案已经给完，没有待执行的工具动作。\n\n结论汇总：\n\n1. 证书路线关闭。\n2. 改形态 + 报哈希白名单。',
  )
  // A copy reads the same words: `messageProse` drops the wrappers and keeps the body.
  assert.equal(
    messageProse(FINAL_ANSWER),
    '答案已经给完，没有待执行的工具动作。\n\n结论汇总：\n\n1. 证书路线关闭。\n2. 改形态 + 报哈希白名单。',
  )
})

test('the answer envelope is read off whether it is closed or still arriving', () => {
  // The opener reaches the bubble before the answer does; the line goes with its break and the
  // words read as prose from the first frame.
  assert.equal(stripModelTags('<final>\n答案写到一半'), '答案写到一半')
  // A closer whose opener the provider's stream cut is the same markup: the words stay.
  assert.equal(stripModelTags('答案已经给完。\n</final>'), '答案已经给完。\n')
  // Code keeps what it quotes, the same exemption every model tag has.
  const fence = '```\n<final>\nx\n</final>\n```'
  assert.equal(stripModelTags(fence), fence)
})

/** The shape a "think, then summarise" answer arrives in: analysis, then the summary. */
const ANALYSIS_AND_SUMMARY = `<analysis>
让我按时间顺序分析这段对话。
</analysis>
<summary>
1. **主要请求和意图：** 把规则改成英文。
</summary>`

test('the analysis and the summary a model names are two blocks of its own words', () => {
  const parts = splitSystemNotices(ANALYSIS_AND_SUMMARY)

  assert.deepEqual(parts, [
    {
      kind: 'notice',
      tag: 'analysis',
      text: '让我按时间顺序分析这段对话。',
      delivery: null,
      irc: null,
    },
    {
      kind: 'notice',
      tag: 'summary',
      text: '1. **主要请求和意图：** 把规则改成英文。',
      delivery: null,
      irc: null,
    },
  ])
  // Both bodies are the message's words: a rail card about this answer reads them, not its label.
  assert.equal(
    messageProse(ANALYSIS_AND_SUMMARY),
    '让我按时间顺序分析这段对话。\n\n1. **主要请求和意图：** 把规则改成英文。',
  )
})

test('a section tag pair with nothing between them leaves no empty paragraph', () => {
  // The moment an answer is between sections: the closer of one and the opener of the next, on
  // their own lines. Neither is words, and neither leaves a gap where it stood.
  const between = '现在我将撰写摘要。\n</analysis>\n<summary>\n1. 主要请求和意图：'
  assert.equal(stripModelTags(between), '现在我将撰写摘要。\n1. 主要请求和意图：')
})

/** A `task` result the engine cut short: a preview instead of an output, and where the rest lives. */
const TRUNCATED_TASK = `<system-notice>
Background job RustSlice has completed. Resume your work using the result below.
<task-result id="RustSlice" agent="task" status="completed" duration="12m35s">
<meta lines="88" size="8.2KB" />
<preview full-output="agent://RustSlice">
{ "status": "complete", "summary": "Implemented the Rust slice" }
</preview>
</task-result>
RustSlice is now idle — message it via \`write agent://RustSlice\` to follow up.
</system-notice>`

test('a truncated task result draws its preview and names the path of the whole one', () => {
  // Over the engine's ceiling the element is a `<preview full-output="agent://ID">` rather than an
  // `<output>`; the head of the payload is what the card can draw and the path is the rest of it.
  const [job] = delivery(TRUNCATED_TASK).jobs

  assert.equal(job.id, 'RustSlice')
  assert.equal(job.output, '{ "status": "complete", "summary": "Implemented the Rust slice" }')
  assert.equal(job.fullOutput, 'agent://RustSlice')
  assert.equal(job.error, null)
  // Neither element is left as angle brackets in the closing sentences beside the card.
  assert.ok(!job.note.includes('<preview'))
  assert.ok(!job.note.includes('</preview>'))
})

test('a failed task carries its own sentence, and the merge summary stays words', () => {
  const failed = delivery(`Background job ReviewBeta has completed.
<task-result id="ReviewBeta" agent="task" status="failed" duration="0.4s">
<error>the review subagent exited with code 2</error>
<output>partial notes</output>
<merge-summary>
Merged into ReviewAlpha's result.
</merge-summary>
</task-result>`)

  const [job] = failed.jobs
  assert.equal(job.error, 'the review subagent exited with code 2')
  assert.equal(job.output, 'partial notes')
  assert.equal(job.fullOutput, null)
  // The merge summary is a sentence about what happened to the result: it is the note, minus its
  // wrapper.
  assert.equal(job.note, "Merged into ReviewAlpha's result.")
  assert.deepEqual(job.noteSpans, [{ kind: 'text', text: "Merged into ReviewAlpha's result." }])
})

/** The bubble's own reading: a call the model appended to its answer is markup, not words. */
test('a call written as markup is not one of the answer’s words', () => {
  const answer = '已完成，分支留在本地。\n\n<ask i="Confirming merge" questions="[{"id": "merge"}]'
  assert.equal(stripModelTags(answer), '已完成，分支留在本地。\n\n')
  // The two vocabularies are stripped together, whichever order they were written in.
  assert.equal(
    stripModelTags('<final>结论：可以。</final>\n<read i="Reading" path="a.ts"/>'),
    '结论：可以。\n',
  )
})

/** A model tag's body is words, and the markup inside it is still markup. */
test('a model tag’s body is stripped like the prose around it', () => {
  const answer = '<important>先看 <ask i="x" questions="[1]"/> 再决定</important>'
  assert.equal(messageProse(answer), '先看 再决定')
  assert.equal(stripModelTags('先看 <ask i="x" questions="[1]"/> 再决定'), '先看 再决定')
})

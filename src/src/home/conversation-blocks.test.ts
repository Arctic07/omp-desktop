import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BackgroundJob, TodoPhase } from '../api/session-types.ts'
import { blockLabel, composerBlocks, resolveOpenBlock } from './conversation-blocks.ts'

/**
 * The row over the composer's field: which blocks it draws, and which of them is open.
 *
 * What is pinned down here is what the reader can see: a block exists only when the engine reported
 * it (a phase with no tasks is not a block, and neither is a plan nobody mentioned), a phase's own
 * readings come from its tasks rather than from a count this side keeps, and opening one is the
 * reader's doing alone — one at a time, and never for a block the row no longer shows.
 */

const JOB: BackgroundJob = { id: 'job-1', type: 'bash', label: 'npm run build', startedAt: 1_700 }

test('an engine that has reported nothing draws no row at all', () => {
  assert.deepEqual(composerBlocks(undefined, []), [])
  assert.deepEqual(composerBlocks([], []), [])
})

test('a phase with no tasks in it is not a block', () => {
  const phases: TodoPhase[] = [
    { name: '计划', tasks: [] },
    { name: '当前进度', tasks: [{ content: '写代码', status: 'in_progress' }] },
  ]

  const blocks = composerBlocks(phases, [])

  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.kind === 'plan' && blocks[0].name, '当前进度')
})

test('a phase reads as its own name and its own count, with the engine statuses as the list draws them', () => {
  const phases: TodoPhase[] = [
    {
      name: '当前进度',
      tasks: [
        { content: '写代码', status: 'completed' },
        { content: '跑测试', status: 'unknown' },
        { content: '看日志', status: 'abandoned' },
        { content: '写报告', status: 'in_progress' },
      ],
    },
  ]

  const [block] = composerBlocks(phases, [])
  assert.equal(block?.kind, 'plan')
  assert.equal(block?.kind === 'plan' ? block.completed : -1, 1)
  assert.equal(block?.kind === 'plan' ? block.total : -1, 4)
  assert.deepEqual(
    block?.kind === 'plan' ? block.items.map((item) => item.status) : [],
    // A status this build does not know is a task nobody has started yet as far as the list can
    // tell, and `abandoned` is one nobody will: the list has a pending mark and a cancelled one.
    ['completed', 'pending', 'cancelled', 'in-progress'],
  )
})

test('the detached work follows the plan as one roster block, not one block per job', () => {
  const phases: TodoPhase[] = [{ name: '计划', tasks: [{ content: '写代码', status: 'pending' }] }]
  const second: BackgroundJob = { ...JOB, id: 'job-2', type: 'task' }

  const blocks = composerBlocks(phases, [JOB, second])

  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['plan', 'jobs'],
  )
  const roster = blocks[1]
  assert.equal(roster?.kind === 'jobs' ? roster.id : '', 'background-jobs')
  // The panel behind the tab reads the engine's own rows, in the engine's own order.
  assert.deepEqual(
    roster?.kind === 'jobs' ? roster.jobs.map((job) => job.id) : [],
    ['job-1', 'job-2'],
  )
})

test('the jobs block exists only while something is running', () => {
  assert.deepEqual(composerBlocks(undefined, [JOB]).map((block) => block.kind), ['jobs'])
  assert.deepEqual(composerBlocks(undefined, []), [])
})

test('one block is open at a time, and only the one the reader opened', () => {
  const phases: TodoPhase[] = [
    { name: '计划', tasks: [{ content: '写代码', status: 'pending' }] },
    { name: '当前进度', tasks: [{ content: '跑测试', status: 'pending' }] },
  ]
  const blocks = composerBlocks(phases, [JOB])
  const [plan, second] = blocks

  assert.equal(resolveOpenBlock(blocks, null), null)
  assert.equal(resolveOpenBlock(blocks, plan?.id ?? ''), plan?.id)
  // A second click is the same single choice, so the first block is no longer open.
  assert.equal(resolveOpenBlock(blocks, second?.id ?? ''), second?.id)
  assert.equal(resolveOpenBlock(blocks, 'background-jobs'), 'background-jobs')
})

test('a block that is gone is not left open', () => {
  const phases: TodoPhase[] = [{ name: '计划', tasks: [{ content: '写代码', status: 'pending' }] }]
  const withBlock = composerBlocks(phases, [JOB])
  const planId = withBlock[0]?.id ?? ''

  // The phase emptied out: it is not a block any more, so there is no panel to stand over the field.
  assert.equal(resolveOpenBlock(composerBlocks([{ name: '计划', tasks: [] }], [JOB]), planId), null)
  // The last job ended: the engine's next snapshot drops the roster, and the panel goes with it.
  assert.equal(resolveOpenBlock(composerBlocks(phases, []), 'background-jobs'), null)
  assert.equal(resolveOpenBlock(composerBlocks(phases, []), planId), planId)
})

test('a block is named in the reader’s words', () => {
  const words = {
    jobs: '后台任务',
    plan: '计划',
    goal: '目标',
    planMode: '计划模式',
    vibe: 'Vibe',
    loop: '循环',
    btw: '侧问',
  }
  const [plan, jobs] = composerBlocks(
    [{ name: '当前进度', tasks: [{ content: '写代码', status: 'pending' }] }],
    [JOB, { ...JOB, id: 'job-2', type: 'eval' }],
  )

  assert.equal(blockLabel(plan!, words), '当前进度')
  assert.equal(blockLabel(jobs!, words), '后台任务')
  // A phase the engine left unnamed falls back to this side's own word for a plan.
  const [unnamed] = composerBlocks([{ name: '', tasks: [{ content: '写代码', status: 'pending' }] }], [])
  assert.equal(blockLabel(unnamed!, words), '计划')
})

test('a phase the engine named for itself reads as a plan, not as the subagent tool', () => {
  const words = {
    jobs: '后台任务',
    plan: '计划',
    goal: '目标',
    planMode: '计划模式',
    vibe: 'Vibe',
    loop: '循环',
    btw: '侧问',
  }
  // A flattened `todo` init carries the engine's own placeholder (`DEFAULT_INIT_PHASE`). Drawn as a
  // title it says `Tasks` — the word this desktop uses for the `task` tool's children — over a todo
  // list, so it is drawn as unnamed instead.
  const [flat] = composerBlocks(
    [{ name: 'Tasks', tasks: [{ content: '写代码', status: 'pending' }] }],
    [],
  )
  assert.equal(blockLabel(flat!, words), '计划')
  // A phase the model did name is still the engine's own stage, drawn verbatim.
  const [named] = composerBlocks(
    [{ name: '验证', tasks: [{ content: '跑测试', status: 'pending' }] }],
    [],
  )
  assert.equal(blockLabel(named!, words), '验证')
})

test('the modes the conversation is in lead the row, and only while they are on', () => {
  const modes = {
    goal: {
      enabled: true,
      status: 'active',
      objective: 'ship it',
      tokensUsed: 10,
      tokenBudget: null,
      timeUsedSeconds: 3,
    },
    plan: { planFilePath: 'local://PLAN.md' },
    vibe: { workers: [] },
  }
  const withModes = composerBlocks(undefined, [], modes)
  assert.deepEqual(
    withModes.map((block) => block.id),
    ['goal', 'plan-mode', 'vibe'],
  )
  // Planning phases and detached work come after the modes: they are what the conversation is
  // doing, not what it is.
  const withWork = composerBlocks(
    [{ name: '当前进度', tasks: [{ content: '写代码', status: 'pending' }] }],
    [JOB],
    modes,
  )
  assert.deepEqual(
    withWork.map((block) => block.kind),
    ['goal', 'planMode', 'vibe', 'plan', 'jobs'],
  )
  // A mode going off removes its block, and an open panel for it closes with it.
  assert.equal(resolveOpenBlock(composerBlocks(undefined, [], {}), 'goal'), null)
})

test('a side question is a block of its own, last in the row', () => {
  const words = {
    jobs: '后台任务',
    plan: '计划',
    goal: '目标',
    planMode: '计划模式',
    vibe: 'Vibe',
    loop: '循环',
    btw: '侧问',
  }
  const blocks = composerBlocks(undefined, [], {}, { question: 'where?', answer: 'there', status: 'running' })
  assert.equal(blocks.at(-1)?.kind, 'btw')
  assert.equal(blockLabel(blocks.at(-1)!, words), '侧问')
  // No side question, no block: its existence is the engine's record, not a placeholder.
  assert.deepEqual(composerBlocks(undefined, [], {}, null), [])
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BackgroundJob, SubagentRow } from '../api/session-types.ts'
import type { ToolMessage } from './conversation-rows.ts'
import { rosterOf, taskRowStatus } from './task-roster.ts'

/**
 * The status a child's roster row draws, when the two rosters disagree.
 *
 * A `task` call can answer while its children keep working, and either side of the merge can be
 * the stale one. The reader's complaint was a row that kept saying "running" beside a completed
 * call; these pin the rules that decide which word wins.
 */

function taskMessage(
  state: string,
  children: Array<{ id: string; status: string }>,
): ToolMessage {
  return {
    kind: 'tool',
    id: 't1',
    at: 1,
    toolCallId: 'call-1',
    name: 'task',
    state,
    argsText: '{}',
    resultText: '',
    startedAt: null,
    endedAt: null,
    intent: null,
    details: {
      subagents: children.map((child) => ({
        id: child.id,
        agent: 'scout',
        description: `child ${child.id}`,
        status: child.status,
        exitCode: child.status === 'completed' ? 0 : 1,
        durationMs: 0,
        tokens: 0,
      })),
    },
  }
}

function liveSubagent(id: string, status: string): SubagentRow {
  return {
    id,
    agent: 'scout',
    index: 0,
    parentToolCallId: null,
    detached: true,
    status,
    description: null,
    assignment: null,
    toolCount: null,
    currentTool: null,
    currentToolArgs: null,
    lastIntent: null,
    model: null,
    tokens: null,
    durationMs: null,
    startedAt: 0,
    recentTools: [],
    recentOutput: [],
  }
}

function taskJob(id: string): BackgroundJob {
  return { id, type: 'task', label: id, startedAt: 1 }
}

test('a finished call with no running job no longer reports its child as running', () => {
  const message = taskMessage('success', [{ id: 'child-1', status: 'running' }])
  const rows = rosterOf(message, { 'child-1': liveSubagent('child-1', 'running') }, [])
  assert.equal(rows[0]?.status, 'unknown')
})

test('a detached child the host still lists as a running job stays running', () => {
  const message = taskMessage('success', [{ id: 'child-1', status: 'running' }])
  const rows = rosterOf(
    message,
    { 'child-1': liveSubagent('child-1', 'running') },
    [taskJob('child-1')],
  )
  assert.equal(rows[0]?.status, 'running')
})

test('an ending from either roster outranks a running word', () => {
  const message = taskMessage('success', [{ id: 'child-1', status: 'completed' }])
  const rows = rosterOf(
    message,
    { 'child-1': liveSubagent('child-1', 'running') },
    [taskJob('child-1')],
  )
  assert.equal(rows[0]?.status, 'completed')
})

test('a call still in flight keeps a foreground child it never listed as a job', () => {
  const message = taskMessage('running', [{ id: 'child-1', status: 'running' }])
  const rows = rosterOf(message, { 'child-1': liveSubagent('child-1', 'running') }, [])
  assert.equal(rows[0]?.status, 'running')
})

test('a live child the call result has not mentioned yet still gets its row', () => {
  const message = taskMessage('running', [])
  const child = { ...liveSubagent('child-9', 'running'), parentToolCallId: 'call-1' }
  const rows = rosterOf(message, { 'child-9': child }, [])
  assert.deepEqual(
    rows.map((row) => row.id),
    ['child-9'],
  )
})

test('a child of another call is not drawn on this card', () => {
  const message = taskMessage('running', [])
  const other = { ...liveSubagent('child-2', 'running'), parentToolCallId: 'call-2' }
  const rows = rosterOf(message, { 'child-2': other }, [])
  assert.deepEqual(rows, [])
})

/**
 * What the call's own row states, when the batch under it ends differently from the call.
 *
 * A detached `task` answers in milliseconds and its children work — or are stopped — afterwards,
 * so the badge has to follow them. The reader's report was a card reading 已完成 beside a roster
 * they had just aborted.
 */

function rowStatusOf(state: string, children: Array<{ id: string; status: string }>, jobs: BackgroundJob[] = []) {
  return taskRowStatus(state as 'running' | 'success' | 'error', rosterOf(taskMessage(state, children), {}, jobs))
}

test('a batch the reader stopped states cancelled, not the success its call returned', () => {
  assert.equal(rowStatusOf('success', [{ id: 'child-1', status: 'aborted' }]), 'cancelled')
})

test('a batch whose child failed states failed', () => {
  assert.equal(rowStatusOf('success', [{ id: 'child-1', status: 'failed' }]), 'error')
})

test('a batch that ended cleanly keeps the call’s own success', () => {
  assert.equal(rowStatusOf('success', [{ id: 'child-1', status: 'completed' }]), 'success')
})

test('a failure outranks an abort in the same batch', () => {
  assert.equal(
    rowStatusOf('success', [
      { id: 'child-1', status: 'aborted' },
      { id: 'child-2', status: 'failed' },
    ]),
    'error',
  )
})

test('a call that failed keeps its failure whatever the roster says', () => {
  assert.equal(rowStatusOf('error', [{ id: 'child-1', status: 'completed' }]), 'error')
})

test('a child still working keeps the row running after the call answered', () => {
  const message = taskMessage('success', [{ id: 'child-1', status: 'running' }])
  const rows = rosterOf(message, { 'child-1': liveSubagent('child-1', 'running') }, [taskJob('child-1')])
  assert.equal(taskRowStatus('success', rows), 'running')
})

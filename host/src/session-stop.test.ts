import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { test } from 'node:test'

import { USER_INTERRUPT_LABEL } from './constants.ts'
import { cancellableCounts, isWorking, stopSession } from './session-stop.ts'
import type { LiveSession } from './sessions.ts'
import type { SdkBundle } from './sdk.ts'

/**
 * What a stop has to see, as the engine's own bookkeeping.
 *
 * The case under test is the one this host used to answer "nothing to stop" to (2026-10-27, user
 * report: sixteen presses of a stop that never ended the session). A background job keeps running
 * while its result can no longer wake the session - an acknowledged or watched delivery is
 * suppressed - so `hasPendingAsyncWork()` is false with a job still on the manager. The state frame
 * publishes every running job as `backgroundJobs`, the screen draws a stop for one, and the stop has
 * to act on it: the busy fact and the cancel are the same set.
 */

/** One running job, as the manager's `getRunningJobs` answers it. */
interface StubJob {
  readonly id: string
  readonly type: string
  readonly label: string
  readonly startTime: number
}

/** The manager surface the stop reads: which jobs run, and the kill it records. */
function jobManager(jobs: StubJob[]) {
  const killed: string[] = []
  const running = [...jobs]
  return {
    killed,
    manager: {
      getRunningJobs: (filter?: { ownerId?: string }) =>
        running.filter(() => filter?.ownerId === undefined || filter.ownerId === 'agent-1'),
      cancelAll: (filter?: { ownerId?: string }, reason?: unknown) => {
        void reason
        for (const job of running) {
          if (filter?.ownerId !== undefined && filter.ownerId !== 'agent-1') continue
          killed.push(job.id)
        }
      },
    },
  }
}

/**
 * A session's engine object, as far as these reads go.
 *
 * `pendingAsyncWork` is the engine's own answer about a wake, kept a separate switch because the
 * whole point is the gap between it and the jobs the manager still runs.
 */
function agentWith(options: {
  jobs?: StubJob[]
  pendingAsyncWork?: boolean
  streaming?: boolean
}) {
  const jobs = jobManager(options.jobs ?? [])
  const agent = {
    isStreaming: options.streaming === true,
    hasAdmittedSubmission: false,
    hasPendingAsyncWork: () => options.pendingAsyncWork === true,
    getAgentId: () => 'agent-1',
    asyncJobManager: jobs.manager,
    queuedMessageCount: 0,
    abort: () => {},
    waitForIdle: async () => {},
  }
  // The engine object is a class with private state; the reads above are the whole surface these
  // rules touch, and the cast is what lets a test stand in for it without a session.
  return { agent: agent as unknown as LiveSession['agent'], killed: jobs.killed }
}

const noChildren = { liveIds: () => [] as readonly string[] } as unknown as LiveSession['subagents']
const goalIdle = { continuationPending: false } as unknown as LiveSession['goal']

test('a session running a background job is working, even when its result can no longer wake it', () => {
  const { agent } = agentWith({
    jobs: [{ id: 'bg_12', type: 'bash', label: 'bash', startTime: 1 }],
    pendingAsyncWork: false,
  })
  assert.equal(isWorking({ agent, subagents: noChildren, goal: goalIdle }), true)
})

test('a job count follows the manager, not the wake it may no longer be owed', () => {
  const { agent } = agentWith({
    jobs: [
      { id: 'bg_1', type: 'bash', label: 'bash', startTime: 1 },
      { id: 'bg_2', type: 'eval', label: 'eval', startTime: 2 },
    ],
    pendingAsyncWork: false,
  })
  assert.deepEqual(cancellableCounts({ agent, subagents: noChildren }), { subagents: 0, jobs: 2 })
})

/**
 * One session as `stopSession` reads it, with the engine's bookkeeping as switches.
 *
 * The state view is built from the same object, so this stub carries every field it reads: the
 * assertions are about what the stop *did* (call order, reason, answer), and the published frame
 * is only there to keep the view from throwing.
 */
function stopStub(options: {
  streaming?: boolean
  steering?: string[]
  followUp?: string[]
  abortNeverSettles?: boolean
  compacting?: boolean
  children?: string[]
  childCancelNeverSettles?: boolean
  clearQueueThrows?: boolean
  dialogs?: number
} = {}) {
  const calls: string[] = []
  const abortReasons: unknown[] = []
  const emitted: unknown[] = []
  let streaming = options.streaming === true
  let compacting = options.compacting === true
  let steering = [...(options.steering ?? [])]
  let followUp = [...(options.followUp ?? [])]
  let children = [...(options.children ?? [])]
  const agent = {
    model: undefined,
    settings: undefined,
    getContextBreakdown: () => null,
    getAvailableThinkingLevels: () => [],
    thinkingLevel: 'off',
    get isStreaming() {
      return streaming
    },
    hasAdmittedSubmission: false,
    getGoalModeState: () => undefined,
    getPlanModeState: () => undefined,
    getVibeModeState: () => undefined,
    get isCompacting() {
      return compacting
    },
    steeringMode: 'queue',
    followUpMode: 'queue',
    interruptMode: 'queue',
    sessionFile: 's.jsonl',
    sessionId: 's1',
    sessionName: undefined,
    autoCompactionEnabled: false,
    get queuedMessageCount() {
      return steering.length + followUp.length
    },
    getTodoPhases: () => [],
    messages: [] as unknown[],
    asyncJobManager: {
      getRunningJobs: () => [] as StubJob[],
      cancelAll: () => {},
      getJob: () => undefined,
      acknowledgeDeliveries: () => 0,
    },
    getAgentId: () => 'agent-1',
    hasPendingAsyncWork: () => false,
    yieldQueue: { has: () => false, clear: () => {} },
    clearQueue: () => {
      calls.push('clearQueue')
      if (options.clearQueueThrows === true) throw new Error('queue unavailable')
      const withdrawn = {
        steering: steering.map(text => ({ text })),
        followUp: followUp.map(text => ({ text })),
      }
      steering = []
      followUp = []
      return withdrawn
    },
    abort: (settings?: { reason?: string }) => {
      calls.push('abort')
      abortReasons.push(settings?.reason)
      if (options.abortNeverSettles === true) return new Promise<void>(() => {})
      streaming = false
      compacting = false
      return Promise.resolve()
    },
    waitForIdle: async () => {},
  }
  const subagents = {
    liveIds: () => children,
    cancel: async () => {
      calls.push('cancelChildren')
      if (options.childCancelNeverSettles === true) return new Promise<never>(() => {})
      const ended = children
      children = []
      return { ended, killed: 0 }
    },
  }
  const live = {
    sessionId: 's1',
    sessionFile: 's.jsonl',
    cwd: 'cwd',
    manager: {
      getBranch: () => [] as unknown[],
      getUsageStatistics: () => ({ input: 0, cacheRead: 0, cacheWrite: 0 }),
    },
    agent,
    events: {
      seq: 1,
      emit: (frame: unknown) => {
        emitted.push(frame)
      },
    },
    ui: {
      cancelAll: () => {
        calls.push('cancelDialogs')
        return options.dialogs ?? 0
      },
    },
    mcpManager: undefined,
    losses: { droppedFrames: 0 },
    lastActivityMs: 0,
    lastEventAt: 0,
    silentNotified: false,
    retry: null,
    releasePending: false,
    releaseScheduled: false,
    commands: [] as unknown[],
    goal: { continuationPending: false, stopForHostAbort: () => calls.push('stopGoal') },
    subagents,
  } as unknown as LiveSession
  const port = {
    sdk: { asyncResultMessageType: 'async-result' } as unknown as SdkBundle,
    held: () => true,
    drop: () => {},
    usesWorkspace: () => false,
  }
  return { live, port, calls, abortReasons, emitted }
}

/// The stop's reason is the engine's own string, not a host-invented sentence: the engine compares
/// it to decide whether this is the reader's interrupt (`AgentSession.abort`) or a lifecycle abort.
/// No engine entry point exports the constant, so this pins the copy against the installed source.
test('the stop reason is the engine user-interrupt label', () => {
  const require_ = createRequire(import.meta.url)
  const enginePackage = require_.resolve('@oh-my-pi/pi-coding-agent/package.json')
  // `pi-tui` publishes only its root entry, and the constant's module is not re-exported by the
  // engine, so the source file is read from the installed package rather than imported.
  const tuiPackage = createRequire(enginePackage).resolve('@oh-my-pi/pi-tui/package.json')
  const source = readFileSync(path.join(path.dirname(tuiPackage), 'src', 'chat', 'messages.ts'), 'utf8')
  const declared = /export const USER_INTERRUPT_LABEL = "([^"]+)"/.exec(source)
  assert.equal(declared?.[1], USER_INTERRUPT_LABEL)
})

/// The reported failure this covers: a steered message waiting behind the turn is resumed by the
/// engine the moment the abort unwinds, so a stop that left it in the queue was followed by a fresh
/// turn. The queue is withdrawn *before* the abort (the engine's own terminal and RPC host do the
/// same on an interrupt), the withdrawn words come back in the answer, and the engine gets its own
/// user-interrupt reason.
test('a stop withdraws the reader queue before aborting, and answers with it', async () => {
  const { live, port, calls, abortReasons, emitted } = stopStub({
    streaming: true,
    steering: ['look at the other file'],
    followUp: ['then run the tests'],
  })
  const outcome = await stopSession(port, live, undefined, 500)
  assert.deepEqual(outcome.restored, ['look at the other file', 'then run the tests'])
  assert.equal(outcome.aborted, true)
  assert.ok(calls.indexOf('clearQueue') < calls.indexOf('abort'), calls.join(','))
  assert.deepEqual(abortReasons, [USER_INTERRUPT_LABEL])
  assert.deepEqual(outcome.remaining, [])
  // The state the stop published is a reading of the session afterwards, not of the queue it just
  // withdrew: the reader's screen has to stop drawing the turn the answer ended.
  const published = emitted[0] as { type: string; state: { isStreaming: boolean } }
  assert.equal(published.type, 'state')
  assert.equal(published.state.isStreaming, false)
})

/// A stop that finds nothing still publishes the idle view (the correction a stale screen has no
/// other frame for) and answers with no work done and nothing withdrawn.
test('a stop with nothing to end answers false and withdraws nothing', async () => {
  const { live, port, calls, emitted } = stopStub({ streaming: false })
  const outcome = await stopSession(port, live, undefined, 500)
  assert.deepEqual(outcome, {
    aborted: false,
    cancelledSubagents: 0,
    cancelledJobs: 0,
    remaining: [],
    restored: [],
  })
  assert.deepEqual(calls, ['clearQueue', 'cancelDialogs'])
  assert.equal(emitted.length, 1)
})

/// The turn may be waiting on the reader (an approval, an `ask`): the press is their answer, and a
/// card left open after the turn is gone would keep asking a question nothing can act on.
test('a stop dismisses the dialog the turn was waiting on', async () => {
  const { live, port, calls } = stopStub({ streaming: false, dialogs: 1 })
  const outcome = await stopSession(port, live, undefined, 500)
  assert.equal(outcome.aborted, true)
  assert.deepEqual(outcome.remaining, [])
  assert.ok(calls.includes('cancelDialogs'))
})

/// A turn that outlasts its window is not a failed request: the stop still answers, `remaining`
/// names the turn, and the answer is not thrown away because the engine was slow.
test('a turn that outlasts the window is reported as remaining, not as a failure', async () => {
  const { live, port } = stopStub({ streaming: true, abortNeverSettles: true })
  const outcome = await stopSession(port, live, undefined, 20)
  assert.equal(outcome.aborted, true)
  assert.ok(outcome.remaining.includes('turn'), JSON.stringify(outcome.remaining))
})

/// Children are cancelled within their own window too: one blocked child must not turn the reader's
/// stop into an endless wait, and it is named in `remaining` for the forced stop.
test('a child that does not unwind within its window is named as remaining', async () => {
  const { live, port } = stopStub({
    streaming: true,
    children: ['child-1'],
    childCancelNeverSettles: true,
  })
  const outcome = await stopSession(port, live, undefined, 500)
  assert.ok(outcome.remaining.includes('children'), JSON.stringify(outcome.remaining))
})

/// Ending the turn is the press; withdrawing the queue is a courtesy to the reader's words. An
/// engine that refuses the withdrawal must not turn the stop into a failed command.
test('a withdrawal that fails does not fail the stop', async () => {
  const { live, port, calls, abortReasons } = stopStub({ streaming: true, clearQueueThrows: true })
  const outcome = await stopSession(port, live, undefined, 500)
  assert.equal(outcome.aborted, true)
  assert.deepEqual(outcome.restored, [])
  assert.ok(calls.includes('abort'))
  assert.deepEqual(abortReasons, [USER_INTERRUPT_LABEL])
})

/// A compaction spends a model call with the turn bit idle: the engine sets `isCompacting` for
/// `/compact`, automatic compaction and handoff. A stop that read only the turn answered "nothing to
/// stop" and left the pass running; `abort()` is the engine's own cancel for it, so the press has to
/// reach it and the answer has to say something was stopped.
test('a stop during a compaction cancels the pass and reports it', async () => {
  const { live, port, calls, abortReasons } = stopStub({ compacting: true })
  const outcome = await stopSession(port, live, undefined, 500)
  assert.equal(outcome.aborted, true)
  assert.ok(calls.includes('abort'), calls.join(','))
  assert.deepEqual(abortReasons, [USER_INTERRUPT_LABEL])
})

/// A compaction is not a turn, so a stop that could not end one has to say so in the words it
/// answers with: the screen draws its "still running" notice from `remaining`, and the turn facets
/// would have reported nothing at all.
test('a compaction the abort could not end is named in the answer', async () => {
  const { live, port } = stopStub({ compacting: true, abortNeverSettles: true })
  const outcome = await stopSession(port, live, undefined, 20)
  assert.equal(outcome.aborted, true)
  assert.deepEqual(outcome.remaining, ['compaction'])
})

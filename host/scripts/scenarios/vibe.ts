/**
 * Vibe mode against a real engine: enter it, direct a worker, and leave it.
 *
 * The unit tests (`src/vibe.test.ts`) decide the order this host drives the engine in, against a
 * session that records what it was asked to do. This scenario is the other half: it proves the real
 * registry, the real worker sessions and the real `mode_change` journal do what the mode promises -
 * `/vibe` enters with the director toolset, a worker can be spawned, and a second `/vibe` **while a
 * director turn is in flight** aborts that turn, takes the worker down with a `mode-exit` tombstone
 * and journals the exit. That turn is the one the exit is most likely to meet, and the one the
 * reported run was blocked in. It is driven by the deterministic provider in
 * `scripts/mock-provider.ts` (opt-in, because it dials a model): `vibe-spawn` makes the director
 * spawn a worker, and `hold` is a model request the provider never answers, so the director's turn
 * stays running for the exit to end.
 */

import * as fs from 'node:fs'

import { workspace } from '../client.ts'
import type { HostProcess } from '../client.ts'
import type { Report, Scenario } from '../harness.ts'
import { openSession, selectModel } from './session-flow.ts'

/** One journal entry of the session file, as the engine writes it. */
interface JournalEntry {
  readonly type?: string
  readonly mode?: string
  readonly data?: { readonly id?: string; readonly action?: string; readonly reason?: string }
  readonly message?: { readonly role?: string; readonly stopReason?: string }
}

/** The conversation's state view, from one `session_state` answer. */
async function sessionState(host: HostProcess, sessionId: string): Promise<Record<string, unknown>> {
  const response = await host.response(host.send({ type: 'session_state', sessionId }), 30_000)
  const data = response.data
  const state =
    data !== null && typeof data === 'object' && 'state' in data && data.state !== null && typeof data.state === 'object'
      ? (data.state as Record<string, unknown>)
      : {}
  return state
}

/**
 * Waits until the state view satisfies `ready`, and answers the view it settled on.
 *
 * A mode change is published on the session's own `state` frames, but the scenarios here read the
 * view rather than the stream: what the reader sees is the view, and a frame the driver missed is
 * not a missing mode.
 */
async function waitForState(
  host: HostProcess,
  sessionId: string,
  ready: (state: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await sessionState(host, sessionId)
    if (ready(state)) return state
    if (Date.now() > deadline) return state
    const tick = Promise.withResolvers<void>()
    setTimeout(tick.resolve, 100)
    await tick.promise
  }
}

/** The worker rows the state view carries, empty when the conversation is not in vibe mode. */
function workerRows(state: Record<string, unknown>): readonly Record<string, unknown>[] {
  const modes = state.modes
  if (modes === null || typeof modes !== 'object') return []
  const vibe = (modes as Record<string, unknown>).vibe
  if (vibe === null || typeof vibe !== 'object') return []
  const workers = (vibe as Record<string, unknown>).workers
  return Array.isArray(workers) ? (workers as Record<string, unknown>[]) : []
}

/** The conversation's journal as the engine wrote it, or an empty list while the file holds none. */
function journal(file: unknown): readonly JournalEntry[] {
  if (typeof file !== 'string' || file === '') return []
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap((line): JournalEntry[] => {
      try {
        const entry: unknown = JSON.parse(line)
        return entry !== null && typeof entry === 'object' ? [entry as JournalEntry] : []
      } catch {
        return []
      }
    })
}

/** The last `mode_change` the journal holds, or undefined when it holds none. */
function lastMode(entries: readonly JournalEntry[]): JournalEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type === 'mode_change') return entry
  }
  return undefined
}

/** Sends one prompt and answers its acknowledgement frame id, without waiting for the turn. */
async function prompt(
  host: HostProcess,
  sessionId: string,
  message: string,
  behavior?: string,
): Promise<{ id: string; ok: boolean; detail: string }> {
  const id = host.send({
    type: 'session_prompt',
    sessionId,
    message,
    ...(behavior === undefined ? {} : { streamingBehavior: behavior }),
  })
  const ack = await host.response(id, 30_000)
  return { id, ok: ack.success === true, detail: JSON.stringify(ack.data ?? ack).slice(0, 200) }
}

/** Waits for the `prompt_result` of one prompt: whether the engine was asked to answer it. */
async function promptResult(
  host: HostProcess,
  id: string,
): Promise<{ found: boolean; agentInvoked: boolean | null }> {
  try {
    const frame = await host.waitFor(
      'prompt_result',
      candidate => candidate.type === 'prompt_result' && candidate.id === id,
      60_000,
    )
    return { found: true, agentInvoked: typeof frame.agentInvoked === 'boolean' ? frame.agentInvoked : null }
  } catch {
    return { found: false, agentInvoked: null }
  }
}

export const vibeScenarios: Record<string, Scenario> = {
  async vibe(host: HostProcess, report: Report) {
    const sessionId = await openSession(host, report, 'vibe')
    await selectModel(host, sessionId, report, 'vibe')

    // Enter: the command is local (`agentInvoked:false`), and the mode is on with no workers yet.
    const entered = await prompt(host, sessionId, '/vibe')
    report.record('vibe.enter.ack', entered.ok, entered.detail)
    const enterResult = await promptResult(host, entered.id)
    report.record(
      'vibe.enter.local',
      enterResult.found && enterResult.agentInvoked === false,
      JSON.stringify(enterResult),
    )
    const enteredState = await waitForState(
      host,
      sessionId,
      state => {
        const modes = state.modes
        return modes !== null && typeof modes === 'object' && 'vibe' in modes
      },
      30_000,
    )
    const enterModes = enteredState.modes as Record<string, unknown> | undefined
    report.record('vibe.enter.state', enterModes !== undefined && 'vibe' in enterModes, JSON.stringify(enterModes))
    const enterJournal = journal(enteredState.sessionFile)
    const enterMode = lastMode(enterJournal)
    const previous = enterMode?.data as { previousTools?: unknown } | undefined
    report.record(
      'vibe.enter.journal',
      enterMode?.mode === 'vibe' && Array.isArray(previous?.previousTools) && previous.previousTools.includes('write'),
      JSON.stringify(enterMode?.data),
    )

    // A worker the director starts. The spawn call returns at once, so the next prompt waits for
    // that turn's own end rather than racing it.
    const spawned = await prompt(host, sessionId, 'vibe-spawn fast held-one')
    report.record('vibe.spawn.ack', spawned.ok, spawned.detail)
    // The turn's end is one frame; the engine's own "not answering" reading lands a moment later,
    // and a prompt sent between the two is refused as busy. The worker keeps the session's
    // `pendingAsyncWork` true for much longer, which is why this is not `waitIdle`.
    await host.waitFor('agent_end', frame => frame.sessionId === sessionId, 60_000)
    await waitForState(host, sessionId, state => state.isStreaming !== true, 30_000)
    const roster = await waitForState(host, sessionId, state => workerRows(state).length === 1, 60_000)
    const rows = workerRows(roster)
    report.record(
      'vibe.worker.roster',
      rows.length === 1 && rows[0]?.id === 'held-one',
      JSON.stringify(rows.map(worker => ({ id: worker.id, state: worker.state }))),
    )

    // A director turn nothing settles: the provider never answers `hold`. This is the state the mode
    // has to be able to leave from — the one the reported run was in when `/vibe` was typed — and the
    // turn the exit has to end before it can swap the toolset back.
    const endsBefore = host.of('agent_end').filter(frame => frame.sessionId === sessionId).length
    const holding = await prompt(host, sessionId, 'hold', 'steer')
    report.record('vibe.hold.ack', holding.ok, holding.detail)
    const blocked = await waitForState(host, sessionId, state => state.isStreaming === true, 60_000)
    report.record('vibe.hold.blocked', blocked.isStreaming === true, JSON.stringify({ isStreaming: blocked.isStreaming }))

    // Exit, while that turn is in flight.
    const exited = await prompt(host, sessionId, '/vibe', 'steer')
    report.record('vibe.exit.ack', exited.ok, exited.detail)
    const exitResult = await promptResult(host, exited.id)
    report.record(
      'vibe.exit.local',
      exitResult.found && exitResult.agentInvoked === false,
      JSON.stringify(exitResult),
    )
    const outside = await waitForState(
      host,
      sessionId,
      state => state.modes === null || typeof state.modes !== 'object' || !('vibe' in (state.modes as object)),
      60_000,
    )
    const leftModes = outside.modes as Record<string, unknown> | undefined
    report.record(
      'vibe.exit.state',
      leftModes === undefined || !('vibe' in leftModes),
      JSON.stringify(leftModes),
    )

    const exitJournal = journal(outside.sessionFile)
    const exitMode = lastMode(exitJournal)
    report.record('vibe.exit.journal', exitMode?.mode === 'none', JSON.stringify(exitMode?.data ?? exitMode?.mode ?? null))
    report.record(
      'vibe.exit.tombstone',
      exitJournal.some(
        entry =>
          entry.type === 'custom' &&
          entry.data?.action === 'tombstone' &&
          entry.data.id === 'held-one' &&
          entry.data.reason === 'mode-exit',
      ),
      JSON.stringify(
        exitJournal
          .filter(entry => entry.type === 'custom' && entry.data?.action === 'tombstone')
          .map(entry => ({ id: entry.data?.id, reason: entry.data?.reason })),
      ),
    )
    report.record(
      'vibe.exit.aborted',
      exitJournal.some(entry => entry.message?.role === 'assistant' && entry.message.stopReason === 'aborted'),
      'the blocked turn ended as an abort',
    )
    try {
      await host.waitFor(
        'agent_end',
        frame =>
          frame.sessionId === sessionId &&
          host.of('agent_end').filter(other => other.sessionId === sessionId).indexOf(frame) >= endsBefore,
        60_000,
      )
      report.record('vibe.exit.turnEnded', true, 'agent_end after the exit')
    } catch {
      report.record('vibe.exit.turnEnded', false, 'no agent_end after the exit')
    }

    // The journal, not the process, is what a reopened conversation reads: a conversation that left
    // the mode comes back plain.
    const file = outside.sessionFile
    const closed = await host.response(host.send({ type: 'session_close', sessionId }), 60_000)
    report.record('vibe.close', closed.success === true, JSON.stringify(closed.data ?? closed))
    const reopened = await host.response(
      host.send({ type: 'session_open', cwd: workspace, sessionFile: typeof file === 'string' ? file : '' }),
      60_000,
    )
    const reopenedData = reopened.data as Record<string, unknown> | undefined
    const reopenedId = typeof reopenedData?.sessionId === 'string' ? reopenedData.sessionId : ''
    const reopenedState = reopenedId === '' ? {} : await sessionState(host, reopenedId)
    const reopenedModes = reopenedState.modes as Record<string, unknown> | undefined
    report.record(
      'vibe.reopen.plain',
      reopened.success === true &&
        (reopenedModes === undefined || !('vibe' in reopenedModes)) &&
        workerRows(reopenedState).length === 0,
      JSON.stringify({ success: reopened.success, modes: reopenedModes }),
    )

    return { sessionId, workers: rows.length }
  },
}

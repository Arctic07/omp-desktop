/**
 * Rewinding a conversation against a real engine: one conversation, cut in place.
 *
 * The unit tests are about which message a rewind addresses (`src/session-branch.test.ts`). This
 * scenario is the other half: it drives two real turns, takes the second one back, and asserts what
 * the reader would see — the conversation keeps its id, its file and its single row, the rows below
 * the message are gone, and the cut survives a close and a reopen. It is driven by the
 * deterministic provider in `scripts/mock-provider.ts` (the scenario is opt-in, because it dials a
 * model).
 */

import { workspace } from '../client.ts'
import type { HostProcess } from '../client.ts'
import type { Report, Scenario } from '../harness.ts'
import { openSession, selectModel, turn } from './session-flow.ts'

/** One page of the conversation, as the host reports it: the counted total and the rows' text. */
async function transcript(
  host: HostProcess,
  sessionId: string,
): Promise<{ total: number; text: string }> {
  const response = await host.response(host.send({ type: 'session_history_page', sessionId }), 60_000)
  const data = response.data
  const messages =
    data !== null && typeof data === 'object' && 'messages' in data && Array.isArray(data.messages)
      ? data.messages
      : []
  const total =
    data !== null && typeof data === 'object' && 'totalMessages' in data && typeof data.totalMessages === 'number'
      ? data.totalMessages
      : -1
  return { total, text: JSON.stringify(messages) }
}

/** The conversation's own state view, narrowed to the fields this scenario reads. */
async function view(
  host: HostProcess,
  sessionId: string,
): Promise<{ file: string; sessions: number }> {
  const response = await host.response(host.send({ type: 'session_state', sessionId }), 30_000)
  const data = response.data
  const state =
    data !== null && typeof data === 'object' && 'state' in data && data.state !== null && typeof data.state === 'object'
      ? data.state
      : null
  const file =
    state !== null && 'sessionFile' in state && typeof state.sessionFile === 'string' ? state.sessionFile : ''
  const health = await host.response(host.send({ type: 'host_health' }), 30_000)
  const healthData = health.data
  const sessions =
    healthData !== null && typeof healthData === 'object' && 'sessions' in healthData && Array.isArray(healthData.sessions)
      ? healthData.sessions.length
      : -1
  return { file, sessions }
}

/** The newest user message a rewind can name, and its text. */
async function lastPoint(host: HostProcess, sessionId: string): Promise<{ entryId: string; text: string }> {
  const response = await host.response(host.send({ type: 'session_branch_points', sessionId }), 30_000)
  const data = response.data
  const points =
    data !== null && typeof data === 'object' && 'points' in data && Array.isArray(data.points) ? data.points : []
  const last = points.at(-1)
  const entryId =
    last !== null && typeof last === 'object' && 'entryId' in last && typeof last.entryId === 'string'
      ? last.entryId
      : ''
  const text = last !== null && typeof last === 'object' && 'text' in last && typeof last.text === 'string' ? last.text : ''
  return { entryId, text }
}

export const rewindScenarios: Record<string, Scenario> = {
  async rewind(host: HostProcess, report: Report) {
    const sessionId = await openSession(host, report, 'rewind')
    await selectModel(host, sessionId, report, 'rewind')
    await turn(host, sessionId, 'first', report, 'rewind.first')
    await turn(host, sessionId, 'second', report, 'rewind.second')

    const opened = await view(host, sessionId)
    const before = await transcript(host, sessionId)
    const target = await lastPoint(host, sessionId)
    report.record('rewind.target', target.entryId !== '' && target.text.includes('second'), JSON.stringify(target))

    const answered = await host.response(
      host.send({ type: 'session_rewind', sessionId, entryId: target.entryId }),
      60_000,
    )
    const answer = answered.data
    const answeredId =
      answer !== null && typeof answer === 'object' && 'sessionId' in answer && typeof answer.sessionId === 'string'
        ? answer.sessionId
        : ''
    const draft =
      answer !== null && typeof answer === 'object' && 'text' in answer && typeof answer.text === 'string'
        ? answer.text
        : ''
    report.record('rewind.answered', answered.success === true && answeredId === sessionId, JSON.stringify(answer).slice(0, 200))
    report.record('rewind.draft', draft.includes('second'), JSON.stringify(draft).slice(0, 200))

    const after = await transcript(host, sessionId)
    const closed = await view(host, sessionId)
    report.record('rewind.cut', after.total < before.total, `${before.total} -> ${after.total}`)
    report.record('rewind.gone', !after.text.includes('second'), 'the message and its answer left the transcript')
    report.record('rewind.kept', after.text.includes('first'), 'the conversation before the message is still there')
    report.record(
      'rewind.inPlace.file',
      closed.file !== '' && closed.file === opened.file,
      `${opened.file} -> ${closed.file}`,
    )
    report.record('rewind.inPlace.oneRow', closed.sessions === opened.sessions, `${opened.sessions} -> ${closed.sessions}`)

    // A leaf move is runtime state; the engine's own durable form is the marker this host writes.
    // Reopening the file proves the cut is what the transcript still says.
    const close = await host.response(host.send({ type: 'session_close', sessionId }), 60_000)
    report.record('rewind.close', close.success === true, JSON.stringify(close.data ?? close))
    const reopened = await host.response(
      host.send({ type: 'session_open', cwd: workspace, sessionFile: opened.file }),
      60_000,
    )
    const reopenedData = reopened.data
    const reopenedId =
      reopenedData !== null && typeof reopenedData === 'object' && 'sessionId' in reopenedData && typeof reopenedData.sessionId === 'string'
        ? reopenedData.sessionId
        : ''
    report.record('rewind.reopen.sameId', reopened.success === true && reopenedId === sessionId, JSON.stringify(reopenedData ?? reopened).slice(0, 200))
    const reread = reopenedId === '' ? { total: -1, text: '' } : await transcript(host, reopenedId)
    report.record(
      'rewind.durable',
      reread.total === after.total && !reread.text.includes('second'),
      `${after.total} -> ${reread.total}`,
    )

    const shutdown = await host.response(host.send({ type: 'host_shutdown', reason: 'rewind' }))
    report.record('rewind.shutdown', shutdown.success === true, JSON.stringify(shutdown.data ?? shutdown))
    return { before: before.total, after: after.total, file: opened.file }
  },
}

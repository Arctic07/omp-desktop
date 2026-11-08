/**
 * Driving one real conversation in the smoke: opening it, naming its model, and running turns.
 *
 * The scenarios that dial the deterministic mock provider (`write-guard`, `rewind`) need the same
 * three gestures, and each of them is a place where a race shows up as a scenario failure rather
 * than a product bug. They live here rather than in one of the scenario modules so both drive the
 * host the same way.
 */

import { workspace } from '../client.ts'
import type { HostProcess } from '../client.ts'
import { OMP_DESKTOP_SMOKE_MODEL, OMP_DESKTOP_SMOKE_PROVIDER, OMP_DESKTOP_SMOKE_THINKING } from '../fixtures.ts'
import type { Report } from '../harness.ts'

/** Opens one new conversation in the smoke workspace. */
export async function openSession(host: HostProcess, report: Report, label: string): Promise<string> {
  const response = await host.response(host.send({ type: 'session_open', cwd: workspace }))
  const data = response.data as Record<string, unknown> | undefined
  const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : ''
  report.record(`${label}.open`, response.success === true && sessionId !== '', JSON.stringify(data ?? response))
  if (sessionId === '') throw new Error(`${label}: the host did not name a session`)
  return sessionId
}

/** Points one conversation at the only model the fixture provider serves. */
export async function selectModel(
  host: HostProcess,
  sessionId: string,
  report: Report,
  label: string,
): Promise<void> {
  const model = await host.response(
    host.send({
      type: 'session_set_model',
      sessionId,
      provider: OMP_DESKTOP_SMOKE_PROVIDER,
      modelId: OMP_DESKTOP_SMOKE_MODEL,
    }),
  )
  report.record(`${label}.setModel`, model.success === true, JSON.stringify(model.data ?? model).slice(0, 200))
  const thinking = await host.response(
    host.send({ type: 'session_set_thinking', sessionId, level: OMP_DESKTOP_SMOKE_THINKING }),
  )
  report.record(`${label}.setThinking`, thinking.success === true, JSON.stringify(thinking.data ?? thinking).slice(0, 200))
}

/**
 * One prompt turn: acknowledge the prompt, then wait for a **new** `agent_end` on that session.
 *
 * The prompt response arrives before the turn runs (`closed-loop` treats it the same way), and the
 * frame log is cumulative, so the wait counts the endings seen before this prompt.
 */
export async function turn(
  host: HostProcess,
  sessionId: string,
  message: string,
  report: Report,
  label: string,
): Promise<void> {
  const before = host.of('agent_end').length
  const ack = await host.response(host.send({ type: 'session_prompt', sessionId, message }), 60_000)
  report.record(`${label}.ack`, ack.success === true, JSON.stringify(ack.data ?? ack).slice(0, 200))
  await host.waitFor(
    'agent_end',
    frame =>
      frame.sessionId === sessionId && host.of('agent_end').indexOf(frame) >= before,
    60_000,
  )
  await waitIdle(host, sessionId)
}

/**
 * Waits until the engine reports the session idle.
 *
 * `agent_end` is the engine's own event; a prompt sent the instant it arrives can still be refused
 * with `session_busy`, because the engine's turn bookkeeping clears a moment later.
 */
export async function waitIdle(host: HostProcess, sessionId: string): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const response = await host.response(host.send({ type: 'session_state', sessionId }), 30_000)
    const data = response.data
    const state =
      data !== null && typeof data === 'object' && 'state' in data && data.state !== null && typeof data.state === 'object'
        ? data.state
        : null
    const streaming = state !== null && 'isStreaming' in state && state.isStreaming === true
    const pending = state !== null && 'pendingAsyncWork' in state ? state.pendingAsyncWork : undefined
    if (!streaming && !pending) return
    if (Date.now() > deadline) throw new Error(`${sessionId} never went idle`)
    const tick = Promise.withResolvers<void>()
    setTimeout(tick.resolve, 100)
    await tick.promise
  }
}

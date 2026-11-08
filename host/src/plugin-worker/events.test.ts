import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EventHub } from './api.ts'
import { WorkerRuntime } from './runtime.ts'
import type { WorkerFrame } from './frames.ts'

/**
 * The worker's receive side of the P1 bus (`omp.desktop` API 0.2.0).
 *
 * Two things are pinned: the hub's own bounds and release (an `off` really removes a handler, and a
 * topic count over the ceiling is refused rather than grown), and that a `worker_event` frame from
 * the supervisor reaches the handler registered on its topic - which is the frame's only purpose.
 */

function hub(): EventHub {
  return new EventHub()
}

test('a delivery reaches the handler registered on its topic, and only that one', () => {
  const events = hub()
  const seen: unknown[] = []
  events.on('plugin:one/hello', payload => seen.push(payload))
  events.dispatch('plugin:one/hello', { n: 1 }, 'one')
  events.dispatch('plugin:two/hello', { n: 2 }, 'two')
  assert.deepEqual(seen, [{ n: 1 }])
})

test('off removes one handler, or every handler on its topic', () => {
  const events = hub()
  const first = (): void => {}
  const second = (): void => {}
  events.on('plugin:one/a', first)
  events.on('plugin:one/a', second)
  events.off('plugin:one/a', first)
  assert.equal(events.dispatch('plugin:one/a', null, 'one'), 1)
  events.off('plugin:one/a')
  assert.equal(events.dispatch('plugin:one/a', null, 'one'), 0)
  assert.equal(events.size, 0, 'a topic with no handler leaves the map')
})

test('a handler that throws does not stop the next one', () => {
  const events = new EventHub()
  const seen: string[] = []
  events.on('plugin:one/a', () => {
    throw new Error('boom')
  })
  events.on('plugin:one/a', () => {
    seen.push('second')
  })
  assert.equal(events.dispatch('plugin:one/a', null, 'one'), 1)
  assert.deepEqual(seen, ['second'])
})

test('the topic and handler ceilings are refused rather than grown', () => {
  const events = hub()
  for (let index = 0; index < 64; index += 1) events.on(`plugin:one/t${index}`, () => {})
  assert.throws(() => events.on('plugin:one/over', () => {}), /at most 64 topics/)
  const crowded = hub()
  for (let index = 0; index < 8; index += 1) crowded.on('plugin:one/a', () => {})
  assert.throws(() => crowded.on('plugin:one/a', () => {}), /at most 8 handlers/)
})

test('a worker_event frame reaches the handler its topic names', () => {
  const lines: string[] = []
  const runtime = new WorkerRuntime({
    identity: { id: 'demo', installId: 'demo@user', root: '/tmp/demo', scope: 'user' },
    ports: {
      writeLine: (line: string) => lines.push(line),
      exit: () => {},
      invoke: async () => null,
    },
  } as never)
  const seen: unknown[] = []
  // The API's own `events` is the surface a plugin uses; the runtime owns the hub it dispatches to,
  // so the handler is registered through `pi.events.on` exactly as a plugin would.
  runtime.api.events.on('plugin:other/ping', payload => seen.push(payload))
  runtime.accept({ type: 'worker_event', event: { topic: 'plugin:other/ping', from: 'other', payload: { ok: true } } } as WorkerFrame)
  assert.deepEqual(seen, [{ ok: true }], 'the delivery reached the handler')
  runtime.accept({ type: 'worker_event' } as WorkerFrame)
  assert.ok(lines.some(line => line.includes('worker_event')), 'a malformed delivery is one warning')
})

import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { PLUGIN_WS_SOCKETS_MAX } from './constants.ts'
import { PluginSocketTable } from './plugin-websocket.ts'

/**
 * The socket table, against a real WebSocket server this test starts.
 *
 * The point is the table's own four properties: an id opens one socket and no more, the inbox is
 * bounded, a `receive` waits for a frame rather than polling forever, and `closeOwner` closes exactly
 * one installation's sockets. The egress decision is the desktop's and is not tested here.
 */

const server = Bun.serve({
  port: 0,
  fetch(request, listener) {
    return listener.upgrade(request) ? undefined : new Response('upgrade required', { status: 400 })
  },
  websocket: {
    message(socket, data) {
      // `bye` hangs up instead of echoing, which is how a plugin learns its stream ended.
      if (data === 'bye') {
        socket.close()
        return
      }
      // Echo, so a `receive` has something to wait for.
      socket.send(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer))
    },
    open() {},
    close() {},
  },
})

after(() => {
  server.stop(true)
})

function url(): string {
  return `ws://127.0.0.1:${server.port}/`
}

test('one id opens one socket and an echo comes back through receive', async () => {
  const table = new PluginSocketTable()
  await table.open('ws-1', url(), 'install-a')
  assert.equal(table.openCount('install-a'), 1)
  const sent = table.send('ws-1', Buffer.from('hello', 'utf8').toString('base64'))
  assert.equal(sent.bytes, 5)
  const answer = await table.receive('ws-1', 2_000, 16)
  assert.deepEqual(answer.frames, [{ data: 'hello' }])
  assert.equal(answer.closed, false)
  table.close('ws-1')
  assert.equal(table.openCount('install-a'), 0)
})

test('a second open for the same id is refused', async () => {
  const table = new PluginSocketTable()
  await table.open('ws-1', url(), 'install-a')
  await assert.rejects(table.open('ws-1', url(), 'install-a'))
  table.close('ws-1')
})

test('the per-installation ceiling is the table own', async () => {
  const table = new PluginSocketTable()
  for (let index = 0; index < PLUGIN_WS_SOCKETS_MAX; index += 1) {
    await table.open(`ws-${index}`, url(), 'install-a')
  }
  await assert.rejects(table.open('ws-over', url(), 'install-a'))
  table.closeOwner('install-a')
  assert.equal(table.openCount('install-a'), 0)
})

test('a receive with nothing to take answers an empty page inside its wait', async () => {
  const table = new PluginSocketTable()
  await table.open('ws-1', url(), 'install-a')
  const started = Date.now()
  const answer = await table.receive('ws-1', 60, 4)
  assert.deepEqual(answer.frames, [])
  assert.ok(Date.now() - started >= 40, 'the poll waited rather than returning at once')
  table.close('ws-1')
})

test('closing one owner leaves the other installation sockets alone', async () => {
  const table = new PluginSocketTable()
  await table.open('ws-a', url(), 'install-a')
  await table.open('ws-b', url(), 'install-b')
  assert.equal(table.closeOwner('install-a'), 1)
  assert.equal(table.openCount('install-b'), 1)
  table.closeOwner('install-b')
})

test('an unknown socket id is refused rather than opened', async () => {
  const table = new PluginSocketTable()
  await assert.rejects(table.receive('ws-none', 10, 4))
  assert.throws(() => table.send('ws-none', 'AA=='))
})

test('a string frame goes out as text and the echo comes back with the inbox state', async () => {
  const table = new PluginSocketTable()
  await table.open('ws-text', url(), 'install-a')
  const sent = table.send('ws-text', Buffer.from('{"hello":1}', 'utf8').toString('base64'))
  assert.deepEqual(sent, { bytes: 11, binary: false }, 'valid UTF-8 is a text frame, which JSON servers expect')
  const answer = await table.receive('ws-text', 2_000, 4)
  assert.deepEqual(answer.frames, [{ data: '{"hello":1}' }])
  assert.equal(answer.dropped, 0)
  assert.equal(answer.closed, false)
  table.close('ws-text')
})

test('bytes that are not text go out as a binary frame rather than as replacement characters', async () => {
  const table = new PluginSocketTable()
  await table.open('ws-binary', url(), 'install-a')
  const sent = table.send('ws-binary', Buffer.from([0xff, 0xfe, 0x00]).toString('base64'))
  assert.deepEqual(sent, { bytes: 3, binary: true })
  table.close('ws-binary')
})

test('a socket the peer closed answers closed rather than an empty inbox', async () => {
  const table = new PluginSocketTable()
  await table.open('ws-bye', url(), 'install-a')
  table.send('ws-bye', Buffer.from('bye', 'utf8').toString('base64'))
  // The close travels back over the same socket; one poll is enough to see it.
  const answer = await table.receive('ws-bye', 2_000, 4)
  assert.equal(answer.closed, true)
  assert.equal(typeof answer.closeCode, 'number')
  table.closeOwner('install-a')
})

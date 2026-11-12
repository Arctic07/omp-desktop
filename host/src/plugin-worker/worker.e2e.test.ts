import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { PLUGIN_WORKER_PROTOCOL } from '../constants.ts'

/**
 * The whole worker, as the supervisor will see it: a real `omp-host` entry point spawned with
 * `--plugin-worker`, a real temporary plugin package, and real NDJSON on stdin/stdout.
 *
 * What this covers that the unit tests cannot: the branch lives before the environment pin and the
 * engine graph, `worker_hello` waits for `onLoad`, an invoke can round-trip *during* `onLoad` (which
 * is why the test answers invokes while waiting for the hello), a refusal is relayed verbatim,
 * `command.execute` reaches the handler, a failing handler is both a refusal and a log line, an
 * unknown frame is ignored with one log line, and
 * `onUnload` runs before the process leaves. The environment is cleared by the worker, so the
 * plugin reads no `HOME` and the run creates no `home/` directory under either directory.
 */

/** One decoded frame plus the invokes the test supervisor answered. */
interface Driver {
  readonly frames: Array<Record<string, unknown>>
  readonly invokes: Array<Record<string, unknown>>
  send(frame: Record<string, unknown>): void
  waitFor(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>
}

/** The fixture entry: reports what it saw, so the assertions are about real values from the worker. */
const MAIN_JS = `import * as fs from 'node:fs'

let invokeCode = null
let dataPath = null
let statKind = null
let listingCount = null
let globCount = null

export async function onLoad(pi) {
  if (pi.plugin.id !== 'e2e-plugin') throw new Error('wrong plugin id')
  try {
    await pi.fs.read('missing.txt')
  } catch (error) {
    invokeCode = error.code
  }
  await pi.commands.register({
    id: 'e2e.hello',
    title: { en: 'E2E Hello' },
    handler: async (params) => {
      if (params && params.fail) throw new Error('boom at C:\\\\secret\\\\plugin.js')
      return {
        pong: true,
        invokeCode,
        dataPath,
        statKind,
        listingCount,
        globCount,
        home: process.env.HOME ?? null,
        userProfile: process.env.USERPROFILE ?? null,
        workerFlag: process.env.OMP_DESKTOP_PLUGIN_WORKER ?? null,
        cwd: process.cwd(),
        root: pi.plugin.root,
        scope: pi.plugin.scope,
      }
    },
  })
  // The three calls an installation makes before it can do anything of its own: where it may write,
  // and what is at a path. Each rides a worker_invoke the supervisor answers like any other.
  dataPath = await pi.plugin.getDataPath()
  statKind = (await pi.fs.stat('docs')).directory
  listingCount = (await pi.fs.list('docs')).entries.length
  globCount = (await pi.fs.glob('docs/**')).entries.length
}

export async function onUnload() {
  fs.writeFileSync('unloaded.txt', 'yes')
}
`

/** The entry point every spawn here runs, from source (the compiled artifact is not required). */
const MAIN_PATH = path.resolve(import.meta.dir, '..', 'main.ts')

/** Reads one piped stream to completion. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done === true) return text
    text += decoder.decode(value, { stream: true })
  }
}

/** Writes a plugin package whose manifest declares a worker entry and one command. */
function writeFixture(root: string): void {
  fs.mkdirSync(path.join(root, 'desktop'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({
      name: 'e2e-plugin',
      version: '1.0.0',
      type: 'module',
      omp: {
        desktop: {
          schemaVersion: 1,
          main: 'desktop/main.js',
          activationEvents: ['onStartup', 'onCommand:e2e.hello'],
          permissions: ['plugin.process', 'command.register', 'fs.read'],
          contributes: { commands: [{ id: 'e2e.hello', title: { en: 'E2E Hello' } }] },
        },
      },
    }, null, 2)}\n`,
    'utf8',
  )
  fs.writeFileSync(path.join(root, 'desktop', 'main.js'), MAIN_JS, 'utf8')
}

/** Starts the driver over one spawned worker. */
function drive(proc: BunSubprocess): Driver {
  const frames: Array<Record<string, unknown>> = []
  const invokes: Array<Record<string, unknown>> = []
  const taken = new Set<number>()
  const decoder = new TextDecoder()
  let pending = ''
  let stderr = ''

  const send = (frame: Record<string, unknown>): void => {
    proc.stdin.write(`${JSON.stringify(frame)}\n`)
    proc.stdin.flush()
  }

  const route = (frame: Record<string, unknown>): void => {
    if (frame.type === 'worker_invoke') {
      invokes.push(frame)
      const method = String(frame.method)
      // The three shapes the fixture reads back verbatim. A canned answer rather than `null`: the
      // worker checks the shape of each (a data path is a string, a listing is an array) and would
      // turn an invented answer into the refusal it is, which would prove nothing about the surface.
      const canned: Record<string, unknown> = {
        'plugin.dataDir': { path: '/tmp/e2e-plugin-data' },
        'fs.stat': { path: 'docs', directory: true, size: 0, modifiedMs: null },
        'fs.list': { path: 'docs', entries: [], truncated: false },
        'fs.glob': { pattern: 'docs/**', entries: [], truncated: false },
      }
      if (method in canned) {
        send({ type: 'worker_invoke_result', id: frame.id, ok: true, value: canned[method] })
        frames.push(frame)
        return
      }
      const allowed =
        method === 'command.register'
        || method === 'command.unregister'
        || method === 'log'
        || method.startsWith('plugin.settings.')
      send({
        type: 'worker_invoke_result',
        id: frame.id,
        ok: allowed,
        ...(allowed ? { value: null } : { code: 'permission_denied', message: 'The e2e supervisor refused this call.' }),
      })
    }
    frames.push(frame)
  }

  void (async () => {
    const reader = proc.stdout.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) return
      pending += decoder.decode(value, { stream: true })
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) break
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (line === '') continue
        route(JSON.parse(line) as Record<string, unknown>)
      }
    }
  })()

  void (async () => {
    const reader = proc.stderr.getReader()
    const errorDecoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) return
      stderr += errorDecoder.decode(value, { stream: true })
    }
  })()

  return {
    frames,
    invokes,
    send,
    async waitFor(predicate, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        for (let index = 0; index < frames.length; index += 1) {
          const frame = frames[index] as Record<string, unknown>
          if (!taken.has(index) && predicate(frame)) {
            taken.add(index)
            return frame
          }
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for a plugin worker frame; seen=${JSON.stringify(frames)} stderr=${stderr}`)
        }
        await delay(20)
      }
    },
  }
}

test('a real worker handshakes, executes a command, relays a refusal and unloads', { timeout: 60_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-worker-e2e-'))
  const root = path.join(base, 'plugin')
  let proc: BunSubprocess | null = null
  try {
    writeFixture(root)
    proc = Bun.spawn({
      // The equivalent of the bundle's `--plugin-worker` launch: the same entry point, run from source.
      cmd: [process.execPath, MAIN_PATH, '--plugin-worker', '--root', root, '--install', 'e2e-plugin@local', '--id', 'e2e-plugin', '--scope', 'user'],
      cwd: base,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const driver = drive(proc)

    // `worker_hello` arrives only after the entry loaded and `onLoad` returned - and `onLoad` had to
    // await two invokes to get there, which the driver answered while waiting.
    const hello = await driver.waitFor(frame => frame.type === 'worker_hello')
    assert.equal(hello.protocol, PLUGIN_WORKER_PROTOCOL)
    assert.equal(hello.pluginId, 'e2e-plugin')
    assert.equal(hello.installId, 'e2e-plugin@local')
    assert.equal(hello.entry, 'desktop/main.js')
    assert.deepEqual(driver.invokes.map(frame => frame.method), ['fs.read', 'command.register', 'plugin.dataDir', 'fs.stat', 'fs.list', 'fs.glob'])
    assert.deepEqual(driver.invokes[0]?.params, { path: 'missing.txt' })
    assert.deepEqual(driver.invokes[1]?.params, { id: 'e2e.hello', title: { en: 'E2E Hello' } })
    assert.deepEqual(driver.invokes[3]?.params, { path: 'docs' })

    // An unknown frame type is one warning, never a crash: the loop keeps serving afterwards.
    driver.send({ type: 'worker_nonsense' })
    const warning = await driver.waitFor(frame => frame.type === 'worker_log' && String(frame.message).includes('unknown plugin worker frame type'))
    assert.equal(warning.level, 'warn')

    driver.send({ type: 'worker_load', id: 'load-1', activation: { event: 'onStartup' } })
    const loaded = await driver.waitFor(frame => frame.type === 'worker_result' && frame.id === 'load-1')
    assert.equal(loaded.ok, true)

    driver.send({ type: 'worker_call', id: 'call-1', method: 'command.execute', params: { commandId: 'e2e.hello' } })
    const answer = await driver.waitFor(frame => frame.type === 'worker_result' && frame.id === 'call-1')
    assert.equal(answer.ok, true)
    const value = answer.value as Record<string, unknown>
    assert.equal(value.pong, true)
    assert.equal(value.invokeCode, 'permission_denied')
    // The three calls `onLoad` made came back through the worker's own surface: a data path the
    // desktop resolved, and an inspection whose answer the plugin read as its own fields.
    assert.equal(value.dataPath, '/tmp/e2e-plugin-data')
    assert.equal(value.statKind, true)
    assert.equal(value.listingCount, 0)
    assert.equal(value.globCount, 0)
    assert.equal(value.home, null)
    assert.equal(value.userProfile, null)
    assert.equal(value.workerFlag, '1')
    assert.equal(value.scope, 'user')
    assert.equal(value.root, root)
    assert.equal(path.resolve(String(value.cwd)).toLowerCase(), path.resolve(root).toLowerCase())

    // An unknown method is answered, not ignored - and answered without a log line: a refusal is the
    // protocol working, and a log that recorded every probe would bury the plugin's real failures.
    driver.send({ type: 'worker_call', id: 'call-2', method: 'no.such.method', params: {} })
    const unknown = await driver.waitFor(frame => frame.type === 'worker_result' && frame.id === 'call-2')
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'unknown_method')
    assert.equal(
      driver.frames.some(frame => frame.type === 'worker_log' && String(frame.message).includes('no.such.method')),
      false,
      'a refusal is not a failure worth a log line',
    )

    // A handler's rejection is `plugin_error`, and the absolute path in its message is redacted
    // before it leaves the worker (no stack, no file path).
    driver.send({ type: 'worker_call', id: 'call-3', method: 'command.execute', params: { commandId: 'e2e.hello', fail: true } })
    const failed = await driver.waitFor(frame => frame.type === 'worker_result' && frame.id === 'call-3')
    assert.equal(failed.ok, false)
    assert.equal(failed.code, 'plugin_error')
    assert.equal(String(failed.message).includes('secret'), false)
    assert.equal(String(failed.message).includes('boom'), true)

    // The same throw is a line in the application's log, written before the answer: a plugin that
    // fails where nobody reads the result still leaves a trace, which is what catching it here buys.
    const failure = await driver.waitFor(
      frame => frame.type === 'worker_log' && String(frame.message).includes('boom'),
    )
    assert.equal(failure.level, 'warn')
    assert.equal(String(failure.message).includes('command.execute'), true)
    assert.equal(String(failure.message).includes('secret'), false, 'the log line is redacted too')

    driver.send({ type: 'worker_unload', id: 'unload-1' })
    const unloaded = await driver.waitFor(frame => frame.type === 'worker_result' && frame.id === 'unload-1')
    assert.equal(unloaded.ok, true)
    const exit = await Promise.race([proc.exited, delay(15_000, -1)])
    assert.equal(exit, 0)
    assert.equal(fs.existsSync(path.join(root, 'unloaded.txt')), true)

    // The worker clears its environment and pins nothing home-shaped: no `home/` anywhere, and the
    // plugin reported neither of the two variables it would have seen.
    assert.equal(fs.existsSync(path.join(base, 'home')), false)
    assert.equal(fs.existsSync(path.join(root, 'home')), false)
  } finally {
    proc?.kill()
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('a launch line the worker cannot read is one worker_fatal and no hello', { timeout: 30_000 }, async () => {
  const proc = Bun.spawn({
    cmd: [process.execPath, MAIN_PATH, '--plugin-worker', '--root', 'relative/plugin', '--install', 'x', '--id', 'x', '--scope', 'user'],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  try {
    const [stdout, exit] = await Promise.all([readAll(proc.stdout), proc.exited])
    const lines = stdout.trim().split('\n')
    assert.equal(lines.length, 1, stdout)
    const frame = JSON.parse(lines[0] as string) as Record<string, unknown>
    assert.equal(frame.type, 'worker_fatal')
    assert.equal(frame.code, 'invalid_input')
    // No `hello` and no host frame: the worker refused before the protocol started.
    assert.equal(exit, 5)
  } finally {
    proc.kill()
  }
})

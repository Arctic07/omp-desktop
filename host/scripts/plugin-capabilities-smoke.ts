/**
 * The P1 capability smoke: the real worker process and the real host process, driven over their own
 * pipes, with the raw answers printed.
 *
 * It is deliberately not a unit test. `bun test` proves the gates; this proves the *surface*: a
 * fixture plugin's own `onLoad(pi)` calls all six capability families, the frames the worker emits
 * are the ones the supervisor reads, a `worker_event` frame reaches `pi.events.on`, and the host's
 * data frames answer over the real protocol against a real session store.
 *
 * Run: `bun run scripts/plugin-capabilities-smoke.ts` from `host/`. Every temporary directory it
 * creates is removed on the way out.
 */

import { spawn } from 'node:child_process'
import { PROTOCOL_VERSION } from '../src/constants.ts'
import { sessionIdFor } from '../src/store.ts'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** One `worker_invoke` the fixture asked for, and the answer this harness gave. */
interface Invocation {
  readonly id: string
  readonly method: string
  readonly params: Record<string, unknown>
}

const fixtureRoots: string[] = []

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fixtureRoots.push(root)
  return root
}

/** The fixture plugin: every capability, one command, and an event handler. */
function fixturePlugin(): string {
  const root = tempRoot('omp-p1-plugin-')
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'p1-smoke',
      version: '0.1.0',
      omp: {
        desktop: {
          schemaVersion: 1,
          main: 'index.mjs',
          permissions: [
            'plugin.process',
            'session.read',
            'usage.read',
            'agent.complete',
            'bus.publish',
            'bus.subscribe',
            'net.websocket',
            'shell.openExternal',
          ],
          net: { domains: ['api.example.com'] },
        },
      },
    }, null, 2),
  )
  fs.writeFileSync(
    path.join(root, 'index.mjs'),
    `export function onLoad(pi) {
  pi.events.on('plugin:other/ping', (payload, from) => {
    pi.log('event ' + from + ' ' + JSON.stringify(payload))
  })
  pi.commands.register({
    id: 'run',
    handler: async () => {
      const calls = [
        ['session.list', () => pi.session.list({ limit: 5 })],
        ['session.get', () => pi.session.get('s1234567890abcdef')],
        ['session.messages', () => pi.session.messages('s1234567890abcdef', { limit: 2, contentLimit: 32 })],
        ['usage.turns', () => pi.usage.turns({ limit: 2 })],
        ['agent.complete', () => pi.agent.complete({ prompt: 'say hi', maxTokens: 16 })],
        ['bus.publish', () => pi.bus.publish('plugin:p1-smoke/hello', { n: 1 })],
        ['bus.subscribe', () => pi.bus.subscribe(['plugin:other/ping'])],
        ['net.websocket.connect', () => pi.net.websocket.connect('wss://api.example.com/socket')],
        ['net.websocket.send', () => pi.net.websocket.send('ws-1', 'hello')],
        ['net.websocket.receive', () => pi.net.websocket.receive('ws-1', { waitMs: 0 })],
        ['net.websocket.close', () => pi.net.websocket.close('ws-1')],
        ['shell.openExternal', () => pi.shell.openExternal('https://api.example.com/docs')],
      ]
      const answers = {}
      for (const [name, call] of calls) {
        try {
          answers[name] = await call()
        } catch (error) {
          answers[name] = { refused: error.code, message: error.message }
        }
      }
      return answers
    },
  })
}`,
  )
  return root
}

/** The host's own data root: a session store with one conversation, and the id the store derives. */
function fixtureHost(): { root: string; sessionId: string } {
  const root = tempRoot('omp-p1-host-')
  // The host derives its store from `--data-root` (`<root>/host/sessions`, `env.ts::pinEnv`), so the
  // fixture writes where the host will look rather than where a test would.
  const sessionDir = path.join(root, 'host', 'sessions')
  fs.mkdirSync(sessionDir, { recursive: true })
  const file = path.join(sessionDir, '2026-10-28T02-00-00-000Z_01a30000-0000-7000-8000-000000000001.jsonl')
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', version: 3, id: 'x', cwd: 'D:/project/smoke', title: 'Smoke conversation' }),
      // The shape the engine writes: an entry id and an entry timestamp on the row, the message
      // object inside it. The projection publishes the id and the time from the first pair.
      JSON.stringify({
        type: 'message',
        id: 'e1',
        timestamp: '2026-10-28T02:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'message',
        id: 'e2',
        timestamp: '2026-10-28T02:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], provider: 'anthropic', model: 'claude', usage: { input: 3, output: 2, costUsd: 0.001 } },
      }),
    ].join('\n') + '\n',
  )
  // The id is a digest of the file's canonical path (`store.ts::sessionIdFor`), which is why it is
  // derived here rather than invented: the frames must name the conversation the store really holds.
  return { root, sessionId: sessionIdFor(file) }
}

/** Runs one child process to completion, collecting its stdout lines. */
function runToEnd(command: string[], env: Record<string, string>, input: string, limitMs = 90_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.dirname(command[0]),
    })
    const lines: string[] = []
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        lines.push(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${command.join(' ')} did not finish in ${limitMs} ms`))
    }, limitMs)
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(lines)
    })
    child.stdin.write(input)
    child.stdin.end()
  })
}

/** The P1 answers the harness gives each invoke, so the worker can finish its command. */
function answerFor(method: string): Record<string, unknown> {
  if (method.startsWith('session.') || method === 'usage.turns') {
    return { ok: true, value: { sessions: [{ sessionId: 's1234567890abcdef' }], nextCursor: null, messages: [], turns: [], total: 0 } }
  }
  if (method === 'agent.complete') return { ok: true, value: { text: 'hi', usage: { input: 3, output: 1 } } }
  if (method === 'bus.publish') return { ok: true, value: { delivered: 0 } }
  if (method === 'bus.subscribe') {
    return { ok: true, value: { topics: ['plugin:other/ping'] } }
  }
  if (method === 'net.websocket.connect') return { ok: true, value: { socketId: 'ws-1' } }
  if (method === 'net.websocket.receive') return { ok: true, value: { frames: [], dropped: 0, closed: false } }
  if (method.startsWith('net.websocket.')) return { ok: true, value: { closed: true, bytes: 5 } }
  if (method === 'shell.openExternal') return { ok: true, value: { ok: true } }
  if (method === 'log') return { ok: true, value: { ok: true } }
  if (method === 'command.register') return { ok: true, value: { ok: true } }
  return { ok: false, code: 'internal', message: `the smoke has no answer for ${method}` }
}

/** The worker half: launch `--plugin-worker`, run the fixture's command, print what it asked for. */
async function workerSmoke(): Promise<void> {
  const root = fixturePlugin()
  const host = path.join(process.cwd(), 'src', 'main.ts')
  const env = { ...process.env, PATH: process.env.PATH ?? '' }
  const args = ['bun', host, '--plugin-worker', '--root', root, '--install', 'p1-smoke@smoke', '--id', 'p1-smoke', '--scope', 'user']
  // The first pass records what the fixture asks for; the second replays the same command with
  // answers, so the plugin's own result is what the harness prints.
  const asked = await driveWorker(args, env, [], false)
  console.log('\n== worker: what the fixture plugin asked for ==')
  for (const invocation of asked.invocations) console.log(`  ${invocation.method} ${JSON.stringify(invocation.params)}`)
  const second = await driveWorker(args, env, [], true)
  console.log('\n== worker: the plugin-visible results (canned answers, relayed verbatim) ==')
  for (const line of second.lines) if (line.includes('"worker_result"')) console.log(`  ${line.slice(0, 900)}`)
}

/**
 * One worker run: send `worker_load`, the command, an event, and unload.
 *
 * The frames are written up front and the answers are synthesised from the invokes the child emits,
 * which is what makes one pipe enough: the worker's read loop is asynchronous, so the harness keeps
 * the stdin open until the child has asked for everything it wants.
 */
async function driveWorker(
  command: string[],
  env: Record<string, string>,
  _frames: string[],
  answer: boolean,
): Promise<{ lines: string[]; invocations: Invocation[] }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.dirname(command[0]),
    })
    const lines: string[] = []
    const invocations: Invocation[] = []
    let buffer = ''
    let sequence = 0
    const send = (frame: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(frame)}\n`)
    }
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('the worker did not finish in time'))
    }, 60_000)
    let loaded = false
    let executed = false
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        lines.push(line)
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (frame.type === 'worker_hello' && !loaded) {
          loaded = true
          send({ type: 'worker_load', id: `l${++sequence}`, activation: { event: 'onStartup' } })
          send({ type: 'worker_call', id: `c${++sequence}`, method: 'command.execute', params: { commandId: 'run' } })
          send({ type: 'worker_event', event: { topic: 'plugin:other/ping', from: 'other', payload: { ok: true } } })
          return
        }
        if (frame.type === 'worker_invoke') {
          const invocation = {
            id: String(frame.id),
            method: String(frame.method),
            params: (frame.params ?? {}) as Record<string, unknown>,
          }
          invocations.push(invocation)
          if (answer) send({ type: 'worker_invoke_result', id: invocation.id, ...answerFor(invocation.method) })
          else send({ type: 'worker_invoke_result', id: invocation.id, ok: true, value: null })
          return
        }
        if (frame.type === 'worker_result' && String(frame.id).startsWith('c')) {
          executed = true
          send({ type: 'worker_unload', id: `u${++sequence}` })
        }
      }
    })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      if (!loaded) reject(new Error(`the worker never introduced itself: ${lines.slice(0, 3).join(' | ')}`))
      else resolve({ lines, invocations })
    })
    if (!executed) {
      // Nothing: the exit handler is what observes the run; `executed` only documents the shape.
    }
  })
}

/** The host half: the real P1 frames over the real protocol, against a real store and socket. */
async function hostSmoke(): Promise<void> {
  const { root, sessionId } = fixtureHost()
  // A WebSocket the host can really open: the frames below are its client's own path.
  const echo = Bun.serve({
    port: 0,
    // Loopback only, like the test's: a smoke server on every interface makes Windows ask.
    hostname: '127.0.0.1',
    fetch(request, listener) {
      return listener.upgrade(request) ? undefined : new Response('upgrade required', { status: 400 })
    },
    websocket: {
      message(socket, data) {
        socket.send(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer))
      },
      // The smoke's own evidence that the socket really opened: printed with the frames below.
      open() {
        console.log('  [socket] the host connected')
      },
      close() {
        console.log('  [socket] the connection closed')
      },
    },
  })
  const host = path.join(process.cwd(), 'src', 'main.ts')
  // A whitelist, not a copy: the host *asserts* every pinned variable it is handed agrees with
  // `--data-root`, so inheriting this process's own pins would make it refuse to start - correctly.
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  // The pins the host derives from `--data-root`, spelled the way `env.ts::pinEnv` spells them.
  const hostDir = path.join(root, 'host')
  Object.assign(env, {
    PI_CODING_AGENT_DIR: path.join(hostDir, 'agent'),
    OMP_DESKTOP_CODING_AGENT_DIR: path.join(hostDir, 'agent'),
    PI_CONFIG_DIR: 'omp-desktop',
    XDG_DATA_HOME: path.join(hostDir, 'xdg'),
    OMP_WORKTREE_DIR: path.join(hostDir, 'worktrees'),
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
  })

  const answers = new Map<string, string>()
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bun', [host, '--data-root', root], {
      env,
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = ''
    const pending = new Map<string, () => void>()
    /** One frame, and the promise that resolves when its id answers: the plugin's own `await`. */
    const request = (frame: Record<string, unknown>): Promise<void> => {
      const id = String(frame.id)
      const { promise, resolve: answered } = Promise.withResolvers<void>()
      pending.set(id, answered)
      child.stdin.write(`${JSON.stringify(frame)}\n`)
      return promise
    }
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('the host did not finish the smoke in time'))
    }, 120_000)
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        try {
          const frame = JSON.parse(line) as Record<string, unknown>
          if (typeof frame.id === 'string') {
            answers.set(frame.id, line)
            pending.get(frame.id)?.()
            pending.delete(frame.id)
          }
        } catch {
          // A non-JSON line is the host's log channel; the smoke prints the answers only.
        }
      }
    })
    child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8')
      if (text.includes('plugins_ws') || text.includes('failed') || text.includes('refus')) {
        console.log(`  [host-err] ${text.trim()}`)
      }
    })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    void (async () => {
      // `hello_ok` first: nothing is served before the protocol is pinned (`dispatch.ts`), and the
      // number is the source constant rather than a literal - a hard-coded one ages into a
      // `protocol_mismatch` the first time the protocol moves (2026-10-29: 30 → 31).
      await request({ type: 'hello_ok', id: 'h0', protocol: PROTOCOL_VERSION })
      await request({ type: 'plugins_session_list', id: 'r1', limit: 5 })
      await request({ type: 'plugins_session_get', id: 'r2', sessionId })
      await request({ type: 'plugins_session_messages', id: 'r3', sessionId, limit: 2, contentLimit: 16 })
      await request({ type: 'plugins_usage_turns', id: 'r4', limit: 5 })
      // Every frame below waits for its own answer, which is exactly how a plugin's `await` behaves:
      // the socket is only usable once `connect` answered, and the harness must not outrun it.
      await request({ type: 'plugins_ws_open', id: 'r5', socketId: 'ws-smoke', url: `ws://127.0.0.1:${echo.port}/`, owner: 'p1-smoke' })
      await request({ type: 'plugins_ws_send', id: 'r6', socketId: 'ws-smoke', data: Buffer.from('ping', 'utf8').toString('base64') })
      await request({ type: 'plugins_ws_receive', id: 'r7', socketId: 'ws-smoke', waitMs: 2_000, limit: 4 })
      await request({ type: 'plugins_ws_close', id: 'r8', socketId: 'ws-smoke' })
      await request({ type: 'plugins_ws_close_owner', id: 'r9', owner: 'p1-smoke' })
      await request({ type: 'plugins_agent_complete', id: 'r10', prompt: 'say hi', maxTokens: 16 })
      child.stdin.end()
    })()
  })
  echo.stop(true)

  console.log('\n== host: raw frames for the P1 commands ==')
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10']) {
    const line = answers.get(id)
    console.log(`  ${line === undefined ? `${id}: no answer` : line.slice(0, 700)}`)
  }
}

await workerSmoke()
await hostSmoke()

for (const root of fixtureRoots) {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    // A fixture that could not be removed is not a failed smoke.
  }
}
console.log('\nsmoke complete')

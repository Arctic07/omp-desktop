/**
 * The plugin worker's protocol loop: frames in, frames out, and the one place a call is settled.
 *
 * The worker is deliberately dumb (plan §6.3): it forwards `pi.*` calls through `worker_invoke` and
 * relays Rust's answer verbatim, so there is no permission, scope or confirmation logic here to
 * drift from the bridge's. What it *does* own is the contract with the supervisor:
 *
 * - `worker_hello` only after the entry resolved and `onLoad` returned (sent by [`handshake`]).
 * - one answer per request, under that request's own `id` - never by arrival order.
 * - a handler's rejection is `plugin_error`, sanitized; no stack and no absolute path leaves here.
 * - an unknown `worker_call` method is `unknown_method`; an unknown frame type is one `worker_log`
 *   warning and nothing else, because a supervisor from a newer build must not be able to kill the
 *   worker by saying something it does not know.
 * - frames are answered off the read loop (`#track`), so one slow handler cannot stop the next
 *   frame from being read; `worker_unload` waits for the in-flight handlers before it answers.
 *
 * The frame ceiling is applied here, on the encoded line: a result that would exceed it is answered
 * with `invalid_input` instead, and an invoke that would is rejected locally before a byte is sent.
 * `worker_invoke` budgets are [`InvokeBudget`]'s (`too_many_requests`).
 */

import { PLUGIN_WORKER_PROTOCOL, PLUGIN_WORKER_ID_MAX } from '../constants.ts'
import { sanitizeMessage } from '../log.ts'
import { isRecord } from '../plugins-manifest.ts'
import { CommandRegistry, EventHub, InvokeRefusal, createPluginApi, type PluginApi, type PluginIdentity } from './api.ts'
import { InvokeBudget } from './budget.ts'
import { encodeWorkerFrame, settlementFrame, workerFrameId, workerLogFrame, type WorkerFrame, type WorkerSettlement } from './frames.ts'

/** A module namespace the entry loaded; only the exports this protocol names are read. */
export type PluginModule = Record<string, unknown>

/** What the runtime writes and how it leaves; injected so the loop is testable without a process. */
export interface WorkerRuntimePorts {
  /** One encoded line, without the newline. A write failure is the writer's to handle. */
  readonly writeLine: (line: string) => void
  /** Leave after `worker_unload` has been answered and the writer flushed. */
  readonly exit: (code: number) => void
}

/** What the runtime needs to know about the installation it serves. */
export interface WorkerRuntimeConfig {
  readonly identity: PluginIdentity
  readonly ports: WorkerRuntimePorts
}

/** A pending `worker_call`: the id the request arrived under and the handler it started. */
type PendingInvoke = {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: InvokeRefusal) => void
}

/** One `renderer.call` hook, the T3 seam: `onRendererCall(method, params)`. */
type RendererCall = (method: string, params: unknown) => unknown

/** The one sentence an oversized answer is replaced with. */
const OVERSIZED = 'The answer exceeds the plugin worker frame ceiling.'

export class WorkerRuntime {
  readonly #identity: PluginIdentity
  readonly #ports: WorkerRuntimePorts
  readonly #budget = new InvokeBudget()
  readonly #registry = new CommandRegistry()
  /**
   * The handlers this worker's `pi.events.on` registered. Owner: this runtime. Bound: the two
   * ceilings in `EventHub`. Release: `off`, `EventHub.clear()` on unload, and process exit.
   */
  readonly #events: EventHub
  readonly #api: PluginApi
  /**
   * Invokes awaiting `worker_invoke_result`. Owner: this runtime. Limit:
   * `PLUGIN_WORKER_MAX_PENDING_INVOKES` (the budget refuses past it). Release: the result removes
   * the entry, and process exit drops the map.
   */
  readonly #pendingInvokes = new Map<string, PendingInvoke>()
  /**
   * `worker_call` handlers that have not settled. Owner: this runtime. Limit: one entry per call the
   * supervisor sent (a trusted side; the worker adds none). Release: each handler's own settlement.
   */
  readonly #inFlight = new Set<Promise<void>>()
  #module: PluginModule = {}
  #sequence = 0
  #closing = false
  #activation: string | null = null

  constructor(config: WorkerRuntimeConfig) {
    this.#identity = config.identity
    this.#ports = config.ports
    // A handler that throws is logged, never rethrown: the delivery came from another plugin, and
    // one subscriber's mistake must not stop the next handler on the same topic.
    this.#events = new EventHub((topic, error) => {
      this.log('warn', `an event handler for ${topic} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.#api = createPluginApi(
      config.identity,
      (method, params) => this.invoke(method, params),
      this.#registry,
      this.#events,
    )
  }

  /** The `pi` object `onLoad` receives. */
  get api(): PluginApi {
    return this.#api
  }

  /** The protocol version this worker advertises; exported for the handshake and the test. */
  get protocol(): number {
    return PLUGIN_WORKER_PROTOCOL
  }

  /** The activation event the supervisor named in `worker_load`, once it has. */
  get activation(): string | null {
    return this.#activation
  }

  /** The module namespace, once the entry has loaded. */
  setModule(module: PluginModule): void {
    this.#module = module
  }

  /** `worker_hello`: the entry resolved and `onLoad` returned. */
  handshake(entry: string): void {
    this.#send({
      type: 'worker_hello',
      protocol: PLUGIN_WORKER_PROTOCOL,
      pluginId: this.#identity.id,
      installId: this.#identity.installId,
      entry,
    })
  }

  /**
   * One inbound frame. Returns after scheduling whatever it started, never after awaiting it: the
   * supervisor may have several calls in flight and a slow handler must not hold the read loop.
   */
  accept(frame: WorkerFrame): void {
    // An answer to an invoke still settles while the worker is unloading: the handler being drained
    // may be waiting for it, and dropping it would turn a graceful stop into a five-second kill.
    if (frame.type === 'worker_invoke_result') {
      this.#acceptInvokeResult(frame)
      return
    }
    if (this.#closing) return
    switch (frame.type) {
      case 'worker_call':
        this.#acceptCall(frame)
        return
      case 'worker_load':
        this.#acceptLoad(frame)
        return
      case 'worker_unload':
        this.#acceptUnload(frame)
        return
      // The one frame this supervisor sends that no request asked for (`omp.desktop` API 0.2.0):
      // a bus message, or nothing else. An unknown `event` shape is one warning and nothing more -
      // a supervisor from a newer build must not be able to break this process by saying something
      // it has not learned yet.
      case 'worker_event':
        this.#acceptEvent(frame)
        return
      default:
        this.log('warn', `unknown plugin worker frame type: ${frame.type}`)
    }
  }

  /** One line to the supervisor's log channel, bounded and control characters replaced. */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.#send(workerLogFrame(level, message))
  }

  /**
   * Answers a request whose frame could not be decoded at all (an oversized line the scanner had to
   * drop). The id is whatever the line's own probe could recover; without one there is nobody to
   * answer and the caller has already logged that.
   */
  refuseRequest(id: string, code: string, message: string): void {
    const safe = workerFrameId(id, PLUGIN_WORKER_ID_MAX)
    if (safe !== null) this.#settle('worker_result', safe, { ok: false, code, message })
  }

  /**
   * One `worker_invoke`: budget, id, send, and a promise settled by `worker_invoke_result`.
   *
   * The promise rejects with the supervisor's own code and message, so a `pi` wrapper relays a
   * refusal without re-reading it. `too_many_requests` and `invalid_input` are raised here, before a
   * frame exists, because they are about this call rather than about what it named.
   */
  invoke(method: string, params: Record<string, unknown>): Promise<unknown> {
    const budget = this.#budget.take()
    if (!budget.ok) return Promise.reject(new InvokeRefusal(budget.code, budget.message))
    this.#sequence += 1
    const id = `i${this.#sequence}`
    const line = encodeWorkerFrame({ type: 'worker_invoke', id, method, params })
    if (line === null) {
      this.#budget.release()
      return Promise.reject(new InvokeRefusal('invalid_input', OVERSIZED))
    }
    const pending = Promise.withResolvers<unknown>()
    this.#pendingInvokes.set(id, { resolve: pending.resolve, reject: pending.reject })
    this.#ports.writeLine(line)
    return pending.promise
  }

  /** One `worker_call`, answered asynchronously under its own id. */
  #acceptCall(frame: WorkerFrame): void {
    const id = workerFrameId(frame.id, PLUGIN_WORKER_ID_MAX)
    if (id === null) {
      this.log('warn', 'dropping a worker_call without a usable id')
      return
    }
    const method = typeof frame.method === 'string' ? frame.method : ''
    const params = frame.params
    this.#track(this.#runCall(id, method, params))
  }

  async #runCall(id: string, method: string, params: unknown): Promise<void> {
    let settlement: WorkerSettlement
    try {
      settlement = { ok: true, value: await this.#callValue(method, params) }
    } catch (error) {
      const code = error instanceof InvokeRefusal ? error.code : 'plugin_error'
      const message = sanitizeMessage(error instanceof Error ? error.message : String(error))
      // A refusal is the protocol working - `unknown_method`, a missing argument - and stays quiet.
      // A throw out of the plugin's own code is a fact about the plugin, and this is the only place
      // it can be captured: the answer goes back to the caller, and the line goes to the app log, so
      // a plugin that throws where nobody is reading the answer still leaves a trace.
      if (code === 'plugin_error') {
        this.log('warn', `the plugin's ${method === '' ? 'handler' : method} call failed: ${message}`)
      }
      settlement = { ok: false, code, message }
    }
    this.#settle('worker_result', id, settlement)
  }

  /** What one `worker_call` method does. Unknown methods are the supervisor's mistake, not a crash. */
  async #callValue(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'command.execute': {
        const fields = isRecord(params) ? params : {}
        const commandId = typeof fields.commandId === 'string' ? fields.commandId : ''
        if (commandId === '') throw new InvokeRefusal('invalid_input', 'command.execute needs a commandId.')
        const command = this.#registry.lookup(commandId)
        if (command === null) throw new InvokeRefusal('not_found', `The command ${commandId} is not registered.`)
        return command.handler(fields)
      }
      case 'activation': {
        const fields = isRecord(params) ? params : {}
        if (typeof fields.event !== 'string' || fields.event === '') {
          throw new InvokeRefusal('invalid_input', 'activation needs an event.')
        }
        this.#activation = fields.event
        return null
      }
      case 'renderer.call': {
        const hook = this.#module.onRendererCall
        if (typeof hook !== 'function') {
          throw new InvokeRefusal('unknown_method', 'This plugin serves no renderer.call methods.')
        }
        const fields = isRecord(params) ? params : {}
        const name = typeof fields.method === 'string' ? fields.method : ''
        if (name === '') throw new InvokeRefusal('invalid_input', 'renderer.call needs a method.')
        return (hook as RendererCall).call(this.#module, name, fields.params)
      }
      default:
        throw new InvokeRefusal('unknown_method', `This worker does not serve ${method || '(no method)'}.`)
    }
  }

  /**
   * `worker_event`: one delivery, handed to the handlers registered on its topic.
   *
   * The topic is the delivery's identity: a message to a topic nobody listens on is answered with
   * nothing (the subscription is the desktop's, and a process that unsubscribed locally by dropping
   * its handler keeps receiving until it asks not to - which is what `bus.subscribe` is for).
   */
  #acceptEvent(frame: WorkerFrame): void {
    const event = frame.event
    if (!isRecord(event) || typeof event.topic !== 'string' || event.topic === '') {
      this.log('warn', 'dropping a worker_event without a topic')
      return
    }
    const from = typeof event.from === 'string' ? event.from : ''
    this.#events.dispatch(event.topic, event.payload, from)
  }

  /** `worker_load`: recorded and answered; `onLoad` already ran before the handshake. */
  #acceptLoad(frame: WorkerFrame): void {
    const id = workerFrameId(frame.id, PLUGIN_WORKER_ID_MAX)
    if (id === null) {
      this.log('warn', 'dropping a worker_load without a usable id')
      return
    }
    const activation = frame.activation
    const event = isRecord(activation) && typeof activation.event === 'string' ? activation.event : null
    if (event === null) {
      this.#settle('worker_result', id, { ok: false, code: 'invalid_input', message: 'worker_load needs activation.event.' })
      return
    }
    this.#activation = event
    this.#settle('worker_result', id, { ok: true })
  }

  /** `worker_unload`: drain the handlers, run `onUnload`, answer, then leave. */
  #acceptUnload(frame: WorkerFrame): void {
    const id = workerFrameId(frame.id, PLUGIN_WORKER_ID_MAX)
    if (id === null) {
      this.log('warn', 'dropping a worker_unload without a usable id')
      return
    }
    this.#closing = true
    // Not tracked in `#inFlight`: `#drain` waits for the handlers, and a drain that awaited the
    // unload task itself would never finish.
    void this.#unload(id)
  }

  async #unload(id: string): Promise<void> {
    // No handler outlives the module that registered it: the delivery loop must not keep calling
    // into an unloading module, and a restarted process starts from what its code registers again.
    this.#events.clear()
    await this.#drain()
    let settlement: WorkerSettlement = { ok: true }
    const hook = this.#module.onUnload
    if (typeof hook === 'function') {
      try {
        await (hook as () => unknown).call(this.#module)
      } catch (error) {
        const message = sanitizeMessage(error instanceof Error ? error.message : String(error))
        this.log('warn', `the plugin's onUnload failed: ${message}`)
        settlement = {
          ok: false,
          code: 'plugin_error',
          message,
        }
      }
    }
    this.#settle('worker_result', id, settlement)
    this.#ports.exit(0)
  }

  /** `worker_invoke_result`: settle the invoke it names, or say why it settles nothing. */
  #acceptInvokeResult(frame: WorkerFrame): void {
    const id = workerFrameId(frame.id, PLUGIN_WORKER_ID_MAX)
    if (id === null) {
      this.log('warn', 'dropping a worker_invoke_result without a usable id')
      return
    }
    const pending = this.#pendingInvokes.get(id)
    if (pending === undefined) {
      this.log('warn', `dropping an answer for an invoke this worker did not send: ${id}`)
      return
    }
    this.#pendingInvokes.delete(id)
    this.#budget.release()
    if (frame.ok === true) {
      pending.resolve(frame.value)
      return
    }
    const code = typeof frame.code === 'string' && frame.code !== '' ? frame.code : 'internal'
    const message = typeof frame.message === 'string' && frame.message !== '' ? frame.message : 'The call was refused.'
    pending.reject(new InvokeRefusal(code, sanitizeMessage(message)))
  }

  /** Answers one request, replacing an answer the frame ceiling cannot carry. */
  #settle(type: 'worker_result' | 'worker_invoke_result', id: string, settlement: WorkerSettlement): void {
    const line = encodeWorkerFrame(settlementFrame(type, id, settlement))
    if (line !== null) {
      this.#ports.writeLine(line)
      return
    }
    // Only a `worker_result` ever reaches here (invoke answers are settled by the supervisor), and
    // the supervisor is waiting under this id: an unanswerable value becomes a refusal, not silence.
    const fallback = encodeWorkerFrame(settlementFrame(type, id, { ok: false, code: 'invalid_input', message: OVERSIZED }))
    if (fallback !== null) this.#ports.writeLine(fallback)
  }

  /** Sends one worker-authored frame, dropping (with a log line) one the ceiling cannot carry. */
  #send(frame: Record<string, unknown>): void {
    const line = encodeWorkerFrame(frame)
    if (line !== null) {
      this.#ports.writeLine(line)
      return
    }
    const reduced = encodeWorkerFrame(workerLogFrame('warn', 'dropped a plugin worker frame over the frame ceiling'))
    if (reduced !== null) this.#ports.writeLine(reduced)
  }

  #track(task: Promise<void>): void {
    this.#inFlight.add(task)
    void task.finally(() => this.#inFlight.delete(task))
  }

  /** Waits for every started handler, including ones started while another was finishing. */
  async #drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight])
    }
  }
}

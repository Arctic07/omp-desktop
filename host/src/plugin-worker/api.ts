/**
 * The `pi` surface a plugin's `onLoad(pi)` receives (plan §6.3).
 *
 * Every method here is a thin forwarder: the worker performs no gate logic at all, so a permission
 * decision, a scope check, a confirmation card and a refusal are all the Rust side's, and the answer
 * a plugin sees is the answer Rust gave - same code, same message, relayed verbatim. The method
 * names are `bridge/methods.rs::BridgeMethod`'s own spellings and that file is the list: `ready`,
 * `close`, `fs.read`, `fs.write`, `fs.delete`, `fs.stat`, `fs.list`, `fs.glob`, `fs.readRange`,
 * `fs.openDefault`, `fs.reveal`, `net.fetch`, `clipboard.read`, `clipboard.write`, `notify`, `log`,
 * `session.list`, `session.get`, `session.messages`, `session.rename`, `session.delete`,
 * `usage.turns`, `agent.complete`, `bus.publish`, `bus.subscribe`, `net.websocket.*`,
 * `shell.openExternal`, `browser.*` and `plugin.dataDir`. The names this file has and that list does
 * not are the worker's own: `plugin.settings.get` / `plugin.settings.set` (which Rust routes to the
 * existing `plugins_config_*` frames) and `command.register` / `command.unregister` /
 * `ui.openView` / `ui.reveal` (whose gates are Rust's too).
 *
 * A method this file has no field for is still reachable through `fetch('/__bridge')` for a page, and
 * through nothing at all for a worker - the surface here is the whole list a resident process has.
 *
 * The command registry is the one piece of state the worker keeps. It is bounded by the same count
 * the manifest is (`PLUGIN_DESKTOP_COMMANDS_MAX`) and every entry leaves on `unregister` or when the
 * process ends; additionally a handler only stays registered if the Rust side accepted the
 * registration, so the plugin's own view and the palette's cannot drift.
 */

import { PLUGIN_DESKTOP_COMMANDS_MAX, PLUGIN_WORKER_EVENT_HANDLERS_MAX, PLUGIN_WORKER_EVENTS_MAX } from '../constants.ts'
import type { WorkerLogLevel } from './frames.ts'

/** A refusal or a shape failure raised inside the worker, carrying the code the plugin branches on. */
export class InvokeRefusal extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'InvokeRefusal'
    this.code = code
  }
}

/** What the `.call` half of `worker_call` needs: one command handler, or `null`. */
export interface CommandHandler {
  readonly id: string
  readonly handler: (params: Record<string, unknown>) => unknown
}

/** The arguments one registration takes. */
export interface CommandRegistration {
  readonly id: string
  readonly title?: Record<string, string>
  readonly handler: (params: Record<string, unknown>) => unknown
}

/**
 * The command registry one worker owns.
 *
 * Owner: the worker process. Limit: `PLUGIN_DESKTOP_COMMANDS_MAX` entries. Release: `unregister`
 * removes one, a refused registration removes the tentative entry, and process exit drops the map.
 */
export class CommandRegistry {
  readonly #commands = new Map<string, CommandHandler>()

  /** The handler for one command id, or `null` when nothing is registered under it. */
  lookup(id: string): CommandHandler | null {
    return this.#commands.get(id) ?? null
  }

  /** How many commands are registered. */
  get size(): number {
    return this.#commands.size
  }

  /** Adds one entry, refusing a duplicate id or one past the bound. */
  add(registration: CommandRegistration): void {
    if (this.#commands.has(registration.id)) {
      throw new InvokeRefusal('invalid_request', `The command ${registration.id} is already registered.`)
    }
    if (this.#commands.size >= PLUGIN_DESKTOP_COMMANDS_MAX) {
      throw new InvokeRefusal('too_many_requests', `A plugin may register at most ${PLUGIN_DESKTOP_COMMANDS_MAX} commands.`)
    }
    this.#commands.set(registration.id, { id: registration.id, handler: registration.handler })
  }

  /** Removes one entry; answers whether there was one. */
  remove(id: string): boolean {
    return this.#commands.delete(id)
  }
}

/**
 * The event handlers one worker holds (`pi.events.on` / `off`, `omp.desktop` API 0.2.0).
 *
 * Owner: this worker process. Bound: `PLUGIN_WORKER_EVENTS_MAX` topics and
 * `PLUGIN_WORKER_EVENT_HANDLERS_MAX` handlers per topic - a plugin that subscribes in a loop is not
 * a reason for this process to hold an unbounded map. Release: `off` removes one, `clear` empties
 * everything when the module unloads, and process exit drops the map with it.
 *
 * Dispatch is the one place a bus message becomes a plugin call: the runtime hands a
 * `worker_event` frame here, and this class calls every handler registered on that topic. A handler
 * that throws is logged and does not stop the others - one plugin's mistake is not the next
 * subscriber's problem.
 */
export class EventHub {
  readonly #handlers = new Map<string, Set<(payload: unknown, from: string) => void>>()
  readonly #onError: (topic: string, error: unknown) => void

  constructor(onError: (topic: string, error: unknown) => void = () => {}) {
    this.#onError = onError
  }

  /** Registers one handler for one topic, refusing past the two ceilings. */
  on(topic: string, handler: (payload: unknown, from: string) => void): void {
    if (typeof handler !== 'function') {
      throw new InvokeRefusal('invalid_request', 'An event handler must be a function.')
    }
    const existing = this.#handlers.get(topic)
    if (existing === undefined && this.#handlers.size >= PLUGIN_WORKER_EVENTS_MAX) {
      throw new InvokeRefusal('too_many_requests', `A plugin may listen on at most ${PLUGIN_WORKER_EVENTS_MAX} topics.`)
    }
    const set = existing ?? new Set()
    if (set.size >= PLUGIN_WORKER_EVENT_HANDLERS_MAX) {
      throw new InvokeRefusal('too_many_requests', `A topic may have at most ${PLUGIN_WORKER_EVENT_HANDLERS_MAX} handlers.`)
    }
    set.add(handler)
    this.#handlers.set(topic, set)
  }

  /** Removes one handler, or every handler on one topic when none is named. */
  off(topic: string, handler?: (payload: unknown, from: string) => void): void {
    if (handler === undefined) {
      this.#handlers.delete(topic)
      return
    }
    const set = this.#handlers.get(topic)
    if (set === undefined) return
    set.delete(handler)
    if (set.size === 0) this.#handlers.delete(topic)
  }

  /** Hands one delivered message to every handler on its topic. */
  dispatch(topic: string, payload: unknown, from: string): number {
    const set = this.#handlers.get(topic)
    if (set === undefined) return 0
    let delivered = 0
    for (const handler of [...set]) {
      try {
        handler(payload, from)
        delivered += 1
      } catch (error) {
        this.#onError(topic, error)
      }
    }
    return delivered
  }

  /** Drops every handler: the module is unloading, so nothing it registered is still anybody's. */
  clear(): void {
    this.#handlers.clear()
  }

  /** How many topics have handlers, for the worker's own tests. */
  get size(): number {
    return this.#handlers.size
  }
}

/** The one channel the API uses to reach Rust: the worker runtime's invoke queue. */
export type InvokePort = (method: string, params: Record<string, unknown>) => Promise<unknown>

/** Everything `onLoad(pi)` may touch, as the frozen surface. */
export interface PluginApi {
  readonly plugin: {
    readonly id: string
    readonly installId: string
    readonly root: string
    readonly scope: 'user' | 'project'
    /** The engine's own plugin settings, read through Rust's `plugin.settings.get`. */
    getSettings(): Promise<unknown>
    /** One setting, written through Rust's `plugin.settings.set` (engine stays authoritative). */
    setSettings(key: string, value: unknown): Promise<unknown>
    /**
     * The one directory this plugin may write freely, created by the desktop on first ask.
     *
     * The path cannot be derived here and is not derived here: the desktop keys it by the
     * installation's own opaque origin key (`services::paths::plugin_data_dir`), so it is the one
     * fact a plugin cannot work out for itself - which is exactly what makes it the answer to "where
     * do I put a cache, a database or a downloaded file that survives an upgrade".
     */
    getDataPath(): Promise<string>
  }
  /** One line in `services::log`, through the bridge's own `log` method and its gates. */
  log(message: string, level?: WorkerLogLevel): void
  readonly commands: {
    register(registration: CommandRegistration): Promise<void>
    unregister(id: string): Promise<void>
  }
  readonly fs: {
    read(path: string, options?: Record<string, unknown>): Promise<unknown>
    write(path: string, text: string, options?: Record<string, unknown>): Promise<unknown>
    delete(path: string): Promise<unknown>
    /**
     * What is at one path: whether it is a directory, how large it is, when it was last written
     * (`omp.desktop` API 0.3.0).
     *
     * A directory is an answer rather than a `not_found`, which is the one thing this has over
     * `read`: a plugin that may reach a path still has no way to learn whether it is there, and the
     * two calls together are what make a granted reach a usable one.
     */
    stat(path: string): Promise<unknown>
    /** One directory's entries, bounded at the desktop's own ceiling (`truncated` says it was hit). */
    list(path: string): Promise<unknown>
    /**
     * Every entry a `/`-separated pattern names, bounded and sorted (`omp.desktop` API 0.3.0).
     *
     * The pattern language is the manifest's own `fs.read.scope` language: `*` inside one segment,
     * `**` for one or more whole segments, and `?`, `[]`, `{}` refused. A pattern with no literal
     * prefix starts at the workspace root (or the plugin's own package when there is none), and each
     * hit is a path in the same spelling the pattern used.
     */
    glob(pattern: string): Promise<unknown>
    /**
     * One byte range of one file, base64 (`omp.desktop` API 0.3.0).
     *
     * `offset` defaults to the start and `length` to the desktop's whole byte ceiling; an offset past
     * the end is an empty answer rather than an error. A `length` over the ceiling is refused.
     */
    readRange(path: string, options?: { offset?: number; length?: number }): Promise<unknown>
    /**
     * Hands one path to the system's own default program (`omp.desktop` API 0.3.0).
     *
     * Its own permission (`fs.openDefault`): a program file is refused whatever the plugin declares,
     * and so is a name the desktop's credential table covers.
     */
    openDefault(path: string): Promise<unknown>
    /** Shows one path in this machine's file manager (`fs.reveal`). */
    reveal(path: string): Promise<unknown>
  }
  readonly net: {
    /** One request on the hosts the manifest lists; `init` carries `method`/`contentType`/`body`. */
    fetch(url: string, init?: Record<string, unknown>): Promise<unknown>
    /** One socket through this application's own client (`omp.desktop` API 0.2.0). */
    readonly websocket: {
      connect(url: string): Promise<unknown>
      send(socketId: string, data: string): Promise<unknown>
      receive(socketId: string, options?: Record<string, unknown>): Promise<unknown>
      close(socketId: string): Promise<unknown>
    }
  }
  /** The session index, read-only: what this application lists, one conversation, its messages. */
  readonly session: {
    list(options?: Record<string, unknown>): Promise<unknown>
    get(sessionId: string): Promise<unknown>
    messages(sessionId: string, options?: Record<string, unknown>): Promise<unknown>
    /**
     * Renames one conversation (`omp.desktop` API 0.3.0). Its own permission (`session.write`).
     *
     * The conversation has to be one the index lists, and the rename goes through its own open
     * session: one that is not open answers `not_found`.
     */
    rename(sessionId: string, title: string): Promise<unknown>
    /** Deletes one conversation (`session.write`): its files leave the disk. */
    delete(sessionId: string): Promise<unknown>
  }
  /**
   * This application's own built-in browser (`omp.desktop` API 0.3.0), one page per installation.
   *
   * The page is the plugin's own: it is never the tab the reader has open, and no call can name
   * another conversation's page. Navigation is held to the manifest's `net.domains` exactly as
   * `net.fetch` is. There is no raw protocol channel here - no cookies, no storage, no DevTools.
   */
  readonly browser: {
    /** Navigates the plugin's page to one `http(s)` address the manifest lists. */
    navigate(url: string): Promise<unknown>
    /** Whether the plugin's page exists. Nothing is drawn for it: an installation is not a conversation. */
    reveal(): Promise<unknown>
    /** The page's accessibility tree. */
    snapshot(): Promise<unknown>
    /** One image of the page. */
    screenshot(options?: { fullPage?: boolean }): Promise<unknown>
    /** One expression evaluated in the page. */
    evaluate(expression: string): Promise<unknown>
    /** What the page has logged, at most `limit` entries. */
    console(options?: { limit?: number }): Promise<unknown>
    /** One navigation action: `back`, `forward`, `reload` or `stop`. */
    action(action: string): Promise<unknown>
  }
  /** The token and cost accounting this application already computes, one row per model call. */
  readonly usage: {
    turns(options?: Record<string, unknown>): Promise<unknown>
  }
  /** One completion on the models this application is configured with. */
  readonly agent: {
    complete(request: Record<string, unknown>): Promise<unknown>
  }
  /** The plugin bus: the publisher's own namespace, and any topic to listen on. */
  readonly bus: {
    publish(topic: string, payload?: unknown): Promise<unknown>
    subscribe(topics: string[]): Promise<unknown>
  }
  /** The system's own browser. */
  readonly shell: {
    openExternal(url: string): Promise<unknown>
  }
  /**
   * Messages delivered to this process: a bus message, on the topic it was published to.
   *
   * Registering is local (`off` is too) while the *subscription* is the desktop's: call
   * `bus.subscribe(topics)` to be delivered, and `events.on` to say what runs. A handler is given
   * the payload and the publisher's plugin id, which is the one attribution the desktop
   * guarantees (a topic's owner is part of its name).
   */
  readonly events: {
    on(topic: string, handler: (payload: unknown, from: string) => void): void
    off(topic: string, handler?: (payload: unknown, from: string) => void): void
  }
  readonly clipboard: {
    read(): Promise<unknown>
    write(text: string): Promise<unknown>
  }
  notify(title: string, body?: string): Promise<unknown>
  readonly ui: {
    openView(entryId: string): Promise<unknown>
    reveal(entryId: string): Promise<unknown>
  }
}

/** The argv values the surface reports unchanged. */
export interface PluginIdentity {
  readonly id: string
  readonly installId: string
  readonly root: string
  readonly scope: 'user' | 'project'
}

/** One non-empty string argument, or a shape refusal. */
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvokeRefusal('invalid_request', `${name} must be a non-empty string.`)
  }
  return value
}

/**
 * Builds the `pi` object for one worker.
 *
 * `invoke` is the runtime's queue, so every call here is subject to the same budgets as a call the
 * plugin makes directly - there is no side door that skips them.
 */
export function createPluginApi(
  identity: PluginIdentity,
  invoke: InvokePort,
  registry: CommandRegistry,
  events: EventHub = new EventHub(),
): PluginApi {
  const call = (method: string, params: Record<string, unknown>): Promise<unknown> => invoke(method, params)
  return {
    plugin: {
      ...identity,
      getSettings: () => call('plugin.settings.get', {}),
      setSettings: (key: string, value: unknown) => call('plugin.settings.set', { key: text(key, 'key'), value }),
      // The desktop answers with a path it created; a refusal here is the protocol working (no host
      // behind the call, a data root that cannot be resolved), and an answer without one is a
      // desktop this build cannot read - never a made-up path a plugin would then write to.
      async getDataPath(): Promise<string> {
        const answer = await call('plugin.dataDir', {})
        const path = answer !== null && typeof answer === 'object' && 'path' in answer ? answer.path : undefined
        if (typeof path !== 'string' || path === '') {
          throw new InvokeRefusal('internal', 'The plugin data directory could not be resolved.')
        }
        return path
      },
    },
    // Logging never throws into a plugin's control flow: a line that could not be sent (budget,
    // refused permission) is a diagnostic nobody is waiting on. The refusal is still Rust's.
    log: (message: string, level: WorkerLogLevel = 'info') => {
      void call('log', { level, message: text(message, 'message') }).catch(() => {})
    },
    commands: {
      async register(registration: CommandRegistration): Promise<void> {
        if (typeof registration !== 'object' || registration === null) {
          throw new InvokeRefusal('invalid_request', 'A command registration must be an object.')
        }
        const id = text(registration.id, 'id')
        if (typeof registration.handler !== 'function') {
          throw new InvokeRefusal('invalid_request', `The command ${id} has no handler.`)
        }
        registry.add({ id, title: registration.title, handler: registration.handler })
        try {
          await call('command.register', registration.title === undefined ? { id } : { id, title: registration.title })
        } catch (error) {
          // Rust refused the registration (no `command.register`, or an id the manifest did not
          // declare): the local registry must not keep a command the palette will never show.
          registry.remove(id)
          throw error
        }
      },
      async unregister(id: string): Promise<void> {
        const commandId = text(id, 'id')
        await call('command.unregister', { id: commandId })
        registry.remove(commandId)
      },
    },
    fs: {
      read: (path: string, options: Record<string, unknown> = {}) => call('fs.read', { ...options, path: text(path, 'path') }),
      write: (path: string, text_: string, options: Record<string, unknown> = {}) =>
        call('fs.write', { ...options, path: text(path, 'path'), text: text_ }),
      delete: (path: string) => call('fs.delete', { path: text(path, 'path') }),
      stat: (path: string) => call('fs.stat', { path: text(path, 'path') }),
      list: (path: string) => call('fs.list', { path: text(path, 'path') }),
      glob: (pattern: string) => call('fs.glob', { pattern: text(pattern, 'pattern') }),
      readRange: (path: string, options: { offset?: number; length?: number } = {}) =>
        call('fs.readRange', { ...options, path: text(path, 'path') }),
      openDefault: (path: string) => call('fs.openDefault', { path: text(path, 'path') }),
      reveal: (path: string) => call('fs.reveal', { path: text(path, 'path') }),
    },
    net: {
      fetch: (url: string, init: Record<string, unknown> = {}) => call('net.fetch', { ...init, url: text(url, 'url') }),
      websocket: {
        connect: (url: string) => call('net.websocket.connect', { url: text(url, 'url') }),
        send: (socketId: string, data: string) =>
          call('net.websocket.send', { socketId: text(socketId, 'socketId'), data }),
        receive: (socketId: string, options: Record<string, unknown> = {}) =>
          call('net.websocket.receive', { ...options, socketId: text(socketId, 'socketId') }),
        close: (socketId: string) => call('net.websocket.close', { socketId: text(socketId, 'socketId') }),
      },
    },
    session: {
      list: (options: Record<string, unknown> = {}) => call('session.list', options),
      get: (sessionId: string) => call('session.get', { sessionId: text(sessionId, 'sessionId') }),
      messages: (sessionId: string, options: Record<string, unknown> = {}) =>
        call('session.messages', { ...options, sessionId: text(sessionId, 'sessionId') }),
      rename: (sessionId: string, title: string) =>
        call('session.rename', { sessionId: text(sessionId, 'sessionId'), title: text(title, 'title') }),
      delete: (sessionId: string) => call('session.delete', { sessionId: text(sessionId, 'sessionId') }),
    },
    browser: {
      navigate: (url: string) => call('browser.navigate', { url: text(url, 'url') }),
      reveal: () => call('browser.reveal', {}),
      snapshot: () => call('browser.snapshot', {}),
      screenshot: (options: { fullPage?: boolean } = {}) => call('browser.screenshot', options),
      evaluate: (expression: string) => call('browser.evaluate', { expression: text(expression, 'expression') }),
      console: (options: { limit?: number } = {}) => call('browser.console', options),
      action: (action: string) => call('browser.action', { action: text(action, 'action') }),
    },
    usage: {
      turns: (options: Record<string, unknown> = {}) => call('usage.turns', options),
    },
    agent: {
      complete: (request: Record<string, unknown>) => call('agent.complete', request),
    },
    bus: {
      publish: (topic: string, payload: unknown = null) =>
        call('bus.publish', { topic: text(topic, 'topic'), payload }),
      subscribe: (topics: string[]) => {
        if (!Array.isArray(topics) || topics.length === 0) {
          throw new InvokeRefusal('invalid_request', 'bus.subscribe needs at least one topic.')
        }
        return call('bus.subscribe', { topics })
      },
    },
    shell: {
      openExternal: (url: string) => call('shell.openExternal', { url: text(url, 'url') }),
    },
    events: {
      on: (topic: string, handler: (payload: unknown, from: string) => void) =>
        events.on(text(topic, 'topic'), handler),
      off: (topic: string, handler?: (payload: unknown, from: string) => void) =>
        events.off(text(topic, 'topic'), handler),
    },
    clipboard: {
      read: () => call('clipboard.read', {}),
      write: (value: string) => call('clipboard.write', { text: value }),
    },
    notify: (title: string, body?: string) =>
      call('notify', body === undefined ? { title: text(title, 'title') } : { title: text(title, 'title'), body }),
    ui: {
      openView: (entryId: string) => call('ui.openView', { entryId: text(entryId, 'entryId') }),
      reveal: (entryId: string) => call('ui.reveal', { entryId: text(entryId, 'entryId') }),
    },
  }
}

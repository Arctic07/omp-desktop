/**
 * The worker's stdout writer: one encoded line at a time, in order, bounded.
 *
 * `process.stdout.write` is used with its completion callback rather than a descriptor write: the
 * worker has one producer (the runtime) and the supervisor reads line by line, so ordering is the
 * queue's order and backpressure is the callback's. A write that fails, or a queue that reaches
 * {@link PLUGIN_WORKER_OUTBOUND_MAX_BYTES}, means the supervisor is gone or has stopped reading -
 * the worker leaves with its own write-failed code, because nothing it emits can be delivered any
 * more (the same conclusion the host reaches on its sink).
 *
 * The queue is the only long-lived container here: owner is this writer, the limit is the constant
 * above, and the release point is the successful write of each line.
 */

import { Buffer } from 'node:buffer'

import { PLUGIN_WORKER_OUTBOUND_MAX_BYTES } from '../constants.ts'

export class WorkerWriter {
  readonly #queue: string[] = []
  readonly #onFailure: () => void
  #queuedBytes = 0
  #draining: Promise<void> | null = null
  #failed = false

  constructor(onFailure: () => void) {
    this.#onFailure = onFailure
  }

  /** True once a write or the queue ceiling ended the channel. */
  get failed(): boolean {
    return this.#failed
  }

  /** Queues one line (no newline) and starts the pump. */
  send(line: string): void {
    if (this.#failed) return
    const bytes = Buffer.byteLength(line, 'utf8') + 1
    if (this.#queuedBytes + bytes > PLUGIN_WORKER_OUTBOUND_MAX_BYTES) {
      this.#fail()
      return
    }
    this.#queue.push(line)
    this.#queuedBytes += bytes
    this.#pump()
  }

  /** Resolves once every queued line has been written, or the channel failed. */
  async flush(): Promise<void> {
    while (!this.#failed && (this.#queue.length > 0 || this.#draining !== null)) {
      if (this.#draining === null) this.#pump()
      const active = this.#draining
      if (active === null) continue
      await active
    }
  }

  #pump(): void {
    if (this.#failed || this.#draining !== null) return
    const line = this.#queue.shift()
    if (line === undefined) return
    this.#queuedBytes -= Buffer.byteLength(line, 'utf8') + 1
    const done = Promise.withResolvers<void>()
    this.#draining = done.promise
    try {
      process.stdout.write(`${line}\n`, error => {
        this.#draining = null
        if (error) {
          this.#fail()
        } else {
          this.#pump()
        }
        done.resolve()
      })
    } catch {
      this.#draining = null
      this.#fail()
      done.resolve()
    }
  }

  #fail(): void {
    if (this.#failed) return
    this.#failed = true
    this.#queue.length = 0
    this.#queuedBytes = 0
    this.#onFailure()
  }
}

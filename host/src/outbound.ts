/**
 * The single stdout writer.
 *
 * Frames are queued as physical lines and drained by one pump, so ordering is the order they were
 * enqueued and no two writers can interleave a chunk run.
 *
 * Writes go straight to the file descriptor: `process.stdout` buffers behind a pipe, so a frame
 * could sit unwritten until the process exited. A descriptor write is ordered and immediate, and
 * a full pipe yields `EAGAIN` instead of blocking, which is the backpressure signal sessions
 * read before they shed.
 *
 * The queue is this process's one unbounded-by-nature container, so it is bounded by
 * `OUTBOUND_QUEUE_BYTES` and that bound counts what is really outstanding: the lines waiting, plus
 * the batch being written right now. Counting only the waiting half would read "not congested" for
 * as long as the sink takes to accept a batch - which is exactly the moment a stalled reader stops
 * the pump - and every session would keep publishing into a queue nothing was draining.
 */

import { Buffer } from 'node:buffer'
import * as fs from 'node:fs'

import { OUTBOUND_QUEUE_BYTES } from './constants.ts'
import { encodeFrame, encodeLine } from './protocol/frames.ts'
import { logLine } from './log.ts'

/** How long to wait for a full pipe to drain before retrying. */
const WRITE_RETRY_MS = 1

export class FrameWriter {
  #queue: string[] = []
  #queuedBytes = 0
  #writingBytes = 0
  #draining: Promise<void> | null = null
  #failed = false
  readonly #onEncodeFailure: (frame: unknown, reason: string) => void
  readonly #onWriteFailure: (reason: string) => void

  constructor(
    onEncodeFailure: (frame: unknown, reason: string) => void = () => {},
    onWriteFailure: (reason: string) => void = () => {},
  ) {
    this.#onEncodeFailure = onEncodeFailure
    this.#onWriteFailure = onWriteFailure
  }

  /**
   * True while more than {@link OUTBOUND_QUEUE_BYTES} is outstanding.
   *
   * Sessions read this before flushing: a stalled reader must make each session shed its own
   * increments instead of letting the writer's queue grow without bound.
   */
  get congested(): boolean {
    return this.#queuedBytes + this.#writingBytes > OUTBOUND_QUEUE_BYTES
  }

  /** True once the sink refused a write; nothing this process emits can reach the reader again. */
  get failed(): boolean {
    return this.#failed
  }

  /** Serializes and enqueues one logical frame; oversized frames become a chunk run. */
  send(frame: unknown): void {
    if (this.#failed) return
    try {
      this.#enqueue(encodeFrame(frame))
    } catch (error) {
      this.#reportEncodeFailure(frame, error)
    }
  }

  /**
   * Enqueues one session frame whose body is already serialized (`SessionEvents`).
   *
   * The line arrives with the session identity and sequence number already in it, so nothing here
   * serializes the frame a second time; the physical-line ceiling and the chunk run are still
   * enforced, on exactly the line that would have been written.
   */
  sendLine(line: string, sessionId: string): void {
    if (this.#failed) return
    try {
      this.#enqueue(encodeLine(line))
    } catch (error) {
      this.#reportEncodeFailure({ sessionId }, error)
    }
  }

  /** Resolves the sink directly, for tests and for callers that must not use a pipe. */
  async flush(): Promise<void> {
    while (this.#draining !== null || this.#queue.length > 0) {
      await (this.#draining ?? Promise.resolve())
    }
  }

  #enqueue(lines: string[]): void {
    for (const line of lines) {
      this.#queue.push(`${line}\n`)
      this.#queuedBytes += Buffer.byteLength(line, 'utf8') + 1
    }
    void this.#drain()
  }

  #reportEncodeFailure(frame: unknown, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error)
    logLine(`frame encoding failed: ${reason}`)
    this.#onEncodeFailure(frame, reason)
  }

  async #drain(): Promise<void> {
    if (this.#draining !== null) return
    this.#draining = this.#pump()
    await this.#draining
  }

  async #pump(): Promise<void> {
    try {
      while (this.#queue.length > 0) {
        const batch = Buffer.from(this.#queue.join(''), 'utf8')
        // The batch stays counted until it is written: from the sink's point of view these bytes are
        // still outstanding, and a session that read "not congested" here would publish the next
        // increment on top of a queue that is not moving.
        this.#writingBytes = this.#queuedBytes
        this.#queue.length = 0
        this.#queuedBytes = 0
        await this.#writeAll(batch)
        this.#writingBytes = 0
      }
    } catch (error) {
      this.#failed = true
      this.#queue.length = 0
      this.#queuedBytes = 0
      this.#writingBytes = 0
      const reason = error instanceof Error ? error.message : String(error)
      logLine(`stdout write failed: ${reason}`)
      // The reader is gone or the descriptor is unusable, and every later frame - protocol
      // responses included - would be dropped here in silence. Reporting it is the one thing this
      // side can still do about it: nothing can be written, so the caller decides what a host that
      // can no longer be heard from does next (`main.ts`).
      this.#onWriteFailure(reason)
    } finally {
      this.#draining = null
    }
  }

  async #writeAll(batch: Buffer): Promise<void> {
    let offset = 0
    while (offset < batch.length) {
      try {
        offset += fs.writeSync(1, batch, offset, batch.length - offset)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error
        // The reader is behind: yield so the event loop keeps running, then retry.
        await new Promise(resolve => setTimeout(resolve, WRITE_RETRY_MS))
      }
    }
  }
}

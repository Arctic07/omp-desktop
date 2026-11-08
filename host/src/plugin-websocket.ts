/**
 * `net.websocket`: the sockets a plugin holds, kept in this process's own client (`omp.desktop` API
 * 0.2.0).
 *
 * This is where the socket actually lives, and the reason it lives *here* rather than in the plugin's
 * own worker is the same one `net.fetch` has: the egress decision is the desktop's
 * (`src-tauri/src/services/plugins/bridge/capabilities.rs` checks the scheme and the manifest's host
 * list before a frame is ever sent), and a socket opened by the plugin's own code would be a second
 * client nobody gated. The worker asks this process to open, send, receive and close; the desktop
 * counts how many an installation holds.
 *
 * Four properties are this module's own:
 *
 * - **One id, one socket.** The id is the desktop's (`services::plugins::sockets`), so a plugin never
 *   chooses one; a second `open` for an id already open is refused rather than replacing the first.
 * - **A bounded inbox.** At most `PLUGIN_WS_PENDING_MAX` frames wait for a `receive`, and a frame over
 *   `PLUGIN_WS_FRAME_BYTES_MAX` is dropped *and counted* rather than queued: a plugin that never reads
 *   costs this process a fixed number of bytes, and the frame it lost is something it can observe.
 * - **A poll, not a push.** `receive` waits at most the caller's `waitMs` for the next frame. This
 *   application has no channel that can call into a plugin page or a worker asynchronously; the one
 *   push lane it has is the bus's, and a socket that pushed on it would put two very different
 *   deliveries behind one subscription model.
 * - **Nothing outlives its owner.** `closeOwner` closes every socket one installation opened, and the
 *   desktop calls it when that installation stops, is disabled or is uninstalled.
 */

import { Buffer } from 'node:buffer'

import { PLUGIN_WS_FRAME_BYTES_MAX, PLUGIN_WS_PENDING_MAX, PLUGIN_WS_SOCKETS_MAX } from './constants.ts'
import { ERROR_CODES, HostError, invalidInput } from './protocol/errors.ts'

/** One frame waiting to be received: the text the peer sent, as the caller reads it. */
interface PendingFrame {
  readonly data: string
}

/** One open socket and its inbox. */
interface OpenSocket {
  readonly socket: WebSocket
  readonly owner: string
  readonly queue: PendingFrame[]
  /** Frames dropped because they were over the ceiling or the inbox was full. */
  dropped: number
  /** The `receive` call waiting for the next frame, when one is. */
  waiter: ((frames: PendingFrame[]) => void) | null
  closed: boolean
  closeInfo: { code: number; reason: string } | null
}

/**
 * The sockets this process holds.
 *
 * Owner: the host process (one instance, `sockets` at the bottom of this file). Bound: the desktop's
 * own eight-per-installation ceiling is the outer one, and this map holds at most the ids that were
 * issued for a live installation. Release: `close`, the peer's own close, and `closeOwner`.
 */
export class PluginSocketTable {
  readonly #sockets = new Map<string, OpenSocket>()

  /** How many sockets one owner holds - the ceiling the desktop enforces, checked here too. */
  openCount(owner: string): number {
    let count = 0
    for (const entry of this.#sockets.values()) if (entry.owner === owner) count += 1
    return count
  }

  /**
   * Opens one socket and answers when the handshake finished, or throws what stopped it.
   *
   * The wait for `onopen` is what makes a refused connection an error the plugin sees at `connect`
   * rather than at its first `send`: a socket that never opened would otherwise look usable.
   */
  async open(socketId: string, url: string, owner: string): Promise<void> {
    if (this.#sockets.has(socketId)) {
      throw new HostError(ERROR_CODES.invalid_input, `The socket ${socketId} is already open.`)
    }
    if (this.openCount(owner) >= PLUGIN_WS_SOCKETS_MAX) {
      throw new HostError(ERROR_CODES.host_busy, `An installation may hold ${PLUGIN_WS_SOCKETS_MAX} sockets.`)
    }
    const socket = new WebSocket(url)
    const entry: OpenSocket = {
      socket,
      owner,
      queue: [],
      dropped: 0,
      waiter: null,
      closed: false,
      closeInfo: null,
    }
    this.#sockets.set(socketId, entry)
    socket.onmessage = event => this.#receive(socketId, event.data)
    socket.onclose = event => {
      entry.closed = true
      entry.closeInfo = { code: event.code, reason: event.reason }
      this.#wake(entry, [])
    }
    socket.onerror = () => {
      // `onclose` always follows an error, and it is the one that carries the reason. Nothing is
      // recorded here that the close would not say better.
    }
    try {
      await opened(socket, url)
    } catch (error) {
      this.#sockets.delete(socketId)
      try {
        socket.close()
      } catch {
        // A socket that never opened has nothing to close.
      }
      throw error
    }
  }

  /**
   * Sends one frame, answering how many bytes went out.
   *
   * The plugin hands over a string and the socket sends it as a **text** frame when those bytes are
   * valid UTF-8 - which is every JSON protocol, and every server that closes on an unexpected binary
   * frame. Bytes that are not text are sent as a binary frame rather than mangled into replacement
   * characters, so a caller with a binary protocol still has a way through.
   */
  send(socketId: string, base64: string): { bytes: number; binary: boolean } {
    const entry = this.#require(socketId)
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length > PLUGIN_WS_FRAME_BYTES_MAX) {
      throw invalidInput(`A frame may carry at most ${PLUGIN_WS_FRAME_BYTES_MAX} bytes.`)
    }
    const text = bytes.toString('utf8')
    const binary = !Buffer.from(text, 'utf8').equals(bytes)
    entry.socket.send(binary ? bytes : text)
    return { bytes: bytes.length, binary }
  }

  /** Closes one socket; the peer's answer arrives as a normal close. */
  close(socketId: string): void {
    const entry = this.#sockets.get(socketId)
    if (entry === undefined) return
    this.#sockets.delete(socketId)
    try {
      entry.socket.close()
    } catch {
      // Already closed by the peer: the table entry is gone either way.
    }
    entry.closed = true
    this.#wake(entry, [])
  }

  /** Closes every socket one installation opened. */
  closeOwner(owner: string): number {
    let closed = 0
    for (const [id, entry] of [...this.#sockets]) {
      if (entry.owner !== owner) continue
      this.close(id)
      closed += 1
    }
    return closed
  }

  /**
   * Waits up to `waitMs` for what the socket has buffered, and answers at most `limit` frames.
   *
   * A socket that has closed answers the frames it still holds and then says so, so a plugin learns
   * that the stream ended instead of polling an empty inbox forever.
   */
  async receive(socketId: string, waitMs: number, limit: number): Promise<Record<string, unknown>> {
    const entry = this.#require(socketId)
    let frames = entry.queue.splice(0, limit)
    if (frames.length === 0 && !entry.closed && waitMs > 0) {
      frames = await this.#hold(entry, waitMs, limit)
    }
    return {
      frames: frames.map(frame => ({ data: frame.data })),
      // Frames the peer sent that this socket could not keep: over the ceiling, or dropped from a full
      // inbox. Counted once, where they were lost - the reader is told what it did not get.
      dropped: entry.dropped,
      closed: entry.closed,
      ...(entry.closeInfo === null ? {} : { closeCode: entry.closeInfo.code, closeReason: entry.closeInfo.reason }),
    }
  }

  /** One inbound frame: queued, handed to a waiter, or counted as dropped. */
  #receive(socketId: string, data: unknown): void {
    const entry = this.#sockets.get(socketId)
    if (entry === undefined) return
    const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')
    const frame: PendingFrame = {
      data: Buffer.from(text, 'utf8').subarray(0, PLUGIN_WS_FRAME_BYTES_MAX).toString('utf8'),
    }
    if (text.length > PLUGIN_WS_FRAME_BYTES_MAX) entry.dropped += 1
    if (entry.waiter !== null) {
      // A waiter takes the frame directly: queueing it first and waking the waiter afterwards would
      // let a second `receive` take what the first was promised.
      const waiter = entry.waiter
      entry.waiter = null
      waiter([frame])
      return
    }
    if (entry.queue.length >= PLUGIN_WS_PENDING_MAX) {
      entry.queue.shift()
      entry.dropped += 1
    }
    entry.queue.push(frame)
  }

  /** Holds one `receive` until a frame arrives or the wait expires. */
  #hold(entry: OpenSocket, waitMs: number, limit: number): Promise<PendingFrame[]> {
    const { promise, resolve } = Promise.withResolvers<PendingFrame[]>()
    const timer = setTimeout(() => {
      entry.waiter = null
      resolve([])
    }, waitMs)
    entry.waiter = frames => {
      clearTimeout(timer)
      // The waiter took the first frame; anything else already queued is taken with it, so a burst
      // is answered in one call rather than one frame per poll.
      const rest = entry.queue.splice(0, Math.max(0, limit - frames.length))
      resolve([...frames, ...rest])
    }
    return promise
  }

  /** Hands a waiting `receive` its answer (the close path uses this with an empty list). */
  #wake(entry: OpenSocket, frames: PendingFrame[]): void {
    const waiter = entry.waiter
    if (waiter === null) return
    entry.waiter = null
    waiter(frames)
  }

  #require(socketId: string): OpenSocket {
    const entry = this.#sockets.get(socketId)
    if (entry === undefined) {
      throw new HostError(ERROR_CODES.session_not_found, `Unknown socket ${socketId}.`)
    }
    return entry
  }
}

/** Resolves when the socket's handshake finished; rejects with what stopped it. */
async function opened(socket: WebSocket, url: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const timer = setTimeout(
    () => reject(new HostError(ERROR_CODES.timeout, `The socket to ${url} did not open.`)),
    15_000,
  )
  socket.onopen = () => {
    clearTimeout(timer)
    resolve()
  }
  const failed = () => {
    clearTimeout(timer)
    reject(new HostError(ERROR_CODES.engine_request_failed, `The socket to ${url} could not be opened.`))
  }
  socket.addEventListener('error', failed, { once: true })
  socket.addEventListener('close', failed, { once: true })
  await promise
}

/** The one table this process holds. */
export const sockets = new PluginSocketTable()

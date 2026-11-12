/**
 * The host client the smoke driver runs scenarios against.
 *
 * One instance launches one real host process (source tree, the built bundle, or the installed
 * bundle), records every frame in both directions with its arrival time, and answers the two
 * questions a scenario asks: "send this command" and "wait until this frame arrives". Scenario
 * logic and evidence layout live in `smoke.ts`.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { ChunkReassembler, LineScanner } from '../src/protocol/frames.ts'
import { BUNDLE_DIRNAME, type BundleManifest } from './packages.ts'

export const repoRoot = path.resolve(import.meta.dir, '..', '..')
export const evidenceDir = path.join(repoRoot, 'host', 'evidence')
/**
 * Data root every host under test is launched with.
 *
 * Defaults to the smoke's own scratch directory; `OMP_DESKTOP_SMOKE_DATA_ROOT` points a run at a fresh root,
 * which is how "the suite needs nothing but what it writes itself" is demonstrated rather than
 * assumed.
 */
export const dataRoot = path.resolve(process.env.OMP_DESKTOP_SMOKE_DATA_ROOT ?? path.join(repoRoot, 'host', '.dev-data', 'data'))
export const workspace = path.join(dataRoot, 'workspace')
export const installedBundle = path.join(repoRoot, 'src-tauri', 'binaries', BUNDLE_DIRNAME)

/** How the host under test is launched. */
export type HostMode = 'src' | 'dist' | 'installed'

/** One recorded frame, either direction. */
export interface RecordedFrame {
  readonly at: number
  readonly direction: 'in' | 'out'
  readonly frame: Record<string, unknown>
}

/** A launched host process with a frame log. */
export class HostProcess {
  readonly mode: HostMode
  readonly tag: string
  readonly frames: RecordedFrame[] = []
  readonly stderrChunks: string[] = []
  /** Physical `rpc_chunk` lines seen on stdout, which is how a chunked outbound frame shows up. */
  chunkLines = 0
  /** When the process was spawned, so spawn→hello and spawn→ready are measurable. */
  readonly spawnedAt = Date.now()
  /** Spawn→hello and spawn→ready, filled in by the handshake. */
  helloMs: number | null = null
  readyMs: number | null = null
  /** When set, the stdout pump stops reading so the host's writes block on a full pipe. */
  #paused = false
  readonly #proc: BunSubprocess
  readonly #scanner = new LineScanner()
  readonly #chunks = new ChunkReassembler()
  #reader: Promise<void>
  #exitCode: number | null = null
  #sent = 0

  constructor(mode: HostMode, tag: string, extraEnv: Record<string, string> = {}) {
    this.mode = mode
    this.tag = tag
    this.#proc = Bun.spawn({
      cmd: HostProcess.#command(mode),
      cwd: repoRoot,
      env: HostProcess.#environment(extraEnv),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    this.#reader = this.#pump()
    void this.#drainStderr()
    void this.#proc.exited.then(code => {
      this.#exitCode = code
    })
  }

  static #command(mode: HostMode): string[] {
    const args = ['--data-root', dataRoot]
    if (mode === 'src') return [process.execPath, path.join(repoRoot, 'host', 'src', 'main.ts'), ...args]
    // `dist` and `installed` are the same bundle shape, one before and one after the installer
    // copies it: its manifest names the runtime and the invocation, and the launcher rebuilds the
    // command from exactly those two facts (`host_bin::verify_bundle`). A missing bundle is an
    // error, not a fallback to another layout.
    const directory = mode === 'dist' ? path.join(repoRoot, 'host', 'dist', BUNDLE_DIRNAME) : installedBundle
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as BundleManifest
    const runtime = manifest.files.find(file => file.role === 'runtime')
    if (runtime === undefined) throw new Error(`${directory} names no runtime`)
    // The manifest records the invocation the launcher reproduces: flags, then the entry. The entry
    // is resolved against the bundle, not the working directory - the same rule the launcher applies
    // (`host_bin::verify_bundle`), because a relative name would start nothing.
    const invocation = [...manifest.argv.slice(0, -1), path.join(directory, manifest.entry)]
    return [path.join(directory, runtime.file), ...invocation, ...args]
  }

  /** The launcher clears the environment and passes only what the host is allowed to read. */
  static #environment(extra: Record<string, string>): Record<string, string> {
    const allowed = [
      'SystemRoot',
      'SystemDrive',
      'windir',
      'COMSPEC',
      'PATHEXT',
      'TEMP',
      'TMP',
      'APPDATA',
      'LOCALAPPDATA',
      'NUMBER_OF_PROCESSORS',
      'PROCESSOR_ARCHITECTURE',
    ]
    const environment: Record<string, string> = { PATH: process.env.PATH ?? '' }
    for (const key of allowed) {
      const value = process.env[key]
      if (value !== undefined) environment[key] = value
    }
    // Both names for the agent directory, exactly as the app's launcher passes them
    // (`src-tauri/src/services/runtime/host/process.rs`): the engine reads its own key, the host
    // pins and asserts both. A harness that passed one would keep working while the two drift.
    environment.PI_CODING_AGENT_DIR = path.join(dataRoot, 'host', 'agent')
    environment.OMP_DESKTOP_CODING_AGENT_DIR = path.join(dataRoot, 'host', 'agent')
    environment.PI_CONFIG_DIR = 'omp-desktop'
    environment.OMP_WORKTREE_DIR = path.join(dataRoot, 'host', 'worktrees')
    environment.XDG_DATA_HOME = path.join(dataRoot, 'host', 'xdg')
    environment.HOME = path.join(dataRoot, 'home')
    environment.USERPROFILE = path.join(dataRoot, 'home')
    // The F4 test knob, forwarded only when the operator set it for this smoke run.
    const uiTimeout = process.env.OMP_DESKTOP_UI_REQUEST_TIMEOUT_MS
    if (uiTimeout !== undefined) environment.OMP_DESKTOP_UI_REQUEST_TIMEOUT_MS = uiTimeout
    return { ...environment, ...extra }
  }

  async #pump(): Promise<void> {
    const reader = (this.#proc.stdout as ReadableStream<Uint8Array>).getReader()
    for (;;) {
      while (this.#paused) await new Promise(resolve => setTimeout(resolve, 25))
      const { done, value } = await reader.read()
      if (done === true) return
      for (const event of this.#scanner.push(value)) {
        if (event.kind !== 'line' || event.text.trim() === '') continue
        let parsed: unknown
        try {
          parsed = JSON.parse(event.text)
        } catch {
          this.stderrChunks.push(`[smoke] unparseable host line: ${event.text.slice(0, 200)}\n`)
          continue
        }
        const frame = parsed as Record<string, unknown>
        if (frame.type === 'rpc_chunk') {
          this.chunkLines += 1
          const reassembled = this.#chunks.accept(frame)
          if (reassembled === null) continue
          this.frames.push({ at: Date.now(), direction: 'in', frame: reassembled })
          continue
        }
        this.frames.push({ at: Date.now(), direction: 'in', frame })
      }
    }
  }

  async #drainStderr(): Promise<void> {
    const reader = (this.#proc.stderr as ReadableStream<Uint8Array>).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) return
      this.stderrChunks.push(Buffer.from(value).toString('utf8'))
    }
  }

  get exitCode(): number | null {
    return this.#exitCode
  }

  /** Sends one command frame; ids are generated when the caller does not care. */
  send(frame: Record<string, unknown>): string {
    this.#sent += 1
    const id = typeof frame.id === 'string' ? frame.id : `c${this.#sent}`
    const outgoing = { ...frame, id }
    this.frames.push({ at: Date.now(), direction: 'out', frame: outgoing })
    this.#proc.stdin.write(`${JSON.stringify(outgoing)}\n`)
    this.#proc.stdin.flush()
    return id
  }

  /**
   * Sends a raw line, for the malformed-input cases.
   *
   * `newline: false` writes the bytes without a terminator, which is the only way to express a
   * line split across two reads - the shape the ceiling rules have to treat like any other.
   */
  sendRaw(line: string, newline = true): void {
    this.#proc.stdin.write(newline ? `${line}\n` : line)
    this.#proc.stdin.flush()
  }

  /** Sends one hand-built `rpc_chunk` line, so malformed runs can be expressed exactly. */
  sendRawChunk(chunk: { chunkId: string; index: number; count: number; byteLength: number; data: string }): void {
    this.sendRaw(JSON.stringify({ type: 'rpc_chunk', ...chunk }))
  }

  /** Stops reading stdout; the host's writes then block on a full pipe, which is the pressure. */
  pauseReading(): void {
    this.#paused = true
  }

  /** Resumes reading and waits for the host to drain what it buffered. */
  async resumeReading(): Promise<void> {
    this.#paused = false
  }

  /**
   * Sends one logical frame as an `rpc_chunk` run, the way a client exceeds the physical ceiling.
   *
   * Returns the logical frame's request id so the response can still be awaited.
   */
  sendChunked(frame: Record<string, unknown>, payloadBytes = 512 * 1024): string {
    this.#sent += 1
    const id = typeof frame.id === 'string' ? frame.id : `c${this.#sent}`
    const bytes = Buffer.from(JSON.stringify({ ...frame, id }), 'utf8')
    const pieces: Buffer[] = []
    for (let offset = 0; offset < bytes.length; offset += payloadBytes) {
      pieces.push(bytes.subarray(offset, Math.min(offset + payloadBytes, bytes.length)))
    }
    const chunkId = `smoke-${this.#sent}`
    this.frames.push({ at: Date.now(), direction: 'out', frame: { type: 'rpc_chunk', chunkId, count: pieces.length, id } })
    pieces.forEach((piece, index) => {
      this.#proc.stdin.write(
        `${JSON.stringify({ type: 'rpc_chunk', chunkId, index, count: pieces.length, byteLength: bytes.length, data: piece.toString('base64') })}\n`,
      )
    })
    this.#proc.stdin.flush()
    return id
  }

  /** Waits until a frame matches, returning it; throws with the frame log when it never does. */
  async waitFor<T extends Record<string, unknown>>(
    label: string,
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs = 120_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.frames.find(entry => entry.direction === 'in' && predicate(entry.frame))
      if (hit !== undefined) return hit.frame as T
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (${this.tag})`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  /** Waits for the response to one request id. */
  response(id: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    return this.waitFor(`response ${id}`, frame => frame.type === 'response' && frame.id === id, timeoutMs)
  }

  /** Frames of one type, in arrival order. */
  of(type: string): Record<string, unknown>[] {
    return this.frames.filter(entry => entry.direction === 'in' && entry.frame.type === type).map(entry => entry.frame)
  }

  async stop(): Promise<void> {
    try {
      this.#proc.stdin.end()
    } catch {}
    await Promise.race([this.#proc.exited, new Promise(resolve => setTimeout(resolve, 15_000))])
  }

  /** Waits for the process to leave and stops recording. */
  async finish(): Promise<number> {
    const code = await Promise.race([
      this.#proc.exited,
      new Promise<number>(resolve => setTimeout(() => resolve(-1), 20_000)),
    ])
    await this.#reader.catch(() => {})
    return code
  }

  /** Writes this run's frames and stderr into the evidence directory. */
  flushEvidence(): { frames: string; stderr: string } {
    const frames = path.join(evidenceDir, `w2-${this.tag}.frames.jsonl`)
    const stderr = path.join(evidenceDir, `w2-${this.tag}.stderr.log`)
    fs.writeFileSync(frames, `${this.frames.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
    fs.writeFileSync(stderr, this.stderrChunks.join(''), 'utf8')
    return { frames, stderr }
  }
}

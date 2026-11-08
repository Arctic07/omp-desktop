/**
 * `omp-host.exe --plugin-worker`: the worker process, from argv to exit.
 *
 * The order is the protocol's (plan §6.2): reset the environment and `cwd` before any plugin code
 * exists, resolve and evaluate the entry, run `onLoad(pi)` - which may already call back through
 * `worker_invoke`, so the writer is alive first - and only then announce `worker_hello`. After that
 * the process is a line loop until stdin closes or `worker_unload` answers.
 *
 * Nothing here imports, initializes or pins an engine module: the worker's whole world is
 * `package.json`, the plugin's own entry, and the frames on stdout/stdin.
 */

import type { PluginApi } from './api.ts'
import { applyWorkerEnvironment } from './environment.ts'
import { WorkerStartupError, loadEntry, type LoadedEntry } from './entry.ts'
import { WORKER_EXIT_WRITE_FAILED, workerFatal } from './fatal.ts'
import { parseWorkerFrame } from './frames.ts'
import { WorkerWriter } from './output.ts'
import type { PluginWorkerOptions } from './argv.ts'
import { WorkerRuntime } from './runtime.ts'
import { LineScanner, oversizedLineRequestId } from '../protocol/frames.ts'
import { MAX_FRAME_BYTES } from '../constants.ts'

/** The sentence an oversized inbound line is answered with, when its id can be recovered. */
const OVERSIZED_INBOUND = `The inbound frame exceeds the ${MAX_FRAME_BYTES} byte plugin worker ceiling.`

/**
 * Runs one worker until it is asked to leave. Never returns normally: every termination path is a
 * `process.exit` (the supervisor watches for it), and the code says which path it was.
 */
export async function runPluginWorker(options: PluginWorkerOptions): Promise<void> {
  try {
    applyWorkerEnvironment(options.root)
  } catch (error) {
    workerFatal('not_found', `The plugin root could not be entered: ${error instanceof Error ? error.message : String(error)}`)
  }

  const writer = new WorkerWriter(() => process.exit(WORKER_EXIT_WRITE_FAILED))
  const runtime = new WorkerRuntime({
    identity: { id: options.pluginId, installId: options.installId, root: options.root, scope: options.scope },
    ports: {
      writeLine: line => writer.send(line),
      exit: code => {
        void writer.flush().then(() => process.exit(code))
      },
    },
  })

  let loaded: LoadedEntry
  try {
    loaded = await loadEntry(options.root)
  } catch (error) {
    if (error instanceof WorkerStartupError) workerFatal(error.code, error.message)
    workerFatal('internal', error instanceof Error ? error.message : String(error))
  }
  runtime.setModule(loaded.module)

  // The read loop starts *before* `onLoad`, because `onLoad` may already await a `pi.*` call: the
  // answer to that invoke is a frame on stdin, and a loop started after the handshake would deadlock
  // against the protocol's own ordering (`worker_hello` only after `onLoad` returns).
  const stdinClosed = startFrameLoop(runtime)

  try {
    await (loaded.module.onLoad as (pi: PluginApi) => unknown)(runtime.api)
  } catch (error) {
    // An `onLoad` that throws is a startup refusal, not a crash state to back off from: the plugin
    // never became live, and the supervisor's answer is `crashed` with this redacted reason.
    workerFatal('internal', `onLoad failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  runtime.handshake(loaded.entry)

  await stdinClosed
  // stdin closed: the supervisor is gone, so there is nobody left to serve and nothing to answer.
  await writer.flush()
  process.exit(0)
}

/** Reads stdin until it closes, handing every decoded frame to the runtime. */
async function startFrameLoop(runtime: WorkerRuntime): Promise<void> {
  const scanner = new LineScanner()
  const reader = Bun.stdin.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done === true) return
    for (const event of scanner.push(value as Uint8Array)) {
      if (event.kind === 'overflow') {
        runtime.log('warn', `dropping an oversized inbound plugin worker line (${event.bytes} bytes)`)
        const id = oversizedLineRequestId(event.text)
        if (id !== null) runtime.refuseRequest(id, 'invalid_input', OVERSIZED_INBOUND)
        continue
      }
      const frame = parseWorkerFrame(event.text)
      if (frame === null) {
        runtime.log('warn', 'dropping an inbound plugin worker line that is not a frame')
        continue
      }
      runtime.accept(frame)
    }
  }
}

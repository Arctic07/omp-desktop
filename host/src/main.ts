/**
 * The one executable entry point: worker mode, the engine's worker selector, or an ordinary host run.
 *
 * Order is contractual (contract §2.1/§5) and this file is where it starts:
 *
 * 1. A compiled build re-entered with an engine worker selector (`__omp_worker_*`) is handed to the
 *    engine's own CLI dispatch and returns without pinning anything. `sdk.ts` is safe to import
 *    statically for that check: its engine references are all type imports, and the runtime loads
 *    happen inside `loadSdk()`.
 * 2. `--plugin-worker` turns this process into a plugin worker (plan §6.2): a separate protocol on
 *    stdin/stdout, no engine module, no environment pin, no `hello`, no stdin claim by the host.
 *    It is checked *before* the ordinary host module is even loaded, which is what guarantees the
 *    worker never evaluates the engine graph (see `host-run.ts`).
 * 3. Otherwise the ordinary host is imported lazily and run to completion.
 *
 * stdout carries protocol frames and nothing else on every path.
 */

import { logLine } from './log.ts'
import { fatalHostFailure } from './host-fatal.ts'
import { parsePluginWorkerArgv } from './plugin-worker/argv.ts'
import { workerFatal } from './plugin-worker/fatal.ts'
import { runPluginWorker } from './plugin-worker/index.ts'
import { handOffCompiledWorkerSelector } from './sdk.ts'

/** Whether this process was launched as a plugin worker (the final catch reports accordingly). */
let workerMode = false

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  if (await handOffCompiledWorkerSelector(argv)) return

  const launch = parsePluginWorkerArgv(argv)
  if (launch.kind === 'invalid') workerFatal('invalid_input', launch.message)
  if (launch.kind === 'worker') {
    workerMode = true
    await runPluginWorker(launch.options)
    return
  }

  // A static import would evaluate the engine's module graph before the worker branch above could
  // run. The specifier is a literal, so the compiler still resolves it at build time.
  const host = await import('./host-run.ts')
  await host.runHost(argv)
}

// No top-level await: the compiled graph must stay free of it, and every failure is reported as a
// frame rather than as an unhandled rejection.
main().catch(error => {
  logLine(`host failed: ${error instanceof Error ? error.message : String(error)}`)
  // A worker that got this far has already spoken the worker protocol; `host_fatal` would be a
  // second vocabulary on the same pipe, so the worker's own startup refusal shape is used.
  if (workerMode) workerFatal('internal', error instanceof Error ? error.message : String(error))
  fatalHostFailure(error)
})

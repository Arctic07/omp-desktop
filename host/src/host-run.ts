/**
 * The ordinary host run: pinned environment, engine graph, `hello`, boot, stdin loop.
 *
 * This module is loaded *lazily* by `main.ts` (the one entry the compiled binary has), after the
 * process has ruled out `--plugin-worker`. That split is what keeps a plugin worker free of the
 * engine's module graph: a static import here would evaluate the engine before the worker branch
 * could run, which is the one thing the worker must never do. Everything below still happens in
 * this order (contract §2.1/§5), unchanged.
 */

import { bootServices } from './boot.ts'
import { HOST_VERSION, MAX_FRAME_BYTES, MAX_REASSEMBLED_BYTES, PROTOCOL_VERSION } from './constants.ts'
import { Dispatcher } from './dispatch.ts'
import { EnvPinError, pinEnv } from './env.ts'
import { fatal } from './host-fatal.ts'
import { retireSeededSkills } from './legacy-skills.ts'
import { SessionRegistry } from './sessions.ts'
import { ChunkReassembler, LineScanner, oversizedLineRequestId } from './protocol/frames.ts'
import { logLine, sanitizeMessage } from './log.ts'
import { FrameWriter } from './outbound.ts'
import { ERROR_CODES } from './protocol/errors.ts'
import { loadSdk } from './sdk.ts'
import { registerSessionHistory } from './session-history.ts'
import { startSilenceSweep } from './silence-sweep.ts'
import { seedSkillCreator } from './skill-creator.ts'
import { seedPluginCreator } from './plugin-creator.ts'
import { configuredUiTimeoutMs } from './ui.ts'

/** Windows x64 is the only shipped target; the triple is reported in `hello`. */
const TARGET = 'x86_64-pc-windows-msvc'

/**
 * The code this process leaves with when its stdout can no longer be written.
 *
 * Distinct from the two startup refusals (`fatal` leaves 2, a protocol mismatch 3) so a support case
 * can tell them apart: the desktop records the exit code beside the exit, and this one says the host
 * was running and then lost the pipe to its reader.
 */
const EXIT_WRITE_FAILED = 4

/**
 * Runs the host to completion, or to its fatal startup refusal.
 *
 * `argv` is the launch vector minus the executable and the script (the caller has already read it
 * once, to choose between worker and ordinary mode).
 */
export async function runHost(argv: readonly string[]): Promise<void> {
  const startedAt = performance.now()

  let paths
  try {
    paths = pinEnv(argv)
  } catch (error) {
    if (error instanceof EnvPinError) fatal(ERROR_CODES.env_pin_failed, error.detail)
    throw error
  }

  // stdout is the frame channel, so the engine's terminal notifications must stay out of it: the
  // bell/OSC fallback writes to process.stdout with no newline, which a reader merges into the next
  // JSON line. The engine's own RPC mode suppresses the same writes for the same reason.
  process.env.PI_NOTIFICATIONS = 'off'

  // The terminal instructions arrive with the built-in plugin package, which
  // the desktop seeds from its bundled catalogue (`services::plugins::builtin`): the plugin owns the
  // invocation, the package carries the words as `rules/<name>.md` with `alwaysApply` - the engine
  // injects the body into every request's `<generic-rules>`, so no skill has to be read first. An
  // earlier build wrote them as native user skills, and a native skill outranks a plugin's - so those
  // copies are retired here. Only the two authoring recipes (skill-creator, plugin-creator) remain
  // native.
  retireSeededSkills(paths.agentDir)
  // The two authoring recipes the app's own surfaces invoke: the Skills page's *New skill* writes
  // `/skill:skill-creator ` into the composer, and the welcome screen's plugin starter writes
  // `/skill:plugin-creator `. Both follow this build (`native-skill.ts`): an unedited copy is
  // refreshed to the recipe this build ships, and a copy the reader edited is left alone.
  seedSkillCreator(paths.agentDir)
  seedPluginCreator(paths.agentDir)

  // A frame the transport cannot encode is dropped by the writer before it ever reaches a session
  // queue, so the accounting and the notice are wired here, where the registry exists. The other half
  // of the transport's own reporting is a write the sink refused: it is not about one frame, so it is
  // not answered frame by frame either (see the sink below).
  let encodeFailureSink: ((frame: unknown, reason: string) => void) | null = null
  let writeFailureSink: ((reason: string) => void) | null = null
  const writer = new FrameWriter(
    (frame, reason) => encodeFailureSink?.(frame, reason),
    reason => writeFailureSink?.(reason),
  )
  // Runtime-selected module graph: the SDK builds its directory table while it is evaluated, so
  // this import must happen after pinEnv() above.
  const sdk = await loadSdk()
  // A desktop conversation is a top-level engine session, which the engine's own `history://`
  // deliberately does not discover from disk. Install the wrapper before any session can issue a
  // read, so `history://<session id>` resolves from the first turn.
  registerSessionHistory(paths, sdk)

  // Printed as soon as the module graph exists: the launcher uses this line to decide whether it
  // is talking to a build it understands, before the engine has read a single setting.
  writer.send({
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    hostVersion: HOST_VERSION,
    sdkVersion: sdk.version,
    bunVersion: Bun.version,
    target: TARGET,
    limits: { maxFrameBytes: MAX_FRAME_BYTES, maxReassembledFrameBytes: MAX_REASSEMBLED_BYTES },
  })

  let ready = false
  let shuttingDown = false
  let exitCode = 0

  let services
  let timing
  try {
    const booted = await bootServices(paths, sdk)
    services = booted.services
    timing = booted.timing
  } catch (error) {
    // The engine services could not be built at all: nothing can be served, so this is one of the
    // few genuinely fatal cases (contract §2.8, ruling A13).
    fatal(ERROR_CODES.host_failed, `engine initialization failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const registry = new SessionRegistry({ paths, sdk, services, writer })
  encodeFailureSink = (frame, reason) => registry.noteEncodeFailure(frame, reason)
  /// The silence sweep's disposer, assigned below where the registry exists: shutdown may be called
  /// before that line only through a failure in this block, which is after it.
  let stopSilenceSweep: (() => void) | null = null

  /** Disposes every session, flushes and leaves; idempotent. */
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    // The sweep is the only timer this process owns, and it walks the registry: stopped first, so a
    // tick cannot land in the middle of `disposeAll` (`silence-sweep.ts` states the release point).
    stopSilenceSweep?.()
    try {
      await registry.disposeAll(reason)
    } catch (error) {
      logLine(`shutdown dispose failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    writer.send({ type: 'host_exit', code: exitCode, reason })
    await writer.flush()
    process.exit(exitCode)
  }

  // The sink refused the bytes, which is not about one frame: nothing this process emits can reach
  // the desktop again - not a prompt's answer, not a dialog, not an error report - and every frame
  // after the failure is dropped inside the writer. Leaving is what makes that visible and what
  // recovers it: the desktop's child-exit detector reports the exit, tells each conversation its turn
  // was interrupted, and rebuilds them from their files, which is the same path a crash takes and the
  // one `watch_liveness` would eventually force anyway - it probes `host_health`, and a host that
  // cannot write cannot answer a probe either. The teardown is attempted so sessions still holding
  // unwritten files are disposed of properly; it cannot hang on the transport, whose `flush` returns
  // as soon as the failed sink has nothing left to take.
  writeFailureSink = reason => {
    logLine(`stdout write failed (${reason}); leaving so the desktop can recover this host`)
    exitCode = EXIT_WRITE_FAILED
    void shutdown('stdout_write_failed')
  }

  const dispatcher = new Dispatcher({
    paths,
    sdk,
    services,
    registry,
    writer,
    protocolVersion: PROTOCOL_VERSION,
    hostVersion: HOST_VERSION,
    sdkVersion: sdk.version,
    ready: () => ready,
    uptimeMs: () => Math.round(performance.now()),
    uiRequestTimeoutMs: configuredUiTimeoutMs,
    requestShutdown: reason => {
      void shutdown(reason)
    },
    requestExit: code => {
      exitCode = code
      void shutdown('protocol_mismatch')
    },
  })

  ready = true
  writer.send({
    type: 'ready',
    initMs: Math.round(performance.now() - startedAt),
    agentDir: paths.agentDir,
    sessionDir: paths.sessionDir,
  })
  logLine(
    `ready in ${Math.round(performance.now() - startedAt)}ms (settings ${timing.settingsMs}ms, auth ${timing.authMs}ms, registry ${timing.registryMs}ms, ${timing.modelsAvailable} models)`,
  )

  const scanner = new LineScanner()
  const chunks = new ChunkReassembler()
  const reader = Bun.stdin.stream().getReader()

  // The host's own account of a silence, one log line per episode: a conversation that stops
  // producing engine events while still reading busy is the one state the user-facing reading
  // (`lastEventAt`) can measure but not explain, and the log is where a report is diagnosed after
  // the fact. Nothing acts on it - see `SessionRegistry.sweepSilence` - and shutdown is its release
  // point (`silence-sweep.ts`).
  stopSilenceSweep = startSilenceSweep(() => registry.sweepSilence())

  for (;;) {
    const { done, value } = await reader.read()
    if (done === true) break
    for (const event of scanner.push(value as Uint8Array)) {
      if (event.kind === 'overflow') {
        registry.noteRejectedCommand()
        logLine(`dropping an oversized inbound line (${event.bytes} bytes)`)
        // The line could not be parsed, so the only thing worth recovering from it is the request
        // it named: a caller that never hears back waits out its own timeout instead of learning
        // that its frame was refused.
        const oversizedId = oversizedLineRequestId(event.text)
        if (oversizedId !== null) {
          writer.send({
            type: 'response',
            id: oversizedId,
            success: false,
            error: sanitizeMessage(`The inbound line exceeds the ${MAX_FRAME_BYTES} byte physical frame ceiling.`),
            code: ERROR_CODES.invalid_input,
          })
        }
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(event.text)
      } catch {
        registry.noteRejectedCommand()
        logLine('dropping an inbound line that is not JSON')
        continue
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        registry.noteRejectedCommand()
        continue
      }
      const frame = parsed as Record<string, unknown>
      let logical = frame
      if (frame.type === 'rpc_chunk') {
        // A malformed chunk run is protocol noise, never a reason to end the process: it is
        // counted, answered when it named a request, and the stream carries on (contract §2.2).
        let reassembled: Record<string, unknown> | null
        try {
          reassembled = chunks.accept(frame)
        } catch (error) {
          registry.noteRejectedCommand()
          const reason = error instanceof Error ? error.message : String(error)
          logLine(`dropping a malformed chunk run: ${reason}`)
          const id = typeof frame.id === 'string' ? frame.id : null
          if (id !== null) {
            writer.send({
              type: 'response',
              id,
              success: false,
              error: sanitizeMessage(reason),
              code: 'invalid_input',
            })
          }
          continue
        }
        if (reassembled === null) continue
        logical = reassembled
      }
      // Awaited per frame, which is what keeps one session's commands in order. The host-level
      // commands that touch no session state are dispatched off this loop by the dispatcher itself,
      // so this await can return before their answer does - that is the point, and the answer still
      // arrives under the frame's own `id` (see `Dispatcher.#detach`).
      await dispatcher.accept(logical)
    }
  }
  // stdin closed: the launcher is gone, so this process leaves the same way `host_shutdown` does.
  await shutdown('stdin_closed')
}

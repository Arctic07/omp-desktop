/**
 * The diagnostics commands: this run's logs, where they live, and the one place that clears them or
 * the webview caches.
 *
 * Every command here takes no arguments and every one of them is an action rather than a read of
 * engine state, so nothing is cached on this side: the page reads the overview when it arrives and
 * re-reads it after a clear.
 */

import { call } from '@/api/client'
import { COMMANDS } from '@/api/types'

/** Which producer wrote a log file: this application, or the engine host. */
export type LogFileSource = 'app' | 'engine'

/** One file in a logs directory. */
export interface LogFileInfo {
  name: string
  bytes: number
  /** When the file was last written, in milliseconds since the Unix epoch. */
  modifiedMs: number
  source: LogFileSource
}

/** Where the logs live, what the directories hold, and what the caches weigh. */
export interface LogsOverview {
  directory: string
  /** The engine's own directory: one file per host process, written by the SDK. */
  engineDirectory: string
  files: LogFileInfo[]
  cacheBytes: number
}

/** The directory the file manager was handed, and whether it took it. */
export interface OpenLogsResult {
  path: string
  /** False is a normal answer: the file manager refused or was unavailable. */
  opened: boolean
}

/** What one clear freed and what it left behind. */
export interface ClearOutcome {
  freedBytes: number
  remainingBytes: number
  /**
   * The part of `freedBytes` the engine reclaimed in its own tree.
   *
   * Zero when the host was not running: the engine's directory is read-only to this process
   * (`rules.md#engine-integration-and-data-ownership`), so its caches are freed by the engine's own process or not at all.
   */
  engineFreedBytes: number
  /** Engine caches it had to keep, and why is in the log: in use, current, or a refused delete. */
  engineSkippedBytes: number
}

/** One line the page asks the host to write; the host tags it as the page's and redacts it. */
export function writeLogLine(
  level: 'info' | 'warn' | 'error',
  message: string,
): Promise<void> {
  return call(COMMANDS.logsWrite, { level, message })
}

export function logsOverview(): Promise<LogsOverview> {
  return call(COMMANDS.logsOverview)
}

export function logsOpenDirectory(source: LogFileSource = 'app'): Promise<OpenLogsResult> {
  return call(COMMANDS.logsOpenDirectory, { scope: source })
}

export function logsClear(): Promise<ClearOutcome> {
  return call(COMMANDS.logsClear)
}

export function cachesClear(): Promise<ClearOutcome> {
  return call(COMMANDS.cachesClear)
}

/**
 * Records which face the terminal panels took, and what the app's `--font-mono` said.
 *
 * The terminal is the one surface whose typography the page has to decide itself (`xterm` takes
 * the face as an option, not from the stylesheet), so a panel that had to refuse the token is a
 * fact only this side can see. One line per page is enough: it is what turns "the terminal looks
 * wrong on this machine" into a name — the face drawn, and the value that produced it — in a log
 * the reader already has.
 */
export function reportTerminalFace(chosen: string, token: string): Promise<void> {
  const refused = token !== '' && token !== chosen
  const detail = token === '' ? 'missing' : refused ? `refused: ${token}` : 'used'
  return writeLogLine(
    refused ? 'warn' : 'info',
    `terminal face: ${chosen} (--font-mono: ${detail})`,
  )
}

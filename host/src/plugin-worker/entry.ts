/**
 * Resolving the plugin's entry from its own `package.json`, and evaluating it as an ES module.
 *
 * The worker is launched with the plugin *root*, not with an entry path: the manifest is the one
 * place the two halves agree on what runs, so re-reading `omp.desktop.main` here is what makes the
 * argv a location rather than a second copy of the manifest. The lexical rule is the manifest
 * validator's (`plugins-desktop.ts::safeRelativePath` + the `.js`/`.mjs` and `node_modules`
 * restrictions), written again on purpose: this is the process that would *evaluate* the path, and
 * a rule only one side checks is not a rule at the boundary. The Rust supervisor re-checks the same
 * shape before spawning, so three sides agree rather than one trusting another.
 *
 * Failures are startup refusals with the bridge's own code vocabulary, never a stack: `not_found`
 * when there is no `main`, `invalid_request` when there is one this build cannot evaluate.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { PLUGIN_DESKTOP_MAIN_PATH_MAX } from '../constants.ts'

/** Why the entry could not be resolved or evaluated; the caller writes it as `worker_fatal`. */
export class WorkerStartupError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkerStartupError'
    this.code = code
  }
}

/** Everything one worker evaluates: the package-relative entry, and the module namespace. */
export interface LoadedEntry {
  readonly entry: string
  readonly module: Record<string, unknown>
}

/** Whether one declared entry is the package-relative path both halves read the same way. */
function safeEntry(value: string): boolean {
  if (value.length === 0 || value.length > PLUGIN_DESKTOP_MAIN_PATH_MAX) return false
  if (path.isAbsolute(value) || /\\|\p{Cc}|:/u.test(value)) return false
  const segments = value.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false
  if (segments.some(segment => segment.toLowerCase() === 'node_modules')) return false
  return /\.(?:js|mjs)$/i.test(value)
}

/**
 * The package-relative entry the plugin's own manifest declares.
 *
 * A `package.json` that cannot be read or parsed is the same refusal as a missing `main`: the
 * worker cannot know what to run, and inventing `index.js` would run a file nobody declared.
 */
export function resolveEntry(root: string): string {
  const manifestPath = path.join(root, 'package.json')
  let manifest: unknown
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new WorkerStartupError('not_found', 'The plugin package.json could not be read.')
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new WorkerStartupError('invalid_request', 'The plugin package.json is not an object.')
  }
  const omp = (manifest as Record<string, unknown>).omp
  const desktop = typeof omp === 'object' && omp !== null ? (omp as Record<string, unknown>).desktop : undefined
  const main = typeof desktop === 'object' && desktop !== null ? (desktop as Record<string, unknown>).main : undefined
  if (main === undefined || main === null) {
    throw new WorkerStartupError('not_found', 'The plugin manifest declares no omp.desktop.main entry.')
  }
  if (typeof main !== 'string' || !safeEntry(main)) {
    throw new WorkerStartupError('invalid_request', 'The omp.desktop.main entry is not a package-relative .js/.mjs path.')
  }
  return main
}

/**
 * Evaluates the entry and requires the one export the protocol is built on.
 *
 * A module that throws while evaluating (a syntax error, a top-level import of something absent) and
 * one that evaluates but exports no `onLoad` are both `invalid_request`: which of the two it was is
 * in the message, and the process is about to end either way.
 */
export async function loadEntry(root: string): Promise<LoadedEntry> {
  const entry = resolveEntry(root)
  const absolute = path.resolve(root, entry)
  let namespace: Record<string, unknown>
  try {
    // The file URL is the one spelling a dynamic import takes for an arbitrary absolute path on
    // Windows; a bare path is read as a package specifier.
    namespace = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>
  } catch (error) {
    throw new WorkerStartupError('invalid_request', `The plugin entry could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof namespace.onLoad !== 'function') {
    throw new WorkerStartupError('invalid_request', 'The plugin entry exports no onLoad function.')
  }
  return { entry, module: namespace }
}

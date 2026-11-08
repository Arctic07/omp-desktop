/**
 * `omp-host.exe --plugin-worker …` argv, parsed before anything else starts.
 *
 * The form is frozen with the Rust supervisor (plan §6.2):
 *
 * ```text
 * omp-host.exe --plugin-worker --root <absolute dir> --install <installId> --id <pluginId> --scope <user|project>
 * ```
 *
 * The parse is deliberately strict: every flag is required exactly once, no other flag is read, and
 * a value is bounded before it reaches a filesystem call. A launch the worker cannot read becomes
 * one `worker_fatal` line and a non-zero exit (the caller maps that to a crashed process), never a
 * `hello` on a half-understood command line.
 *
 * `--flag value` and `--flag=value` are both read, because the launcher builds the vector and a
 * hand-run repro types it; both spellings resolve to the same options, and a flag given twice in
 * either spelling is refused rather than last-one-wins.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { PLUGIN_ID_MAX, PLUGIN_WORKER_ROOT_MAX } from '../constants.ts'

/** The flag that selects worker mode. */
export const PLUGIN_WORKER_FLAG = '--plugin-worker'

/** The four required flags, in the order the launcher writes them. */
const REQUIRED_FLAGS = ['--root', '--install', '--id', '--scope'] as const
type RequiredFlag = (typeof REQUIRED_FLAGS)[number]

/** The scope a plugin installation lives in. */
export type PluginWorkerScope = 'user' | 'project'

/** Everything the worker needs from its launch line. */
export interface PluginWorkerOptions {
  readonly root: string
  readonly installId: string
  readonly pluginId: string
  readonly scope: PluginWorkerScope
}

/** The parse result: an ordinary host run, a worker launch, or a refusal to start. */
export type PluginWorkerArgv =
  | { readonly kind: 'not_worker' }
  | { readonly kind: 'worker'; readonly options: PluginWorkerOptions }
  | { readonly kind: 'invalid'; readonly message: string }

/** True when the string is non-empty, bounded and free of control characters. */
function boundedToken(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value)
}

/**
 * Resolves one absolute directory, or says why it is not one.
 *
 * The check is lexical first (a relative root would make `cwd` depend on the launcher's own) and
 * the filesystem second: a root that is not a directory is a launch the entry inside it cannot
 * come from, and the worker says so before importing anything.
 */
function workerRoot(value: string): string | null {
  if (!boundedToken(value, PLUGIN_WORKER_ROOT_MAX) || !path.isAbsolute(value)) return null
  const normalised = path.normalize(value)
  try {
    if (!fs.statSync(normalised).isDirectory()) return null
  } catch {
    return null
  }
  return normalised
}

/**
 * Parses the worker flags out of a host argv.
 *
 * Returns `not_worker` when the flag is absent, so an ordinary host run never pays for this module's
 * rules; any malformed worker launch is `invalid` with a sentence the caller writes as
 * `worker_fatal { code: 'invalid_input' }`.
 */
export function parsePluginWorkerArgv(argv: readonly string[]): PluginWorkerArgv {
  const workerIndex = argv.findIndex(arg => arg === PLUGIN_WORKER_FLAG || arg.startsWith(`${PLUGIN_WORKER_FLAG}=`))
  if (workerIndex < 0) return { kind: 'not_worker' }
  // The selector carries no value. `--plugin-worker=1` is a caller that expected a knob this
  // protocol does not have, and reading it as "on" would hide that.
  if (argv[workerIndex] !== PLUGIN_WORKER_FLAG) return { kind: 'invalid', message: `${PLUGIN_WORKER_FLAG} takes no value.` }

  const values = new Map<RequiredFlag, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    if (index === workerIndex) continue
    const equals = arg.indexOf('=')
    const flag = (equals < 0 ? arg : arg.slice(0, equals)) as RequiredFlag
    if (!REQUIRED_FLAGS.includes(flag)) return { kind: 'invalid', message: `Unknown plugin worker flag: ${arg}` }
    if (values.has(flag)) return { kind: 'invalid', message: `The ${flag} flag was given more than once.` }
    let value: string | undefined
    if (equals >= 0) {
      value = arg.slice(equals + 1)
    } else {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) return { kind: 'invalid', message: `The ${flag} flag needs a value.` }
      value = next
      index += 1
    }
    if (value === '') return { kind: 'invalid', message: `The ${flag} flag needs a value.` }
    values.set(flag, value)
  }

  const missing = REQUIRED_FLAGS.find(flag => !values.has(flag))
  if (missing !== undefined) return { kind: 'invalid', message: `The ${missing} flag is required.` }

  const root = workerRoot(values.get('--root') as string)
  if (root === null) return { kind: 'invalid', message: '--root must be an absolute path to an existing directory.' }
  const installId = values.get('--install') as string
  if (!boundedToken(installId, PLUGIN_ID_MAX)) return { kind: 'invalid', message: `--install must be 1-${PLUGIN_ID_MAX} characters with no control characters.` }
  const pluginId = values.get('--id') as string
  if (!boundedToken(pluginId, PLUGIN_ID_MAX)) return { kind: 'invalid', message: `--id must be 1-${PLUGIN_ID_MAX} characters with no control characters.` }
  const scope = values.get('--scope') as string
  if (scope !== 'user' && scope !== 'project') return { kind: 'invalid', message: '--scope must be user or project.' }

  return { kind: 'worker', options: { root, installId, pluginId, scope } }
}

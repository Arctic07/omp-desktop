/**
 * The plugin worker's process environment: `cwd` is the plugin root, nothing else is inherited.
 *
 * A worker exists to run third-party code, so its environment is built the way the host and the
 * engine's own child processes build theirs (`rules.md#engine-integration-and-data-ownership`): clear first, then a short allow-list
 * of variables the operating system itself needs to spawn a process or find a temporary directory.
 * `HOME` / `USERPROFILE` are deliberately *not* set and deliberately not pinned to anything: nothing
 * in this process writes to a home directory, and leaving the variables absent is what makes that
 * true for plugin code that would otherwise reach for `~` by accident.
 *
 * `OMP_DESKTOP_PLUGIN_WORKER=1` is the one application variable added, so a plugin (and a support
 * log) can tell it is running in a worker rather than in the host. The engine's own variables are
 * not here at all - the worker never evaluates an engine module.
 */

/** Variables the platform needs: `PATH` to resolve tools, the Windows system root, temp, locale. */
const KEPT_ENVIRONMENT = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'TZ',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
] as const

/**
 * Switches this process into a worker: `chdir` to the plugin root, then replace the environment.
 *
 * `chdir` first: a relative path a plugin passes is resolved against its own package, and that is
 * the only directory it should ever assume. Throws when the root is gone (the caller turns that
 * into `worker_fatal`); the argv parser has already required an absolute existing directory.
 */
export function applyWorkerEnvironment(root: string): void {
  process.chdir(root)
  const kept: Record<string, string> = {}
  for (const name of KEPT_ENVIRONMENT) {
    const value = process.env[name]
    if (value !== undefined) kept[name] = value
  }
  for (const name of Object.keys(process.env)) delete process.env[name]
  for (const [name, value] of Object.entries(kept)) process.env[name] = value
  process.env.OMP_DESKTOP_PLUGIN_WORKER = '1'
}

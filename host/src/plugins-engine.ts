/**
 * The plugin engine diagnostic (`plugins_engine`): which engine is loaded, which protocol this host
 * speaks, and whether the external tools an install spawns are here at all.
 *
 * Every value is a runtime fact of *this* process: the version comes from the SDK bundle the host
 * loaded, and each tool is resolved with `Bun.which` in the same process that would spawn it. That
 * is what lets a page tell "this plugin is broken" from "this machine cannot install plugins",
 * which is the difference the install preflight refuses on (`plugins.ts`).
 *
 * The probe only ever answers whether a tool is resolvable, never a version: a version string is
 * another engine-shaped surface to keep in step, and the one decision it feeds - "can an install
 * run" - needs availability alone.
 */

import { PLUGIN_TOOLCHAIN_ENV } from './constants.ts'

/** The external tools the engine's plugin install paths spawn (`bun install`, `git clone`). */
export type PluginToolName = 'bun' | 'git' | 'npm'

/** Whether each tool is resolvable in this process. */
export type PluginToolchain = Readonly<Record<PluginToolName, boolean>>

/**
 * The tools the operator's test knob reports as absent.
 *
 * `OMP_DESKTOP_SMOKE_TOOLCHAIN=bun=0` is how the smoke drives the "no toolchain" path without
 * rewriting the system `PATH`: the knob replaces the filesystem answer for the named tools. It is
 * denial-only - `0` and `false` deny a tool, and *every* other value, `1`/`true` included, is
 * ignored - so the knob can never claim a tool this machine does not have, and the preflight it
 * feeds can only ever refuse work.
 */
function deniedTools(): ReadonlySet<string> {
  const raw = process.env[PLUGIN_TOOLCHAIN_ENV]
  if (raw === undefined || raw === '') return new Set()
  const denied = new Set<string>()
  for (const pair of raw.split(',')) {
    const [name, value] = pair.split('=')
    if (name === undefined || name.trim() === '') continue
    if (value === '0' || value === 'false') denied.add(name.trim().toLowerCase())
  }
  return denied
}

/** True when one tool resolves to an executable this process could spawn. */
function toolAvailable(tool: PluginToolName, denied: ReadonlySet<string>): boolean {
  if (denied.has(tool)) return false
  try {
    return Bun.which(tool) !== null
  } catch {
    // A lookup that cannot answer is not a tool: the callers only use this to *refuse* work.
    return false
  }
}

/**
 * Probes the toolchain an install needs, from this process's real environment.
 *
 * `bun` is what the engine's install/uninstall and git-spec paths spawn; `git` is what a
 * marketplace clone runs; `npm` is reported for the page's diagnostics and is not spawned by any
 * path this host drives.
 */
export function probePluginToolchain(): PluginToolchain {
  const denied = deniedTools()
  return {
    bun: toolAvailable('bun', denied),
    git: toolAvailable('git', denied),
    npm: toolAvailable('npm', denied),
  }
}

/**
 * The `plugins_engine` answer: the loaded engine version (the `hello` frame's `sdkVersion`), the
 * host protocol under it, and the toolchain an install would spawn.
 */
export function pluginEngineInfo(sdkVersion: string, protocol: number): Record<string, unknown> {
  return { sdkVersion, protocol, toolchain: probePluginToolchain() }
}

/**
 * Data-root pinning and startup self-check (contract §1.3, ruling F3, `rules.md#engine-integration-and-data-ownership`).
 *
 * The SDK builds its directory table while its modules are evaluated, so every variable that
 * decides where the engine writes must be set - and asserted - before the SDK is imported.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { SESSION_DIR_SEGMENT } from './constants.ts'

/** Absolute directories derived from `--data-root`; one object carries every pinned location. */
export interface HostPaths {
  /** Application data root handed in by the host process. */
  readonly dataRoot: string
  /** Agent directory (`OMP_DESKTOP_CODING_AGENT_DIR`): credentials, models config, caches. */
  readonly agentDir: string
  /** Session directory this host owns exclusively. */
  readonly sessionDir: string
  /** This host's own derived usage index (`host/usage-index.json`), never inside a session dir. */
  readonly usageIndexFile: string
  /** Worktree base (`OMP_WORKTREE_DIR`). */
  readonly worktreesDir: string
  /** `XDG_DATA_HOME`; `<xdgDataHome>/omp` is expected to exist before the engine runs. */
  readonly xdgDataHome: string
  /** Pinned `HOME`/`USERPROFILE`; the engine's `logs/` and `gpu_cache.json` land underneath. */
  readonly home: string
  /** `PI_CONFIG_DIR` literal - always `omp-desktop`, never a path (ruling F3). */
  readonly configDir: string
  /** Default workspace used when a caller opens a session without a cwd. */
  readonly defaultWorkspace: string
}

/** Raised when the launching environment contradicts the pinned data root. */
export class EnvPinError extends Error {
  readonly detail: string

  constructor(detail: string, message: string) {
    super(message)
    this.name = 'EnvPinError'
    this.detail = detail
  }
}

/** Windows compares paths case-insensitively; the host only ever runs on win32 x64. */
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/** Reads `--data-root <dir>` or `--data-root=<dir>` from the launch arguments. */
function dataRootArgument(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--data-root') {
      return argv[index + 1] ?? ''
    }
    if (argument.startsWith('--data-root=')) {
      return argument.slice('--data-root='.length)
    }
  }
  return null
}

/**
 * Asserts a variable the launcher provided agrees with the value derived from `--data-root`.
 *
 * A variable that was not provided at all is not a mismatch: the host sets it itself. Only a
 * real contradiction (F3) is refused, so a caller that passes just `--data-root` is valid.
 */
function assertPin(name: string, provided: string | undefined, derived: string): void {
  if (provided === undefined || provided === '') return
  const agrees = name === 'PI_CONFIG_DIR'
    ? provided === derived
    : samePath(path.resolve(provided), path.resolve(derived))
  if (!agrees) {
    throw new EnvPinError(
      name,
      `${name} is ${provided}, but the data root requires ${derived}`,
    )
  }
}

/** True when `candidate` names a location under `root`; equal paths count as inside. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Resolves a path whose leaf may not exist yet.
 *
 * The deepest existing ancestor is resolved - that is where any junction or symlink on the way
 * would already have been taken - and the remainder is appended, so the caller sees the real
 * destination without this check creating directories outside the data root to find out.
 */
function realPathOf(target: string): string {
  const missing: string[] = []
  let current = path.resolve(target)
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

/**
 * Every location the engine may create under the pinned home, checked against the data root.
 *
 * The comparison runs on resolved paths rather than on the spellings the host derived: a data
 * root whose `host/` entry is a junction or a symlink elsewhere keeps every lexical path inside
 * while the engine's writes land outside it, and only the real target shows that (`rules.md#engine-integration-and-data-ownership`).
 */
function assertInsideDataRoot(realRoot: string, candidate: string, detail: string): void {
  const real = realPathOf(candidate)
  if (isInside(realRoot, real)) return
  throw new EnvPinError(detail, `${detail}: ${candidate} resolves to ${real}, outside the pinned data root ${realRoot}`)
}

/**
 * Pins every data-location variable to `<dataRoot>` and creates the directories the engine and
 * the host assume already exist. Must run before the SDK is imported.
 */
export function pinEnv(argv: readonly string[]): HostPaths {
  const rawDataRoot = dataRootArgument(argv)
  if (rawDataRoot === null || rawDataRoot === '') {
    throw new EnvPinError('--data-root', 'The host requires an absolute --data-root argument.')
  }
  if (!path.isAbsolute(rawDataRoot)) {
    throw new EnvPinError('--data-root', `--data-root must be absolute: ${rawDataRoot}`)
  }
  const dataRoot = path.resolve(rawDataRoot)
  // The data root is the authority for what "inside" means, so it is resolved first: a data root
  // reached through a link is still the data root, and everything under it has to land in the
  // directory it really names.
  fs.mkdirSync(dataRoot, { recursive: true })
  const realRoot = fs.realpathSync.native(dataRoot)
  const hostDir = path.join(dataRoot, 'host')
  const paths: HostPaths = {
    dataRoot,
    agentDir: path.join(hostDir, 'agent'),
    sessionDir: path.join(hostDir, ...SESSION_DIR_SEGMENT.slice(1)),
    usageIndexFile: path.join(hostDir, 'usage-index.json'),
    worktreesDir: path.join(hostDir, 'worktrees'),
    xdgDataHome: path.join(hostDir, 'xdg'),
    home: path.join(dataRoot, 'home'),
    configDir: 'omp-desktop',
    defaultWorkspace: path.join(dataRoot, 'workspace'),
  }

  assertPin('PI_CODING_AGENT_DIR', process.env.PI_CODING_AGENT_DIR, paths.agentDir)
  assertPin('OMP_DESKTOP_CODING_AGENT_DIR', process.env.OMP_DESKTOP_CODING_AGENT_DIR, paths.agentDir)
  assertPin('PI_CONFIG_DIR', process.env.PI_CONFIG_DIR, paths.configDir)
  assertPin('XDG_DATA_HOME', process.env.XDG_DATA_HOME, paths.xdgDataHome)
  assertPin('OMP_WORKTREE_DIR', process.env.OMP_WORKTREE_DIR, paths.worktreesDir)
  assertPin('HOME', process.env.HOME, paths.home)
  assertPin('USERPROFILE', process.env.USERPROFILE, paths.home)

  // Native addon extraction and the engine's own logs are located from the two variables below;
  // both must stay inside the data root, which is also what makes the pinned home safe. The
  // checks run before anything is created, so a data root that points its writes elsewhere is
  // refused before this host has written a single byte outside it.
  assertInsideDataRoot(realRoot, path.join(paths.xdgDataHome, 'omp', 'natives'), 'native_cache_outside_data_root')
  assertInsideDataRoot(realRoot, path.join(paths.home, '.omp', 'natives'), 'native_cache_outside_data_root')
  assertInsideDataRoot(realRoot, path.join(paths.home, paths.configDir), 'config_root_outside_data_root')
  assertInsideDataRoot(realRoot, paths.agentDir, 'agent_dir_outside_data_root')
  assertInsideDataRoot(realRoot, paths.sessionDir, 'session_dir_outside_data_root')

  // Naming rule: every environment variable this application defines is `OMP_DESKTOP_`-prefixed,
  // so the app's own name for the agent directory is `OMP_DESKTOP_CODING_AGENT_DIR`. The engine's
  // own keys are set as well, because the engine reads those names and nothing else
  // (`pi-utils/src/dirs.ts` consults `PI_CODING_AGENT_DIR` alone, so that key is the one that
  // decides where engine data actually lands) - and each of the names below is asserted above to
  // agree with the data root. Both names carry the same value, so what this app documents and what
  // the engine obeys cannot drift apart.
  process.env.PI_CODING_AGENT_DIR = paths.agentDir
  process.env.OMP_DESKTOP_CODING_AGENT_DIR = paths.agentDir
  process.env.PI_CONFIG_DIR = paths.configDir
  process.env.XDG_DATA_HOME = paths.xdgDataHome
  process.env.OMP_WORKTREE_DIR = paths.worktreesDir
  process.env.HOME = paths.home
  process.env.USERPROFILE = paths.home

  for (const directory of [
    paths.agentDir,
    paths.sessionDir,
    paths.worktreesDir,
    paths.home,
    paths.defaultWorkspace,
    path.join(paths.xdgDataHome, 'omp'),
  ]) {
    fs.mkdirSync(directory, { recursive: true })
  }

  return paths
}

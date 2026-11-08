/**
 * `memory_status` / `memory_action`: which memory backend is active, and what it currently holds.
 *
 * The backend itself is the source of truth: `resolveMemoryBackend(settings)` is the engine's own
 * selector (including its migration of the legacy `memories.enabled` flag), `status()` is its own
 * report, and `buildDeveloperInstructions()` is the text the engine would actually inject into a
 * prompt. This module therefore renders nothing and summarises nothing - it projects what the
 * backend answers, and reads the memory directory only for the *file inventory* the page lists,
 * one level deep, only for the local backend, and never outside the engine's memory root
 * (ruling C5, contract §2.6).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { cfgMemoryBackend } from '@oh-my-pi/pi-coding-agent/memory-backend/settings'

import type { BootServices } from './boot.ts'
import {
  clampText,
  enumField,
  isWithin,
  requireText,
  resolveCwd,
  takeRows,
  TIMED_OUT,
  withTimeout,
} from './capabilities.ts'
import {
  CAPABILITY_CWD_MAX,
  CAPABILITY_TEXT_MAX,
  MEMORY_ARTIFACT_ROWS_MAX,
  MEMORY_CATALOG_WORKSPACES_MAX,
  MEMORY_PREVIEW_MAX,
  MEMORY_STATUS_BANKS_MAX,
  MEMORY_STATUS_TEXT_MAX,
  MEMORY_STATUS_TIMEOUT_MS,
} from './constants.ts'
import type { HostPaths } from './env.ts'
import { logError } from './log.ts'
import { invalidInput } from './protocol/errors.ts'
import type { MemoryBackend, MemoryBackendStatus, SdkBundle } from './sdk.ts'

/**
 * The backend ids this desktop offers, in the order the page lists them.
 *
 * The engine's own `MemoryBackendId` also carries `hindsight` (a client of a remote Hindsight
 * service), and this list deliberately stops short of it: reaching that service needs an endpoint
 * and a token - `hindsight.apiUrl` / `hindsight.apiToken`, or the `HINDSIGHT_*` environment
 * variables - and this desktop neither exposes those settings nor injects that environment. A
 * switch for it could therefore only produce a backend that talks to nothing (measured on this
 * artifact: `statusError: unsupported`, no status endpoint at all). Offering a choice that cannot
 * work is worse than not offering it, so the list holds what runs without setup outside this
 * application.
 *
 * Only the *choices* are scoped: the active value is reported verbatim (`memory_status.backend`),
 * so a `memory.backend` written outside this app is never hidden - the page can say it is not one
 * of the offered backends, which is a state, not a lie.
 *
 * The union is a type, so there is nothing to iterate at run time; keeping the list here next to
 * the write path is what makes `set_backend` refuse an id the engine would silently collapse to
 * `off`.
 */
const OFFERED_MEMORY_BACKENDS = ['off', 'local', 'mnemopi', 'sharpshooter'] as const

/** Actions the page may run against the active backend. */
const MEMORY_ACTIONS = ['set_backend', 'enqueue', 'clear'] as const

/** The four single-file artifacts a local memory root may hold. */
const MEMORY_FILES = ['MEMORY.md', 'memory_summary.md', 'raw_memories.md', 'learned.md'] as const

/** The two directories a local memory root may hold. */
const MEMORY_DIRECTORIES = ['rollout_summaries', 'skills'] as const

/** One row of the artifact inventory. */
interface MemoryArtifact {
  readonly name: string
  readonly kind: 'file' | 'directory'
  readonly bytes: number
  readonly files: number
  readonly updatedAtMs: number | null
}

/** One backend status, in the engine's own field names and order (contract §2.6-B). */
interface MemoryStatusRow {
  readonly backend: string | null
  readonly active: boolean | null
  readonly writable: boolean | null
  readonly searchable: boolean | null
  readonly scope: string | null
  readonly retainBank: string | null
  readonly recallBanks: string[] | null
  readonly workingCount: number | null
  readonly episodicCount: number | null
  readonly tripleCount: number | null
  readonly lastMemory: string | null
  readonly lastRecall: boolean | null
  readonly database: string | null
  readonly message: string | null
  readonly error: string | null
}

/** A string field of a status row, clamped; absent stays `null` rather than becoming `""`. */
function statusText(value: string | undefined, max: number): string | null {
  return clampText(value, max).text
}

/** The engine's status, with every undeclared field published as `null` instead of omitted. */
function statusRow(status: MemoryBackendStatus): MemoryStatusRow {
  return {
    backend: status.backend ?? null,
    // The three capability flags are booleans in the Rust DTO, where an explicit `null` fails the
    // whole payload's decode; a backend that leaves one unspecified means "not supported", which is
    // `false` (ruling C24).
    active: status.active ?? false,
    writable: status.writable ?? false,
    searchable: status.searchable ?? false,
    scope: statusText(status.scope, CAPABILITY_TEXT_MAX),
    retainBank: statusText(status.retainBank, CAPABILITY_TEXT_MAX),
    recallBanks:
      status.recallBanks?.slice(0, MEMORY_STATUS_BANKS_MAX).map((bank: string) => clampText(bank, CAPABILITY_TEXT_MAX).text ?? '') ??
      null,
    workingCount: status.workingCount ?? null,
    episodicCount: status.episodicCount ?? null,
    tripleCount: status.tripleCount ?? null,
    lastMemory: statusText(status.lastMemory, MEMORY_STATUS_TEXT_MAX),
    lastRecall: status.lastRecall ?? null,
    database: statusText(status.database, CAPABILITY_TEXT_MAX),
    message: statusText(status.message, MEMORY_STATUS_TEXT_MAX),
    error: statusText(status.error, MEMORY_STATUS_TEXT_MAX),
  }
}

/** One file's size and modification time, or `null` when it is not a readable file. */
function fileStat(target: string): { bytes: number; updatedAtMs: number } | null {
  try {
    const stats = fs.statSync(target)
    if (!stats.isFile()) return null
    return { bytes: stats.size, updatedAtMs: Math.round(stats.mtimeMs) }
  } catch {
    return null
  }
}

/**
 * The files inside one artifact directory, counted one level deep.
 *
 * `skills/` is the exception: its entries are skill directories whose payload is `SKILL.md`, so the
 * count is of those files. Nothing here recurses further, and nothing here opens a file: the
 * inventory is a size listing, not a parse (contract §2.6-B forbids reading the engine's SQLite
 * stores).
 */
function directoryStat(root: string, name: string): MemoryArtifact | null {
  const target = path.join(root, name)
  if (!isWithin(root, target)) return null
  let entries: fs.Dirent[]
  try {
    if (!fs.statSync(target).isDirectory()) return null
    entries = fs.readdirSync(target, { withFileTypes: true })
  } catch {
    return null
  }

  let bytes = 0
  let files = 0
  let updatedAtMs: number | null = null
  for (const entry of entries) {
    const candidate = entry.isDirectory() && name === 'skills' ? path.join(target, entry.name, 'SKILL.md') : path.join(target, entry.name)
    const stats = fileStat(candidate)
    if (stats === null) continue
    bytes += stats.bytes
    files += 1
    updatedAtMs = updatedAtMs === null ? stats.updatedAtMs : Math.max(updatedAtMs, stats.updatedAtMs)
  }
  return { name, kind: 'directory', bytes, files, updatedAtMs }
}

/** The memory root's inventory: the four files and the two directories, if they are there. */
function artifactRows(root: string): MemoryArtifact[] {
  let realRoot: string
  try {
    realRoot = fs.realpathSync.native(root)
  } catch {
    // No memory has been written for this project yet: an empty inventory, not an error.
    return []
  }
  const rows: MemoryArtifact[] = []
  for (const name of MEMORY_FILES) {
    const target = path.join(realRoot, name)
    if (!isWithin(realRoot, target)) continue
    const stats = fileStat(target)
    if (stats === null) continue
    rows.push({ name, kind: 'file', bytes: stats.bytes, files: 1, updatedAtMs: stats.updatedAtMs })
  }
  for (const name of MEMORY_DIRECTORIES) {
    const row = directoryStat(realRoot, name)
    if (row !== null) rows.push(row)
  }
  return rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/** The backend's own status, or the machine code that says why there is none. */
async function readStatus(
  backend: MemoryBackend,
  paths: HostPaths,
  cwd: string,
): Promise<{ status: MemoryStatusRow | null; statusError: 'timeout' | 'unsupported' | 'failed' | null }> {
  if (typeof backend.status !== 'function') return { status: null, statusError: 'unsupported' }
  try {
    const answer = await withTimeout(backend.status({ agentDir: paths.agentDir, cwd }), MEMORY_STATUS_TIMEOUT_MS)
    if (answer === TIMED_OUT) return { status: null, statusError: 'timeout' }
    return { status: statusRow(answer), statusError: null }
  } catch (error) {
    // A remote backend that cannot answer is a state the page shows, not a failed command: the
    // caller still needs the backend id, the inventory and the injection.
    logError('memory status failed', error)
    return { status: null, statusError: 'failed' }
  }
}

/** The `memory_status` payload. */
async function memoryView(
  paths: HostPaths,
  services: BootServices,
  sdk: SdkBundle,
  cwd: string,
): Promise<Record<string, unknown>> {
  const settings = services.settings
  const backend = await sdk.resolveMemoryBackend(settings)
  const backendId = backend.id
  // Only the local backend keeps artifacts under the memory root; every other backend's state is
  // whatever `status()` and the injection say, and none of their storage is read here.
  const root = backendId === 'local' ? sdk.getMemoryRoot(paths.agentDir, cwd) : null
  // The working directory is the third argument as of SDK 18.11: it selects project-scoped memory,
  // which is exactly what the page is previewing, so the injection it shows is the one this
  // workspace would actually get rather than the user-level one.
  const injection = clampText(
    await backend.buildDeveloperInstructions(paths.agentDir, cwd, settings),
    MEMORY_PREVIEW_MAX,
  )
  const { status, statusError } = await readStatus(backend, paths, cwd)

  return {
    backend: backendId,
    backends: OFFERED_MEMORY_BACKENDS,
    cwd,
    root,
    artifacts: root === null ? [] : takeRows(artifactRows(root), MEMORY_ARTIFACT_ROWS_MAX).rows,
    injection: injection.text,
    injectionTruncated: injection.truncated,
    status,
    statusError,
  }
}

/**
 * One workspace directory of a catalog read, resolved the way a session's working directory is.
 *
 * A directory that still exists resolves through the same call a session's `cwd` goes through, so
 * the catalog and the session that reads that memory name one root and not two spellings of it.
 *
 * A directory that is gone - a workspace whose folder was moved or deleted, which the store keeps
 * on purpose - is normalised instead of refused. The engine derives the root from the string, not
 * from the filesystem, so the answer is still the directory that workspace's memory lived in; one
 * missing workspace must not fail the read for every other one the page asked about.
 */
function catalogCwd(target: unknown): string {
  const raw = requireText(target, 'cwd', CAPABILITY_CWD_MAX)
  if (raw.includes('\n') || raw.includes('\r')) throw invalidInput('cwd must be a single path.')
  if (!path.isAbsolute(raw)) throw invalidInput('cwd must be an absolute path.')
  try {
    return fs.realpathSync.native(raw)
  } catch {
    return path.resolve(raw)
  }
}

/**
 * The workspace directories one catalog read names.
 *
 * Shape is checked before anything is derived: an unbounded list, an empty entry or a relative path
 * is refused here rather than turned into roots.
 */
function catalogCwds(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalidInput('cwds must be an array of absolute paths.')
  if (value.length > MEMORY_CATALOG_WORKSPACES_MAX) {
    throw invalidInput(`cwds may name at most ${MEMORY_CATALOG_WORKSPACES_MAX} workspaces.`)
  }
  return value.map(catalogCwd)
}

/**
 * `memory_catalog`: where the memory of each named workspace lives, and nothing else.
 *
 * The roots are the engine's own (`getMemoryRoot`), and they exist for the local backend only: the
 * other backends keep their state in a remote service or in SQLite, so a caller that wants to list
 * files has nothing to list. This read never touches a backend - no `status()`, no injection - so a
 * page can name every workspace once without paying for a backend round trip per workspace.
 */
export async function readMemoryCatalog(
  paths: HostPaths,
  services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cwds = catalogCwds(frame.cwds)
  const backendId = (await sdk.resolveMemoryBackend(services.settings)).id
  const localOnly = backendId === 'local'
  return {
    backend: backendId,
    enabled: backendId !== 'off',
    localOnly,
    workspaces: cwds.map(cwd => ({
      cwd,
      root: localOnly ? sdk.getMemoryRoot(paths.agentDir, cwd) : null,
    })),
  }
}

/** `memory_status`: the active backend, its status, its artifacts and its injected instructions. */
export async function readMemory(
  paths: HostPaths,
  services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cwd = resolveCwd(paths, frame.cwd)
  return await memoryView(paths, services, sdk, cwd)
}

/**
 * `memory_action`: switch the backend, consolidate now, or wipe the local store.
 *
 * The switch is a settings write and is flushed before the answer, exactly like a model-role
 * write, because the next read has to observe it. `enqueue` and `clear` are the backend's own
 * operations, called with the directories the engine itself uses.
 */
export async function runMemoryAction(
  paths: HostPaths,
  services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = enumField(frame.action, MEMORY_ACTIONS, 'action')
  const cwd = resolveCwd(paths, frame.cwd)
  const settings = services.settings

  switch (action) {
    case 'set_backend': {
      const backend = enumField(frame.backend, OFFERED_MEMORY_BACKENDS, 'backend')
      cfgMemoryBackend.set(settings, backend)
      await settings.flush()
      break
    }
    case 'enqueue':
      await (await sdk.resolveMemoryBackend(settings)).enqueue(paths.agentDir, cwd)
      break
    case 'clear':
      await (await sdk.resolveMemoryBackend(settings)).clear(paths.agentDir, cwd)
      break
  }

  return await memoryView(paths, services, sdk, cwd)
}

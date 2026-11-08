/**
 * The resident plugin processes, as the supervisor holds them.
 *
 * One table, keyed `(pluginId, scope)`: an id is only unique within a registry, and the same plugin
 * can be installed at both scopes. The table is the supervisor's own — it answers `plugin_process`
 * with the whole of it, and pushes the whole of it again on every start, stop, crash and timeout —
 * so this store adopts answers and never patches a row of its own. A crash and the restart that
 * follows it are two writes to the same row; a reader that merged halves would have to guess which
 * one it missed.
 *
 * **Lifetime and bounds** (`rules.md#resource-bounds-and-release-points`): the resource is keyed by workspace because a
 * project-scope installation is only addressable from the project it lives in, and it holds one
 * answer at a time. The index below is a memo of the *current* array only — its owner is this
 * module, its bound is the supervisor's own cap of 16 live processes (plan §6.4), and it is
 * released by the next answer or by `pluginProcessesResource.reset()`, which puts the memo back to
 * the empty map. Nothing here retains a row for a process the supervisor has forgotten.
 */

import { useCallback } from 'react'

import { toApiError, type ApiError } from '@/api/client'
import {
  activatePlugin,
  pluginProcesses,
  restartPluginProcess as restartProcess,
  runPluginCommand as runCommand,
} from '@/api/plugins'
import type {
  EnginePluginCommandRunResult,
  PluginProcessesView,
  ProcessRow,
} from '@/api/plugins-types'
import type { PluginRow } from '@/api/plugins-types'
import { reportClientError } from '@/lib/client-errors'
import { createWorkspaceResource, type ResourceState } from '@/state/resource'
import { useStoreSelector } from '@/state/store'

export const pluginProcessesResource = createWorkspaceResource<PluginProcessesView>((workspaceId) =>
  pluginProcesses(workspaceId),
)

/** Read the supervisor's table. Keyed by workspace, like every other plugin read. */
export function readPluginProcess(workspaceId: number | null, force = false): Promise<void> {
  return pluginProcessesResource.read(workspaceId, { force })
}

const NO_ROWS: readonly ProcessRow[] = []
const NO_INDEX: ReadonlyMap<string, ProcessRow> = new Map()

/** The array the index below was built from; `null` until the first read. */
let indexedRows: readonly ProcessRow[] | null = null
let indexedProcesses: ReadonlyMap<string, ProcessRow> = NO_INDEX

/**
 * The table as a lookup, rebuilt only when the array itself is replaced.
 *
 * A selector must hand back a value the state already holds, so a component cannot build its own
 * map on every render; this memo is what lets it ask for "this installation's row" and get a
 * reference that only changes when the supervisor says something new.
 */
function indexProcesses(rows: readonly ProcessRow[]): ReadonlyMap<string, ProcessRow> {
  if (rows === indexedRows) return indexedProcesses
  const next = new Map<string, ProcessRow>()
  for (const row of rows) {
    // A row without its identity is not addressable by any page; it is skipped rather than keyed
    // under a made-up pair.
    if (row.pluginId === '' || row.scope === '') continue
    next.set(`${row.pluginId}\u0000${row.scope}`, row)
  }
  indexedRows = rows
  indexedProcesses = next
  return next
}

/**
 * One installation's process row, re-rendering only when the supervisor reports a new table.
 *
 * Null is an ordinary answer — the plugin's process has not been activated yet, or has been let go —
 * and the page draws it as "not running" rather than as a missing fact. The row itself is the one
 * the state holds, so a selector can never loop on a freshly built object.
 */
export function usePluginProcess(pluginId: string, scope: string): ProcessRow | null {
  const select = useCallback(
    (state: ResourceState<PluginProcessesView>) => {
      const rows = Array.isArray(state.value?.processes) ? state.value.processes : NO_ROWS
      return indexProcesses(rows).get(`${pluginId}\u0000${scope}`) ?? null
    },
    [pluginId, scope],
  )
  return useStoreSelector(pluginProcessesResource.store, select)
}

/**
 * Adopt a table the desktop pushed.
 *
 * The event carries the supervisor's whole table, not one installation's slice, so it is adopted as
 * an ordinary answer for whichever workspace read last — the table is a fact about this process, and
 * a workspace switch cannot make a running process into a different one.
 */
export function applyPluginProcessEvent(view: PluginProcessesView): void {
  if (!Array.isArray(view?.processes)) return
  pruneActivatedViews(view.processes)
  pluginProcessesResource.adopt(view)
}

/** Owner: this module; bounded by installed plugin count × view entries. Released by list answers
 * removing/disabling rows and by pluginProcessesResource.reset(). */
const activatedViews = new Set<string>()

export function retainActivatedViews(rows: readonly PluginRow[]): void {
  const live = new Set(rows.filter((row) => row.enabled).map((row) => `${row.id}\u0000${row.scope}`))
  for (const key of activatedViews) {
    const second = key.indexOf('\u0000', key.indexOf('\u0000') + 1)
    if (second < 0 || !live.has(key.slice(0, second))) activatedViews.delete(key)
  }
}

function pruneActivatedViews(rows: readonly ProcessRow[]): void {
  const live = new Set(rows.map((row) => `${row.pluginId}\u0000${row.scope}`))
  for (const key of activatedViews) {
    const second = key.indexOf('\u0000', key.indexOf('\u0000') + 1)
    if (second < 0 || !live.has(key.slice(0, second))) activatedViews.delete(key)
  }
}

/** Activate one visible view once; undeclared onView events are an expected host refusal. */
export function activatePluginView(
  workspaceId: number | null,
  pluginId: string,
  scope: string,
  entryId: string,
): void {
  const key = `${pluginId}\u0000${scope}\u0000${entryId}`
  if (activatedViews.has(key)) return
  activatedViews.add(key)
  void activatePlugin(workspaceId, pluginId, scope, `onView:${entryId}`)
    .then((view) => {
      pruneActivatedViews(view.processes)
      pluginProcessesResource.adopt(view)
    })
    .catch((error: unknown) => {
      const apiError = toApiError(error)
      if (apiError.code !== 'INVALID_INPUT') reportClientError('plugin view activation failed', error, key)
    })
}
/**
 * Ask the supervisor to stop one installation's process and start it again.
 *
 * Never automatic: a crashed process stays `crashed` with its reason on screen until the reader
 * presses the button, which is the whole point of not disabling the plugin on a crash (plan §6.4).
 * The answer is the fresh table, adopted like a read.
 */
export async function restartPluginProcess(
  workspaceId: number | null,
  pluginId: string,
  scope: string,
): Promise<ApiError | null> {
  try {
    pluginProcessesResource.adopt(await restartProcess(workspaceId, pluginId, scope))
    return null
  } catch (error) {
    return toApiError(error)
  }
}

/** What one contributed command answered: the worker's own result, or a transport refusal. */
export interface PluginCommandOutcome {
  /** The worker's answer; null when the call itself was refused. */
  result: EnginePluginCommandRunResult | null
  error: ApiError | null
}

/**
 * Run one contributed command through its installation's process.
 *
 * A `result.ok === false` is *not* an error here: the worker answered, and its stable `code` is what
 * the page shows beside the command that produced it. A transport failure is an `ApiError`, because
 * that one is about the desktop rather than about the command.
 */
export async function runPluginCommand(
  workspaceId: number | null,
  pluginId: string,
  scope: string,
  commandId: string,
): Promise<PluginCommandOutcome> {
  try {
    return { result: await runCommand(workspaceId, pluginId, scope, commandId), error: null }
  } catch (error) {
    return { result: null, error: toApiError(error) }
  }
}

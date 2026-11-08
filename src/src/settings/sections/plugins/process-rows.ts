/**
 * The plugin page's resident-process projections: what one row declares, what a contributed command
 * is called, and the list a command palette would show.
 *
 * The plan puts a「插件命令」group beside the application's session commands (plan §6.4). This build
 * has no command palette — the old Vue frontend's was not ported, and none of the React tree opens
 * one — so the list is built here as the one shared source it would consume, and the plugin detail
 * view is the runner that exists today. A future palette adds a rendering of `pluginPaletteCommands`
 * and nothing else; it must not grow a second command list of its own.
 *
 * Everything is pure: the row arrives from the host, the wording from `copy.ts`, and an unknown
 * token is shown as it arrived rather than dropped.
 */

import type { JsonObject, PluginRow } from '../../../api/plugins-types'
import type { Language } from '../../../lib/i18n'
// Runtime imports are relative with their extension: this module is read by the test runner as well
// as by the bundler, and the runner has no alias to resolve.
import { pageTitle, pluginDisplayName } from '../../../state/plugin-text.ts'
import type { ProcessCopy } from './process-copy'

/** One contributed command as a list draws it, before it is bound to an installation. */
export interface DeclaredPluginCommand {
  /** The id `engine_plugin_command_run` names; '' for an entry this build cannot address. */
  id: string
  /** Locale → label, as the manifest wrote it; null when it wrote none. */
  title: JsonObject | null
  keywords: readonly string[]
}

/** The resident-process half of one row, normalized for the page. */
export interface DeclaredPluginProcess {
  /** The package-relative entry, or null when the plugin declares no `main`. */
  main: string | null
  activationEvents: readonly string[]
  commands: readonly DeclaredPluginCommand[]
  /** False when the manifest turned the supervisor's crash restarts off; missing reads as true. */
  autoRestart: boolean
  /** False when the supervisor refuses this installation a process; missing reads as allowed. */
  available: boolean
  /** The supervisor's refusal token when `available` is false, else null. */
  reason: string | null
}

/** One manifest string as the wire may carry it: anything that is not a string is not text. */
function processText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The process block one row declares, or null when there is nothing to draw.
 *
 * Null covers both "this host build predates the field" and "this plugin declares neither a `main`
 * nor a command" — the host projects null for the second for the same reason it projects null for a
 * theme list: an empty block is not a fact about the plugin. Every field is read defensively, so an
 * older host that sends a partial block still yields a usable view rather than throwing.
 */
export function pluginProcessOf(row: PluginRow): DeclaredPluginProcess | null {
  const process = row.desktop?.process
  if (process === null || process === undefined) return null

  const commands: DeclaredPluginCommand[] = []
  for (const command of Array.isArray(process.commands) ? process.commands : []) {
    if (command === null || typeof command !== 'object') continue
    const id = processText(command.id)
    if (id === '') continue
    commands.push({
      id,
      title:
        command.title !== null && typeof command.title === 'object' ? command.title : null,
      keywords: Array.isArray(command.keywords)
        ? command.keywords.filter(
            (keyword): keyword is string => typeof keyword === 'string' && keyword.trim() !== '',
          )
        : [],
    })
  }

  const main = processText(process.main)
  if (main === '' && commands.length === 0) return null

  const reason = processText(process.reason)
  return {
    main: main === '' ? null : main,
    activationEvents: Array.isArray(process.activationEvents)
      ? process.activationEvents.filter(
          (event): event is string => typeof event === 'string' && event.trim() !== '',
        )
      : [],
    commands,
    autoRestart: process.autoRestart !== false,
    available: process.available !== false,
    reason: reason === '' ? null : reason,
  }
}

/** Whether an installed row may receive the view activation for one page entry. */
export function pluginViewActivatable(row: PluginRow, entryId: string): boolean {
  if (!row.enabled) return false
  const process = pluginProcessOf(row)
  return process !== null && process.available && process.activationEvents.includes(`onView:${entryId}`)
}

/**
 * One process state as the page words it: the four the supervisor reports, and the pid for the one
 * state that has one. A token this build does not know is shown as it arrived.
 */
export function pluginProcessStateLabel(
  state: string,
  pid: number | null,
  copy: ProcessCopy,
): string {
  if (state === 'running') return copy.processRunning(typeof pid === 'number' ? pid : null)
  return copy.processStateLabels[state] ?? state
}

/** The supervisor's refusal sentence: a known token is worded here, anything else is its own text. */
export function pluginProcessRefusalLabel(reason: string, copy: ProcessCopy): string {
  return copy.processRefusalLabels[reason] ?? reason
}

/** A crash reason as one sentence; an unrecognised token keeps the supervisor's spelling. */
export function pluginProcessCrashLabel(reason: string, copy: ProcessCopy): string {
  return copy.processCrashLabels[reason] ?? reason
}

/**
 * Whether the restart control is usable right now.
 *
 * `starting` is the one state a restart cannot be pressed in: the supervisor is already between the
 * old process and the new one, and a second start would be refused. Every other state — including
 * `crashed` and `running` — accepts a manual restart, which is the plan's own rule (a crash never
 * disables the plugin; the reader decides when to try again).
 */
export function pluginProcessRestartable(state: string): boolean {
  return state !== 'starting'
}

/** The most of one command's returned value the row shows, in characters. */
export const COMMAND_VALUE_MAX_CHARS = 2000

/**
 * The `value` a `worker_result` carried, as the row shows it: pretty-printed JSON, bounded.
 *
 * A command's return value is the one thing an author can see of what their handler computed — the
 * page used to drop it and print "ran" alone, which made a handler that returned the wrong shape
 * indistinguishable from one that returned nothing. It is shown as data, never as markup: the text
 * goes into a `<pre>`'s text node, so a handler that echoes a `<script>` shows a `<script>`.
 *
 * Null means "nothing to show": an absent value (`undefined`/`null`), or one the JSON writer cannot
 * represent (a cycle, a function). A string is shown as it stands rather than quoted.
 */
export function commandResultValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      return null
    }
  }
  if (typeof text !== 'string') return null
  return text.length > COMMAND_VALUE_MAX_CHARS ? `${text.slice(0, COMMAND_VALUE_MAX_CHARS)}…` : text
}

/** One contributed command as the page draws it, in the order a palette would list it. */
export interface PluginCommandEntry {
  /** The installation the command belongs to, as every plugin write names it. */
  pluginId: string
  scope: string
  /** The installation's display name, for the entry's second line. */
  pluginName: string
  /** `row.desktop.process.commands[].id`, what `engine_plugin_command_run` takes. */
  commandId: string
  /** The command's own label, else its id. */
  title: string
  keywords: readonly string[]
  /** A stable identity for a list key: an id is only unique within its installation. */
  key: string
}

/**
 * Every contributed command of every installable row, in the host's own order.
 *
 * Sources and filters, exactly:
 * - only `row.enabled` rows (a disabled plugin's code does not run, so its commands are not offered);
 * - only rows whose process `available !== false` (the supervisor's verdict, restated here so the
 *   list never offers something the desktop would refuse);
 * - commands keep the manifest's order, and rows keep the host's order, so the same list comes back
 *   the same way on every render.
 *
 * A command with an empty id is not addressable and is skipped by `pluginProcessOf`.
 */
export function pluginPaletteCommands(
  rows: readonly PluginRow[],
  language: Language,
): PluginCommandEntry[] {
  const entries: PluginCommandEntry[] = []
  for (const row of rows) {
    if (!row.enabled) continue
    const process = pluginProcessOf(row)
    if (process === null || !process.available) continue
    const pluginName = pluginDisplayName(row, language)
    for (const command of process.commands) {
      const title = pageTitle(command.title, language)
      const label = title === '' ? command.id : title
      entries.push({
        pluginId: row.id,
        scope: row.scope,
        pluginName,
        commandId: command.id,
        title: label,
        keywords: command.keywords,
        key: `${row.id}\u0000${row.scope}\u0000${command.id}`,
      })
    }
  }
  return entries
}

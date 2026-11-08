/**
 * The plugin-process block of `omp.desktop` (plan §6.1): `main`, `activationEvents` and
 * `contributes.commands`, as the row projects them.
 *
 * Split out of `plugins-desktop.ts` at the line limit (`rules.md#single-file-line-limit`). The split is by
 * responsibility rather than by size: this file is the whole resident-process half of the manifest,
 * and the row's other entry lists, themes and scopes stay in the parent. The shared text rules
 * (`safeRelativePath`, `desktopLabels`, `DESKTOP_ID`) live in `plugins-desktop-text.ts`, so the
 * dependency direction is text → this file → the parent, with no cycle.
 */

import {
  PLUGIN_DESKTOP_ACTIVATION_EVENTS_MAX,
  PLUGIN_DESKTOP_ACTIVATION_EVENT_MAX,
  PLUGIN_DESKTOP_COMMAND_ID,
  PLUGIN_DESKTOP_COMMANDS_MAX,
  PLUGIN_DESKTOP_COMMAND_KEYWORDS_MAX,
  PLUGIN_DESKTOP_COMMAND_KEYWORD_MAX,
  PLUGIN_DESKTOP_MAIN_PATH_MAX,
} from './constants.ts'
import { logLine } from './log.ts'
import { DESKTOP_ID, desktopLabels, safeRelativePath } from './plugins-desktop-text.ts'
import { isRecord } from './plugins-manifest.ts'

/**
 * One command a plugin process contributes (`omp.desktop.contributes.commands`, plan §6.1).
 *
 * The id is the palette's key and the worker's registry key, so the manifest projects it exactly as
 * written; the title is a localised label the page joins with `i18n` (a missing translation is what
 * a missing field means everywhere else here), and the keywords are the palette's search terms.
 */
export interface DesktopProcessCommand {
  readonly id: string
  readonly title: Record<string, string> | null
  readonly keywords: string[]
}

/**
 * The resident-process half of a block (plan §6.1), or `null` when the block declares neither a
 * `main` nor a contributed command.
 *
 * `main` is the package-relative entry, not an absolute path: the Rust supervisor resolves it
 * against the row's `rootPath`, and the worker re-reads it from the same `package.json`. The host
 * never checks that the file exists - that is the worker's startup refusal (`worker_fatal`), which
 * is the only place the answer is authoritative.
 */
export interface DesktopProcessView {
  readonly main: string | null
  readonly activationEvents: string[]
  readonly commands: DesktopProcessCommand[]
  /**
   * Whether the supervisor may restart this process after a crash (`omp.desktop.autoRestart`).
   *
   * Absent means `true`: the field only ever *turns the restarts off*, so a manifest that says
   * nothing keeps the supervisor's own behaviour. `false` goes straight to `crashed` on the first
   * unexpected exit, which is what a plugin holding a lock or a half-written file wants; the
   * reader's manual restart still works either way.
   */
  readonly autoRestart: boolean
}

/** The activation events this build implements (plan §6.1, spec §3.2). */
const ACTIVATION_STARTUP = 'onStartup'
const ACTIVATION_COMMAND_PREFIX = 'onCommand:'
const ACTIVATION_VIEW_PREFIX = 'onView:'

/**
 * Whether one declared activation event is one this build implements.
 *
 * The rule is closed on purpose: the two prefixed forms name an id of the shape the matching list
 * uses, so `onCommand:` with an empty or non-token id, an unimplemented spelling (`onLanguage:x`)
 * and anything this build has never heard of are all the same answer - an event nothing will fire.
 * Unknown ones are dropped with a log line rather than refusing the block (spec §3.2): being told
 * about something is not a reach, so a plugin from a newer contract still loads on this build.
 */
function activationEventKnown(event: string): boolean {
  if (event === ACTIVATION_STARTUP) return true
  if (event.startsWith(ACTIVATION_COMMAND_PREFIX)) {
    return PLUGIN_DESKTOP_COMMAND_ID.test(event.slice(ACTIVATION_COMMAND_PREFIX.length))
  }
  if (event.startsWith(ACTIVATION_VIEW_PREFIX)) {
    return DESKTOP_ID.test(event.slice(ACTIVATION_VIEW_PREFIX.length))
  }
  return false
}

/**
 * The plugin-process block (`omp.desktop.main`, `activationEvents`, `contributes.commands`, plan
 * §6.1), projected for the row.
 *
 * Shapes only: `plugin.process` and `command.register` are projected like every other permission
 * and *not* enforced here. Whether a process may start - including the built-in exemption, which
 * needs no permission name - is the Rust supervisor's decision, made where the runnability facts
 * live; a host-side refusal would be a second authority over the same question. `main` is checked
 * for the lexical shape only and never for existence, for the same reason: the worker's startup
 * refusal (`worker_fatal`) is the authoritative answer.
 *
 * A `main` outside the shape refuses the whole desktop block, like a theme stylesheet. An
 * activation event outside the vocabulary is dropped with one log line, like an invalid `net`
 * domain - it loses reach rather than adding any.
 */
export function desktopProcess(raw: Record<string, unknown>): {
  readonly view: DesktopProcessView | null
  readonly reason: string | null
} {
  let main: string | null = null
  const declaredMain = raw.main
  if (declaredMain !== undefined && declaredMain !== null) {
    if (
      typeof declaredMain !== 'string'
      || !safeRelativePath(declaredMain, PLUGIN_DESKTOP_MAIN_PATH_MAX)
      || !/\.(?:js|mjs)$/i.test(declaredMain)
      || declaredMain.split('/').some(segment => segment.toLowerCase() === 'node_modules')
    ) {
      return { view: null, reason: 'invalid_process_main' }
    }
    main = declaredMain
  }

  // The one field whose *absence* is a value: every other field here is either the manifest's own
  // shape or this side's verdict, while a missing `autoRestart` says "restart me", which is what the
  // supervisor does when nothing is declared. A non-boolean is a shape this host cannot read, so it
  // refuses the block rather than guessing which way the author meant.
  let autoRestart = true
  const declaredAutoRestart = raw.autoRestart
  if (declaredAutoRestart !== undefined && declaredAutoRestart !== null) {
    if (typeof declaredAutoRestart !== 'boolean') return { view: null, reason: 'invalid_process_autorestart' }
    autoRestart = declaredAutoRestart
  }

  const activationEvents: string[] = []
  const declaredEvents = raw.activationEvents
  if (declaredEvents !== undefined && declaredEvents !== null) {
    if (!Array.isArray(declaredEvents) || declaredEvents.length > PLUGIN_DESKTOP_ACTIVATION_EVENTS_MAX) {
      return { view: null, reason: 'invalid_activation_events' }
    }
    for (const item of declaredEvents) {
      // A non-string is a shape this host cannot read at all, so it refuses; a string it does not
      // recognise is an event nothing fires, so it is dropped and said out loud.
      if (typeof item !== 'string') return { view: null, reason: 'invalid_activation_events' }
      const event = item.trim()
      if (event.length > PLUGIN_DESKTOP_ACTIVATION_EVENT_MAX || !activationEventKnown(event)) {
        logLine(`dropping unknown omp.desktop activation event: ${event}`)
        continue
      }
      if (!activationEvents.includes(event)) activationEvents.push(event)
    }
  }

  const commands: DesktopProcessCommand[] = []
  const contributes = raw.contributes
  if (contributes !== undefined && contributes !== null) {
    if (!isRecord(contributes)) return { view: null, reason: 'invalid_contributes' }
    const declaredCommands = contributes.commands
    if (declaredCommands !== undefined && declaredCommands !== null) {
      if (!Array.isArray(declaredCommands) || declaredCommands.length > PLUGIN_DESKTOP_COMMANDS_MAX) {
        return { view: null, reason: 'invalid_commands' }
      }
      const seen = new Set<string>()
      for (const item of declaredCommands) {
        if (!isRecord(item)) return { view: null, reason: 'invalid_commands' }
        const id = item.id
        if (typeof id !== 'string' || !PLUGIN_DESKTOP_COMMAND_ID.test(id)) {
          return { view: null, reason: 'invalid_commands' }
        }
        // A command id addresses one handler in the command palette and one entry in the worker's
        // registry, so a duplicate would make both ambiguous - the same refusal a duplicate entry
        // id gets.
        if (seen.has(id)) return { view: null, reason: 'duplicate_entry_id' }
        seen.add(id)
        const labels = desktopLabels(item.title)
        if (labels.invalid) return { view: null, reason: 'invalid_commands' }
        const keywords: string[] = []
        const declaredKeywords = item.keywords
        if (declaredKeywords !== undefined && declaredKeywords !== null) {
          if (!Array.isArray(declaredKeywords) || declaredKeywords.length > PLUGIN_DESKTOP_COMMAND_KEYWORDS_MAX) {
            return { view: null, reason: 'invalid_commands' }
          }
          for (const keyword of declaredKeywords) {
            if (typeof keyword !== 'string') return { view: null, reason: 'invalid_commands' }
            const text = keyword.trim()
            if (text === '' || text.length > PLUGIN_DESKTOP_COMMAND_KEYWORD_MAX) {
              return { view: null, reason: 'invalid_commands' }
            }
            if (!keywords.includes(text)) keywords.push(text)
          }
        }
        commands.push({ id, title: labels.labels, keywords })
      }
    }
  }

  // A process block exists exactly when there is something to run or something to register: an
  // `activationEvents`-only declaration has no worker to fire it in, so it projects to nothing.
  if (main === null && commands.length === 0) return { view: null, reason: null }
  return { view: { main, activationEvents, commands, autoRestart }, reason: null }
}

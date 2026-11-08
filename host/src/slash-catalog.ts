/**
 * The engine's whole builtin command catalog, and where each command runs on this side.
 *
 * The engine advertises a builtin to non-terminal clients only when it has a text-mode `handle`
 * (`slash-commands/available-commands.ts`); the rest carry `handleTui` and exist only in its
 * terminal. The desktop therefore has to know the *whole* catalog, not just the advertised half:
 *
 * - `SERVED` commands are the terminal-only ones this host runs itself. Their palette rows are
 *   generated from the engine's own metadata, so a new engine command added here appears with the
 *   engine's wording, not a copy that can drift.
 * - `UI_SURFACE` commands are the ones whose whole body is a terminal widget (a picker, a menu, an
 *   overlay). The desktop already has that surface, or does not need it, and the entry names it.
 *
 * Nothing is left out by accident: `slash-catalog.test.ts` walks the engine's registry and fails
 * when a command is in neither map, so an engine upgrade that adds a TUI-only command cannot ship
 * silently missing. That test is the maintenance contract for "every CLI command comes in".
 */

import { BUILTIN_SLASH_COMMANDS_INTERNAL } from '@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry'
import type { InternalAvailableSlashCommand } from '@oh-my-pi/pi-coding-agent/slash-commands/available-commands'

/**
 * The commands this host runs, keyed by their engine name.
 *
 * A `served` command must have a dispatcher in `slash-desktop.ts`; adding one here without a
 * handler offers a palette row that can only answer "not implemented".
 */
export const SERVED: Readonly<Record<string, true>> = {
  goal: true,
  vibe: true,
  plan: true,
  'plan-review': true,
  loop: true,
  'guided-goal': true,
  cleanse: true,
  btw: true,
  tan: true,
}

/**
 * The terminal-only commands that are a UI surface, with the desktop surface that stands in for
 * one. These are the only commands the desktop deliberately leaves unadvertised.
 */
export const UI_SURFACE: Readonly<Record<string, string>> = {
  settings: 'the application’s Settings page',
  setup: 'Settings → Providers',
  login: 'Settings → Providers',
  logout: 'Settings → Providers',
  queue: 'the composer’s queue (send with the queue gesture)',
  hub: 'the conversation’s background/subagent roster',
  agents: 'the engine’s agent definitions are read by the engine; no desktop editor yet',
  skills: 'the composer’s skill action',
  extensions: 'Settings → Plugins',
  git: 'the work panel’s git view',
  copy: 'select text in the transcript (the transcript is real text here)',
  open: 'the transcript’s links',
  hotkeys: 'the application’s own key handling; no keymap editor yet',
  debug: 'the debug panel is not built for the desktop yet',
  live: 'realtime voice is a terminal feature; the desktop has no voice surface',
  record: 'screen recording is a terminal feature; the desktop has no replay surface',
  pause: 'the desktop stops a turn and background work per conversation instead',
  collab: 'live session sharing is a terminal/relay feature; no desktop room UI yet',
  join: 'live session sharing is a terminal/relay feature; no desktop room UI yet',
  leave: 'live session sharing is a terminal/relay feature; no desktop room UI yet',
  new: 'the workspace’s own “New conversation” action',
  resume: 'the workspace rail’s conversation list',
  branch: 'the conversation menu’s branch action and the rewind controls',
  fork: 'the conversation menu’s export/branch actions',
  tree: 'the workspace rail’s conversation list',
  clear: 'a new conversation in the same workspace',
  delete: 'the workspace rail’s conversation menu',
  seance: 'the subagent conversation tabs',
  omfg: 'the TTSR rule editor is a terminal overlay; no desktop editor yet',
  // The engine's picker of this session's `local://` files, edited in `$VISUAL`/`$EDITOR`. The
  // desktop has no editor for that namespace: plan mode's own file is reported in the mode panel
  // (`local://PLAN.md`) and written by the engine, and every other `local://` file is read by the
  // engine when a prompt names it.
  local: 'the engine’s `local://` files have no editor here; plan mode’s own file is shown in the mode panel',
  exit: 'close the window',
  quit: 'close the window',
  restart: 'the application’s own relaunch, not a command',
}

/** One command as the palette draws it, built from the engine's own metadata. */
function entryOf(
  command: (typeof BUILTIN_SLASH_COMMANDS_INTERNAL)[number],
): InternalAvailableSlashCommand {
  const hint = command.inlineHint
  return {
    name: command.name,
    aliases: command.aliases,
    description: command.description,
    input: hint === undefined ? undefined : { hint },
    subcommands: command.subcommands,
    source: 'builtin',
  }
}

/**
 * The palette rows for the terminal-only commands this host serves.
 *
 * Derived from the engine's registry at call time rather than copied: an engine upgrade that
 * renames a hint, adds a subcommand or changes the description of a served command updates the
 * palette with it.
 */
export function servedCommandEntries(): InternalAvailableSlashCommand[] {
  return BUILTIN_SLASH_COMMANDS_INTERNAL.filter(
    (command) => SERVED[command.name] === true && typeof command.handle !== 'function',
  ).map(entryOf)
}

/** The engine commands that exist only in its terminal, whatever the desktop does with them. */
export function terminalOnlyCommands(): Array<{ name: string; aliases?: string[] }> {
  return BUILTIN_SLASH_COMMANDS_INTERNAL.filter(
    (command) => typeof command.handle !== 'function' && typeof command.handleTui === 'function',
  ).map((command) => ({ name: command.name, aliases: command.aliases }))
}

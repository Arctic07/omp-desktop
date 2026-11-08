/**
 * The application's own identity, as the shell reports it, and the one act that raises its window.
 *
 * `getVersion` is a core plugin API rather than one of this desktop's commands, but it is still an
 * IPC call and belongs behind this layer for the same reason: nothing outside `src/api/**` reaches
 * the shell directly.
 */

import { getVersion } from '@tauri-apps/api/app'

import { call } from '@/api/client'
import { COMMANDS } from '@/api/types'

/** This build's version, from the bundled `tauri.conf.json` rather than from any copy here. */
export function appVersion(): Promise<string> {
  return getVersion()
}

/**
 * Raises the window, whose document is the only thing that can say it is worth looking at.
 *
 * The start-up path leaves the window hidden: shown any earlier, the webview has nothing to paint
 * and puts its own white on screen (the flash every start opened on, 2026-10-20). `src/main.tsx`
 * calls this as its first act, with the start-up shell in `index.html` already parsed and styled.
 * Fire-and-forget: the desktop arms its own ceiling, so a failure here cannot leave the application
 * without a window.
 */
export function mainWindowReady(): void {
  void call(COMMANDS.mainWindowReady).catch(() => undefined)
}

/**
 * Marks the taskbar button of a turn that finished while the reader was elsewhere.
 *
 * The desktop cannot tell which conversation is on screen or whether its window has the focus — the
 * front end owns both — so the decision to flash is made where the ending is folded
 * (`state/session-stream.ts`), and this is only the act. Fire-and-forget: a desktop that could not
 * flash has no state to undo, and the conversation itself is unchanged.
 */
export function flashTaskbar(): void {
  void call(COMMANDS.flashTaskbar).catch(() => undefined)
}

/**
 * Tell the OS whether this application is in front.
 *
 * In the background its processes — this one and the engine host — drop to below-normal priority
 * with execution speed throttling, so a game or a build keeps the machine's cores while agents keep
 * making progress. Focus is the signal: the front end owns it, and the command is fire-and-forget
 * because an OS that refuses the hint has nothing to correct on screen.
 */
export function appBackground(background: boolean): Promise<void> {
  return call(COMMANDS.appBackground, { background })
}

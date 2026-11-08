/**
 * The desktop's own preferences: the ones the application keeps in its store and pushes to the shell
 * (`presence`, the startup theme) and the tray's language.
 *
 * These are not engine settings. They belong to the host process, which is why they answer with
 * their own small shapes rather than with an engine view, and why a write here is the whole
 * preference rather than a patch.
 */

import { call } from '@/api/client'
import { COMMANDS } from '@/api/types'
import type { Language } from '@/lib/i18n'

/** Whether closing the window leaves the application running in the system tray. */
export interface PresenceSettings {
  closeToTray: boolean
}

/** The three themes the shell can be started with; `system` follows the machine. */
export type StartupTheme = 'light' | 'dark' | 'system'

export function presenceGet(): Promise<PresenceSettings> {
  return call(COMMANDS.presenceGet)
}

export function presenceSet(closeToTray: boolean): Promise<PresenceSettings> {
  return call(COMMANDS.presenceSet, { closeToTray })
}

/**
 * Tells the tray which language its own menu is written in.
 *
 * Fire-and-forget by design: the tray's labels are the shell's business, and a failure here must not
 * take the interface's own language change down with it.
 */
export function trayLanguageSet(language: Language): Promise<void> {
  return call(COMMANDS.trayLanguageSet, { language })
}

/** Records the theme the next start should open with; this run's theme is the document's own. */
export function startupThemeSet(theme: StartupTheme): Promise<void> {
  return call(COMMANDS.startupThemeSet, { theme })
}

/**
 * The theme the shell last painted the window from, or `null` when it has no record.
 *
 * Asked only by a start whose own storage holds no theme: the settings page writes the storage, and
 * this is the copy the shell keeps for the frame before that page exists. The two agree until the
 * webview's storage is lost, and the record is then the only surviving copy of the choice
 * (`state/startup-theme::themeToAdopt`).
 */
export function startupThemeGet(): Promise<StartupTheme | null> {
  return call(COMMANDS.startupThemeGet)
}

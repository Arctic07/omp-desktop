/**
 * The open-in-app commands: which applications this machine has, one application's own icon, and
 * one launch on the workspace directory.
 *
 * The desktop owns every decision here (`src-tauri/src/services/open_in_app.rs`): the catalog of
 * products, the locators that prove one installed, the icon extracted from the installed binary,
 * and the launch itself. The page names none of those paths; it only asks for an id and a
 * workspace-relative target.
 */

import { call } from '@/api/client'
import { COMMANDS } from '@/api/types'

interface OpenInAppAppsResult {
  apps: string[]
}

interface OpenInAppIconResult {
  dataUrl: string
}

/** The catalog ids this machine can actually launch, in the desktop's own menu order. */
export async function openInAppApps(): Promise<string[]> {
  const result = await call<OpenInAppAppsResult>(COMMANDS.openInAppApps)
  return result.apps
}

/**
 * One application's own icon as a `data:` URL.
 *
 * A refusal (`OPEN_IN_APP_FAILED`) means this machine serves no artwork for the app, which the menu
 * draws with its generic glyph instead: that is not an error the reader should see.
 */
export async function openInAppIcon(appId: string): Promise<string> {
  const result = await call<OpenInAppIconResult>(COMMANDS.openInAppIcon, { appId })
  return result.dataUrl
}

/**
 * Open one workspace target in one application.
 *
 * `path` is workspace-relative and may be empty for the root itself; the desktop resolves it inside
 * `root` before a launcher sees it.
 */
export function openInAppLaunch(
  appId: string,
  root: string,
  path = '',
): Promise<void> {
  return call<void>(COMMANDS.openInAppLaunch, { appId, root, path })
}

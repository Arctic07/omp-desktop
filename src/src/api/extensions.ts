/**
 * The extensions dashboard's commands: the engine's discovered items and one-item toggle.
 *
 * The shapes mirror `src-tauri/src/models/extensions.rs` verbatim. The row's `id` is the engine's
 * own `disabledExtensions` token, so the page never builds one.
 */

import { call } from '@/api/client'
import { COMMANDS } from '@/api/types'

export interface EngineExtensionRow {
  id: string
  kind: string
  name: string
  displayName: string
  description: string | null
  trigger: string | null
  provider: string
  providerName: string
  level: string
  /** `active` | `disabled` | `shadowed`. */
  state: string
  disabledReason: string | null
  shadowedBy: string | null
}

export interface ExtensionsView {
  extensions: EngineExtensionRow[]
  /** True when the answer is a prefix of a longer discovery. */
  truncated: boolean
}

export function extensionsList(workspaceId: number | null): Promise<ExtensionsView> {
  return call(COMMANDS.extensionsList, { workspaceId })
}

export function setExtension(
  workspaceId: number | null,
  id: string,
  enabled: boolean,
): Promise<ExtensionsView> {
  return call(COMMANDS.extensionsSet, { workspaceId, id, enabled })
}

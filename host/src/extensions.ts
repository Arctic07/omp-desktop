/**
 * `extensions_list` / `extensions_set`: the engine's `/extensions` dashboard, projected.
 *
 * The engine already owns this surface (`modes/components/extensions/state-manager.ts`): it loads
 * every capability with `includeDisabled`, resolves the provider/user-source gates item by item, and
 * gives each row the id `disabledExtensions` stores (`skill:<name>`, `hook:<type>:<tool>:<name>`,
 * `extension-module:<name>`, …). Rebuilding that list here would be a second discovery with its own
 * id conventions; this module calls the engine's own loader and projects only what the page draws.
 *
 * The write is the engine's own setting (`disabledExtensions`, read by every capability loader).
 * One id is added or removed, the setting is flushed, the capability caches are dropped and every
 * live session is reloaded - the same sequence `plugins_reload` runs, because an item toggle changes
 * the set of skills, commands, tools and modules a session advertises.
 *
 * MCP servers are deliberately not part of this list. The engine's dashboard toggles them through
 * the MCP configuration (`disabledServers` / `enabled`), not through `disabledExtensions`, and this
 * application already owns that surface (`settings/sections/McpSection.tsx`); a toggle here would
 * either write a setting the MCP loader does not read or duplicate the MCP page's write.
 */

import type { BootServices } from './boot.ts'
import { requireBoolean, requireText, resolveCwd } from './capabilities.ts'
import {
  EXTENSION_ID_MAX,
  EXTENSION_ITEMS_MAX,
  EXTENSIONS_IDS_MAX,
} from './constants.ts'
import type { HostPaths } from './env.ts'
import { logLine } from './log.ts'
import { ERROR_CODES, HostError, invalidInput } from './protocol/errors.ts'
import type { SessionRegistry } from './sessions.ts'
import type { SdkBundle } from './sdk.ts'

/** The id prefixes `disabledExtensions` gates; anything else is not this surface's to write. */
const EXTENSION_ID_PREFIXES = [
  'skill:',
  'rule:',
  'tool:',
  'hook:',
  'prompt:',
  'slash-command:',
  'context-file:',
  'extension-module:',
] as const

/** One discovered item, as the page draws it. */
interface ExtensionRow {
  readonly id: string
  readonly kind: string
  readonly name: string
  readonly displayName: string
  readonly description: string | null
  readonly trigger: string | null
  /** The provider that discovered it (`.omp`, a plugin package, Claude, …). */
  readonly provider: string
  readonly providerName: string
  /** `user` | `project`. */
  readonly level: string
  /** `active` | `disabled` | `shadowed`. */
  readonly state: string
  /** Why it is not active: `item-disabled`, `provider-disabled`, `user-opt-in`, `shadowed`. */
  readonly disabledReason: string | null
  /** The item's name when another provider's copy shadows it, or null. */
  readonly shadowedBy: string | null
}

/** The roots every discovery in this process reads: configured `extensions:` paths plus plugins. */
function extensionRoots(sdk: SdkBundle, services: BootServices) {
  return sdk.extensionRoots(sdk.cfgExtensions.get(services.settings))
}

/**
 * The engine's whole dashboard, without MCP servers, ordered and cut to the page bound.
 *
 * The cap is a page bound, not a discovery rule: an engine with thousands of skills is answered
 * with the first `EXTENSION_ITEMS_MAX` rows in a deterministic order, and the page says the list was
 * cut rather than silently drawing a prefix. `all` is the uncut list, for the write's own check.
 */
export async function extensionRows(
  sdk: SdkBundle,
  services: BootServices,
  cwd: string,
): Promise<{ rows: ExtensionRow[]; all: ExtensionRow[]; truncated: boolean }> {
  const disabled = sdk.cfgDisabledExtensions.get(services.settings)
  const extensions = await sdk.loadAllExtensions(cwd, disabled, extensionRoots(sdk, services))
  const rows: ExtensionRow[] = []
  for (const extension of extensions) {
    if (extension.kind === 'mcp') continue
    const source = extension.source as { provider?: unknown; providerName?: unknown; level?: unknown }
    const provider = typeof source.provider === 'string' ? source.provider : ''
    const providerName = typeof source.providerName === 'string' ? source.providerName : provider
    const level = typeof source.level === 'string' ? source.level : ''
    rows.push({
      id: extension.id,
      kind: extension.kind,
      name: extension.name,
      displayName: extension.displayName,
      description: extension.description ?? null,
      trigger: extension.trigger ?? null,
      provider,
      providerName,
      level,
      state: extension.state,
      disabledReason: extension.disabledReason ?? null,
      shadowedBy: extension.shadowedBy ?? null,
    })
  }
  rows.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name) ||
      left.provider.localeCompare(right.provider),
  )
  const truncated = rows.length > EXTENSION_ITEMS_MAX
  return {
    rows: truncated ? rows.slice(0, EXTENSION_ITEMS_MAX) : rows,
    all: rows,
    truncated,
  }
}

/**
 * `extensions_list`: every engine item this build can toggle, and whether the page bound cut the list.
 *
 * The raw `disabledExtensions` list is not answered: each row's `state` is that setting resolved
 * against the item, which is what the page draws and what the switch writes.
 */
export async function listExtensions(
  paths: HostPaths,
  services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cwd = resolveCwd(paths, frame.cwd)
  const { rows, truncated } = await extensionRows(sdk, services, cwd)
  return { extensions: rows, truncated }
}

/**
 * One id as this frame may write: a known prefix and a bounded token.
 *
 * The field is `targetId`, never `id`: the envelope's `id` is the correlation key the Rust host
 * writes itself before encoding, so an id sent under it arrives as `h7` (ruling C14, the same rule
 * every other plugin frame follows).
 */
export function extensionIdField(value: unknown): string {
  const id = requireText(value, 'targetId', EXTENSION_ID_MAX).trim()
  // The prefix alone names nothing: every engine id carries the item's own name after it, and a
  // bare `skill:` would sit in `disabledExtensions` matching no capability.
  const prefix = EXTENSION_ID_PREFIXES.find(candidate => id.startsWith(candidate))
  if (prefix === undefined || id.length === prefix.length) {
    throw invalidInput(`"${id}" is not an extension item this surface can toggle.`)
  }
  if (/\p{Cc}/u.test(id)) throw invalidInput('The extension id must not contain control characters.')
  return id
}

/**
 * `extensions_set`: add or remove one id from `disabledExtensions`.
 *
 * The list is checked before it grows: an id that is not in the current discovery is refused, so a
 * page cannot fill the setting with names no provider will ever match. That check reads the uncut
 * discovery, because the page's row cap is a drawing bound and an item past it is still a real one.
 * Ids from an earlier build that no longer resolve stay in the setting untouched - removing them is
 * the user's own cleanup, and this frame only edits the id it was given.
 */
export async function setExtension(
  paths: HostPaths,
  services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
  registry: SessionRegistry,
): Promise<Record<string, unknown>> {
  const id = extensionIdField(frame.targetId)
  const enabled = requireBoolean(frame.enabled, 'enabled')
  const cwd = resolveCwd(paths, frame.cwd)
  // The page bound is not a discovery rule: an item past `EXTENSION_ITEMS_MAX` is still a real
  // item, and refusing its write would make it permanently untoggleable.
  const { all } = await extensionRows(sdk, services, cwd)
  if (!all.some(row => row.id === id)) {
    throw new HostError(ERROR_CODES.plugin_not_found, `No extension item is discovered as "${id}".`)
  }
  const current = sdk.cfgDisabledExtensions.get(services.settings)
  const present = current.includes(id)
  if (enabled ? present : !present) {
    const next = enabled ? current.filter(candidate => candidate !== id) : [...current, id]
    if (next.length > EXTENSIONS_IDS_MAX) {
      throw invalidInput(`disabledExtensions would exceed ${String(EXTENSIONS_IDS_MAX)} entries.`)
    }
    sdk.cfgDisabledExtensions.set(services.settings, next)
    await services.settings.flush()
  }
  // The setting's own flush is not enough: every capability cache was built under the old list, and
  // a session advertises the commands and skills of the set it loaded.
  sdk.resetCapabilities()
  const { reloaded, failed } = await registry.reloadPlugins()
  logLine(
    `extension "${id}" -> ${enabled ? 'enabled' : 'disabled'}; ${String(reloaded)} session(s) reloaded${failed > 0 ? `, ${String(failed)} failed` : ''}`,
  )
  const { rows: refreshed, truncated } = await extensionRows(sdk, services, cwd)
  return { extensions: refreshed, truncated }
}

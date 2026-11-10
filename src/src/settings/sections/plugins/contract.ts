import type { ApiError } from '@/api/client'
import type { PluginTemplate } from '@/api/plugins'
import type {
  EnginePluginUpdate,
  JsonObject,
  PluginGrantRow,
  PluginRow,
} from '@/api/plugins-types'
import type { Language } from '@/lib/i18n'
import { isGranted, pluginKey } from '@/state/plugins-store'
import { pluginDisplayDescription, pluginDisplayName } from '@/state/plugin-text'

/**
 * What the plugin page's views share: the shape of one row as they draw it, the page's own result
 * line, and the writes a view asks the page for.
 *
 * The page holds every write because a write is never one view's own: enabling a plugin changes the
 * list and the detail view at once, and the store's install writes the same list the store's cards
 * read. So a view reports the press and draws what it was given; nothing below decides what a
 * button means.
 */

/** The two registries a plugin can be installed in; the engine's own tokens. */
export type PluginScope = 'user' | 'project'

/** One setting's value, as the engine's own store carries it. */
export type PluginSettingValue = JsonObject | string | number | boolean | null

/** One installation as the list and the detail view draw it. */
export interface PluginEntry {
  row: PluginRow
  /** An id is only unique within its scope, so every map on this page is keyed by this. */
  key: string
  name: string
  description: string
  /** The pending update the host named for this installation, or null when there is none. */
  update: EnginePluginUpdate | null
  /** Whether this exact installation's consent has been recorded. */
  granted: boolean
}

/**
 * The page's own last result line, or the host's own sentence for a write it refused: `success`
 * notices are plain result lines, and a refusal or a partial failure is stated in a notice with the
 * page's own heading above it.
 */
export interface PluginNotice {
  /** The notice's own heading; unused by the page's plain result lines. */
  title: string
  text: string
  /** The host's own code, when the notice is a refusal; '' for the page's own result lines. */
  code: string
  variant: 'success' | 'warning' | 'destructive'
}

/** Everything a view below the page may ask it to do. */
export interface PluginActions {
  /** The write in flight, or ''; every control on the page locks while one is. */
  busyKey: string
  /** What each installation's own last write answered, keyed the way a row looks itself up. */
  failures: Readonly<Record<string, ApiError>>
  /** Turn one installation's switch: the consent gate, or the write itself. */
  toggle: (row: PluginRow) => void
  /** Open the confirmation dialog for a row whose code has not been agreed to yet. */
  requestConsent: (row: PluginRow) => void
  /** Ask the page to open the uninstall card for one installation. */
  requestUninstall: (row: PluginRow) => void
  /**
   * Apply one installation's pending update: the engine's own upgrade, or — when the host says the
   * new version is on another marketplace — the source switch, which the page confirms first.
   */
  upgrade: (row: PluginRow) => void
  upgradeAll: () => void
  /** Forget one installation's confirmation, which also disables it. */
  revoke: (row: PluginRow) => void
  refresh: () => void
  checkUpdates: () => void
  reload: () => void
  installSource: (source: string, scope: PluginScope) => Promise<ApiError | null>
  /** Install or upgrade from a package file the reader picked (the host runs it as a task). */
  installPackage: (path: string, scope: PluginScope) => Promise<ApiError | null>
  /** Install or upgrade from a URL; the digest is required and checked before any download. */
  installUrl: (url: string, sha256: string, scope: PluginScope) => Promise<ApiError | null>
  /** Copy one authoring template into a folder; nothing is installed by it. */
  scaffoldTemplate: (
    template: PluginTemplate,
    targetDir: string,
  ) => Promise<{ path: string | null; error: ApiError | null }>
  setSetting: (row: PluginRow, key: string, value: PluginSettingValue) => Promise<ApiError | null>
  resetSetting: (row: PluginRow, key: string | null) => Promise<ApiError | null>
}

/** Two version strings as the same version: the engine's own prefix is not part of the number. */
function sameVersion(left: string, right: string): boolean {
  const strip = (value: string): string => value.trim().replace(/^v/i, '')
  return strip(left) === strip(right)
}

/**
 * The pending updates the host's rows still support.
 *
 * `plugins_check_updates` answered earlier than the list beside it, so an upgrade leaves entries
 * behind whose `from → to` contradicts the version the row now reports. An entry is kept only while
 * it is still a promise: the installation it names must still be installed, and must not already
 * report the version the entry says it would move to.
 *
 * The match is on the plugin id and the scope — the identity a row is keyed by — not on the
 * engine's install handle, which a source switch changes on purpose.
 */
export function pendingUpdates(
  updates: readonly EnginePluginUpdate[],
  rows: readonly PluginRow[],
): EnginePluginUpdate[] {
  return updates.filter((update) =>
    rows.some(
      (row) =>
        row.id === update.pluginId &&
        row.scope === update.scope &&
        !sameVersion(row.version ?? '', update.to),
    ),
  )
}

/** The rows and their own facts, as one array of entries in the engine's own order. */
export function buildEntries(
  rows: readonly PluginRow[],
  grants: readonly PluginGrantRow[],
  updates: readonly EnginePluginUpdate[],
  language: Language,
): PluginEntry[] {
  return rows.map((row) => ({
    row,
    key: pluginKey(row),
    name: pluginDisplayName(row, language),
    description: pluginDisplayDescription(row, language),
    update:
      updates.find(
        (update) => update.pluginId === row.id && update.scope === row.scope,
      ) ?? null,
    granted: isGranted(grants, row.id, row.scope),
  }))
}

/** The rows the scope and the query select, in the engine's own order. */
export function entriesInScope(
  entries: readonly PluginEntry[],
  scope: PluginScope,
  query: string,
): PluginEntry[] {
  const term = query.trim().toLowerCase()
  return entries.filter((entry) => {
    if (entry.row.scope !== scope) return false
    if (term === '') return true
    const permissions = (entry.row.desktop?.permissions ?? []).join(' ')
    const haystack = [
      entry.name,
      entry.row.name,
      entry.row.description ?? '',
      entry.row.id,
      permissions,
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(term)
  })
}

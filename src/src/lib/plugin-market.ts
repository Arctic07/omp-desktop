import type { EngineMarketplaceRow, MarketplacePluginRow, PluginRow } from '@/api/plugins-types'
import { manifestText } from './manifest-text.ts'

/**
 * The marketplace this build registers on its own, and the pure projections its page draws.
 *
 * The catalogue entry rules live here rather than beside either page: the installed list no longer
 * browses a marketplace, and the market page is the one surface that turns an entry into a card, a
 * search hit and an install handle. `marketplace` is the engine's own identity for a source, so the
 * built-in name is the name its catalogue declares, not the repository shorthand it is added by.
 */
export const BUILTIN_MARKETPLACE_NAME = 'claude-plugins-official'

/** The source the built-in marketplace is added by: a GitHub shorthand the engine classifies itself. */
export const BUILTIN_MARKETPLACE_SOURCE = 'anthropics/claude-plugins-official'

/**
 * The marketplace this application's bundled plugin package is published from.
 *
 * It is a reserved identity (`src-tauri/src/services/plugins/builtin.rs::BUILTIN_MARKETPLACE_NAME`),
 * not a catalogue the reader chooses: it exists so the engine has somewhere to install the built-in
 * plugin from, and its row is never a browsing source.
 */
const RESERVED_MARKETPLACE_NAME = 'omp-desktop-builtin'

/**
 * Install handles a previous bundle published and this build no longer carries.
 *
 * The catalogue cached on an older data root can still list them until the marketplace's next
 * refresh; a card for one would offer an install the bundle can no longer satisfy.
 */
const RETIRED_STORE_INSTALLS: Record<string, true> = {
  'omp.browser@omp-desktop-builtin': true,
}

/** One source URI as the repository it names, for comparing the forms the engine accepts. */
function marketplaceSourceKey(sourceUri: string): string {
  return sourceUri
    .trim()
    .toLowerCase()
    .replace(/^git@github\.com:/, '')
    .replace(/^ssh:\/\/git@github\.com\//, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

/**
 * Whether one registry row is the marketplace this build registers.
 *
 * The name alone is not the identity: a catalogue declares its own name, so another source can
 * publish under the same name and the registry keys only on it. Both the name and the source must
 * name this build's marketplace, and the source compares as a repository, so the shorthand, HTTPS
 * and SSH forms of the same GitHub repository are the same source.
 */
export function isBuiltinMarketplace(row: { name: string; sourceUri: string }): boolean {
  return (
    row.name === BUILTIN_MARKETPLACE_NAME &&
    marketplaceSourceKey(row.sourceUri) === BUILTIN_MARKETPLACE_SOURCE
  )
}

/**
 * The registry in the order the page shows it: the built-in marketplace first, then the registry's
 * own order. A duplicate name keeps its first row, because a name is the engine's key for a source.
 *
 * The reserved bundle marketplace and a local source whose directory is gone are not browsing
 * sources: the first is this application's own installation channel, and the second can neither be
 * refreshed nor read. They stay in the engine's registry; the page simply never offers them.
 */
export function orderMarketplaces(rows: readonly EngineMarketplaceRow[]): EngineMarketplaceRow[] {
  const seen = new Set<string>()
  const ordered: EngineMarketplaceRow[] = []
  for (const row of rows) {
    if (row.name === RESERVED_MARKETPLACE_NAME || row.available === false) continue
    if (seen.has(row.name)) continue
    seen.add(row.name)
    ordered.push(row)
  }
  const builtin = ordered.findIndex((row) => isBuiltinMarketplace(row))
  if (builtin > 0) {
    const [row] = ordered.splice(builtin, 1)
    ordered.unshift(row)
  }
  return ordered
}

/** One catalogue entry as a card draws it: every listing field, '' where none was published. */
export interface MarketEntryView {
  name: string
  description: string
  version: string
  author: string
  homepage: string
  repository: string
  license: string
  category: string
  tags: readonly string[]
  source: string
  /** The installation this entry would create, spelled the engine's own way. */
  installId: string
}

/** The installation id one catalogue entry installs as: `name@marketplace`, the engine's spelling. */
export function marketInstallId(entry: { name: string; marketplace: string }): string {
  return `${entry.name}@${entry.marketplace}`
}

/** One catalogue entry projected for a card; a field the listing did not publish draws no line. */
export function marketEntryView(entry: MarketplacePluginRow): MarketEntryView {
  return {
    name: entry.name,
    description: manifestText(entry.description),
    version: manifestText(entry.version),
    author: manifestText(entry.author),
    homepage: manifestText(entry.homepage),
    repository: manifestText(entry.repository),
    license: manifestText(entry.license),
    category: manifestText(entry.category),
    tags: entry.tags.filter((tag) => tag.trim() !== ''),
    source: manifestText(entry.source),
    installId: marketInstallId(entry),
  }
}

/** The haystack one catalogue entry contributes: the four fields the contract publishes. */
function marketSearchText(entry: MarketplacePluginRow): string {
  return [entry.name, entry.description ?? '', entry.category ?? '', entry.tags.join(' ')]
    .join(' ')
    .toLowerCase()
}

/** The entries the market page's query selects, in the engine's own order. */
export function filterMarketEntries(
  entries: readonly MarketplacePluginRow[],
  query: string,
): MarketplacePluginRow[] {
  const published = entries.filter(
    (entry) => RETIRED_STORE_INSTALLS[marketInstallId(entry)] !== true,
  )
  const term = query.trim().toLowerCase()
  if (term === '') {
    return [...published]
  }
  return published.filter((entry) => marketSearchText(entry).includes(term))
}

/** One marketplace's entries the page shows, narrowed by the page's own query. */
export function marketplaceEntries(
  entries: readonly MarketplacePluginRow[],
  marketplace: string,
  query: string,
): MarketplacePluginRow[] {
  return filterMarketEntries(
    entries.filter((entry) => entry.marketplace === marketplace),
    query,
  )
}

/**
 * The installation one catalogue entry would create at `scope`, or null while it is not installed.
 *
 * The match is on the engine's install handle (`name@marketplace`), which is what the entry installs
 * as and what the host reports on the row; a row's own id is the plugin, shared by every marketplace
 * that publishes it. The scope is the page's own workspace picker: the user scope means the one
 * machine-wide installation, a workspace means that workspace's project registry.
 */
export function installedForEntry(
  entry: MarketplacePluginRow,
  rows: readonly PluginRow[],
  scope: 'user' | 'project' = 'user',
): PluginRow | null {
  const installId = marketInstallId(entry)
  return rows.find((row) => row.installId === installId && row.scope === scope) ?? null
}

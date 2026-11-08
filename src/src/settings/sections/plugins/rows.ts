import type { ApiError } from '@/api/client'
import type {
  EnginePluginCode,
  EnginePluginSource,
  EnginePluginSourceOption,
  EnginePluginToolchain,
  EnginePluginUpdate,
  MarketplacePluginRow,
  PluginRow,
  PluginSettingSchema,
} from '@/api/plugins-types'
import type { Language } from '@/lib/i18n'
import type { PluginsCopy } from '@/settings/sections/plugins/copy'

/**
 * The plugin page's pure projections: everything that turns the host's reports into what a row, a
 * badge, a search or a settings field reads, with no React and no IPC in it.
 *
 * They are here rather than in the components because each one is a rule the page repeats in several
 * places — a version in the list and in the detail view, a permission in the consent card and in the
 * detail view, a search term over four fields — and because the engine reports machine tokens
 * (permissions, consent reasons, source kinds, scope names, toolchain tools), so every sentence a
 * reader sees is resolved here and a token this build cannot word falls back to the engine's own
 * spelling rather than to a blank line.
 */

/** The three binaries the host probes before an install that may need one. */
const TOOLCHAIN_TOOLS = ['bun', 'git', 'npm'] as const

type PluginToolchainTool = (typeof TOOLCHAIN_TOOLS)[number]

/**
 * The host lifecycle codes, whose sentence is an unlocalized English one and whose condition is a
 * fact about the whole app rather than about the write that met it: a page states its own line
 * instead of repeating the host's. Ported from the Vue app's `isHostLifecycleCode`.
 */
const HOST_CODES: Readonly<Record<string, true>> = {
  host_exited: true,
  host_crashed: true,
  host_not_ready: true,
  timeout: true,
  host_failed: true,
  env_pin_failed: true,
  protocol_mismatch: true,
  ENGINE_NOT_FOUND: true,
  ENGINE_SPAWN_FAILED: true,
  ENGINE_CHECKSUM_MISMATCH: true,
  ENGINE_PROTOCOL: true,
}

/** One manifest string as the wire may carry it: anything that is not a string is not text. */
function manifestText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** The plugin's own i18n block for one language, or null when the manifest carries none. */
function manifestLocale(row: PluginRow, language: Language): Record<string, unknown> | null {
  const i18n = row.desktop?.i18n
  if (i18n === null || i18n === undefined) {
    return null
  }
  const locale = i18n[language]
  return typeof locale === 'object' && locale !== null ? (locale as Record<string, unknown>) : null
}


/** One plugin's own translation table for its setting keys, or null when it ships none. */
export function pluginSettingLabels(
  row: PluginRow,
  language: Language,
): Record<string, unknown> | null {
  const settings = manifestLocale(row, language)?.settings
  return typeof settings === 'object' && settings !== null
    ? (settings as Record<string, unknown>)
    : null
}

/** `v1.2.3`, unless the engine's string already spells its own prefix. */
function prefixVersion(version: string): string {
  const trimmed = version.trim()
  return /^v\d/i.test(trimmed) ? trimmed : `v${trimmed}`
}

/**
 * A row's version line: `v1.2.3`, or `v1.2.3 → v2.0.0` while an update is pending.
 *
 * Both endpoints are the engine's own comparison; this only displays them. A row without a version
 * has an empty line rather than a placeholder, and the views hide the line for exactly that reason.
 */
export function formatPluginVersion(
  row: Pick<PluginRow, 'version'>,
  update: { from: string; to: string } | null,
): string {
  if (update !== null) {
    return `${prefixVersion(update.from)} → ${prefixVersion(update.to)}`
  }
  const version = manifestText(row.version)
  return version === '' ? '' : prefixVersion(version)
}

const TIMESTAMP_LOCALES: Readonly<Record<Language, string>> = { en: 'en-US', zh: 'zh-CN' }

/**
 * One registry timestamp, in the reader's own locale and time zone.
 *
 * A value that is not a date is shown exactly as it arrived rather than being swallowed: a timestamp
 * this side cannot parse is still a fact about the plugin's record.
 */
export function formatPluginTimestamp(value: string | null, language: Language): string {
  const text = manifestText(value)
  if (text === '') {
    return ''
  }
  const at = new Date(text)
  if (Number.isNaN(at.getTime())) {
    return text
  }
  return new Intl.DateTimeFormat(TIMESTAMP_LOCALES[language], {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at)
}

/** How much of a commit sha a row shows. Empty in, empty out. */
export function shortPluginRevision(sha: string | null): string {
  return sha?.trim().slice(0, 7) ?? ''
}

/**
 * The id the engine's own commands address one installation by.
 *
 * A row's `id` is the plugin — what pages, themes and consent grants are keyed by — while the
 * engine still installs `name@marketplace` units. The two are not interchangeable: passing a plugin
 * id to an uninstall silently names nothing, and passing an install handle into a page key splits
 * one plugin into two. So this is the only place that decides, and every engine write reads it.
 *
 * - marketplace install: the row's `installId` (`name@marketplace`);
 * - npm package / linked directory: the row's `id`, which is that package's name;
 * - a marketplace row without an `installId` is a contract violation, and answers null rather than
 *   falling back to the plugin id — the host would refuse the write, and guessing here would let a
 *   bug become a wrong write against whatever that id happens to name.
 */
export function pluginTargetId(
  row: Pick<PluginRow, 'id' | 'installId' | 'source'>,
): string | null {
  const installId = (row.installId ?? '').trim()
  if (row.source.kind === 'marketplace') {
    return installId === '' ? null : installId
  }
  if (installId !== '') return installId
  const id = row.id.trim()
  return id === '' ? null : id
}

/** The source line of one row: the kind, and the label the host reported. */
export function formatPluginSource(source: EnginePluginSource, copy: PluginsCopy): string {
  const kind = copy.sourceKinds[source.kind] ?? source.kind
  const label = source.label.trim()
  return label === '' ? kind : `${kind} · ${label}`
}

/** One source as the detail view and the row's badge draw it. */
export interface PluginSourceView {
  marketplace: string
  version: string
  sourceLabel: string
  /** True for the source the installation in hand came from. */
  installed: boolean
}

/**
 * Every source one plugin id is available from, the installed one first.
 *
 * The order is the page's own rule rather than the host's: the installed source is the fact a reader
 * checks first, and the rest read as "also published by …". Two entries for one marketplace are
 * collapsed onto the installed one, so a host that repeats a source cannot draw the same line twice.
 */
export function pluginSourceViews(
  sources: readonly EnginePluginSourceOption[],
  installedMarketplace: string | null,
): PluginSourceView[] {
  /** One entry per marketplace, keeping the host's own installed mark over an unmarked duplicate. */
  const byMarketplace = new Map<string, { view: PluginSourceView; explicit: boolean }>()
  for (const source of sources) {
    const marketplace = source.marketplace.trim()
    if (marketplace === '') continue
    const previous = byMarketplace.get(marketplace)
    if (previous === undefined || (source.installed && !previous.explicit)) {
      byMarketplace.set(marketplace, {
        view: {
          marketplace,
          version: manifestText(source.version),
          sourceLabel: manifestText(source.sourceLabel),
          installed: source.installed,
        },
        explicit: source.installed,
      })
    }
  }
  return [...byMarketplace.values()]
    .map(({ view }) => ({
      ...view,
      // The row's own marketplace is the installed one even when the host did not repeat the mark.
      installed:
        view.installed || (installedMarketplace !== null && view.marketplace === installedMarketplace),
    }))
    .sort(
      (left, right) =>
        Number(right.installed) - Number(left.installed) ||
        left.marketplace.localeCompare(right.marketplace),
    )
}

/** The installed source line (`market-a · v1.2.3`), or just the marketplace when it names no version. */
export function formatMarketplaceSource(view: PluginSourceView): string {
  const version = view.version.trim()
  return version === '' ? view.marketplace : `${view.marketplace} · ${prefixVersion(version)}`
}

/**
 * The sources a plugin is published by, as the detail view lists them: the installed one and the
 * ones this plugin could be switched to. Empty for a plugin no marketplace publishes.
 */
export function pluginSourceList(row: {
  sources?: readonly EnginePluginSourceOption[]
  source: Pick<EnginePluginSource, 'marketplace'>
}): PluginSourceView[] {
  return pluginSourceViews(row.sources ?? [], row.source.marketplace)
}

/**
 * The installed source of a plugin, or null when it did not come from a marketplace.
 *
 * The marketplace is the row's own `source.marketplace`, and the version is the row's installed
 * version — the one number that is a fact about the installation. `sources[]` versions are what each
 * marketplace publishes (the candidates the update check compares), so they belong to the "also
 * published by" list rather than beside the installed version.
 */
export function installedPluginSource(row: {
  version?: string | null
  source: Pick<EnginePluginSource, 'marketplace'>
}): PluginSourceView | null {
  const marketplace = (row.source.marketplace ?? '').trim()
  if (marketplace === '') return null
  return {
    marketplace,
    version: (row.version ?? '').trim(),
    sourceLabel: '',
    installed: true,
  }
}

/**
 * How an update is applied, decided from what the host answered.
 *
 * The engine's own upgrade only reinstalls within one marketplace, so a `switch-source` update is a
 * destructive two-step write and needs the page's confirmation card. Anything this build does not
 * recognise — a future kind, or a switch the host could not name a target marketplace for — reads as
 * the ordinary in-place update, because that is the only route the page can run without a target.
 */
export function pluginUpdateConfirmation(
  update: Pick<EnginePluginUpdate, 'kind' | 'marketplace'>,
): 'in-place' | 'switch-card' {
  const marketplace = (update.marketplace ?? '').trim()
  return update.kind === 'switch-source' && marketplace !== '' ? 'switch-card' : 'in-place'
}

/** The label of an update's action, per the write it starts. */
export function pluginUpdateActionLabel(
  update: Pick<EnginePluginUpdate, 'kind' | 'marketplace'>,
  copy: Pick<PluginsCopy, 'updateAction' | 'switchSourceAction'>,
): string {
  return pluginUpdateConfirmation(update) === 'switch-card'
    ? copy.switchSourceAction
    : copy.updateAction
}

/** The badge of a pending update, per the write it starts. */
export function pluginUpdateBadgeLabel(
  update: Pick<EnginePluginUpdate, 'kind' | 'marketplace'>,
  copy: Pick<PluginsCopy, 'updateBadge' | 'switchSourceBadge'>,
): string {
  return pluginUpdateConfirmation(update) === 'switch-card'
    ? copy.switchSourceBadge
    : copy.updateBadge
}


/**
 * The capability list, in plain language: one line per part the host reported, and no line for a
 * part it did not. The consent card and the detail view both show it, so it is built once here.
 */
export function pluginCapabilityLabels(code: EnginePluginCode, copy: PluginsCopy): string[] {
  const labels: string[] = []
  if (code.extensions > 0) labels.push(copy.capabilityLabels.extensions(code.extensions))
  if (code.baseTools) labels.push(copy.capabilityLabels.baseTools)
  if (code.baseHooks) labels.push(copy.capabilityLabels.baseHooks)
  if (code.hooksDir) labels.push(copy.capabilityLabels.hooksDir)
  if (code.toolsDir) labels.push(copy.capabilityLabels.toolsDir)
  if (code.mcpConfig) labels.push(copy.capabilityLabels.mcpConfig)
  if (code.skillsDir) labels.push(copy.capabilityLabels.skillsDir)
  if (code.commandsDir) labels.push(copy.capabilityLabels.commandsDir)
  if (code.agentsDir) labels.push(copy.capabilityLabels.agentsDir)
  if (code.rulesDir) labels.push(copy.capabilityLabels.rulesDir)
  if (code.promptsDir) labels.push(copy.capabilityLabels.promptsDir)
  if (code.lspConfig) labels.push(copy.capabilityLabels.lspConfig)
  if (code.dapConfig) labels.push(copy.capabilityLabels.dapConfig)
  return labels
}

/** The label of each consent reason, in the order they arrived; an unknown token keeps its spelling. */
export function pluginConsentLabel(reasons: readonly string[], copy: PluginsCopy): string[] {
  return reasons.map((reason) => copy.consentReasonLabels[reason] ?? reason)
}

/** The label of one permission; an unknown name is shown as the engine spelled it. */
export function pluginPermissionLabel(permission: string, copy: PluginsCopy): string {
  return copy.permissionLabels[permission] ?? permission
}

/** The scope line that pairs with a permission's label; an unknown name has no scope to state. */
export function pluginPermissionScope(permission: string, copy: PluginsCopy): string {
  return copy.permissionScopes[permission] ?? ''
}

/**
 * Whether the domain list a permission carries is really "any host".
 *
 * The two keys are read here and nowhere else in the page: the flag is honoured only when the
 * manifest also declared `net.anyHost` (the host's re-check refuses the pair split, and this keeps
 * the display honest for a row from a build that refused nothing). A plugin with the widening gets
 * the widening's sentence instead of a list of names it does not have.
 */
export function pluginReachesAnyHost(
  permissions: readonly string[],
  netAnyHost: boolean | undefined,
): boolean {
  return netAnyHost === true && permissions.includes('net.anyHost')
}

/** The three file modes whose scope line `fs.anyPath` replaces. */
export const PLUGIN_FS_MODE_PERMISSIONS = ['fs.read', 'fs.write', 'fs.delete'] as const

/**
 * Whether an installation reaches any path, i.e. whether its file modes still have a scope to state.
 *
 * One key, unlike `net.anyHost`: `fs.anyPath` is a permission token that cannot be read as "listed a
 * scope", so the declaration alone is the fact. The three modes then have no range to describe -
 * `fs.read.scope` is not what they resolve against any more - and the widening's own sentence is the
 * only true one on the page. Without this the consent list would show "the files the manifest lists
 * under `fs.read.scope`" and "every path on this machine" side by side, and the reader would have to
 * guess which one the gate honours.
 */
export function pluginReachesAnyPath(permissions: readonly string[]): boolean {
  return permissions.includes('fs.anyPath')
}

/** The diagnostics line for the toolchain: every tool the host probed, and whether it found it. */
export function toolchainSummary(toolchain: EnginePluginToolchain, copy: PluginsCopy): string {
  return TOOLCHAIN_TOOLS.map(
    (tool) => `${tool}: ${toolchain[tool] ? copy.toolchainAvailable : copy.toolchainMissing}`,
  ).join(' · ')
}

/**
 * The tool a refusal's own sentence names, when it names one of the tools the host probes.
 *
 * The host's sentence is read, never shown: it can carry a machine path, so the page keeps the one
 * fact it wants to repeat — which binary was missing — and words everything else itself. A tool name
 * is only accepted as a whole word, so a message about a "bundle" is not read as a missing `bun`.
 */
function pluginInstallUnavailableTool(message: string): PluginToolchainTool | null {
  const text = message.toLowerCase()
  return (
    TOOLCHAIN_TOOLS.find((tool) => new RegExp(`(^|[^a-z0-9])${tool}([^a-z0-9]|$)`).test(text)) ?? null
  )
}

/**
 * The page's own line for an install refused because a tool is missing, or null when the refusal is
 * some other one and keeps its own handling. Both spellings of the code are accepted — the desktop
 * layer's uppercase one and the host's own lowercase one — because they name the same condition.
 */
function pluginInstallUnavailableMessage(
  code: string,
  message: string,
  copy: PluginsCopy,
): string | null {
  if (code !== 'PLUGIN_INSTALL_UNAVAILABLE' && code !== 'plugin_install_unavailable') {
    return null
  }
  const tool = pluginInstallUnavailableTool(message)
  return tool === null ? copy.installUnavailableGeneric : copy.installUnavailableTool(tool)
}

/** The page's own line for a write that could not stop the plugin, or null for any other refusal. */
function pluginDisableFailedMessage(code: string, copy: PluginsCopy): string | null {
  return code === 'PLUGIN_DISABLE_FAILED' || code === 'plugin_disable_failed'
    ? copy.disableFailedMessage
    : null
}

/**
 * A host refusal as this page states it: the heading it is drawn under, the code, and the sentence.
 *
 * A lifecycle code is a fact about the app rather than about the write — the session or the workspace
 * is gone — and the app states it elsewhere already, so this answers the page's own heading with no
 * sentence at all. A condition the page words itself is stated in the reader's own language; every
 * other refusal keeps the host's sentence, which is the reader's only clue about it.
 */
export function pluginFailureView(
  failure: ApiError,
  copy: PluginsCopy,
): { title: string; code: string; message: string } {
  if (HOST_CODES[failure.code] === true) {
    return { title: copy.writeFailed, code: '', message: '' }
  }
  const unavailable = pluginInstallUnavailableMessage(failure.code, failure.message, copy)
  if (unavailable !== null) {
    return { title: copy.installUnavailableTitle, code: failure.code, message: unavailable }
  }
  const worded = pluginDisableFailedMessage(failure.code, copy)
  return { title: copy.writeFailed, code: failure.code, message: worded ?? failure.message }
}

/** The label of one setting row: the plugin's own name for the key, else the schema's description. */
export function pluginSettingLabel(
  key: string,
  schema: PluginSettingSchema,
  labels: Record<string, unknown> | null,
): string {
  const localized = manifestText(labels?.[key])
  if (localized !== '') {
    return localized
  }
  const description = manifestText(schema.description)
  return description === '' ? key : description
}

/** The three states a row's own status can be in. */
type PluginRowStatus = 'enabled' | 'disabled' | 'error'

/**
 * The row's status. A desktop block the host rejected — or could not parse at all — is the one
 * failure a row can report on its own; otherwise the status repeats `enabled`, which is the engine's
 * own answer.
 */
export function pluginStatus(row: PluginRow): PluginRowStatus {
  if ((row.desktopError ?? '').trim() !== '') {
    return 'error'
  }
  if (row.desktop !== null && !row.desktop.valid) {
    return 'error'
  }
  return row.enabled ? 'enabled' : 'disabled'
}

/** The label of one scope; an unknown scope is shown as the host spelled it. */
export function pluginScopeLabel(scope: string, copy: PluginsCopy): string {
  return copy.scopeLabels[scope] ?? scope
}

/* ------------------------------------------------------------------- the store */

/** The installation id one catalogue entry installs as: `name@marketplace`, the engine's spelling. */
function storeInstallId(entry: { name: string; marketplace: string }): string {
  return `${entry.name}@${entry.marketplace}`
}

/** One catalogue entry as the store draws it: every listing field, '' where none was published. */
interface StoreEntryView {
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

/** One catalogue entry projected for a card; a field the listing did not publish draws no line. */
export function storeEntryView(entry: MarketplacePluginRow): StoreEntryView {
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
    installId: storeInstallId(entry),
  }
}

/** The haystack one catalogue entry contributes: the four fields the contract publishes. */
function storeSearchText(entry: MarketplacePluginRow): string {
  return [entry.name, entry.description ?? '', entry.category ?? '', entry.tags.join(' ')]
    .join(' ')
    .toLowerCase()
}

/** The entries the store's query selects, in the engine's own order. */
export function filterStoreEntries(
  entries: readonly MarketplacePluginRow[],
  query: string,
): MarketplacePluginRow[] {
  const term = query.trim().toLowerCase()
  if (term === '') {
    return [...entries]
  }
  return entries.filter((entry) => storeSearchText(entry).includes(term))
}

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'

import type { ApiError } from '@/api/client'
import type { MarketplacePluginRow } from '@/api/plugins-types'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import {
  catalogueResource,
  marketplacesResource,
  readCatalogue,
  readMarketplaces,
  refreshMarketplaceCatalogue,
  writeMarketplaceAdd,
  writeMarketplaceRemove,
  writeMarketplaceUpdate,
} from '@/state/plugins-store'
import { useResourceState } from '@/state/resource'
import {
  SettingsBadge,
  SettingsCard,
  SettingsEmpty,
  SettingsField,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
} from '@/settings/parts'
import type { PluginsCopy } from '@/settings/sections/plugins/copy'
import type { PluginActions, PluginEntry } from '@/settings/sections/plugins/contract'
import { filterStoreEntries, storeEntryView } from '@/settings/sections/plugins/rows'

/**
 * Installs that used to be published from the bundled marketplace and are now first-party
 * surfaces. The catalogue on an older data root may still list them until its next refresh;
 * the store hides them by the engine handle it installs under.
 */
const RETIRED_BUILTIN_STORE_ENTRIES = new Set(['omp.browser@omp-desktop-builtin'])

/** The install handles this build still serves as its own; their store cards never offer removal. */
const BUILTIN_STORE_INSTALLS = new Set(['omp.terminal@omp-desktop-builtin'])

/**
 * The store: what the registered marketplaces publish, and the sources they come from.
 *
 * The catalogue is a listing, not an installation, so nothing about a plugin's permissions is known
 * before its package is read — the engine reads the manifest at install time and the consent gate
 * states it before the plugin can be enabled. An entry is installed by its `name@marketplace`, the
 * engine's own spelling of a marketplace source, and every install here lands in the user's own
 * registry, which is the scope the store's own "already installed" test uses.
 *
 * The registry writes are this view's own: a marketplace is not an installation, and a refusal of
 * one is stated beside the sources rather than filed against a plugin row.
 */
export function PluginStoreView({
  copy,
  entries,
  actions,
  onBack,
}: {
  copy: PluginsCopy
  /** Every installation the engine reports, which is what "already installed" is decided on. */
  entries: readonly PluginEntry[]
  actions: PluginActions
  onBack: () => void
}) {
  const marketplaces = useResourceState(marketplacesResource)
  const catalogue = useResourceState(catalogueResource)

  const [query, setQuery] = useState('')
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [source, setSource] = useState('')
  const [sourceError, setSourceError] = useState('')
  /** The registry write in flight: `refresh` / `add` / `update:<name>` / `remove:<name>`. */
  const [busyKey, setBusyKey] = useState('')
  /** The registry's last refusal, with the page's own heading for the write that met it. */
  const [failure, setFailure] = useState<{ title: string; error: ApiError } | null>(null)
  /** The host's honest half of a refresh answer: it reused a catalogue read that was recent. */
  const [throttled, setThrottled] = useState(false)
  /** The catalogue entry whose install is in flight, so that one card's button can say so. */
  const [installingId, setInstallingId] = useState('')

  useEffect(() => {
    void readMarketplaces()
    void readCatalogue()
  }, [])

  /** One registry write: the lock, the refusal and the catalogue re-read all in one place. */
  const run = useCallback(
    async (
      key: string,
      title: string,
      write: () => Promise<ApiError | null>,
      reread: boolean,
    ): Promise<boolean> => {
      if (busyKey !== '') return false
      setBusyKey(key)
      setFailure(null)
      const error = await write()
      if (error !== null) {
        setFailure({ title, error })
      } else if (reread) {
        await readCatalogue(true)
      }
      setBusyKey('')
      return error === null
    },
    [busyKey],
  )

  const refreshCatalogue = useCallback(async () => {
    if (busyKey !== '') return
    setBusyKey('refresh')
    setFailure(null)
    const answer = await refreshMarketplaceCatalogue()
    setThrottled(answer.throttled)
    if (answer.error !== null) setFailure({ title: copy.storeRefreshFailed, error: answer.error })
    setBusyKey('')
  }, [busyKey, copy.storeRefreshFailed])

  const addSource = useCallback(async () => {
    const trimmed = source.trim()
    if (trimmed === '') {
      setSourceError(copy.sourceRequired)
      return
    }
    setSourceError('')
    const accepted = await run(
      'add',
      copy.storeAddSourceFailed,
      () => writeMarketplaceAdd(trimmed),
      true,
    )
    // A refused source stays in the field so it can be corrected rather than retyped.
    if (accepted) setSource('')
  }, [copy.sourceRequired, copy.storeAddSourceFailed, run, source])

  /** Installs one entry by its `name@marketplace`, in the scope the store installs into. */
  const installEntry = useCallback(
    async (entry: MarketplacePluginRow) => {
      const view = storeEntryView(entry)
      setInstallingId(view.installId)
      await actions.installSource(view.installId, 'user')
      setInstallingId('')
    },
    [actions],
  )

  const rows = catalogue.value ?? []
  const visible = filterStoreEntries(rows, query).filter(
    (entry) => !RETIRED_BUILTIN_STORE_ENTRIES.has(storeEntryView(entry).installId),
  )
  const marketplaceRows = marketplaces.value ?? []

  /** The catalogue, grouped by the marketplace each entry was read from, in catalogue order. */
  const groups: { name: string; entries: MarketplacePluginRow[] }[] = []
  for (const entry of visible) {
    const group = groups.find((candidate) => candidate.name === entry.marketplace)
    if (group === undefined) {
      groups.push({ name: entry.marketplace, entries: [entry] })
    } else {
      group.entries.push(entry)
    }
  }

  /**
   * The installation one entry would create, or null while it is not installed in this scope.
   *
   * Matched by the engine's install handle (`name@marketplace`), which is what the entry installs
   * as and what the host reports on the row; a row's own `id` is the plugin, shared by every
   * marketplace that publishes it.
   */
  function installedEntry(entry: MarketplacePluginRow): PluginEntry | null {
    const installId = storeEntryView(entry).installId
    return (
      entries.find(
        (candidate) => candidate.row.installId === installId && candidate.row.scope === 'user',
      ) ?? null
    )
  }

  const busy = busyKey !== '' || actions.busyKey !== ''

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          {copy.backAction}
        </Button>
        <span className="text-sm leading-5 font-semibold text-foreground">{copy.storeTitle}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busyKey !== ''}
            onClick={() => void refreshCatalogue()}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {busyKey === 'refresh' ? copy.storeRefreshing : copy.storeRefreshAction}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={sourcesOpen}
            onClick={() => setSourcesOpen((open) => !open)}
          >
            {copy.storeSourcesAction}
          </Button>
          <Button
            size="sm"
            aria-expanded={addOpen}
            onClick={() => setAddOpen((open) => !open)}
          >
            <Plus size={14} aria-hidden="true" />
            {copy.storeAddSourceAction}
          </Button>
        </div>
      </div>

      <p className="text-[13px] leading-[19px] text-muted-foreground">{copy.storeSubtitle}</p>

      {failure === null ? null : (
        <SettingsNotice variant="destructive" title={failure.title}>
          <span className="flex flex-wrap items-center gap-1.5">
            <SettingsBadge>{failure.error.code}</SettingsBadge>
            <span className="min-w-0">{failure.error.message}</span>
          </span>
        </SettingsNotice>
      )}

      {catalogue.error === null ? null : (
        <SettingsNotice variant="destructive" title={copy.storeLoadFailed}>
          <span className="flex flex-wrap items-center gap-1.5">
            <SettingsBadge>{catalogue.error.code}</SettingsBadge>
            <span className="min-w-0">{catalogue.error.message}</span>
          </span>
        </SettingsNotice>
      )}

      {throttled ? (
        <p className="text-[13px] leading-[19px] text-muted-foreground">{copy.storeThrottledNote}</p>
      ) : null}

      {sourcesOpen ? (
        <SettingsGroup title={copy.storeSourcesTitle}>
          <SettingsCard>
            {marketplaceRows.length === 0 ? (
              <SettingsEmpty>{copy.storeSourcesEmpty}</SettingsEmpty>
            ) : (
              marketplaceRows.map((marketplace) => (
                <SettingsRow
                  key={marketplace.name}
                  title={marketplace.name}
                  description={marketplace.sourceUri}
                  control={
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyKey !== ''}
                        aria-label={copy.storeSourcesRefresh}
                        title={copy.storeSourcesRefresh}
                        onClick={() =>
                          void run(
                            `update:${marketplace.name}`,
                            copy.writeFailed,
                            () => writeMarketplaceUpdate(marketplace.name),
                            true,
                          )
                        }
                      >
                        <RefreshCw size={14} aria-hidden="true" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyKey !== ''}
                        aria-label={copy.storeSourcesRemove}
                        title={copy.storeSourcesRemove}
                        onClick={() =>
                          void run(
                            `remove:${marketplace.name}`,
                            copy.writeFailed,
                            () => writeMarketplaceRemove(marketplace.name),
                            true,
                          )
                        }
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </Button>
                    </>
                  }
                />
              ))
            )}
          </SettingsCard>
        </SettingsGroup>
      ) : null}

      {addOpen ? (
        <SettingsCard>
          <div className="flex flex-col gap-4 px-5 py-[15px]">
            <SettingsField label={copy.storeAddSourceLabel} hint={copy.storeAddSourceHint}>
              <Input
                value={source}
                onChange={(next) => {
                  setSource(next)
                  setSourceError('')
                }}
                placeholder={copy.storeAddSourcePlaceholder}
                aria-label={copy.storeAddSourceLabel}
                error={sourceError === '' ? undefined : sourceError}
                reserveErrorLine
                autoComplete="off"
                spellCheck={false}
                classNames={{ field: 'h-9 rounded-lg', input: 'text-sm' }}
              />
            </SettingsField>
            <div>
              <Button
                size="sm"
                disabled={busyKey !== '' || source.trim() === ''}
                onClick={() => void addSource()}
              >
                <Plus size={14} aria-hidden="true" />
                {copy.storeAddSourceSubmit}
              </Button>
            </div>
          </div>
        </SettingsCard>
      ) : null}

      <div className="w-full max-w-[320px]">
        <Input
          value={query}
          onChange={setQuery}
          placeholder={copy.storeSearchPlaceholder}
          aria-label={copy.storeSearchLabel}
          leftIcon={<Search />}
          classNames={{ field: 'h-9 rounded-lg', input: 'text-sm' }}
        />
      </div>

      {catalogue.status === 'loading' && catalogue.value === null ? (
        <p className="text-[13px] leading-[19px] text-muted-foreground" role="status">
          {copy.loading}
        </p>
      ) : visible.length === 0 ? (
        <SettingsEmpty>{query.trim() === '' ? copy.storeEmpty : copy.storeSearchEmpty}</SettingsEmpty>
      ) : (
        groups.map((group) => (
          <SettingsGroup key={group.name} title={`${group.name} · ${group.entries.length}`}>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.entries.map((entry) => {
                const view = storeEntryView(entry)
                const installed = installedEntry(entry)
                const builtinInstalled =
                  installed !== null &&
                  (installed.row.builtin ||
                    BUILTIN_STORE_INSTALLS.has(installed.row.installId ?? ''))
                const installing = actions.busyKey === 'install' && installingId === view.installId
                return (
                  <div
                    key={view.installId}
                    className="flex flex-col gap-2 rounded-2xl border border-border/60 p-4"
                  >
                    <span className="text-sm leading-5 font-medium text-foreground">{view.name}</span>
                    {view.description === '' ? null : (
                      <span className="text-[13px] leading-[19px] text-muted-foreground">
                        {view.description}
                      </span>
                    )}
                    <span className="flex flex-wrap items-center gap-1.5">
                      {view.version === '' ? null : <SettingsBadge>{view.version}</SettingsBadge>}
                      <SettingsBadge>{view.installId}</SettingsBadge>
                    </span>

                    <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                      {installed === null ? (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void installEntry(entry)}
                        >
                          <Plus size={14} aria-hidden="true" />
                          {installing ? copy.storeInstalling : copy.storeInstallAction}
                        </Button>
                      ) : (
                        <>
                          <AnimatedBadge
                            status="success"
                            size="sm"
                            showIcon={false}
                            animated={false}
                          >
                            {copy.storeInstalledBadge}
                          </AnimatedBadge>
                          {builtinInstalled ? (
                            <span title={copy.builtinHint}>
                              <AnimatedBadge
                                status="info"
                                size="sm"
                                showIcon={false}
                                animated={false}
                              >
                                {copy.builtinBadge}
                              </AnimatedBadge>
                            </span>
                          ) : (
                            <>
                              {installed.update === null ? null : (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={busy}
                                  onClick={() => actions.upgrade(installed.row)}
                                >
                                  {copy.updateAction}
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => actions.requestUninstall(installed.row)}
                              >
                                <Trash2 size={14} aria-hidden="true" />
                                {copy.uninstallAction}
                              </Button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </SettingsGroup>
        ))
      )}
    </>
  )
}

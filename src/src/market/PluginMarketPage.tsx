import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Store,
} from 'lucide-react'

import type { ApiError } from '@/api/client'
import type {
  EngineMarketplaceRow,
  MarketplacePluginRow,
  PluginRow,
} from '@/api/plugins-types'
import {
  Alert,
  AlertAction,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from '@/components/motion/alert'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import { Button } from '@/components/motion/button'
import { Card } from '@/components/motion/card'
import { Input } from '@/components/motion/input'
import { Loader } from '@/components/motion/loader'
import { MenuList, type MenuItem } from '@/components/motion/menu-list'
import { Pagination } from '@/components/motion/pagination'
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from '@/components/motion/popover-morph'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/motion/select'
import { Tooltip } from '@/components/motion/tooltip'
import { useCopy } from '@/lib/i18n'
import {
  marketEntryView,
  marketplaceEntries,
  orderMarketplaces,
} from '@/lib/plugin-market'
import { cn } from '@/lib/utils'
import { MARKET_COPY } from '@/market/market-copy'
import { MarketEntryGrid } from '@/market/MarketEntryGrid'
import {
  MarketEmptyState,
  MarketSelectorSkeleton,
  MarketSkeleton,
} from '@/market/MarketStates'
import type { PluginEntry } from '@/settings/sections/plugins/contract'
import { PluginConsentDialog } from '@/settings/sections/plugins/PluginConsentDialog'
import {
  setMarketplaceEnabled,
  useDisabledMarketplaces,
} from '@/state/market-visibility'
import { MarketSourcesDialog } from '@/market/MarketSourcesDialog'
import {
  catalogueResource,
  ensureBuiltinMarketplace,
  isGranted,
  marketGrantsResource,
  marketplacesResource,
  marketPluginsResource,
  pluginKey,
  readCatalogue,
  readMarketGrants,
  readMarketPlugins,
  readMarketplaces,
  writeGrant,
  writeMarketplaceAdd,
  writeMarketplaceRemove,
  writeMarketplaceUpdate,
  writePluginEnabled,
  writePluginInstallSource,
} from '@/state/plugins-store'
import { useResourceState } from '@/state/resource'
import { useWorkspaceScope, type WorkspaceScopeTarget } from '@/settings/use-workspace-scope'
import { useStoreSelector } from '@/state/store'
import { workspaceStore, type WorkspaceState } from '@/state/workspace-store'
import { WorkspaceScopeSelect } from '@/settings/WorkspaceScopeSelect'

/** Stable empties, so a resource with nothing in it does not rebuild the page every render. */
const NO_MARKETS: readonly EngineMarketplaceRow[] = []
const NO_ENTRIES: readonly MarketplacePluginRow[] = []
const NO_ROWS: readonly PluginRow[] = []

/** One page of the catalogue grid: three rows of three on the widest layout. */
const PLUGIN_PAGE_SIZE = 9

/**
 * The plugin marketplace: every registered marketplace's catalogue, in one place.
 *
 * The registry and the catalogues are the engine's own answers (`history` of them lives in the host),
 * and this page is a reader plus four writes: add a source, refresh the browsable sources, remove a
 * source, and install one entry at the scope the workspace picker names. Managing an installation —
 * enabling, updating, removing — stays in the plugin page in Settings, because those writes change a
 * plugin the reader already owns.
 *
 * The built-in marketplace is seeded by `plugins-store.ts::ensureBuiltinMarketplace` rather than by a
 * build-time catalogue: the engine's own `marketplaces_add` fetches and validates it, and a reader who
 * removed it gets it back on the next visit.
 */
export function PluginMarketPage({
  onBack,
  onOpenPlugins,
  onCreatePlugin,
  initialScope,
}: {
  /** Leave for the surface the reader came from: the plugin page or the conversation column. */
  onBack: () => void
  /** Open the installed plugin page in Settings; the plugin page starts at its own user scope. */
  onOpenPlugins: () => void
  /** Start the guided plugin-authoring flow with this prompt in the composer. */
  onCreatePlugin: (prompt: string) => void
  /** The scope carried in from plugin management; `user` when the rail opened this page. */
  initialScope?: WorkspaceScopeTarget
}) {
  const copy = useCopy(MARKET_COPY)
  const { workspaceId, target, setTarget } = useWorkspaceScope(initialScope ?? 'user')
  /** The installation scope one card would write: the machine's, or the picked workspace's. */
  const installScope = target === 'user' ? 'user' : 'project'
  const workspaces = useStoreSelector(
    workspaceStore,
    (state: WorkspaceState) => state.items,
  )
  const workspaceName =
    target === 'user'
      ? ''
      : (workspaces.find((workspace) => workspace.id === target)?.name ?? '')
  const installLabel =
    target === 'user' ? copy.installToUser : copy.installToProject(workspaceName)
  const marketplacesState = useResourceState(marketplacesResource)
  const catalogueState = useResourceState(catalogueResource)
  const pluginsState = useResourceState(marketPluginsResource)
  const grantsState = useResourceState(marketGrantsResource)

  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  const [cataloguePage, setCataloguePage] = useState(1)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [source, setSource] = useState('')
  const [sourceError, setSourceError] = useState('')
  /** The write in flight: `refresh` / `add` / `remove:<name>` / `install:<id>`. */
  const [busyKey, setBusyKey] = useState('')
  const [failure, setFailure] = useState<{ title: string; error: ApiError } | null>(null)
  const [notice, setNotice] = useState('')
  const [seeding, setSeeding] = useState(true)
  const [seedError, setSeedError] = useState<ApiError | null>(null)
  /** The installed entry whose code still needs the reader's confirmation. */
  const [consentEntry, setConsentEntry] = useState<PluginEntry | null>(null)

  /** The seed, then the catalogue it makes readable. A page left mid-read mounts nothing else. */
  const prepare = useCallback(async () => {
    await readMarketplaces()
    const error = await ensureBuiltinMarketplace()
    setSeedError(error)
    if (error === null) await readCatalogue(true)
    setSeeding(false)
  }, [])

  useEffect(() => {
    void prepare()
  }, [prepare])

  useEffect(() => {
    void readMarketGrants(workspaceId)
    void readMarketPlugins(workspaceId)
  }, [workspaceId])

  const marketplaces = marketplacesState.value ?? NO_MARKETS
  const disabledMarketplaces = useDisabledMarketplaces()
  const sources = useMemo(() => orderMarketplaces(marketplaces), [marketplaces])
  const browsable = useMemo(
    () => sources.filter((row) => !disabledMarketplaces.includes(row.name)),
    [disabledMarketplaces, sources],
  )
  const active = browsable.some((row) => row.name === selected)
    ? selected
    : (browsable[0]?.name ?? '')
  const entries = catalogueState.value ?? NO_ENTRIES
  const visible = useMemo(
    () => marketplaceEntries(entries, active, query),
    [active, entries, query],
  )
  const cataloguePages = Math.max(1, Math.ceil(visible.length / PLUGIN_PAGE_SIZE))
  const cataloguePageCurrent = Math.min(cataloguePage, cataloguePages)
  const pageEntries = visible.slice(
    (cataloguePageCurrent - 1) * PLUGIN_PAGE_SIZE,
    cataloguePageCurrent * PLUGIN_PAGE_SIZE,
  )
  const installed = pluginsState.value?.plugins ?? NO_ROWS
  const grants = grantsState.value
  const busy = busyKey !== ''

  const addItems = useMemo<MenuItem[]>(
    () => [
      {
        id: 'create',
        label: copy.addCreate,
        icon: Sparkles,
        onSelect: () => {
          setMenuOpen(false)
          onCreatePlugin(copy.createPrompt)
        },
      },
      {
        id: 'market',
        label: copy.addMarket,
        icon: Plus,
        onSelect: () => {
          setMenuOpen(false)
          setFormOpen(true)
        },
      },
    ],
    [copy.addCreate, copy.addMarket, copy.createPrompt, onCreatePlugin],
  )

  const refresh = useCallback(async () => {
    if (busy) return
    setBusyKey('refresh')
    setFailure(null)
    setNotice('')
    // One catalogue at a time, over the sources this page offers: a hidden or missing source would
    // otherwise fail the whole refresh with a path the reader cannot see or fix here.
    let firstError: ApiError | null = null
    for (const marketplace of browsable) {
      const error = await writeMarketplaceUpdate(marketplace.name)
      if (error !== null && firstError === null) firstError = error
    }
    await readMarketplaces()
    await readCatalogue(true)
    if (firstError !== null) setFailure({ title: copy.refreshFailed, error: firstError })
    setBusyKey('')
  }, [browsable, busy, copy.refreshFailed])

  const addSource = useCallback(async () => {
    const trimmed = source.trim()
    if (trimmed === '') {
      setSourceError(copy.addSourceRequired)
      return
    }
    if (busy) return
    setBusyKey('add')
    setFailure(null)
    setNotice('')
    setSourceError('')
    const error = await writeMarketplaceAdd(trimmed)
    if (error !== null) {
      setFailure({ title: copy.addSourceFailed, error })
    } else {
      setSource('')
      setFormOpen(false)
      await readCatalogue(true)
    }
    setBusyKey('')
  }, [busy, copy.addSourceFailed, copy.addSourceRequired, source])

  const removeSource = useCallback(
    async (name: string): Promise<boolean> => {
      if (busy) return false
      setBusyKey(`remove:${name}`)
      setFailure(null)
      setNotice('')
      const error = await writeMarketplaceRemove(name)
      if (error !== null) {
        setFailure({ title: copy.removeFailed, error })
      } else {
        await readCatalogue(true)
      }
      setBusyKey('')
      return error === null
    },
    [busy, copy.removeFailed],
  )

  /** Switch one source on or off for browsing; it stays registered either way. */
  const toggleSource = setMarketplaceEnabled

  const installEntry = useCallback(
    async (entry: MarketplacePluginRow) => {
      if (busy) return
      const view = marketEntryView(entry)
      setBusyKey(`install:${view.installId}`)
      setFailure(null)
      setNotice('')
      const error = await writePluginInstallSource(workspaceId, view.installId, installScope)
      setBusyKey('')
      if (error !== null) {
        setFailure({ title: copy.installFailed, error })
        return
      }
      setNotice(copy.installedNotice(view.name))
      const installedRow = marketPluginsResource.store
        .get()
        .value?.plugins.find(
          (row) => row.installId === view.installId && row.scope === installScope,
        )
      const currentGrants = marketGrantsResource.store.get().value ?? []
      if (
        installedRow !== undefined &&
        installedRow.consent.required &&
        !isGranted(currentGrants, installedRow.id, installedRow.scope)
      ) {
        setConsentEntry({
          row: installedRow,
          key: pluginKey(installedRow),
          name: view.name,
          description: installedRow.description ?? '',
          update: null,
          granted: false,
        })
      }
    },
    [busy, copy, installScope, workspaceId],
  )

  const confirmConsent = useCallback(async () => {
    const entry = consentEntry
    if (entry === null || busy) return
    setBusyKey('consent')
    setFailure(null)
    setNotice('')
    const grantError = await writeGrant(workspaceId, entry.row.id, true, entry.row.scope)
    if (grantError !== null) {
      setFailure({ title: copy.consentFailed, error: grantError })
      setBusyKey('')
      return
    }
    if (entry.row.installId !== null) {
      const enableError = await writePluginEnabled(
        workspaceId,
        entry.row.installId,
        true,
        entry.row.scope,
      )
      if (enableError !== null) {
        setFailure({ title: copy.consentFailed, error: enableError })
        setBusyKey('')
        return
      }
    }
    setBusyKey('')
    setConsentEntry(null)
  }, [busy, consentEntry, copy.consentFailed, workspaceId])

  /** One branch per catalogue state, so the render tree does not repeat the same conditions. */
  const renderCatalogueBody = () => {
    if (browsable.length === 0) {
      if (seeding) return <MarketSkeleton label={copy.preparingBuiltin} />
      const noSources = sources.length === 0
      return (
        <MarketEmptyState
          icon={<Store className="size-5" aria-hidden="true" />}
          title={noSources ? copy.sourcesEmpty : copy.emptyBrowseTitle}
          description={noSources ? copy.emptyNoSourcesBody : copy.emptyBrowseBody}
          action={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                if (noSources) setFormOpen(true)
                else setSourcesOpen(true)
              }}
            >
              {noSources ? copy.emptyAddMarket : copy.emptyOpenSources}
            </Button>
          }
        />
      )
    }
    if (catalogueState.status === 'loading' && catalogueState.value === null) {
      return <MarketSkeleton label={seeding ? copy.preparingBuiltin : copy.loading} />
    }
    if (catalogueState.error !== null) {
      return (
        <Alert variant="destructive">
          <AlertIcon />
          <AlertContent>
            <AlertTitle>{copy.loadFailed}</AlertTitle>
            <AlertDescription>{catalogueState.error.message}</AlertDescription>
          </AlertContent>
        </Alert>
      )
    }
    if (visible.length === 0) {
      if (query.trim() === '') {
        return (
          <MarketEmptyState
            icon={<Store className="size-5" aria-hidden="true" />}
            title={copy.empty}
            description={copy.emptyMarketBody}
          />
        )
      }
      return (
        <MarketEmptyState
          icon={<Search className="size-5" aria-hidden="true" />}
          title={copy.searchEmpty}
          description={copy.emptySearchBody}
          action={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setQuery('')
                setCataloguePage(1)
              }}
            >
              {copy.clearSearch}
            </Button>
          }
        />
      )
    }
    return (
      <>
        <MarketEntryGrid
          entries={pageEntries}
          installed={installed}
          scope={installScope}
          grants={grants}
          busy={busy}
          busyKey={busyKey}
          copy={copy}
          installLabel={installLabel}
          onInstall={(entry) => void installEntry(entry)}
          onConsent={(row, name) => {
            setFailure(null)
            setNotice('')
            setConsentEntry({
              row,
              key: pluginKey(row),
              name,
              description: row.description ?? '',
              update: null,
              granted: false,
            })
          }}
        />
        {cataloguePages <= 1 ? null : (
          <div className="flex justify-center pt-1">
            <Pagination
              totalPages={cataloguePages}
              page={cataloguePageCurrent}
              onPageChange={setCataloguePage}
              labels={{
                pagination: copy.pagination,
                previous: copy.previousPage,
                next: copy.nextPage,
                page: copy.pageOf,
                back: copy.backPages,
                forward: copy.forwardPages,
              }}
            />
          </div>
        )}
      </>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto bg-pane">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-3">
              <Tooltip content={copy.back}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={copy.back}
                  onClick={onBack}
                  className="size-9 shrink-0 rounded-full border border-border bg-background/60 text-foreground hover:bg-muted"
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                </Button>
              </Tooltip>
              <h1 className="min-w-0 truncate text-[22px] leading-7 font-semibold text-foreground">
                {copy.title}
              </h1>
            </div>
            <p className="max-w-[640px] text-[13px] leading-[19px] text-muted-foreground">
              {copy.subtitle}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Tooltip content={copy.refresh}>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                aria-label={copy.refresh}
                disabled={busy}
                onClick={() => void refresh()}
                className="size-9 rounded-lg"
              >
                <RefreshCw
                  className={cn('size-4', busyKey === 'refresh' && 'animate-spin')}
                  aria-hidden="true"
                />
              </Button>
            </Tooltip>
            <MarketSourcesDialog
              open={sourcesOpen}
              onOpenChange={setSourcesOpen}
              marketplaces={sources}
              busyKey={busyKey}
              failure={failure}
              copy={copy}
              disabled={disabledMarketplaces}
              onToggle={toggleSource}
              onRemove={removeSource}
              trigger={
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  aria-label={copy.sourcesAction}
                  title={copy.sourcesAction}
                  className="size-9 rounded-lg"
                >
                  <Store className="size-4" aria-hidden="true" />
                </Button>
              }
            />
            <MorphPopover open={menuOpen} onOpenChange={setMenuOpen}>
              <MorphPopoverTrigger>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                >
                  {copy.addAction}
                  <ChevronDown className="size-3.5" aria-hidden="true" />
                </Button>
              </MorphPopoverTrigger>
              <MorphPopoverContent
                side="bottom"
                align="end"
                sideOffset={6}
                radius={12}
                className="w-56 p-1.5"
              >
                <MenuList items={addItems} />
              </MorphPopoverContent>
            </MorphPopover>
            <Button type="button" size="sm" onClick={onOpenPlugins}>
              {copy.manage}
            </Button>
          </div>
        </div>

        {failure === null || sourcesOpen ? null : (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertTitle>{failure.title}</AlertTitle>
              <AlertDescription>
                <span className="flex flex-wrap items-center gap-1.5">
                  <AnimatedBadge animated={false} size="sm" showIcon={false}>
                    {failure.error.code}
                  </AnimatedBadge>
                  <span className="min-w-0 break-words">{failure.error.message}</span>
                </span>
              </AlertDescription>
            </AlertContent>
          </Alert>
        )}

        {notice === '' ? null : (
          <p className="text-[13px] leading-[19px] text-muted-foreground" role="status">
            {notice}
          </p>
        )}

        {seedError === null ? null : (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertTitle>{copy.builtinFailed}</AlertTitle>
              <AlertDescription>
                <span className="flex flex-wrap items-center gap-1.5">
                  <AnimatedBadge animated={false} size="sm" showIcon={false}>
                    {seedError.code}
                  </AnimatedBadge>
                  <span className="min-w-0 break-words">{seedError.message}</span>
                </span>
              </AlertDescription>
              <AlertAction>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setSeeding(true)
                    void prepare()
                  }}
                >
                  {copy.retry}
                </Button>
              </AlertAction>
            </AlertContent>
          </Alert>
        )}

        {sources.length === 0 ? (
          seeding ? (
            <MarketSelectorSkeleton />
          ) : seedError === null ? (
            <p className="text-[13px] leading-[19px] text-muted-foreground">{copy.sourcesEmpty}</p>
          ) : null
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <WorkspaceScopeSelect value={target} onChange={setTarget} />
            <div className="w-[min(380px,100%)] min-w-0">
              <Select
                value={active}
                onValueChange={(name) => {
                  setSelected(name)
                  setCataloguePage(1)
                }}
                className="w-full min-w-0"
              >
                <SelectTrigger aria-label={copy.sourcesTitle}>
                  <SelectValue placeholder={copy.selectPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {browsable.map((marketplace) => (
                    <SelectItem key={marketplace.name} value={marketplace.name}>
                      {marketplace.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {formOpen ? (
          <Card size="compact" aria-busy={busyKey === 'add'} className="flex flex-col gap-3 px-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm leading-5 font-medium text-foreground">
                {copy.addSourceLabel}
              </span>
              <Input
                value={source}
                onChange={(next) => {
                  setSource(next)
                  setSourceError('')
                }}
                disabled={busyKey === 'add'}
                placeholder={copy.addSourcePlaceholder}
                aria-label={copy.addSourceLabel}
                error={sourceError === '' ? undefined : sourceError}
                reserveErrorLine
                autoComplete="off"
                spellCheck={false}
                classNames={{ field: 'h-9 rounded-lg', input: 'text-sm' }}
              />
            </label>
            <p className="text-xs leading-[18px] text-muted-foreground">{copy.addSourceHint}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy || source.trim() === ''}
                onClick={() => void addSource()}
              >
                {busyKey === 'add' ? (
                  <span aria-hidden="true" className="inline-flex">
                    <Loader size={14} speed={0.9} />
                  </span>
                ) : (
                  <Plus className="size-3.5" aria-hidden="true" />
                )}
                {busyKey === 'add' ? copy.addSourceSubmitting : copy.addSourceSubmit}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busyKey === 'add'}
                onClick={() => {
                  setFormOpen(false)
                  setSourceError('')
                }}
              >
                {copy.cancel}
              </Button>
            </div>
          </Card>
        ) : null}

        <div className="grid w-full grid-cols-[minmax(0,380px)_auto] items-center gap-3">
          <div className="min-w-0">
            <Input
              value={query}
              onChange={(next) => {
                setQuery(next)
                setCataloguePage(1)
              }}
              placeholder={copy.searchPlaceholder}
              aria-label={copy.searchLabel}
              leftIcon={<Search />}
              classNames={{ field: 'h-9 rounded-lg', input: 'text-sm' }}
            />
          </div>
          <span className="text-xs leading-[18px] text-muted-foreground">
            {copy.entryCount(visible.length)}
          </span>
        </div>

        {renderCatalogueBody()}

        <PluginConsentDialog
          entry={consentEntry}
          busy={busy}
          failure={failure?.error ?? null}
          onConfirm={() => void confirmConsent()}
          onCancel={() => setConsentEntry(null)}
        />
      </div>
    </div>
  )
}

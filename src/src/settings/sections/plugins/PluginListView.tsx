import { memo, useCallback, useEffect, useState } from 'react'
import {
  CircleArrowUp,
  Download,
  FileArchive,
  FolderOpen,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Store,
} from 'lucide-react'

import type { ApiError } from '@/api/client'
import { PLUGIN_TEMPLATES, type PluginTemplate } from '@/api/plugins'
import { chooseFolder, choosePluginPackage } from '@/api/dialog'
import { pluginAutoUpdate } from '@/api/plugins'
import type { InspectPackageView, PluginInstallPreview } from '@/api/plugins-types'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/motion/select'
import { SkeletonBar } from '@/components/motion/skeleton-bar'
import { Switch } from '@/components/motion/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { WorkspaceScopeSelect } from '@/settings/WorkspaceScopeSelect'
import type { WorkspaceScopeTarget } from '@/settings/use-workspace-scope'
import { inspectPluginPackageFile, previewPluginInstallFile, type TrackedPluginTask } from '@/state/plugins-store'
import { SettingsBadge, SettingsCard, SettingsField, SettingsGroup, SettingsNotice } from '@/settings/parts'
import type { PluginsCopy } from '@/settings/sections/plugins/copy'
import {
  entriesInScope,
  type PluginActions,
  type PluginEntry,
  type PluginScope,
} from '@/settings/sections/plugins/contract'
import { PluginListSkeleton } from '@/settings/sections/plugins/PluginListSkeleton'
import {
  formatMarketplaceSource,
  formatPluginSource,
  formatPluginVersion,
  installedPluginSource,
  pluginFailureView,
  pluginPermissionLabel,
  pluginTargetId,
  pluginUpdateBadgeLabel,
} from '@/settings/sections/plugins/rows'

/** The one source string a longer value than this cannot be; the host refuses it too. */
const SOURCE_MAX_LENGTH = 512

/** The toolbar's add control: its own state is the panel's open flag, not the write lock. */
const AddButton = memo(function AddButton({
  open,
  label,
  onToggle,
}: {
  open: boolean
  label: string
  onToggle: () => void
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-expanded={open}
      onClick={onToggle}
    >
      <Plus size={14} aria-hidden="true" />
      {label}
    </Button>
  )
})

/**
 * The installed list: the scope it is showing, one search field, the actions the engine offers over
 * the list, and a row per installation.
 *
 * Nothing here decides a plugin's state — the engine owns the install, the enable flag and the
 * settings, and the desktop records only its own consent grant — so every row draws what the page
 * was handed and reports the press back. The one thing this view does own is the source-install
 * form's own text, because a half-typed source string is nobody else's state.
 */
export function PluginListView({
  copy,
  actions,
  entries,
  updateCount,
  checking,
  refreshing,
  reloading,
  workspaceTarget,
  listTarget,
  onWorkspaceTarget,
  tasks,
  onStopTask,
  onOpenMarket,
  onOpenDetail,
}: {
  copy: PluginsCopy
  actions: PluginActions
  /** Every installation the engine reports, in its own order, before scope and query. */
  entries: readonly PluginEntry[]
  /**
   * How many pending updates the engine's own upgrade can apply. A source switch is not part of
   * this: it uninstalls first and asks for its own confirmation.
   */
  updateCount: number
  checking: boolean
  /** The installation/grants read is in flight; the refresh control draws its wait. */
  refreshing: boolean
  /** The plugin-state reload is in flight; the same skeleton keeps the list geometry. */
  reloading: boolean
  /** The workspace whose registry the list shows; `user` is the machine-wide scope. */
  workspaceTarget: WorkspaceScopeTarget
  /** The scope the rows are drawn in; it lags the picker until a switch's reads answer. */
  listTarget: WorkspaceScopeTarget
  onWorkspaceTarget: (target: WorkspaceScopeTarget) => void
  /** The long installs this process is running, newest first. */
  tasks: readonly TrackedPluginTask[]
  onStopTask: (taskId: string) => void
  /** Leave for the plugin marketplace, where the catalogues are browsed and installed from. */
  onOpenMarket: () => void
  onOpenDetail: (entry: PluginEntry) => void
}) {
  /** The search term; the list itself follows the workspace picker's scope. */
  const [query, setQuery] = useState('')
  /** Whether the install panel is showing; the header's `添加` toggles it. */
  const [installOpen, setInstallOpen] = useState(false)
  const toggleInstall = useCallback(() => setInstallOpen((open) => !open), [])
  /** Which of the four routes the panel is on: a source string, a package file, a URL, a template. */
  const [route, setRoute] = useState<'source' | 'file' | 'url' | 'template'>('source')
  const [source, setSource] = useState('')
  // A new installation lands where the reader is looking unless they choose otherwise.
  const [installScope, setInstallScope] = useState<PluginScope>(
    workspaceTarget === 'user' ? 'user' : 'project',
  )
  const [sourceError, setSourceError] = useState('')
  /** The last dry-run of a source install, and whether one is in flight. */
  const [preview, setPreview] = useState<PluginInstallPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<ApiError | null>(null)
  const [forceInstall, setForceInstall] = useState(false)
  /** The engine's startup marketplace policy; read once when the page mounts. */
  const [autoUpdate, setAutoUpdate] = useState('')
  useEffect(() => {
    let live = true
    void pluginAutoUpdate()
      .then((view) => {
        if (live) setAutoUpdate(view.value)
      })
      .catch(() => {
        // A refused read leaves the selector on its initial value; the setting itself is unchanged.
      })
    return () => {
      live = false
    }
  }, [])
  const changeAutoUpdate = useCallback(async (next: string) => {
    setAutoUpdate(next)
    try {
      const view = await pluginAutoUpdate(next)
      setAutoUpdate(view.value)
    } catch {
      // The host refused the write; leave the engine's current value as the only truth by re-reading.
      const view = await pluginAutoUpdate().catch(() => null)
      if (view !== null) setAutoUpdate(view.value)
    }
  }, [])
  /** The picked package, and what the host read out of it before anything was installed. */
  const [packagePath, setPackagePath] = useState('')
  const [inspection, setInspection] = useState<InspectPackageView | null>(null)
  const [packageError, setPackageError] = useState<ApiError | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [url, setUrl] = useState('')
  const [sha256, setSha256] = useState('')
  const [urlError, setUrlError] = useState('')
  const [shaError, setShaError] = useState('')
  /** The authoring template, the folder it goes into, and where it was actually written. */
  const [template, setTemplate] = useState<PluginTemplate>('panel-basic')
  const [templateDir, setTemplateDir] = useState('')
  const [scaffoldPath, setScaffoldPath] = useState('')
  const [scaffoldError, setScaffoldError] = useState<ApiError | null>(null)

  const busy = actions.busyKey !== ''
  /** The picker is the scope: the machine's user registry, or the chosen workspace's project one. */
  const effectiveScope: PluginScope = listTarget === 'user' ? 'user' : 'project'
  const installing =
    actions.busyKey === 'install' ||
    actions.busyKey === 'install-file' ||
    actions.busyKey === 'install-url'
  const scaffolding = actions.busyKey === 'scaffold'
  const visible = entriesInScope(entries, effectiveScope, query)
  const searching = query.trim() !== ''
  const listLoading = refreshing || checking || reloading

  /** Dry-run the source: the engine's own `--dry-run`, without writing anything. */
  async function previewInstall(): Promise<void> {
    const trimmed = source.trim()
    if (trimmed === '') {
      setSourceError(copy.sourceRequired)
      return
    }
    if (trimmed.length > SOURCE_MAX_LENGTH) {
      setSourceError(copy.sourceTooLong)
      return
    }
    setSourceError('')
    setPreview(null)
    setPreviewError(null)
    setPreviewing(true)
    const { preview: read, error } = await previewPluginInstallFile(
      workspaceTarget === 'user' ? null : workspaceTarget,
      trimmed,
      installScope,
      forceInstall,
    )
    setPreviewing(false)
    if (read === null) setPreviewError(error)
    else setPreview(read)
  }

  async function submitInstall(): Promise<void> {
    const trimmed = source.trim()
    if (trimmed === '') {
      setSourceError(copy.sourceRequired)
      return
    }
    if (trimmed.length > SOURCE_MAX_LENGTH) {
      setSourceError(copy.sourceTooLong)
      return
    }
    setSourceError('')
    const error = await actions.installSource(trimmed, installScope, forceInstall)
    // The installed row is the answer, not the path that produced it: once the engine accepted the
    // source, the form closes and forgets it, the way the reference client's add flow returns to the list. A
    // refusal stays in the field so it can be corrected rather than retyped.
    if (error === null) {
      setSource('')
      setInstallOpen(false)
    }
  }

  /**
   * Choose a package and read it.
   *
   * The read is a preview, not a gate: the package installs when the install button is pressed
   * whether or not the preview was taken, so the card informs the choice instead of standing in
   * front of it.
   */
  async function pickPackage(): Promise<void> {
    const chosen = await choosePluginPackage(copy.choosePackageTitle)
    if (chosen === null) return
    setPackagePath(chosen)
    setInspection(null)
    setPackageError(null)
    setInspecting(true)
    const { inspection: read, error } = await inspectPluginPackageFile(chosen)
    setInspecting(false)
    if (read === null) setPackageError(error)
    else setInspection(read)
  }

  async function submitPackage(): Promise<void> {
    if (packagePath === '') return
    const error = await actions.installPackage(packagePath, installScope)
    if (error !== null) return
    setPackagePath('')
    setInspection(null)
    setInstallOpen(false)
  }

  async function submitUrl(): Promise<void> {
    const address = url.trim()
    const digest = sha256.trim()
    if (address === '') {
      setUrlError(copy.urlRequired)
      return
    }
    // The host's own shape (`sanitize_sha256`): 64 lowercase hex characters. Checking it here
    // keeps a typo from becoming a download that could only fail after 200 MiB.
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      setShaError(copy.sha256Shape)
      return
    }
    setUrlError('')
    setShaError('')
    const error = await actions.installUrl(address, digest, installScope)
    if (error !== null) return
    setUrl('')
    setSha256('')
    setInstallOpen(false)
  }

  /** Choose where a template tree is written, and forget the previous answer about it. */
  async function pickTargetFolder(): Promise<void> {
    const chosen = await chooseFolder(copy.chooseTargetAction)
    if (chosen === null) return
    setTemplateDir(chosen)
    setScaffoldPath('')
    setScaffoldError(null)
  }

  async function submitTemplate(): Promise<void> {
    if (templateDir === '') return
    const { path, error } = await actions.scaffoldTemplate(template, templateDir)
    if (error !== null) {
      setScaffoldPath('')
      setScaffoldError(error)
      return
    }
    setScaffoldError(null)
    setScaffoldPath(path ?? '')
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <WorkspaceScopeSelect
          value={workspaceTarget}
          onChange={(next) => {
            // The install form follows the picker until the reader changes its own scope; a later
            // picker change resets it again, so a workspace install cannot land in the user registry.
            setInstallScope(next === 'user' ? 'user' : 'project')
            onWorkspaceTarget(next)
          }}
        />
        <div className="ml-auto w-[220px]">
          <Input
            value={query}
            onChange={setQuery}
            placeholder={copy.searchPlaceholderPlugins}
            aria-label={copy.searchLabel}
            leftIcon={<Search />}
            classNames={{ field: 'h-9 rounded-lg', input: 'text-sm' }}
          />
        </div>
      </div>

      <SettingsGroup>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={actions.refresh}
            aria-label={copy.refresh}
          >
            {refreshing ? (
              <SkeletonBar className="size-3.5 rounded-full" />
            ) : (
              <RefreshCw size={14} aria-hidden="true" />
            )}
            {copy.refresh}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={actions.checkUpdates}
          >
            {checking ? (
              <SkeletonBar className="size-3.5 rounded-full" />
            ) : (
              <Download size={14} aria-hidden="true" />
            )}
            {copy.updateCheckAction}
          </Button>
          {updateCount > 0 ? (
            <Button size="sm" variant="secondary" onClick={actions.upgradeAll}>
              <CircleArrowUp size={14} aria-hidden="true" />
              {copy.upgradeAllAction}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={actions.reload}
          >
            {reloading ? (
              <SkeletonBar className="size-3.5 rounded-full" />
            ) : (
              <Plug size={14} aria-hidden="true" />
            )}
            {copy.reloadAction}
          </Button>
          <Select value={autoUpdate} onValueChange={(next) => void changeAutoUpdate(next)}>
            <SelectTrigger aria-label={copy.autoUpdateLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{copy.autoUpdateValues.off}</SelectItem>
              <SelectItem value="notify">{copy.autoUpdateValues.notify}</SelectItem>
              <SelectItem value="auto">{copy.autoUpdateValues.auto}</SelectItem>
            </SelectContent>
          </Select>
          <AddButton
            open={installOpen}
            label={copy.addAction}
            onToggle={toggleInstall}
          />
          <Button size="sm" variant="ghost" onClick={onOpenMarket}>
            <Store size={14} aria-hidden="true" />
            {copy.marketAction}
          </Button>
        </div>

        {installOpen ? (
          <SettingsCard>
            <div className="flex flex-col gap-4 px-5 py-[15px]">
              <Tabs
                value={route}
                onValueChange={(next) =>
                  setRoute(
                    next === 'file'
                      ? 'file'
                      : next === 'url'
                        ? 'url'
                        : next === 'template'
                          ? 'template'
                          : 'source',
                  )
                }
                variant="segment"
              >
                <TabsList>
                  <TabsTrigger value="source">{copy.installModeSource}</TabsTrigger>
                  <TabsTrigger value="file">{copy.installModeFile}</TabsTrigger>
                  <TabsTrigger value="url">{copy.installModeUrl}</TabsTrigger>
                  <TabsTrigger value="template">{copy.installModeTemplate}</TabsTrigger>
                </TabsList>
              </Tabs>

              {route === 'source' ? (
                <div className="flex flex-col gap-3">
                  <SettingsField label={copy.installLabel} hint={copy.installHint}>
                    <Input
                      value={source}
                      onChange={(next) => {
                        setSource(next)
                        setSourceError('')
                        setPreview(null)
                        setPreviewError(null)
                      }}
                      placeholder={copy.installPlaceholder}
                      aria-label={copy.installLabel}
                      error={sourceError === '' ? undefined : sourceError}
                      reserveErrorLine
                      autoComplete="off"
                      spellCheck={false}
                      classNames={{ field: 'h-9 rounded-lg', input: 'text-sm' }}
                    />
                  </SettingsField>
                  <div className="flex flex-wrap items-center gap-3">
                    <Switch
                      checked={forceInstall}
                      ariaLabel={copy.forceInstallLabel}
                      label={copy.forceInstallLabel}
                      onCheckedChange={setForceInstall}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || previewing}
                      onClick={() => void previewInstall()}
                    >
                      {previewing ? copy.previewing : copy.previewAction}
                    </Button>
                  </div>
                  {preview === null ? null : (
                    <p className="text-[13px] leading-[19px] text-muted-foreground" role="status">
                      {copy.previewText(
                        preview.kind,
                        preview.name,
                        preview.version ?? '',
                        preview.scope,
                        preview.features === null ? copy.previewAllFeatures : preview.features.join(', '),
                      )}
                    </p>
                  )}
                  {previewError === null ? null : (
                    <SettingsNotice variant="destructive" title={copy.installTitle}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <SettingsBadge>{previewError.code}</SettingsBadge>
                        <span className="min-w-0">{previewError.message}</span>
                      </span>
                    </SettingsNotice>
                  )}
                </div>
              ) : route === 'file' ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void pickPackage()}>
                      <FileArchive size={14} aria-hidden="true" />
                      {copy.choosePackageAction}
                    </Button>
                    {packagePath === '' ? null : (
                      <code className="min-w-0 truncate font-mono text-xs leading-[18px] text-muted-foreground">
                        {packagePath}
                      </code>
                    )}
                  </div>
                  {inspecting ? (
                    <p className="text-[13px] leading-[19px] text-muted-foreground" role="status">
                      {copy.packageInspecting}
                    </p>
                  ) : packageError === null ? null : (
                    <SettingsNotice variant="destructive" title={copy.installTitle}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <SettingsBadge>{packageError.code}</SettingsBadge>
                        <span className="min-w-0">{packageError.message}</span>
                      </span>
                    </SettingsNotice>
                  )}
                  {inspection === null ? null : (
                    <div className="flex flex-col gap-2 rounded-[10px] border border-border px-4 py-3 text-[13px] leading-[19px]">
                      <strong className="text-sm leading-5 font-medium text-foreground">
                        {copy.packagePreviewTitle}
                        {': '}
                        {inspection.name}
                        {inspection.version === null ? '' : ` ${inspection.version}`}
                      </strong>
                      {inspection.description === null ? null : (
                        <p className="text-muted-foreground">{inspection.description}</p>
                      )}
                      <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
                        <li>{copy.packagePages(inspection.pageCount)}</li>
                        {inspection.hasExtensions ? <li>{copy.packageExtensions}</li> : null}
                        {inspection.permissions.length === 0 ? null : (
                          <li>
                            {inspection.permissions
                              .map((permission) => pluginPermissionLabel(permission, copy))
                              .join(' · ')}
                          </li>
                        )}
                        {inspection.netDomains.length === 0 ? null : (
                          <li>
                            {copy.permissionDomainsLabel}
                            {': '}
                            {inspection.netDomains.join(', ')}
                          </li>
                        )}
                      </ul>
                      <p className={inspection.checksumVerified ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400'}>
                        {inspection.checksumVerified
                          ? copy.packageChecksumOk(inspection.checksumCount)
                          : copy.packageChecksumMissing}
                      </p>
                      <p className="font-mono text-xs leading-[18px] break-all text-muted-foreground">
                        {copy.packageShaLabel}
                        {': '}
                        {inspection.sha256}
                      </p>
                    </div>
                  )}
                </div>
              ) : route === 'url' ? (
                <div className="flex flex-col gap-4">
                  <SettingsField label={copy.urlLabel} hint={copy.urlHint}>
                    <Input
                      value={url}
                      onChange={(next) => {
                        setUrl(next)
                        setUrlError('')
                      }}
                      placeholder={copy.urlPlaceholder}
                      aria-label={copy.urlLabel}
                      error={urlError === '' ? undefined : urlError}
                      reserveErrorLine
                      autoComplete="off"
                      spellCheck={false}
                      classNames={{ field: 'h-9 rounded-lg', input: 'text-sm' }}
                    />
                  </SettingsField>
                  <SettingsField label={copy.sha256Label} hint={copy.sha256Hint}>
                    <Input
                      value={sha256}
                      onChange={(next) => {
                        setSha256(next)
                        setShaError('')
                      }}
                      aria-label={copy.sha256Label}
                      error={shaError === '' ? undefined : shaError}
                      reserveErrorLine
                      autoComplete="off"
                      spellCheck={false}
                      classNames={{ field: 'h-9 rounded-lg', input: 'font-mono text-sm' }}
                    />
                  </SettingsField>
                </div>
              ) : null}
              {route === 'template' ? (
                <div className="flex flex-col gap-4">
                  <SettingsField label={copy.templateLabel} hint={copy.templateHint}>
                    <Select
                      value={template}
                      onValueChange={(next) =>
                        setTemplate(
                          PLUGIN_TEMPLATES.find((name) => name === next) ?? PLUGIN_TEMPLATES[0],
                        )
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PLUGIN_TEMPLATES.map((name) => (
                          <SelectItem key={name} value={name}>
                            {copy.templateNames[name]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingsField>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void pickTargetFolder()}
                    >
                      <FolderOpen size={14} aria-hidden="true" />
                      {copy.chooseTargetAction}
                    </Button>
                    {templateDir === '' ? null : (
                      <code className="min-w-0 truncate font-mono text-xs leading-[18px] text-muted-foreground">
                        {templateDir}
                      </code>
                    )}
                  </div>
                  {scaffoldError === null ? null : (
                    <SettingsNotice variant="destructive" title={copy.installTitle}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <SettingsBadge>{scaffoldError.code}</SettingsBadge>
                        <span className="min-w-0">{scaffoldError.message}</span>
                      </span>
                    </SettingsNotice>
                  )}
                  {scaffoldPath === '' ? null : (
                    <p className="font-mono text-xs leading-[18px] break-all text-muted-foreground">
                      {copy.scaffoldDone(scaffoldPath)}
                    </p>
                  )}
                </div>
              ) : null}

              <div className="flex flex-wrap items-end gap-3">
                {route === 'template' ? null : (
                  <div className="flex w-48 flex-col gap-1.5">
                    <span className="px-1 text-sm font-medium text-foreground">
                      {copy.installScopeLabel}
                    </span>
                    <Select
                      value={installScope}
                      onValueChange={(next) =>
                        setInstallScope(next === 'project' ? 'project' : 'user')
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">{copy.scopeUser}</SelectItem>
                        <SelectItem value="project">{copy.scopeWorkspace}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <Button
                  size="sm"
                  disabled={
                    installing
                    || scaffolding
                    || (route === 'file' && packagePath === '')
                    || (route === 'template' && templateDir === '')
                  }
                  onClick={
                    route === 'source'
                      ? () => void submitInstall()
                      : route === 'file'
                        ? () => void submitPackage()
                        : route === 'url'
                          ? () => void submitUrl()
                          : () => void submitTemplate()
                  }
                >
                  {scaffolding
                    ? copy.scaffolding
                    : installing
                      ? copy.installing
                      : route === 'template'
                        ? copy.scaffoldAction
                        : copy.installAction}
                </Button>
              </div>
            </div>
          </SettingsCard>
        ) : null}

        {tasks.length === 0 ? null : (
          <SettingsCard>
            {tasks.map((task) => (
              <div
                key={task.taskId}
                className="flex min-h-[52px] items-center justify-between gap-4 border-b border-border/60 px-5 py-3 last:border-b-0"
              >
                <span className="min-w-0 text-[13px] leading-[19px] text-muted-foreground" role="status">
                  {task.stage === null
                    ? // The started frame carries the host's machine token as its label
                      // (`plugin.import`); the page words it instead of printing it.
                      copy.installing
                    : copy.taskRunning(copy.taskStages[task.stage] ?? task.stage)}
                </span>
                <Button size="sm" variant="ghost" onClick={() => onStopTask(task.taskId)}>
                  {copy.taskCancel}
                </Button>
              </div>
            ))}
          </SettingsCard>
        )}

        <div className="relative">
          <div
            className={listLoading ? 'invisible' : undefined}
            aria-hidden={listLoading || undefined}
          >
            {visible.length > 0 ? (
              <SettingsCard>
                {visible.map((entry) => (
                  <PluginRowItem
                    key={entry.key}
                    entry={entry}
                    copy={copy}
                    failure={actions.failures[entry.key] ?? null}
                    onOpen={() => onOpenDetail(entry)}
                    onToggle={() => actions.toggle(entry.row)}
                  />
                ))}
              </SettingsCard>
            ) : searching ? (
              <p className="m-3.5 rounded-[10px] border border-dashed border-border p-3.5 text-center text-xs leading-[18px] text-muted-foreground">
                {copy.searchEmpty}
              </p>
            ) : (
              <div className="flex flex-col items-center gap-1.5 rounded-2xl border border-dashed border-border px-5 py-8 text-center">
                <strong className="text-sm leading-5 font-medium text-foreground">
                  {copy.installedEmptyTitle}
                </strong>
                <p className="text-[13px] leading-[19px] text-muted-foreground">
                  {copy.installedEmptyDescription}
                </p>
                <Button size="sm" className="mt-2" onClick={onOpenMarket}>
                  <Plus size={14} aria-hidden="true" />
                  {copy.marketAction}
                </Button>
              </div>
            )}
          </div>
          {listLoading ? (
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <PluginListSkeleton
                label={copy.loading}
                rows={Math.max(1, visible.length)}
              />
            </div>
          ) : null}
        </div>
      </SettingsGroup>
    </>
  )
}

/**
 * One installation: what it is called, what it is, and the switch the engine gates it by.
 *
 * The switch's label is the decision the page makes — a plugin whose manifest says it brings code is
 * not enabled before the reader confirms what it brings — so this row only reports the press.
 */
function PluginRowItem({
  entry,
  copy,
  failure,
  onOpen,
  onToggle,
}: {
  entry: PluginEntry
  copy: PluginsCopy
  failure: { code: string; message: string } | null
  onOpen: () => void
  onToggle: () => void
}) {
  const row = entry.row
  const version = formatPluginVersion(row, entry.update)
  const marketplaceSource = installedPluginSource(row)
  /** No engine handle means no write can name this installation; the switch says so instead. */
  const addressable = pluginTargetId(row) !== null
  const failureView = failure === null ? null : pluginFailureView(failure, copy)

  return (
    <div className="flex flex-col border-b border-border/60 last:border-b-0">
      <div className="flex min-h-[70px] items-center justify-between gap-6 px-5 py-[15px]">
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 flex-col gap-[3px] rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex flex-wrap items-center gap-2">
            <span
              className="text-sm leading-5 font-medium text-foreground"
              title={row.id}
            >
              {entry.name}
            </span>
            {entry.update === null ? null : (
              <AnimatedBadge status="info" size="sm" showIcon={false} animated={false}>
                {pluginUpdateBadgeLabel(entry.update, copy)}
              </AnimatedBadge>
            )}
            {row.shadowedBy === null ? null : (
              <span title={copy.shadowedHint}>
                <AnimatedBadge status="neutral" size="sm" showIcon={false} animated={false}>
                  {copy.shadowedBadge}
                </AnimatedBadge>
              </span>
            )}
            {row.builtin ? (
              <span title={copy.builtinHint}>
                <AnimatedBadge status="info" size="sm" showIcon={false} animated={false}>
                  {copy.builtinBadge}
                </AnimatedBadge>
              </span>
            ) : null}
          </span>
          <span className="text-[13px] leading-[19px] text-muted-foreground">
            {entry.description === '' ? copy.noDescription : entry.description}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {version === '' ? null : <SettingsBadge>{version}</SettingsBadge>}
            <SettingsBadge>{formatPluginSource(row.source, copy)}</SettingsBadge>
            {marketplaceSource === null ? null : (
              <SettingsBadge>{formatMarketplaceSource(marketplaceSource)}</SettingsBadge>
            )}
          </span>
        </button>

        <span title={row.builtin ? copy.builtinHint : undefined}>
          <Switch
            checked={row.enabled}
            // A built-in is the surface the build promises; its switch is not the reader's to turn
            // (`PLUGIN_BUILTIN_PROTECTED` answers a write that arrives anyway). A row the host
            // reported without an engine handle has no installation any write could name. A write
            // in flight is refused by `runWrite`; dimming every switch for it made the whole list
            // flicker and showed a not-allowed cursor, so the control keeps its normal appearance.
            disabled={row.builtin || !addressable}
            onCheckedChange={onToggle}
            ariaLabel={
              row.builtin
                ? copy.builtinHint
                : !addressable
                  ? copy.noInstallHandleHint
                  : row.enabled
                    ? copy.toggleOff(entry.name)
                    : copy.toggleOn(entry.name)
            }
          />
        </span>
      </div>

      {failureView === null ? null : (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-1.5 px-5 pb-3 text-xs leading-[18px] text-destructive"
        >
          {failureView.title}
          {failureView.code === '' ? null : <SettingsBadge>{failureView.code}</SettingsBadge>}
          {failureView.message === '' ? null : (
            <span className="min-w-0 text-muted-foreground">{failureView.message}</span>
          )}
        </p>
      )}
    </div>
  )
}

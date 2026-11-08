import { useMemo, useState } from 'react'

import { ArrowLeft, ChevronDown, RefreshCw, ShieldOff, Trash2 } from 'lucide-react'

import { toApiError, type ApiError } from '@/api/client'

import type {
  EnginePluginEngineInfo,
  EnginePluginSettings,
  PluginRow,
} from '@/api/plugins-types'
import { openPluginPanel } from '@/api/plugins'
import { PluginPageFrame } from '@/components/plugins/plugin-page-frame'
import { PluginPageIcon } from '@/components/plugins/plugin-page-icon'
import { pluginPagesOf } from '@/state/plugin-pages'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import { Button } from '@/components/motion/button'
import { useCopy, type Language, type Localized } from '@/lib/i18n'
import {
  SettingsBadge,
  SettingsCard,
  SettingsEmpty,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
} from '@/settings/parts'
import type { PluginsCopy } from '@/settings/sections/plugins/copy'
import type { PluginActions, PluginEntry } from '@/settings/sections/plugins/contract'
import { PluginPermissionList } from '@/settings/sections/plugins/PluginPermissionList'
import { PluginProcessSection } from '@/settings/sections/plugins/PluginProcessSection'
import { PluginSettingsForm } from '@/settings/sections/plugins/PluginSettingsForm'
import {
  formatMarketplaceSource,
  formatPluginSource,
  formatPluginTimestamp,
  formatPluginVersion,
  installedPluginSource,
  pluginCapabilityLabels,
  pluginFailureView,
  pluginScopeLabel,
  pluginSourceList,
  pluginStatus,
  pluginSettingLabels,
  pluginTargetId,
  pluginUpdateActionLabel,
  shortPluginRevision,
  toolchainSummary,
} from '@/settings/sections/plugins/rows'

interface PluginSurfaceCopy {
  panelsTitle: string
  openPanel: string
  panelFailed: string
  settingsPagesTitle: string
  settingsPagesNone: string
}

const SURFACE_COPY: Localized<PluginSurfaceCopy> = {
  en: {
    panelsTitle: 'Plugin panels',
    openPanel: 'Open panel',
    panelFailed: 'The panel could not be opened.',
    settingsPagesTitle: 'Plugin pages',
    settingsPagesNone: 'This plugin has no enabled settings page.',
  },
  zh: {
    panelsTitle: '插件面板',
    openPanel: '打开面板',
    panelFailed: '无法打开插件面板。',
    settingsPagesTitle: '插件页面',
    settingsPagesNone: '该插件没有可用的设置页面。',
  },
}

/**
 * One plugin in full: what it is, what it brings, what it may do, its settings and its diagnostics.
 *
 * Everything shown is a fact the host reported — a missing one is hidden rather than padded — and
 * the diagnostics block is the only place a failure that concerns the desktop part alone is stated,
 * because the plugin's engine part keeps loading regardless.
 *
 * The view writes nothing itself: upgrade, uninstall and the consent withdrawal are asks the page
 * answers (the last two through its own confirmation), and the settings form forwards its writes the
 * same way, so this view never decides what a button means.
 *
 * Its one exception is the plugin's resident process (`PluginProcessSection`): this build has no
 * command palette, so the commands a plugin contributes are executed here, and `pluginPaletteCommands`
 * in `process-rows.ts` is the list a future palette would read rather than a second one.
 */
export function PluginDetailView({
  entry,
  copy,
  language,
  actions,
  config,
  configStatus,
  configError,
  engineInfo,
  uninstallOpen,
  workspaceId,
  onBack,
}: {
  entry: PluginEntry
  copy: PluginsCopy
  language: Language
  actions: PluginActions
  config: EnginePluginSettings | null
  configStatus: 'idle' | 'loading' | 'ready' | 'error'
  configError: ApiError | null
  /** The engine the host is running, for the diagnostics block; null when the read was refused. */
  engineInfo: EnginePluginEngineInfo | null
  /** Whether this installation's uninstall is already being confirmed above the view. */
  uninstallOpen: boolean
  /** The workspace whose registry the row lives in; a process write is addressed through it. */
  workspaceId: number | null
  onBack: () => void
}) {
  const row: PluginRow = entry.row
  const busy = actions.busyKey !== ''
  const failure = actions.failures[entry.key] ?? null
  const failureView = failure === null ? null : pluginFailureView(failure, copy)
  const capabilities = pluginCapabilityLabels(row.code, copy)
  const version = formatPluginVersion(row, entry.update)
  const source = formatPluginSource(row.source, copy)
  const sources = pluginSourceList(row)
  const installedSource = installedPluginSource(row)
  /** No engine handle means no write can name this installation. */
  const addressable = pluginTargetId(row) !== null
  const revision = shortPluginRevision(row.source.gitCommitSha)
  const installedAt = formatPluginTimestamp(row.installedAt, language)
  const updatedAt = formatPluginTimestamp(row.lastUpdated, language)
  const surfaceCopy = useCopy(SURFACE_COPY)
  const surfaces = useMemo(() => pluginPagesOf([row], language), [language, row])
  const [selectedSettingsKey, setSelectedSettingsKey] = useState<string | null>(null)
  const [panelBusyKey, setPanelBusyKey] = useState<string | null>(null)
  const [panelError, setPanelError] = useState<ApiError | null>(null)
  const selectedSettingsPage =
    surfaces.settings.find((page) => page.key === selectedSettingsKey) ?? surfaces.settings[0] ?? null

  const openPanel = async (page: (typeof surfaces.panels)[number]): Promise<void> => {
    setPanelError(null)
    setPanelBusyKey(page.key)
    try {
      await openPluginPanel(row.id, row.scope, page.pageId, page.title)
    } catch (error) {
      setPanelError(toApiError(error))
    } finally {
      setPanelBusyKey(null)
    }
  }

  /** The desktop block's own verdict, worded; '' means the diagnostics block has other lines. */
  const desktopNote = ((): string => {
    const desktop = row.desktop
    if (desktop === null) {
      return (row.desktopError ?? '').trim() === '' ? copy.desktopAbsent : ''
    }
    return desktop.valid ? copy.desktopValid : copy.desktopInvalid
  })()

  /** The diagnostics' own lines: the engine's report, then the host's reason and parse error. */
  const diagnostics: { label: string; value: string }[] = []
  if (engineInfo !== null) {
    const sdk = engineInfo.sdkVersion.trim()
    if (sdk !== '') diagnostics.push({ label: copy.engineSdkVersionLabel, value: sdk })
    diagnostics.push({
      label: copy.engineProtocolVersionLabel,
      value: String(engineInfo.protocol),
    })
    diagnostics.push({
      label: copy.toolchainLabel,
      value: toolchainSummary(engineInfo.toolchain, copy),
    })
  }
  const reason = (row.desktop?.reason ?? '').trim()
  if (reason !== '') diagnostics.push({ label: copy.desktopReasonLabel, value: reason })
  const desktopError = (row.desktopError ?? '').trim()
  if (desktopError !== '') diagnostics.push({ label: copy.desktopErrorLabel, value: desktopError })

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          {copy.backAction}
        </Button>
        <span className="text-sm leading-5 font-semibold text-foreground">{entry.name}</span>
        <SettingsBadge>{row.id}</SettingsBadge>
        <SettingsBadge>{copy.statusLabels[pluginStatus(row)]}</SettingsBadge>
        <SettingsBadge>{pluginScopeLabel(row.scope, copy)}</SettingsBadge>
        {row.shadowedBy === null ? null : (
          <AnimatedBadge status="warning" size="sm" showIcon={false} animated={false}>
            {copy.shadowedBadge}
          </AnimatedBadge>
        )}
        {row.consent.required ? (
          <AnimatedBadge
            status={entry.granted ? 'success' : 'warning'}
            size="sm"
            showIcon={false}
            animated={false}
          >
            {entry.granted ? copy.consentGrantedBadge : copy.consentRequiredBadge}
          </AnimatedBadge>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions.busyKey === `plugin:${entry.key}` ? (
            <span className="text-xs leading-[18px] text-muted-foreground" role="status">
              {copy.writeBusy}
            </span>
          ) : null}
          {entry.update === null ? null : (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => actions.upgrade(row)}>
              <RefreshCw size={14} aria-hidden="true" />
              {pluginUpdateActionLabel(entry.update, copy)}
            </Button>
          )}
          <span title={row.builtin ? copy.builtinHint : undefined}>
            <Button
              size="sm"
              variant="secondary"
              // A built-in is not the reader's to remove; the command refuses it too
              // (`PLUGIN_BUILTIN_PROTECTED`). A row without an engine handle has nothing to remove.
              disabled={busy || uninstallOpen || row.builtin || !addressable}
              onClick={() => actions.requestUninstall(row)}
            >
              <Trash2 size={14} aria-hidden="true" />
              {copy.uninstallAction}
            </Button>
          </span>
          {row.consent.required && entry.granted ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !addressable}
              onClick={() => actions.revoke(row)}
            >
              <ShieldOff size={14} aria-hidden="true" />
              {copy.consentRevoke}
            </Button>
          ) : null}
        </div>
      </div>

      {failureView === null ? null : (
        <SettingsNotice variant="destructive" title={failureView.title}>
          <span className="flex flex-wrap items-center gap-1.5">
            {failureView.code === '' ? null : <SettingsBadge>{failureView.code}</SettingsBadge>}
            {failureView.message === '' ? null : (
              <span className="min-w-0">{failureView.message}</span>
            )}
          </span>
        </SettingsNotice>
      )}

      <SettingsGroup title={copy.overviewTitle}>
        <SettingsCard>
          <SettingsRow
            stack
            title={copy.descriptionLabel}
            description={entry.description === '' ? copy.noDescription : entry.description}
          />
          {version === '' ? null : (
            <SettingsRow title={copy.versionLabel} control={<Value>{version}</Value>} />
          )}
          <SettingsRow title={copy.sourceLabel} control={<Value>{source}</Value>} />
          {installedSource === null ? null : (
            <SettingsRow
              title={copy.sourceMarketLabel}
              control={<Value>{formatMarketplaceSource(installedSource)}</Value>}
            />
          )}
          {revision === '' ? null : (
            <SettingsRow
              title={copy.revisionLabel}
              control={
                <code className="font-mono text-xs leading-[18px] text-muted-foreground">
                  {revision}
                </code>
              }
            />
          )}
          {installedAt === '' ? null : (
            <SettingsRow title={copy.installTimeLabel} control={<Value>{installedAt}</Value>} />
          )}
          {updatedAt === '' ? null : (
            <SettingsRow title={copy.updatedTimeLabel} control={<Value>{updatedAt}</Value>} />
          )}
        </SettingsCard>
      </SettingsGroup>

      {sources.length > 1 ? (
        <SettingsGroup title={copy.sourcesTitle}>
          <SettingsCard>
            {sources.map((option) => (
              <SettingsRow
                key={option.marketplace}
                title={formatMarketplaceSource(option)}
                description={option.sourceLabel === '' ? undefined : option.sourceLabel}
                control={
                  option.installed ? (
                    <AnimatedBadge status="success" size="sm" showIcon={false} animated={false}>
                      {copy.sourceInstalledBadge}
                    </AnimatedBadge>
                  ) : undefined
                }
              />
            ))}
          </SettingsCard>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title={copy.capabilitiesTitle}>
        <SettingsCard>
          {capabilities.length === 0 ? (
            <SettingsEmpty>{copy.capabilitiesNone}</SettingsEmpty>
          ) : (
            <ul className="flex list-disc flex-col gap-1.5 px-5 py-[15px] pl-9">
              {capabilities.map((capability) => (
                <li key={capability} className="text-[13px] leading-[19px] text-muted-foreground">
                  {capability}
                </li>
              ))}
            </ul>
          )}
        </SettingsCard>
      </SettingsGroup>

      <PluginProcessSection row={row} copy={copy} language={language} workspaceId={workspaceId} />

      {surfaces.panels.length === 0 ? null : (
        <SettingsGroup title={surfaceCopy.panelsTitle}>
          <SettingsCard>
            {surfaces.panels.map((page) => (
              <SettingsRow
                key={page.key}
                title={page.title}
                control={
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || panelBusyKey !== null}
                    onClick={() => void openPanel(page)}
                  >
                    <PluginPageIcon token={page.icon} className="size-3.5" />
                    {panelBusyKey === page.key ? copy.writeBusy : surfaceCopy.openPanel}
                  </Button>
                }
              />
            ))}
            {panelError === null ? null : (
              <p role="alert" className="px-5 py-[15px] text-xs leading-[18px] text-destructive">
                {surfaceCopy.panelFailed} {panelError.code}: {panelError.message}
              </p>
            )}
          </SettingsCard>
        </SettingsGroup>
      )}

      <SettingsGroup title={surfaceCopy.settingsPagesTitle}>
        <SettingsCard>
          {surfaces.settings.length === 0 ? (
            <SettingsEmpty>{surfaceCopy.settingsPagesNone}</SettingsEmpty>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5 border-border border-b px-5 py-3">
                {surfaces.settings.map((page) => (
                  <Button
                    key={page.key}
                    size="sm"
                    variant={selectedSettingsPage?.key === page.key ? 'secondary' : 'ghost'}
                    onClick={() => setSelectedSettingsKey(page.key)}
                    className="font-normal"
                  >
                    <PluginPageIcon token={page.icon} className="size-3.5" />
                    {page.title}
                  </Button>
                ))}
              </div>
              {selectedSettingsPage === null ? (
                <SettingsEmpty>{surfaceCopy.settingsPagesNone}</SettingsEmpty>
              ) : (
                <div className="h-[min(60vh,560px)] min-h-[360px] p-3">
                  <PluginPageFrame
                    page={selectedSettingsPage}
                    active
                    className="overflow-hidden rounded-lg border border-border"
                  />
                </div>
              )}
            </>
          )}
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title={copy.settingsTitle}>
        <SettingsCard>
          <div className="px-5 py-[15px]">
            <PluginSettingsForm
              row={row}
              config={config}
              loading={configStatus === 'loading'}
              copy={copy}
              settingLabels={pluginSettingLabels(row, language)}
              onSet={(key, value) => actions.setSetting(row, key, value)}
              onReset={(key) => actions.resetSetting(row, key)}
            />
            {configError === null ? null : (
              <p
                role="alert"
                className="mt-2 flex flex-wrap items-center gap-1.5 text-xs leading-[18px] text-destructive"
              >
                {copy.writeFailed}
                <SettingsBadge>{configError.code}</SettingsBadge>
                <span className="min-w-0 text-muted-foreground">{configError.message}</span>
              </p>
            )}
          </div>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title={copy.diagnosticsTitle}>
        <SettingsCard>
          {engineInfo === null ? (
            <p className="px-5 py-[15px] text-[13px] leading-[19px] text-muted-foreground">
              {copy.engineInfoUnavailable}
            </p>
          ) : null}
          {diagnostics.map((line) => (
            <SettingsRow
              key={line.label}
              title={line.label}
              control={
                <code className="font-mono text-xs leading-[18px] text-muted-foreground">
                  {line.value}
                </code>
              }
            />
          ))}
          {desktopNote === '' ? null : (
            <p className="px-5 py-[15px] text-[13px] leading-[19px] text-muted-foreground">
              {desktopNote}
            </p>
          )}
          {engineInfo !== null && desktopNote === '' && diagnostics.length === 0 ? (
            <SettingsEmpty>{copy.diagnosticsNone}</SettingsEmpty>
          ) : null}
        </SettingsCard>
      </SettingsGroup>

      {/* Last on the page, and closed until asked for (2026-10-27): the permission table is
          reference material and the longest block here, while the decisions are above it. */}
      <PluginPermissionsGroup row={row} copy={copy} />
    </>
  )
}

/**
 * The permissions block: last on the page and closed until asked for.
 *
 * The table is reference material - what each permission lets the plugin do and where the scope is
 * written - and it is the longest block on the detail page; the decisions (enable, update, the
 * settings form) are above it. The count on the disclosure is the row's own list, so a plugin that
 * declares nothing still says so without being opened.
 */
function PluginPermissionsGroup({ row, copy }: { row: PluginRow; copy: PluginsCopy }) {
  const [open, setOpen] = useState(false)
  const count = row.desktop?.permissions.length ?? 0
  return (
    <SettingsGroup title={copy.permissionsTitle} description={copy.permissionIntro}>
      <SettingsCard>
        <div className="px-5 py-[15px]">
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
            />
            {open ? copy.permissionsHide : copy.permissionsShow(count)}
          </Button>
        </div>
        {open ? (
          <div className="px-5 pb-[15px]">
            <PluginPermissionList
              permissions={row.desktop?.permissions ?? []}
              netDomains={row.desktop?.netDomains ?? []}
              netAnyHost={row.desktop?.netAnyHost ?? false}
              copy={copy}
            />
          </div>
        ) : null}
      </SettingsCard>
    </SettingsGroup>
  )
}

/** A short reported value, drawn beside the label it belongs to. */
function Value({ children }: { children: string }) {
  return <span className="text-[13px] leading-[19px] text-muted-foreground">{children}</span>
}

import { useCallback, useEffect, useMemo, useState } from 'react'

import { toApiError, type ApiError } from '@/api/client'
import type { PluginTemplate } from '@/api/plugins'
import type { PluginGrantRow, PluginRow } from '@/api/plugins-types'
import { useCopy, useLanguage } from '@/lib/i18n'
import { readPluginSettings, pluginSettingsResource } from '@/state/plugins-store'
import {
  checkUpdates,
  clearUpdates,
  engineInfoResource,
  grantsResource,
  isGranted,
  pluginKey,
  pluginTaskStore,
  pluginsResource,
  readGrants,
  readPlugins,
  reloadPluginState,
  resetPluginSetting,
  scaffoldPluginTemplate,
  stopPluginTask,
  updatesStore,
  writeGrant,
  writePluginEnabled,
  writePluginInstallPackage,
  writePluginInstallSource,
  writePluginInstallUrl,
  writePluginSetting,
  writePluginSwitch,
  writePluginUninstall,
  writePluginUpgrade,
} from '@/state/plugins-store'
import { useResourceState } from '@/state/resource'
import { useStore, useStoreSelector } from '@/state/store'
import { workspaceStore } from '@/state/workspace-store'
import { SettingsBadge, SettingsLoadState, SettingsNotice } from '@/settings/parts'
import { COPY } from '@/settings/sections/plugins/copy'
import {
  buildEntries,
  pendingUpdates,
  type PluginActions,
  type PluginEntry,
  type PluginNotice,
  type PluginScope,
  type PluginSettingValue,
} from '@/settings/sections/plugins/contract'
import {
  PluginConsentCard,
  PluginSwitchCard,
  PluginUninstallCard,
} from '@/settings/sections/plugins/PluginCards'
import { PluginDetailView } from '@/settings/sections/plugins/PluginDetailView'
import { PluginListView } from '@/settings/sections/plugins/PluginListView'
import { PluginStoreView } from '@/settings/sections/plugins/PluginStoreView'
import { pluginDisplayName } from '@/state/plugin-text'
import { pluginFailureView, pluginTargetId, pluginUpdateConfirmation } from '@/settings/sections/plugins/rows'

/**
 * The plugins page: the installations this workspace sees, one plugin in full, and the store the
 * marketplaces publish into.
 *
 * Nothing here decides a plugin's state. The engine owns the install, the enable flag and the
 * settings, the host reports all of them, and this application records only its own consent grant —
 * so every write ends with the host's refreshed answer in place of what was on screen, and a refusal
 * leaves the previous data standing with the failure filed against the installation that asked.
 *
 * Three writes are confirmed. The first enable of a plugin that brings code waits for the reader's
 * confirmation — the grant first, then the switch — the update that changes marketplace is a
 * destructive uninstall-then-install and asks twice, and the uninstall removes files and data for
 * good. Switching a plugin off is immediate: it keeps everything and only stops the plugin, so a
 * confirmation on it would be ceremony rather than a decision. Withdrawing a confirmation runs the
 * same decision in reverse and needs no card either.
 *
 * A row's `id` is the plugin and its `installId` is the engine's handle for the installation. Every
 * engine write reads the handle through `pluginTargetId`; keys, grants and the update's own identity
 * stay on the plugin id. Mixing the two is the one mistake this page must not make.
 *
 * The list belongs to a workspace, so a switch of workspace reads again; the marketplaces and the
 * engine's own report are process-wide, so they are read once.
 */

/** The active workspace: the installation list and every consent grant belong to it. */
const selectActiveWorkspaceId = (state: { activeId: number | null }): number | null => state.activeId

/** Stable empties, so a resource with nothing in it does not rebuild the page every render. */
const NO_ROWS: readonly PluginRow[] = []
const NO_GRANTS: readonly PluginGrantRow[] = []

/** One installation's own write, as the page's busy key spells it. */
function pluginWriteKey(entry: Pick<PluginEntry, 'key'>): string {
  return `plugin:${entry.key}`
}

export default function PluginsSection() {
  const copy = useCopy(COPY)
  const { language } = useLanguage()
  const workspaceId = useStoreSelector(workspaceStore, selectActiveWorkspaceId)

  const pluginsState = useResourceState(pluginsResource)
  const grantsState = useResourceState(grantsResource)
  const updatesState = useStore(updatesStore)
  const tasks = useStore(pluginTaskStore)
  const configState = useResourceState(pluginSettingsResource)
  const engineInfoState = useResourceState(engineInfoResource)

  const [busyKey, setBusyKey] = useState('')
  const [failures, setFailures] = useState<Readonly<Record<string, ApiError>>>({})
  const [notice, setNotice] = useState<PluginNotice | null>(null)
  /** The installation whose first enable is waiting for a confirmation, keyed by `pluginKey`. */
  const [consentKey, setConsentKey] = useState('')
  /** The installation whose uninstall is waiting for a confirmation, keyed the same way. */
  const [uninstallKey, setUninstallKey] = useState('')
  /** The installation whose source switch is waiting for its two confirmations, keyed the same way. */
  const [switchKey, setSwitchKey] = useState('')
  /** The installation whose detail view is open; null while the list is. */
  const [selected, setSelected] = useState<{ id: string; scope: string } | null>(null)
  const [storeOpen, setStoreOpen] = useState(false)

  // The list and the grants both belong to the workspace, and the engine's report does not.
  useEffect(() => {
    // A keyed resource keeps the last key's answer while the next read runs, and the page's own
    // cards name one installation. Neither may survive the switch: the rows would be the previous
    // workspace's (every button would speak about an installation that is not there), and an open
    // consent or uninstall card would act on an installation of the workspace just left. Clearing
    // the resources first is what makes the new read the first answer again.
    pluginsResource.reset()
    grantsResource.reset()
    setSelected(null)
    setConsentKey('')
    setUninstallKey('')
    setSwitchKey('')
    setFailures({})
    setNotice(null)
    void readPlugins(workspaceId)
    void readGrants(workspaceId)
    void engineInfoResource.read()
  }, [workspaceId])

  // One plugin's settings are read when its detail view opens, and belong to the same workspace.
  useEffect(() => {
    if (selected === null) return
    void readPluginSettings(workspaceId, selected.id)
  }, [selected, workspaceId])

  const rows = pluginsState.value?.plugins ?? NO_ROWS
  const grants = grantsState.value ?? NO_GRANTS
  const updates = useMemo(
    () => pendingUpdates(updatesState.updates, rows),
    [rows, updatesState.updates],
  )
  const entries = useMemo(
    () => buildEntries(rows, grants, updates, language),
    [grants, language, rows, updates],
  )
  /**
   * The updates the engine's own upgrade can carry out.
   *
   * A source switch cannot be part of "update all": it uninstalls first and asks for its own
   * confirmation, so counting it under that button would promise a write it will not run.
   */
  const inPlaceUpdates = useMemo(
    () => updates.filter((update) => pluginUpdateConfirmation(update) === 'in-place'),
    [updates],
  )

  /** One of the page's own result lines: a plain sentence, no notice shell around it. */
  const report = useCallback((text: string) => {
    setNotice({ title: '', text, code: '', variant: 'success' })
  }, [])

  /** A host refusal, worded the way this page states it: a missing tool and a reserved source each
   *  get the page's own sentence rather than the host's own unlocalized one. */
  const reportRefusal = useCallback(
    (error: ApiError) => {
      const view = pluginFailureView(error, copy)
      setNotice({ title: view.title, text: view.message, code: view.code, variant: 'destructive' })
    },
    [copy],
  )

  /** One write, with the lock, the failure filing and the answer's own list all in one place. */
  const runWrite = useCallback(
    async (key: string, write: () => Promise<ApiError | null>): Promise<boolean> => {
      if (busyKey !== '') return false
      setBusyKey(key)
      setFailures((current) => {
        if (current[key] === undefined) return current
        const next = { ...current }
        delete next[key]
        return next
      })
      const error = await write()
      if (error !== null) setFailures((current) => ({ ...current, [key]: error }))
      setBusyKey('')
      return error === null
    },
    [busyKey],
  )

  /**
   * A row the host reported without an engine handle, so no write can name its installation.
   *
   * `installId` is mandatory on a marketplace row; a row without one is a contract violation, and
   * substituting its plugin id here would send the engine a name that may belong to something else.
   * The page says what happened instead of writing.
   */
  const reportUnaddressable = useCallback(() => {
    setNotice({
      title: copy.writeFailed,
      text: copy.noInstallHandleHint,
      code: '',
      variant: 'destructive',
    })
  }, [copy])

  const refresh = useCallback(() => {
    void readPlugins(workspaceId, true)
    void readGrants(workspaceId, true)
  }, [workspaceId])

  /**
   * The switch, which is the page's decision: a plugin whose manifest says it brings code is not
   * enabled before the reader confirms what it brings. Switching one off is immediate.
   *
   * The write names the engine's installation handle, not the row's plugin id.
   */
  const toggle = useCallback(
    (row: PluginRow) => {
      const targetId = pluginTargetId(row)
      if (targetId === null) {
        reportUnaddressable()
        return
      }
      const granted = isGranted(grants, row.id, row.scope)
      if (!row.enabled && row.consent.required && !granted) {
        setConsentKey(pluginKey(row))
        return
      }
      void runWrite(`plugin:${pluginKey(row)}`, () =>
        writePluginEnabled(workspaceId, targetId, !row.enabled, row.scope),
      )
    },
    [grants, reportUnaddressable, runWrite, workspaceId],
  )

  /** The grant first, for this installation's own scope: an id in both scopes is two decisions. */
  const confirmConsent = useCallback(async () => {
    const entry = entries.find((candidate) => candidate.key === consentKey)
    if (entry === undefined || busyKey !== '') return
    const targetId = pluginTargetId(entry.row)
    if (targetId === null) {
      setConsentKey('')
      reportUnaddressable()
      return
    }
    const key = pluginWriteKey(entry)
    setBusyKey(key)
    const grantError = await writeGrant(workspaceId, entry.row.id, true, entry.row.scope)
    if (grantError !== null) {
      setFailures((current) => ({ ...current, [key]: grantError }))
      setBusyKey('')
      return
    }
    const enableError = await writePluginEnabled(workspaceId, targetId, true, entry.row.scope)
    if (enableError !== null) {
      setFailures((current) => ({ ...current, [key]: enableError }))
    } else {
      setConsentKey('')
    }
    setBusyKey('')
  }, [busyKey, consentKey, entries, reportUnaddressable, workspaceId])

  const confirmUninstall = useCallback(async () => {
    const entry = entries.find((candidate) => candidate.key === uninstallKey)
    if (entry === undefined) return
    const targetId = pluginTargetId(entry.row)
    if (targetId === null) {
      setUninstallKey('')
      reportUnaddressable()
      return
    }
    const key = pluginWriteKey(entry)
    const accepted = await runWrite(key, () =>
      writePluginUninstall(workspaceId, targetId, entry.row.scope),
    )
    if (!accepted) return
    setUninstallKey('')
    report(copy.uninstalled(entry.name))
  }, [copy, entries, report, reportUnaddressable, runWrite, uninstallKey, workspaceId])

  /** Forgets one installation's confirmation, which also stops it: disable, then forget the grant. */
  const revoke = useCallback(
    (row: PluginRow) => {
      const targetId = pluginTargetId(row)
      if (targetId === null) {
        reportUnaddressable()
        return
      }
      const key = `plugin:${pluginKey(row)}`
      void runWrite(key, async () => {
        const grantError = await writeGrant(workspaceId, row.id, false, row.scope)
        if (grantError !== null) return grantError
        return writePluginEnabled(workspaceId, targetId, false, row.scope)
      })
    },
    [reportUnaddressable, runWrite, workspaceId],
  )

  /**
   * One installation's update, by the route its own kind takes.
   *
   * The engine's upgrade only reinstalls within one marketplace, so an in-place update runs as
   * before; a change of source is the destructive two-step write and opens the card that states it
   * first, before anything is uninstalled.
   */
  const upgrade = useCallback(
    (row: PluginRow) => {
      const entry =
        entries.find(
          (candidate) => candidate.row.id === row.id && candidate.row.scope === row.scope,
        ) ?? null
      if (entry?.update != null && pluginUpdateConfirmation(entry.update) === 'switch-card') {
        setSwitchKey(entry.key)
        return
      }
      const targetId = pluginTargetId(row)
      if (targetId === null) {
        reportUnaddressable()
        return
      }
      const name = pluginDisplayName(row, language)
      void runWrite(`plugin:${pluginKey(row)}`, () =>
        writePluginUpgrade(workspaceId, targetId, row.scope),
      ).then((accepted) => {
        if (accepted) report(copy.upgraded(name))
      })
    },
    [copy, entries, language, report, reportUnaddressable, runWrite, workspaceId],
  )

  /**
   * The source switch, after the card's two confirmations.
   *
   * Addressed by the plugin id: the host resolves the current installation itself, because the two
   * steps it runs have different addresses. The answer says whether a failed install was rolled
   * back, and the page states exactly that — nothing changed, or the plugin now comes from the new
   * marketplace.
   */
  const switchSource = useCallback(async () => {
    const entry = entries.find((candidate) => candidate.key === switchKey)
    if (entry === undefined || busyKey !== '') return
    const update = entry.update
    if (update === null || update.marketplace === null) return
    const key = pluginWriteKey(entry)
    setBusyKey(key)
    setFailures((current) => {
      if (current[key] === undefined) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    const { switched, error } = await writePluginSwitch(
      workspaceId,
      entry.row.id,
      entry.row.scope,
      update.marketplace,
    )
    setBusyKey('')
    setSwitchKey('')
    if (error !== null) {
      setFailures((current) => ({ ...current, [key]: error }))
      return
    }
    if (switched === null) return
    if (switched.rolledBack) {
      // The host put the previous installation back; the page says so rather than reporting an
      // upgrade that did not happen.
      setNotice({
        title: copy.switchRolledBackTitle,
        text: copy.switchRolledBack(switched.marketplace),
        code: '',
        variant: 'warning',
      })
      return
    }
    report(copy.switchedSource(entry.name, switched.marketplace, switched.to))
  }, [busyKey, copy, entries, report, switchKey, workspaceId])

  const upgradeAll = useCallback(() => {
    void runWrite('upgrade-all', () => writePluginUpgrade(workspaceId, null, null)).then(
      (accepted) => {
        if (!accepted) return
        // The check's own answer named these upgrades; they are applied, so it is spent.
        clearUpdates()
        report(copy.upgradedAll)
      },
    )
  }, [copy, report, runWrite, workspaceId])

  const runCheckUpdates = useCallback(async () => {
    await checkUpdates(workspaceId)
    const answer = updatesStore.get()
    if (answer.status === 'error') {
      if (answer.error !== null) reportRefusal(answer.error)
      return
    }
    const pending = pendingUpdates(
      answer.updates,
      pluginsResource.store.get().value?.plugins ?? NO_ROWS,
    )
    report(pending.length === 0 ? copy.updatesNone : copy.updatesFound(pending.length))
  }, [copy, report, reportRefusal, workspaceId])

  const reload = useCallback(async () => {
    const { result, error } = await reloadPluginState(workspaceId)
    if (result === null) {
      if (error !== null) reportRefusal(error)
      return
    }
    if (result.reloaded) {
      report(copy.reloadDone(result.sessions))
      return
    }
    // The host reloaded what it could and named the sessions it could not; the page states it.
    setNotice({
      title: copy.reloadAction,
      text: copy.reloadFailed(result.failed),
      code: '',
      variant: 'warning',
    })
  }, [copy, report, reportRefusal, workspaceId])

  /**
   * One install, whichever route asked for it.
   *
   * All three routes end in the same list write and the same report, so they share the lock, the
   * cleared refusal and the "which row appeared" comparison. A route that has no new row to name
   * (an upgrade, or a refusal) falls back to the source text the reader handed in.
   */
  const runInstall = useCallback(
    async (
      key: string,
      write: () => Promise<ApiError | null>,
      fallbackName: string,
    ): Promise<ApiError | null> => {
      if (busyKey !== '') return null
      const before = new Set(
        (pluginsResource.store.get().value?.plugins ?? NO_ROWS).map((row) => pluginKey(row)),
      )
      setBusyKey(key)
      setFailures((current) => {
        if (current.install === undefined) return current
        const next = { ...current }
        delete next.install
        return next
      })
      const error = await write()
      setBusyKey('')
      if (error !== null) {
        // An install has no row of its own yet, so its refusal is the page's to state.
        reportRefusal(error)
        return error
      }
      const added = (pluginsResource.store.get().value?.plugins ?? NO_ROWS).find(
        (row) => !before.has(pluginKey(row)),
      )
      report(copy.installed(added === undefined ? fallbackName : pluginDisplayName(added, language)))
      return null
    },
    [busyKey, copy, language, report, reportRefusal],
  )

  const installSource = useCallback(
    (source: string, scope: PluginScope) =>
      runInstall('install', () => writePluginInstallSource(workspaceId, source, scope), source),
    [runInstall, workspaceId],
  )

  const installPackage = useCallback(
    (path: string, scope: PluginScope) =>
      runInstall('install-file', () => writePluginInstallPackage(workspaceId, path, scope), path),
    [runInstall, workspaceId],
  )

  const installUrl = useCallback(
    (url: string, sha256: string, scope: PluginScope) =>
      runInstall(
        'install-url',
        () => writePluginInstallUrl(workspaceId, url, sha256, scope),
        url,
      ),
    [runInstall, workspaceId],
  )

  /**
   * One authoring template, written where the reader pointed.
   *
   * Nothing is installed and no list changes, so this is not an install: it takes the page's lock
   * only while it runs, and reports the directory the reader opens next.
   */
  const scaffoldTemplate = useCallback(
    async (
      template: PluginTemplate,
      targetDir: string,
    ): Promise<{ path: string | null; error: ApiError | null }> => {
      if (busyKey !== '') return { path: null, error: null }
      setBusyKey('scaffold')
      const answer = await scaffoldPluginTemplate(template, targetDir)
      setBusyKey('')
      if (answer.error !== null) reportRefusal(answer.error)
      return answer
    },
    [busyKey, reportRefusal],
  )

  const setSetting = useCallback(
    (row: PluginRow, key: string, value: PluginSettingValue) =>
      writePluginSetting(workspaceId, row.id, key, value),
    [workspaceId],
  )

  const resetSetting = useCallback(
    (row: PluginRow, key: string | null) => resetPluginSetting(workspaceId, row.id, key),
    [workspaceId],
  )

  const actions = useMemo<PluginActions>(
    () => ({
      busyKey,
      failures,
      toggle,
      requestUninstall: (row) => setUninstallKey(pluginKey(row)),
      upgrade,
      upgradeAll,
      revoke,
      refresh,
      checkUpdates: () => void runCheckUpdates(),
      reload: () => void reload(),
      installSource,
      installPackage,
      installUrl,
      scaffoldTemplate,
      setSetting,
      resetSetting,
    }),
    [
      busyKey,
      failures,
      installPackage,
      installSource,
      installUrl,
      scaffoldTemplate,
      refresh,
      reload,
      resetSetting,
      revoke,
      runCheckUpdates,
      setSetting,
      toggle,
      upgrade,
      upgradeAll,
    ],
  )

  const consentEntry = entries.find((entry) => entry.key === consentKey) ?? null
  const uninstallEntry = entries.find((entry) => entry.key === uninstallKey) ?? null
  const switchEntry =
    entries.find(
      (entry) =>
        entry.key === switchKey &&
        entry.update !== null &&
        pluginUpdateConfirmation(entry.update) === 'switch-card',
    ) ?? null
  const selectedEntry =
    selected === null
      ? null
      : (entries.find(
          (entry) => entry.row.id === selected.id && entry.row.scope === selected.scope,
        ) ?? null)
  // A keyed resource keeps the previous key's answer on screen while the next read is in flight.
  // Showing it under another installation would let the form submit one plugin's keys against a
  // different plugin (the host refuses them, but the page would be lying until it did).
  const selectedConfig =
    selectedEntry !== null && configState.value?.id === selectedEntry.row.id
      ? configState.value
      : null
  const selectedConfigStatus =
    selectedConfig !== null || configState.status === 'error' ? configState.status : 'loading'

  /** The read state reads as ready over a list already on screen, so a refresh does not blink. */
  const loadStatus =
    pluginsState.value !== null && pluginsState.status === 'loading' ? 'ready' : pluginsState.status

  return (
    <>
      {pluginsState.value === null || pluginsState.error !== null ? (
        <SettingsLoadState
          status={loadStatus}
          error={pluginsState.error}
          loadingLabel={copy.loading}
          failedLabel={copy.loadFailed}
          retryLabel={copy.retry}
          onRetry={refresh}
        />
      ) : null}

      {notice === null ? null : notice.variant === 'success' ? (
        <p className="text-[13px] leading-[19px] text-muted-foreground" role="status">
          {notice.text}
        </p>
      ) : (
        <SettingsNotice variant={notice.variant} title={notice.title}>
          <span className="flex flex-wrap items-center gap-1.5">
            {notice.code === '' ? null : <SettingsBadge>{notice.code}</SettingsBadge>}
            {notice.text === '' ? null : <span className="min-w-0">{notice.text}</span>}
          </span>
        </SettingsNotice>
      )}

      {consentEntry === null ? null : (
        <PluginConsentCard
          entry={consentEntry}
          copy={copy}
          busy={busyKey !== ''}
          onConfirm={() => void confirmConsent()}
          onCancel={() => setConsentKey('')}
        />
      )}

      {uninstallEntry === null ? null : (
        <PluginUninstallCard
          entry={uninstallEntry}
          copy={copy}
          busy={busyKey !== ''}
          onConfirm={() => void confirmUninstall()}
          onCancel={() => setUninstallKey('')}
        />
      )}

      {switchEntry === null ? null : (
        <PluginSwitchCard
          entry={switchEntry}
          copy={copy}
          busy={busyKey !== ''}
          onConfirm={() => void switchSource()}
          onCancel={() => setSwitchKey('')}
        />
      )}

      {pluginsState.value === null ? null : storeOpen ? (
        <PluginStoreView copy={copy} entries={entries} actions={actions} onBack={() => setStoreOpen(false)} />
      ) : selectedEntry === null ? (
        <PluginListView
          copy={copy}
          actions={actions}
          entries={entries}
          updateCount={inPlaceUpdates.length}
          checking={updatesState.status === 'checking'}
          tasks={tasks}
          onStopTask={(taskId) =>
            void stopPluginTask(taskId).catch((error: unknown) =>
              reportRefusal(toApiError(error)),
            )
          }
          onOpenStore={() => setStoreOpen(true)}
          onOpenDetail={(entry) => setSelected({ id: entry.row.id, scope: entry.row.scope })}
        />
      ) : (
        <PluginDetailView
          entry={selectedEntry}
          copy={copy}
          language={language}
          actions={actions}
          config={selectedConfig}
          configStatus={selectedConfigStatus}
          configError={selectedConfigStatus === 'error' ? configState.error : null}
          engineInfo={engineInfoState.value}
          uninstallOpen={
            uninstallEntry !== null && selectedEntry.key === uninstallEntry.key
          }
          workspaceId={workspaceId}
          onBack={() => setSelected(null)}
        />
      )}
    </>
  )
}

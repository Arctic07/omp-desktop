import { Download } from 'lucide-react'

import type { UpdateStatus } from '@/api/update'
import { Button } from '@/components/motion/button'
import { useCopy, type Localized } from '@/lib/i18n'
import {
  SettingsBadge,
  SettingsCard,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
} from '@/settings/parts'
import { useStoreSelector } from '@/state/store'
import {
  checkForUpdates,
  installUpdate,
  relaunchForUpdate,
  updateStore,
} from '@/state/update-store'
import { clampedPercent, updateAction, type UpdateAction } from '@/state/update-view'

/**
 * The About page's update group: the phase, the announced version, and the one act it earns.
 *
 * The title bar's pill draws the same status (`home/UpdatePill.tsx`), so the two surfaces cannot
 * disagree about which version is being offered. A failure is a status here, not a rejected call:
 * the check's own words are the notice under the card.
 */

interface UpdateCopy {
  title: string
  description: string
  statusTitle: string
  versionTitle: string
  actionTitle: string
  phaseIdle: string
  phaseUnsupported: string
  phaseChecking: string
  phaseCurrent: string
  phaseAvailable: (version: string | null) => string
  phaseDownloading: (percent: number | null) => string
  phaseReady: string
  phaseError: string
  check: string
  retryCheck: string
  install: string
  retryInstall: string
  relaunch: string
  unavailable: string
  checkingAction: string
  downloadingAction: string
  notesTitle: string
  failedTitle: string
}

const COPY: Localized<UpdateCopy> = {
  en: {
    title: 'Updates',
    description: 'Ask this project’s release feed whether a newer build exists.',
    statusTitle: 'Status',
    versionTitle: 'Announced version',
    actionTitle: 'Update',
    phaseIdle: 'Not checked yet',
    phaseUnsupported: 'Development builds do not check for updates',
    phaseChecking: 'Checking…',
    phaseCurrent: 'This build is the newest release',
    phaseAvailable: (version) =>
      version === null ? 'A newer release is available' : `Version ${version} is available`,
    phaseDownloading: (percent) =>
      percent === null ? 'Downloading the installer' : `Downloading the installer ${percent}%`,
    phaseReady: 'Downloaded; restart to finish',
    phaseError: 'The update did not complete',
    check: 'Check for updates',
    retryCheck: 'Retry check',
    install: 'Download and install',
    retryInstall: 'Retry download',
    relaunch: 'Restart to update',
    unavailable: 'Unavailable',
    checkingAction: 'Checking…',
    downloadingAction: 'Downloading…',
    notesTitle: 'Release notes',
    failedTitle: 'Update failed',
  },
  zh: {
    title: '更新',
    description: '向本项目的发布源查询是否有更新的版本。',
    statusTitle: '状态',
    versionTitle: '可用版本',
    actionTitle: '更新',
    phaseIdle: '尚未检查',
    phaseUnsupported: '开发构建不检查更新',
    phaseChecking: '正在检查…',
    phaseCurrent: '当前已是最新版本',
    phaseAvailable: (version) =>
      version === null ? '有新版本可用' : `新版本 ${version} 可用`,
    phaseDownloading: (percent) =>
      percent === null ? '正在下载安装包' : `正在下载安装包 ${percent}%`,
    phaseReady: '已下载，重启后完成更新',
    phaseError: '更新未完成',
    check: '检查更新',
    retryCheck: '重试检查',
    install: '下载并安装',
    retryInstall: '重试下载',
    relaunch: '重启更新',
    unavailable: '不可用',
    checkingAction: '正在检查…',
    downloadingAction: '正在下载…',
    notesTitle: '更新说明',
    failedTitle: '更新失败',
  },
}

export function AboutUpdates() {
  const copy = useCopy(COPY)
  const update = useStoreSelector(updateStore, (state) => state.status)
  const failure = useStoreSelector(updateStore, (state) => state.failure)
  const action = updateAction(update)
  // The status's own error is a failed check or download; `failure` is a rejected command, which
  // leaves the last status untouched and needs its own sentence.
  const trouble =
    update?.phase === 'error' ? (update.error ?? copy.phaseError) : (failure?.message ?? null)

  return (
    <>
      <SettingsGroup title={copy.title} description={copy.description}>
        <SettingsCard>
          <SettingsRow
            icon={<Download className="size-4" aria-hidden="true" />}
            title={copy.statusTitle}
            control={
              <SettingsBadge
                tone={
                  update?.phase === 'available' || update?.phase === 'error' ? 'warning' : 'muted'
                }
              >
                {phaseLabel(update, copy)}
              </SettingsBadge>
            }
          />
          {update?.version === null || update?.version === undefined ? null : (
            <SettingsRow
              title={copy.versionTitle}
              control={<SettingsBadge>{update.version}</SettingsBadge>}
            />
          )}
          <SettingsRow
            title={copy.actionTitle}
            description={actionHint(update, action, copy)}
            control={
              <Button
                size="sm"
                variant="secondary"
                disabled={action === null}
                onClick={() => {
                  if (action === 'check') void checkForUpdates()
                  else if (action === 'install') void installUpdate()
                  else if (action === 'relaunch') void relaunchForUpdate()
                }}
              >
                {actionLabel(update, action, copy)}
              </Button>
            }
          />
        </SettingsCard>
        {update !== null &&
        update.notes !== null &&
        (update.phase === 'available' || update.phase === 'ready') ? (
          <SettingsNotice variant="info" title={copy.notesTitle}>
            <span className="whitespace-pre-line">{update.notes}</span>
          </SettingsNotice>
        ) : null}
        {trouble === null ? null : (
          <SettingsNotice variant="destructive" title={copy.failedTitle}>
            {trouble}
          </SettingsNotice>
        )}
      </SettingsGroup>
    </>
  )
}

/** The update's phase as one sentence, in this page's words. */
function phaseLabel(status: UpdateStatus | null, copy: UpdateCopy): string {
  if (status === null) return copy.phaseIdle
  switch (status.phase) {
    case 'idle':
      return copy.phaseIdle
    case 'unsupported':
      return copy.phaseUnsupported
    case 'checking':
      return copy.phaseChecking
    case 'current':
      return copy.phaseCurrent
    case 'available':
      return copy.phaseAvailable(status.version)
    case 'downloading':
      return copy.phaseDownloading(clampedPercent(status.progress))
    case 'ready':
      return copy.phaseReady
    case 'error':
      return copy.phaseError
    default:
      return assertNever(status.phase)
  }
}

/** The one control's label: the act, or the reason it cannot be pressed. */
function actionLabel(
  status: UpdateStatus | null,
  action: UpdateAction | null,
  copy: UpdateCopy,
): string {
  switch (action) {
    case 'check':
      return status?.phase === 'error' ? copy.retryCheck : copy.check
    case 'install':
      return status?.phase === 'error' ? copy.retryInstall : copy.install
    case 'relaunch':
      return copy.relaunch
    case null:
      if (status?.phase === 'checking') return copy.checkingAction
      if (status?.phase === 'downloading') return copy.downloadingAction
      if (status?.phase === 'unsupported') return copy.unavailable
      return copy.check
  }
}

/** The line under the control: what pressing it will do. */
function actionHint(
  status: UpdateStatus | null,
  action: UpdateAction | null,
  copy: UpdateCopy,
): string {
  if (action === 'install' && status?.phase === 'error') return copy.phaseError
  if (action === 'relaunch') return copy.phaseReady
  return ''
}

function assertNever(value: never): never {
  throw new Error(`unhandled update phase: ${String(value)}`)
}

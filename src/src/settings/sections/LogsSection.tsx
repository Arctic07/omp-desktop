import { useEffect, useRef, useState } from 'react'

import { toApiError } from '@/api/client'
import { logsOpenDirectory } from '@/api/diagnostics'
import type { LogFileSource } from '@/api/diagnostics'
import { Button } from '@/components/motion/button'
import { TextShimmer } from '@/components/motion/text-shimmer'
import { useCopy, type Localized } from '@/lib/i18n'
import {
  SettingsCard,
  SettingsEmpty,
  SettingsGroup,
  SettingsLoadState,
  SettingsPath,
  SettingsRow,
} from '@/settings/parts'
import { formatBytes } from '@/settings/sections/rules-format'
import { clearCaches, clearLogs, logsResource, readLogs } from '@/state/logs-store'
import { useResourceState } from '@/state/resource'

/**
 * The desktop app's logs page: where the two log directories live, the files themselves and the two
 * clears.
 *
 * Two producers write logs and neither directory can be merged into the other: this application and
 * the engine host write `app.log` and `host.log` into `<data root>/logs`, while the engine's own
 * structured logs are `omp.<day>.<pid>.log` files the SDK places under its pinned config root. They
 * are listed as one table - a report is read from both - and each row says which producer wrote it,
 * so the two locations stay visible without a second page.
 *
 * Both directories are bounded by the host (`services::log_retention`): files older than seven days
 * are removed, and the engine's directory keeps only its newest twenty. The page states that rather
 * than describing the rule.
 */

/** `logsCopy.ts`'s wording, the part this page shows, in both languages. */
interface LogsCopy {
  locationTitle: string
  locationDescription: string
  engineLocationTitle: string
  engineLocationDescription: string
  copyPath: string
  copyPathDone: string
  copyPathFailed: string
  openAction: string
  openFailed: string
  clearTitle: string
  clearDescription: string
  clearAction: string
  clearConfirm: string
  clearCancel: string
  clearDone: string
  clearPartial: string
  filesTitle: string
  filesDescription: string
  filesEmpty: string
  filesLoading: string
  sourceApp: string
  sourceEngine: string
  cacheTitle: string
  cacheDescription: string
  cacheSizeTitle: string
  cacheAction: string
  cacheDone: string
  cachePartial: string
  /** Appended to a clear's report when the engine reclaimed part of it in its own tree. */
  cacheDoneEngine: string
  loadFailed: string
  retry: string
}

const COPY: Localized<LogsCopy> = {
  en: {
    locationTitle: 'Log directory',
    locationDescription: 'The app log (app.log) and the engine host log (host.log) are written here.',
    engineLocationTitle: 'Engine log directory',
    engineLocationDescription:
      'The engine writes one file per host process (omp.<day>.<pid>.log) here. Files older than seven days are removed automatically, and only the newest twenty are kept.',
    copyPath: 'Copy path',
    copyPathDone: 'Copied',
    copyPathFailed: 'Copy failed',
    openAction: 'Open folder',
    openFailed: 'The file manager did not open this directory.',
    clearTitle: 'Clear logs',
    clearDescription:
      'Deletes every log file in both directories. A log still being written is emptied and this run keeps recording into it; a running host keeps its own file.',
    clearAction: 'Clear logs',
    clearConfirm: 'Confirm',
    clearCancel: 'Cancel',
    clearDone: 'Cleared {size} of logs.',
    clearPartial: 'Some logs are still in use; the remaining {size} could not be deleted.',
    filesTitle: 'Log files',
    filesDescription:
      'Listed by name; a file still being written keeps growing. Logs older than seven days are removed automatically.',
    filesEmpty: 'No log files yet.',
    filesLoading: 'Reading…',
    sourceApp: 'App',
    sourceEngine: 'Engine',
    cacheTitle: 'Cache',
    cacheDescription:
      'Clears the window’s webview caches (HTTP cache, code cache, GPU and shader caches), the conversation index the desktop keeps for its own reads, and the caches the engine keeps in its own directory (addons of engine versions that are no longer running). Sessions, settings, logins and credentials are untouched; the index is rebuilt on the next list, and the engine’s share is named in the result.',
    cacheSizeTitle: 'Clearable cache',
    cacheAction: 'Clear cache',
    cacheDone: 'Freed {size}.',
    cachePartial: 'Some files are in use; the remaining {size} could not be deleted - clear again to retry.',
    cacheDoneEngine: "{size} of it came from the engine's own caches.",
    loadFailed: 'The log directory could not be read.',
    retry: 'Retry',
  },
  zh: {
    locationTitle: '日志目录',
    locationDescription: '应用日志 app.log 与引擎宿主日志 host.log 都写在这里。',
    engineLocationTitle: '引擎日志目录',
    engineLocationDescription:
      '引擎为每个宿主进程写一个文件（omp.<日期>.<进程号>.log）。超过 7 天的文件会自动删除，最多保留最新 20 个。',
    copyPath: '复制路径',
    copyPathDone: '已复制',
    copyPathFailed: '复制失败',
    openAction: '打开目录',
    openFailed: '文件管理器没有打开这个目录。',
    clearTitle: '清除日志',
    clearDescription:
      '删除两个日志目录里的全部日志文件。正在写入的日志会被清空，本轮运行随后继续记录；正在运行的宿主进程保留自己的文件。',
    clearAction: '清除日志',
    clearConfirm: '确认清除',
    clearCancel: '取消',
    clearDone: '已清除 {size} 日志。',
    clearPartial: '部分日志仍在使用中，剩余 {size} 未能删除。',
    filesTitle: '日志文件',
    filesDescription: '按文件名排列；正在写入的文件会继续增长。超过 7 天的日志会自动删除。',
    filesEmpty: '还没有日志文件。',
    filesLoading: '正在读取…',
    sourceApp: '应用',
    sourceEngine: '引擎',
    cacheTitle: '缓存',
    cacheDescription: '清除窗口自身的网页视图缓存（HTTP 缓存、代码缓存、GPU 与 shader 缓存）、桌面为自身读取维护的对话索引，以及引擎在自建目录里留下的缓存（已不再运行的引擎版本的原生模块）。会话、设置、登录状态与凭据不受影响；索引在下次打开列表时重建，引擎那部分的空间会在结果里单独说明。',
    cacheSizeTitle: '可清理缓存',
    cacheAction: '清除缓存',
    cacheDone: '已释放 {size}。',
    cachePartial: '部分文件正在使用中，剩余 {size} 未能删除，可再次清除重试。',
    cacheDoneEngine: '其中 {size} 来自引擎自身的缓存。',
    loadFailed: '无法读取日志目录。',
    retry: '重试',
  },
}

/** What a value reads while the host has answered nothing about it. */
const NO_VALUE = '—'

/** How long the copy button states what it did before offering the copy again. */
const COPY_FEEDBACK_MS = 2000

/** A log file's own moment, as this page states it: the local `YYYY-MM-DD HH:MM`. */
function formatModifiedAt(modifiedMs: number): string {
  // A file whose time could not be read is listed with a dash rather than the epoch: 1970 is a date
  // the reader would believe, and "unknown" is what the answer actually says.
  if (modifiedMs === 0) return NO_VALUE
  const at = new Date(modifiedMs)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** The host's own sentence for a refusal, or this page's line when the refusal carried none. */
function failureText(error: unknown, fallback: string): string {
  const refusal = toApiError(error)
  return refusal.message === '' ? fallback : refusal.message
}

/** What a clear reports: how much went, and — when a running process held some back — what stayed. */
function clearedText(
  done: string,
  partial: string,
  freedBytes: number,
  remainingBytes: number,
  engineBytes: number,
  engineNote: string,
): string {
  const freed = done.replace('{size}', formatBytes(freedBytes))
  // The engine's share is named rather than folded in: the same sentence otherwise reads as though
  // this application freed all of it, and the part it cannot touch is the larger half.
  const report =
    engineBytes <= 0 ? freed : `${freed} ${engineNote.replace('{size}', formatBytes(engineBytes))}`
  if (remainingBytes <= 0) return report
  return `${report} ${partial.replace('{size}', formatBytes(remainingBytes))}`
}

export default function LogsSection() {
  const copy = useCopy(COPY)
  const { status, error, value: overview } = useResourceState(logsResource)
  /** The clear in flight, and which of the two it is: every control locks behind it. */
  const [busy, setBusy] = useState<'logs' | 'cache' | null>(null)
  /** What the last clear reported, in the page's words; stays until the next one replaces it. */
  const [outcome, setOutcome] = useState<string | null>(null)
  /** Which copy button just answered, and what it said - each row has its own path. */
  const [copyState, setCopyState] = useState<{
    target: LogFileSource
    result: 'done' | 'failed'
  } | null>(null)
  /** The log clear's two-step: the first press only swaps the button for the confirm pair. */
  const [confirming, setConfirming] = useState(false)
  /** A refusal from one of the three actions — opening the folder, or either clear. */
  const [actionFailure, setActionFailure] = useState<string | null>(null)
  const copyTimer = useRef<number | null>(null)

  // This run keeps writing to those files while the page is not on screen, so the answer from an
  // earlier visit is stale: every arrival reads the host again.
  useEffect(() => {
    void readLogs(true)
  }, [])

  // The copy button's own timer has no surface left to report to once the section is gone.
  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    }
  }, [])

  const directory = overview?.directory ?? ''
  const engineDirectory = overview?.engineDirectory ?? ''
  const cacheSizeText = overview === null ? NO_VALUE : formatBytes(overview.cacheBytes)
  const loading = status === 'idle' || status === 'loading'
  /** The copy says the list is ordered by name, so the page orders it rather than trusting the host. */
  const files = [...(overview?.files ?? [])].sort((left, right) => left.name.localeCompare(right.name))

  /** The path one row shows, and the label its copy button states. */
  function pathOf(target: LogFileSource): string {
    return target === 'engine' ? engineDirectory : directory
  }

  function copyLabel(target: LogFileSource): string {
    if (copyState === null || copyState.target !== target) return copy.copyPath
    return copyState.result === 'done' ? copy.copyPathDone : copy.copyPathFailed
  }

  /** The failure notice's retry: the directory is read again rather than adjusted. */
  function retry(): void {
    setActionFailure(null)
    void readLogs(true)
  }

  /** The button says what happened for two seconds, then goes back to offering the copy. */
  async function copyDirectory(target: LogFileSource): Promise<void> {
    const path = pathOf(target)
    if (path === '') return
    let copied = true
    try {
      await navigator.clipboard.writeText(path)
    } catch {
      // A webview without the clipboard permission is a copy that did not happen, not a failure of
      // the page: the button states it and offers the copy again.
      copied = false
    }
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    setCopyState({ target, result: copied ? 'done' : 'failed' })
    copyTimer.current = window.setTimeout(() => {
      copyTimer.current = null
      setCopyState(null)
    }, COPY_FEEDBACK_MS)
  }

  async function openDirectory(target: LogFileSource): Promise<void> {
    setActionFailure(null)
    try {
      const answer = await logsOpenDirectory(target)
      // `opened: false` is a whole answer rather than a rejection: the path may be gone, or this
      // machine's file manager may have refused it. The page has a sentence for that, and the host
      // has none.
      if (!answer.opened) setActionFailure(copy.openFailed)
    } catch (error) {
      setActionFailure(failureText(error, copy.loadFailed))
    }
  }

  /** The log clear: the first press asks, the second deletes. */
  async function clearLogFiles(): Promise<void> {
    if (busy !== null) return
    if (!confirming) {
      setConfirming(true)
      return
    }
    setBusy('logs')
    setActionFailure(null)
    const { outcome: cleared, error: refused } = await clearLogs()
    setBusy(null)
    setConfirming(false)
    if (cleared === null) {
      setActionFailure(refused === null ? copy.loadFailed : failureText(refused, copy.loadFailed))
      return
    }
    // A log clear never reaches the engine's own caches, so its sentence has no engine part.
    setOutcome(
      clearedText(copy.clearDone, copy.clearPartial, cleared.freedBytes, cleared.remainingBytes, 0, ''),
    )
  }

  /** The cache clear, which deliberately does not ask: what it drops still exists elsewhere. */
  async function clearWebviewCaches(): Promise<void> {
    if (busy !== null) return
    setBusy('cache')
    setActionFailure(null)
    const { outcome: freed, error: refused } = await clearCaches()
    setBusy(null)
    if (freed === null) {
      setActionFailure(refused === null ? copy.loadFailed : failureText(refused, copy.loadFailed))
      return
    }
    setOutcome(
      clearedText(
        copy.cacheDone,
        copy.cachePartial,
        freed.freedBytes,
        freed.remainingBytes,
        freed.engineFreedBytes,
        copy.cacheDoneEngine,
      ),
    )
  }

  return (
    <>
      {/* Only the failure is stated here: the file list below carries its own reading and empty
          states, and two lines saying the same thing is what the reference page avoids. */}
      {status === 'error' ? (
        <SettingsLoadState
          status={status}
          error={error}
          loadingLabel={copy.filesLoading}
          failedLabel={copy.loadFailed}
          retryLabel={copy.retry}
          onRetry={retry}
        />
      ) : null}

      <SettingsCard>
        <SettingsRow
          stack
          title={copy.locationTitle}
          description={copy.locationDescription}
          control={
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <SettingsPath>{directory === '' ? NO_VALUE : directory}</SettingsPath>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={directory === '' || busy !== null}
                onClick={() => void copyDirectory('app')}
              >
                {copyLabel('app')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void openDirectory('app')}
              >
                {copy.openAction}
              </Button>
            </div>
          }
        />
        <SettingsRow
          stack
          title={copy.engineLocationTitle}
          description={copy.engineLocationDescription}
          control={
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <SettingsPath>{engineDirectory === '' ? NO_VALUE : engineDirectory}</SettingsPath>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={engineDirectory === '' || busy !== null}
                onClick={() => void copyDirectory('engine')}
              >
                {copyLabel('engine')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void openDirectory('engine')}
              >
                {copy.openAction}
              </Button>
            </div>
          }
        />
        <SettingsRow
          title={copy.clearTitle}
          description={copy.clearDescription}
          control={
            confirming ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => setConfirming(false)}
                >
                  {copy.clearCancel}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void clearLogFiles()}
                >
                  {copy.clearConfirm}
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive"
                disabled={busy !== null}
                onClick={() => void clearLogFiles()}
              >
                {copy.clearAction}
              </Button>
            )
          }
        />
      </SettingsCard>

      {/* What one of the three actions answered: the file manager refusing the directory, or the
          host refusing a clear. */}
      {actionFailure === null ? null : (
        <p role="alert" className="text-[13px] leading-[19px] text-destructive">
          {actionFailure}
        </p>
      )}

      <SettingsGroup title={copy.filesTitle} description={copy.filesDescription}>
        {overview !== null && files.length > 0 ? (
          <SettingsCard>
            {files.map((file) => (
              <SettingsRow
                key={`${file.source}:${file.name}`}
                title={file.name}
                control={
                  <span className="flex items-center gap-2 text-xs leading-[18px] text-muted-foreground">
                    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px]">
                      {file.source === 'engine' ? copy.sourceEngine : copy.sourceApp}
                    </span>
                    <span>{`${formatBytes(file.bytes)} · ${formatModifiedAt(file.modifiedMs)}`}</span>
                  </span>
                }
              />
            ))}
          </SettingsCard>
        ) : (
          <SettingsCard>
            <SettingsEmpty>
              {overview === null && loading ? (
                <TextShimmer>{copy.filesLoading}</TextShimmer>
              ) : (
                copy.filesEmpty
              )}
            </SettingsEmpty>
          </SettingsCard>
        )}
      </SettingsGroup>

      <SettingsGroup title={copy.cacheTitle} description={copy.cacheDescription}>
        <SettingsCard>
          <SettingsRow
            title={copy.cacheSizeTitle}
            control={<span className="text-sm font-medium text-foreground">{cacheSizeText}</span>}
          />
          <SettingsRow
            title={copy.cacheAction}
            control={
              <Button
                variant="outline"
                size="sm"
                className="text-destructive"
                disabled={busy !== null}
                onClick={() => void clearWebviewCaches()}
              >
                {copy.cacheAction}
              </Button>
            }
          />
        </SettingsCard>
      </SettingsGroup>

      {outcome === null ? null : (
        <p aria-live="polite" className="text-[13px] leading-[19px] text-muted-foreground">
          {outcome}
        </p>
      )}
    </>
  )
}

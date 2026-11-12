import { useEffect, useState, type ReactNode } from 'react'
import { BookOpen, Code, ExternalLink, Globe, Info, Terminal } from 'lucide-react'

import { runtimeRestart } from '@/api/agent'
import { appVersion } from '@/api/app'
import { toApiError, type ApiError } from '@/api/client'
import type { RuntimeStatus } from '@/api/types'
import { Button } from '@/components/motion/button'
import { TextShimmer } from '@/components/motion/text-shimmer'
import { useCopy, type Localized } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  SettingsBadge,
  SettingsCard,
  SettingsGroup,
  SettingsNotice,
  SettingsPath,
  SettingsRow,
} from '@/settings/parts'
import { AboutUpdates } from '@/settings/sections/AboutUpdates'
import { useResourceState } from '@/state/resource'
import { readEngineStatus, runtimeResource } from '@/state/runtime-store'

/**
 * The About page: the build's own version, the project resources, and what the local engine host
 * reports about itself.
 *
 * The version is the running build's own (`getVersion`, which is what the shell reports rather than
 * a copy written here); the runtime rows are one read of the host's status and the paths under it,
 * worded exactly as the reference engine-status card words them. Nothing on this page is a figure
 * the app made up about itself.
 */

/** The desktop app's own copy, verbatim (`src/i18nCopyZh.ts`, `settingsPage.about`), in both languages. */
interface AboutCopy {
  title: string
  description: string
  versionTitle: string
  buildTitle: string
  buildValue: string
  linksTitle: string
  linksDescription: string
  resources: readonly { id: string; label: string; href: string }[]
  statusTitle: string
}

const COPY: Localized<AboutCopy> = {
  en: {
    title: 'About',
    description: 'A quick look at this local OMP desktop build.',
    versionTitle: 'Version',
    buildTitle: 'Build',
    buildValue: 'Desktop application',
    linksTitle: 'Resources',
    linksDescription: 'Open project resources in your default browser.',
    resources: [
      { id: 'website', label: 'Official website', href: 'https://omp.auiox.com/' },
      { id: 'repository', label: 'Project repository', href: 'https://github.com/Arctic07/omp-desktop' },
      { id: 'documentation', label: 'OMP documentation', href: 'https://omp.sh/docs' },
      { id: 'engine-source', label: 'Engine source code', href: 'https://github.com/can1357/oh-my-pi' },
    ],
    statusTitle: 'Runtime status',
  },
  zh: {
    title: '关于',
    description: '查看这个本地 OMP 桌面构建的信息。',
    versionTitle: '版本',
    buildTitle: '构建类型',
    buildValue: '桌面应用',
    linksTitle: '资源',
    linksDescription: '在默认浏览器中打开项目资源。',
    resources: [
      { id: 'website', label: '官网', href: 'https://omp.auiox.com/' },
      { id: 'repository', label: '项目仓库', href: 'https://github.com/Arctic07/omp-desktop' },
      { id: 'documentation', label: 'OMP 文档', href: 'https://omp.sh/docs' },
      { id: 'engine-source', label: '引擎源码', href: 'https://github.com/can1357/oh-my-pi' },
    ],
    statusTitle: '运行状态',
  },
}

/** `engineStatusCopy.ts`'s wording, the part this page shows, in both languages. */
interface EngineStatusCopy {
  engineDescription: string
  enginePathLabel: string
  engineVersionLabel: string
  engineTrustLabel: string
  engineTrustVerified: string
  engineTrustUnverified: string
  engineTrustMismatch: string
  engineTrustMismatchTitle: string
  engineTrustMismatchHint: string
  /** The artifact's own manifest records a protocol this build does not speak. */
  engineProtocolMismatch: string
  engineProtocolMismatchTitle: string
  engineProtocolMismatchHint: string
  protocolVersionLabel: string
  credentialBackendLabel: string
  credentialKeyringValue: string
  credentialUnavailableTitle: string
  credentialUnavailableValue: string
  credentialUnavailableHint: string
  dataRootLabel: string
  agentDirLabel: string
  configRootLabel: string
  /** The engine's own trouble, as one row whose value is built from the fragments below. */
  engineDiagnosticsLabel: string
  engineDiagnosticsDegraded: string
  engineDiagnosticsUnknownFrames: (count: number) => string
  engineDiagnosticsDroppedFrames: (count: number) => string
  engineDiagnosticsReplays: (count: number) => string
  /** Joins those fragments into one line, with this language's punctuation. */
  engineDiagnosticsSeparator: string
  /** The degraded host's own block: what it means, and the one action that brings it back. */
  engineDegradedTitle: string
  engineDegradedHint: string
  engineRestart: string
  engineRestarting: string
  engineRestartFailed: string
  loadFailed: string
  retry: string
  loading: string
  engineNotFound: string
  engineNotFoundHint: string
  engineVersionUnknown: string
  engineVersionUnknownHint: string
}

const ENGINE_COPY: Localized<EngineStatusCopy> = {
  en: {
    engineDescription: 'Read-only details reported by the local engine host.',
    enginePathLabel: 'Host path',
    engineVersionLabel: 'SDK version',
    engineTrustLabel: 'Host integrity',
    engineTrustVerified: 'Verified against the bundled manifest',
    engineTrustUnverified: 'Not verified (development override only)',
    engineTrustMismatch: 'Checksum mismatch',
    engineTrustMismatchTitle: 'Host integrity check failed',
    engineTrustMismatchHint:
      'The engine bundle on disk does not match the manifest this build shipped with, so the host is not started. Reinstall the latest release.',
    engineProtocolMismatch: 'Protocol version mismatch',
    engineProtocolMismatchTitle: 'Host built for another protocol',
    engineProtocolMismatchHint:
      'The engine bundle was built for a different protocol than this build speaks, so it is not started: such a host completes the handshake and then ignores every command added since it was built, which is how the engine pages end up empty with nothing stating why. Reinstall the latest release and restart the application.',
    protocolVersionLabel: 'Protocol version',
    credentialBackendLabel: 'Credential storage',
    credentialKeyringValue: 'OS keyring',
    credentialUnavailableTitle: 'Credential storage unavailable',
    credentialUnavailableValue: 'Unavailable',
    credentialUnavailableHint:
      'The operating system keyring is not reachable, so API keys cannot be saved. Configure providers from a terminal that points at this app data root.',
    dataRootLabel: 'Data root',
    agentDirLabel: 'Engine data directory',
    configRootLabel: 'Engine config root',
    engineDiagnosticsLabel: 'Engine diagnostics',
    engineDiagnosticsDegraded: 'host stopped after repeated crashes',
    engineDiagnosticsUnknownFrames: (count) => `inbound frames the host did not recognize: ${count}`,
    engineDiagnosticsDroppedFrames: (count) => `outbound frames the host could not encode: ${count}`,
    engineDiagnosticsReplays: (count) => `replays after a sequence gap: ${count}`,
    engineDiagnosticsSeparator: '; ',
    engineDegradedTitle: 'Engine stopped',
    engineDegradedHint:
      'The engine host kept failing to start, so nothing is serving your conversations until it is restarted. Restarting starts a fresh host and reopens the conversations it was serving; a turn that was running when it stopped comes back marked interrupted, because the engine cannot continue a turn in a new process.',
    engineRestart: 'Restart engine',
    engineRestarting: 'Restarting…',
    engineRestartFailed: 'Could not restart the engine.',
    loadFailed: 'Could not read the engine status.',
    retry: 'Retry',
    loading: 'Loading…',
    engineNotFound: 'No host found',
    engineNotFoundHint: 'Reinstall the application.',
    engineVersionUnknown: 'Host found, version unknown',
    engineVersionUnknownHint:
      'No SDK version is recorded for this host: the bundle manifest is missing, unreadable, or does not match its files, and no running host has reported one either. Reinstall the latest release.',
  },
  zh: {
    engineDescription: '来自本地引擎宿主的只读信息。',
    enginePathLabel: '宿主路径',
    engineVersionLabel: 'SDK 版本',
    engineTrustLabel: '宿主完整性',
    engineTrustVerified: '已校验（与随包清单一致）',
    engineTrustUnverified: '未校验（仅开发覆盖）',
    engineTrustMismatch: '摘要不匹配',
    engineTrustMismatchTitle: '宿主完整性校验失败',
    engineTrustMismatchHint:
      '磁盘上的引擎宿主包与该构建随包清单记录的摘要不一致，因此不会启动宿主。请重新安装最新版本。',
    engineProtocolMismatch: '协议版本不匹配',
    engineProtocolMismatchTitle: '宿主产物按另一个协议构建',
    engineProtocolMismatchHint:
      '引擎宿主包按与本版本不同的协议构建，因此不会启动：这样的宿主能完成握手，却会忽略自它构建之后新增的所有命令——引擎状态页面会一直空着，且没有任何说明。请重新安装最新版本并重启应用。',
    protocolVersionLabel: '协议版本',
    credentialBackendLabel: '凭据存储',
    credentialKeyringValue: '系统安全存储（OS keyring）',
    credentialUnavailableTitle: '凭据存储不可用',
    credentialUnavailableValue: '不可用',
    credentialUnavailableHint:
      '无法访问操作系统安全存储，API 密钥不会被保存。请在指向该数据根目录的终端中配置供应商。',
    dataRootLabel: '数据根目录',
    agentDirLabel: '引擎数据目录',
    configRootLabel: '引擎配置根',
    engineDiagnosticsLabel: '引擎诊断',
    engineDiagnosticsDegraded: '宿主反复崩溃后已停止',
    engineDiagnosticsUnknownFrames: (count) => `宿主未识别的入站帧：${count}`,
    engineDiagnosticsDroppedFrames: (count) => `宿主无法编码的出站帧：${count}`,
    engineDiagnosticsReplays: (count) => `序号缺口后的重放：${count}`,
    engineDiagnosticsSeparator: '；',
    engineDegradedTitle: '引擎已停止',
    engineDegradedHint:
      '引擎宿主连续启动失败，在重新启动之前没有任何进程为你的会话服务。重启会拉起一个新的宿主，并重新打开它此前承载的会话；停止时正在运行的那一轮会以「已中断」状态回来——引擎无法在新进程里继续一轮对话。',
    engineRestart: '重启引擎',
    engineRestarting: '正在重启…',
    engineRestartFailed: '无法重启引擎。',
    loadFailed: '无法读取引擎状态。',
    retry: '重试',
    loading: '正在读取…',
    engineNotFound: '未找到宿主',
    engineNotFoundHint: '请重新安装应用。',
    engineVersionUnknown: '已找到宿主，版本未知',
    engineVersionUnknownHint:
      '该宿主没有可查的 SDK 版本：宿主包清单缺失、无法读取，或与其文件不符，也没有正在运行的宿主报告过版本。请重新安装最新版本。',
  },
}

/** The desktop's code for a host artifact that does not hash to the digest this build shipped. */
const ENGINE_CHECKSUM_MISMATCH = 'ENGINE_CHECKSUM_MISMATCH'

/** The desktop's code for an artifact whose manifest records another protocol version. */
const ENGINE_PROTOCOL = 'ENGINE_PROTOCOL'

/**
 * Everything the 运行状态 card states about one report, in the words the reference card uses.
 *
 * Four states rather than two for the integrity row: an artifact the manifest cannot vouch for (a
 * development override, or a platform without a recorded digest) is not one that failed its check,
 * and a file that matches its manifest while speaking another protocol is not a corrupt one — saying
 * "not verified" for all three would hide the two that matter.
 */
interface EngineFacts {
  pathValue: string
  /** No host artifact was resolved, so nothing will start an engine. */
  pathBroken: boolean
  versionValue: string
  /** The artifact is on disk and nothing states its SDK version. Not "no host". */
  versionBroken: boolean
  trustValue: string
  trustBroken: boolean
  checksumBroken: boolean
  protocolBroken: boolean
  credentialValue: string
  credentialBroken: boolean
  /** The engine's own trouble as one line, and empty when there is none. */
  diagnostics: string
}

/**
 * The engine's own trouble as one line, and empty when there is none — the card then renders no
 * diagnostics row at all. Every part states something wrong rather than something that merely is:
 * `stopped` before a first start and `starting` while one comes up are the expected lifecycle, so
 * only a host that gave up after repeated crashes is worded; each counter reads 0 until a frame was
 * actually lost, so a zero carries no information.
 */
function engineDiagnostics(runtime: RuntimeStatus, copy: EngineStatusCopy): string {
  const parts: string[] = []
  if (runtime.hostStatus === 'degraded') parts.push(copy.engineDiagnosticsDegraded)
  if (runtime.unknownFrames > 0) parts.push(copy.engineDiagnosticsUnknownFrames(runtime.unknownFrames))
  if (runtime.droppedFrames > 0) parts.push(copy.engineDiagnosticsDroppedFrames(runtime.droppedFrames))
  if (runtime.replayAttempts > 0) parts.push(copy.engineDiagnosticsReplays(runtime.replayAttempts))
  return parts.join(copy.engineDiagnosticsSeparator)
}

function engineFacts(runtime: RuntimeStatus, copy: EngineStatusCopy): EngineFacts {
  const notFound = runtime.enginePath === ''
  // An artifact whose manifest gave no version, and which no running host has reported on either.
  const versionUnknown = !notFound && runtime.engineVersion === '' && runtime.sdkVersion === null
  const checksumBroken = runtime.engineError === ENGINE_CHECKSUM_MISMATCH
  const protocolBroken = runtime.engineError === ENGINE_PROTOCOL
  const credentialBroken = runtime.credentialBackend !== 'os-keyring'
  const trustValue = protocolBroken
    ? copy.engineProtocolMismatch
    : checksumBroken
      ? copy.engineTrustMismatch
      : runtime.engineVerified
        ? copy.engineTrustVerified
        : copy.engineTrustUnverified
  return {
    pathValue: notFound ? copy.engineNotFound : runtime.enginePath,
    pathBroken: notFound,
    // Two sources, one fact: the version recorded for the artifact, or — when that manifest gave
    // none — the one the running host reported about itself.
    versionValue:
      runtime.engineVersion !== ''
        ? runtime.engineVersion
        : (runtime.sdkVersion ?? copy.engineVersionUnknown),
    versionBroken: versionUnknown,
    trustValue,
    trustBroken: checksumBroken || protocolBroken,
    checksumBroken,
    protocolBroken,
    credentialValue: credentialBroken ? copy.credentialUnavailableValue : copy.credentialKeyringValue,
    credentialBroken,
    diagnostics: engineDiagnostics(runtime, copy),
  }
}

/**
 * One engine fact: its label over the value the host reported.
 *
 * Stacked rather than side by side because four of the nine values are absolute paths and two are
 * joined sentences — longer than any control column this page has.
 */
function EngineRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <SettingsRow stack title={label} control={<div className="min-w-0 flex-1">{children}</div>} />
  )
}

/**
 * GitHub's mark on the settings row's icon grid.
 *
 * lucide carries no brand icons, and the project's own repository is one of the resources this page
 * names; the path is GitHub's published Octicons mark, drawn with `currentColor` so the row's own
 * muted tone applies.
 */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

/** The leading icon every resource row wears, in the settings icon grid's own size and tone. */
function resourceIcon(id: string): ReactNode | undefined {
  switch (id) {
    case 'website':
      return <Globe className="size-4" aria-hidden="true" />
    case 'repository':
      return <GithubMark className="size-4" />
    case 'documentation':
      return <BookOpen className="size-4" aria-hidden="true" />
    case 'engine-source':
      return <Code className="size-4" aria-hidden="true" />
    default:
      return undefined
  }
}

/** A value line, in the error tone when the fact it states is a broken one. */
function valueClass(broken: boolean): string {
  return cn('text-[13px] leading-[19px]', broken ? 'text-destructive' : 'text-foreground')
}

export default function AboutSection() {
  const copy = useCopy(COPY)
  const engineCopy = useCopy(ENGINE_COPY)
  const engineRead = useResourceState(runtimeResource)
  const runtime = engineRead.value?.runtime ?? null
  const paths = engineRead.value?.paths ?? null
  const facts = runtime === null ? null : engineFacts(runtime, engineCopy)
  const loading = engineRead.status === 'idle' || engineRead.status === 'loading'

  /**
   * The version the running build reports about itself, read once. A read that fails — which is what
   * a preview outside the desktop shell looks like — leaves the row out entirely rather than
   * printing a number nothing vouched for.
   */
  const [version, setVersion] = useState('')

  useEffect(() => {
    void appVersion()
      .then((value) => setVersion(value))
      .catch(() => undefined)
  }, [])

  // The engine's status is read on the first visit to this section, not while it is never shown.
  useEffect(() => {
    void readEngineStatus()
  }, [])

  /** A retry after the card is on screen: the host may have been restarted since it was read. */
  function retry(): void {
    void readEngineStatus(true)
  }

  /** The restart this page asked for: whether one is in flight, and how the last one failed. */
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState<ApiError | null>(null)

  /**
   * Bring a degraded host back.
   *
   * This is the explicit start path (`runtime_restart`): once the restart series has given up, the
   * implicit start refuses (`ensure_running` answers `host_not_ready` for every page action), so this
   * button is the only way back and the reason it exists. Running turns are not resumed - the engine
   * has no way to continue one in a new process, which is what the hint says - and the status read
   * that follows is what tells the page whether it worked: the value is adopted from the host's own
   * answer rather than patched here, so a restart that failed leaves the page still saying degraded.
   */
  async function restart(): Promise<void> {
    setRestarting(true)
    setRestartError(null)
    try {
      await runtimeRestart()
    } catch (error) {
      setRestartError(toApiError(error))
    } finally {
      setRestarting(false)
    }
    await readEngineStatus(true)
  }

  return (
    <>
      <SettingsGroup title={copy.title} description={copy.description}>
        <SettingsCard>
          {version === '' ? null : (
            <SettingsRow
              icon={<Info className="size-4" aria-hidden="true" />}
              title={copy.versionTitle}
              control={<SettingsBadge>{version}</SettingsBadge>}
            />
          )}
          <SettingsRow
            icon={<Terminal className="size-4" aria-hidden="true" />}
            title={copy.buildTitle}
            control={<SettingsBadge>{copy.buildValue}</SettingsBadge>}
          />
        </SettingsCard>
      </SettingsGroup>

      <AboutUpdates />

      <SettingsGroup title={copy.linksTitle} description={copy.linksDescription}>
        <SettingsCard className="overflow-hidden">
          {copy.resources.map((resource) => (
            <a
              key={resource.id}
              href={resource.href}
              target="_blank"
              rel="noreferrer"
              data-external
              className="block border-b border-border/60 transition-colors last:border-b-0 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <SettingsRow
                icon={resourceIcon(resource.id)}
                title={resource.label}
                description={resource.href}
                control={<ExternalLink className="size-4 text-muted-foreground" aria-hidden="true" />}
              />
            </a>
          ))}
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title={copy.statusTitle} description={engineCopy.engineDescription}>
        <SettingsCard>
          {runtime !== null && paths !== null && facts !== null ? (
            <>
              <EngineRow label={engineCopy.enginePathLabel}>
                {facts.pathBroken ? (
                  <span className={valueClass(true)}>{facts.pathValue}</span>
                ) : (
                  <SettingsPath>{facts.pathValue}</SettingsPath>
                )}
              </EngineRow>
              <EngineRow label={engineCopy.engineVersionLabel}>
                <span className={valueClass(facts.versionBroken)}>{facts.versionValue}</span>
              </EngineRow>
              <EngineRow label={engineCopy.engineTrustLabel}>
                <span className={valueClass(facts.trustBroken)}>{facts.trustValue}</span>
              </EngineRow>
              <EngineRow label={engineCopy.protocolVersionLabel}>
                <span className={valueClass(false)}>{runtime.protocolVersion}</span>
              </EngineRow>
              <EngineRow label={engineCopy.credentialBackendLabel}>
                <span className={valueClass(facts.credentialBroken)}>{facts.credentialValue}</span>
              </EngineRow>
              <EngineRow label={engineCopy.dataRootLabel}>
                <SettingsPath>{runtime.dataRoot}</SettingsPath>
              </EngineRow>
              <EngineRow label={engineCopy.agentDirLabel}>
                <SettingsPath>{runtime.agentDir}</SettingsPath>
              </EngineRow>
              <EngineRow label={engineCopy.configRootLabel}>
                <SettingsPath>{paths.configRoot}</SettingsPath>
              </EngineRow>
              {facts.diagnostics === '' ? null : (
                <EngineRow label={engineCopy.engineDiagnosticsLabel}>
                  <span className={valueClass(true)}>{facts.diagnostics}</span>
                </EngineRow>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3 px-5 py-[15px]">
              {loading ? (
                <span role="status" className="text-[13px] leading-[19px] text-muted-foreground">
                  <TextShimmer>{engineCopy.loading}</TextShimmer>
                </span>
              ) : null}
              <Button variant="outline" size="sm" disabled={loading} onClick={retry}>
                {engineCopy.retry}
              </Button>
            </div>
          )}
        </SettingsCard>
      </SettingsGroup>

      {/* The one engine state this page can act on. A degraded host is where the automatic restart
          series gave up, and the implicit start path refuses to touch it afterwards - every page that
          reads engine state answers `host_not_ready` instead - so `runtime_restart` is the only way
          back and this is the only place it is offered. The action appears for that state alone: a
          stopped host starts itself on the next read, and a running one has nothing to restart. */}
      {runtime !== null && runtime.hostStatus === 'degraded' ? (
        <SettingsNotice variant="destructive" title={engineCopy.engineDegradedTitle}>
          <span className="flex flex-col gap-3">
            <span>{engineCopy.engineDegradedHint}</span>
            <span className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="secondary" disabled={restarting} onClick={() => void restart()}>
                {restarting ? engineCopy.engineRestarting : engineCopy.engineRestart}
              </Button>
              {restartError === null ? null : (
                <span className="min-w-0">
                  {engineCopy.engineRestartFailed} {restartError.message}
                </span>
              )}
            </span>
          </span>
        </SettingsNotice>
      ) : null}

      {/* The read's own refusal, with the host's sentence. The retry sits in the card while no value
          is on screen; when rows from an earlier read are still shown, this notice is the only place
          a retry can be offered, so it carries one. */}
      {engineRead.status === 'error' ? (
        <SettingsNotice variant="destructive" title={engineCopy.loadFailed}>
          <span className="flex flex-wrap items-center gap-3">
            {engineRead.error === null ? null : (
              <span className="min-w-0">{engineRead.error.message}</span>
            )}
            {runtime === null ? null : (
              <Button size="sm" variant="secondary" onClick={retry}>
                {engineCopy.retry}
              </Button>
            )}
          </span>
        </SettingsNotice>
      ) : null}

      {/* Unresolved host artifact: nothing will start an engine, so the fix is to provide one. */}
      {facts !== null && facts.pathBroken ? (
        <SettingsNotice variant="info" title={engineCopy.engineNotFound}>
          {engineCopy.engineNotFoundHint}
        </SettingsNotice>
      ) : null}

      {/* A host artifact is on disk but nothing states its SDK version; this must not read as "no
          host". */}
      {facts !== null && facts.versionBroken ? (
        <SettingsNotice variant="info" title={engineCopy.engineVersionUnknown}>
          {engineCopy.engineVersionUnknownHint}
        </SettingsNotice>
      ) : null}

      {facts !== null && facts.checksumBroken ? (
        <SettingsNotice variant="destructive" title={engineCopy.engineTrustMismatchTitle}>
          {engineCopy.engineTrustMismatchHint}
        </SettingsNotice>
      ) : null}

      {/* A file that is exactly what its manifest describes, and still cannot be talked to: nothing
          about the file is wrong, only its age, and the fix is to build it again. */}
      {facts !== null && facts.protocolBroken ? (
        <SettingsNotice variant="destructive" title={engineCopy.engineProtocolMismatchTitle}>
          {engineCopy.engineProtocolMismatchHint}
        </SettingsNotice>
      ) : null}

      {/* Any backend other than the OS keyring means keys cannot be persisted. */}
      {facts !== null && facts.credentialBroken ? (
        <SettingsNotice variant="destructive" title={engineCopy.credentialUnavailableTitle}>
          {engineCopy.credentialUnavailableHint}
        </SettingsNotice>
      ) : null}
    </>
  )
}

import { Fragment, useEffect, useRef, useState } from 'react'
import { FileText, Folder, FolderOpen, RefreshCw, Search } from 'lucide-react'

import type {
  EngineMemoryCatalogView,
  EngineMemoryView,
  EngineMemoryWorkspace,
} from '@/api/capabilities-types'
import type { ApiError } from '@/api/client'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/motion/select'
import { Switch } from '@/components/motion/switch'
import { useCopy, useLanguage, type Localized } from '@/lib/i18n'
import {
  SettingsBadge,
  SettingsCard,
  SettingsEmpty,
  SettingsLoadState,
  SettingsRow,
} from '@/settings/parts'
import { formatMemoryUpdatedAt, type MemoryUpdatedCopy } from '@/settings/sections/memory-updated'
import {
  memoryCatalogResource,
  memoryResource,
  readMemory,
  readMemoryCatalog,
  revealMemoryFile,
  setMemoryBackend,
} from '@/state/memory-store'
import { useResourceState, type ResourceState } from '@/state/resource'
import { useStoreSelector } from '@/state/store'
import { workspaceStore, type WorkspaceState } from '@/state/workspace-store'

/**
 * Workspace memory on or off, the backend the engine runs for this project, and — while that backend
 * keeps files — the documents a workspace's memory consists of. The switch's own sentence names the
 * cost, so nothing here repeats it.
 *
 * Two owners, and the page decides nothing itself. The engine owns the switch and the backend: the
 * value is `memory.backend`, read through the host and written back through it, so both controls
 * show what the engine reports rather than what was clicked. The desktop owns the file list: the
 * workspace ids it sends are resolved from the store, the engine's own root derivation names the
 * directory, and the walk over it is read-only.
 *
 * The clock is the third piece: a row says "3 min ago" or "Today 14:05", so the list re-renders on a
 * slow tick instead of freezing the wording it had when it loaded.
 */

/** `memoryCopy.ts`'s wording, the part this page shows, in both languages. */
interface MemoryCopy {
  workspaceMemory: string
  memoryDescription: string
  /** One write in flight; both controls lock while one is. */
  saving: string
  backendTitle: string
  backendDescription: string
  /** The engine's own backend ids, named; one this page has no word for keeps the engine's token. */
  backendNames: Readonly<Record<string, string>>
  backendOutsideOptions: (id: string) => string
  /** The active backend keeps its memories somewhere other than files, so there is nothing to list. */
  localOnly: (backend: string) => string
  loading: string
  loadFailed: string
  retry: string
  empty: string
  workspaceLabel: string
  files: string
  memoryCount: (count: number) => string
  searchLabel: string
  searchPlaceholder: string
  searchEmpty: string
  refresh: string
  refreshing: string
  reveal: string
  revealFailed: string
  updated: MemoryUpdatedCopy
}

const COPY: Localized<MemoryCopy> = {
  en: {
    workspaceMemory: 'Workspace Memory',
    memoryDescription:
      'Save and reuse long-term context in workspaces. Applies to new sessions and may increase model requests and token costs.',
    saving: 'Saving…',
    backendTitle: 'Memory backend',
    backendDescription:
      'Which memory subsystem the engine runs for this project — the engine’s own `memory.backend` setting.',
    backendNames: {
      off: 'Off',
      local: 'Local files',
      mnemopi: 'Mnemo Pi (local)',
      sharpshooter: 'Sharpshooter',
    },
    backendOutsideOptions: (id) =>
      `The active backend is \`${id}\`, which this app does not offer — it needs setup this app has no control over. Pick one of the backends above to replace it.`,
    localOnly: (backend) =>
      `File-backed memory belongs to the engine’s local backend. The active backend is ${backend}, which keeps its memories elsewhere, so there is nothing to list here.`,
    loading: 'Loading memories…',
    loadFailed: 'Could not read the memory state.',
    retry: 'Retry',
    empty: 'No saved workspace memories',
    workspaceLabel: 'Workspaces',
    files: 'Files',
    memoryCount: (count) => `${count} memor${count === 1 ? 'y' : 'ies'}`,
    searchLabel: 'Search memory files',
    searchPlaceholder: 'Search memory files…',
    searchEmpty: 'No memory files found.',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    reveal: 'Reveal in file manager',
    revealFailed: 'Could not reveal this file.',
    updated: {
      justNow: 'Just now',
      minutesAgo: (count) => `${count} min ago`,
      today: (time) => `Today ${time}`,
      yesterday: (time) => `Yesterday ${time}`,
      weekday: (weekday, time) => `${weekday} ${time}`,
      weekdayZh: (weekday) => `周${weekday}`,
      date: (date, time) => `${date} ${time}`,
      monthDay: (month, day) => `${month}/${day}`,
      yearMonthDay: (year, month, day) => `${year}/${month}/${day}`,
    },
  },
  zh: {
    workspaceMemory: '工作区记忆',
    memoryDescription: '在工作区中保存并复用长期上下文，新会话生效。开启后可能增加模型调用和 Token 成本。',
    saving: '保存中…',
    backendTitle: '记忆后端',
    backendDescription: '引擎为本项目运行哪套记忆子系统，也就是引擎自己的 `memory.backend` 设置。',
    backendNames: {
      off: '关闭',
      local: '本地文件',
      mnemopi: 'Mnemo Pi（本地）',
      sharpshooter: 'Sharpshooter',
    },
    backendOutsideOptions: (id) =>
      `当前后端是 \`${id}\`，本应用不提供它——它需要本应用无法配置的前置条件。从上面选择一个后端即可替换它。`,
    localOnly: (backend) =>
      `文件记忆只属于引擎的本地后端。当前后端是 ${backend}，它把记忆保存在别处，因此这里没有可列出的文件。`,
    loading: '正在加载记忆…',
    loadFailed: '无法读取记忆状态。',
    retry: '重试',
    empty: '暂无已保存的工作区记忆',
    workspaceLabel: '工作区',
    files: '文件',
    memoryCount: (count) => `${count} 条记忆`,
    searchLabel: '搜索记忆文件',
    searchPlaceholder: '搜索记忆文件…',
    searchEmpty: '没有匹配的记忆文件。',
    refresh: '刷新',
    refreshing: '刷新中...',
    reveal: '在文件管理器中显示',
    revealFailed: '无法在文件管理器中显示该文件。',
    updated: {
      justNow: '刚刚',
      minutesAgo: (count) => `${count} 分钟前`,
      today: (time) => `今天 ${time}`,
      yesterday: (time) => `昨天 ${time}`,
      weekday: (weekday, time) => `${weekday} ${time}`,
      weekdayZh: (weekday) => `周${weekday}`,
      date: (date, time) => `${date} ${time}`,
      monthDay: (month, day) => `${month} 月 ${day} 日`,
      yearMonthDay: (year, month, day) => `${year} 年 ${month} 月 ${day} 日`,
    },
  },
}

/** How often the rows' timestamps are re-worded while a file list is on screen. */
const CLOCK_TICK_MS = 30_000

/** The store's own fields, read one at a time: a selector that built an object would loop. */
const selectActiveWorkspaceId = (state: WorkspaceState) => state.activeId
const selectWorkspaces = (state: WorkspaceState) => state.items

/** What `SettingsLoadState` is handed: one status and one error for the whole page. */
interface PageReadState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: ApiError | null
}

/**
 * The page's one read state: both reads feed this page, so whichever is outstanding or failed is the
 * one worth reporting, and the reader gets one line rather than two.
 */
function pageReadState(
  memory: ResourceState<EngineMemoryView>,
  catalog: ResourceState<EngineMemoryCatalogView>,
): PageReadState {
  if (memory.status === 'error') return { status: 'error', error: memory.error }
  if (catalog.status === 'error') return { status: 'error', error: catalog.error }
  if (memory.status !== 'ready') return { status: memory.status, error: null }
  if (catalog.status !== 'ready') return { status: catalog.status, error: null }
  return { status: 'ready', error: null }
}

/** The engine's own name for a backend, or its own token when this page has no word for it. */
function backendName(copy: MemoryCopy, id: string): string {
  return copy.backendNames[id] ?? id
}

/**
 * The workspace the viewer shows: the one that was picked, while the host still answers for it, then
 * the one being worked in, then the first the host named. Nothing is selected only when the host
 * named no workspace at all.
 */
function selectWorkspace(
  workspaces: readonly EngineMemoryWorkspace[],
  pickedId: number | null,
  activeId: number | null,
): EngineMemoryWorkspace | null {
  const picked = workspaces.find((entry) => entry.workspaceId === pickedId)
  if (picked !== undefined) return picked
  const active = workspaces.find((entry) => entry.workspaceId === activeId)
  if (active !== undefined) return active
  return workspaces.length > 0 ? workspaces[0] : null
}

/** The ids the host is asked to walk; resolved from the store, never from a path this side hands it. */
function workspaceIds(): number[] {
  return workspaceStore.get().items.map((workspace) => workspace.id)
}

export default function MemorySection() {
  const copy = useCopy(COPY)
  const { language } = useLanguage()
  const activeWorkspaceId = useStoreSelector(workspaceStore, selectActiveWorkspaceId)
  const workspaces = useStoreSelector(workspaceStore, selectWorkspaces)
  const memory = useResourceState(memoryResource)
  const catalog = useResourceState(memoryCatalogResource)

  /** One write at a time; both controls lock while one is in flight. */
  const [writing, setWriting] = useState(false)
  const [writeFailure, setWriteFailure] = useState<ApiError | null>(null)
  /** The path of the file whose reveal failed; the line under that row says so. */
  const [revealFailure, setRevealFailure] = useState<string | null>(null)
  /** The viewer's own query; it never leaves the page. */
  const [query, setQuery] = useState('')
  /**
   * The workspace the reader picked, kept together with the active one it was picked under: a pick
   * belongs to that workspace, so working in another one takes the viewer with it.
   */
  const [pick, setPick] = useState<{ activeId: number | null; workspaceId: number } | null>(null)
  /** The clock every row is worded against, re-read on the tick below. */
  const [now, setNow] = useState(() => Date.now())
  const lastBackend = useRef<string | null>(null)

  const view = memory.value
  const backend = view?.backend ?? null
  const backends = view?.backends ?? []
  const catalogValue = catalog.value
  const catalogWorkspaces = catalogValue?.workspaces ?? []
  const pickedWorkspaceId =
    pick !== null && pick.activeId === activeWorkspaceId ? pick.workspaceId : activeWorkspaceId
  const selected = selectWorkspace(catalogWorkspaces, pickedWorkspaceId, activeWorkspaceId)
  const files = selected?.files ?? []
  const trimmedQuery = query.trim().toLocaleLowerCase()
  const visibleFiles =
    trimmedQuery === ''
      ? files
      : files.filter((file) => file.name.toLocaleLowerCase().includes(trimmedQuery))
  const readState = pageReadState(memory, catalog)

  // The engine's view belongs to the workspace being worked in — it is what the host resolves the
  // memory root for — so a switch reads it again.
  useEffect(() => {
    void readMemory(activeWorkspaceId)
  }, [activeWorkspaceId])

  // The catalog answers per workspace, so the set of them is the question: a workspace added or
  // removed asks again, while a re-render with the same set does not. The ids themselves are read
  // from the store when the read starts, so the array's identity is never a reason to ask again.
  const catalogKey = workspaces.map((workspace) => workspace.id).join(',')
  useEffect(() => {
    void readMemoryCatalog(workspaceIds())
  }, [catalogKey])

  // A different backend keeps its memories somewhere else, so the walk is asked for again once the
  // engine has reported the new one; the first landing is not a change.
  useEffect(() => {
    if (backend === null) return
    const changed = lastBackend.current !== null && lastBackend.current !== backend
    lastBackend.current = backend
    if (changed) void readMemoryCatalog(workspaceIds(), true)
  }, [backend])

  // The tick only matters while a file list is on screen.
  useEffect(() => {
    if (backend !== 'local') return
    const ticker = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(ticker)
  }, [backend])

  /**
   * One write for both controls: `local` is the switch's on, `off` is its off, and a pick is the
   * value itself. The engine's own answer replaces what is on screen — never the click.
   */
  async function writeBackend(next: string): Promise<void> {
    if (writing || backend === null || next === backend) return
    setWriting(true)
    setWriteFailure(await setMemoryBackend(activeWorkspaceId, next))
    setWriting(false)
  }

  /** The page's one retry, which is also the list's own refresh: both reads feed this page. */
  function refresh(): void {
    void readMemoryCatalog(workspaceIds(), true)
    void readMemory(activeWorkspaceId, true)
  }

  /** Reveals one document in the platform's file manager; the host derives the root it must be in. */
  async function reveal(workspaceId: number, path: string, name: string): Promise<void> {
    setRevealFailure(null)
    try {
      const answer = await revealMemoryFile(workspaceId, name)
      setRevealFailure(answer.ok ? null : path)
    } catch {
      setRevealFailure(path)
    }
  }

  return (
    <>
      <SettingsLoadState
        status={readState.status}
        error={readState.error}
        loadingLabel={copy.loading}
        failedLabel={copy.loadFailed}
        retryLabel={copy.retry}
        onRetry={refresh}
      />

      <SettingsCard>
        <SettingsRow
          title={copy.workspaceMemory}
          description={copy.memoryDescription}
          control={
            <>
              {writing ? (
                <span role="status" className="text-[13px] leading-[19px] text-muted-foreground">
                  {copy.saving}
                </span>
              ) : null}
              <Switch
                checked={backend !== null && backend !== 'off'}
                disabled={writing || backend === null}
                onCheckedChange={(next) => void writeBackend(next ? 'local' : 'off')}
                ariaLabel={copy.workspaceMemory}
              />
            </>
          }
        />
        <SettingsRow
          title={copy.backendTitle}
          description={copy.backendDescription}
          control={
            backend === null ? null : (
              <div className="w-[190px]">
                <Select
                  value={backend}
                  disabled={writing}
                  onValueChange={(next) => void writeBackend(next)}
                >
                  <SelectTrigger>
                    <span className="sr-only">{copy.backendTitle}</span>
                    {/* A backend the picker does not offer has no item to name it, so the trigger
                        falls back to the engine's own token — the one the hint below spells out. */}
                    <SelectValue placeholder={backendName(copy, backend)} />
                  </SelectTrigger>
                  <SelectContent>
                    {backends.map((id) => (
                      <SelectItem key={id} value={id}>
                        {backendName(copy, id)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )
          }
        />

        {/* A `memory.backend` this app does not offer: not a failure, and any offered one replaces it. */}
        {backend !== null && !backends.includes(backend) ? (
          <p className="px-5 pt-3 pb-4 text-[13px] leading-[19px] text-muted-foreground">
            {copy.backendOutsideOptions(backend)}
          </p>
        ) : null}

        {/* The host refused the write: what it said, next to the controls that asked for it. */}
        {writeFailure === null ? null : (
          <p
            role="alert"
            className="flex flex-wrap items-center gap-2 px-5 pt-3 pb-4 text-[13px] leading-[19px] text-destructive"
          >
            <SettingsBadge>{writeFailure.code}</SettingsBadge>
            <span className="min-w-0">{writeFailure.message}</span>
          </p>
        )}
      </SettingsCard>

      {/* Not the local backend: the engine keeps no files for it, so there is nothing to list. */}
      {backend !== null && backend !== 'local' ? (
        <SettingsEmpty>{copy.localOnly(backendName(copy, backend))}</SettingsEmpty>
      ) : null}

      {/* The local backend: the walk over every workspace's memory root, once the host has answered. */}
      {backend === 'local' && catalogValue !== null ? (
        selected === null ? (
          <SettingsEmpty>{copy.empty}</SettingsEmpty>
        ) : (
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Folder className="size-4 flex-none text-muted-foreground" aria-hidden="true" />
              <span className="text-[13px] leading-5 text-muted-foreground">
                {copy.workspaceLabel}
              </span>
              <div className="w-[190px]">
                <Select
                  value={String(selected.workspaceId)}
                  onValueChange={(next) =>
                    setPick({ activeId: activeWorkspaceId, workspaceId: Number(next) })
                  }
                >
                  <SelectTrigger>
                    <span className="sr-only">{copy.workspaceLabel}</span>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {catalogWorkspaces.map((workspace) => (
                      <SelectItem key={workspace.workspaceId} value={String(workspace.workspaceId)}>
                        {workspace.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <span className="h-5 w-px bg-border" aria-hidden="true" />
              <span className="text-[13px] leading-5 text-muted-foreground">
                {copy.memoryCount(files.length)}
              </span>
              <div className="ml-auto w-[220px]">
                <Input
                  value={query}
                  onChange={setQuery}
                  placeholder={copy.searchPlaceholder}
                  aria-label={copy.searchLabel}
                  leftIcon={<Search />}
                  classNames={{ field: 'h-9 rounded-lg', input: 'text-sm' }}
                />
              </div>
            </div>

            {trimmedQuery !== '' && visibleFiles.length === 0 ? (
              <SettingsEmpty>{copy.searchEmpty}</SettingsEmpty>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-[15px] leading-[22px] font-semibold text-foreground">
                    {copy.files}
                  </h3>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={catalog.status === 'loading'}
                    onClick={refresh}
                  >
                    <RefreshCw className="size-3.5" aria-hidden="true" />
                    {catalog.status === 'loading' ? copy.refreshing : copy.refresh}
                  </Button>
                </div>

                <SettingsCard>
                  {visibleFiles.map((file) => (
                    <Fragment key={file.path}>
                      <div className="flex items-center gap-3 border-b border-border/60 px-5 py-[13px] last:border-b-0">
                        <span className="grid size-7 flex-none place-items-center rounded-lg bg-muted text-muted-foreground">
                          <FileText className="size-4" aria-hidden="true" />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-sm leading-5 font-medium text-foreground">
                            {file.name}
                          </span>
                          <span className="text-xs leading-[18px] text-muted-foreground">
                            {formatMemoryUpdatedAt(copy.updated, language, now, file.modifiedAtMs)}
                          </span>
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={copy.reveal}
                          title={copy.reveal}
                          onClick={() => void reveal(selected.workspaceId, file.path, file.name)}
                        >
                          <FolderOpen className="size-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                      {revealFailure === file.path ? (
                        <p
                          role="alert"
                          className="px-5 pb-[13px] text-xs leading-[18px] text-destructive"
                        >
                          {copy.revealFailed}
                        </p>
                      ) : null}
                    </Fragment>
                  ))}
                </SettingsCard>
              </>
            )}
          </section>
        )
      ) : null}
    </>
  )
}

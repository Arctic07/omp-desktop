import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Download, Plus, RefreshCw, Search } from 'lucide-react'

import type { EngineSkillRow, EngineSkillSetTarget } from '@/api/capabilities-types'
import type { ApiError } from '@/api/client'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Switch } from '@/components/motion/switch'
import { useCopy } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  SettingsBadge,
  SettingsCard,
  SettingsEmpty,
  SettingsGroup,
  SettingsLoadState,
  SettingsNotice,
  SettingsPath,
  SettingsRow,
  SettingsStats,
} from '@/settings/parts'
import {
  IMPORTABLE_SKILL_PROVIDERS,
  SKILLS_COPY,
  type SkillImportSelection,
  type SkillLevel,
} from '@/settings/sections/skills-copy'
import { useResourceState } from '@/state/resource'
import { prefillComposer } from '@/state/composer-prefill'
import { sendPrompt, sessionStore, startSessionIn } from '@/state/session-store'
import { readSkills, skillWriteKey, skillsResource, writeSkill } from '@/state/skills-store'
import { workspaceStore } from '@/state/workspace-store'
import { WorkspaceScopeSelect } from '@/settings/WorkspaceScopeSelect'
import { useWorkspaceScope } from '@/settings/use-workspace-scope'

/**
 * The skills page: what the engine discovered for this workspace, grouped by the level it reported,
 * and the engine's own switches over it.
 *
 * Nothing here decides whether a skill is enabled — the engine does, and every write answers with the
 * whole refreshed list, which is what this page then renders. The list belongs to a workspace (the
 * engine discovers skills per directory), so a switch of workspace reads again.
 *
 * The two entries that create work are different on purpose. `导入` hands a task to the engine,
 * because the files another agent owns are read through the agent's own tools. `新建` opens a new
 * task and puts `/skill:skill-creator` in the composer without sending it, and the seeded
 * `skill-creator` skill supplies the interview. Skill files belong to the engine's own tools, so
 * neither entry writes one here.
 */

/** The levels this page names, in the order it shows them. */
const LEVELS: readonly SkillLevel[] = ['user', 'project', 'native', 'unknown']

/** One page of the list. A skill row is taller than a provider row, but the pages are the same
 *  count the models page uses, and the list no longer grows with the number of skills installed:
 *  the section column keeps its own scroll and the page itself never grows past the window. */
const PAGE_SIZE = 5

/** The engine's level for a row, folded to the four names above. */
function levelOf(level: string): SkillLevel {
  return level === 'user' || level === 'project' || level === 'native' ? level : 'unknown'
}

/** No rows at all, as one array: a list the engine has not answered yet keeps its identity. */
const NO_ROWS: readonly EngineSkillRow[] = []

/** The rows the scope and the query select, in the engine's own order. */
function selectRows(rows: readonly EngineSkillRow[], query: string): EngineSkillRow[] {
  const term = query.trim().toLowerCase()
  return rows.filter((row) => {
    if (term === '') return true
    return (
      row.name.toLowerCase().includes(term) ||
      row.description.toLowerCase().includes(term) ||
      row.source.toLowerCase().includes(term) ||
      row.baseDir.toLowerCase().includes(term)
    )
  })
}

/** The skills other agents on this machine provide, which is what an import task copies. */
function importableSkills(rows: readonly EngineSkillRow[]): SkillImportSelection[] {
  return rows
    .filter((row) => IMPORTABLE_SKILL_PROVIDERS.includes(row.source))
    .map((row) => ({ name: row.name, filePath: row.filePath }))
}

/** One switch's refusal: this page's sentence, the engine's code, and its own message. */
function WriteFailure({ failure, className }: { failure: ApiError | null; className?: string }) {
  const copy = useCopy(SKILLS_COPY)
  if (failure === null) return null
  return (
    <span
      role="alert"
      className={cn(
        'flex flex-wrap items-center gap-1.5 text-xs leading-[18px] text-destructive',
        className,
      )}
    >
      {copy.writeFailed}
      <SettingsBadge>{failure.code}</SettingsBadge>
      <span className="min-w-0 text-muted-foreground">{failure.message}</span>
    </span>
  )
}

/** The pattern lists the engine's own settings carry; this page only reports them. */
function PatternChips({ patterns }: { patterns: readonly string[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {patterns.map((pattern) => (
        <SettingsPath key={pattern}>{pattern}</SettingsPath>
      ))}
    </span>
  )
}

/**
 * One skill: what it is, where it came from, and the switch the engine gates it by.
 *
 * `busy` marks the row whose write is in flight, and `disabled` covers every other row: two switches
 * writing the same setting at once could each read the same previous value.
 */
function SkillRow({
  row,
  source,
  busy,
  disabled,
  failure,
  onToggle,
}: {
  row: EngineSkillRow
  /** The provider as this page names it; the engine's own name, or the copy's for a known id. */
  source: string
  busy: boolean
  disabled: boolean
  failure: ApiError | null
  onToggle: (next: boolean) => void
}) {
  const copy = useCopy(SKILLS_COPY)

  return (
    <div className="flex min-h-[70px] items-center justify-between gap-6 border-b border-border/60 px-5 py-[15px] last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm leading-5 font-medium text-foreground">{row.name}</span>
          <SettingsBadge>{source}</SettingsBadge>
          {row.plugin === null ? null : (
            <SettingsBadge>{copy.pluginBadge(row.plugin)}</SettingsBadge>
          )}
          {row.hidden ? (
            <AnimatedBadge status="warning" size="sm" animated={false}>
              {copy.hiddenBadge}
            </AnimatedBadge>
          ) : null}
        </span>
        <span className="text-[13px] leading-[19px] text-muted-foreground">
          {row.description.trim() === '' ? copy.noDescription : row.description}
        </span>
        {row.plugin === null ? null : (
          <span className="text-xs leading-[18px] text-muted-foreground">{copy.pluginHint(row.plugin)}</span>
        )}
        <SettingsPath>{row.filePath}</SettingsPath>
        <WriteFailure failure={failure} />
      </div>

      {busy ? (
        <span className="text-xs leading-[18px] text-muted-foreground" role="status">
          {copy.writeBusy}
        </span>
      ) : null}

      <Switch
        checked={row.enabled}
        // A skill a plugin carries is not the reader's to switch: the plugin's own switch is that
        // decision, and the engine stops discovering the skill when the plugin is off.
        disabled={disabled || row.plugin !== null}
        onCheckedChange={onToggle}
        ariaLabel={
          row.plugin !== null
            ? copy.pluginBadge(row.plugin)
            : row.enabled
              ? copy.toggleOff(row.name)
              : copy.toggleOn(row.name)
        }
      />
    </div>
  )
}

export default function SkillsSection({
  onOpenWorkspace,
  active = true,
}: {
  onOpenWorkspace: () => void
  /** Whether this is the section on screen; a hidden section holds its read until it returns. */
  active?: boolean
}) {
  const copy = useCopy(SKILLS_COPY)
  const { workspaceId, target, setTarget } = useWorkspaceScope()
  const { status, error, value: view } = useResourceState(skillsResource)

  /** The scope the rows were drawn in before the pick; while the new read runs they keep it. */
  const [listTarget, setListTarget] = useState(target)
  /** A picker change is reading the new directory; the old rows keep their own scope meanwhile. */
  const [switching, setSwitching] = useState(false)
  const [query, setQuery] = useState('')
  /** The page on screen; clamped below rather than reset when the list changes under it. */
  const [page, setPage] = useState(1)
  /** The engine's warnings banner: collapsed until the reader asks for the paths and reasons. */
  const [warningsOpen, setWarningsOpen] = useState(false)
  /** The switch a write is in flight for, or ''; `skillWriteKey` spells its shape. */
  const [busyKey, setBusyKey] = useState('')
  const [failures, setFailures] = useState<Readonly<Record<string, ApiError>>>({})
  const [taskNotice, setTaskNotice] = useState('')
  const [taskFailed, setTaskFailed] = useState(false)
  const [taskRunning, setTaskRunning] = useState(false)

  // The engine discovers skills per directory, so the list follows the workspace it describes. It
  // is also re-read whenever the section is shown: a skill written in chat while the page was
  // hidden (the *New skill* flow) would otherwise wait for the reader to find Refresh.
  useEffect(() => {
    if (!active) return
    void readSkills(workspaceId, true)
  }, [active, workspaceId])

  const refresh = useCallback(() => {
    void readSkills(workspaceId, true)
  }, [workspaceId])

  // The picker is page-local: it starts on the machine-wide scope, and choosing another workspace
  // never moves the conversation column. The rows on screen keep the scope they were drawn in
  // until the new read answers.
  useEffect(() => {
    if (target !== listTarget) setSwitching(true)
  }, [target, listTarget])

  // The rows on screen are the previous directory's until this read answers; filtering them by the
  // new scope would empty the list and change the page height for a frame.
  useEffect(() => {
    if (!switching) return
    let live = true
    void readSkills(workspaceId).finally(() => {
      if (!live) return
      setListTarget(target)
      setSwitching(false)
    })
    return () => {
      live = false
    }
  }, [switching, target, workspaceId])

  const rows = view?.skills ?? NO_ROWS
  const filtered = useMemo(() => {
    // The machine-wide scope lists no workspace's project skills; the host may still discover them
    // from its default directory, so they are dropped here rather than shown under `用户`.
    const rowsInScope =
      listTarget === 'user'
        ? rows.filter((row) => levelOf(row.level) !== 'project')
        : rows.filter((row) => levelOf(row.level) === 'project')
    return selectRows(rowsInScope, query)
  }, [rows, query, listTarget])
  // The page is clamped rather than reset: a filter that shortens the list, a workspace switch, or a
  // skill turned off elsewhere moves the reader to the last page that exists instead of an empty one.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pageRows = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [currentPage, filtered],
  )
  const groups = useMemo(
    () =>
      LEVELS.map((level) => ({
        level,
        rows: pageRows.filter((row) => levelOf(row.level) === level),
      })).filter((group) => group.rows.length > 0),
    [pageRows],
  )

  /** Turn one switch. The answer is the engine's own list, so a refusal keeps the page as it was. */
  const write = useCallback(
    async (target: EngineSkillSetTarget, id: string | null, enabled: boolean) => {
      if (busyKey !== '') return
      const key = skillWriteKey(target, id)
      setBusyKey(key)
      setFailures((current) => {
        if (current[key] === undefined) return current
        const next = { ...current }
        delete next[key]
        return next
      })
      const failure = await writeSkill(workspaceId, target, id, enabled)
      if (failure !== null) setFailures((current) => ({ ...current, [key]: failure }))
      setBusyKey('')
    },
    [busyKey, workspaceId],
  )

  /**
   * Start one agent task for a skill the reader asked for: a session in this workspace whose first
   * prompt is the task's own words. The desktop writes no skill file — the engine's agents own their
   * own directories, and the prompts name the ones the engine discovers.
   */
  const startTask = useCallback(
    async (prompt: string) => {
      if (taskRunning) return
      setTaskFailed(false)
      setTaskNotice('')
      if (workspaceId === null) {
        setTaskFailed(true)
        return
      }
      setTaskRunning(true)
      try {
        await startSessionIn(workspaceId)
        // The session is what a prompt goes to, so a creation that did not land is this task's own
        // failure rather than a prompt sent into whatever was on screen before.
        if (sessionStore.get().activeId === null) {
          setTaskFailed(true)
          return
        }
        await sendPrompt(prompt)
        setTaskNotice(copy.taskStarted)
        onOpenWorkspace()
      } catch {
        setTaskFailed(true)
      } finally {
        setTaskRunning(false)
      }
    },
    [copy, onOpenWorkspace, taskRunning, workspaceId],
  )

  /**
   * The authoring hand-off: a new conversation in one workspace, with `/skill:skill-creator` in the
   * composer and nothing sent. The prompt names the level the reader chose, because the recipe is
   * the same either way and the destination is the one thing it cannot infer.
   */
  /**
   * The one authoring entry. The picker decides the destination: a picked workspace creates a
   * project-level skill there, while the user scope creates a user-level skill in the conversation's
   * current workspace. One button, because the scope is already the reader's answer.
   */
  const startNewSkill = useCallback(() => {
    if (taskRunning) return
    setTaskFailed(false)
    setTaskNotice('')
    const project = target !== 'user'
    const targetWorkspace = project ? target : workspaceStore.get().activeId
    if (targetWorkspace === null) {
      setTaskFailed(true)
      return
    }
    setTaskRunning(true)
    void (async () => {
      try {
        await startSessionIn(targetWorkspace)
        if (sessionStore.get().activeId === null) {
          setTaskFailed(true)
          return
        }
        prefillComposer(project ? copy.newProjectSkillPrompt : copy.newUserSkillPrompt)
        onOpenWorkspace()
      } catch {
        setTaskFailed(true)
      } finally {
        setTaskRunning(false)
      }
    })()
  }, [copy.newProjectSkillPrompt, copy.newUserSkillPrompt, onOpenWorkspace, target, taskRunning])

  /** `导入` hands the skills other agents provide to one task; with none there is nothing to hand over. */
  const startImport = useCallback(() => {
    const skills = importableSkills(rows)
    if (skills.length === 0) {
      setTaskFailed(false)
      setTaskNotice(copy.importEmpty)
      return
    }
    void startTask(copy.importSkillPrompt(skills))
  }, [copy, rows, startTask])

  const busy = busyKey !== ''
  /**
   * What the read state reads as over the list: a refresh in flight keeps the list on screen, so only
   * a first read or a failure is drawn above it.
   */
  const loadStatus = view !== null && status === 'loading' ? 'ready' : status
  const searching = query.trim() !== ''
  const figures =
    view === null
      ? []
      : [
          { value: String(view.summary.total), label: copy.figureSkills },
          { value: String(view.summary.enabled), label: copy.figureEnabled },
          { value: String(view.summary.disabled), label: copy.figureDisabled },
          { value: String(view.summary.hidden), label: copy.figureHidden },
          { value: String(view.summary.warnings), label: copy.figureWarnings },
        ]

  return (
    <>
      {view === null || error !== null ? (
        <SettingsLoadState
          status={loadStatus}
          error={error}
          loadingLabel={copy.loading}
          failedLabel={copy.loadFailed}
          retryLabel={copy.retry}
          onRetry={refresh}
        />
      ) : null}

      {taskFailed ? <SettingsNotice variant="destructive" title={copy.taskFailed} /> : null}
      {taskNotice === '' ? null : (
        <p className="text-[13px] leading-[19px] text-muted-foreground" role="status">
          {taskNotice}
        </p>
      )}

      {view === null ? null : (
        <>
          <SettingsCard>
            <SettingsStats items={figures} />
          </SettingsCard>

          {/* The warnings sit above the list: a count the reader sees without scrolling, and the
              paths and reasons only when asked for. The
              page used to bury the one warning at the foot of the engine card, where "1 warning"
              in the figures pointed at nothing visible (2026-10-21). */}
          {view.warnings.length === 0 ? null : (
            <div className="overflow-hidden rounded-2xl border border-amber-500/40 bg-amber-500/10">
              <button
                type="button"
                aria-expanded={warningsOpen}
                aria-label={warningsOpen ? copy.warningsCollapse : copy.warningsExpand}
                onClick={() => setWarningsOpen((open) => !open)}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                {warningsOpen ? (
                  <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
                ) : (
                  <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
                )}
                <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-amber-500" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {copy.warningsSummary(view.warnings.length)}
                </span>
              </button>
              {warningsOpen ? (
                <ul className="flex flex-col gap-2.5 border-t border-amber-500/30 px-4 py-3">
                  {view.warnings.map((warning) => (
                    <li
                      key={`${warning.skillPath}:${warning.message}`}
                      className="flex min-w-0 flex-col gap-1"
                    >
                      <SettingsPath>{warning.skillPath}</SettingsPath>
                      <span className="text-[13px] leading-[19px] text-muted-foreground">
                        {warning.message}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <WorkspaceScopeSelect
              value={target}
              onChange={(next) => {
                setSwitching(true)
                setTarget(next)
              }}
            />
            <span className="h-5 w-px bg-border" aria-hidden="true" />
            <span className="text-[13px] leading-5 text-muted-foreground">
              {copy.countLabel(filtered.length)}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <div className="w-[220px]">
                <Input
                  value={query}
                  onChange={(value) => {
                    setQuery(value)
                    setPage(1)
                  }}
                  placeholder={copy.searchPlaceholder}
                  aria-label={copy.searchLabel}
                  leftIcon={<Search />}
                  classNames={{ field: 'h-9 rounded-lg', input: 'text-sm' }}
                />
              </div>
              <Button size="sm" variant="ghost" disabled={taskRunning} onClick={startImport}>
                <Download size={14} aria-hidden="true" />
                {copy.importAction}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={status === 'loading'}
                onClick={refresh}
                aria-label={copy.refresh}
                title={copy.refresh}
              >
                <RefreshCw size={14} aria-hidden="true" />
                {copy.refresh}
              </Button>
              {filtered.length === 0 && !searching ? null : (
                <Button size="sm" disabled={taskRunning} onClick={startNewSkill}>
                  <Plus size={14} aria-hidden="true" />
                  {copy.newAction}
                </Button>
              )}
            </div>
          </div>

          {filtered.length === 0 && searching ? (
            <SettingsEmpty>{copy.searchEmpty}</SettingsEmpty>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 rounded-2xl border border-dashed border-border px-5 py-8 text-center">
              <strong className="text-sm leading-5 font-medium text-foreground">
                {copy.installedEmptyTitle}
              </strong>
              <p className="text-[13px] leading-[19px] text-muted-foreground">
                {copy.installedEmptyDescription}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" disabled={taskRunning} onClick={startNewSkill}>
                  <Plus size={14} aria-hidden="true" />
                  {copy.newSkill}
                </Button>
                <Button size="sm" variant="outline" disabled={taskRunning} onClick={startImport}>
                  <Download size={14} aria-hidden="true" />
                  {copy.importAction}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {groups.map((group) => (
                <SettingsGroup key={group.level} title={copy.levelLabels[group.level]}>
                  <SettingsCard>
                    {group.rows.map((row) => {
                      const key = skillWriteKey('skill', row.name)
                      return (
                        <SkillRow
                          key={row.name}
                          row={row}
                          source={
                            row.sourceName !== ''
                              ? row.sourceName
                              : (copy.providerLabels[row.source] ?? row.source)
                          }
                          busy={busyKey === key}
                          disabled={busy}
                          failure={failures[key] ?? null}
                          onToggle={(next) => void write('skill', row.name, next)}
                        />
                      )
                    })}
                  </SettingsCard>
                </SettingsGroup>
              ))}
              {/* The list is paged, so the section stays one page tall however many skills are
                  installed; the count in the toolbar already states the total. */}
              {pageCount > 1 ? (
                <nav className="flex items-center justify-center gap-3" aria-label={copy.pagerLabel}>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={currentPage <= 1}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    {copy.pagerPrevious}
                  </Button>
                  <span
                    className="text-xs leading-[18px] whitespace-nowrap text-muted-foreground"
                    role="status"
                    aria-live="polite"
                  >
                    {copy.pagerStatus(currentPage, pageCount)}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={currentPage >= pageCount}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    {copy.pagerNext}
                  </Button>
                </nav>
              ) : null}
            </>
          )}

          <SettingsGroup title={copy.engineTitle} description={copy.engineDescription}>
            <SettingsCard>
              <SettingsRow
                title={copy.masterTitle}
                description={copy.masterDescription}
                control={
                  <>
                    {busyKey === skillWriteKey('master', null) ? (
                      <span className="text-xs leading-[18px] text-muted-foreground" role="status">
                        {copy.writeBusy}
                      </span>
                    ) : null}
                    <Switch
                      checked={view.masterEnabled}
                      disabled={busy}
                      onCheckedChange={(next) => void write('master', null, next)}
                      ariaLabel={
                        view.masterEnabled
                          ? copy.toggleOff(copy.masterTitle)
                          : copy.toggleOn(copy.masterTitle)
                      }
                    />
                  </>
                }
              />
              <WriteFailure
                failure={failures[skillWriteKey('master', null)] ?? null}
                className="border-b border-border/60 px-5 py-2.5"
              />

              {view.sources.map((source) => {
                const key = skillWriteKey('source', source.id)
                const label = copy.sourceLabels[source.id] ?? source.label
                return (
                  <Fragment key={source.id}>
                    <SettingsRow
                      title={label}
                      description={source.label}
                      control={
                        <>
                          {busyKey === key ? (
                            <span
                              className="text-xs leading-[18px] text-muted-foreground"
                              role="status"
                            >
                              {copy.writeBusy}
                            </span>
                          ) : null}
                          <Switch
                            checked={source.enabled}
                            disabled={busy}
                            onCheckedChange={(next) => void write('source', source.id, next)}
                            ariaLabel={source.enabled ? copy.toggleOff(label) : copy.toggleOn(label)}
                          />
                        </>
                      }
                    />
                    <WriteFailure
                      failure={failures[key] ?? null}
                      className="border-b border-border/60 px-5 py-2.5"
                    />
                  </Fragment>
                )
              })}

              {view.ignoredPatterns.length === 0 ? null : (
                <SettingsRow
                  stack
                  title={copy.ignoredPatternsLabel}
                  control={<PatternChips patterns={view.ignoredPatterns} />}
                />
              )}
              {view.includedPatterns.length === 0 ? null : (
                <SettingsRow
                  stack
                  title={copy.includedPatternsLabel}
                  control={<PatternChips patterns={view.includedPatterns} />}
                />
              )}
            </SettingsCard>

            <p className="text-[13px] leading-[19px] text-muted-foreground">{copy.storageHint}</p>
            {view.masterEnabled || view.summary.total === 0 ? null : (
              <p className="text-[13px] leading-[19px] text-muted-foreground">{copy.masterOffHint}</p>
            )}
          </SettingsGroup>
        </>
      )}
    </>
  )
}

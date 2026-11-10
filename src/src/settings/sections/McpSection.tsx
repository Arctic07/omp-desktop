import { useCallback, useEffect, useState } from 'react'
import { Download, Plug, Plus, RefreshCw, Search } from 'lucide-react'

import type { EngineMcpError, EngineMcpServerRow } from '@/api/capabilities-types'
import type { ApiError } from '@/api/client'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Switch } from '@/components/motion/switch'
import { Tooltip } from '@/components/motion/tooltip'
import { useCopy } from '@/lib/i18n'
import {
  SettingsBadge,
  SettingsCard,
  SettingsEmpty,
  SettingsGroup,
  SettingsLoadState,
  SettingsPager,
  SettingsPath,
} from '@/settings/parts'
import McpServerEditor, {
  type McpDefinitionPayload,
  type McpRemovePayload,
} from '@/settings/sections/McpServerEditor'
import { MCP_COPY, statusOf, transportOf, type McpStatus } from '@/settings/sections/mcp-copy'
import { McpSourceImport } from '@/settings/sections/McpSourceImport'
import {
  mcpResource,
  readMcp,
  removeMcpDefinition,
  writeMcpDefinition,
  writeMcpEnabled,
} from '@/state/mcp-store'
import { ompImportStore } from '@/state/omp-import-store'
import { useResourceState } from '@/state/resource'
import { useStoreSelector } from '@/state/store'
import { WorkspaceScopeSelect } from '@/settings/WorkspaceScopeSelect'
import { useWorkspaceScope } from '@/settings/use-workspace-scope'

/**
 * The MCP page: what the engine found for this project, one switch per server, and the editor that
 * writes a definition.
 *
 * Every value here comes from the engine's own read (`mcpResource`, keyed by workspace, because MCP
 * discovery is per directory) and every write answers with the whole refreshed view, which is what
 * this page then renders. A server's state is two facts, never one: the definition file decides
 * `configuredEnabled`, the user's own lists decide `enabled` (with `override` naming which list did
 * it), and connection status is a third that only exists once a session has created the MCP manager.
 *
 * A definition is editable in place only where this application owns the file that holds it — the
 * host decides that per row (`writable` / `scope`) from the same rule its write path uses. A
 * definition another tool's file carries is listed, not rewritten: clicking it opens the editor as
 * a copy under a new suggested name, and saving writes a user-scope definition while the source
 * stays untouched. The import panel uses the same editor for the same reason.
 */

/** How many definitions one page of the installed list holds. */
const MCP_PAGE_SIZE = 8

/** The engine has not answered yet, as one array: a list without a value keeps its identity. */
const NO_SERVERS: readonly EngineMcpServerRow[] = []
const NO_PROBLEMS: readonly EngineMcpError[] = []

/** The badge a status reads as: the four tones the app draws statuses with. */
const STATUS_TONES: Record<McpStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  connected: 'success',
  connecting: 'warning',
  disconnected: 'danger',
  unknown: 'neutral',
}

/** The open editor: a definition being edited, or a new one (`row === null`). */
interface EditorSubject {
  row: EngineMcpServerRow | null
  /** True when the card was filled in from a definition another tool owns. */
  copied: boolean
}

/** Whether this application owns the file a definition lives in, which is what makes it editable. */
function owned(row: EngineMcpServerRow): boolean {
  return row.writable && row.scope !== null
}

/** A name for a copied definition that the list does not already hold. */
function copyName(name: string, taken: readonly string[]): string {
  const base = `${name}-local`
  let candidate = base
  let suffix = 2
  while (taken.includes(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

/**
 * One server: what it is, where it came from, and the switch the engine gates it by.
 *
 * `disabled` covers every row while one write is in flight: two switches writing the same setting
 * at once could each read the same previous value. The switch is the only busy signal; no
 * transient "saving" line is inserted beside it, so its own animation does not shift the row.
 * The row's own failed write is stated below, in this page's sentence plus the engine's code and
 * message.
 */
function ServerRow({
  row,
  live,
  failure,
  onToggle,
  onOpen,
}: {
  row: EngineMcpServerRow
  /** Whether a session has created the MCP manager yet, which is what a tool count needs. */
  live: boolean
  failure: ApiError | null
  onToggle: (next: boolean) => void
  onOpen: () => void
}) {
  const copy = useCopy(MCP_COPY)
  const editable = owned(row)
  const status = statusOf(row.status)
  /** A switched-off definition was never attempted, so it has no failure to report. */
  const off = !row.enabled
  const tone = off ? 'neutral' : STATUS_TONES[status]
  const statusLabel = off ? copy.disabledBadge : copy.statusLabels[status]
  const statusReason = off
    ? copy.disabledReason
    : (row.error ?? copy.statusReasons[status])
  // A server its file switches off, with no user-level list to explain it: the switch alone would
  // leave the reader guessing which side turned it off.
  const definitionOff = !row.configuredEnabled && row.override === 'none'

  const main = (
    <>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="truncate text-sm leading-5 font-medium text-foreground">{row.name}</span>
        <SettingsBadge>
          {editable
            ? row.scope === 'project'
              ? copy.scopeProject
              : copy.scopeUser
            : row.sourceProvider}
        </SettingsBadge>
        {definitionOff ? <SettingsBadge>{copy.definitionDisabled}</SettingsBadge> : null}
      </span>
      <span className="truncate text-[13px] leading-[19px] text-muted-foreground">
        {`${copy.transportLabels[transportOf(row.transport)]}${copy.countSeparator}${row.target}`}
      </span>
      {editable ? null : (
        <span className="text-xs leading-[18px] text-muted-foreground">
          {copy.foreignHint(row.sourceProvider)}
        </span>
      )}
      <span className="flex items-center gap-2">
        {/* The badge answers "is it up"; the tooltip answers "and if not, why", with the engine's
            own words when it recorded a failure and the state's own sentence when it did not. */}
        <Tooltip
          side="top"
          align="start"
          className="max-w-[320px]"
          content={
            <span className="block text-xs leading-[18px]">
              {statusReason}
            </span>
          }
        >
          <span className="inline-flex">
            <AnimatedBadge status={tone} size="sm" animated={false}>
              {statusLabel}
            </AnimatedBadge>
          </span>
        </Tooltip>
        {live ? (
          <span className="text-xs leading-[18px] text-muted-foreground">
            {copy.toolCount(row.toolCount)}
          </span>
        ) : null}
      </span>
    </>
  )

  return (
    <div className="flex flex-col border-b border-border/60 last:border-b-0">
      <div className="flex items-center gap-3 px-5 py-[15px]">
        <span className="grid size-8 flex-none place-items-center rounded-lg bg-muted text-muted-foreground">
          <Plug className="size-4" aria-hidden="true" />
        </span>

        <button
          type="button"
          aria-label={editable ? row.name : `${row.name}: ${copy.foreignHint(row.sourceProvider)}`}
          onClick={onOpen}
          className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {main}
        </button>

        <Switch
          checked={row.enabled}
          onCheckedChange={onToggle}
          ariaLabel={row.enabled ? copy.toggleOff(row.name) : copy.toggleOn(row.name)}
        />
      </div>

      {failure === null ? null : (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-1.5 px-5 pb-[15px] text-xs leading-[18px] text-destructive"
        >
          {copy.writeFailed}
          <SettingsBadge>{failure.code}</SettingsBadge>
          <span className="min-w-0 text-muted-foreground">{failure.message}</span>
        </p>
      )}
    </div>
  )
}

export default function McpSection({ active = true }: { active?: boolean }) {
  const copy = useCopy(MCP_COPY)
  const { workspaceId, target, setTarget } = useWorkspaceScope()
  const { status, error, value: view } = useResourceState(mcpResource)

  /** The search term; the list itself follows the workspace picker's scope. */
  /** The scope the rows were drawn in before the pick; while the new read runs they keep it. */
  const [listTarget, setListTarget] = useState(target)
  /** A picker change is reading the new directory; the old rows keep their own scope meanwhile. */
  const [switching, setSwitching] = useState(false)
  const [query, setQuery] = useState('')
  /** The list is paged the way the provider list is: a long catalogue is not one scrolling card. */
  const [page, setPage] = useState(1)
  /** The switch a write is in flight for, or ''; every other switch waits for it. */
  const [busyName, setBusyName] = useState('')
  const [failures, setFailures] = useState<Readonly<Record<string, ApiError>>>({})
  const [editor, setEditor] = useState<EditorSubject | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [definitionBusy, setDefinitionBusy] = useState<'save' | 'remove' | null>(null)
  const [definitionFailure, setDefinitionFailure] = useState<ApiError | null>(null)

  // The engine discovers MCP definitions per directory, so the list follows the workspace it
  // describes. It is also re-read whenever the section is shown: a plugin installed or removed
  // while the page was hidden changes the servers the engine discovers from that plugin's
  // directory, and this page holds the only view of them.
  useEffect(() => {
    if (!active) return
    void readMcp(workspaceId, true)
  }, [active, workspaceId])

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
    void readMcp(workspaceId).finally(() => {
      if (!live) return
      setListTarget(target)
      setSwitching(false)
    })
    return () => {
      live = false
    }
  }, [switching, target, workspaceId])

  const refresh = useCallback(() => {
    void readMcp(workspaceId, true)
  }, [workspaceId])

  // An import can add definitions (and connect them), so the list re-reads when one lands: the
  // rows' live status is the engine's answer, not something this page can predict.
  const imported = useStoreSelector(ompImportStore, (state) => state.result)
  useEffect(() => {
    if (imported === null) return
    refresh()
  }, [imported, refresh])

  /** Turn one switch. The answer is the engine's own view, so a refusal keeps the page as it was. */
  const toggle = useCallback(
    async (name: string, next: boolean) => {
      if (busyName !== '' || switching) return
      setBusyName(name)
      setFailures((current) => {
        if (current[name] === undefined) return current
        const rest = { ...current }
        delete rest[name]
        return rest
      })
      const failure = await writeMcpEnabled(workspaceId, name, next)
      if (failure !== null) setFailures((current) => ({ ...current, [name]: failure }))
      setBusyName('')
    },
    [busyName, switching, workspaceId],
  )

  /** Write one definition. Only a write that landed closes the editor; a refusal stays on screen. */
  const saveDefinition = useCallback(
    async (payload: McpDefinitionPayload) => {
      if (definitionBusy !== null) return
      setDefinitionBusy('save')
      setDefinitionFailure(null)
      const failure = await writeMcpDefinition(
        workspaceId,
        payload.name,
        payload.scope,
        payload.definition,
      )
      setDefinitionBusy(null)
      if (failure === null) {
        setEditor(null)
      } else {
        setDefinitionFailure(failure)
      }
    },
    [definitionBusy, workspaceId],
  )

  const removeDefinition = useCallback(
    async (payload: McpRemovePayload) => {
      if (definitionBusy !== null) return
      setDefinitionBusy('remove')
      setDefinitionFailure(null)
      const failure = await removeMcpDefinition(workspaceId, payload.name, payload.scope)
      setDefinitionBusy(null)
      if (failure === null) {
        setEditor(null)
      } else {
        setDefinitionFailure(failure)
      }
    },
    [definitionBusy, workspaceId],
  )

  const closeEditor = useCallback(() => {
    setEditor(null)
    setDefinitionFailure(null)
  }, [])

  const servers = view === null ? NO_SERVERS : view.servers
  const openEditor = useCallback(
    (row: EngineMcpServerRow | null, copied: boolean) => {
      // The rows still describe the old directory while a switch read is in flight. Opening an
      // editor then would prefill from them but write under the new workspace; refuse all entries.
      if (switching) return
      // One surface at a time: opening the editor closes the import panel it may have been started from.
      setImportOpen(false)
      setDefinitionFailure(null)
      const subject =
        copied && row !== null
          ? { ...row, name: copyName(row.name, servers.map((server) => server.name)) }
          : row
      setEditor({ row: subject, copied })
    },
    [servers, switching],
  )
  const problems = view === null ? NO_PROBLEMS : view.errors
  const term = query.trim().toLowerCase()
  // The machine-wide scope lists no workspace's project definitions; the host may still discover
  // them from its default directory, so they are dropped here rather than shown under `用户`.
  // The picker is the scope: the machine's user-level definitions, or the chosen workspace's
  // project definitions. A user-level server is active everywhere, but showing it under a
  // workspace would make two different workspaces look identical.
  const scoped = servers.filter((row) =>
    listTarget === 'user' ? row.level !== 'project' : row.level === 'project',
  )
  const visible = scoped.filter(
    (row) =>
      term.length === 0 ||
      row.name.toLowerCase().includes(term) ||
      row.target.toLowerCase().includes(term) ||
      row.sourceProvider.toLowerCase().includes(term),
  )
  // The page is clamped rather than reset: a filter that shortens the list, or a definition that
  // disappears under it, moves the reader to the last page that exists instead of an empty one.
  const pageCount = Math.max(1, Math.ceil(visible.length / MCP_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pageRows = visible.slice((currentPage - 1) * MCP_PAGE_SIZE, currentPage * MCP_PAGE_SIZE)
  const editorKey =
    editor === null
      ? ''
      : editor.row === null
        ? 'new'
        : `${editor.copied ? 'copy' : 'edit'}:${editor.row.name}`

  if (editor !== null) {
    return (
      <McpServerEditor
        key={editorKey}
        subject={editor.row}
        copied={editor.copied}
        busy={definitionBusy}
        failure={definitionFailure}
        onSave={(payload) => void saveDefinition(payload)}
        onRemove={(payload) => void removeDefinition(payload)}
        onCancel={closeEditor}
        defaultScope={listTarget === 'user' ? 'user' : 'project'}
      />
    )
  }

  return (
    <>
      {view === null || error !== null ? (
        <SettingsLoadState
          // A refresh in flight keeps the list on screen, so only a first read or a failure is drawn.
          status={view !== null && status === 'loading' ? 'ready' : status}
          error={error}
          loadingLabel={copy.loading}
          failedLabel={copy.loadFailed}
          retryLabel={copy.retry}
          onRetry={refresh}
        />
      ) : null}

      {view === null ? null : (
        <>
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
              {copy.mcpCount(scoped.length)}
            </span>
            <div className="ml-auto w-[240px]">
              <Input
                value={query}
                onChange={(next) => {
                  setQuery(next)
                  setPage(1)
                }}
                placeholder={copy.searchPlaceholder}
                aria-label={copy.searchLabel}
                leftIcon={<Search />}
                classNames={{ field: 'h-9 rounded-lg', input: 'text-sm' }}
              />
            </div>
          </div>

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[15px] leading-[22px] font-semibold text-foreground">
                {copy.installedTitle}{' '}
                <span className="font-normal text-muted-foreground">{scoped.length}</span>
              </h3>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  title={copy.sourceImportTitle}
                  onClick={() => setImportOpen(true)}
                >
                  <Download className="size-3.5" aria-hidden="true" />
                  {copy.importAction}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={copy.refresh}
                  title={copy.refresh}
                  disabled={status === 'loading'}
                  onClick={refresh}
                >
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={definitionBusy !== null}
                  onClick={() => openEditor(null, false)}
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                  {copy.newServer}
                </Button>
              </div>
            </div>

            {visible.length > 0 ? (
              <SettingsCard>
                {pageRows.map((row) => (
                  <ServerRow
                    key={row.name}
                    row={row}
                    live={view.live}
                    failure={failures[row.name] ?? null}
                    onToggle={(next) => void toggle(row.name, next)}
                    onOpen={() => openEditor(row, !owned(row))}
                  />
                ))}
              </SettingsCard>
            ) : term.length > 0 ? (
              <SettingsEmpty>{copy.searchEmpty}</SettingsEmpty>
            ) : (
              <div className="flex flex-col items-center gap-1.5 rounded-2xl border border-dashed border-border px-5 py-8 text-center">
                <strong className="text-sm leading-5 font-medium text-foreground">
                  {copy.emptyTitle}
                </strong>
                <p className="text-[13px] leading-[19px] text-muted-foreground">{copy.empty}</p>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={definitionBusy !== null}
                    onClick={() => openEditor(null, false)}
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    {copy.emptyNewServer}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    title={copy.sourceImportTitle}
                    onClick={() => setImportOpen(true)}
                  >
                    <Download className="size-3.5" aria-hidden="true" />
                    {copy.importAction}
                  </Button>
                </div>
              </div>
            )}

            <SettingsPager
              page={currentPage}
              pageCount={pageCount}
              total={visible.length}
              label={copy.pagerLabel}
              previous={copy.pagerPrevious}
              next={copy.pagerNext}
              status={copy.pagerStatus}
              totalLabel={copy.pagerTotal}
              onPage={setPage}
            />
          </section>

          {problems.length === 0 ? null : (
            <SettingsGroup title={copy.problemsTitle} description={copy.problemsDescription}>
              <SettingsCard>
                {problems.map((problem, index) => (
                  <div
                    key={`${problem.serverName ?? ''}:${problem.sourcePath ?? ''}:${index}`}
                    className="flex flex-col gap-1.5 border-b border-border/60 px-5 py-[15px] last:border-b-0"
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {problem.serverName === null ? null : (
                        <span className="text-sm leading-5 font-medium text-foreground">
                          {problem.serverName}
                        </span>
                      )}
                      {problem.sourcePath === null ? null : (
                        <SettingsPath>{problem.sourcePath}</SettingsPath>
                      )}
                    </span>
                    <span className="text-[13px] leading-[19px] text-muted-foreground">
                      {problem.message}
                    </span>
                  </div>
                ))}
              </SettingsCard>
            </SettingsGroup>
          )}

          <McpSourceImport
            open={importOpen}
            onClose={() => setImportOpen(false)}
            onImported={refresh}
          />
        </>
      )}
    </>
  )
}

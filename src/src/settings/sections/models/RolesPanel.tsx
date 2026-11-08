import { ExternalLink } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { toApiError, type ApiError } from '@/api/client'
import type { EngineModel, ModelRoleRow } from '@/api/types'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/motion/select'
import { TextShimmer } from '@/components/motion/text-shimmer'
import { useCopy } from '@/lib/i18n'
import { SettingsBadge, SettingsCard, SettingsEmpty, SettingsGroup } from '@/settings/parts'
import { MODELS_COPY, type ModelsCopy } from '@/settings/sections/models/copy'
import { WriteNotice } from '@/settings/sections/models/panel-state'
import {
  assignRole,
  isModelOffered,
  modelSelector,
  modelStore,
  providerLabel,
  providerNameIndex,
  roleCandidates,
} from '@/state/model-store'
import { useStoreSelector } from '@/state/store'

/**
 * The engine's model roles: what each one resolves to, and the two controls that write it.
 *
 * The table is the engine's own — its roles, its sections, its tags — and every write answers with
 * the table the engine now reports, so a row always shows what the engine holds rather than what
 * was typed here. Candidates are read per role, when that row's picker opens: the engine narrows
 * them by role, and asking for every row's pool on arrival is work nobody asked for.
 */

const DOCS_URL = 'https://omp.sh/docs'

/**
 * The model picker's value for handing the role back to the engine. It is written with no model at
 * all, and no candidate selector is spelled this way, so the two can never be confused.
 */
const ENGINE_DEFAULT_CHOICE = 'engine-default'

/**
 * The role this application always pins.
 *
 * `default` is the model a new conversation starts on and the one the composer names before any
 * session has reported a model of its own, so it is the one role whose resolution is not offered back
 * to the engine: clearing it leaves the next conversation starting on a model this app cannot name.
 */
const DEFAULT_ROLE_ID = 'default'

/** A level the engine reports but this build has no word for keeps the engine's own spelling. */
function levelLabel(copy: ModelsCopy, level: string): string {
  return copy.thinkingLevelLabels[level] ?? level
}

/** One role: its name and tag on the left, the model and thinking selectors on the right. */
function RoleFactRow({
  title,
  badge,
  extra,
  description,
  control,
}: {
  title: string
  /** The engine's short tag for the role, where it has one. */
  badge?: string
  /** The row's own state badge, beside the tag. */
  extra?: ReactNode
  description?: ReactNode
  control?: ReactNode
}) {
  return (
    <div className="flex min-h-[70px] flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-[15px] last:border-b-0">
      {/* The clip belongs to the copy column, not to the row: it is what keeps the status chip's
          layout projection inside the column the chip is in, and the row's other column carries the
          pickers — whose panels are drawn in flow rather than portalled, so a clip on the row would
          cut them off at the row's own edge. */}
      <div className="flex min-w-0 flex-1 flex-col gap-[3px] overflow-hidden">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm leading-5 font-medium text-foreground">{title}</span>
          {badge === undefined ? null : <SettingsBadge>{badge}</SettingsBadge>}
          {extra}
        </span>
        {description === undefined ? null : (
          <span className="text-[13px] leading-[19px] text-muted-foreground">{description}</span>
        )}
      </div>
      {control === undefined ? null : (
        <div className="flex max-w-full flex-wrap items-center justify-end gap-2">{control}</div>
      )}
    </div>
  )
}

/**
 * The engine's candidates as its own providers, in the order the engine listed them.
 *
 * The picker states a provider once and lists its models under it: the engine keys a provider by a
 * generated id, so writing the selector on every row spells `custom-ba937c28/gpt-5.6-luna` and
 * `custom-ba937c28/gpt-6-luna` — a column of keys that says nothing about which provider a model
 * belongs to, which is the one thing the list is being read for.
 */
function byProvider(models: readonly EngineModel[]): Array<[string, EngineModel[]]> {
  const groups = new Map<string, EngineModel[]>()
  for (const model of models) {
    const bucket = groups.get(model.provider)
    if (bucket === undefined) {
      groups.set(model.provider, [model])
    } else {
      bucket.push(model)
    }
  }
  return [...groups]
}

/**
 * One role: what it resolves to, the picker that assigns it, and the level pinned to that model.
 *
 * A role the engine resolved to a provider this application does not offer reads as unresolved
 * rather than naming a model the reader cannot pick, cannot see in the catalogue and would not
 * recognise in the picker: the resolution is still the engine's, and the row says so by offering the
 * pick that replaces it.
 */
function RoleRow({
  role,
  catalogue,
  names,
}: {
  role: ModelRoleRow
  /** The engine's whole catalogue, where a model's own effort levels are read from. */
  catalogue: readonly EngineModel[]
  /** What each provider is called, so a row names one rather than printing its key. */
  names: ReadonlyMap<string, string>
}) {
  const copy = useCopy(MODELS_COPY)
  const [modelOpen, setModelOpen] = useState(false)
  const [candidates, setCandidates] = useState<readonly EngineModel[] | null>(null)
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [candidatesFailure, setCandidatesFailure] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ApiError | null>(null)

  const resolved = role.model !== null && isModelOffered(role.model) ? role.model : null
  /** The engine's own selector, which is what the picker writes and what a level is pinned to. */
  const current = resolved === null ? null : `${resolved.provider}/${resolved.id}`
  /** The same model as the row writes it: the provider by name, the model by the id it is keyed by. */
  const currentLabel =
    resolved === null ? null : `${providerLabel(names, resolved.provider)}/${resolved.id}`
  const pinned = resolved === null ? null : role.thinkingLevel
  const catalogueModel =
    catalogue.find(
      (model) => model.provider === resolved?.provider && model.id === resolved?.id,
    ) ?? null
  /** `null` while the catalogue does not carry this model, so nothing can be said about its levels. */
  const levels = catalogueModel === null ? null : catalogueModel.thinkingLevels
  const levelsOffered = levels ?? []
  /** The pinned level is offered too when the catalogue does not list it, or its word is lost. */
  const levelItems =
    pinned === null || levelsOffered.includes(pinned) ? levelsOffered : [...levelsOffered, pinned]

  async function loadCandidates(): Promise<void> {
    if (candidates !== null || loadingCandidates) {
      return
    }
    setLoadingCandidates(true)
    setCandidatesFailure(null)
    try {
      setCandidates(await roleCandidates(role.id))
    } catch (error) {
      setCandidatesFailure(toApiError(error))
    } finally {
      setLoadingCandidates(false)
    }
  }

  /** One write at a time: the row's own controls stay put while the engine answers. */
  async function write(selector: string | null): Promise<void> {
    if (busy) {
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      await assignRole(role.id, selector)
    } catch (error) {
      setFailure(toApiError(error))
    } finally {
      setBusy(false)
    }
  }

  /**
   * A level belongs to the model it was pinned to, so it only survives a switch the newly picked
   * model can run — anything else would pin a strength the engine refuses.
   */
  function changeModel(selector: string): void {
    if (selector === ENGINE_DEFAULT_CHOICE) {
      void write(null)
      return
    }
    const picked = candidates?.find((model) => modelSelector(model) === selector) ?? null
    if (pinned !== null && picked !== null && picked.thinkingLevels.includes(pinned)) {
      void write(`${selector}:${pinned}`)
      return
    }
    void write(selector)
  }

  /** `''` is the choice that writes no level at all, leaving the strength to the engine. */
  function changeLevel(level: string): void {
    if (current === null) {
      return
    }
    void write(level === '' ? current : `${current}:${level}`)
  }

  /**
   * A role the workspace's own configuration overrides. Said on the row it applies to, because it is
   * a fact about that one row — the note about the `default` role is about the group, and is drawn
   * under it.
   */
  const overrideNote = role.source === 'project' ? copy.projectOverrideNote : null
  /** The level control is inert without a model to pin a level to, or with no level to offer. */
  /**
   * The level control is inert without a model to pin a level to, or with no level to offer.
   *
   * A role resolving to nothing this app offers gets no hint either: the row says what it is (the
   * engine's role) and offers the picker that replaces the resolution, and a line telling the reader
   * to choose a model under a field that is already a picker says it twice.
   */
  const levelLocked = resolved === null || (levels !== null && levels.length === 0)
  const levelHint =
    resolved === null || levels === null || levels.length > 0 ? null : copy.levelUnavailableLabel
  /**
   * A row is its name and its controls. The model itself needs no second line under the name: the
   * picker beside it already states the model, so a `provider/model:level` line repeated the same
   * fact in a key nobody reads and pushed the row onto two lines. Only something the controls cannot
   * say — a workspace override, an inert level, a write in flight or a failure — is written below.
   */
  const hasNote =
    overrideNote !== null ||
    levelHint !== null ||
    busy ||
    failure !== null ||
    candidatesFailure !== null

  return (
    <RoleFactRow
      title={role.name}
      badge={role.tag ?? undefined}
      extra={
        /* Static, like the role's own tag beside it: a chip that rolled its label and slid to its
           new place whenever the row was written read as the row moving rather than as a state. */
        <AnimatedBadge status={role.configured ? 'info' : 'neutral'} size="sm" animated={false}>
          {role.configured ? copy.rolesConfiguredLabel : copy.rolesAutoLabel}
        </AnimatedBadge>
      }
      description={
        hasNote ? (
          <>
            {overrideNote === null ? null : <span className="block">{overrideNote}</span>}
            {levelHint === null ? null : <span className="block">{levelHint}</span>}
            {busy ? (
              <span className="block">
                <TextShimmer>{copy.busyLabel}</TextShimmer>
              </span>
            ) : null}
            {failure === null ? null : (
              <WriteNotice text={copy.assignFailed(role.name)} error={failure} />
            )}
            {candidatesFailure === null ? null : (
              <WriteNotice text={copy.candidatesFailedLabel} error={candidatesFailure} />
            )}
          </>
        ) : undefined
      }
      control={
        <>
          <Select
            value={current ?? ''}
            open={modelOpen}
            onOpenChange={(open) => {
              setModelOpen(open)
              if (open) {
                void loadCandidates()
              }
            }}
            onValueChange={changeModel}
            disabled={busy}
            className="w-[248px] shrink-0"
          >
            {/* The trigger states the model itself: candidates arrive only once the picker opens,
                so no option has registered a label to show here yet. A role resolving to nothing
                this app offers leaves it empty rather than spelling a placeholder the reader has
                already been told about by the picker's own chevron. */}
            <SelectTrigger className="w-full" aria-label={copy.editRole(role.name)}>
              {currentLabel === null ? null : (
                <span className="min-w-0 truncate">{currentLabel}</span>
              )}
            </SelectTrigger>
            <SelectContent className="w-full">
              {/* A role the engine offers many models for would otherwise run the panel past the
                  bottom of the window: the list is capped and scrolls inside itself. */}
              <div className="flex max-h-[280px] flex-col overflow-y-auto overscroll-contain">
                {role.id === DEFAULT_ROLE_ID ? null : (
                  <SelectItem value={ENGINE_DEFAULT_CHOICE}>{copy.roleDefaultChoice}</SelectItem>
                )}
                {loadingCandidates ? (
                  <p className="px-2.5 py-1.5 text-xs leading-[18px] text-muted-foreground">
                    {copy.loadingLabel}
                  </p>
                ) : null}
                {candidates !== null && candidates.length === 0 ? (
                  <p className="px-2.5 py-1.5 text-xs leading-[18px] text-muted-foreground">
                    {copy.candidatesEmptyLabel}
                  </p>
                ) : null}
                {byProvider(candidates ?? []).map(([provider, models]) => (
                  <div key={provider} role="group" aria-label={providerLabel(names, provider)}>
                    {/* Stated once for the models under it; the group carries the same words for a
                        reader who cannot see the heading. */}
                    <p
                      aria-hidden="true"
                      className="px-2.5 pt-2 pb-1 text-[11px] leading-4 font-medium text-muted-foreground"
                    >
                      {providerLabel(names, provider)}
                    </p>
                    {models.map((candidate) => {
                      const selector = modelSelector(candidate)
                      return (
                        <SelectItem key={selector} value={selector}>
                          {candidate.id}
                        </SelectItem>
                      )
                    })}
                  </div>
                ))}
              </div>
            </SelectContent>
          </Select>

          <Select
            value={pinned ?? ''}
            onValueChange={changeLevel}
            disabled={busy || levelLocked}
            className="w-[248px] shrink-0"
          >
            <SelectTrigger
              className="h-8 w-full min-w-0 gap-1 rounded-xl px-2 py-0 text-xs"
              aria-label={copy.thinkingStrengthLabel}
            >
              <span className="min-w-0 shrink-0 truncate text-muted-foreground">
                {copy.thinkingStrengthLabel}
              </span>
              <SelectValue className="min-w-0 truncate" />
            </SelectTrigger>
            <SelectContent className="w-full">
              <SelectItem value="">{copy.levelNoneLabel}</SelectItem>
              {levelItems.map((level) => (
                <SelectItem key={level} value={level}>
                  {levelLabel(copy, level)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      }
    />
  )
}

/** One block of the table: one row per role the engine reported for that section. */
function RoleTable({
  roles,
  catalogue,
  names,
}: {
  roles: readonly ModelRoleRow[]
  catalogue: readonly EngineModel[]
  names: ReadonlyMap<string, string>
}) {
  return (
    <SettingsCard>
      {roles.map((role) => (
        <RoleRow key={role.id} role={role} catalogue={catalogue} names={names} />
      ))}
    </SettingsCard>
  )
}

export default function RolesPanel() {
  const copy = useCopy(MODELS_COPY)
  const roles = useStoreSelector(modelStore, (state) => state.roles)
  const catalogue = useStoreSelector(modelStore, (state) => state.models)
  const providers = useStoreSelector(modelStore, (state) => state.providers)
  const status = useStoreSelector(modelStore, (state) => state.status)
  /** One index for the whole table: every row names its provider out of the same map. */
  const names = useMemo(() => providerNameIndex(providers), [providers])
  /** The engine's own split, in its own order; a section it reported nothing for is left out. */
  const chat = roles.filter((role) => role.section === 'chat')
  const kind = roles.filter((role) => role.section === 'kind')

  return (
    <>
      <div className="flex flex-col gap-2">
        <p className="max-w-[620px] text-[13px] leading-[19px] text-muted-foreground">
          {copy.rolesLead}
        </p>
        <a
          className="inline-flex w-fit items-center gap-1.5 text-[13px] leading-[19px] font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
        >
          {copy.docsLabel}
          <ExternalLink aria-hidden="true" size={14} />
        </a>
      </div>

      {chat.length === 0 ? null : (
        <SettingsGroup title={copy.chatGroupTitle}>
          <RoleTable roles={chat} catalogue={catalogue} names={names} />
          {/* The note belongs to the group rather than to the `default` row: it says what the role
              does for every conversation this app starts, which is a fact about the table. */}
          <p className="max-w-[620px] text-[13px] leading-[19px] text-muted-foreground">
            {copy.defaultRoleNote}
          </p>
        </SettingsGroup>
      )}

      {kind.length === 0 ? null : (
        <SettingsGroup title={copy.kindGroupTitle}>
          <RoleTable roles={kind} catalogue={catalogue} names={names} />
        </SettingsGroup>
      )}

      {roles.length === 0 && status === 'ready' ? (
        <SettingsCard>
          <SettingsEmpty>{copy.rolesEmptyLabel}</SettingsEmpty>
        </SettingsCard>
      ) : null}
    </>
  )
}

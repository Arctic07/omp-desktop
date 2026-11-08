import { Bot, ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'

import { toApiError, type ApiError } from '@/api/client'
import type { EngineModel, ProviderSummary } from '@/api/types'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { useCopy } from '@/lib/i18n'
import { SettingsCard, SettingsEmpty, SettingsPager, SettingsPath } from '@/settings/parts'
import { MODELS_COPY, type ModelsCopy } from '@/settings/sections/models/copy'
import { KeyPoolSection } from '@/settings/sections/models/KeyPoolSection'
import { WriteNotice } from '@/settings/sections/models/panel-state'
import { applyProviderKeys, clearProviderKey, modelStore } from '@/state/model-store'
import { useStoreSelector } from '@/state/store'

/**
 * The engine's own providers: the catalogue each one brings, and where its key is entered.
 *
 * The list, the keys and the models are all the engine's answers — a save or a clear writes the
 * keyring and then re-reads the provider list, so a row shows what the host reports rather than what
 * was typed here. The write's own answer decides what the row says about the key taking effect.
 */

/** One provider with the models the engine's catalogue reports for it. */
interface ProviderEntryData {
  provider: ProviderSummary
  models: readonly EngineModel[]
}

/** What the row says about the last write: the engine answered, or it refused. */
interface ProviderOutcome {
  action: 'save' | 'clear'
  live: boolean
  failure: ApiError | null
}

const PAGE_SIZE = 8

/** The engine's own numbers, as short as a row can carry them (`formatTokenShort` in the desktop). */
function tokenShort(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null
  }
  const compact = (scaled: number): string => {
    const rounded = Math.round(scaled * 10) / 10
    return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1)
  }
  if (value >= 1_000_000) {
    return `${compact(value / 1_000_000)}M`
  }
  if (value >= 1_000) {
    return `${compact(value / 1_000)}K`
  }
  return `${Math.trunc(value)}`
}

/** The three facts the engine reports for a model, as one muted line. */
function modelMeta(model: EngineModel, copy: ModelsCopy): string {
  const facts: string[] = []
  const context = tokenShort(model.contextWindow)
  if (context !== null) {
    facts.push(`${copy.modelContextShort} ${context}`)
  }
  const output = tokenShort(model.maxTokens)
  if (output !== null) {
    facts.push(`${copy.modelOutputShort} ${output}`)
  }
  // Only the positive is listed: a row says what the model is good for, and Rust maps a field the
  // engine never reported to `false`, so writing the negative would claim more than the catalogue does.
  if (model.supportsImages) {
    facts.push(copy.modelImagesShort)
  }
  return facts.join(' · ')
}

/** The models the catalogue offers for one provider, read-only and height-bounded like Vue. */
function ModelCatalog({ models }: { models: readonly EngineModel[] }) {
  const copy = useCopy(MODELS_COPY)

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] leading-[19px] font-medium text-foreground">
          {copy.providerModelsTitle}
        </span>
        <span className="text-xs leading-[18px] text-muted-foreground">
          {`${models.length} ${copy.modelsLabel}`}
        </span>
      </div>
      {models.length === 0 ? (
        <p className="text-[13px] leading-[19px] text-muted-foreground">{copy.providerModelsEmpty}</p>
      ) : (
        <ul className="flex max-h-[264px] flex-col gap-0.5 overflow-y-auto">
          {models.map((model) => {
            const meta = modelMeta(model, copy)
            return (
              <li
                key={model.id}
                className="flex min-h-[30px] items-center justify-between gap-2 rounded-md px-2 py-0.5 transition-colors hover:bg-muted"
              >
                <span className="flex min-w-0 flex-col gap-px">
                  <span className="truncate text-[13px] leading-[19px] font-medium text-foreground">
                    {model.name || model.id}
                  </span>
                  <span className="truncate font-mono text-xs leading-[18px] text-muted-foreground">
                    {model.id}
                  </span>
                </span>
                {meta === '' ? null : (
                  <span className="max-w-[45%] flex-none truncate text-xs leading-[18px] text-muted-foreground">
                    {meta}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** What the row says about one write, and whether it reads as a refusal. */
function outcomeNotice(outcome: ProviderOutcome, copy: ModelsCopy): string {
  if (outcome.failure !== null) {
    return outcome.action === 'save' ? copy.keySaveFailed : copy.keyClearFailed
  }
  if (outcome.action === 'clear') {
    return copy.keyCleared
  }
  // The key clause answers the one question the user has ("did it take effect?"): a write the
  // running engine host accepted is live now, and one no process could be told takes effect at the
  // next start.
  return `${copy.keySaved} · ${outcome.live ? copy.keyLive : copy.keyRestartRequired}`
}

interface ProviderBodyProps {
  entry: ProviderEntryData
  apiKeyDrafts: string[]
  savedMasks: readonly string[]
  removedKeys: readonly number[]
  onApiKeyChange: (index: number, value: string) => void
  onAddKey: () => void
  onRemoveKey: (index: number) => void
  onRemoveSaved: (index: number) => void
  onSave: () => void
  onClear: () => void
  busy: boolean
  outcome: ProviderOutcome | null
}

/** The expanded row body: the key pool first, then the provider's own catalogue. */
function ProviderBody({
  entry,
  apiKeyDrafts,
  savedMasks,
  removedKeys,
  onApiKeyChange,
  onAddKey,
  onRemoveKey,
  onRemoveSaved,
  onSave,
  onClear,
  busy,
  outcome,
}: ProviderBodyProps) {
  const copy = useCopy(MODELS_COPY)
  const { provider, models } = entry
  /** Providers without a known environment variable can only be configured outside the app. */
  const keyEditable = provider.apiKeyEnv !== ''
  const edited = removedKeys.length > 0 || apiKeyDrafts.some((draft) => draft.trim() !== '')

  return (
    <div className="flex flex-col gap-3.5 border-t border-border/60 px-4 pb-4 pt-3">
      {keyEditable ? (
        <KeyPoolSection
          label={copy.apiKeyLabel}
          hint={copy.customKeysHint}
          savedMasks={savedMasks}
          removedKeys={removedKeys}
          drafts={apiKeyDrafts}
          busy={busy}
          onRemoveSaved={onRemoveSaved}
          onDraftChange={onApiKeyChange}
          onAddDraft={onAddKey}
          onRemoveDraft={onRemoveKey}
          footer={
            <>
              <span className="flex flex-wrap items-center gap-2 text-xs leading-[18px] text-muted-foreground">
                {copy.apiKeyEnvLabel}
                <SettingsPath>{provider.apiKeyEnv}</SettingsPath>
              </span>

              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !provider.configured}
                  onClick={onClear}
                >
                  {copy.clearKey}
                </Button>
                <Button size="sm" disabled={busy || !edited} onClick={onSave}>
                  {busy ? copy.savingKey : copy.saveKey}
                </Button>
              </div>
            </>
          }
        />
      ) : (
        <p className="text-[13px] leading-[19px] text-muted-foreground">{copy.providerNoKeyForm}</p>
      )}

      {outcome === null ? null : (
        <WriteNotice text={outcomeNotice(outcome, copy)} error={outcome.failure} />
      )}

      <ModelCatalog models={models} />
    </div>
  )
}

/** One provider row: what the engine reports about it, and the key form it opens. */
function ProviderEntry({
  entry,
  expanded,
  onToggle,
}: {
  entry: ProviderEntryData
  expanded: boolean
  onToggle: () => void
}) {
  const copy = useCopy(MODELS_COPY)
  const { provider, models } = entry
  /** The typed keys never leave this component except through the call that stores them. */
  // No empty row when keys are already saved; the masked rows are the list.
  const [apiKeyDrafts, setApiKeyDrafts] = useState<string[]>(() =>
    provider.apiKeyMasks.length > 0 ? [] : [''],
  )
  /** Saved rows the reader marked for removal, by their position in `apiKeyMasks`. */
  const [removedKeys, setRemovedKeys] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<ProviderOutcome | null>(null)

  async function save(): Promise<void> {
    const keys = apiKeyDrafts.map((draft) => draft.trim()).filter((key) => key !== '')
    if (busy || (keys.length === 0 && removedKeys.length === 0)) {
      return
    }
    setBusy(true)
    setOutcome(null)
    try {
      const live = await applyProviderKeys(provider.id, removedKeys, keys)
      setApiKeyDrafts([])
      setRemovedKeys([])
      setOutcome({ action: 'save', live, failure: null })
    } catch (error) {
      setOutcome({ action: 'save', live: false, failure: toApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function clear(): Promise<void> {
    if (busy) {
      return
    }
    setBusy(true)
    setOutcome(null)
    try {
      await clearProviderKey(provider.id)
      setApiKeyDrafts([])
      setRemovedKeys([])
      setOutcome({ action: 'clear', live: false, failure: null })
    } catch (error) {
      setOutcome({ action: 'clear', live: false, failure: toApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="flex min-h-[58px] min-w-0 items-center gap-3 px-4 py-2.5">
        <Bot className="size-[17px] flex-none text-muted-foreground" aria-hidden="true" />
        <strong className="min-w-0 flex-1 truncate text-[13px] leading-[19px] font-medium text-foreground">
          {provider.name}
        </strong>
        <div className="flex flex-none flex-wrap items-center justify-end gap-2.5">
          {models.length > 0 ? (
            <span className="text-xs leading-[18px] whitespace-nowrap text-muted-foreground">
              {`${models.length} ${copy.modelsLabel}`}
            </span>
          ) : null}
          <AnimatedBadge animated={false} status={provider.configured ? 'info' : 'neutral'} size="sm">
            {provider.configured ? copy.providerConfiguredLabel : copy.providerNotConfiguredLabel}
          </AnimatedBadge>
          {provider.authenticated ? (
            <AnimatedBadge animated={false} status="success" size="sm">
              {copy.authenticatedLabel}
            </AnimatedBadge>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            aria-expanded={expanded}
            aria-label={copy.providerToggleLabel(provider.name, expanded)}
            onClick={onToggle}
          >
            {expanded ? copy.hideKeyEditor : copy.configureKey}
            <ChevronDown
              className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'}
              size={14}
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>
      {expanded ? (
        <ProviderBody
          entry={entry}
          apiKeyDrafts={apiKeyDrafts}
          savedMasks={provider.apiKeyMasks}
          removedKeys={removedKeys}
          onApiKeyChange={(index, value) =>
            setApiKeyDrafts((current) =>
              current.map((draft, position) => (position === index ? value : draft)),
            )
          }
          onAddKey={() => setApiKeyDrafts((current) => [...current, ''])}
          onRemoveKey={(index) =>
            setApiKeyDrafts((current) =>
              current.filter((_, position) => position !== index),
            )
          }
          onRemoveSaved={(index) =>
            setRemovedKeys((current) => (current.includes(index) ? current : [...current, index]))
          }
          onSave={() => void save()}
          onClear={() => void clear()}
          busy={busy}
          outcome={outcome}
        />
      ) : null}
    </div>
  )
}

export default function ProvidersPanel() {
  const copy = useCopy(MODELS_COPY)
  const providers = useStoreSelector(modelStore, (state) => state.providers)
  const models = useStoreSelector(modelStore, (state) => state.models)
  const status = useStoreSelector(modelStore, (state) => state.status)
  /** Vue starts with every row closed; only one provider can be expanded at a time. */
  const [openProviderId, setOpenProviderId] = useState('')
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(1)

  const entries = useMemo(
    () =>
      providers.map(
        (provider): ProviderEntryData => ({
          provider,
          models: models.filter((model) => model.provider === provider.id),
        }),
      ),
    [providers, models],
  )

  const query = filter.trim().toLowerCase()
  const rows = useMemo(
    () =>
      query === ''
        ? entries
        : entries.filter((entry) =>
            [
              entry.provider.id,
              entry.provider.name,
              entry.provider.apiKeyEnv,
              ...entry.models.flatMap((model) => [model.id, model.name]),
            ].some((fact) => fact.toLowerCase().includes(query)),
          ),
    [entries, query],
  )

  // The page is clamped rather than reset: a filter that shortens the list, or a provider list that
  // shrinks under it, moves the reader to the last page that exists instead of an empty one.
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pageRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  return (
    <>
      <p className="max-w-[620px] text-[13px] leading-[19px] text-muted-foreground">
        {copy.providersLead}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[220px] flex-1"
          value={filter}
          onChange={(value) => {
            setFilter(value)
            setPage(1)
          }}
          placeholder={copy.providerFilterPlaceholder}
          aria-label={copy.providerFilterLabel}
        />
      </div>

      <SettingsCard>
        {entries.length === 0 && status === 'ready' ? (
          <SettingsEmpty>{copy.providersEmpty}</SettingsEmpty>
        ) : rows.length === 0 ? (
          <p className="px-5 py-4 text-[13px] leading-[19px] text-muted-foreground">
            {copy.providersNoMatch}
          </p>
        ) : (
          pageRows.map((entry) => (
            <ProviderEntry
              key={entry.provider.id}
              entry={entry}
              expanded={entry.provider.id === openProviderId}
              onToggle={() =>
                setOpenProviderId((current) =>
                  current === entry.provider.id ? '' : entry.provider.id,
                )
              }
            />
          ))
        )}
      </SettingsCard>

      <SettingsPager
        page={currentPage}
        pageCount={pageCount}
        total={rows.length}
        label={copy.pagerLabel}
        previous={copy.pagerPrevious}
        next={copy.pagerNext}
        status={copy.pagerStatus}
        totalLabel={copy.pagerTotal}
        onPage={setPage}
      />
    </>
  )
}

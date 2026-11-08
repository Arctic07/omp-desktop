import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { toApiError } from '@/api/client'
import { CUSTOM_PROVIDER_APIS, type CustomProvider } from '@/api/types'
import { Button } from '@/components/motion/button'
import { Checkbox } from '@/components/motion/checkbox'
import { Input } from '@/components/motion/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/motion/select'
import { useCopy } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { MODELS_COPY, type ModelsCopy } from '@/settings/sections/models/copy'
import {
  draftFrom,
  emptyModelDraft,
  isHttpUrl,
  isEmptyModel,
  mergeFetched,
  providerIdFor,
  toInput,
  validateDraft,
  type DraftProblem,
  type ModelDraft,
} from '@/settings/sections/models/custom-draft'
import { KeyPoolSection } from '@/settings/sections/models/KeyPoolSection'
import { WriteNotice, type WriteOutcome } from '@/settings/sections/models/panel-state'
import {
  applyProviderKeys,
  clearProviderKey,
  fetchCustomModels,
  saveCustomProvider,
} from '@/state/model-store'

/**
 * The editor for one custom provider: the fixed fields, the key, and the model list under them.
 *
 * The key is stored before the provider is written, because `models.yml` renders its `auth:` value
 * from the keyring — the other order would leave the provider reading as `auth: none` and every
 * call 401. The draft's own checks run first, so the engine is only asked for drafts it can write.
 */

export interface EditorNotice extends WriteOutcome {
  /** The write landed, so the panel closes the editor it belongs to. */
  saved: boolean
}

interface CustomEditorProps {
  /** `null` starts a new provider; an existing one is edited in place. */
  provider: CustomProvider | null
  /** The ids already in use, so a generated one does not overwrite another provider. */
  takenIds?: readonly string[]
  onCancel: () => void
  onDone: (notice: EditorNotice) => void
  /** Lets the panel guard its own controls while this editor writes. */
  onBusyChange: (busy: boolean) => void
}

function problemText(problem: DraftProblem, copy: ModelsCopy): string {
  switch (problem) {
    case 'id':
      return copy.customErrorIdInvalid
    case 'name':
      return copy.customErrorNameRequired
    case 'base-url':
      return copy.customErrorBaseUrlInvalid
    case 'model-id':
      return copy.customErrorModelIdRequired
    case 'model-id-duplicate':
      return copy.customErrorModelIdDuplicate
  }
}

/** The model list of the editor: the hand-filled metadata, and one row's own expander. */
function ModelRows({
  models,
  busy,
  fetching,
  fetchOutcome,
  onFetch,
  onChange,
}: {
  models: readonly ModelDraft[]
  busy: boolean
  fetching: boolean
  fetchOutcome: WriteOutcome | null
  onFetch: () => void
  onChange: (models: ModelDraft[]) => void
}) {
  const copy = useCopy(MODELS_COPY)
  const [expanded, setExpanded] = useState<readonly number[]>([])

  const replace = (index: number, model: ModelDraft): void =>
    onChange(models.map((current, position) => (position === index ? model : current)))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-[3px]">
          <h4 className="text-[13px] leading-[19px] font-semibold text-foreground">
            {copy.customModelsTitle}
          </h4>
          <p className="max-w-[520px] text-[13px] leading-[19px] text-muted-foreground">
            {copy.customModelsHint}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Button size="sm" variant="secondary" disabled={busy || fetching} onClick={onFetch}>
            {fetching ? copy.customFetching : copy.customFetchModels}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onChange([...models, emptyModelDraft()])}
          >
            <Plus size={14} />
            {copy.customAddModel}
          </Button>
        </div>
      </div>

      {fetchOutcome === null ? null : <WriteNotice {...fetchOutcome} />}

      {models.length === 0 ? (
        <p className="text-[13px] leading-[19px] text-muted-foreground">{copy.modelsEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {models.map((model, index) => {
            const open = expanded.includes(index)
            return (
              <li key={index} className="rounded-xl border border-border/60 bg-background">
                {/* One column template for both rows: two flexible fields plus the two 2rem icon
                    buttons. The expanded row leaves the last two cells empty but they still hold
                    their width, so 上下文长度 / 最大输出 line up with the fields above instead of
                    taking the buttons' room (2026-10-17). */}
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem_2rem] items-end gap-2 px-3 py-3">
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-xs leading-[18px] text-muted-foreground">
                      {copy.customModelIdLabel}
                    </span>
                    <Input
                      value={model.id}
                      disabled={busy}
                      placeholder="model-id"
                      onChange={(id) => replace(index, { ...model, id })}
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-xs leading-[18px] text-muted-foreground">
                      {copy.customModelNameLabel}
                    </span>
                    <Input
                      value={model.name}
                      disabled={busy}
                      onChange={(name) => replace(index, { ...model, name })}
                    />
                  </label>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={busy}
                    aria-expanded={open}
                    aria-label={open ? copy.collapseModel : copy.expandModel}
                    onClick={() =>
                      setExpanded((current) =>
                        open ? current.filter((entry) => entry !== index) : [...current, index],
                      )
                    }
                  >
                    <ChevronDown
                      className={cn('transition-transform', open && 'rotate-180')}
                      size={16}
                    />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={busy}
                    aria-label={copy.customRemoveModel}
                    onClick={() => {
                      setExpanded((current) => current.filter((entry) => entry !== index))
                      onChange(models.filter((_, position) => position !== index))
                    }}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>

                {open ? (
                  <div className="flex flex-col gap-3 border-t border-border/60 px-3 py-3">
                    {/* The same column template as the row above, so these two fields end exactly
                        where the model-id / display-name fields do. The two trailing cells stay
                        empty: the icon buttons live on the row above, and their width must not be
                        handed to these fields (2026-10-17). */}
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem_2rem] gap-2">
                      <label className="flex min-w-0 flex-col gap-1.5">
                        <span className="text-xs leading-[18px] text-muted-foreground">
                          {copy.contextWindowLabel}
                        </span>
                        {/* A text field with a numeric keypad rather than `type="number"`: the native
                            spinner is drawn inside the field's right edge and pushes the text out of
                            line with the field beside it (2026-10-17). */}
                        <Input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={model.contextWindow}
                          disabled={busy}
                          onChange={(contextWindow) => replace(index, { ...model, contextWindow })}
                        />
                      </label>
                      <label className="flex min-w-0 flex-col gap-1.5">
                        <span className="text-xs leading-[18px] text-muted-foreground">
                          {copy.maxTokensLabel}
                        </span>
                        <Input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={model.maxTokens}
                          disabled={busy}
                          onChange={(maxTokens) => replace(index, { ...model, maxTokens })}
                        />
                      </label>
                    </div>
                    {/* The same two columns as the fields above, so 支持推理 starts exactly where
                        最大输出 tokens does; the trailing icon cells stay empty (2026-10-17). */}
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem_2rem] gap-2">
                      <Checkbox
                        checked={model.supportsImages}
                        disabled={busy}
                        onCheckedChange={(supportsImages) =>
                          replace(index, { ...model, supportsImages })
                        }
                        label={copy.supportsImagesLabel}
                      />
                      <Checkbox
                        checked={model.supportsReasoning}
                        disabled={busy}
                        onCheckedChange={(supportsReasoning) =>
                          replace(index, { ...model, supportsReasoning })
                        }
                        label={copy.customReasoningLabel}
                      />
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default function CustomEditor({
  provider,
  takenIds = [],
  onCancel,
  onDone,
  onBusyChange,
}: CustomEditorProps) {
  const copy = useCopy(MODELS_COPY)
  const isNew = provider === null
  const [draft, setDraft] = useState(() => draftFrom(provider))
  // No empty row when keys are already saved: the masked rows are the list, and the Add button
  // starts a new one. A provider with no keys opens with one field so there is somewhere to type.
  const [apiKeys, setApiKeys] = useState<string[]>(() =>
    (provider?.apiKeyMasks?.length ?? 0) > 0 ? [] : [''],
  )
  /** Saved rows the reader marked for removal, by their position in `apiKeyMasks`. */
  const [removedKeys, setRemovedKeys] = useState<number[]>([])
  const savedMasks = provider?.apiKeyMasks ?? []
  const [problem, setProblem] = useState<DraftProblem | null>(null)
  const [fetching, setFetching] = useState(false)
  const [fetchOutcome, setFetchOutcome] = useState<WriteOutcome | null>(null)
  const [busy, setBusy] = useState(false)

  /** Probes the address with the first key in play: a typed one, else the first stored one. The
   *  pool's other keys are not probed and their catalogues are never merged in. */
  async function fetchModels(): Promise<void> {
    const baseUrl = draft.baseUrl.trim()
    if (busy || fetching) {
      return
    }
    setFetchOutcome(null)
    if (!isHttpUrl(baseUrl)) {
      setProblem('base-url')
      return
    }
    setProblem(null)
    setFetching(true)
    try {
      const key = apiKeys.map((entry) => entry.trim()).find((entry) => entry !== '') ?? ''
      // An empty field on a saved provider means "use the first stored key", so the probe needs the
      // id to borrow it; otherwise an authenticated endpoint answers 401.
      const savedId = isNew ? null : provider.id
      const fetched = await fetchCustomModels(baseUrl, key === '' ? null : key, savedId)
      if (fetched.length === 0) {
        setFetchOutcome({ text: copy.customFetchEmpty, error: null })
        return
      }
      // Fetched models carry no metadata, so untouched placeholder rows go away first; a model id
      // already in the list (typed by hand or fetched before) is not added twice.
      setDraft((current) => ({
        ...current,
        models: mergeFetched(current.models.filter((model) => !isEmptyModel(model)), fetched),
      }))
    } catch (error) {
      setFetchOutcome({ text: copy.customFetchFailed, error: toApiError(error) })
    } finally {
      setFetching(false)
    }
  }

  async function save(): Promise<void> {
    if (busy) {
      return
    }
    const keys = apiKeys.map((entry) => entry.trim()).filter((entry) => entry !== '')
    const hadKeys = savedMasks.length > 0
    const keyEdit = removedKeys.length > 0 || keys.length > 0
    /**
     * The id is generated from the name, never typed: a new provider gets one here, and an existing
     * one keeps the id it was saved with (the engine keys its file by it). Generated at save time
     * rather than on every keystroke so the value is stable while the reader types.
     */
    const resolved = {
      ...draft,
      id: isNew ? providerIdFor(draft.name, takenIds) : provider.id,
    }
    const invalid = validateDraft(resolved)
    setProblem(invalid)
    if (invalid !== null) {
      return
    }

    /** Whether the running engine host took the key this attempt stored; `false` is stated, not lost. */
    let live = true

    setBusy(true)
    onBusyChange(true)
    try {
      if (keyEdit) {
        try {
          live = await applyProviderKeys(resolved.id.trim(), removedKeys, keys)
        } catch (error) {
          onDone({ text: copy.customFailed, error: toApiError(error), saved: false })
          return
        }
      }

      try {
        await saveCustomProvider(toInput(resolved))
      } catch (error) {
        const failure = toApiError(error)
        // Only a provider that had no keys before this attempt can be rolled back: a removal or a
        // replacement of existing keys cannot restore what the keyring no longer holds.
        if (!keyEdit || hadKeys) {
          onDone({ text: copy.customFailed, error: failure, saved: false })
          return
        }
        // Never leave a stored key behind for a provider that was not written to the file.
        try {
          await clearProviderKey(resolved.id.trim())
          onDone({ text: copy.customKeyRolledBack, error: failure, saved: false })
        } catch {
          // Reported as a state the user can clear from the card, not swallowed.
          onDone({ text: copy.customKeyOrphaned, error: failure, saved: false })
        }
        return
      }

      setApiKeys([])
      setRemovedKeys([])
      onDone({
        text: keyEdit && !live ? `${copy.customSaved} · ${copy.customKeyDeferred}` : copy.customSaved,
        error: null,
        saved: true,
      })
    } finally {
      setBusy(false)
      onBusyChange(false)
    }
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-4 px-5 py-4',
        // The two acts read differently on purpose. A new provider is its own block, opened on the
        // card it serves and named with the fields under a heading. An edit stays where the row it
        // belongs to is, tinted and divided from it — the row is the engine's answer, the tint says
        // this part of it is being changed.
        isNew ? 'border-t border-border/60' : 'border-t border-border/60 bg-muted/40',
      )}
    >
      <div className="flex flex-col gap-[3px]">
        <h4 className="flex items-center gap-2 text-[13px] leading-[19px] font-semibold text-foreground">
          {isNew ? <Plus className="size-3.5 text-muted-foreground" aria-hidden="true" /> : null}
          {isNew ? copy.customNewTitle : copy.customEditTitle}
        </h4>
        <p className="max-w-[620px] text-[13px] leading-[19px] text-muted-foreground">
          {isNew ? copy.customNewLead : copy.customLead}
        </p>
        {isNew ? null : (
          <p className="text-xs leading-[18px] text-muted-foreground">{provider?.id}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] leading-[19px] font-medium text-foreground">
            {copy.customNameLabel}
          </span>
          <Input
            value={draft.name}
            disabled={busy}
            onChange={(name) => setDraft((current) => ({ ...current, name }))}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] leading-[19px] font-medium text-foreground">
            {copy.customApiLabel}
          </span>
          <Select
            value={draft.api}
            disabled={busy}
            onValueChange={(api) => setDraft((current) => ({ ...current, api }))}
          >
            {/* The stored dialect is stated as it is: one this build does not list is kept, not replaced. */}
            <SelectTrigger className="w-full">
              <span className="min-w-0 truncate">{draft.api}</span>
            </SelectTrigger>
            <SelectContent className="w-full">
              {CUSTOM_PROVIDER_APIS.map((api) => (
                <SelectItem key={api} value={api}>
                  {api}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="col-span-2 flex flex-col gap-1.5">
          <span className="text-[13px] leading-[19px] font-medium text-foreground">
            {copy.customBaseUrlLabel}
          </span>
          <Input
            value={draft.baseUrl}
            disabled={busy}
            placeholder="https://api.example.com/v1"
            onChange={(baseUrl) => setDraft((current) => ({ ...current, baseUrl }))}
          />
        </label>
      </div>

      {/* The pool sits under the address, one row per key: a provider's rotation set is read as a
          list of credentials, not as a single value beside its name. */}
      <KeyPoolSection
        label={copy.customKeysLabel}
        hint={copy.customKeysHint}
        savedMasks={savedMasks}
        removedKeys={removedKeys}
        drafts={apiKeys}
        busy={busy}
        onRemoveSaved={(index) =>
          setRemovedKeys((current) => (current.includes(index) ? current : [...current, index]))
        }
        onDraftChange={(index, value) =>
          setApiKeys((current) =>
            current.map((entry, position) => (position === index ? value : entry)),
          )
        }
        onAddDraft={() => setApiKeys((current) => [...current, ''])}
        onRemoveDraft={(index) =>
          setApiKeys((current) => current.filter((_, position) => position !== index))
        }
      />

      {problem === null ? null : (
        <p className="text-[13px] leading-[19px] text-destructive" role="alert">
          {problemText(problem, copy)}
        </p>
      )}

      <ModelRows
        models={draft.models}
        busy={busy}
        fetching={fetching}
        fetchOutcome={fetchOutcome}
        onFetch={() => void fetchModels()}
        onChange={(models) => setDraft((current) => ({ ...current, models }))}
      />

      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {copy.customCancel}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {busy ? copy.customSaving : isNew ? copy.customNewOpen : copy.customSave}
        </Button>
      </div>
    </div>
  )
}

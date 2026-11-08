import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { toApiError } from '@/api/client'
import type { CustomProvider } from '@/api/types'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import { Button } from '@/components/motion/button'
import { useCopy } from '@/lib/i18n'
import { SettingsCard, SettingsEmpty } from '@/settings/parts'
import { MODELS_COPY } from '@/settings/sections/models/copy'
import CustomEditor, { type EditorNotice } from '@/settings/sections/models/CustomEditor'
import { WriteNotice, type WriteOutcome } from '@/settings/sections/models/panel-state'
import { clearProviderKey, modelStore, removeCustomProvider } from '@/state/model-store'
import { useStoreSelector } from '@/state/store'

/**
 * The providers this app defines itself: the list of them, and the editor for one.
 *
 * The list is the engine's answer, and each write replaces it whole — a save, a delete and a key
 * clear all end with the host's own list rather than an optimistic guess. The editor opens under the
 * row it edits, and the add row at the end of the list is the way in for a new one.
 */

/** Which editor is open: no editor, the new-provider one, or the one under a stored row. */
interface EditorState {
  open: boolean
  /** The edited provider's id, `''` for a provider that is not written yet. */
  id: string
}

/** One stored provider as a row: where it points, how many models, whether a key is stored. */
function CustomProviderRow({
  provider,
  editing,
  confirming,
  busy,
  onToggleEditor,
  onRequestRemove,
  onCancelRemove,
  onConfirmRemove,
  onClearKey,
}: {
  provider: CustomProvider
  editing: boolean
  confirming: boolean
  busy: boolean
  onToggleEditor: () => void
  onRequestRemove: () => void
  onCancelRemove: () => void
  onConfirmRemove: () => void
  onClearKey: () => void
}) {
  const copy = useCopy(MODELS_COPY)

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="flex min-h-[70px] items-center justify-between gap-6 px-5 py-[15px]">
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm leading-5 font-medium text-foreground">{provider.name}</span>
            <AnimatedBadge
              status={provider.apiKeyConfigured ? 'info' : 'neutral'}
              size="sm"
              animated={false}
            >
              {provider.apiKeyConfigured
                ? copy.providerConfiguredLabel
                : copy.providerNotConfiguredLabel}
            </AnimatedBadge>
          </span>
          <span className="text-[13px] leading-[19px] text-muted-foreground">
            {`${provider.models.length} ${copy.modelsLabel} · ${provider.api} · ${provider.baseUrl}`}
          </span>
        </div>
        <div className="flex flex-none items-center gap-2">
          {provider.apiKeyConfigured ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onClearKey}>
              {copy.clearStoredKey}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            aria-expanded={editing}
            onClick={onToggleEditor}
          >
            {editing ? copy.hideKeyEditor : copy.customEdit}
            <ChevronDown
              className={editing ? 'rotate-180 transition-transform' : 'transition-transform'}
              size={14}
              aria-hidden="true"
            />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            aria-label={copy.customRemove}
            onClick={onRequestRemove}
          >
            <Trash2 size={15} />
          </Button>
        </div>
      </div>

      {confirming ? (
        <div className="flex flex-col gap-3 border-t border-border/60 bg-muted/40 px-5 py-4">
          <p className="text-[13px] leading-[19px] text-muted-foreground">{copy.customRemoveHint}</p>
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onCancelRemove}>
              {copy.customCancel}
            </Button>
            <Button size="sm" disabled={busy} onClick={onConfirmRemove}>
              {copy.customRemoveConfirm}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default function CustomPanel() {
  const copy = useCopy(MODELS_COPY)
  const providers = useStoreSelector(modelStore, (state) => state.customProviders)
  const status = useStoreSelector(modelStore, (state) => state.status)
  const [editor, setEditor] = useState<EditorState>({ open: false, id: '' })
  /** Bumped per editor session, so a reopened editor starts from the stored provider again. */
  const [session, setSession] = useState(0)
  const [confirmingId, setConfirmingId] = useState('')
  const [busyId, setBusyId] = useState('')
  /** A write started by the open editor; every control on this view waits for it. */
  const [editorBusy, setEditorBusy] = useState(false)
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null)

  const guarded = busyId !== '' || editorBusy
  /** Every id in use, so a generated one does not collide with a stored provider. */
  const takenIds = providers.map((provider) => provider.id)

  /**
   * One editor at a time, under the row it edits — or, for `null`, in place of the list's add row.
   * Pressing the same entry again collapses it. A write in flight owns the whole list, so it must
   * not be swapped for another draft.
   */
  function toggleEditor(provider: CustomProvider | null): void {
    if (guarded) {
      return
    }
    const id = provider?.id ?? ''
    if (editor.open && editor.id === id) {
      setEditor({ open: false, id: '' })
      return
    }
    setSession((current) => current + 1)
    setEditor({ open: true, id })
    setOutcome(null)
  }

  function closeEditor(): void {
    setEditor({ open: false, id: '' })
  }

  function handleEditorDone(notice: EditorNotice): void {
    setOutcome({ text: notice.text, error: notice.error })
    if (notice.saved) {
      closeEditor()
    }
  }

  async function remove(provider: CustomProvider): Promise<void> {
    if (guarded) {
      return
    }
    setBusyId(provider.id)
    setOutcome(null)
    try {
      await removeCustomProvider(provider.id)
      setOutcome({ text: copy.customRemoved, error: null })
    } catch (error) {
      setOutcome({ text: copy.customFailed, error: toApiError(error) })
    } finally {
      setBusyId('')
      setConfirmingId('')
      if (editor.id === provider.id) {
        closeEditor()
      }
    }
  }

  async function clearKey(provider: CustomProvider): Promise<void> {
    if (guarded) {
      return
    }
    setBusyId(provider.id)
    setOutcome(null)
    try {
      await clearProviderKey(provider.id)
      setOutcome({ text: copy.customKeyCleared, error: null })
    } catch (error) {
      setOutcome({ text: copy.customFailed, error: toApiError(error) })
    } finally {
      setBusyId('')
    }
  }

  return (
    <>
      <p className="max-w-[620px] text-[13px] leading-[19px] text-muted-foreground">
        {copy.customLead}
      </p>

      {outcome === null ? null : <WriteNotice text={outcome.text} error={outcome.error} />}

      <SettingsCard>
        {providers.length === 0 && status === 'ready' ? (
          <SettingsEmpty>{copy.customEmpty}</SettingsEmpty>
        ) : null}

        {providers.map((provider) => (
          <div key={provider.id}>
            <CustomProviderRow
              provider={provider}
              editing={editor.open && editor.id === provider.id}
              confirming={confirmingId === provider.id}
              busy={guarded}
              onToggleEditor={() => toggleEditor(provider)}
              onRequestRemove={() => setConfirmingId(provider.id)}
              onCancelRemove={() => setConfirmingId('')}
              onConfirmRemove={() => void remove(provider)}
              onClearKey={() => void clearKey(provider)}
            />
            {editor.open && editor.id === provider.id ? (
              <CustomEditor
                key={session}
                provider={provider}
                takenIds={takenIds}
                onCancel={closeEditor}
                onDone={handleEditorDone}
                onBusyChange={setEditorBusy}
              />
            ) : null}
          </div>
        ))}
      </SettingsCard>

      {/*
        A new provider has its own block rather than a row inside the list.

        The list's rows are readings of the engine's own answer; a block that writes one is a
        different act and reading it as "another row" was what made adding a provider look exactly
        like editing one — the same folded container under the same heading, with only the title's
        one word telling them apart. It is separated from the list by its own lead and its own
        button, so the two acts are two things on the page.
      */}
      <div className="flex flex-col gap-3">
        <p className="max-w-[620px] text-[13px] leading-[19px] text-muted-foreground">
          {copy.customNewLead}
        </p>
        <SettingsCard>
          {editor.open && editor.id === '' ? (
            <CustomEditor
              key={session}
              provider={null}
              takenIds={takenIds}
              onCancel={closeEditor}
              onDone={handleEditorDone}
              onBusyChange={setEditorBusy}
            />
          ) : (
            <button
              type="button"
              disabled={guarded}
              onClick={() => toggleEditor(null)}
              className="flex w-full items-center justify-center gap-2 px-5 py-4 text-[13px] leading-[19px] font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <Plus size={15} />
              {copy.customNewOpen}
            </button>
          )}
        </SettingsCard>
      </div>
    </>
  )
}

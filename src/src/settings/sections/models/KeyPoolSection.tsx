import { Plus, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { useCopy } from '@/lib/i18n'
import { MODELS_COPY } from '@/settings/sections/models/copy'
import { PROVIDER_KEYS_MAX } from '@/settings/sections/models/limits'

/**
 * One provider's key pool as a list: saved keys as masked, removable rows, and the keys being typed.
 *
 * Shared by the custom-provider editor and the built-in provider form so the two surfaces cannot
 * drift: the same rows, the same numbering, the same cap, and the same hint. Each caller owns its
 * own header wording and footer (the editor's save button sits with the rest of its form; the
 * built-in form keeps its environment line and buttons in `footer`).
 */
export interface KeyPoolSectionProps {
  label: string
  /** The count is the saved rows still shown (removals excluded). */
  hint: (visibleCount: number) => string
  savedMasks: readonly string[]
  /** Positions in `savedMasks` the reader marked for removal. */
  removedKeys: readonly number[]
  drafts: readonly string[]
  busy: boolean
  onRemoveSaved: (index: number) => void
  onDraftChange: (index: number, value: string) => void
  onAddDraft: () => void
  onRemoveDraft: (index: number) => void
  footer?: ReactNode
}

export function KeyPoolSection({
  label,
  hint,
  savedMasks,
  removedKeys,
  drafts,
  busy,
  onRemoveSaved,
  onDraftChange,
  onAddDraft,
  onRemoveDraft,
  footer,
}: KeyPoolSectionProps) {
  const copy = useCopy(MODELS_COPY)
  const visibleMasks = savedMasks
    .map((mask, index) => ({ mask, index }))
    .filter((entry) => !removedKeys.includes(entry.index))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-[3px]">
          <span className="text-[13px] leading-[19px] font-medium text-foreground">{label}</span>
          <p className="max-w-[620px] text-xs leading-[18px] text-muted-foreground">
            {hint(visibleMasks.length)}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || visibleMasks.length + drafts.length >= PROVIDER_KEYS_MAX}
          onClick={onAddDraft}
        >
          <Plus size={14} />
          {copy.customKeysAdd}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {/* A saved key is shown as its masked form: enough to tell two keys apart, never enough to
            use. It is not an input; the row is removed, not edited. */}
        {visibleMasks.map(({ mask, index }) => (
          <div key={`saved-${index}`} className="flex items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="text-xs leading-[18px] text-muted-foreground">
                {`${copy.customKeysRowLabel(index + 1)} · ${copy.customKeysSavedTag}`}
              </span>
              <Input value={mask} readOnly disabled={busy} />
            </label>
            <Button
              size="icon"
              variant="ghost"
              disabled={busy}
              aria-label={copy.customKeysRemove}
              onClick={() => onRemoveSaved(index)}
            >
              <Trash2 size={16} />
            </Button>
          </div>
        ))}

        {drafts.map((key, index) => (
          <div key={`new-${index}`} className="flex items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="text-xs leading-[18px] text-muted-foreground">
                {copy.customKeysRowLabel(visibleMasks.length + index + 1)}
              </span>
              <Input
                type="password"
                autoComplete="new-password"
                value={key}
                disabled={busy}
                placeholder={copy.apiKeyPlaceholder}
                onChange={(value) => onDraftChange(index, value)}
              />
            </label>
            <Button
              size="icon"
              variant="ghost"
              disabled={busy}
              aria-label={copy.customKeysRemove}
              onClick={() => onRemoveDraft(index)}
            >
              <Trash2 size={16} />
            </Button>
          </div>
        ))}
      </div>

      {footer}
    </div>
  )
}

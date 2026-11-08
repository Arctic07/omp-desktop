import type { ApiError } from '@/api/client'
import { Button } from '@/components/motion/button'
import { useCopy } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { SettingsNotice } from '@/settings/parts'
import { MODELS_COPY } from '@/settings/sections/models/copy'
import { loadModels, modelStore } from '@/state/model-store'
import { useStoreSelector } from '@/state/store'

/**
 * The model page's read state, stated once above the view that shows it.
 *
 * Every view on the page reads the same six lists, which the store loads together, so a failed read
 * is one fact rather than one per view. A read in flight draws nothing: the page has nothing to say
 * until an answer arrives, and a "Loading…" line that appears for a few hundred milliseconds on every
 * visit is noise rather than information (2026-10-17). The refresh button states that same fact in
 * place, on the one control a reader would use to ask again.
 */
export function ModelsStatus() {
  const copy = useCopy(MODELS_COPY)
  const status = useStoreSelector(modelStore, (state) => state.status)
  const error = useStoreSelector(modelStore, (state) => state.error)

  if (status !== 'error') {
    return null
  }

  return (
    <SettingsNotice variant="destructive" title={copy.loadFailedLabel}>
      <span className="flex flex-wrap items-center gap-3">
        {error === null ? null : <span className="min-w-0">{error.message}</span>}
        <Button size="sm" variant="secondary" onClick={() => void loadModels(true)}>
          {copy.retry}
        </Button>
      </span>
    </SettingsNotice>
  )
}

/** One write's outcome as the panel that owns it keeps it: what happened, and any refusal. */
export interface WriteOutcome {
  text: string
  error: ApiError | null
}

/** One write's outcome: what happened, and the desktop's own words when it refused. */
export function WriteNotice({ text, error }: WriteOutcome) {
  return (
    <span
      role="status"
      className={cn(
        'block text-[13px] leading-[19px]',
        error === null ? 'text-muted-foreground' : 'text-destructive',
      )}
    >
      {error === null ? text : `${text} · ${error.message}`}
    </span>
  )
}

/**
 * The find bar over one file: a query, how many matches it has, and the three keys that move
 * between them.
 *
 * It draws nothing itself — the viewer owns the query and which match is on screen, because the
 * preview has to mark the lines and the editor has to select one. The bar is the field and the
 * buttons, and `Enter` / `Shift+Enter` / `Escape` are answered here so the reader never has to
 * leave the field to step through.
 */

import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { FILE_PANEL_COPY } from '@/components/workspace/file-panel-copy'
import { useCopy } from '@/lib/i18n'

export interface FileFindBarProps {
  query: string
  onQueryChange: (value: string) => void
  /** Zero-based index of the match on screen, or -1 while the query matches nothing. */
  current: number
  total: number
  /** The file holds more matches than were collected; the count ends with a `+`. */
  truncated: boolean
  /** Bumped every `Ctrl+F`: the field takes focus and selects what it already holds. */
  focusSignal: number
  onStep: (step: 1 | -1) => void
  onClose: () => void
}

export function FileFindBar({
  query,
  onQueryChange,
  current,
  total,
  truncated,
  focusSignal,
  onStep,
  onClose,
}: FileFindBarProps) {
  const copy = useCopy(FILE_PANEL_COPY)
  const fieldRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const field = fieldRef.current
    if (field === null) return
    field.focus()
    field.select()
  }, [focusSignal])

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-border border-b px-2">
      <Input
        ref={fieldRef}
        value={query}
        onChange={onQueryChange}
        placeholder={copy.findPlaceholder}
        aria-label={copy.findLabel}
        leftIcon={<Search />}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            return
          }
          if (event.key !== 'Enter') return
          event.preventDefault()
          onStep(event.shiftKey ? -1 : 1)
        }}
        classNames={{
          field: 'h-7 rounded-md',
          input: 'text-xs',
          leftIcon: 'left-2',
        }}
      />
      <span
        role="status"
        aria-live="polite"
        className="shrink-0 px-1 font-mono text-[10px] tabular-nums text-muted-foreground"
      >
        {total === 0 ? copy.findNone : `${current + 1}/${total}${truncated ? '+' : ''}`}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={copy.findPrev}
        title={copy.findPrev}
        onClick={() => onStep(-1)}
        disabled={total === 0}
        className="size-6 shrink-0 rounded-md"
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={copy.findNext}
        title={copy.findNext}
        onClick={() => onStep(1)}
        disabled={total === 0}
        className="size-6 shrink-0 rounded-md"
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={copy.findClose}
        title={copy.findClose}
        onClick={onClose}
        className="size-6 shrink-0 rounded-md"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}

import type { ReactNode, TextareaHTMLAttributes } from 'react'

import { Alert, AlertContent, AlertDescription, AlertTitle } from '@/components/motion/alert'
import { Button } from '@/components/motion/button'
import { Card } from '@/components/motion/card'
import { TextShimmer } from '@/components/motion/text-shimmer'
import type { ApiError } from '@/api/client'
import { cn } from '@/lib/utils'

/**
 * The settings vocabulary, once: the desktop app draws every page from these same
 * shapes (group heading, card, row, chips, figures, badge, empty state, notice,
 * path), so a section only writes what is genuinely its own.
 */

export function SettingsGroup({
  title,
  description,
  children,
}: {
  /** Omit when the section is already named by the controls above it. */
  title?: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      {title === undefined ? null : (
        <header className="flex flex-col gap-[3px]">
          <h3 className="text-[15px] leading-[22px] font-semibold text-foreground">{title}</h3>
          {description ? (
            <p className="text-[13px] leading-[19px] text-muted-foreground">{description}</p>
          ) : null}
        </header>
      )}
      {children}
    </section>
  )
}

/** Full-bleed rows inside a bordered, softly raised surface. */
export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Card variant="outlined" size="default" className={cn('gap-0 rounded-2xl py-0 shadow-sm', className)}>
      {children}
    </Card>
  )
}

/** One setting: copy on the left, its control on the right. */
export function SettingsRow({
  title,
  description,
  icon,
  control,
  stack = false,
}: {
  title: string
  description?: string
  icon?: ReactNode
  control?: ReactNode
  /** Put the control under the copy instead of beside it (wide controls, textareas). */
  stack?: boolean
}) {
  return (
    <div
      className={cn(
        'flex min-h-[70px] justify-between gap-6 border-b border-border/60 px-5 py-[15px] last:border-b-0',
        stack ? 'flex-col items-stretch gap-3' : 'items-center',
      )}
    >
      <div className={cn('flex min-w-0 flex-1 flex-col gap-[3px]', icon && 'flex-row items-center gap-2.5')}>
        {icon ? (
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            {icon}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-col gap-[3px]">
          <span className="text-sm leading-5 font-medium text-foreground">{title}</span>
          {description ? (
            <span className="text-[13px] leading-[19px] text-muted-foreground">{description}</span>
          ) : null}
        </span>
      </div>
      {control ? <div className="flex flex-none items-center gap-2">{control}</div> : null}
    </div>
  )
}

/** A row of figures: value above, label under. */
export function SettingsStats({ items }: { items: { value: string; label: string }[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(92px,1fr))] gap-3 px-5 py-4">
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xl leading-[26px] font-semibold whitespace-nowrap text-foreground">
            {item.value}
          </span>
          <span className="text-xs leading-[18px] text-muted-foreground">{item.label}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * A row of exclusive chips, as the control it looks like.
 *
 * The desktop app draws every exclusive choice this way — theme, density, busy behaviour, where a
 * link goes, the usage window — so this is the one implementation: the chips keep the shape the
 * settings page has always drawn, and each one is a button that reports the value it stands for.
 */
export function SettingsChoice<V extends string>({
  options,
  value,
  onChange,
  disabled = false,
  label,
  className,
}: {
  options: readonly { value: V; label: string }[]
  value: V
  onChange: (value: V) => void
  disabled?: boolean
  /** The group's own name, for a reader who cannot see which chip is pressed. */
  label: string
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn('flex flex-wrap gap-1.5', className)}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'min-h-8 rounded-lg border px-2.5 py-[5px] text-[13px] leading-5 outline-none transition-colors',
              'focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'border-foreground bg-muted text-foreground'
                : 'border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * A list's own read state, stated once above the view that shows it.
 *
 * A read in flight keeps whatever the last read answered on screen, so this renders the loading line
 * over the previous value rather than replacing it — which is what makes a refresh not blink.
 */
export function SettingsLoadState({
  status,
  error,
  loadingLabel,
  failedLabel,
  retryLabel,
  onRetry,
}: {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: ApiError | null
  loadingLabel: string
  failedLabel: string
  retryLabel: string
  onRetry: () => void
}) {
  if (status === 'error') {
    return (
      <SettingsNotice variant="destructive" title={failedLabel}>
        <span className="flex flex-wrap items-center gap-3">
          {error === null ? null : <span className="min-w-0">{error.message}</span>}
          <Button size="sm" variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        </span>
      </SettingsNotice>
    )
  }

  if (status === 'ready') return null

  return (
    <p className="text-[13px] leading-[19px] text-muted-foreground" role="status">
      <TextShimmer>{loadingLabel}</TextShimmer>
    </p>
  )
}

/** A stacked field: the label above the control, which is the shape a textarea needs. */
export function SettingsField({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="px-1 text-sm font-medium text-foreground">{label}</span>
      {children}
      {hint === undefined ? null : (
        <span className="px-1 text-[13px] leading-[19px] text-muted-foreground">{hint}</span>
      )}
    </div>
  )
}

/**
 * The one textarea every editor on the settings page uses.
 *
 * Both the rules file and an MCP definition's JSON are monospace text read as code rather than as
 * prose, so they share one frame: the same border, radius and focus ring, with the height left to
 * the caller's `rows`.
 */
export function SettingsTextarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      spellCheck={false}
      className={cn(
        'w-full resize-y rounded-xl border border-border bg-background px-3.5 py-3 font-mono text-[13px] leading-[21px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60',
        className,
      )}
      {...props}
    />
  )
}

/** A short machine token beside a row. `warning` is for a token that reports a refusal. */
export function SettingsBadge({
  children,
  tone = 'muted',
  ariaLabel,
}: {
  children: ReactNode
  tone?: 'muted' | 'warning'
  /** The machine token behind the words, for a reader who needs the exact reason. */
  ariaLabel?: string
}) {
  return (
    <span
      aria-label={ariaLabel}
      className={cn(
        'flex-none rounded-md px-1.5 py-px text-[11px] leading-4 whitespace-nowrap',
        tone === 'warning'
          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
          : 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}

/** Nothing to list here yet. */
export function SettingsEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="m-3.5 rounded-[10px] border border-dashed border-border p-3.5 text-center text-xs leading-[18px] text-muted-foreground">
      {children}
    </p>
  )
}

/** A titled notice inside the page: the app's own alert component, no bespoke shell. */
export function SettingsNotice({
  title,
  children,
  variant = 'info',
}: {
  title: string
  children?: ReactNode
  variant?: 'default' | 'info' | 'success' | 'warning' | 'destructive'
}) {
  return (
    <Alert variant={variant} className="rounded-2xl px-5 py-4">
      <AlertContent className="gap-1">
        <AlertTitle className="text-sm leading-5 font-medium">{title}</AlertTitle>
        {children ? (
          <AlertDescription className="text-[13px] leading-[19px]">{children}</AlertDescription>
        ) : null}
      </AlertContent>
    </Alert>
  )
}

/** A path or other machine string, read as code rather than prose. */
export function SettingsPath({ children }: { children: ReactNode }) {
  return (
    <code className="block truncate rounded-lg bg-muted px-2 py-1 font-mono text-xs leading-[18px] text-muted-foreground">
      {children}
    </code>
  )
}

/**
 * The pager under a long settings list.
 *
 * Two pages have one - the provider list and the MCP server list - and the rule they share is the
 * caller's: it slices, this draws. A single page draws nothing, so a short list never grows a
 * footer it has no use for. The words arrive as labels because each page words its own total
 * ("providers" / "servers").
 */
export function SettingsPager({
  page,
  pageCount,
  total,
  label,
  previous,
  next,
  status,
  totalLabel,
  onPage,
}: {
  page: number
  pageCount: number
  total: number
  label: string
  previous: string
  next: string
  status: (page: number, pageCount: number) => string
  totalLabel: (count: number) => string
  onPage: (page: number) => void
}) {
  if (pageCount <= 1) return null
  return (
    <nav className="flex items-center justify-center gap-3" aria-label={label}>
      <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        {previous}
      </Button>
      <span
        className="text-xs leading-[18px] whitespace-nowrap text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        {`${status(page, pageCount)} · ${totalLabel(total)}`}
      </span>
      <Button
        size="sm"
        variant="secondary"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        {next}
      </Button>
    </nav>
  )
}

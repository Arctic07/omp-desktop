import { useState, type ReactElement } from 'react'
import { CircleHelp, Search, Trash2 } from 'lucide-react'

import type { ApiError } from '@/api/client'
import type { EngineMarketplaceRow } from '@/api/plugins-types'
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from '@/components/motion/alert'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import { Button } from '@/components/motion/button'
import {
  CenterMorphModal,
  CenterMorphModalContent,
  CenterMorphModalTrigger,
} from '@/components/motion/center-morph-modal'
import { Input } from '@/components/motion/input'
import { Pagination } from '@/components/motion/pagination'
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from '@/components/motion/popover-morph'
import { Switch } from '@/components/motion/switch'
import { Table, type TableColumn } from '@/components/motion/table'
import { isBuiltinMarketplace } from '@/lib/plugin-market'
import type { MarketCopy } from '@/market/market-copy'
import { useBlockingOverlayWhile } from '@/state/overlay-depth'

/** One page of the sources list: five rows, one source each. */
const SOURCES_PER_PAGE = 5
/** One table row's height; the table is the list, so a row is never squeezed. */
const SOURCE_ROW_HEIGHT = 64
/** The table header's height; a compact band above the one-per-row list. */
const TABLE_HEADER_HEIGHT = 44

/**
 * The marketplace sources, in beUI's center-morph dialog.
 *
 * The list is one row per source and pages at five; the dialog is opened from the header's
 * storefront control, so the page body stays a catalogue. Removing a source asks first and states
 * the boundary the engine already holds: the registry row and its cached catalogue go, while every
 * plugin installed from it stays installed.
 */
export function MarketSourcesDialog({
  open,
  onOpenChange,
  marketplaces,
  busyKey,
  failure,
  copy,
  disabled,
  onToggle,
  onRemove,
  trigger,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  marketplaces: readonly EngineMarketplaceRow[]
  /** The registry write in flight, spelled `remove:<name>`; '' when idle. */
  busyKey: string
  /** The page's last write refusal; shown inside the dialog, which covers the page notice. */
  failure: { title: string; error: ApiError } | null
  copy: MarketCopy
  /** Names switched off in the process-level browsing filter; they stay registered. */
  disabled: readonly string[]
  /** Switch one source on or off in the market page. */
  onToggle: (name: string, enabled: boolean) => void
  /** Resolves true when the source is gone, so the confirmation can close. */
  onRemove: (name: string) => Promise<boolean>
  /** The header control that opens the dialog. */
  trigger: ReactElement
}) {
  useBlockingOverlayWhile(open)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const busy = busyKey !== ''
  const term = query.trim().toLowerCase()
  const filtered =
    term === ''
      ? marketplaces
      : marketplaces.filter(
          (marketplace) =>
            marketplace.name.toLowerCase().includes(term) ||
            marketplace.sourceUri.toLowerCase().includes(term),
        )
  const totalPages = Math.max(1, Math.ceil(filtered.length / SOURCES_PER_PAGE))
  const current = Math.min(page, totalPages)
  const rows = filtered.slice(
    (current - 1) * SOURCES_PER_PAGE,
    current * SOURCES_PER_PAGE,
  )

  const columns: TableColumn<EngineMarketplaceRow>[] = [
    {
      key: 'name',
      header: copy.sourceName,
      width: '34%',
      cell: (marketplace) => (
        <span className="block truncate font-medium text-foreground">{marketplace.name}</span>
      ),
    },
    {
      key: 'sourceUri',
      header: copy.sourceAddress,
      width: '44%',
      cell: (marketplace) => (
        <span className="block truncate text-muted-foreground" title={marketplace.sourceUri}>
          {marketplace.sourceUri}
        </span>
      ),
    },
    {
      key: 'status',
      header: copy.sourceStatus,
      width: '80px',
      align: 'center',
      cell: (marketplace) => {
        const enabled = !disabled.includes(marketplace.name)
        return (
          <Switch
            checked={enabled}
            disabled={busy}
            ariaLabel={copy.sourceToggle(marketplace.name, enabled)}
            onCheckedChange={(next) => onToggle(marketplace.name, next)}
          />
        )
      },
    },
    {
      key: 'actions',
      header: copy.sourceAction,
      width: '72px',
      align: 'right',
      cell: (marketplace) => {
        const builtin = isBuiltinMarketplace(marketplace)
        const remove = (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={builtin ? copy.builtinDeleteHint : copy.sourceRemove}
            title={builtin ? copy.builtinDeleteHint : copy.sourceRemove}
            disabled={builtin || busy}
            className="size-8 rounded-lg text-muted-foreground"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        )
        if (builtin) return remove
        return (
          <MorphPopover
            open={pending === marketplace.name}
            onOpenChange={(open) => setPending(open ? marketplace.name : null)}
          >
            <MorphPopoverTrigger>{remove}</MorphPopoverTrigger>
            <MorphPopoverContent
              side="top"
              align="end"
              sideOffset={8}
              radius={12}
              arrow
              className="w-60 p-3"
            >
              <div className="flex items-start gap-2">
                <CircleHelp
                  className="mt-0.5 size-4 shrink-0 text-amber-500"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-sm leading-5 font-medium text-foreground">
                    {copy.removeConfirmTitle}
                  </p>
                  <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
                    {copy.removeBubbleBody}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setPending(null)}
                >
                  {copy.cancel}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void confirmRemove(marketplace.name)}
                >
                  {copy.removeConfirmAction}
                </Button>
              </div>
            </MorphPopoverContent>
          </MorphPopover>
        )
      },
    },
  ]

  const confirmRemove = async (name: string) => {
    if (await onRemove(name)) setPending(null)
  }

  return (
    <CenterMorphModal open={open} onOpenChange={onOpenChange}>
      <CenterMorphModalTrigger>{trigger}</CenterMorphModalTrigger>
      <CenterMorphModalContent
        ariaLabel={copy.sourcesTitle}
        closeButtonLabel={copy.close}
        className="max-w-[52rem]"
      >
        <div className="flex flex-col gap-4 p-6 pr-14">
          <div>
            <h2 className="text-lg leading-6 font-semibold text-foreground">
              {copy.sourcesTitle}
            </h2>
            <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">
              {copy.sourcesSubtitle}
            </p>
          </div>

          {failure === null ? null : (
            <Alert variant="destructive">
              <AlertIcon />
              <AlertContent>
                <AlertTitle>{failure.title}</AlertTitle>
                <AlertDescription>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <AnimatedBadge animated={false} size="sm" showIcon={false}>
                      {failure.error.code}
                    </AnimatedBadge>
                    <span className="min-w-0 break-words">{failure.error.message}</span>
                  </span>
                </AlertDescription>
              </AlertContent>
            </Alert>
          )}

          <div className="flex flex-col gap-3">
            <Input
              value={query}
              onChange={(next) => {
                setQuery(next)
                setPage(1)
              }}
              placeholder={copy.sourcesSearchPlaceholder}
              aria-label={copy.sourcesSearchLabel}
              leftIcon={<Search />}
              classNames={{ field: 'h-9 rounded-lg', input: 'text-sm' }}
            />
            <Table
              data={rows}
              columns={columns}
              getRowId={(marketplace) => marketplace.name}
              rowHeight={SOURCE_ROW_HEIGHT}
              headerHeight={TABLE_HEADER_HEIGHT}
              height={Math.max(1, rows.length) * SOURCE_ROW_HEIGHT + TABLE_HEADER_HEIGHT + 2}
              emptyState={<span className="text-muted-foreground">{query.trim() === '' ? copy.sourcesEmpty : copy.sourcesSearchEmpty}</span>}
              className="rounded-2xl"
            />
          </div>

          {totalPages <= 1 ? null : (
            <div className="flex justify-center pt-1">
              <Pagination
                totalPages={totalPages}
                page={current}
                onPageChange={setPage}
                labels={{
                  pagination: copy.pagination,
                  previous: copy.previousPage,
                  next: copy.nextPage,
                  page: copy.pageOf,
                  back: copy.backPages,
                  forward: copy.forwardPages,
                }}
              />
            </div>
          )}
        </div>
      </CenterMorphModalContent>
    </CenterMorphModal>
  )
}

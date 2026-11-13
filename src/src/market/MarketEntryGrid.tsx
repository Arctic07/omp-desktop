import { Plus } from 'lucide-react'

import type { MarketplacePluginRow, PluginGrantRow, PluginRow } from '@/api/plugins-types'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import { Button } from '@/components/motion/button'
import { Card } from '@/components/motion/card'
import { Loader } from '@/components/motion/loader'
import {
  installedForEntry,
  marketEntryView,
} from '@/lib/plugin-market'
import type { MarketCopy } from '@/market/market-copy'
import { isGranted } from '@/state/plugins-store'

/**
 * The catalogue's cards: one installed handle and one consent action per card, while the page keeps
 * the reads, writes and pagination.
 *
 * The grant check lives here because it needs the entry's install id, not the page's current
 * selection: an installation is looked up by `name@marketplace` at the scope the page shows, and a
 * missing grant is what turns `已安装` into the one prompt the card can offer before a switch exists.
 */
export function MarketEntryGrid({
  entries,
  installed,
  scope,
  grants,
  busy,
  busyKey,
  copy,
  installLabel,
  onInstall,
  onConsent,
}: {
  entries: readonly MarketplacePluginRow[]
  installed: readonly PluginRow[]
  /** The registry the page is showing: the machine's, or the picked workspace's. */
  scope: 'user' | 'project'
  grants: readonly PluginGrantRow[] | null
  busy: boolean
  busyKey: string
  copy: MarketCopy
  /** The scope this page writes: the button says where the installation lands. */
  installLabel: string
  onInstall: (entry: MarketplacePluginRow) => void
  onConsent: (row: PluginRow) => void
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {entries.map((entry) => {
        const view = marketEntryView(entry)
        const installedRow = installedForEntry(entry, installed, scope)
        const installing = busyKey === `install:${view.installId}`
        const needsConsent =
          installedRow !== null &&
          grants !== null &&
          installedRow.consent.required &&
          !isGranted(grants, installedRow.id, installedRow.scope)
        return (
          <Card
            key={view.installId}
            size="compact"
            className="flex min-h-[172px] min-w-0 flex-col gap-2 px-4"
          >
            <div className="flex min-w-0 items-start justify-between gap-2">
              <span className="min-w-0 truncate text-sm leading-5 font-medium text-foreground">
                {view.name}
              </span>
              {view.version === '' ? null : (
                <AnimatedBadge
                  animated={false}
                  size="sm"
                  showIcon={false}
                  className="max-w-[45%]"
                >
                  <span className="truncate">{view.version}</span>
                </AnimatedBadge>
              )}
            </div>
            {view.description === '' ? null : (
              <p className="line-clamp-3 text-[13px] leading-[19px] break-words text-muted-foreground">
                {view.description}
              </p>
            )}
            <div className="flex min-w-0 flex-col gap-0.5">
              {view.author === '' ? null : (
                <span className="min-w-0 truncate text-xs leading-[18px] text-muted-foreground">
                  {view.author}
                </span>
              )}
              <span
                className="min-w-0 truncate text-xs leading-[18px] text-muted-foreground"
                title={view.installId}
              >
                {view.installId}
              </span>
            </div>
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
              {installedRow === null ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => onInstall(entry)}
                >
                  {installing ? (
                    <span aria-hidden="true" className="inline-flex">
                      <Loader size={14} speed={0.9} />
                    </span>
                  ) : (
                    <Plus className="size-3.5" aria-hidden="true" />
                  )}
                  {installing ? copy.installing : installLabel}
                </Button>
              ) : (
                <>
                  <AnimatedBadge
                    status="success"
                    size="sm"
                    showIcon={false}
                    animated={false}
                  >
                    {copy.installed}
                  </AnimatedBadge>
                  {needsConsent ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => onConsent(installedRow)}
                    >
                      {copy.consentRequiredAction}
                    </Button>
                  ) : null}
                  {installedRow.builtin ? (
                    <span title={copy.builtinHint}>
                      <AnimatedBadge
                        status="info"
                        size="sm"
                        showIcon={false}
                        animated={false}
                      >
                        {copy.builtin}
                      </AnimatedBadge>
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </Card>
        )
      })}
    </div>
  )
}

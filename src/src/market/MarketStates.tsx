import type { ReactNode } from 'react'

import { Card } from '@/components/motion/card'
import { SkeletonBar } from '@/components/motion/skeleton-bar'

/** The body's default when there is nothing to list: a beUI surface, a mark, and one next action. */
export function MarketEmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border px-6 py-12 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </span>
      <strong className="text-sm leading-5 font-medium text-foreground">{title}</strong>
      <p className="max-w-[360px] text-[13px] leading-[19px] text-muted-foreground">
        {description}
      </p>
      {action}
    </div>
  )
}

/** The marketplace's fixed skeleton slots; a static count keeps the wait from resizing on render. */
const SKELETON_CARDS = [0, 1, 2, 3, 4, 5] as const

/** The selector's wait, before the registry has answered. */
export function MarketSelectorSkeleton() {
  return <SkeletonBar className="h-9 w-full max-w-[380px] rounded-lg" />
}

/** The catalogue's wait: the same card grid, at the same sizes, with nothing to read yet. */
export function MarketSkeleton({ label }: { label: string }) {
  return (
    <div role="status" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <span className="sr-only">{label}</span>
      {SKELETON_CARDS.map((slot) => (
        <Card
          key={slot}
          size="compact"
          aria-hidden="true"
          className="flex min-h-[172px] min-w-0 flex-col gap-3 px-4"
        >
          <SkeletonBar className="h-4 w-2/5" delay={slot * 0.06} />
          <SkeletonBar className="h-3 w-full" delay={slot * 0.06 + 0.05} />
          <SkeletonBar className="h-3 w-4/5" delay={slot * 0.06 + 0.1} />
          <SkeletonBar className="mt-auto h-8 w-24 rounded-lg" delay={slot * 0.06 + 0.15} />
        </Card>
      ))}
    </div>
  )
}

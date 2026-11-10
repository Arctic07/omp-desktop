import { SettingsCard } from '@/settings/parts'
import { SkeletonBar } from '@/components/motion/skeleton-bar'

/** The installed list's wait: the same row geometry, with nothing to read yet. */
export function PluginListSkeleton({
  label,
  rows = 4,
}: {
  label: string
  rows?: number
}) {
  return (
    <SettingsCard>
      <div role="status" aria-busy="true">
        <span className="sr-only">{label}</span>
        {Array.from({ length: rows }, (_, slot) => (
          <div
            key={slot}
            className="flex min-h-[70px] items-center justify-between gap-6 border-b border-border/60 px-5 py-[15px] last:border-b-0"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <SkeletonBar className="h-3.5 w-40 max-w-full" delay={slot * 0.06} />
              <SkeletonBar
                className="h-3 w-2/3 max-w-[420px]"
                delay={slot * 0.06 + 0.05}
              />
              <div className="flex flex-wrap gap-2">
                <SkeletonBar
                  className="h-3 w-20 rounded-full"
                  delay={slot * 0.06 + 0.1}
                />
                <SkeletonBar
                  className="h-3 w-32 rounded-full"
                  delay={slot * 0.06 + 0.15}
                />
              </div>
            </div>
            <SkeletonBar
              className="h-5 w-9 shrink-0 rounded-full"
              delay={slot * 0.06 + 0.2}
            />
          </div>
        ))}
      </div>
    </SettingsCard>
  )
}

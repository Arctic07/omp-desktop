import type { ReactNode } from "react";
import { ThinkingShimmer } from "@/components/agents/loading-states/thinking-shimmer";
import { cn } from "@/lib/utils";

/**
 * The application's own loading mark, ported from the master desktop's `LoadingGrid.vue`
 * (beautifului's LoadingState «Drive»): a 3×3 pixel grid whose lit cell sweeps out of the middle
 * row, beside the wait's own shimmer label.
 *
 * The grid and its clock are decorative; the root's `role="status"` is what speaks, and the label
 * is the whole of what it announces. The delays light the cells on the same diagonal the master
 * uses (middle cell first, then out to both ends).
 */
const CELL_DELAYS_MS = [90, 180, 270, 0, 90, 180, 270, 90, 180] as const;

export function LoadingGrid({
  label,
  className,
}: {
  /** The wait's own words; omitted for a mark that only has to say "something is happening". */
  label?: ReactNode;
  className?: string;
}) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn("inline-flex items-center gap-2.5", className)}
    >
      <span aria-hidden="true" className="grid grid-cols-3 gap-[1.5px]">
        {CELL_DELAYS_MS.map((delay, index) => (
          <i
            // The grid is fixed geometry, so the index is its identity.
            key={index}
            className="size-1 rounded-[1px] bg-foreground opacity-15 animate-[omp-pixel-on_650ms_ease-in-out_infinite] motion-reduce:animate-none motion-reduce:opacity-40"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      {label ? <ThinkingShimmer className="text-[13px]">{label}</ThinkingShimmer> : null}
    </span>
  );
}

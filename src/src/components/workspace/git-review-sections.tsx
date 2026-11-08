/**
 * The review list's two section headers: one side's count, its totals, and the actions over the
 * whole side.
 *
 * Split out of `git-review.tsx` (`rules.md#single-file-line-limit`): the header is the one row of the list that acts
 * on a whole side instead of one file, and it is where the two sides differ. The file rows, the
 * commit box and the list that mounts them all stay beside the scroll surface they measure.
 */

import { ChevronRight, LoaderCircle, Minus, Plus, Undo2 } from "lucide-react";

import type { ReviewFile } from "@/api/git";
import type { GitReviewCopy } from "@/components/workspace/git-review-copy";
import { cn } from "@/lib/utils";
import { discardKeyOf, type GitReviewState, type ReviewSection } from "@/state/git-review-store";

/** One section's header: its count, its totals, and the actions over the whole side. */
export function SectionHeader({
  copy,
  review,
  section,
  label,
  files,
  additions,
  deletions,
}: {
  copy: GitReviewCopy;
  review: GitReviewState;
  section: ReviewSection;
  label: string;
  files: readonly ReviewFile[];
  additions: number;
  deletions: number;
}) {
  const expanded = review.isSectionExpanded(section);

  return (
    // The header's tail is the file row's own tail shape — the undo slot, the totals, then the
    // section action — so the totals sit exactly above the per-file numbers below.
    <header aria-label={label} className="flex items-center gap-1 px-2 py-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => review.toggleSection(section)}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
        />
        <span className="text-xs font-semibold">{label}</span>
        <span className="shrink-0 rounded-md bg-muted px-1.5 text-[11px] leading-4 text-muted-foreground">
          {files.length}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1.5">
        {section === "unstaged" ? (
          <SectionDiscard copy={copy} review={review} files={files} />
        ) : (
          // The staged side keeps the slot empty: a staged row is the index's own state, and the
          // discard that would touch it is the other side's business.
          <span aria-hidden="true" className="size-6 shrink-0" />
        )}
        <DiffStats additions={additions} deletions={deletions} />
        <SectionAction copy={copy} review={review} section={section} files={files} />
      </div>
    </header>
  );
}

/** One column of +/− numbers, fixed width and right-aligned so every row's pair lines up. */
export function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex w-16 shrink-0 items-center justify-end gap-1.5 font-mono text-[10px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
      <span className="text-rose-600 dark:text-rose-400">−{deletions}</span>
    </span>
  );
}

/**
 * The unstaged side's own undo: every change on that side, thrown away at once.
 *
 * It sits in the header's undo slot — the same `size-6` column the per-file buttons below line up
 * with — and repeats their two-step gesture: the first press arms it and names what the second will
 * do, so a click that lands over the list can never revert a side outright.
 */
function SectionDiscard({
  copy,
  review,
  files,
}: {
  copy: GitReviewCopy;
  review: GitReviewState;
  files: readonly ReviewFile[];
}) {
  const key = discardKeyOf("unstaged", "all");
  const armed = review.isDiscardArmed(key);
  const running = review.activeAction === key;
  const title = armed ? copy.discardAllConfirm : copy.discardAll;
  return (
    <button
      type="button"
      aria-label={title}
      aria-pressed={armed}
      title={title}
      disabled={files.length === 0 || review.gitBusy}
      onClick={() => review.discardSection("unstaged", files)}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
        armed
          ? "bg-destructive/10 text-destructive hover:bg-destructive/15"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {running ? (
        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
      ) : (
        <Undo2 aria-hidden="true" className="size-3.5" />
      )}
    </button>
  );
}

/** The section's one action: unstage everything on the staged side, stage everything on the other. */
function SectionAction({
  copy,
  review,
  section,
  files,
}: {
  copy: GitReviewCopy;
  review: GitReviewState;
  section: ReviewSection;
  files: readonly ReviewFile[];
}) {
  const running =
    review.activeAction === (section === "staged" ? "unstage:all" : "stage:all");
  return (
    <button
      type="button"
      aria-label={section === "staged" ? copy.unstageAll : copy.stageAll}
      title={section === "staged" ? copy.unstageAll : copy.stageAll}
      disabled={files.length === 0 || review.gitBusy}
      onClick={() => (section === "staged" ? review.unstageAll(files) : review.stageAll(files))}
      className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
    >
      {running ? (
        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
      ) : section === "staged" ? (
        <Minus aria-hidden="true" className="size-3.5" />
      ) : (
        <Plus aria-hidden="true" className="size-3.5" />
      )}
    </button>
  );
}

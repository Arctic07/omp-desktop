/**
 * The git review panel: what the workspace's changed tree looks like, and what the reader does to it.
 *
 * The desktop owns git (`src-tauri/src/services/git/**`); this component draws the answer and the
 * actions on it — two sections (staged / unstaged), each file row expanding to its own hunks inline,
 * a commit box whose message the engine can draft, and the sync that pulls before it pushes. Clicking
 * a file row opens the diff view (`git-diff-view.tsx`), which is the only place the diff renders full;
 * dragging one carries the file into the composer, the same gesture the file tree runs.
 *
 * State and tokens live in the hook (`state/git-review-store.ts`); this file renders it.
 */

import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  GitFork,
  Minus,
  Plus,
  LoaderCircle,
  Sparkles,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { AgentProgress } from "@/components/agents/loading-states/agent-progress";
import { Alert, AlertContent, AlertDescription, AlertIcon } from "@/components/motion/alert";
import { Button } from "@/components/motion/button";
import { GIT_REVIEW_COPY, type GitReviewCopy } from "@/components/workspace/git-review-copy";
import { GitDiffView } from "@/components/workspace/git-diff-view";
import { DiffStats, SectionHeader } from "@/components/workspace/git-review-sections";
import { BranchPicker } from "@/home/BranchPicker";
import type { ReviewFile, ReviewFileStatus, WorkspaceReview } from "@/api/git";
import { absolutePathOf } from "@/lib/file-path";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  beginFileDrag,
  cancelFileDrag,
  finishFileDrag,
  moveFileDrag,
} from "@/state/file-drag-store";
import { discardKeyOf, useGitReview, type GitReviewState, type ReviewSection } from "@/state/git-review-store";
import {
  subscribeWorkspaceChange,
  workspaceChangeRevision,
} from "@/state/workspace-watch-store";

/** The resolved copy the panel's subcomponents pass down. */
type GitCopy = GitReviewCopy;

export interface GitReviewPanelProps {
  /** The workspace root the tab was opened on, or null when it had none. */
  workspaceRoot: string | null;
  /** Whether this panel is the one on screen: a hidden one catches up when it is shown again. */
  active: boolean;
}

/** The letter a file row and the diff header both carry, one per status. */
const STATUS_LETTER: Record<ReviewFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

const STATUS_ROW_CLASS: Record<ReviewFileStatus, string> = {
  added: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  modified: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  deleted: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  renamed: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  untracked: "bg-muted text-muted-foreground",
};

function statusOf(file: ReviewFile): ReviewFileStatus {
  return (STATUS_LETTER as Record<string, string>)[file.status] !== undefined
    ? (file.status as ReviewFileStatus)
    : "modified";
}

/** The changed file's own name, which is what the rows are named by. */
function leafName(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] || normalized;
}

/** The directory part above the leaf, drawn smaller beside it. */
function dirName(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const cut = normalized.lastIndexOf("/");
  return cut <= 0 ? "" : normalized.slice(0, cut);
}

export function GitReviewPanel({ workspaceRoot, active }: GitReviewPanelProps) {
  const copy = useCopy(GIT_REVIEW_COPY);
  const review = useGitReview({ active, workspaceRoot });
  useWorkspaceChanges(review.noteChange);


  return (
    <section aria-label={copy.title} className="flex h-full min-h-0 flex-1 flex-col">
      {/* The branch row heads the changes area: where HEAD is, how far it has drifted, the
          repository it belongs to, and the picker that switches it. A workspace outside a working
          tree draws no row, and the wrapper takes no space for one. The outer 6px and the button's
          own 6px put the branch icon on the panel's 12px gutter — the one the header title, the
          tabs and every row below share — so the row reads as part of the panel rather than an
          inset card. */}
      <div className="shrink-0 px-1.5 pt-2 empty:hidden">
        <BranchPicker root={workspaceRoot} active={active} />
      </div>
      <header className="flex h-11 shrink-0 items-center gap-2 border-border border-b px-3">
        <h2 className="text-sm font-semibold">{copy.title}</h2>
        {review.phase === "content" ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {review.review?.clean ? copy.clean : copy.filesChanged(review.changedCount)}
          </span>
        ) : null}
        <div className="flex-1" />
        <button
          type="button"
          aria-label={copy.refresh}
          title={copy.refresh}
          disabled={workspaceRoot === null || review.loading || review.gitBusy}
          onClick={() => void review.refresh(false)}
          className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <LoaderCircle
            aria-hidden="true"
            className={cn("size-4", review.loading && "animate-spin")}
          />
        </button>
      </header>

      {/* The panel fills the tab's box; its review content owns the vertical scroll so the header stays
          visible while the commit controls and changed-file list extend below the viewport. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelBody copy={copy} review={review} />
      </div>
    </section>
  );
}

/** The one body the panel's phases draw, kept out of the header's re-render. */
function PanelBody({
  copy,
  review,
}: {
  copy: GitCopy;
  review: GitReviewState;
}) {
  if (review.phase === "no-workspace") {
    return (
      <EmptyState icon={<GitFork aria-hidden="true" className="size-6" />} title={copy.noWorkspace}>
        {copy.noWorkspaceHint}
      </EmptyState>
    );
  }
  if (review.phase === "loading") {
    return (
      <div className="flex items-center justify-center px-6 py-10">
        <AgentProgress label={copy.loading} />
      </div>
    );
  }
  if (review.phase === "error") {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <CircleAlert aria-hidden="true" className="size-6 text-destructive" />
        <p className="text-sm font-medium">{review.requestError ?? copy.readFailed}</p>
        <Button variant="outline" size="sm" onClick={() => void review.refresh(false)}>
          {copy.retry}
        </Button>
      </div>
    );
  }
  if (review.review === null) {
    return (
      <EmptyState icon={<CircleCheck aria-hidden="true" className="size-6" />} title={copy.empty} />
    );
  }
  if (!review.review.repo) {
    return (
      <EmptyState icon={<GitFork aria-hidden="true" className="size-6" />} title={copy.noRepository} />
    );
  }
  return <ReviewContent copy={copy} review={review} />;
}

/**
 * Reads the watch's revision and hands every change to the review.
 *
 * The subscription lives here rather than inside the hook so the hook stays a pure function of its
 * inputs; the reader hands the hook's own `noteChange` in, and the effect reads it through a ref
 * that an effect keeps current — a subscription must not be re-registered because the reader
 * re-created the callback.
 */
function useWorkspaceChanges(noteChange: (revision: number) => void) {
  const noteRef = useRef(noteChange);
  useEffect(() => {
    noteRef.current = noteChange;
  }, [noteChange]);
  useEffect(
    () =>
      subscribeWorkspaceChange(() => {
        noteRef.current(workspaceChangeRevision());
      }),
    [],
  );
}

function EmptyState({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-muted-foreground">
      {icon}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children ? <p className="text-xs leading-5">{children}</p> : null}
    </div>
  );
}

function ReviewContent({
  copy,
  review,
}: {
  copy: GitCopy;
  review: GitReviewState;
}) {
  const data = review.review;
  // Non-null by construction: every caller of this branch holds `review.review !== null`.
  if (data === null) return null;
  const selected = review.selectedFile;
  if (selected !== null) {
    return <GitDiffView file={selected} onBack={review.closeFile} />;
  }
  return <ReviewList copy={copy} review={review} data={data} />;
}

/**
 * One row of the review: the boxes above the list, a section header, or a file.
 *
 * The panel is one scroll surface, so the commit box, the notices and both sections are rows of
 * the same list. A tree can carry thousands of changed files now that the per-side ceiling is
 * gone; laying out every row would make the panel's first paint and every watch refresh cost the
 * whole tree, so only the rows in the window are mounted.
 */
type ReviewItem =
  | { kind: "refreshing"; key: string }
  | { kind: "request-error"; key: string }
  | { kind: "commit"; key: string }
  | { kind: "action-error"; key: string }
  | { kind: "truncated"; key: string }
  | {
      kind: "section";
      key: string;
      section: ReviewSection;
      label: string;
      files: readonly ReviewFile[];
      additions: number;
      deletions: number;
    }
  | { kind: "file"; key: string; section: ReviewSection; file: ReviewFile }
  | { kind: "empty"; key: string; clean: boolean };

/** The row's height before it has been measured: one line for the boxes, one file row otherwise. */
function estimateReviewItem(item: ReviewItem): number {
  switch (item.kind) {
    case "commit":
      return 150;
    case "empty":
      return 120;
    case "request-error":
    case "action-error":
      return 44;
    case "refreshing":
    case "truncated":
      return 28;
    case "section":
      return 34;
    case "file":
      return 32;
  }
}

function ReviewList({
  copy,
  review,
  data,
}: {
  copy: GitCopy;
  review: GitReviewState;
  data: WorkspaceReview;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const repositoryRoot = data.repositoryRoot ?? null;
  const stagedOpen = review.isSectionExpanded("staged");
  const unstagedOpen = review.isSectionExpanded("unstaged");

  const items = useMemo<ReviewItem[]>(() => {
    const rows: ReviewItem[] = [];
    if (review.loading) rows.push({ kind: "refreshing", key: "refreshing" });
    if (review.requestError !== null) rows.push({ kind: "request-error", key: "request-error" });
    rows.push({ kind: "commit", key: "commit" });
    if (review.actionError !== null) rows.push({ kind: "action-error", key: "action-error" });
    if (review.truncated) rows.push({ kind: "truncated", key: "truncated" });

    if (data.stagedFiles.length === 0 && data.unstagedFiles.length === 0) {
      rows.push({ kind: "empty", key: "empty", clean: data.clean });
      return rows;
    }

    // A section with nothing in it still draws its header: the action buttons carry the state
    // (disabled), and a hidden header would make "staged" appear and vanish as files move sides.
    const sections = [
      {
        section: "staged" as const,
        label: copy.staged,
        files: data.stagedFiles,
        open: stagedOpen,
      },
      {
        section: "unstaged" as const,
        label: copy.unstaged,
        files: data.unstagedFiles,
        open: unstagedOpen,
      },
    ];
    for (const { section, label, files, open } of sections) {
      let additions = 0;
      let deletions = 0;
      for (const file of files) {
        additions += file.additions;
        deletions += file.deletions;
      }
      rows.push({
        kind: "section",
        key: `section:${section}`,
        section,
        label,
        files,
        additions,
        deletions,
      });
      if (!open) continue;
      for (const file of files) {
        rows.push({ kind: "file", key: `${section}:${file.path}`, section, file });
      }
    }
    return rows;
  }, [
    copy.staged,
    copy.unstaged,
    data.clean,
    data.stagedFiles,
    data.unstagedFiles,
    review.actionError,
    review.loading,
    review.requestError,
    review.truncated,
    stagedOpen,
    unstagedOpen,
  ]);

  // oxlint-disable-next-line react/incompatible-library -- the same window the feed and diff view use.
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => scrollerRef.current,
    getItemKey: (index) => items[index]?.key ?? String(index),
    estimateSize: (index) => estimateReviewItem(items[index]!),
    overscan: 10,
    initialRect: { width: 420, height: 720 },
    useAnimationFrameWithResizeObserver: true,
  });

  /**
   * Aims the window at where the scroller actually is.
   *
   * The virtualizer reads its offset from the element's scroll events, and a browser clamp is not a
   * scroll: when the list gets shorter than the box (a section collapsed, files staged away) or the
   * box gets taller (the column or the window grew), the element's `scrollTop` is pulled back while
   * the model keeps the old, larger offset. The window is then computed from an offset past the end
   * of the content — everything but the last rows falls outside it, so the head of the list (the
   * commit box and the section headers) never mounts and the rows that do mount sit at their
   * absolute positions under a blank box. Reported 2026-10-20 as "展开收起 就顶部不见了".
   *
   * Reading the element back and re-aiming is what makes the model agree with the box again; the
   * two obey the same clamp, so it converges on the next render.
   */
  const aimAtScroller = useCallback(() => {
    const element = scrollerRef.current;
    if (element === null) return;
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    const at = Math.min(element.scrollTop, max);
    if (element.scrollTop !== at) element.scrollTop = at;
    if (virtualizer.scrollOffset !== at) {
      // `scrollToOffset` cannot repair this on its own: it records the intended position and waits
      // for the element's scroll event, and a box that is already at that position never fires one.
      // The event is the only thing the model reads, so the event is what is sent.
      element.dispatchEvent(new Event("scroll"));
    }
  }, [virtualizer]);

  // A render is what mounts a head row, so every render re-checks the aim (the effect runs after the
  // one that drew the empty box, and its correction is what draws the rows).
  useLayoutEffect(() => {
    aimAtScroller();
  });

  // The two boxes a clamp comes from: the scrollport's own, and the scrollable content's.
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => aimAtScroller());
    observer.observe(element);
    const content = element.firstElementChild;
    if (content instanceof HTMLElement) observer.observe(content);
    return () => observer.disconnect();
  }, [aimAtScroller]);

  return (
    <div ref={scrollerRef} className="h-full min-h-0 overflow-y-auto overscroll-contain pb-4">
      <div
        role="list"
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          if (item === undefined) return null;
          return (
            <div
              key={virtualRow.key}
              role={item.kind === "file" ? "listitem" : "presentation"}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute inset-x-0 top-0 flow-root"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <ReviewItemView
                copy={copy}
                review={review}
                item={item}
                repositoryRoot={repositoryRoot}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One item's own reading, with every panel kept out of the list's re-render path. */
function ReviewItemView({
  copy,
  review,
  item,
  repositoryRoot,
}: {
  copy: GitCopy;
  review: GitReviewState;
  item: ReviewItem;
  repositoryRoot: string | null;
}) {
  switch (item.kind) {
    case "refreshing":
      return (
        <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
          {copy.refreshing}
        </p>
      );
    case "request-error":
      return (
        <div
          role="alert"
          className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-destructive/40 px-2.5 py-1.5 text-xs text-destructive"
        >
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{review.requestError}</span>
          <button
            type="button"
            className="shrink-0 font-medium underline-offset-2 hover:underline"
            onClick={() => void review.refresh(false)}
          >
            {copy.retry}
          </button>
        </div>
      );
    case "commit":
      return <CommitBox copy={copy} review={review} />;
    case "action-error":
      return (
        <Alert variant="destructive" className="mx-3 mb-2 items-start gap-2 py-2 pr-2 pl-3 text-xs">
          <AlertIcon>
            <CircleAlert aria-hidden="true" className="size-3.5" />
          </AlertIcon>
          <AlertContent>
            <AlertDescription className="text-xs">{review.actionError}</AlertDescription>
          </AlertContent>
        </Alert>
      );
    case "truncated":
      return (
        <p role="note" className="px-3 py-1.5 text-xs text-muted-foreground">
          {copy.truncated}
        </p>
      );
    case "section":
      return (
        <SectionHeader
          copy={copy}
          review={review}
          section={item.section}
          label={item.label}
          files={item.files}
          additions={item.additions}
          deletions={item.deletions}
        />
      );
    case "file":
      return (
        <FileRow
          copy={copy}
          review={review}
          section={item.section}
          file={item.file}
          repositoryRoot={repositoryRoot}
        />
      );
    case "empty":
      return (
        <EmptyState
          icon={<CircleCheck aria-hidden="true" className="size-6" />}
          title={item.clean ? copy.clean : copy.empty}
        />
      );
  }
}

function CommitBox({
  copy,
  review,
}: {
  copy: GitCopy;
  review: GitReviewState;
}) {
  const label =
    review.primaryKind === "commit"
      ? review.primaryBusy
        ? copy.committing
        : copy.commit
      : review.primaryBusy
        ? copy.syncing
        : review.syncCount > 0
          ? copy.syncCount(review.syncCount)
          : copy.sync;
  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="omp-git-commit-message" className="text-xs font-medium text-muted-foreground">
          {copy.commitMessage}
        </label>
        <button
          type="button"
          disabled={review.gitBusy || review.stagedCount === 0}
          onClick={() => void review.draft()}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Sparkles aria-hidden="true" className="size-3" />
          {review.draftLoading ? copy.drafting : copy.draft}
        </button>
      </div>
      <textarea
        id="omp-git-commit-message"
        value={review.commitMessage}
        onChange={(event) => review.setCommitMessage(event.target.value)}
        placeholder={copy.commitPlaceholder}
        rows={2}
        disabled={review.gitBusy}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            if (review.primaryKind === "commit") void review.commit();
          }
        }}
        className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-[13px] leading-5 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
      />
      <Button
        size="sm"
        disabled={review.primaryDisabled}
        onClick={() => {
          if (review.primaryKind === "commit") void review.commit();
          else void review.sync();
        }}
        title={review.primaryKind === "sync" && review.branch ? copy.syncHint(review.branch.upstream) : label}
      >
        {review.primaryBusy ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null}
        {label}
      </Button>
    </div>
  );
}

/**
 * One hover-revealed action in the row's tail group.
 *
 * The tail's spacing rule is "one gap between every pair of neighbours", and a button that shows
 * only on hover must not break it: the slot is the same `size-6` box the section action uses, and
 * the glyph inside is centred, so the visual distance from the undo to the counts reads the same as
 * the counts to the stage button beside them.
 */
function RowAction({
  title,
  armed,
  running,
  onClick,
  children,
}: {
  title: string;
  armed?: boolean;
  running?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={title}
      aria-pressed={armed}
      title={title}
      disabled={running}
      onClick={onClick}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
        armed
          ? "text-destructive opacity-100"
          : "text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100",
        running === true && "opacity-100",
      )}
    >
      {running ? <LoaderCircle aria-hidden="true" className="size-3 animate-spin" /> : children}
    </button>
  );
}

function FileRow({
  copy,
  review,
  section,
  file,
  repositoryRoot,
}: {
  copy: GitCopy;
  review: GitReviewState;
  section: ReviewSection;
  file: ReviewFile;
  repositoryRoot: string | null;
}) {
  const status = statusOf(file);
  const expanded = review.isFileExpanded(section, file);
  const actionRunning =
    review.activeAction ===
    `${section === "staged" ? "unstage" : "stage"}:${file.path}`;
  const discardKey = discardKeyOf(section, file.path);
  // Only the unstaged side carries the discard; reading the armed state unconditionally is what
  // keeps the hook order stable while the spacer stands in for the button on the staged side.
  const discardArmed = section === "unstaged" && review.isDiscardArmed(discardKey);
  const movedRef = useRef(false);

  // The same pointer gesture the file tree runs (`state/file-drag-store.ts`): a changed file can be
  // dragged into the composer like any file on disk. HTML5 drag-and-drop cannot do it in this
  // window — Tauri's own file-drop channel is on, which is what makes an Explorer drop carry a
  // path — so the row runs the gesture itself. The row's path is repository-relative, so the
  // payload is built against the repository root rather than the workspace the panel was opened on.
  //
  // A deleted row names a file that is gone: it starts no drag at all, because the import would
  // refuse it and the reader would get a notice where the ghost promised a chip.
  const dragPath =
    repositoryRoot === null || status === "deleted"
      ? null
      : absolutePathOf(repositoryRoot, file.path);
  const dragName = leafName(file.path);

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragPath === null) return;
    if (event.button !== 0 || (event.pointerType !== "mouse" && event.pointerType !== "pen")) return;
    movedRef.current = false;
    const payload = { path: dragPath, name: dragName };
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;

    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const onMove = (move: PointerEvent) => {
      if (!moved) {
        if (Math.abs(move.clientX - start.x) + Math.abs(move.clientY - start.y) < 4) return;
        moved = true;
        movedRef.current = true;
        beginFileDrag(payload, { x: move.clientX, y: move.clientY });
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      moveFileDrag({ x: move.clientX, y: move.clientY });
    };
    const onUp = (up: PointerEvent) => {
      finish();
      if (!moved) return;
      up.preventDefault();
      finishFileDrag({ x: up.clientX, y: up.clientY });
    };
    const onCancel = () => {
      finish();
      cancelFileDrag();
    };
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      finish();
      cancelFileDrag();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  };

  return (
    <div className="rounded-lg px-1">
      <div className="group flex min-h-8 items-center gap-1 rounded-lg px-1 hover:bg-muted/50">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? copy.collapseFile(file.path) : copy.expandFile(file.path)}
          onClick={() => review.toggleFile(section, file)}
          className="grid size-5 shrink-0 place-items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("size-3 text-muted-foreground/70 transition-transform", expanded && "rotate-90")}
          />
        </button>
        <button
          type="button"
          aria-label={copy.openDiff(file.path)}
          title={copy.openDiff(file.path)}
          draggable={false}
          onPointerDown={handlePointerDown}
          onClick={() => {
            // A drag that ended back over its own row must not also open the diff view.
            if (movedRef.current) {
              movedRef.current = false;
              return;
            }
            review.openFile(section, file);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            aria-hidden="true"
            className={cn(
              "grid size-4 shrink-0 place-items-center rounded font-mono text-[9px] font-semibold",
              STATUS_ROW_CLASS[status],
            )}
          >
            {STATUS_LETTER[status]}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
            {dirName(file.path) ? (
              <span className="text-muted-foreground/70">{dirName(file.path)}/</span>
            ) : null}
            <span className="text-foreground">{leafName(file.path)}</span>
          </span>
        </button>
        {/* The row's tail is one fixed-shape group — undo · stats · stage — with the same gap
            between every pair of neighbours; the stats therefore hold one column across all rows
            and the section header, and the undo (hover-revealed) sits immediately left of the
            counts it would throw away. Every slot keeps its width whether or not it is visible,
            so nothing shifts when the buttons fade in. The undo exists only on the unstaged side:
            a staged row is the index's own state, and what the discard would restore is the other
            action's business — so its slot stays an empty spacer there, and the columns keep
            aligning across both sections. */}
        <div className="flex shrink-0 items-center gap-1.5">
          {section === "unstaged" ? (
            <RowAction
              title={discardArmed ? copy.discardConfirm(file.path) : copy.discard}
              armed={discardArmed}
              onClick={() => review.discardFiles(section, [file])}
            >
              <Undo2 aria-hidden="true" className="size-3" />
            </RowAction>
          ) : (
            <span aria-hidden="true" className="size-6 shrink-0" />
          )}
          <DiffStats additions={file.additions} deletions={file.deletions} />
          <RowAction
            title={section === "staged" ? copy.unstage : copy.stage}
            running={actionRunning}
            onClick={() => (section === "staged" ? review.unstageFile(file) : review.stageFile(file))}
          >
            {section === "staged" ? (
              <Minus aria-hidden="true" className="size-3" />
            ) : (
              <Plus aria-hidden="true" className="size-3" />
            )}
          </RowAction>
        </div>
      </div>
      {/* The collapsed body holds nothing (`AgentDisclosure` unmounts its children), so a long list
          of collapsed rows never tokenizes or lays out a single diff line. */}
      <AgentDisclosure open={expanded}>
        <FileHunks copy={copy} file={file} />
      </AgentDisclosure>
    </div>
  );
}

/** One file's own hunks, drawn inline under its row; the diff view is the full-surface version. */
function FileHunks({
  copy,
  file,
}: {
  copy: GitCopy;
  file: ReviewFile;
}) {
  if (file.binary) {
    return <RowMessage>{copy.binary}</RowMessage>;
  }
  if (file.tooLarge) {
    return <RowMessage>{copy.tooLarge}</RowMessage>;
  }
  if (file.hunks.length === 0) {
    return <RowMessage>{copy.noLineDetails}</RowMessage>;
  }
  return (
    <div className="mb-1 ml-6 flex flex-col overflow-hidden rounded-lg border border-border/70 bg-muted/40">
      {file.hunks.map((hunk, hunkIndex) => (
        <div key={`${hunkIndex}:${hunk.header}`}>
          <div
            className="truncate bg-muted/60 px-2 py-1 font-mono text-[10px] text-muted-foreground"
            title={hunk.header}
          >
            {hunk.header}
          </div>
          <div className="font-mono text-[11px] leading-[18px]">
            {hunk.lines.map((line, lineIndex) => (
              <div
                key={`${lineIndex}:${line.type}`}
                className={cn(
                  "grid grid-cols-[0.9rem_minmax(0,1fr)]",
                  line.type === "add" && "bg-emerald-500/[0.08]",
                  line.type === "del" && "bg-rose-500/[0.08]",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "select-none text-center",
                    line.type === "add" && "text-emerald-600 dark:text-emerald-400",
                    line.type === "del" && "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {line.type === "add" ? "+" : line.type === "del" ? "−" : ""}
                </span>
                <span className="min-w-0 break-all px-1 whitespace-pre-wrap text-foreground/85">
                  {line.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function RowMessage({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1 ml-6 rounded-lg border border-dashed border-border px-2 py-1.5 text-[11px] text-muted-foreground">
      {children}
    </p>
  );
}

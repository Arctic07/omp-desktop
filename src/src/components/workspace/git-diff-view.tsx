/**
 * The full diff view one file row opens: the file's own hunks, paired old/new columns, virtualized.
 *
 * The row's inline expansion (`git-review.tsx`) is the preview; this is the surface a reader opens
 * when they want the whole diff. It draws the diff and nothing else — there is no whole-file mode —
 * which is the difference from the desktop app's review panel. Rows are virtualized
 * (`@tanstack/react-virtual`) because a changed file's diff can be tens of thousands of lines.
 */

import { ChevronLeft, FileDiff as FileDiffIcon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ReviewFile } from "@/api/git";
import { GIT_REVIEW_COPY } from "@/components/workspace/git-review-copy";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface GitDiffViewProps {
  file: ReviewFile;
  onBack: () => void;
}

/** One render row: a hunk header, or one paired line. */
type DiffRenderRow =
  | { kind: "hunk"; key: string; header: string }
  | {
      kind: "line";
      key: string;
      oldNumber: number | null;
      newNumber: number | null;
      oldType: string | null;
      newType: string | null;
      oldText: string | null;
      newText: string | null;
    };

interface PairRow {
  oldNumber: number | null
  newNumber: number | null
  oldType: string | null
  newType: string | null
  oldText: string | null
  newText: string | null
}

/**
 * Pairs a hunk's lines into rows: a context line is its own pair, and a run of deletions and
 * additions is zipped side by side, the way a two-column diff reads.
 */
function pairLines(lines: ReviewFile["hunks"][number]["lines"], oldStart: number, newStart: number): PairRow[] {
  const rows: PairRow[] = [];
  let oldNumber = oldStart;
  let newNumber = newStart;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.type !== "add" && line.type !== "del") {
      rows.push({
        oldText: line.text,
        newText: line.text,
        oldNumber,
        newNumber,
        oldType: line.type,
        newType: line.type,
      });
      oldNumber += 1;
      newNumber += 1;
      index += 1;
      continue;
    }
    const deleted: string[] = [];
    const added: string[] = [];
    while (index < lines.length) {
      const change = lines[index];
      if (change === undefined || (change.type !== "add" && change.type !== "del")) break;
      if (change.type === "del") deleted.push(change.text);
      else added.push(change.text);
      index += 1;
    }
    const count = Math.max(deleted.length, added.length);
    for (let pair = 0; pair < count; pair += 1) {
      const oldText = deleted[pair] ?? null;
      const newText = added[pair] ?? null;
      rows.push({
        oldText,
        newText,
        oldNumber: oldText === null ? null : oldNumber,
        newNumber: newText === null ? null : newNumber,
        oldType: oldText === null ? null : "del",
        newType: newText === null ? null : "add",
      });
      if (oldText !== null) oldNumber += 1;
      if (newText !== null) newNumber += 1;
    }
  }
  return rows;
}

/** The `@@ -a,b +c,d @@` half of a hunk header, which is what the row numbers come from. */
function hunkStarts(header: string): { oldStart: number; newStart: number } | null {
  const match = /@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  if (match === null) return null;
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

function rowsOf(file: ReviewFile): DiffRenderRow[] {
  const rows: DiffRenderRow[] = [];
  file.hunks.forEach((hunk, hunkIndex) => {
    const starts = hunkStarts(hunk.header);
    rows.push({ kind: "hunk", key: `${hunkIndex}:h`, header: hunk.header });
    if (starts === null) return;
    pairLines(hunk.lines, starts.oldStart, starts.newStart).forEach((row, rowIndex) => {
      rows.push({ kind: "line", key: `${hunkIndex}:${rowIndex}`, ...row });
    });
  });
  return rows;
}

/** A line's estimate from its longer side: one 22px row per ~80 columns of code, one row minimum. */
function estimateRow(row: DiffRenderRow | undefined): number {
  if (row === undefined || row.kind === "hunk") return 24;
  const text = row.oldText ?? row.newText ?? "";
  return Math.max(1, Math.ceil(text.length / 80)) * 22;
}

export function GitDiffView({ file, onBack }: GitDiffViewProps) {
  const copy = useCopy(GIT_REVIEW_COPY);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => rowsOf(file), [file]);
  const hasRows = rows.some((row) => row.kind === "line");
  const unavailable = file.binary || file.tooLarge;

  // oxlint-disable-next-line react/incompatible-library -- the row model is `@tanstack/react-virtual`,
  // the same library the conversation feed uses; the compiler skips this component rather than
  // optimizing it, which is the price of the window.
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.key ?? String(index),
    estimateSize: (index) => estimateRow(rows[index]),
    overscan: 12,
    initialRect: { width: 480, height: 720 },
    useAnimationFrameWithResizeObserver: true,
  });

  // A new file opens at its top: the virtualizer's measurement cache is dropped with the rows, and
  // the offset is corrected once the first frame's real measurements are in.
  const rowSignature = rows.length > 0 ? rows[0]!.key : "";
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    virtualizer.measure();
    const frame = requestAnimationFrame(() => {
      virtualizer.scrollToOffset(0);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one reset per opened file
  }, [file.path, rowSignature]);

  const fileName = file.path.replaceAll("\\", "/").split("/").pop() ?? file.path;

  return (
    <section aria-label={fileName} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-border border-b px-2">
        <button
          type="button"
          aria-label={copy.diffBack}
          title={copy.diffBack}
          onClick={onBack}
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft aria-hidden="true" className="size-3.5" />
          {copy.diffBack}
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs font-medium">{fileName}</span>
          <span className="truncate font-mono text-[10px] text-muted-foreground/80">{file.path}</span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
          <span className="text-rose-600 dark:text-rose-400">−{file.deletions}</span>
        </span>
      </header>

      {unavailable ? (
        <DiffState icon={<FileDiffIcon aria-hidden="true" className="size-6" />} title={file.binary ? copy.diffBinary : copy.diffTooLarge} />
      ) : !hasRows ? (
        <DiffState icon={<FileDiffIcon aria-hidden="true" className="size-6" />} title={copy.diffEmpty} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            aria-hidden="true"
            className="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-border border-b bg-muted/40 text-[10px] tracking-wide text-muted-foreground uppercase"
          >
            <span className="border-border/60 border-r px-2 py-1">{copy.diffOld}</span>
            <span className="px-2 py-1">{copy.diffNew}</span>
          </div>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" role="region" aria-label={`${copy.diffOld} / ${copy.diffNew}`}>
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index];
                if (row === undefined) return null;
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className="absolute inset-x-0 top-0"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {row.kind === "hunk" ? (
                      <div
                        className="bg-muted/60 px-2 py-1 font-mono text-[10px] break-all text-muted-foreground"
                        title={row.header}
                      >
                        {row.header}
                      </div>
                    ) : (
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                        <DiffCell
                          number={row.oldNumber}
                          marker={row.oldType === "del" ? "−" : row.oldType === null ? "" : ""}
                          type={row.oldType}
                          text={row.oldText ?? ""}
                        />
                        <DiffCell
                          number={row.newNumber}
                          marker={row.newType === "add" ? "+" : ""}
                          type={row.newType}
                          text={row.newText ?? ""}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function DiffCell({
  number,
  marker,
  type,
  text,
}: {
  number: number | null;
  marker: string;
  type: string | null;
  text: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[2.4rem_0.9rem_minmax(0,1fr)] border-border/60 border-r font-mono text-[11px] leading-[22px]",
        type === "add" && "bg-emerald-500/[0.08]",
        type === "del" && "bg-rose-500/[0.08]",
        type === null && "bg-muted/[0.35]",
      )}
    >
      <span className="pr-1 text-right tabular-nums text-muted-foreground/50 select-none">
        {number ?? ""}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "text-center select-none",
          type === "add" && "text-emerald-600 dark:text-emerald-400",
          type === "del" && "text-rose-600 dark:text-rose-400",
        )}
      >
        {marker}
      </span>
      <span className="min-w-0 px-1 whitespace-pre-wrap break-all text-foreground/85">{text}</span>
    </div>
  );
}

function DiffState({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center text-muted-foreground">
      {icon}
      <p className="text-sm font-medium text-foreground">{title}</p>
    </div>
  );
}

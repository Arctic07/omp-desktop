import {
  Check,
  Circle,
  ExternalLink,
  FileText,
  Globe2,
  ImageIcon,
  LoaderCircle,
  MessageSquare,
  PencilLine,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/ease";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Markdown } from "@/components/agents/markdown";
import { useCopy, type Localized } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type {
  AgentActivityItem,
  AgentActivitySearch,
  AgentActivityStep,
  AgentActivityText,
  AgentActivityTool,
  AgentActivityTrace,
  AgentSearchResult,
} from "./types";

/** The tool actions the row knows; anything else reads as `other`. */
type ToolActionLabel = "read" | "edit" | "write" | "run" | "other";

interface ActivityRowCopy {
  /** The verb a tool row shows in front of its target. */
  actionLabels: Readonly<Record<ToolActionLabel, string>>;
  /** The further results a search row did not show. */
  moreResults: (count: number) => string;
}

const COPY: Localized<ActivityRowCopy> = {
  en: {
    actionLabels: {
      read: "Read",
      edit: "Edit",
      write: "Write",
      run: "Run",
      other: "Tool",
    },
    moreResults: (count) => `+${count} more`,
  },
  zh: {
    actionLabels: {
      read: "读取",
      edit: "编辑",
      write: "写入",
      run: "运行",
      other: "工具",
    },
    moreResults: (count) => `还有 ${count} 项`,
  },
};

function StepRow({ item }: { item: AgentActivityStep }) {
  const state = item.status ?? "complete";

  return (
    <div className="flex min-h-7 items-start gap-2.5 rounded-md px-1.5 py-1">
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-4 shrink-0 place-items-center text-muted-foreground/70"
      >
        {state === "complete" ? (
          <Check className="size-4" strokeWidth={1.8} />
        ) : state === "active" ? (
          <span className="relative grid size-3 place-items-center">
            <motion.span
              className="absolute inset-0 rounded-full bg-foreground/10"
              animate={{ opacity: [0.35, 0.8, 0.35] }}
              transition={{ duration: 1.5, repeat: Number.POSITIVE_INFINITY }}
            />
            <span className="size-1.5 rounded-full bg-foreground/60" />
          </span>
        ) : (
          <Circle className="size-3" strokeWidth={1.5} />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 leading-5",
          state === "pending" ? "text-muted-foreground/55" : "text-foreground/90",
        )}
      >
        {item.label}
      </span>
      {item.meta ? (
        <span className="shrink-0 leading-5 text-muted-foreground/55">
          {item.meta}
        </span>
      ) : null}
    </div>
  );
}

function TextRow({ item }: { item: AgentActivityText }) {
  return (
    <div className="rounded-md px-1.5 py-1 leading-5 text-muted-foreground">
      {item.content}
    </div>
  );
}

function SearchResultRow({
  result,
}: {
  result: AgentSearchResult;
}) {
  const content = (
    <>
      <span
        aria-hidden="true"
        className="grid size-5 shrink-0 place-items-center text-muted-foreground"
      >
        {result.icon ?? <Globe2 className="size-3" strokeWidth={2} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate font-medium text-foreground/90">
            {result.title}
          </span>
          {result.domain ? (
            <span className="shrink-0 truncate text-[10px] text-muted-foreground/55">
              {result.domain}
            </span>
          ) : null}
        </span>
        {result.snippet ? (
          <span className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
            {result.snippet}
          </span>
        ) : null}
      </span>
      {result.url ? (
        <ExternalLink
          aria-hidden="true"
          className="mt-0.5 size-3 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100"
        />
      ) : null}
    </>
  );
  const className = cn(
    "group flex min-h-7 items-start gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors",
    result.url && "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
  );

  return result.url ? (
    <a href={result.url} target="_blank" rel="noreferrer" className={className}>
      {content}
    </a>
  ) : (
    <div className={className}>{content}</div>
  );
}

function SearchRow({ item }: { item: AgentActivitySearch }) {
  const copy = useCopy(COPY);
  const reduce = useReducedMotion() ?? false;
  const enter = reduce ? { opacity: 1 } : { opacity: 0, y: 6 };
  const visible = { opacity: 1, y: 0 };
  const exit = reduce ? { opacity: 0 } : { opacity: 0, y: -3 };
  const transition = reduce
    ? { duration: 0 }
    : {
        opacity: { duration: 0.18, ease: EASE_OUT },
        y: SPRING_LAYOUT,
        layout: SPRING_LAYOUT,
      };

  return (
    <div className="space-y-0.5">
      <div className="flex min-h-7 items-center gap-2.5 rounded-md px-1.5 py-1 text-muted-foreground">
        <Search aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.7} />
        <span className="min-w-0 flex-1 truncate">{item.query}</span>
        {item.results?.length ? (
          <AnimatedBadge status="neutral" size="sm" animated={false} showIcon={false}>
            {String(item.results.length)}
          </AnimatedBadge>
        ) : null}
      </div>
      {/* The answer leads when the provider wrote one: it is the prose the reader asked for, and
          the sources below are the evidence for it. Drawn at the row's own small size (the CSS
          variable the transcript's markdown column reads) rather than at full message size, so a
          card inside a tool row does not read as a second message. */}
      {item.answer ? (
        <div className="min-w-0 px-1.5 pb-1 pl-8">
          <Markdown
            text={item.answer}
            className="[--omp-content-font-size:0.75rem] leading-5 text-foreground/80"
          />
        </div>
      ) : null}
      {item.results?.length ? (
        <div className="space-y-0.5 pl-4">
          <AnimatePresence initial mode="popLayout">
            {item.results.map((result) => (
              <motion.div
                layout="position"
                key={result.id}
                initial={enter}
                animate={visible}
                exit={exit}
                transition={transition}
              >
                <SearchResultRow result={result} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      ) : null}
      <AnimatePresence initial>
        {item.moreCount ? (
          <motion.div
            key="more-results"
            initial={enter}
            animate={visible}
            exit={exit}
            transition={transition}
            className="px-1.5 py-1 pl-8 text-muted-foreground/55"
          >
            {copy.moreResults(item.moreCount)}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ActionIcon({ action }: { action: string }) {
  if (action === "read") return <FileText className="size-4" />;
  if (action === "edit" || action === "write") {
    return <PencilLine className="size-4" />;
  }
  if (action === "run") return <SquareTerminal className="size-4" />;
  return <Wrench className="size-4" />;
}

/** The four verbs the row names; anything else reads as `other`. */
function isToolAction(
  action: string,
): action is Exclude<ToolActionLabel, "other"> {
  return (
    action === "read" ||
    action === "edit" ||
    action === "write" ||
    action === "run"
  );
}

function ToolRow({ item }: { item: AgentActivityTool }) {
  const copy = useCopy(COPY);
  const action = copy.actionLabels[
    isToolAction(item.action) ? item.action : "other"
  ];

  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2.5 rounded-md px-1.5 py-0.5 leading-5">
      <span
        aria-hidden="true"
        className="grid size-4 shrink-0 place-items-center text-muted-foreground/70"
      >
        <ActionIcon action={item.action} />
      </span>
      <span className="shrink-0 font-medium text-foreground/90">{action}</span>
      <span className="min-w-0 flex-1 truncate rounded-lg bg-muted/80 px-2.5 py-1 font-mono text-xs text-muted-foreground/70">
        {item.target}
      </span>
      {typeof item.additions === "number" || typeof item.deletions === "number" ? (
        <span className="flex shrink-0 items-center gap-2 font-mono tabular-nums">
          {typeof item.additions === "number" ? (
            <span className="text-emerald-500">+{item.additions}</span>
          ) : null}
          {typeof item.deletions === "number" ? (
            <span className="text-rose-500">−{item.deletions}</span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function TraceIcon({ kind }: { kind: AgentActivityTrace["kind"] }) {
  if (kind === "thinking") return <Sparkles className="size-4" />;
  if (kind === "message") return <MessageSquare className="size-4" />;
  if (kind === "write") return <PencilLine className="size-4" />;
  if (kind === "run") return <SquareTerminal className="size-4" />;
  if (kind === "read") return <ImageIcon className="size-4" />;
  return <Wrench className="size-4" />;
}

/**
 * One traced step: an icon, its label, and whatever it reported beside them.
 *
 * With a handler the line is a button — the trace stands for something the reader can open (a
 * `task` call's child, whose own conversation has a tab) — and without one it is the plain line it
 * has always been: same box, same grid, same three cells.
 */
function TraceRow({
  item,
  onSelect,
}: {
  item: AgentActivityTrace;
  onSelect?: (item: AgentActivityItem) => void;
}) {
  const content = (
    <>
      <span
        aria-hidden="true"
        className="grid size-4 place-items-center text-muted-foreground/70"
      >
        {item.mark === "running" ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : item.mark === "done" ? (
          <Check className="size-3.5 text-emerald-500" />
        ) : item.mark === "idle" ? (
          <Circle className="size-3 text-muted-foreground/55" />
        ) : item.mark === "failed" ? (
          <X className="size-3.5 text-destructive" />
        ) : (
          (item.icon ?? <TraceIcon kind={item.kind} />)
        )}
      </span>
      <span className="font-medium text-foreground/90">{item.label}</span>
      {item.detail ? (
        <span className="min-w-0 truncate rounded-lg bg-muted/80 px-2.5 py-1 font-mono text-xs text-muted-foreground/70">
          {item.detail}
        </span>
      ) : (
        <span />
      )}
      {item.markLabel ? <span className="sr-only">{item.markLabel}</span> : null}
    </>
  );
  // The body this roster sits in is the column's own width (`tool-result.tsx`), so the trace starts
  // on the left edge of the card that spawned it: any horizontal padding here puts every child row
  // inside the call's own edge (2026-10-20, restated 2026-10-28 when `pl-6` came off the body).
  const className =
    "grid min-h-8 grid-cols-[1rem_auto_minmax(0,1fr)] items-center gap-2 rounded-md pr-1.5 py-0.5";

  if (onSelect === undefined) return <div className={className}>{content}</div>;
  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      // `text-left` is what keeps the button's own centring out of the row: the grid places the
      // three cells, and the label inside them still reads from the left.
      className={cn(
        className,
        "w-full text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {content}
    </button>
  );
}

/**
 * One row of the run.
 *
 * `onSelect` is passed down from the caller and reaches only the trace row, which is the one kind
 * whose item can stand for something openable here. Every other kind draws exactly what it drew
 * before, handler or not.
 */
export function ActivityRow({
  item,
  onSelect,
}: {
  item: AgentActivityItem;
  onSelect?: (item: AgentActivityItem) => void;
}) {
  if (item.type === "text") return <TextRow item={item} />;
  if (item.type === "search") return <SearchRow item={item} />;
  if (item.type === "tool") return <ToolRow item={item} />;
  if (item.type === "trace") return <TraceRow item={item} onSelect={onSelect} />;
  return <StepRow item={item} />;
}

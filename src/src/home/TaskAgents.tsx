import { Ban, Bot, ChevronRight, Circle, CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { useCopy } from "@/lib/i18n";
import { formatTokenCount } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/home/conversation-format";
import { COPY } from "@/home/homeCopy";
import { taskLabel, type RosterEntry } from "@/home/task-roster";
import { modelIdOf } from "@/state/model-store";

/**
 * The children one `task` call ran, as the card the call's body leads with.
 *
 * A batch is a heading and a short list. The heading states how many children there are, the models
 * they resolved (the ids only, one line, when a batch mixed them) and how far the batch has come
 * (`done / total`, in the batch's own colour). Each row is one child: its state mark, its name, the
 * `done / total` column's own two digits, and the way in — clicking it opens that child's
 * conversation in the tool column.
 *
 * The row states what a child *is*, not what it has run up. Call counts, tokens, time, the task book
 * and the child's recent calls are its conversation's own content; drawing them here as well made a
 * batch of six children a wall of figures nobody asked for, and the card is the roster, not a second
 * transcript.
 */
export interface TaskAgentsProps {
  rows: readonly RosterEntry[];
  /** Opens one child's own conversation beside this one; absent where there is nowhere to open it. */
  onOpenSubagent?: (childId: string, label: string) => void;
}

function isLive(row: RosterEntry): boolean {
  return row.status === "running" || row.status === "pending";
}

function settled(row: RosterEntry): boolean {
  return row.status === "completed" || row.status === "failed" || row.status === "aborted";
}

function StateMark({ status }: { status: string }) {
  if (status === "completed") {
    return <CircleCheck aria-hidden="true" className="size-3.5 text-emerald-600 dark:text-emerald-400" />;
  }
  // An abort is the reader's own stop, not a failure: it gets the same slash the tool rows use for
  // a cancelled call rather than the × a failed child gets (2026-10-23, reader report: 中止后
  // task 的总状态仍是 已完成 — the batch's own ending has to be tellable apart from a failure).
  if (status === "aborted") {
    return <Ban aria-hidden="true" className="size-3.5 text-muted-foreground" />;
  }
  if (status === "failed") {
    return <CircleX aria-hidden="true" className="size-3.5 text-rose-600 dark:text-rose-400" />;
  }
  if (status === "running" || status === "pending") {
    return (
      <LoaderCircle
        aria-hidden="true"
        className="size-3.5 animate-spin text-blue-600 dark:text-blue-400"
      />
    );
  }
  return <Circle aria-hidden="true" className="size-3.5 text-muted-foreground/40" />;
}

/** One child: a line the reader can read at a glance, and — where there is one — the way into it. */
function AgentRow({
  row,
  label,
  ordinal,
  onOpen,
}: {
  row: RosterEntry;
  label: string;
  /** Its place in the list, as the two digits the head's trailing column prints. */
  ordinal: string;
  onOpen: (() => void) | undefined;
}) {
  const copy = useCopy(COPY);
  // A row that cannot be opened is the only place its figures survive: everywhere else they are the
  // child's conversation's own.
  const detail =
    onOpen === undefined
      ? [
          row.toolCount !== null ? copy.toolCalls(row.toolCount) : "",
          row.tokens !== null && row.tokens > 0 ? `${formatTokenCount(row.tokens)} tok` : "",
          row.durationMs !== null ? formatDuration(row.durationMs) : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "";

  const head = (
    <>
      <span className="grid size-4 shrink-0 place-items-center">
        <StateMark status={row.status} />
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          row.status === "failed"
            ? "text-rose-600 dark:text-rose-400"
            : row.status === "aborted"
              ? "text-muted-foreground"
              : "text-foreground/90",
        )}
      >
        {label}
      </span>
      {row.exitCode !== null && row.exitCode !== 0 ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-rose-600 dark:text-rose-400">
          {copy.taskAgentExit(String(row.exitCode))}
        </span>
      ) : null}
      {row.truncated ? (
        <span className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground/60">
          {copy.taskAgentTruncated}
        </span>
      ) : null}
      {detail !== "" ? (
        <span className="max-w-[50%] shrink truncate text-[11px] tabular-nums whitespace-nowrap text-muted-foreground/60">
          {detail}
        </span>
      ) : null}
      <span
        aria-hidden="true"
        className="w-4 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/50"
      >
        {ordinal}
      </span>
      {onOpen === undefined ? (
        <span aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/50" />
      )}
    </>
  );

  return (
    <li className="min-w-0">
      {onOpen === undefined ? (
        <div className="flex min-h-7 min-w-0 items-center gap-2 px-1.5 py-0.5">{head}</div>
      ) : (
        <button
          type="button"
          aria-label={`${copy.taskAgentOpen}: ${label}`}
          onClick={onOpen}
          className="flex min-h-7 w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-0.5 text-left outline-none transition-colors hover:bg-background/60 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {head}
        </button>
      )}
    </li>
  );
}

export function TaskAgents({ rows, onOpenSubagent }: TaskAgentsProps) {
  const copy = useCopy(COPY);

  if (rows.length === 0) return null;
  const running = rows.filter(isLive).length;
  // Only a child that failed colours the counter red. An aborted child is the reader's own stop, so
  // it counts as settled (and is drawn with the cancelled mark) rather than as a failure — the
  // batch's ending then matches the badge, which states 已取消 for the same reason.
  const failed = rows.filter((row) => row.status === "failed").length;
  const done = rows.filter(settled).length;
  const tone =
    running > 0
      ? "text-blue-600 dark:text-blue-400"
      : failed > 0
        ? "text-rose-600 dark:text-rose-400"
        : "text-muted-foreground/70";
  const detached = rows.some((row) => row.detached);
  // The models the batch resolved, one line under the count. A task can be spawned with its own
  // model, so this answers "which model did this work" without a chip on every row; the ids only,
  // since the provider key is the engine's (2026-10-21, user request).
  const models = [...new Set(rows.flatMap((row) => (row.model === null ? [] : [modelIdOf(row.model)])))];
  const modelLine = models.join(" · ");

  return (
    <section aria-label={copy.taskAgents(rows.length)} className="flex min-w-0 flex-col">
      <header className="flex min-w-0 items-center gap-2 px-1 pb-1.5">
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-lg bg-background/60 text-muted-foreground ring-1 ring-border/60"
        >
          <Bot className="size-4" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-medium text-foreground/90">
              {copy.taskAgents(rows.length)}
            </span>
            {detached ? (
              // The pill says "后台" and nothing more: a neutral status glyph in front of the word is
              // decoration the reader did not ask for (2026-10-21, user report).
              <AnimatedBadge status="neutral" size="sm" animated={false} showIcon={false}>
                {copy.taskAgentDetached}
              </AnimatedBadge>
            ) : null}
          </span>
          {modelLine !== "" ? (
            <span
              title={rows.map((row) => row.model).filter(Boolean).join("\n")}
              className="truncate font-mono text-[10px] leading-4 text-muted-foreground/60"
            >
              {modelLine}
            </span>
          ) : null}
        </span>
        <span
          className={cn("ml-auto shrink-0 text-[11px] font-medium tabular-nums", tone)}
          aria-hidden="true"
        >
          {`${done} / ${rows.length}`}
        </span>
      </header>
      <ul className="flex min-w-0 flex-col">
        {rows.map((row, index) => {
          const label =
            taskLabel(row.description) || taskLabel(row.assignment) || row.agent || copy.taskAgents(1);
          return (
            <AgentRow
              key={row.id}
              row={row}
              label={label}
              ordinal={String(index + 1).padStart(2, "0")}
              onOpen={
                onOpenSubagent === undefined ? undefined : () => onOpenSubagent(row.id, label)
              }
            />
          );
        })}
      </ul>
    </section>
  );
}

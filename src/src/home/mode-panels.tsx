import { Bot, ChevronDown, FileText, Repeat, Target } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/motion/button";
import { StatusMark, type ConversationStatus } from "@/components/agents/status-mark";
import { sendPrompt } from "@/state/session-send";
import { useCopy } from "@/lib/i18n";
import { formatDuration } from "@/home/conversation-format";
import { COPY } from "@/home/homeCopy";
import type { SessionGoalMode, SessionLoopMode, SessionPlanMode, SessionVibeWorker, SubagentRow } from "@/api/session-types";
import { sessionStore, type SessionStoreState } from "@/state/session-store";
import { useStoreSelector } from "@/state/store";

/** The live roster rows for this conversation's children, by id (one object per frame). */
const NO_SUBAGENTS: Record<string, SubagentRow> = {};
const selectSubagents = (state: SessionStoreState): Record<string, SubagentRow> =>
  state.activeId === null ? NO_SUBAGENTS : (state.records[state.activeId]?.subagents ?? NO_SUBAGENTS);

/**
 * The panels behind the mode tabs: goal, plan mode, and the vibe worker fleet.
 *
 * They share the row above the composer with the plan and background-work panels and use the same
 * shape (`ConversationBlocks`'s `BackgroundJobsPanel`): one bordered section, a header that closes
 * it, and rows at one height. What differs is the content — a mode is a fact about the
 * conversation, not a task to tick off, so the goal panel reads as a small report and the vibe
 * panel as the fleet's roster.
 */

interface ModePanelProps {
  onCollapse: () => void;
}

/** One labelled row: a name in the muted column, its value in the reader's. */
function ModeRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3 px-1.5 py-1">
      <span className="w-20 shrink-0 pt-0.5 text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1 text-sm text-foreground/90">{children}</div>
    </div>
  );
}

function PanelHeader({
  icon,
  title,
  count,
  onCollapse,
}: {
  icon: ReactNode;
  title: string;
  count?: number;
  onCollapse: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded
      onClick={onCollapse}
      className="group flex h-11 w-full items-center gap-2.5 rounded-2xl px-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="grid size-6 shrink-0 place-items-center text-muted-foreground">{icon}</span>
      <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">{title}</h3>
      {count === undefined ? null : (
        <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
      <ChevronDown
        aria-hidden="true"
        className="size-3.5 shrink-0 rotate-180 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
      />
    </button>
  );
}

/** The row of real exit controls a mode's panel carries. */
function ModeActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1.5 px-1.5 pt-1 pb-0.5">{children}</div>;
}

/** One action that runs a command in this conversation, exactly as typing it would. */
function ModeAction({ command, label }: { command: string; label: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 px-2 text-[11px]"
      onClick={() => void sendPrompt(command)}
    >
      {label}
    </Button>
  );
}

/** One `--while`/`--until`-free budget reading: `used / budget`, or `used (no budget)`. */
function goalTokens(goal: SessionGoalMode): string {
  const used = goal.tokensUsed.toLocaleString();
  return goal.tokenBudget === null ? `${used} (no budget)` : `${used} / ${goal.tokenBudget.toLocaleString()}`;
}

/** The goal mode's own report: what it is, where it stands, and what it has spent. */
export function GoalPanel({ goal, onCollapse }: ModePanelProps & { goal: SessionGoalMode }) {
  const copy = useCopy(COPY);
  return (
    <section className="w-full overflow-hidden rounded-2xl border border-border/70">
      <PanelHeader icon={<Target aria-hidden="true" className="size-4" />} title={copy.goalTitle} onCollapse={onCollapse} />
      <div className="scrollbar-hide max-h-[220px] overflow-y-auto px-2 pb-2">
        <ModeRow label={copy.goalObjective}>
          <p className="whitespace-pre-wrap break-words leading-5">{goal.objective}</p>
        </ModeRow>
        <ModeRow label={copy.goalStatus}>
          <span className="tabular-nums">
            {goal.status}
            {goal.enabled ? "" : copy.goalPausedSuffix}
          </span>
        </ModeRow>
        <ModeRow label={copy.goalTokens}>
          <span className="tabular-nums">{goalTokens(goal)}</span>
        </ModeRow>
        <ModeRow label={copy.goalTime}>
          <span className="tabular-nums">{formatSeconds(goal.timeUsedSeconds)}</span>
        </ModeRow>
        <ModeActions>
          {goal.enabled ? (
            <ModeAction command="/goal pause" label={copy.goalActionPause} />
          ) : (
            <ModeAction command="/goal resume" label={copy.goalActionResume} />
          )}
          <ModeAction command="/goal drop" label={copy.goalActionDrop} />
        </ModeActions>
      </div>
    </section>
  );
}

/** Plan mode's own report: the file the agent is writing, and what approval will do. */
export function PlanModePanel({ plan, onCollapse }: ModePanelProps & { plan: SessionPlanMode }) {
  const copy = useCopy(COPY);
  return (
    <section className="w-full overflow-hidden rounded-2xl border border-border/70">
      <PanelHeader icon={<FileText aria-hidden="true" className="size-4" />} title={copy.planModeTitle} onCollapse={onCollapse} />
      <div className="px-2 pb-3">
        <ModeRow label={copy.planFile}>
          <code className="break-all font-mono text-xs leading-5">{plan.planFilePath}</code>
        </ModeRow>
        <p className="px-1.5 pt-1 text-xs leading-5 text-muted-foreground">{copy.planModeHint}</p>
        <ModeActions>
          <ModeAction command="/plan-review" label={copy.planActionReview} />
          <ModeAction command="/plan" label={copy.planActionLeave} />
        </ModeActions>
      </div>
    </section>
  );
}

/** Loop mode's own report: the prompt that repeats, and what bounds the repeats. */
export function LoopPanel({ loop, onCollapse }: ModePanelProps & { loop: SessionLoopMode }) {
  const copy = useCopy(COPY);
  return (
    <section className="w-full overflow-hidden rounded-2xl border border-border/70">
      <PanelHeader icon={<Repeat aria-hidden="true" className="size-4" />} title={copy.loopTitle} onCollapse={onCollapse} />
      <div className="px-2 pb-3">
        <ModeRow label={copy.loopPrompt}>
          {loop.prompt === undefined ? (
            <span className="text-muted-foreground">{copy.loopNoPrompt}</span>
          ) : (
            <p className="whitespace-pre-wrap break-words leading-5">{loop.prompt}</p>
          )}
        </ModeRow>
        {loop.limit === undefined ? null : (
          <ModeRow label={copy.loopLimit}>
            <span className="tabular-nums">{loop.limit}</span>
          </ModeRow>
        )}
        {loop.condition === undefined ? null : (
          <ModeRow label={copy.loopCondition}>
            <code className="break-all font-mono text-xs leading-5">{loop.condition}</code>
          </ModeRow>
        )}
        {loop.paused ? (
          <p className="px-1.5 pt-1 text-xs leading-5 text-muted-foreground">{copy.loopPaused}</p>
        ) : null}
        <ModeActions>
          <ModeAction command="/loop" label={copy.loopActionOff} />
        </ModeActions>
      </div>
    </section>
  );
}

/**
 * A worker's state word as the mark the left rail draws for a conversation.
 *
 * The row's word comes from one of two places — the engine's fleet snapshot (`VibeSessionState`:
 * `starting` / `running` / `idle` / `dead`) or the live child roster (`pending` / `running` /
 * `completed` / `failed` / `aborted`), which wins where it reports — so both vocabularies land on
 * the rail's five glyphs instead of inventing a second set of dots for this panel.
 */
function workerMark(state: string): ConversationStatus {
  switch (state) {
    case "running":
      return "running";
    case "starting":
    case "pending":
      return "pending";
    case "failed":
      return "error";
    case "dead":
    case "aborted":
      return "cancelled";
    default:
      // `idle` and `completed` are settled, and a settled row carries no mark at all — the same
      // rule the rail's own completed conversations follow.
      return "completed";
  }
}

/** One worker: tier, state, model, turns, and what it is doing now. */
function WorkerRow({
  worker,
  nowMs,
  onOpen,
}: {
  worker: SessionVibeWorker;
  nowMs: number;
  onOpen?: () => void;
}) {
  const copy = useCopy(COPY);
  const activity =
    worker.lastIntent ?? worker.currentTool ?? worker.turnMessage ?? copy.vibeWorkerIdle;
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm leading-5 text-foreground/90">{worker.id}</span>
          <span className="shrink-0 rounded-full border border-border/70 px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {worker.cli}
          </span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{activity}</span>
          <span className="shrink-0 tabular-nums">
            {copy.vibeWorkerTurns(worker.turns)}
            {worker.queued > 0 ? ` · ${copy.vibeWorkerQueued(worker.queued)}` : ""}
          </span>
        </span>
      </span>
      {/* One right-hand column, so every row's state mark sits on the same edge: the elapsed turn
          reading to its left, the mark itself last. */}
      <span className="flex shrink-0 items-center gap-2 text-muted-foreground/55">
        {worker.turnStartedAt === undefined ? null : (
          <span className="text-xs tabular-nums">
            {formatDuration(nowMs - worker.turnStartedAt)}
          </span>
        )}
        <span
          role="img"
          aria-label={worker.state}
          className="grid size-3.5 place-items-center"
        >
          <StatusMark status={workerMark(worker.state)} />
        </span>
      </span>
    </>
  );
  if (onOpen === undefined) {
    return <li className="flex min-h-9 min-w-0 items-center gap-2.5 rounded-xl px-1.5 py-1">{body}</li>;
  }
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-xl px-1.5 py-1 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {body}
      </button>
    </li>
  );
}

/** The vibe fleet: every worker the director is driving, in spawn order. */
export function VibePanel({
  workers,
  onCollapse,
  onOpenWorker,
}: ModePanelProps & {
  workers: readonly SessionVibeWorker[];
  onOpenWorker?: (worker: SessionVibeWorker) => void;
}) {
  const copy = useCopy(COPY);
  const live = useStoreSelector(sessionStore, selectSubagents);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const running = workers.some((worker) => worker.turnStartedAt !== undefined);
  useEffect(() => {
    if (!running) return;
    const ticker = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(ticker);
  }, [running]);
  return (
    <section className="w-full overflow-hidden rounded-2xl border border-border/70">
      <PanelHeader
        icon={<Bot aria-hidden="true" className="size-4" />}
        title={copy.vibeTitle}
        count={workers.length}
        onCollapse={onCollapse}
      />
      <div className="scrollbar-hide max-h-[220px] overflow-y-auto px-2 pb-2">
        {workers.length === 0 ? (
          <p className="px-1.5 py-2 text-sm text-muted-foreground">{copy.vibeEmpty}</p>
        ) : (
          <ol aria-live="polite" className="space-y-0">
            {workers.map((worker) => {
              // The engine's fleet snapshot is refreshed on mode changes; the child roster streams
              // while a worker runs. The live row wins where it reports, so the panel says what the
              // worker is doing now rather than what it was doing when the mode last changed.
              const row = live[worker.id];
              const merged = row === undefined ? worker : {
                ...worker,
                state: row.status,
                model: row.model ?? worker.model,
                currentTool: row.currentTool ?? worker.currentTool,
                lastIntent: row.lastIntent ?? worker.lastIntent,
              };
              return (
                <WorkerRow
                  key={worker.id}
                  worker={merged}
                  nowMs={nowMs}
                  onOpen={onOpenWorker === undefined ? undefined : () => onOpenWorker(worker)}
                />
              );
            })}
          </ol>
        )}
        <ModeActions>
          <ModeAction command="/vibe" label={copy.vibeActionExit} />
        </ModeActions>
      </div>
    </section>
  );
}

/** `12s` / `3m 4s` / `2h 5m`: the same reading the stopwatch rows use, without fractional seconds. */
function formatSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

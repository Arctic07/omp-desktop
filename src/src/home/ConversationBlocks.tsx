import { Activity, Bot, ChevronDown, CircleDot, FileText, ListTodo, MessageSquareText, Repeat, Square, SquareFunction, SquareTerminal, Target } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TodoList } from "@/components/agents/todo-list";
import { Button } from "@/components/motion/button";
import { Tooltip } from "@/components/motion/tooltip";
import type { BackgroundJob, SessionModes, TodoPhase } from "@/api/session-types";
import type { BtwView } from "@/state/transcript";
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "@/lib/ease";
import { NO_HOVER_GROWTH } from "@/lib/hover-motion";
import { useCopy } from "@/lib/i18n";
import { COPY } from "@/home/homeCopy";
import { formatDuration } from "@/home/conversation-format";
import {
  blockLabel,
  composerBlocks,
  resolveOpenBlock,
  type BlockWords,
  type ComposerBlock,
} from "@/home/conversation-blocks";
import { BtwPanel } from "@/home/BtwPanel";
import { GoalPanel, LoopPanel, PlanModePanel, VibePanel } from "@/home/mode-panels";
import { blockPanelStore } from "@/state/block-panel-store";
import { sessionStore, stopJob, type SessionStoreState } from "@/state/session-store";
import { useStoreSelector, useStore } from "@/state/store";

/** The kinds of work the engine detaches, in the glyphs this app draws them with. */
const JOB_ICON: Record<string, typeof Bot> = {
  bash: SquareTerminal,
  eval: SquareFunction,
  task: Bot,
};

const NO_PHASES: TodoPhase[] = [];
const NO_JOBS: BackgroundJob[] = [];
const NO_MODES: SessionModes = {};

/** The phases of the engine's plan the conversation on screen has reported. */
const selectPhases = (state: SessionStoreState): TodoPhase[] =>
  state.activeId === null
    ? NO_PHASES
    : (state.records[state.activeId]?.runtime?.todoPhases ?? NO_PHASES);

/** The work that conversation detached, which outlives the turn that started it. */
const selectJobs = (state: SessionStoreState): BackgroundJob[] =>
  state.activeId === null
    ? NO_JOBS
    : (state.records[state.activeId]?.runtime?.backgroundJobs ?? NO_JOBS);

/** The side question on screen, or null when none is shown. */
const selectBtw = (state: SessionStoreState): BtwView | null =>
  state.activeId === null ? null : (state.records[state.activeId]?.btw ?? null);

/** The modes that conversation is in (goal, plan mode, vibe), as one object per state frame. */
const selectModes = (state: SessionStoreState): SessionModes =>
  state.activeId === null ? NO_MODES : (state.records[state.activeId]?.runtime?.modes ?? NO_MODES);

/**
 * The blocks above the composer's field: the engine's plan, and the work it detached as one tab.
 *
 * A pill is what a block *is* here — a reading of how far along something stands, and a control that
 * opens it — so a block that does not exist draws nothing at all: no empty row, no placeholder. The
 * row is the foot of this stack, directly over the field, so the pills read as the field's own strip
 * of tabs; what a pill opens is a panel above that row, full width, and only one at a time, which is
 * what keeps the column above the field clean enough to type in. A panel under the row would push
 * the pills — the controls the reader reaches for — away from the field they belong to.
 *
 * The detached work is here rather than in a surface of its own because it is one more block of the
 * same kind: a thing the engine is doing that is not a row of the transcript, with a reading and a
 * roster behind it. Two places deciding what a job looks like is how they drift.
 */
export function ConversationBlocks({
  onOpenSubagent,
}: {
  /** Opens one detached `task` child's conversation in the right column. */
  onOpenSubagent?: (childId: string, label: string) => void;
}) {
  const copy = useCopy(COPY);
  const reduce = useReducedMotion() ?? false;
  const phases = useStoreSelector(sessionStore, selectPhases);
  const jobs = useStoreSelector(sessionStore, selectJobs);
  const modes = useStoreSelector(sessionStore, selectModes);
  const btw = useStoreSelector(sessionStore, selectBtw);
  const blocks = useMemo(() => composerBlocks(phases, jobs, modes, btw), [phases, jobs, modes, btw]);
  /**
   * A new side question opens its panel by itself: the answer never enters the transcript, so a
   * question that waited for a click would leave the reader watching a conversation that is not
   * changing while the answer streams somewhere they cannot see.
   */
  const seenQuestion = useRef<string | null>(null);
  const question = btw?.question ?? null;
  useEffect(() => {
    if (question === null || question === seenQuestion.current) return;
    seenQuestion.current = question;
    blockPanelStore.set("btw");
  }, [question]);
  /**
   * The block the reader opened, by id, and the rule that reads it back out of the blocks on hand.
   *
   * It is not an effect that closes a panel whose block has gone: the rule is applied where it is
   * read, so there is no frame in which the panel is drawn for a block the row no longer shows.
   */
  const chosen = useStore(blockPanelStore);
  const setChosen = blockPanelStore.set;
  const openId = resolveOpenBlock(blocks, chosen);
  const open = blocks.find((block) => block.id === openId) ?? null;
  /** The jobs whose stop has been asked for, until the engine's next snapshot says they are gone. */
  const [stopping, setStopping] = useState<readonly string[]>([]);

  const stop = useCallback((jobId: string) => {
    setStopping((current) => (current.includes(jobId) ? current : [...current, jobId]));
    void stopJob(jobId).finally(() =>
      setStopping((current) => current.filter((id) => id !== jobId)),
    );
  }, []);

  if (blocks.length === 0) return null;

  const words: BlockWords = {
    jobs: copy.backgroundJobs,
    plan: copy.planTitle,
    goal: copy.goalTitle,
    planMode: copy.planModeTitle,
    vibe: copy.vibeTitle,
    loop: copy.loopTitle,
    btw: copy.btwTitle,
  };

  return (
    // `relative` is the anchor the open panel hangs from; it is also why the row is the only thing
    // here that takes space: a block's panel is drawn *over* the foot of the transcript, never
    // inside this stack.
    <div className="relative flex min-w-0 flex-col">
      {open === null ? null : (
        // The panel is an overlay above the pill row (`bottom-full`), not a row of the stack: opening
        // a block must not grow the composer, because the composer growing shrinks the transcript and
        // every visible row jumps up while the reader is looking at it. The panel keeps its one row
        // gap from the pills, covers whatever was at the foot of the column, and leaves the field,
        // the pills and the conversation exactly where they were. `bg-pane` is what makes the cover
        // opaque — the panel is this column's surface, drawn over rows rather than between them.
        <div className="absolute inset-x-0 bottom-full z-30 mb-1.5 overflow-hidden rounded-2xl bg-pane shadow-lg">
          {open.kind === "plan" ? (
            <TodoList
              // One list per block, not one list whose name changed: switching pills opens another
              // phase's plan, and a list that reuses the last one's rows is a list that can draw a
              // row for a task it no longer holds.
              key={open.id}
              items={open.items}
              title={open.name || copy.planTitle}
              // The pill is the block's own trigger, so this panel is open because the row says so.
              open
              // A phase folding itself away is no longer needed: every block starts folded, and the
              // one the reader opened is theirs to keep — including after the work it reports is
              // finished.
              collapseOnComplete={false}
              maxHeight={220}
              onOpenChange={(next) => {
                if (!next) setChosen(null);
              }}
            />
          ) : open.kind === "goal" ? (
            <GoalPanel goal={open.goal} onCollapse={() => setChosen(null)} />
          ) : open.kind === "planMode" ? (
            <PlanModePanel plan={open.plan} onCollapse={() => setChosen(null)} />
          ) : open.kind === "btw" ? (
            <BtwPanel btw={open.btw} onCollapse={() => setChosen(null)} />
          ) : open.kind === "loop" ? (
            <LoopPanel loop={open.loop} onCollapse={() => setChosen(null)} />
          ) : open.kind === "vibe" ? (
            <VibePanel
              workers={open.workers}
              onCollapse={() => setChosen(null)}
              // A worker is a registered subagent: the same tab a `task` child opens into, so a
              // reader can watch the work rather than the label.
              onOpenWorker={
                onOpenSubagent === undefined
                  ? undefined
                  : (worker) => onOpenSubagent(worker.id, worker.id)
              }
            />
          ) : (
            <BackgroundJobsPanel
              jobs={open.jobs}
              stopping={stopping}
              onStop={stop}
              onCollapse={() => setChosen(null)}
              stopLabel={(job) =>
                copy.backgroundJobStop(
                  job.label || copy.backgroundJobKinds[job.type] || job.type,
                )
              }
              onOpen={
                onOpenSubagent === undefined
                  ? undefined
                  : (job) =>
                      onOpenSubagent(
                        job.id,
                        job.label || copy.backgroundJobKinds[job.type] || job.type,
                      )
              }
            />
          )}
        </div>
      )}

      <div
        role="group"
        aria-label={copy.blocksLabel}
        className="flex min-w-0 flex-wrap items-center gap-1.5"
      >
        {blocks.map((block) => (
          <BlockPill
            key={block.id}
            block={block}
            label={blockLabel(block, words)}
            progress={copy.planProgress}
            jobsCount={copy.backgroundJobsCount}
            open={block.id === openId}
            reduce={reduce}
            onToggle={() => setChosen(block.id === openId ? null : block.id)}
          />
        ))}
      </div>
    </div>
  );
}

interface BackgroundJobsPanelProps {
  jobs: readonly BackgroundJob[];
  /** The jobs whose stop has been asked for and the engine has not answered yet. */
  stopping: readonly string[];
  onStop: (jobId: string) => void;
  stopLabel: (job: BackgroundJob) => string;
  /** Closes the panel from its own header, the same gesture the plan's card offers. */
  onCollapse: () => void;
  /** Opens a detached `task` child's own conversation, when this conversation has one. */
  onOpen?: (job: BackgroundJob) => void;
}

/**
 * Everything the conversation is still running in the background, as the panel its tab opens onto.
 *
 * The surface is the plan card's own (`TodoList`): one bordered `section`, a 44px header with the
 * block's name and count, then rows at the step rows' height, gap and type. The two expansions hang
 * from the same row of pills, so a reader who opens one and then the other must not see two
 * different ideas of what an expanded block looks like.
 *
 * One interval for the whole roster rather than one per row: the rows share a clock, and a closed
 * panel has nothing ticking for it. An elapsed figure is drawn only when the engine gave a start
 * time — a figure counted from a time nobody reported would be a number this side made up.
 *
 * Per-row stop is the action this panel exists for: a `task` child is also a way into its own
 * conversation, and the stop stays outside that clickable band so one press never becomes the other.
 */
function BackgroundJobsPanel({
  jobs,
  stopping,
  onStop,
  stopLabel,
  onCollapse,
  onOpen,
}: BackgroundJobsPanelProps) {
  const copy = useCopy(COPY);
  const reduce = useReducedMotion() ?? false;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const timing = jobs.some((job) => job.startedAt > 0);

  useEffect(() => {
    if (!timing) return;
    const ticker = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(ticker);
  }, [timing]);

  return (
    <section className="w-full overflow-hidden rounded-2xl border border-border/70">
      <button
        type="button"
        aria-expanded
        onClick={onCollapse}
        className="group flex h-11 w-full items-center gap-2.5 rounded-2xl px-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="grid size-6 shrink-0 place-items-center text-muted-foreground">
          <Activity aria-hidden="true" className="size-4" />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
          {copy.backgroundJobs}
        </h3>
        <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
          <span className="sr-only">{copy.backgroundJobsCount(jobs.length)}</span>
          <span aria-hidden="true">{jobs.length}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-3.5 shrink-0 rotate-180 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
        />
      </button>
      <div className="scrollbar-hide max-h-[220px] overflow-y-auto px-2 pb-2">
        <ol aria-live="polite" className="space-y-0">
          <AnimatePresence initial={false}>
            {jobs.map((job) => {
              const Icon = JOB_ICON[job.type] ?? CircleDot;
              const isStopping = stopping.includes(job.id);
              const label = job.label || copy.backgroundJobKinds[job.type] || job.type;
              const body = (
                <>
                  <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
                    <Icon aria-hidden="true" className="size-4" />
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-sm leading-5 text-foreground/90"
                    title={label}
                  >
                    {label}
                  </span>
                  {job.startedAt > 0 ? (
                    <span className="shrink-0 text-sm tabular-nums text-muted-foreground/55">
                      {formatDuration(nowMs - job.startedAt)}
                    </span>
                  ) : null}
                </>
              );
              return (
                <motion.li
                  key={job.id}
                  initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={
                    reduce
                      ? { duration: 0 }
                      : {
                          opacity: { duration: 0.18, ease: EASE_OUT },
                          y: SPRING_LAYOUT,
                        }
                  }
                  className="flex min-h-9 min-w-0 items-center gap-2.5 rounded-xl px-1.5 py-1"
                >
                  {onOpen === undefined || job.type !== "task" ? (
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">{body}</div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onOpen(job)}
                      aria-label={label}
                      className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {body}
                    </button>
                  )}
                  <Tooltip content={stopLabel(job)}>
                    <Button
                      {...NO_HOVER_GROWTH}
                      variant="ghost"
                      size="icon"
                      aria-label={stopLabel(job)}
                      disabled={isStopping}
                      onClick={() => onStop(job.id)}
                      className="size-6 shrink-0 rounded-md"
                    >
                      <Square aria-hidden="true" className="size-2.5 fill-current" />
                    </Button>
                  </Tooltip>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>
      </div>
    </section>
  );
}

interface BlockPillProps {
  block: ComposerBlock;
  label: string;
  /** A phase's own count, in the reader's words; the jobs block reads its own count below. */
  progress: (completed: number, total: number) => string;
  /** How many jobs the roster holds, in the reader's words. */
  jobsCount: (count: number) => string;
  open: boolean;
  reduce: boolean;
  onToggle: () => void;
}

/**
 * One block, as the pill the row draws it as: beUI's own `Button` at its small size, which is the
 * pill the rest of this composer is made of — a full-round control, an icon and a label at 12px.
 *
 * Its two variants are the open and closed states rather than a fill chosen here: `outline` is the
 * block standing closed, `secondary` is the raised surface of the one the reader has opened, so the
 * state is the component's own material and not a colour written twice.
 */
function BlockPill({ block, label, progress, jobsCount, open, reduce, onToggle }: BlockPillProps) {
  const Icon =
    block.kind === "plan"
      ? ListTodo
      : block.kind === "goal"
        ? Target
        : block.kind === "planMode"
          ? FileText
          : block.kind === "vibe"
            ? Bot
            : block.kind === "loop"
              ? Repeat
              : block.kind === "btw"
                ? MessageSquareText
                : Activity;
  /**
   * The trailing count: a phase's `done/total`, the fleet's worker count, and nothing for the two
   * mode reports — a goal and a plan file are one thing each, and "1" beside them would be a
   * number nobody counts.
   */
  const count =
    block.kind === "plan" ? (
      <>
        <span className="sr-only">{progress(block.completed, block.total)}</span>
        <span aria-hidden="true">
          {block.completed}/{block.total}
        </span>
      </>
    ) : block.kind === "jobs" ? (
      <>
        <span className="sr-only">{jobsCount(block.jobs.length)}</span>
        <span aria-hidden="true">{block.jobs.length}</span>
      </>
    ) : block.kind === "vibe" ? (
      <span aria-hidden="true">{block.workers.length}</span>
    ) : null;

  return (
    <Button
      variant={open ? "secondary" : "outline"}
      size="sm"
      aria-expanded={open}
      onClick={onToggle}
      className="max-w-full"
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
      {count === null ? null : (
        <span className="shrink-0 tabular-nums text-muted-foreground/70">{count}</span>
      )}
      <motion.span
        aria-hidden="true"
        animate={{ rotate: open ? 180 : 0 }}
        transition={reduce ? { duration: 0 } : SPRING_SWAP}
        className="shrink-0 text-muted-foreground/60"
      >
        <ChevronDown className="size-3.5" />
      </motion.span>
    </Button>
  );
}

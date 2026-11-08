import type {
  BackgroundJob,
  SessionGoalMode,
  SessionLoopMode,
  SessionModes,
  SessionPlanMode,
  SessionVibeWorker,
  TodoPhase,
  TodoStatus,
} from "@/api/session-types";
// The dock's own item shape, so a block carries what the panel draws rather than a second reading
// of the engine's plan. A type-only import: this module is read by the test runner as well as by the
// bundler, and the runner strips it.
import type { TodoItem, TodoItemStatus } from "@/components/agents/todo-list";
import type { BtwView } from "@/state/transcript";

/**
 * The blocks above the composer's field, as data.
 *
 * The engine reports two kinds of progress that are not a row of the transcript: its plan, in
 * phases, and the work a turn detached. Neither belongs over the field as a panel — a stack of
 * panels is what a reader scrolls past on the way to what they are typing — so each block is one
 * pill, and the pill opens the block it names.
 *
 * What is open is decided here rather than in the component, because it is a rule about the blocks
 * and not about drawing them: one at a time, opened by the reader and by nothing else, and not left
 * open once the block it names is gone.
 */

/** The engine's own status words, as the dock draws them. */
const TODO_STATUS: Record<TodoStatus, TodoItemStatus> = {
  pending: "pending",
  in_progress: "in-progress",
  completed: "completed",
  abandoned: "cancelled",
  blocked: "pending",
  unknown: "pending",
};

/**
 * One block of the row: a phase of the engine's plan, or the work the engine detached.
 *
 * A phase is a group of its own rather than a slice of one flat list, because the phase is what the
 * plan is ordered by — `计划` and `当前进度` are stages of the work, and how far along each stands is
 * the thing the reader scans the row for.
 *
 * The detached work is one block rather than one per job: it is one *tab* above the field, and what
 * it opens is the roster of everything still running. A pill per job pushed the rest of the row left
 * as a conversation accumulated background shells, and a reader who wanted "what is still running"
 * had to scan a row of pills that all looked alike. The jobs themselves are untouched here — the
 * panel reads the engine's own rows.
 */
export type ComposerBlock =
  | {
      kind: "plan";
      /** `plan:<position>:<name>`: the engine may name two phases the same. */
      id: string;
      name: string;
      items: TodoItem[];
      completed: number;
      total: number;
    }
  | {
      kind: "jobs";
      /** Fixed, because the block is the roster rather than any one job in it. */
      id: "background-jobs";
      jobs: readonly BackgroundJob[];
    }
  | {
      kind: "goal";
      id: "goal";
      goal: SessionGoalMode;
    }
  | {
      kind: "planMode";
      id: "plan-mode";
      plan: SessionPlanMode;
    }
  | {
      kind: "vibe";
      id: "vibe";
      workers: readonly SessionVibeWorker[];
    }
  | {
      kind: "loop";
      id: "loop";
      loop: SessionLoopMode;
    }
  | {
      kind: "btw";
      id: "btw";
      btw: BtwView;
    };

/** The one id the jobs block has, stable across snapshots so an open panel survives a job ending. */
export const BACKGROUND_JOBS_BLOCK_ID = "background-jobs";

/**
 * The phase name the engine writes for itself when a `todo` init arrives flattened
 * (`{op: "init", items: [...]}` with no `phase`): `DEFAULT_INIT_PHASE` in
 * `@oh-my-pi/pi-coding-agent`'s `tools/todo.ts`.
 *
 * It is a placeholder, not a name the model chose, and as a block title it reads as the wrong tool:
 * `Tasks` is this desktop's word for the `task` tool's children, so a todo list under that heading
 * looks like a subagent batch. The block is therefore drawn as unnamed and falls back to the
 * reader's own word for a plan. A model that deliberately names a phase `Tasks` gets the same
 * fallback — the two are one string and the engine keeps no other mark of which it was.
 */
const ENGINE_DEFAULT_PHASE = "Tasks";

/**
 * The row the composer draws, in order: the plan's phases, then the detached work.
 *
 * A phase with no tasks in it is not a block — it would be a pill that opens onto an empty list —
 * and neither is anything the engine has not reported: nothing here is derived, so an engine that
 * has said nothing about a plan leaves no row at all. The detached work is one block when at least
 * one job is running, and no block at all when none is.
 */
export function composerBlocks(
  phases: readonly TodoPhase[] | undefined,
  jobs: readonly BackgroundJob[],
  modes?: SessionModes,
  btw?: BtwView | null,
): ComposerBlock[] {
  const blocks: ComposerBlock[] = [];
  // The modes come first: they are what the conversation *is* while everything else is what it is
  // doing. Each is present only while the engine says the mode is on.
  if (modes?.goal !== undefined) blocks.push({ kind: "goal", id: "goal", goal: modes.goal });
  if (modes?.plan !== undefined) blocks.push({ kind: "planMode", id: "plan-mode", plan: modes.plan });
  if (modes?.vibe !== undefined) blocks.push({ kind: "vibe", id: "vibe", workers: modes.vibe.workers });
  if (modes?.loop !== undefined) blocks.push({ kind: "loop", id: "loop", loop: modes.loop });
  // The side question last: it is an aside, and it leaves as soon as the reader clears it.
  if (btw !== null && btw !== undefined) blocks.push({ kind: "btw", id: "btw", btw });
  phases?.forEach((phase, phaseIndex) => {
    if (phase.tasks.length === 0) return;
    const items: TodoItem[] = phase.tasks.map((task, taskIndex) => ({
      id: `${phase.name}-${taskIndex}`,
      title: task.content,
      status: TODO_STATUS[task.status] ?? "pending",
      detail: task.blocker,
    }));
    blocks.push({
      kind: "plan",
      // The id keeps the engine's own name: it is what the phase is, even when the block is drawn
      // without it (a reader's open panel survives a snapshot, and renaming the id would close it).
      id: `plan:${phaseIndex}:${phase.name}`,
      name: phase.name === ENGINE_DEFAULT_PHASE ? "" : phase.name,
      items,
      completed: items.filter((item) => item.status === "completed").length,
      total: items.length,
    });
  });
  if (jobs.length > 0) {
    blocks.push({ kind: "jobs", id: BACKGROUND_JOBS_BLOCK_ID, jobs });
  }
  return blocks;
}

/**
 * Which block is open, given the one the reader chose.
 *
 * One at a time is the whole rule — `chosen` is a single id, because a row of open panels is the
 * stacked dock this replaced. The reader is also the only thing that opens one: a phase the engine
 * has finished with is still theirs to read, so no state of the work overrules their click.
 *
 * What that click does not survive is the block ceasing to exist — a phase whose tasks empted out, a
 * job that ended — because there is then nothing to draw, and a panel standing over the field for a
 * block the row no longer shows is exactly what this row is for.
 */
export function resolveOpenBlock(
  blocks: readonly ComposerBlock[],
  chosen: string | null,
): string | null {
  if (chosen === null) return null;
  return blocks.some((block) => block.id === chosen) ? chosen : null;
}

/** The words a block's own name is composed from. */
export interface BlockWords {
  /** What the detached-work tab reads as, whatever is running in it. */
  jobs: string;
  /** What a phase with no name of its own is called. */
  plan: string;
  /** The three mode tabs. */
  goal: string;
  planMode: string;
  vibe: string;
  loop: string;
  btw: string;
}

/**
 * One block's own name, in the reader's words.
 *
 * A plan's name is the engine's — it is the engine's stage of the work, and there is no word on this
 * side that could say it better. The detached work is named for what it is rather than for any one
 * job: the panel behind it lists the engine's own labels, where there is room for them. The mode
 * tabs are named for the mode, because each opens the same panel whatever it currently holds.
 */
export function blockLabel(block: ComposerBlock, words: BlockWords): string {
  switch (block.kind) {
    case "jobs":
      return words.jobs;
    case "goal":
      return words.goal;
    case "planMode":
      return words.planMode;
    case "vibe":
      return words.vibe;
    case "loop":
      return words.loop;
    case "btw":
      return words.btw;
    default:
      return block.name || words.plan;
  }
}

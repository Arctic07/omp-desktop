import type { ChatMessage, ChatTokenUsage, ToolSource } from "@/api/session-types";
import type { TurnEnding } from "@/state/transcript";

import { parseReminder, sameReminder } from "./reminder.ts";
import { readModelReasoning } from "./reasoning-echo.ts";
import { stripModelTags } from "./system-notice.ts";
import { readStrayToolCall, type StrayToolCall } from "./tool-call-markup.ts";

/**
 * The transcript's rows, folded out of the conversation.
 *
 * What lives here is one thing: how a run of messages becomes a row. Consecutive tool calls become a
 * single row (a run of five calls is one line, not five); only the first answer of a turn names the
 * agent; reasoning is grouped by the run it belongs to; and each turn's footer is placed on the last
 * row it drew.
 *
 * What the navigation rail shows of those rows is a second reading of them, and it lives in
 * `home/rail-rows.ts` — the rail's list is derived from these rows rather than from the document,
 * which is a concern of the list rather than of the fold.
 */

/** One tool call of the transcript, which is one message of the engine's own. */
export type ToolMessage = Extract<ChatMessage, { kind: "tool" }>;

/**
 * Whether a call reported a search card: the pages it read or the answer a provider wrote for it.
 *
 * This is the content a `web_search` row opens itself for (`ConversationToolRow`), so a search that
 * has not reported either yet stays folded like every other call — opening it on a result text that
 * is still arriving would be the flash of JSON the fold exists to avoid. `tool_updated` frames carry
 * `details` while a call runs, so the row also gates this on the call having settled; the predicate
 * itself answers only what the payload holds.
 */
export function hasSearchCard(
  sources: readonly ToolSource[] | undefined,
  answer: string | undefined,
): boolean {
  if ((sources?.length ?? 0) > 0) return true;
  return (answer ?? "").trim() !== "";
}

/** One injected reminder: the harness explaining a rule check that fired on a call. */
export type ReminderMessage = Extract<ChatMessage, { kind: "reminder" }>;

/** One engine notice kept in the transcript: the idle recap, or a compaction's report. */
export type NoticeMessage = Extract<ChatMessage, { kind: "notice" }>;

/**
 * How a run of calls settled: how many answered successfully and how many failed.
 *
 * The folded run's header and the rail's preview both state the split once anything failed, so the
 * counting lives in one place and the two cannot disagree about what "3 succeeded · 1 failed" means.
 */
export function toolRunOutcomes(tools: readonly ToolMessage[]): {
  succeeded: number
  failed: number
} {
  let succeeded = 0
  let failed = 0
  for (const tool of tools) {
    if (tool.state === "success") succeeded += 1
    else if (tool.state === "error") failed += 1
  }
  return { succeeded, failed }
}

/** One row of the transcript. */
export type TranscriptRow =
  | {
      kind: "single"
      id: string
      message: ChatMessage
      /**
       * Whether this row names its speaker — the avatar, the name and the clock.
       *
       * One turn reads as one speaker: the engine emits an assistant message per step (one before a
       * tool call, one after), and each of them naming the agent again puts two avatars over one
       * turn's output. The avatar belongs to the turn's first answer, and the answers after a call
       * are the same agent still talking. The reader's own row always names its sender.
       */
      namesSender: boolean
      /**
       * The reasoning this row carries, which is one stretch of thinking rather than one turn's.
       *
       * The engine emits an assistant message per step, and a step that thought and then called a
       * tool is a thought of its own: the run of steps a call separates is exactly the run of
       * thoughts the reader watched, so each stretch is drawn on the row it belongs to instead of
       * being concatenated with the ones around it. What *is* merged is a thought the engine split
       * across adjacent messages with nothing in between — those are one stretch, and they read as
       * one.
       */
      thinking: string
      /** Whether that reasoning is still arriving: its own step has not begun its answer yet. */
      thinkingLive: boolean
      /**
       * What the turn this row belongs to cost, when this row is the one that carries its footer.
       *
       * A footer belongs to the *turn*, not to each answer it was written in — the engine writes an
       * assistant message per step, and a footer after every one of them is a conversation that looks
       * finished five times. So it lands on the last row the turn drew — its last answer, or the call
       * it ended on — and the pane draws it only once the turn is over: while a turn is in flight,
       * nothing on screen is a finished answer (`ConversationPane`).
       */
      tail: TurnTail | null
      /**
       * The ending this row states, when it is the turn's last answer and the turn is over.
       *
       * One turn writes several answers, and an attempt the engine retried away is one of them: the
       * failure it carried is the reason the retry happened, not an outcome the reader should be told
       * twice. So the ending is read off the turn as a whole (`TranscriptState.lastTurn`), and drawn
       * on the row the turn ends on — once, after the turn is over.
       */
      ending: RowEnding | null
      /**
       * The tool call this step wrote as markup instead of an answer, when it wrote one
       * (`readStrayToolCall`).
       *
       * The words are cleared from the message when this is set — the envelope is not prose — and
       * the row draws the call it named, so a legacy spelling the engine never parsed reads as the
       * call it was rather than as a wall of brackets.
       */
      stray: StrayToolCall | null
    }
  | {
      /**
       * A run of reminders the harness injected, folded the way a run of calls is.
       *
       * One reminder is one rule check that fired, and it explains the call beside it. Consecutive
       * ones naming the same rule are the same thing happening again — three in a row is one row with
       * a count, not three lines — and a reminder row never carries the turn's name, footer or
       * ending: it is an annotation on the turn, not a step of it.
       */
      kind: "reminders"
      id: string
      reminders: ReminderMessage[]
    }
  | {
      kind: "tools"
      id: string
      tools: ToolMessage[]
      /**
       * Whether this run of calls is where the turn names its speaker.
       *
       * A turn is not guaranteed to draw an answer before it draws calls: a step that calls a tool
       * writes no row of its own, so a turn that starts with calls used to have no avatar and no
       * sender line anywhere — every call row is a placeholder, and the answer after the calls is
       * no longer the turn's first row. The first row the turn actually draws names the speaker,
       * whatever kind it is.
       */
      namesSender: boolean
      /** What the turn cost, when this run of calls is the last row the turn drew (see above). */
      tail: TurnTail | null
    };

/**
 * What a settled turn cost, and where the reader can carry on from it.
 *
 * Every reading here is the engine's or the host's own; a turn whose usage the engine never reported
 * shows no usage at all rather than a zero it did not claim (`TurnTail` in `home/ConversationTurnTail`).
 */
export interface TurnTail {
  /** The sum over the turn's own steps; null when none of them reported usage. */
  usage: ChatTokenUsage | null
  /** The turn's own wall time, from the prompt that opened it to its last step. */
  durationMs: number | null
  /**
   * Decode rate: the turn's output over the time its steps spent writing.
   *
   * The denominator is the sum of the steps' own windows when every one of them reported both ends,
   * and the turn's wall clock otherwise — a step that reported nothing would otherwise read as a
   * step that took no time. Null while either fact is missing.
   */
  tps: number | null
  /** The model that answered, when the engine named both halves of it. */
  model: { provider: string; id: string } | null
  /** The turn's last answer that drew words: what the footer's copy action writes. */
  text: string
  /** When the turn's last step ended, for the clock label; null when nothing stamped it. */
  at: number | null
  /**
   * True for the newest turn: its footer stays in view while every earlier turn's waits for the
   * hover or the focus that puts the reader on it.
   */
  latest: boolean
  /**
   * The entry this turn ends on — the point a fork continues from, so the conversation carries on
   * *after* the output the reader pointed at.
   *
   * Null for a turn nothing names: a row built from live frames has no entry of its own, and the
   * host's own tip names one only for the turn that just settled in this process.
   */
  continueEntryId: string | null
}

/**
 * How a step ended, as the row it ends says so.
 *
 * `aborted` and `failed` are the turn's own outcomes; `miscall` is one step's: its words were a
 * tool-call envelope the engine never parsed, so the step answered nothing and no call ran. The note
 * states that where it happened, because a turn that completed normally would otherwise read as an
 * answer the model never gave (2026-11-01, `me/deepseek-v4.1-flash`).
 */
export interface RowEnding {
  outcome: "aborted" | "failed" | "miscall";
  /** The engine's own account of a failure, when it gave one. */
  error: string | null;
}

/**
 * What a turn's ending reads as, or null when it is not one a row should state.
 *
 * `completed` is the ordinary case and states nothing: the answer that finished the turn is its own
 * account. `aborted` is the reader's own act — including a turn the host confirmed stopping while
 * the engine was waiting out a retry, whose engine-side ending carries the failure it was retrying
 * (`stopped`) rather than an abort. `failed` keeps the engine's reason, because it exists nowhere
 * else.
 */
export function rowEnding(turn: TurnEnding | null): RowEnding | null {
  if (turn === null) return null;
  if (turn.outcome === "completed") return null;
  if (turn.outcome === "aborted" || turn.stopped) return { outcome: "aborted", error: null };
  return { outcome: "failed", error: turn.error };
}

/** The row that stands for the turn in flight: not a message, but the last line of the transcript. */
export const RUNNING_ROW_ID = "turn-running";

/**
 * One row of the transcript, from the messages it is folded out of.
 *
 * Four rules, all about what a turn looks like rather than about what it contains: consecutive tool
 * calls become a single row (a run of five calls is one line, not five); only the first answer of a
 * turn names the agent (`namesSender`), because every answer after it is the same agent still
 * talking; reasoning is grouped by the run it belongs to (`thinking`), because a thought the engine
 * wrote and then acted on is its own thought, while a thought it merely carried on writing is the
 * same one; and the turn's footer is placed on the last row the turn drew (`tail`), because a footer
 * is the turn's rather than each answer's — and a turn does not always end at its prose, since the
 * calls of its last step come after the answer that made them.
 */
export interface BuildRowsOptions {
  /** Whether a turn is in flight; the ending is drawn only once it is over. */
  streaming?: boolean;
  /**
   * The turn that just ended in this process, as `turn_finished` reported it.
   *
   * When there is one, its outcome is the only ending drawn: a retried attempt's failure is the
   * reason the retry happened, not what the turn came to. When there is none — a conversation read
   * back from disk, whose turns ended in an earlier process — each answer states its own ending
   * from the record it carries (`stopReason` / `error`), which is how a reopened conversation keeps
   * showing why a turn stopped.
   */
  turn?: TurnEnding | null;
  /**
   * The host's own name for the entry the conversation currently ends on (`SessionRuntimeState`).
   *
   * A row built from live frames carries no entry of its own, so this is what lets the turn that
   * just settled here offer a fork at all — the host publishes it with every state frame, and it
   * names exactly the entry that turn ended with.
   */
  tipEntryId?: string | null;
}

/** `endedAt - startedAt` when both ends are known and the order holds; null otherwise. */
function elapsedMs(startedAt: number | null, endedAt: number | null): number | null {
  return startedAt === null || endedAt === null || endedAt < startedAt ? null : endedAt - startedAt;
}

/** The `provider/id` one step was answered by, only when the engine named both. */
function messageModel(
  message: Extract<ChatMessage, { kind: "assistant" }>,
): { provider: string; id: string } | null {
  return message.modelProvider === null || message.modelId === null
    ? null
    : { provider: message.modelProvider, id: message.modelId };
}

/**
 * One step's usage added onto a turn's running total, bucket by bucket.
 *
 * `reasoning` is the one bucket a step can leave unreported, so the turn reports it only if a step
 * did: two absences stay null rather than summing into a zero the engine never claimed, while one
 * reported bucket makes the other side count as zero.
 */
function addUsage(total: ChatTokenUsage | null, usage: ChatTokenUsage): ChatTokenUsage {
  if (total === null) return { ...usage };
  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    reasoning:
      total.reasoning === null && usage.reasoning === null
        ? null
        : (total.reasoning ?? 0) + (usage.reasoning ?? 0),
    costUsd: total.costUsd + usage.costUsd,
  };
}

/** The turn being folded, as the messages of it arrive. */
interface TurnDraft {
  /** The prompt that opened the turn, or 0 when nothing opened it. */
  openedAt: number;
  /** When the last step of it ended. */
  closedAt: number;
  /** Whether the engine wrote anything of its own in the turn — a call is not an answer. */
  hasAnswer: boolean;
  usage: ChatTokenUsage | null;
  model: { provider: string; id: string } | null;
  text: string;
  /** The steps' own writing time, and whether every one of them reported both its ends. */
  decodeMs: number;
  decodeComplete: boolean;
  /** The row the footer will land on: the last row the turn drew, or -1 while it has drawn none. */
  tailRow: number;
}

function openTurn(): TurnDraft {
  return {
    openedAt: 0,
    closedAt: 0,
    hasAnswer: false,
    usage: null,
    model: null,
    text: "",
    decodeMs: 0,
    decodeComplete: true,
    tailRow: -1,
  };
}

/**
 * One step of the turn, folded into the draft. Called for every step, drawn or not.
 *
 * Its words are kept as the answer reads rather than as the model wrote them: the footer copies
 * this text and hands it to plugins, so the wrappers a model puts around its own answer
 * (`stripModelTags`) come off here, once, for both.
 */
function addStep(turn: TurnDraft, message: Extract<ChatMessage, { kind: "assistant" }>): void {
  turn.hasAnswer = true;
  if (message.usage !== null) turn.usage = addUsage(turn.usage, message.usage);
  const named = messageModel(message);
  if (named !== null) turn.model = named;
  if (message.text.length > 0) turn.text = stripModelTags(message.text);
  const closed = message.endedAt ?? message.at;
  if (closed > 0) turn.closedAt = closed;
  const window = elapsedMs(message.startedAt, message.endedAt);
  if (window === null) turn.decodeComplete = false;
  else turn.decodeMs += window;
}

/**
 * The footer the draft has earned, or null when the turn has none to give.
 *
 * The turn still being written has no footer: nothing on the screen is a finished answer while one
 * is arriving. That is a fact about *this* turn, not about the conversation — the turns above it
 * have ended, and their footers are the record of turns that did. Suppressing every footer while a
 * turn runs (the earlier reading of `streaming`) took a row's worth of height out of every settled
 * answer the moment the reader sent a prompt: on the 95-turn picture conversation that is ~2 300 px
 * of content removed and restored on each send, and the feed's floor is not pinned across a shrink
 * (2026-11-05, user report: 消息发送会导致上面消息上下抖动).
 */
function tailOf(turn: TurnDraft, rows: TranscriptRow[], inFlight: boolean): TurnTail | null {
  if (inFlight || !turn.hasAnswer || turn.tailRow === -1) return null;
  const row = rows[turn.tailRow];
  if (row === undefined) return null;
  const durationMs =
    turn.openedAt > 0 && turn.closedAt >= turn.openedAt ? turn.closedAt - turn.openedAt : null;
  const self = row.kind === "single" ? row.message : null;
  const window = turn.decodeComplete && turn.decodeMs > 0 ? turn.decodeMs : durationMs;
  const usage = turn.usage;
  return {
    usage,
    durationMs,
    tps: usage === null || window === null || window <= 0 ? null : usage.output / (window / 1_000),
    model: turn.model,
    text: turn.text,
    at: turn.closedAt > 0 ? turn.closedAt : null,
    latest: false,
    // Neither a reminders row nor an engine notice is where a turn can be forked from: the first
    // names no message of its own, the second is not part of a turn at all.
    continueEntryId:
      self !== null && self.kind !== "reminder" && self.kind !== "notice"
        ? (self.entryId ?? null)
        : row.kind === "tools"
          ? (row.tools[row.tools.length - 1]?.entryId ?? null)
          : null,
  };
}

/**
 * Which assistant steps sat in a turn that went on after them.
 *
 * An answer followed by another answer in the same turn is one the engine retried away: it closed
 * with a failure, the turn continued, and the failure is the reason for the retry rather than the
 * turn's outcome. Its record still carries `stopReason: "error"` and the provider's words, so
 * drawing that as the row's ending put one red socket error on screen per attempt — and once the
 * turn-level ending cleared those rows, left their measured heights behind as blank space.
 */
function retriedAwaySteps(messages: ChatMessage[]): boolean[] {
  const retried = new Array<boolean>(messages.length).fill(false);
  let laterAnswer = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.kind === "user") {
      laterAnswer = false;
      continue;
    }
    if (message.kind !== "assistant") continue;
    retried[index] = laterAnswer;
    laterAnswer = true;
  }
  return retried;
}

/**
 * One step with the reasoning it wrote for itself read back out of both channels
 * (`readModelReasoning`).
 *
 * A model that thinks in the text channel writes an envelope around what it meant to think, and one
 * that streams its answer into the thinking channel writes a marker where the answer begins. Either
 * way the engine records the words where the model put them, and the envelope's names are the only
 * thing on this side that can tell those words from an answer, so the step is read as the reasoning
 * and answer it says it is. A step with no envelope is handed back as the same object — a frame that
 * changed nothing must still redraw nothing.
 */
function withModelReasoning(message: ChatMessage): ChatMessage {
  if (message.kind !== "assistant") return message;
  const { reasoning, answer } = readModelReasoning(message.text, message.thinking);
  if (answer === message.text && reasoning === message.thinking) return message;
  return { ...message, text: answer, thinking: reasoning };
}

export function buildRows(
  messages: ChatMessage[],
  options: BuildRowsOptions = {},
): TranscriptRow[] {
  const { streaming = false, turn = null, tipEntryId = null } = options;
  const ending = streaming ? null : rowEnding(turn);
  // The steps as the reader will see them: a step that wrote its reasoning into a channel's markup
  // (`readModelReasoning`) is read with that reasoning on the reasoning side and its answer in its
  // words, so no marker reaches a row, a preview, or a copy.
  const steps = messages.map(withModelReasoning);
  // A step whose words are a tool-call envelope nothing executed: the fragment is not an answer, so
  // it is read out of the words here and stated as what it is under the step (`readStrayToolCall`).
  // The step keeps its place — it spent tokens and took time like any other — and a caller reading
  // the message's text (a copy, a preview) never carries the markup.
  const strays = steps.map((step) =>
    step.kind === "assistant" ? readStrayToolCall(step.text) : null,
  );
  const shown = steps.map((step, index) =>
    strays[index] === null ? step : { ...step, text: "" },
  );
  const retriedAway = retriedAwaySteps(steps);
  const rows: TranscriptRow[] = [];
  let pending: ToolMessage[] = [];
  /** The run of reminders being collected: consecutive ones naming the same rule fold into it. */
  let pendingReminders: ReminderMessage[] = [];
  // Whether this turn's agent has been named yet, and where the current stretch of reasoning is
  // being collected.
  let named = false;
  let holder = -1;
  let thinking: string[] = [];
  /**
   * The turn being read, as its own steps report it.
   *
   * The footer is accumulated here rather than looked up at the end because the facts it carries
   * belong to the turn as a whole: a step the turn *did not draw* (one that only called a tool) still
   * spent tokens and still took time, and reading the rows back would lose it.
   */
  let draft = openTurn();
  /**
   * The last answer this turn drew a row for: where its ending belongs.
   *
   * A stop can land on a step that drew nothing but a tool call, and the answer before it is still
   * the turn's last row on screen — an ending under a folded run of calls has nowhere to be drawn.
   */
  let lastAnswerRow = -1;

  /**
   * Whether the speaker is still unnamed, and a row the turn draws may claim the name.
   *
   * A turn's first drawn row is its speaker, whatever kind that row is. The engine writes an
   * assistant message per step, and the step that only calls tools draws no row of its own — so a
   * turn whose first step called a tool used to start with placeholder rows and put the avatar and
   * the sender line on the answer *after* the calls, or, for a turn the reader stopped mid-call,
   * nowhere at all.
   */
  const claimName = (): boolean => {
    if (named) return false;
    named = true;
    return true;
  };

  /**
   * Fold the run of calls being collected into one row.
   *
   * Whatever it pushes is a row the turn drew, so it is the turn's last drawn row until something
   * else is drawn — a run of calls is very often where a turn ends, and the footer belongs under it
   * rather than above the calls it describes.
   */
  const flushTools = () => {
    if (pending.length === 1) {
      rows.push({
        kind: "single",
        id: pending[0].id,
        message: pending[0],
        namesSender: claimName(),
        thinking: "",
        thinkingLive: false,
        tail: null,
        ending: null,
        stray: null,
      });
    } else if (pending.length > 1) {
      rows.push({
        kind: "tools",
        id: `tools-${pending[0].id}`,
        tools: pending,
        namesSender: claimName(),
        tail: null,
      });
    }
    if (pending.length > 0) draft.tailRow = rows.length - 1;
    pending = [];
  };

  /**
   * Fold the run of reminders being collected into one row.
   *
   * A reminder is not the turn's row: it names nobody, carries no footer and states no ending, so it
   * never claims the speaker and never becomes where the turn ended.
   */
  const flushReminders = () => {
    if (pendingReminders.length > 0) {
      rows.push({
        kind: "reminders",
        id: pendingReminders[0].id,
        reminders: pendingReminders,
      });
      pendingReminders = [];
    }
  };

  /**
   * Fold everything being collected into rows, in the order it arrived.
   *
   * A reminder that arrived before this message is drawn before the row this message draws — the
   * transcript reads in the order the engine wrote it — so the reminder run is settled first.
   */
  const flush = () => {
    flushReminders();
    flushTools();
  };

  /** Hand the stretch of reasoning being collected to the row it belongs to. */
  const settleThinking = () => {
    if (holder !== -1 && thinking.length > 0) {
      const row = rows[holder];
      if (row !== undefined && row.kind === "single") {
        rows[holder] = { ...row, thinking: thinking.join("\n\n") };
      }
    }
    holder = -1;
    thinking = [];
  };

  /** Hand the turn its footer, once nothing more is coming from it. */
  const settleTail = (inFlight: boolean) => {
    const row = rows[draft.tailRow];
    // A reminder row is an annotation inside the turn: the footer belongs to the row the turn itself
    // last drew, so a tail never lands on one.
    if (row !== undefined && row.kind !== "reminders") {
      const tail = tailOf(draft, rows, inFlight);
      if (tail !== null) rows[draft.tailRow] = { ...row, tail };
    }
    draft.tailRow = -1;
  };

  /** Hand the turn its ending, once it is over and there is one to state. */
  const settleEnding = () => {
    if (ending === null || streaming) return;
    // The row the turn ends on, in the reader's order of preference: its last answer (the only row
    // an ending is drawn on), then the last row it drew, then the prompt that opened it — for a stop
    // that landed before anything else was drawn. Only a row that draws an ending is a candidate: a
    // folded run of calls carries none of its own, and neither does a lone call's row
    // (`SingleToolRow` has no ending slot), so a turn that ended on one states its ending on the
    // answer before it, or on the prompt when it drew no answer. The floor is what keeps a turn with
    // no rows of its own from putting its ending on the previous turn.
    const prompt = lastUserRowIndex(rows);
    const floor = turn === null ? 0 : prompt;
    const index = [lastAnswerRow, rows.length - 1, prompt].find((candidate) => {
      if (candidate < floor) return false;
      const row = rows[candidate];
      return row !== undefined && row.kind === "single" && row.message.kind !== "tool";
    });
    const row = index === undefined ? undefined : rows[index];
    if (index !== undefined && row !== undefined && row.kind === "single") {
      rows[index] = { ...row, ending };
    }
    lastAnswerRow = -1;
  };

  /** Start the next turn: the speaker is named again, and no reasoning carries over into it. */
  const closeTurn = (inFlight = false) => {
    flushReminders();
    settleThinking();
    settleTail(inFlight);
    draft = openTurn();
    named = false;
    lastAnswerRow = -1;
  };

  for (let messageIndex = 0; messageIndex < shown.length; messageIndex += 1) {
    const message = shown[messageIndex];
    if (message === undefined) continue;
    const stray = strays[messageIndex] ?? null;
    if (message.kind === "reminder") {
      // A reminder sits where it happened — between the call that tripped the rule and whatever the
      // agent did next — so the calls already collected are folded first, and a reasoning stretch is
      // closed: the reminder is not part of what was being thought. `flushTools` rather than `flush`:
      // the run of reminders being collected stays open, which is what folds two in a row into one.
      flushTools();
      settleThinking();
      const last = pendingReminders[pendingReminders.length - 1];
      const parsed = parseReminder(message.text);
      const previous = last === undefined ? null : parseReminder(last.text);
      if (
        last === undefined ||
        parsed === null ||
        previous === null ||
        !sameReminder(parsed, previous)
      ) {
        flushReminders();
      }
      pendingReminders.push(message);
      continue;
    }
    if (message.kind === "notice") {
      // An engine notice kept in the transcript (the idle recap, a compaction's report). It arrives
      // between turns, so the calls above are folded first; the row carries the sentence itself —
      // no footer, no ending — because it is an annotation on the conversation rather than a step
      // of it. `namesSender` stays false here because the pane, not the row, decides the speaker
      // line: the report gets the agent's, the recap none (`home/ConversationPane.tsx`).
      flush();
      rows.push({
        kind: "single",
        id: message.id,
        message,
        namesSender: false,
        thinking: "",
        thinkingLive: false,
        tail: null,
        ending: null,
        stray: null,
      });
      continue;
    }
    if (message.kind === "tool") {
      // A `task` call supervises a batch rather than being one of one: it keeps its own row so the
      // roster of children it spawned is on screen, instead of folded into a collapsed count.
      // A call that produced pictures is the same case for the same reason: the picture is the
      // output, and a folded run would hide it behind the count (`ConversationToolRow` draws it
      // outside the fold; this keeps the whole row from folding).
      // A search is the same case again, for the answer it supports: the query, the provider's
      // answer and the pages it read are what a reader checks the claim against, and a count over
      // a folded run states none of them (2026-10-31, user report: websearch 的搜索输出不要收起).
      if (
        message.name === "task" ||
        message.name === "web_search" ||
        message.images?.length
      ) {
        flush();
        rows.push({
          kind: "single",
          id: message.id,
          message,
          namesSender: claimName(),
          thinking: "",
          thinkingLive: false,
          tail: null,
          ending: null,
          stray: null,
        });
        draft.tailRow = rows.length - 1;
        settleThinking();
        continue;
      }
      // A call ends the stretch of reasoning that led to it: whatever the next step thinks is a new
      // thought, and drawing the two as one block is what made a turn read as a single wall of
      // planning.
      settleThinking();
      pending.push(message);
      continue;
    }
    // The turn's own account of itself is read from every step it wrote, including the ones it does
    // not draw: a step that only called a tool spent tokens and took time like any other, and the
    // footer under the turn is what says so.
    if (message.kind === "assistant") addStep(draft, message);
    // An assistant turn that only calls tools carries no text and no reasoning of its own. Rendering
    // it would put a bare avatar above every call — and, because it sits between them, would also
    // stop consecutive calls from folding into one row. A step that reasoned is *not* one of those:
    // its reasoning is content, and it is drawn on a row of its own.
    const retried =
      message.kind === "assistant" && retriedAway[messageIndex] === true;
    const reasoning = message.kind === "assistant" ? message.thinking.trim() : "";
    // A retried-away step whose only content is its failure draws nothing: the attempt it made is
    // already in the turn's footer, and a row with no words, no reasoning and no ending is a blank
    // stretch of transcript.
    // A step whose words were a tool call nothing executed is neither blank nor wordless: its note
    // is what the step has to say, and it is the reason the turn stopped where it did.
    const blank =
      stray === null &&
      (isBlankAssistant(message) ||
        (retried &&
          message.kind === "assistant" &&
          !message.text.trim() &&
          !reasoning &&
          !message.images?.length));
    if (
      blank ||
      (stray === null &&
        message.kind === "assistant" &&
        !reasoning &&
        !carriesItsOwn(message))
    )
      continue;
    // The reader's own prompt closes the turn above it — but only after that turn's waiting calls
    // have been folded into their row, so the name is decided while the turn it belongs to is still
    // the one being read.
    if (message.kind === "user") {
      flush();
      closeTurn();
      // The prompt is what the turn's own wall clock is measured from.
      draft.openedAt = message.at;
    } else {
      flush();
    }
    const names = message.kind === "user" ? true : claimName();
    rows.push({
      kind: "single",
      id: message.id,
      message,
      namesSender: names,
      thinking: "",
      thinkingLive: false,
      tail: null,
      ending: null,
      stray,
    });
    if (message.kind === "assistant") {
      // The answer is now the last row the turn drew, and the footer follows the turn rather than
      // the answer: a step that answers and then calls a tool is not the turn's last word, and a
      // footer under it is a finished-looking answer in the middle of a turn still being written.
      draft.tailRow = rows.length - 1;
      // The ending sits under the turn's last answer: a stop can land on a step that only called
      // tools, and the answer before it is still the turn's last row an ending can be drawn on.
      lastAnswerRow = rows.length - 1;
      // Every answer states the ending its own record carries. The turn-level record below can only
      // speak about the *last* turn this process ran, so an earlier failure or stop would otherwise
      // vanish the moment the reader sends another prompt - and a conversation read back from disk
      // has no turn record at all. The last turn's own retried-away attempts are cleared below, so
      // this never reports the same turn twice.
      const own = messageEnding(message, retried, stray);
      if (own !== null) {
        const row = rows[rows.length - 1];
        if (row.kind === "single") rows[rows.length - 1] = { ...row, ending: own };
      }
      if (reasoning) {
        // Adjacent steps with nothing between them are one stretch of thinking; a step that drew an
        // answer of its own closes it, and so does a call (above).
        if (holder === -1) holder = rows.length - 1;
        thinking.push(reasoning);
      }
      if (carriesItsOwn(message)) settleThinking();
    }
  }
  flush();
  flushReminders();
  // The turn the host named is the last one, and it is stated once, by the turn's own ending. Any
  // ending an individual message of it carries is either an attempt the engine retried away or the
  // same fact again; leaving it would report one failure twice (or keep a retried attempt's error
  // on screen after the retry succeeded). Earlier turns keep theirs: `lastTurn` cannot speak for
  // them.
  if (turn !== null) {
    const prompt = lastUserRowIndex(rows);
    for (let index = prompt + 1; index < rows.length; index += 1) {
      const row = rows[index];
      // A step that answered with an unparsed tool call keeps its note: the turn's own outcome
      // cannot carry that fact, and the note is why the step said nothing rather than the same
      // failure reported twice.
      if (
        row.kind === "single" &&
        row.ending !== null &&
        row.ending.outcome !== "miscall"
      ) {
        rows[index] = { ...row, ending: null };
      }
    }
  }
  settleEnding();
  closeTurn(streaming);

  // The newest turn is the one no later prompt opened behind it: its footer stays in view while every
  // earlier turn's waits for the hover or the focus that puts the reader on it. Only the last turn
  // can be that one, and its fork point falls back to the host's own tip — the entry a row drawn from
  // live frames never named for itself.
  const lastPrompt = lastUserRowIndex(rows);
  for (let index = rows.length - 1; index > lastPrompt; index -= 1) {
    const row = rows[index];
    if (row.kind === "reminders" || row.tail === null) continue;
    rows[index] = {
      ...row,
      tail: { ...row.tail, latest: true, continueEntryId: row.tail.continueEntryId ?? tipEntryId },
    };
    break;
  }

  if (streaming) {
    // The reasoning is the live output until its own answer starts arriving: the engine thinks
    // first, and a collapsed block over that stretch is a turn that looks like nothing is happening.
    // The step it belongs to is the last one written — a call after it means it has stopped
    // thinking and gone to work.
    const last = shown[shown.length - 1];
    if (
      last?.kind === "assistant" &&
      last.thinking.trim() &&
      !last.text.trim()
    ) {
      const index = rows.findIndex((row) => row.kind === "single" && row.id === last.id);
      const row = rows[index];
      if (row !== undefined && row.kind === "single") {
        rows[index] = { ...row, thinkingLive: true };
      }
    }
  }
  return rows;
}

/**
 * Whether a step has something of its own to draw: words, a failure, pictures, or a stop the reader
 * caused. Everything else a step carries is either the turn's shared reasoning or the engine's own
 * bookkeeping.
 */
function carriesItsOwn(message: ChatMessage): boolean {
  if (message.kind !== "assistant") return true;
  return (
    Boolean(message.text.trim() || message.error || message.images?.length) ||
    stoppedByReader(message)
  );
}

/**
 * Whether this step was stopped rather than finished.
 *
 * Two ways the engine states it. A message it recorded a reason for says `aborted`; a turn the
 * reader stopped before any step wrote a reason is the engine's own `Interrupted by user` on the
 * message's error, or the sentinel a bare abort carries. Both are stops the reader caused, and both
 * are what the row has to draw a line under — a turn cut off mid-step otherwise reads as an empty
 * answer and is dropped as blank.
 *
 * A step whose failure the engine retried away is *not* one of these: it carries an error, so it
 * draws its own row, and the turn's outcome is stated once by {@link rowEnding} on the row the turn
 * ends on.
 */
export function stoppedByReader(message: ChatMessage): boolean {
  if (message.kind !== "assistant") return false;
  if (message.stopReason === "aborted") return true;
  return ABORT_SENTINELS.some((sentinel) => message.error === sentinel);
}

/**
 * The ending an answer states from its own record, for a conversation read back from disk.
 *
 * The engine's own reading of a message (`pi-tui/src/chat/transcript-render-helpers.ts`): only two
 * stop reasons are an ending a reader is shown. `aborted` is the reader's own act — even when the
 * engine wrote a sentence on it, which is what makes a stop read like a crash. `error` is a failure
 * and keeps the engine's words. `stop`, `length` and `toolUse` are the engine's own bookkeeping for
 * a step that finished (a step that called a tool ended with `toolUse`, and every one of them would
 * otherwise read as a failure after a reload).
 */
function messageEnding(
  message: ChatMessage,
  retriedAway = false,
  stray: StrayToolCall | null = null,
): RowEnding | null {
  if (message.kind !== "assistant") return null;
  // The step's words were a tool call nothing executed: it answered nothing, and no call ran. That
  // is stated even when the engine retried the step away — the missing call is what the reader is
  // looking for, and the retry that followed it does not undo the fact.
  if (stray !== null) return { outcome: "miscall", error: null };
  // The engine continued after this step, so the failure it carries was retried away. Keeping it
  // would report the same failure once per attempt and, on a stopped turn, leave its empty row
  // behind after the turn-level ending cleared it.
  if (retriedAway) return null;
  const error = message.error?.trim() || null;
  if (message.stopReason === "aborted") return { outcome: "aborted", error: null };
  if (message.stopReason === "error" || error !== null) {
    if (error !== null && ABORT_SENTINELS.includes(error)) return { outcome: "aborted", error: null };
    return { outcome: "failed", error };
  }
  return null;
}

/**
 * The engine's own words for an abort that carried no reason, and the label a user interrupt is
 * threaded through as (`pi-tui/src/chat/messages.ts`). Neither is an error a reader should see as
 * one: they say the turn was stopped, which the row states in its own words.
 */
const ABORT_SENTINELS = ["Request was aborted", "Request was aborted.", "Interrupted by user"];

export function isBlankAssistant(message: ChatMessage): boolean {
  return (
    message.kind === "assistant" &&
    !message.text.trim() &&
    !message.thinking.trim() &&
    !message.error &&
    !message.stopReason &&
    !message.images?.length
  );
}

/** Whether a row is the reader's own words. */
export function isUserRow(row: TranscriptRow): boolean {
  return row.kind === "single" && row.message.kind === "user";
}

/** The last row the reader opened a turn with, or -1 when the transcript holds no prompt. */
function lastUserRowIndex(rows: readonly TranscriptRow[]): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (isUserRow(rows[index])) return index;
  }
  return -1;
}

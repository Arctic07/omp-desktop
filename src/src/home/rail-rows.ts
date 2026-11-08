// Relative, with its extension: this module is read by the test runner as well as by the bundler,
// and the runner has no alias to resolve.
import { isUserRow, RUNNING_ROW_ID, toolRunOutcomes, type TranscriptRow } from "./conversation-rows.ts";
import { railPreview } from "../components/agents/rail-preview.ts";
import { draftProse } from "../state/composer-draft.ts";
import { messageProse } from "./system-notice.ts";

/**
 * The navigation rail's own records: one conversation turn, as the list beside the transcript
 * reads it.
 *
 * A turn's card is its prompt as the title and the last body the agent wrote as the content — not
 * the arguments of a call or a row's own label. The list is derived from the transcript's rows
 * rather than from the document, which is what lets it cover a conversation whose rows are not all
 * drawn. That derivation is also the one thing a streamed delta used to make expensive: every frame
 * re-read every row's text out of the DOM. So the list is kept behind a cache — a pass over the
 * turns compares what it read last time and rebuilds only the entries whose own text changed, and an
 * unchanged pass returns the very array it returned before, which keeps the rail's own rendering off
 * the streaming path entirely.
 *
 * Even one entry per turn is more marks than the rail's box can draw in a very long conversation:
 * the list is built whole and then *selected* down to the room the rail has (`selectRailItems`), by
 * how much each turn deserves a mark.
 */

/**
 * One entry of the navigation rail.
 *
 * Declared here rather than imported from the rail's own component so that this module stays a
 * module about the conversation: it is data, and the rail is what draws it. What the rail needs of
 * an entry is all it holds, so the list goes straight through — `rank` included, which the rail
 * itself never reads.
 */
export interface RailEntry {
  id: string
  label: string
  description?: string
  /** The row's accessible name, composed from the position the rail draws it at. */
  ariaLabel?: (index: number, total: number) => string
  /** What this turn deserves when the rail has no room for every one of them. */
  rank: number
}

/** The wording the rail's own rows carry, read from the surface that draws the transcript. */
export interface RailCopy {
  /** What a row whose text is empty is called. */
  message: string
  /** What a row that carries nothing but the agent's reasoning is called. */
  thinking: string
  /** What the turn in flight reads as, while it is the last row. */
  working: string
  /** What a rule reminder's row reads as before the row it annotates. */
  reminder: string
  /** What a run of tool calls reads as, with how many calls it holds. */
  toolCalls: (count: number) => string
  /** How many calls of that run settled successfully, read beside the count once one failed. */
  toolSucceeded: (count: number) => string
  /** How many calls of that run failed, so a mixed run never reads as all failed. */
  toolFailedCount: (count: number) => string
  /** A rail row's accessible name; the row's own sender, position and total. */
  railItemLabel: (sender: string, index: number, total: number) => string
}

/** One line of a row's text, the way a card would read it. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * What a row reads as.
 *
 * A row's card shows the text the row itself draws, not the whole row: a prompt's own words without
 * the engine's notices above them, an answer's own text, the count a folded run of calls stands for.
 * The wording an empty row falls back to is the label its own row carries, so a preview of the
 * reasoning reads as "Thinking" rather than as nothing.
 */
export function rowText(row: TranscriptRow, copy: RailCopy): string {
  if (row.kind === "reminders") {
    // The rail reads what the row draws: a rule check is not what a turn was about, and the row it
    // annotates is right beside it.
    return copy.reminder
  }
  if (row.kind === "tools") {
    const { succeeded, failed } = toolRunOutcomes(row.tools)
    // A run that holds one failure states both sides of the split: "4 calls · 1 failed" reads as if
    // all four failed, which is the report this wording answers (2026-11-02, user report: 应该写好
    // 多少成功 多少失败 不然一眼看去全是失败).
    const outcomes =
      failed > 0
        ? `${succeeded > 0 ? ` · ${copy.toolSucceeded(succeeded)}` : ""} · ${copy.toolFailedCount(failed)}`
        : ""
    return `${copy.toolCalls(row.tools.length)}${outcomes}`
  }
  const message = row.message;
  if (message.kind === "user") {
    const prose = messageProse(message.text);
    // A prompt's own words, with the files' characters taken out of them: a card reads what was
    // written, and a character standing for a file is not one of the words.
    return collapse(draftProse(prose)) || collapse(draftProse(message.text));
  }
  if (message.kind === "assistant") {
    // The card reads what the row draws, and the row draws the engine's tagged blocks as cards
    // rather than as their text: a peer's IRC message or a delivery must not become the preview of
    // an answer as a wall of angle brackets. An emphasized block is the answer's own words, though,
    // and it is what the reader would call the answer — so its body stays (`messageProse`).
    const prose = messageProse(message.text);
    // A row that reasoned and then went to work carries no words of its own: it reads as the
    // reasoning the reader watched, not as a message with nothing in it.
    return collapse(prose) || (row.thinking ? copy.thinking : copy.message);
  }
  return message.kind === "tool" ? collapse(message.intent ?? message.name) : "";
}

/** One row's rail entry, and the readings it was built from. */
interface CachedRailItem {
  text: string
  response: string
  rank: number
  /**
   * The wording the entry was built with.
   *
   * The card's label, its empty-row fallback and its accessible name are all text, so a reader who
   * switches language while the conversation is open has to be handed new entries — the cache
   * compares this reference for exactly that reason (`HomeCopy` is rebuilt when the language moves).
   */
  copy: RailCopy
  item: RailEntry
}

/**
 * What the rail was built from last time, so a pass can tell what actually changed.
 *
 * It is kept by the caller rather than by this module: two transcripts are two lists, and a cache
 * shared between them would answer one with the other's rows.
 */
export interface RailCache {
  entries: Map<string, CachedRailItem>
  items: RailEntry[] | null
}

export function createRailCache(): RailCache {
  return { entries: new Map(), items: null };
}

/** One turn of the conversation, from the reader's prompt to the answer it drew. */
interface TurnGroup {
  /** The turn's first row: the prompt, or the first row when the transcript starts mid-turn. */
  id: string
  first: TranscriptRow
  rows: TranscriptRow[]
}

function turnGroups(rows: readonly TranscriptRow[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const row of rows) {
    if (groups.length === 0 || isUserRow(row)) {
      groups.push({ id: row.id, first: row, rows: [row] });
    } else {
      groups[groups.length - 1]!.rows.push(row);
    }
  }
  return groups;
}

/** The last thing the agent actually wrote in one turn: its final answer body, not a call. */
function finalAnswer(group: TurnGroup): string {
  let answer = "";
  for (const row of group.rows) {
    if (row.kind !== "single" || row.message.kind !== "assistant") continue;
    // The card reads the answer, not the engine's tagged blocks inside it: the same split the
    // transcript draws, so a reminder cannot become the preview of an answer.
    const prose = messageProse(row.message.text);
    const text = collapse(prose);
    if (text !== "") answer = text;
  }
  return answer;
}

/**
 * The rail's own records: one per turn, in the conversation's order.
 *
 * A turn is the reader's prompt and everything the agent did in answer to it, so its entry reads
 * as that turn: the prompt is the title, the last answer body is the content, and the card draws
 * them clipped rather than a row's arguments or a call's result. Rows before the first prompt (a
 * transcript read back from its middle) are the leading group, named by their own first row.
 *
 * The items are re-used by identity, and the array itself is re-used when nothing about it changed —
 * a streamed delta inside the newest turn therefore updates that turn's preview and leaves every
 * earlier entry alone. The accessible name is left as a function of the turn's position rather than
 * baked in, because a position changes whenever a turn is appended.
 */
export function railItems(
  rows: TranscriptRow[],
  running: boolean,
  copy: RailCopy,
  cache: RailCache,
): RailEntry[] {
  const groups = turnGroups(rows);
  const entries = new Map<string, CachedRailItem>();
  const items: RailEntry[] = [];
  let changed = false;

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const prompted = isUserRow(group.first);
    const prompt = prompted ? rowText(group.first, copy) : "";
    // The card's title is the prompt and appears the moment the reader sends it; its content is
    // the answer, and an answer only becomes *the* answer when the turn ends. While the last turn
    // is still running the card says so instead of following every streamed delta — a focus card
    // that rewrites itself word by word is noise, and re-reading every row per frame is the rail's
    // one expensive pass (2026-10-20, user request).
    const inFlight = running && index === groups.length - 1;
    const answer = inFlight ? copy.working : finalAnswer(group);
    const rank = prompted ? RAIL_RANK.prompt : RAIL_RANK.body;
    const cached = cache.entries.get(group.id);
    if (
      cached !== undefined &&
      cached.copy === copy &&
      cached.text === prompt &&
      cached.response === answer &&
      cached.rank === rank
    ) {
      entries.set(group.id, cached);
      items.push(cached.item);
      continue;
    }
    changed = true;
    const sender = prompted ? "user" : "assistant";
    const item: RailEntry = {
      id: group.id,
      rank,
      ...railPreview(prompt, answer, copy.message),
      ariaLabel: (at: number, of: number) => copy.railItemLabel(sender, at, of),
    };
    entries.set(group.id, { text: prompt, response: answer, rank, copy, item });
    items.push(item);
  }

  // A conversation with no rows at all still has a turn in flight, and it is the only mark it has.
  if (groups.length === 0 && running) {
    const cached = cache.entries.get(RUNNING_ROW_ID);
    if (cached !== undefined && cached.copy === copy && cached.text === copy.working) {
      entries.set(RUNNING_ROW_ID, cached);
      items.push(cached.item);
    } else {
      changed = true;
      const item: RailEntry = {
        id: RUNNING_ROW_ID,
        label: copy.working,
        rank: RAIL_RANK.body,
        ariaLabel: (at: number, of: number) => copy.railItemLabel("assistant", at, of),
      };
      entries.set(RUNNING_ROW_ID, {
        text: copy.working,
        response: "",
        rank: RAIL_RANK.body,
        copy,
        item,
      });
      items.push(item);
    }
  }

  cache.entries = entries;
  if (changed || cache.items?.length !== items.length) {
    cache.items = items;
  }
  return cache.items ?? items;
}

/**
 * What a turn deserves, when the rail has no room for every turn.
 *
 * A turn that begins with the reader's prompt is the skeleton of the conversation; a leading group
 * of rows read from the middle of a turn is the body. Equal ranks are spread over the room
 * (`selectRailItems`), so no part of a long conversation disappears from the rail.
 */
const RAIL_RANK = { prompt: 1, body: 0 } as const;

/** Those ranks, best first: the order the rail spends its marks in. */
const RAIL_RANKS: readonly number[] = [RAIL_RANK.prompt, RAIL_RANK.body];

/**
 * The marks the rail draws: at most `capacity` of them, the rows that matter most kept, in the
 * conversation's own order.
 *
 * The newest row is always one of them — the rail's last mark is the foot of the transcript, and
 * both the scroller and the feed read it as "take me to the newest" — and the rest are taken a rank
 * at a time. A rank with more rows than marks left is spread over all of its rows rather than cut
 * off at its end, so what is left still describes the whole conversation: the first mark is the
 * conversation's first row, the last is its newest, and the reader's own prompts, the failures and
 * the turn boundaries are the marks in between.
 */
export function selectRailItems(items: RailEntry[], capacity: number): RailEntry[] {
  if (items.length <= capacity) return items;
  const kept = new Set<number>([items.length - 1]);
  for (const rank of RAIL_RANKS) {
    const slots = capacity - kept.size;
    if (slots <= 0) break;
    const candidates: number[] = [];
    for (let index = 0; index < items.length; index += 1) {
      if (!kept.has(index) && items[index].rank === rank) candidates.push(index);
    }
    for (const index of spread(candidates, slots)) kept.add(index);
  }
  return items.filter((_, index) => kept.has(index));
}

/**
 * Up to `slots` of these positions, spread over all of them.
 *
 * Both ends are kept and the rest are taken at an even stride: a run of twenty rows with five marks
 * to give it is drawn as the first, the last and three in between.
 */
function spread(candidates: number[], slots: number): number[] {
  if (candidates.length <= slots) return candidates;
  if (slots === 1) return [candidates[candidates.length - 1]];
  const picked: number[] = [];
  for (let step = 0; step < slots; step += 1) {
    picked.push(candidates[Math.round((step * (candidates.length - 1)) / (slots - 1))]);
  }
  return picked;
}

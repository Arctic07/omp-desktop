import { AgentActivity } from "@/components/agents/agent-activity";
import { parseUnifiedDiff } from "@/components/agents/diff-lines";
import { FileDiff } from "@/components/agents/file-diff";
import { ToolResult, ToolResultOutput } from "@/components/agents/tool-result";
import { PluginToolCard, usePluginSlotSessionId } from "@/components/plugins/plugin-slot";
import { TaskAgents } from "@/home/TaskAgents";
import { ConversationImages } from "@/home/ConversationImages";
import type { BackgroundJob, SubagentRow, ToolDetails } from "@/api/session-types";
import { hasSearchCard, type ToolMessage } from "@/home/conversation-rows";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatDuration, formatMinimized, summarizeToolArgs } from "@/home/conversation-format";
import { COPY } from "@/home/homeCopy";
import { rosterOf, taskRowStatus } from "@/home/task-roster";
import { toolCardNameOf } from "@/state/plugin-slot-rules";

export type { ToolMessage };

export interface ConversationToolRowProps {
  message: ToolMessage;
  /** Every subagent the conversation has reported, keyed by its own id. */
  subagents: Record<string, SubagentRow>;
  /**
   * The conversation's running background jobs.
   *
   * A detached `task` job's id is the child's own id, so once the call has answered this is the
   * host's current answer to "which children are still running". A roster frame can stop before a
   * child's work does; without this, that row keeps spinning after the child is gone.
   */
  backgroundJobs?: readonly BackgroundJob[];
  /**
   * The reader's own decision about this call's body, or null while they have not made one.
   *
   * It is handed in rather than kept here because the reader's decisions outlive the row: a windowed
   * transcript unmounts the rows that scroll out of it, and the row that comes back must be the one
   * they left — open if they opened it. The pane owns the map (`ConversationPane`).
   */
  chosen: boolean | null;
  onDisclosureChange: (open: boolean) => void;
  /**
   * Open one of this call's `task` children, where the caller can show it.
   *
   * Absent where there is nowhere to open it (a transcript drawn without the tool column); the
   * roster is then the plain list it is, with no row claiming to be a way in.
   */
  onOpenSubagent?: (childId: string, label: string) => void;
  className?: string;
}

/**
 * The call's own outcome, as the desktop states it.
 *
 * `state` is the whole of it: the live path sets it on `tool_started` and again on
 * `tool_finished`, and the cold path pairs each call with its `toolResult`. `endedAt` is *not* a
 * second opinion — the desktop leaves it null on every row read back from disk, because the host
 * clock exists only while a turn is live, so reading it as "still running" would report every
 * finished call in an old conversation as in flight.
 */
function statusOf(message: ToolMessage) {
  if (message.state === "error") return "error" as const;
  return message.state === "success" ? ("success" as const) : ("running" as const);
}

/** A source's host, for the search card's second line; the URL itself when it cannot be parsed. */
function sourceDomain(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The call's arguments as data when the engine's text parses, as that text when it does not.
 *
 * Mid-stream arguments are truncated JSON, and a card that only ever received the raw string would
 * have to parse it again; a card that only ever received data would lose a partially written call.
 */
function toolArgsOf(argsText: string): unknown {
  if (argsText.trim() === "") return null;
  try {
    return JSON.parse(argsText) as unknown;
  } catch {
    return argsText;
  }
}

export function ConversationToolRow({
  message,
  subagents,
  backgroundJobs,
  chosen,
  onDisclosureChange,
  onOpenSubagent,
  className,
}: ConversationToolRowProps) {
  const copy = useCopy(COPY);
  const sessionId = usePluginSlotSessionId();
  const callStatus = statusOf(message);
  const duration =
    message.startedAt !== null && message.endedAt !== null
      ? formatDuration(message.endedAt - message.startedAt)
      : "";
  const summary = summarizeToolArgs(message.argsText);
  const details: ToolDetails = message.details ?? {};

  const roster = rosterOf(message, subagents, backgroundJobs);

  /**
   * What the call reported as its own structured result, when it reported one.
   *
   * A search and a `task` are the two calls whose body is not their arguments: a search is the query
   * it ran, the answer the provider wrote (when it writes prose) and the pages it read, a `task` is
   * the roster of children it supervised. Drawn as the arguments JSON and the result text they are
   * a wall of raw code in a monospaced block — which is exactly what a reader sees instead of the
   * component the library has for it. Both are drawn with beUI's `AgentActivity` (a search card, a
   * trace roster); the raw payload stays where it is the only thing there is, on every other call.
   */
  const sources = details.sources ?? []
  const answer = details.answer?.trim() ?? ''
  // `tool_updated` frames carry `details` while a call runs, so a search that streams its card
  // would open mid-flight. The card is a result; the row waits for the call to settle.
  const searching = callStatus !== "running" && hasSearchCard(sources, answer)
  const tasking = roster.length > 0 || (details.subagents?.length ?? 0) > 0;
  const query = message.intent ?? summary ?? message.name;
  const searchResults = sources.map((source, index) => ({
    id: `${message.id}-source-${index}`,
    title: source.title.trim() || source.url,
    domain: sourceDomain(source.url),
    url: source.url,
    snippet: source.snippet.trim() || undefined,
  }));

  /**
   * What the call opens itself for.
   *
   * A `task` batch does. Its roster is the children's progress and the way into each child's
   * own conversation, and a detached spawn answers in milliseconds while the children work for
   * minutes — nothing else on the row says which of them is still running.
   *
   * A search does too, once it has its search card: the query it ran, the answer the provider
   * wrote and the pages it read are the evidence a reader judges that answer by, and a folded row
   * leaves them behind one click (2026-10-31, user report: websearch 的搜索输出不要收起，这样用户
   * 才知道搜索了哪些、可信度够不够). It opens once the call is settled and the card has content, not
   * when the call starts: a search still in flight is not the flash of JSON the rule below objects
   * to, and `tool_updated` frames may carry a partial card while it runs.
   *
   * Every other call starts folded, running or not (2026-10-24, user report: 工具调用太快了，
   * 默认展开再自动收起不好): a call that opened once it had output was open for however long the
   * tool took and folded the moment it answered, which on a fast call is a flash of JSON and result
   * and then nothing. Its header already states the call, and its status word (运行中 / 已完成) is
   * drawn there while it runs, so a folded row still answers "is it doing anything?".
   *
   * `chosen` is the reader's own decision, and it outranks this in both directions: what they opened
   * stays open after the work ends, and what they closed stays closed while output is arriving.
   */
  const working = roster.some((row) => row.status === "running" || row.status === "pending");
  // A `task` call is not its own row: a detached spawn returns in milliseconds and leaves children
  // working for minutes, and an abort settles those children after the call has already answered.
  // The batch therefore settles the badge (running / failed / cancelled), and `taskRowStatus` is
  // where that ranking lives (2026-10-23, reader report: 中止后 task 仍是 已完成).
  const status = taskRowStatus(callStatus, roster);
  // A roster is the call's output, not its payload: once it has children, its rows stay on screen
  // as the record of what they did unless the reader folds it away themselves. The old rule closed
  // it the moment the last child settled, leaving only the header's badge — and that badge is gone.
  // The search card is the same bargain: sources on screen for the reader to check, until they
  // fold it themselves.
  const open = chosen ?? (tasking || working || searching);

  /**
   * The minimizer's record, when this call has one.
   *
   * Only a `bash` result carries it, and only when the output minimizer rewrote what the command
   * printed. It is drawn above the result text because that text is the minimized capture: nothing
   * in it says the raw output was larger, or where the rest of it lives.
   */
  const minimized = details.minimized;

  const changes = details.files?.length
    ? details.files
    : details.diff
      ? [{ path: details.path ?? message.name, diff: details.diff, firstChangedLine: details.firstChangedLine }]
      : [];

  const durationMs =
    message.startedAt !== null && message.endedAt !== null
      ? message.endedAt - message.startedAt
      : null;

  const card = (
    <ToolResult
      tool={message.name}
      title={message.intent ?? summary ?? message.name}
      status={status}
      kind="custom"
      meta={
        <span className="flex items-center gap-2">
          {duration ? <span className="tabular-nums">{duration}</span> : null}
          {status === "running" ? <span>{copy.toolRunning}</span> : null}
          {status === "error" ? <span>{copy.toolFailed}</span> : null}
        </span>
      }
      defaultOpen={false}
      open={open}
      onOpenChange={onDisclosureChange}
      collapseOnComplete={false}
      className={cn("min-w-0", className)}
      afterHeader={
        // The pictures a call produced are its output, not its detail: they sit outside the fold
        // (and outside the scroll box) so a screenshot is on screen whether the call is open or not.
        message.images?.length ? (
          <div className="min-w-0 pb-1.5 pt-1">
            <ConversationImages images={message.images} label={copy.toolImages} />
          </div>
        ) : undefined
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        {/* The roster leads for a `task` call: it is what the call is, and the payload it was handed
            is a wall of JSON that would otherwise bury it. Each row is the way into that child's own
            conversation, under the name the row itself prints. */}
        {roster.length > 0 ? (
          <TaskAgents rows={roster} onOpenSubagent={onOpenSubagent} />
        ) : null}

        {/* A search is the query and the pages it read, as the search card the library draws: the
            raw result text repeats that list line for line, so it is not drawn beside it. */}
        {searching ? (
          <section className="flex min-w-0 flex-col gap-1.5">
            <AgentActivity
              items={[
                {
                  id: message.id,
                  type: "search",
                  query,
                  answer: answer === "" ? undefined : answer,
                  results: searchResults,
                },
              ]}
              status={status === "running" ? "working" : "complete"}
              defaultOpen
              collapseOnComplete={false}
              maxHeight={320}
            />
          </section>
        ) : null}

        {/* The arguments are the body of a call that has nothing better to draw: a search's JSON is
            not the search, and a `task`'s is not the roster. */}
        {!searching && !tasking && message.argsText.trim() ? (
          <section className="flex min-w-0 flex-col gap-1.5">
            <h4 className="text-xs font-medium text-muted-foreground">{copy.toolArgs}</h4>
            <ToolResultOutput language="text">{message.argsText}</ToolResultOutput>
          </section>
        ) : null}

        {changes.map((change, index) => (
          <FileDiff
            key={`${change.path}-${index}`}
            file={change.path}
            lines={parseUnifiedDiff(change.diff ?? "")}
            status={status === "running" ? "streaming" : "complete"}
            defaultOpen
            collapseOnComplete={false}
            copyText={change.diff}
          />
        ))}

        {/* A `task`'s roster above is the whole output, and a search's result is the list above:
            the raw result sentence on top of either is a second account of the same run. Every
            other call reads its result here. */}
        {!searching && !tasking ? (
          <section className="flex min-w-0 flex-col gap-1.5">
            <h4 className="text-xs font-medium text-muted-foreground">{copy.toolResult}</h4>
            {/* The body below is the minimized capture, so it cannot say a larger one exists.
                The engine's card states it in one line (`git 120.4KB → 3.2KB`), and the same line
                sits above the text here — a reader comparing the two surfaces reads one number. */}
            {minimized ? (
              <p className="text-[11px] tabular-nums text-muted-foreground/70">
                {copy.toolMinimized(formatMinimized(minimized))}
              </p>
            ) : null}
            {message.resultText.trim() ? (
              <ToolResultOutput language="text">{message.resultText}</ToolResultOutput>
            ) : (
              <p className="text-xs text-muted-foreground">{copy.toolEmptyResult}</p>
            )}
          </section>
        ) : null}
      </div>
    </ToolResult>
  );

  // The card a plugin registered for its own tool (`tool.card`), or this one. Registration settled
  // ownership: an engine built-in's name and another plugin's are never mounted here. The name is
  // read through `toolCardNameOf`, because a plugin tool arrives as an `xd://` device call on one of
  // the carrier tools rather than under its own name.
  const cardName = toolCardNameOf({ name: message.name, argsText: message.argsText });
  return (
    <PluginToolCard
      toolName={cardName}
      props={{
        toolName: cardName,
        toolCallId: message.toolCallId,
        toolArgs: toolArgsOf(message.argsText),
        toolStatus: status,
        toolResult: message.resultText,
        toolError: status === "error" ? message.resultText : null,
        durationMs,
        messageId: message.id,
        sessionId,
      }}
      fallback={card}
    />
  );
}

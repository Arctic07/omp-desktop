import { ChevronDown, ChevronRight, Undo2 } from "lucide-react";
import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { TextShimmer } from "@/components/motion/text-shimmer";
import { Tooltip } from "@/components/motion/tooltip";
import { Message, MessageContent, MessageHeader } from "@/components/agents/message";
import { MessageBubble, MessageBubbleContent } from "@/components/agents/message-bubble";
import { SystemNoticeCard } from "@/components/agents/system-notice";
import type {
  BackgroundJob,
  ChatAttachmentRef,
  ChatMessage,
  SessionRetry,
  SubagentRow,
} from "@/api/session-types";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { AssistantRow } from "@/home/AssistantRow";
import { AttachmentChip } from "@/home/AttachmentChip";
import { ConversationTurnTail } from "@/home/ConversationTurnTail";
import { CopyButton } from "@/home/CopyButton";
import { TurnEndingNote } from "@/home/TurnEndingNote";
import { formatClock, summarizeToolArgs } from "@/home/conversation-format";
import { isModelTag, messageProse, splitSystemNotices } from "@/home/system-notice";
import { RecapRow } from "@/components/agents/recap-row";
import { ReminderRow } from "@/components/agents/reminder-row";
import { ConversationToolRow, type ToolMessage } from "@/home/ConversationToolRow";
import {
  PluginSlot,
  PluginSlotSessionProvider,
  usePluginSlotSessionId,
} from "@/components/plugins/plugin-slot";
import { ConversationFeed, FEED_VIRTUALIZATION_THRESHOLD } from "@/home/ConversationFeed";
import { isArrival } from "@/home/conversation-arrivals";
import { RewindDialog } from "@/home/RewindDialog";
import { buildRows, toolRunOutcomes, type TranscriptRow, type TurnTail } from "@/home/conversation-rows";
import { messageSegments } from "@/state/composer-draft";
import { continueFromEntry } from "@/state/session-actions";
import { canRewindMessage, type TurnEnding } from "@/state/transcript";
import { COPY } from "@/home/homeCopy";

type UserMessage = Extract<ChatMessage, { kind: "user" }>;

/** What a message longer than this keeps of itself on screen until the reader asks for more. */
const COLLAPSED_LINES = 5;

/**
 * One user message the reader asked to take back, in the shape the surface that owns the composer
 * needs: what to address it by, and what to put back into the field.
 *
 * `entryId` is present when the transcript read named the entry; a row written by the live stream
 * has only the engine's own timestamp, which the host resolves to the same entry.
 */
export interface RewindTarget {
  entryId?: string
  at: number
  /** The message's own words, with the engine's injected notices left out. */
  text: string
  attachments: ChatAttachmentRef[]
}

const NO_JOBS: readonly BackgroundJob[] = [];

export interface ConversationPaneProps {
  /** The conversation these rows belong to; the pane is mounted per conversation. */
  sessionId: string;
  messages: ChatMessage[];
  subagents: Record<string, SubagentRow>;
  /**
   * The conversation's running background jobs.
   *
   * A detached `task` job's id is the child's own id, so this is the host's current answer to
   * "which subagents are still running" — the roster's frames can stop before the child's work
   * does, and a row that keeps saying `running` after the job is gone is the mismatch this fixes.
   */
  backgroundJobs?: readonly BackgroundJob[];
  /** The turn in flight, if any: it is what makes the last row read as streaming. */
  streaming: boolean;
  /**
   * The retry the engine is waiting out, when it is waiting on one.
   *
   * Read from the conversation's own runtime snapshot: the host publishes a state frame on every
   * retry edge (`session-view.ts::noteRetry`), so this is the same fact a screen that mounted
   * mid-retry reads — and the waiting line is where it belongs, rather than in a notice the reader
   * has to dismiss.
   */
  retry: SessionRetry | null;
  /**
   * The turn that ended in this process, when one did.
   *
   * Its outcome is what the transcript states, once, on the row the turn ended on. A conversation
   * read back from disk has none — its turns ended in an earlier process — and each answer then
   * states its own ending from the record it carries.
   */
  lastTurn: TurnEnding | null;
  /**
   * The host's own name for the entry the conversation ends on (`SessionRuntimeState.tipEntryId`).
   *
   * The rows of a turn that just ran here were built from live frames, which name no entry of their
   * own — this is what lets that turn offer a fork at all.
   */
  tipEntryId: string | null;
  /**
   * Whether the rows name their speaker.
   *
   * `true` for a conversation, where the reader has to see who is talking. `false` for a transcript
   * drawn without speakers — a subagent's own conversation in the right column, which has one voice
   * and a panel that already names it: the avatars and the "智能体 + 时刻" header are then not drawn
   * at all, and the content fills the column they stood in.
   */
  speakers?: boolean;
  /**
   * Whether a settled turn offers its fork.
   *
   * `false` for a transcript this side only reads: a subagent's run is the engine's own record, and
   * `session_branch_from` addresses a conversation, not a child.
   */
  fork?: boolean;
  /**
   * Whether a settled turn draws its footer — copy, fork, usage and the model.
   *
   * `false` for a subagent's transcript: its run is a step of the parent's turn, not a
   * conversation bill of its own, and its usage line would read as a second answer to the same
   * question. The running line still says the child is working (`runningLabel`).
   */
  showTail?: boolean;
  /** What the turn in flight says while it works; the subagent panel says `运行中`. */
  runningLabel?: string;
  /** Open one of this conversation's `task` children, where the caller can show it. */
  onOpenSubagent?: (childId: string, label: string) => void;
  /**
   * Take one of the reader's own messages back, addressed and with the draft it should restore.
   *
   * The rewrite belongs to the store (it is the engine's own write, in place: same file, same
   * row), and the draft belongs to the composer; what the pane owns is the confirmation and the row
   * the reader pointed at. `false` means the engine refused, and the surface that called is
   * the one that says why.
   */
  onRewind?: (target: RewindTarget) => Promise<boolean>;
  className?: string;
  viewportClassName?: string;
}

/**
 * The transcript: the rows on disk, the turn arriving, and what each row looks like.
 *
 * The pane is mounted once per conversation (`key`), and the rows it draws are the ones the feed
 * decides to draw — every one of them while the conversation is short, the ones around the reader
 * once it is long. Where the reader was, and whether the transcript is following, belongs to the
 * feed: it is the side that knows where a row actually is, and the side that has to put the reader
 * back on one after a window has been rebuilt.
 */
export function ConversationPane({
  sessionId,
  messages,
  subagents,
  backgroundJobs = NO_JOBS,
  streaming,
  retry,
  lastTurn,
  tipEntryId,
  speakers = true,
  fork = true,
  showTail = true,
  runningLabel,
  onOpenSubagent,
  onRewind,
  className,
  viewportClassName,
}: ConversationPaneProps) {
  // The turn in flight is the only row that can still grow, and it is what makes an otherwise empty
  // assistant row worth showing: it is the answer arriving.
  const streamingId = useMemo(() => {
    if (!streaming) return null;
    // Only an answer that came after the reader's own last prompt is still growing. The previous
    // turn's answer is finished, and marking it as the streaming one is what kept its thinking
    // animated while the next turn ran.
    let promptAt = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].kind === "user") {
        promptAt = index;
        break;
      }
    }
    for (let index = messages.length - 1; index > promptAt; index -= 1) {
      if (messages[index].kind === "assistant") return messages[index].id;
    }
    return null;
  }, [messages, streaming]);
  const rows = useMemo(
    () => buildRows(messages, { streaming, turn: lastTurn, tipEntryId }),
    [messages, streaming, lastTurn, tipEntryId],
  );
  const virtualized = rows.length > FEED_VIRTUALIZATION_THRESHOLD;

  /**
   * The rows this pane had drawn as of its last commit.
   *
   * A row that is already there when the pane mounts is not arriving: the reader switched to a
   * conversation whose rows are on disk, and running the entrance over all of them (a whole-tree
   * animation, on every switch) is work that shows nothing — the reader asked for the transcript,
   * not for it to be drawn again. What the pop-in belongs to is a row that appears *while* the pane
   * is up: the prompt echoing after it is sent, an answer starting.
   *
   * The set is rebuilt only when the row list's shape changed (a row added, removed, or the tail
   * replaced), so a streamed delta — one row growing on every frame — costs nothing here.
   */
  const drawnBefore = useRef<ReadonlySet<string> | null>(null);
  const drawnCount = useRef(-1);
  const drawnTail = useRef<string | null>(null);
  useLayoutEffect(() => {
    const tail = rows.at(-1)?.id ?? null;
    if (drawnCount.current === rows.length && drawnTail.current === tail) return;
    drawnCount.current = rows.length;
    drawnTail.current = tail;
    drawnBefore.current = new Set(rows.map((row) => row.id));
  }, [rows]);
  const arrived = useCallback((id: string) => isArrival(drawnBefore.current, id), []);

  /**
   * The disclosures the reader has opened or closed by hand, keyed by row id.
   *
   * It lives here rather than in the rows for two reasons. A windowed transcript unmounts the rows
   * that scroll out of it, so a choice kept in a row would be forgotten the moment it left the
   * screen; and a decision has to outrank the row's own live default in *both* directions — a row
   * the reader opened stays open after its work ends, and one they closed stays closed while output
   * is still arriving. A row they never touched is not in the map and follows the run.
   *
   * It is not in the store either: it belongs to the visit, so reopening a conversation from history
   * starts from the defaults again, exactly as the desktop app's own feed does.
   */
  const [disclosures, setDisclosures] = useState<ReadonlyMap<string, boolean>>(new Map());
  const rememberDisclosure = useCallback(
    (id: string, open: boolean) => {
      setDisclosures((current) => new Map(current).set(id, open));
    },
    [],
  );
  const choiceFor = useCallback(
    (id: string) => disclosures.get(id) ?? null,
    [disclosures],
  );

  /**
   * Carry this conversation on from one of its own outputs.
   *
   * The fork is the engine's own write, and the store owns it: what is left here is naming the
   * conversation the footer belongs to, so a footer drawn for one conversation can never fork
   * another. A surface with nothing to fork (`fork === false`, a subagent's transcript) hands the
   * footer no handler at all, and the footer draws no fork button.
   */
  const continueFrom = useCallback(
    async (entryId: string) => {
      await continueFromEntry(sessionId, entryId);
    },
    [sessionId],
  );
  const onContinue = fork ? continueFrom : undefined;

  /**
   * The message waiting for the reader's confirmation, and whether its rewrite is in flight.
   *
   * A running turn is not offered: the engine refuses a rewrite under it, and the button that could
   * not do anything is worse than no button.
   */
  const [rewindTarget, setRewindTarget] = useState<RewindTarget | null>(null);
  const [rewinding, setRewinding] = useState(false);
  const confirmRewind = useCallback(async () => {
    if (rewindTarget === null || onRewind === undefined) return;
    setRewinding(true);
    try {
      await onRewind(rewindTarget);
    } finally {
      setRewinding(false);
      setRewindTarget(null);
    }
  }, [onRewind, rewindTarget]);
  const rewindFrom = onRewind === undefined || streaming ? undefined : setRewindTarget;

  return (
    <>
      {/* One conversation's rows, with their own session id: a plugin slot on a message states the
          conversation that message belongs to (a subagent's pane is a conversation too). */}
      <PluginSlotSessionProvider sessionId={sessionId}>
        <ConversationFeed
          sessionId={sessionId}
          rows={rows}
          streaming={streaming}
          retry={retry}
          runningLabel={runningLabel}
          className={className}
          viewportClassName={viewportClassName}
          // The rows are keyed by the row they stand for, so a window that redraws a row it has drawn
          // before hands React the same element rather than a new one — and a row the reader scrolls
          // back to is the row they left, not a new one arriving.
          //
          // The pop-in belongs to a row that arrived while this pane was up: a conversation drawn
          // whole is drawn still (every row of it is a mount, and a switch must not animate a
          // transcript), and a windowed one draws no row animation at all — its rows mount for the
          // other reason too, the reader scrolling past them, and animating those would put a fade
          // where a row should already be, which is a blank stretch in the middle of a fling.
          renderRow={(row) => (
            <RowView
              key={row.id}
              row={row}
              subagents={subagents}
              backgroundJobs={backgroundJobs}
              streamingId={streamingId}
              animateIn={!virtualized && arrived(row.id)}
              speakers={speakers}
              showTail={showTail}
              chosen={choiceFor(row.id)}
              disclosures={disclosures}
              onDisclosureChange={rememberDisclosure}
              onContinue={onContinue}
              onRewind={rewindFrom}
              onOpenSubagent={onOpenSubagent}
            />
          )}
        />
      </PluginSlotSessionProvider>
      <RewindDialog
        open={rewindTarget !== null}
        busy={rewinding}
        onCancel={() => setRewindTarget(null)}
        onConfirm={() => void confirmRewind()}
      />
    </>
  );
}

/** One row, drawn as what it is. */
function RowView({
  row,
  subagents,
  backgroundJobs,
  streamingId,
  animateIn,
  speakers,
  showTail,
  chosen,
  disclosures,
  onDisclosureChange,
  onContinue,
  onRewind,
  onOpenSubagent,
}: {
  row: TranscriptRow
  subagents: Record<string, SubagentRow>
  backgroundJobs: readonly BackgroundJob[]
  streamingId: string | null
  animateIn: boolean
  speakers: boolean
  /** Whether this row may state the turn's footer (never in a subagent's transcript). */
  showTail: boolean
  /** The reader's own decision for this row's disclosure, or null while they have not made one. */
  chosen: boolean | null
  /** Every decision the reader has made in this conversation, for a row that holds several. */
  disclosures: ReadonlyMap<string, boolean>
  onDisclosureChange: (id: string, open: boolean) => void
  onContinue: ((entryId: string) => Promise<void>) | undefined
  /** Undefined while the conversation is running: a rewrite under a turn is refused. */
  onRewind: ((target: RewindTarget) => void) | undefined
  onOpenSubagent: ((childId: string, label: string) => void) | undefined
}) {
  if (row.kind === "reminders") {
    return (
      <ReminderRow
        rowId={row.id}
        reminders={row.reminders}
        chosen={chosen}
        onDisclosureChange={onDisclosureChange}
        className="mt-0.5"
      />
    );
  }
  if (row.kind === "tools") {
    return (
      <ToolCallGroup
        rowId={row.id}
        tools={row.tools}
        namesSender={row.namesSender}
        tail={showTail ? row.tail : null}
        subagents={subagents}
        backgroundJobs={backgroundJobs}
        animateIn={animateIn}
        speakers={speakers}
        chosen={chosen}
        disclosures={disclosures}
        onDisclosureChange={onDisclosureChange}
        onContinue={onContinue}
        onOpenSubagent={onOpenSubagent}
      />
    );
  }
  // The idle recap: one line where the conversation is, the same row the engine's own terminal draws.
  if (row.message.kind === "notice") {
    return <RecapRow message={row.message} className="mt-1" />;
  }
  if (row.message.kind === "user") {
    return (
      <>
        <UserRow
          message={row.message}
          animateIn={animateIn}
          speakers={speakers}
          onRewind={onRewind}
        />
        {row.ending === null ? null : <TurnEndingNote ending={row.ending} />}
      </>
    );
  }
  if (row.message.kind === "assistant") {
    return (
      <AssistantRow
        message={row.message}
        namesSender={row.namesSender}
        speakers={speakers}
        thinking={row.thinking}
        thinkingLive={row.thinkingLive}
        streaming={row.message.id === streamingId}
        ending={row.ending}
        stray={row.stray}
        tail={showTail ? row.tail : null}
        animateIn={animateIn}
        chosen={chosen}
        onDisclosureChange={onDisclosureChange}
        onContinue={onContinue}
      />
    );
  }
  // A single-tool row is the only shape left: a user or an answer returned above.
  if (row.message.kind !== "tool") return null;
  return (
    <SingleToolRow
      message={row.message}
      namesSender={row.namesSender}
      tail={showTail ? row.tail : null}
      subagents={subagents}
      backgroundJobs={backgroundJobs}
      animateIn={animateIn}
      speakers={speakers}
      chosen={chosen}
      onDisclosureChange={onDisclosureChange}
      onContinue={onContinue}
      onOpenSubagent={onOpenSubagent}
    />
  );
}

/**
 * The reader's own row.
 *
 * Memoized on its message: a turn streaming into the conversation replaces the transcript on every
 * frame, and every row the frame did not touch keeps its own object — so only the row that is
 * actually growing is redrawn.
 *
 * The copy under the bubble writes back exactly what the reader typed: the message's own words, with
 * the files' private placeholder characters left out — those code points are positions the chip list
 * already carries, and pasted anywhere else they travel as invisible junk. A message that is nothing
 * but files therefore copies as empty text, which is the truth of it: it has no words to write. The
 * files themselves are handed to the copy as well (`CopyButton`'s `files`), so the images and
 * documents a message carried are part of what a copy of that message means.
 */
const UserRow = memo(function UserRow({
  message,
  animateIn,
  speakers,
  onRewind,
}: {
  message: UserMessage
  animateIn: boolean
  speakers: boolean
  /** Take this message back out of the conversation; undefined while a turn is running. */
  onRewind: ((target: RewindTarget) => void) | undefined
}) {
  const copy = useCopy(COPY);
  const sessionId = usePluginSlotSessionId();
  // The engine wraps its own context into the user's own turn — a reminder, a delivery — and that
  // belongs above their words rather than inside the bubble they typed into. A model tag is the
  // opposite case: it *is* the reader's words with markup on them, so it stays in the bubble,
  // unbracketed (`stripModelTags`), and never becomes a card about the turn.
  const parts = useMemo(() => splitSystemNotices(message.text), [message.text]);
  const notices = parts.filter(
    (part): part is Extract<typeof part, { kind: "notice" }> =>
      part.kind === "notice" && !isModelTag(part.tag),
  );
  const prose = useMemo(() => messageProse(message.text), [message.text]);
  /**
   * The message as it was written: its words and the files it carried, in one flow.
   *
   * The files sit *inside* the bubble, where they stood in the sentence the reader wrote — the same
   * reading of one message the composer's own field draws, and the same reading a reopened
   * conversation gets, because the files come back out of the transcript's own text
   * (`state/composer-draft.ts::messageSegments`). A message that carried a file and nothing else is
   * a bubble holding that file: there is no reason to draw the words' box empty.
   */
  const segments = useMemo(
    () => messageSegments(prose, message.attachments),
    [prose, message.attachments],
  );
  const words = useMemo(() => segments.map((segment) => segment.text).join(""), [segments]);
  /** The files behind this message's chips, in the order it named them. */
  const files = useMemo(
    () => message.attachments.map((attachment) => attachment.path),
    [message.attachments],
  );
  /**
   * A pasted transcript, a stack trace or a whole diff is one bubble that can run for a screenful;
   * the row keeps `COLLAPSED_LINES` of it until the reader asks for the rest.
   *
   * The cut is measured, not guessed: five of the bubble's own line boxes, and only while the
   * content is actually taller than that — a short message never grows a control it does not need.
   * `scrollHeight` is the content's height in both states, so expanding does not lose the answer.
   */
  const [expanded, setExpanded] = useState(false);
  const [lineHeight, setLineHeight] = useState(0);
  const [longer, setLonger] = useState(false);
  const body = useRef<HTMLDivElement | null>(null);
  const bodyId = useId();

  useLayoutEffect(() => {
    const element = body.current;
    if (element === null) return;
    const measure = () => {
      const height = Number.parseFloat(window.getComputedStyle(element).lineHeight);
      if (!Number.isFinite(height) || height <= 0) return;
      setLineHeight(height);
      setLonger(element.scrollHeight > height * COLLAPSED_LINES + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [segments]);

  const clamped = longer && !expanded;

  return (
    <Message from="user" animateIn={animateIn}>
      <MessageContent>
        {speakers ? (
          <MessageHeader>
            <span>{copy.youLabel}</span>
            <span>{formatClock(message.at)}</span>
          </MessageHeader>
        ) : null}
        {notices.map((notice, index) => (
          <SystemNoticeCard key={index} notice={notice} className="w-full" />
        ))}
        {segments.length > 0 ? (
          <MessageBubble variant="solid">
            <MessageBubbleContent>
              <div
                ref={body}
                id={bodyId}
                className={cn(clamped && "overflow-hidden")}
                style={clamped ? { maxHeight: lineHeight * COLLAPSED_LINES } : undefined}
              >
                {segments.map((segment, index) =>
                  segment.attachment === null ? (
                    <span key={index} className="whitespace-pre-wrap break-words">
                      {segment.text}
                    </span>
                  ) : (
                    <AttachmentChip
                      key={`${index}-${segment.attachment.path}`}
                      attachment={segment.attachment}
                    />
                  ),
                )}
              </div>
            </MessageBubbleContent>
          </MessageBubble>
        ) : null}
        {/* The row's controls are the transcript's only right-aligned actions, and the message
            navigation rail is drawn over the scrollport's right edge
            (`components/agents/message-scroller.tsx`): on a column narrower than the conversation
            lane plus the rail, its tick buttons sit over these controls and took their clicks. The
            row is lifted above the rail (its own `z-10`) so a press on the rewind button is the
            rewind, not a jump to another turn (2026-11-02, user report). */}
        <div className="relative z-20 flex h-7 items-center gap-2">
          {longer ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => setExpanded((value) => !value)}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {expanded ? copy.collapseMessage : copy.expandMessage}
              <ChevronDown
                aria-hidden="true"
                className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
              />
            </button>
          ) : null}
          <CopyButton text={words} files={files} />
          {/* The reader's own message is the one thing in the transcript they can take back: the
              engine rewrites the conversation to end before it and the text returns to the field.
              Only a row the engine wrote has an address to cut at (`canRewindMessage`). */}
          {onRewind === undefined || !canRewindMessage(message) ? null : (
            <Tooltip content={copy.rewindMessage}>
              <button
                type="button"
                aria-label={copy.rewindMessage}
                onClick={() =>
                  onRewind({
                    entryId: message.entryId,
                    at: message.at,
                    text: prose,
                    attachments: message.attachments,
                  })
                }
                className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Undo2 aria-hidden="true" className="size-3.5" />
              </button>
            </Tooltip>
          )}
          {/* A plugin's items on this message's own action row, after this app's copy and rewind. */}
          <PluginSlot
            slot="message.actions.user"
            props={{
              message: { id: message.id, role: "user", content: words },
              messageId: message.id,
              sessionId,
              position: "right",
            }}
          />
        </div>
      </MessageContent>
    </Message>
  );
});

/** A `task` call, or a call that stands on its own: one row, its own body. */
const SingleToolRow = memo(function SingleToolRow({
  message,
  namesSender,
  tail,
  subagents,
  backgroundJobs,
  animateIn,
  speakers,
  chosen,
  onDisclosureChange,
  onContinue,
  onOpenSubagent,
}: {
  message: ToolMessage
  /** Whether this row is where the turn names its speaker (see `buildRows`). */
  namesSender: boolean
  /** What the turn cost, when this call is the last row the turn drew. */
  tail: TurnTail | null
  subagents: Record<string, SubagentRow>
  backgroundJobs: readonly BackgroundJob[]
  animateIn: boolean
  speakers: boolean
  chosen: boolean | null
  onDisclosureChange: (id: string, open: boolean) => void
  onContinue: ((entryId: string) => Promise<void>) | undefined
  onOpenSubagent: ((childId: string, label: string) => void) | undefined
}) {
  const copy = useCopy(COPY);
  const named = namesSender && speakers;
  return (
    <Message from="assistant" animateIn={animateIn}>
      <MessageContent className="gap-3">
        {/* The speaker line belongs to the turn, and a turn whose first drawn row is a call names
            it here — the same avatar, wording and clock an answer's row uses. A call's `at` is the
            host's start stamp for the step, which is the same moment the engine wrote the step. */}
        {named ? (
          <MessageHeader>
            <span>{copy.agentLabel}</span>
            <span>{formatClock(message.at)}</span>
          </MessageHeader>
        ) : null}
        <ConversationToolRow
          message={message}
          subagents={subagents}
          backgroundJobs={backgroundJobs}
          chosen={chosen}
          onDisclosureChange={(open) => onDisclosureChange(message.id, open)}
          onOpenSubagent={onOpenSubagent}
        />
        {tail === null ? null : (
          <ConversationTurnTail tail={tail} onContinue={onContinue} messageId={message.id} />
        )}
      </MessageContent>
    </Message>
  );
});

/**
 * A run of consecutive tool calls, folded to one line until it is opened.
 *
 * The line opens itself while any call in the run is still working — that is where their output is
 * — and folds once the run settles. A reader who opened or closed it by hand keeps their choice.
 */
const ToolCallGroup = memo(
  function ToolCallGroup({
    rowId,
    tools,
    namesSender,
    tail,
    subagents,
    backgroundJobs,
    animateIn,
    speakers,
    chosen,
    disclosures,
    onDisclosureChange,
    onContinue,
    onOpenSubagent,
  }: {
    rowId: string
    tools: ToolMessage[]
    /** Whether this run is where the turn names its speaker (see `buildRows`). */
    namesSender: boolean
    /** What the turn cost, when this run is the last row the turn drew. */
    tail: TurnTail | null
    subagents: Record<string, SubagentRow>
    backgroundJobs: readonly BackgroundJob[]
    animateIn: boolean
    speakers: boolean
    chosen: boolean | null
    disclosures: ReadonlyMap<string, boolean>
    onDisclosureChange: (id: string, open: boolean) => void
    onContinue: ((entryId: string) => Promise<void>) | undefined
    onOpenSubagent: ((childId: string, label: string) => void) | undefined
  }) {
    const copy = useCopy(COPY);
    const { succeeded, failed } = toolRunOutcomes(tools);
    const running = tools.some((tool) => tool.state === "running");
    // A run of calls never opens itself, even while its calls run: the row's own line already says
    // how many and what the latest one was doing, and a group that opened on the first call and
    // folded when the last answered was a flash of output the reader had no time to read
    // (2026-10-24, same rule as a single call — see `ConversationToolRow`). `chosen` is the
    // reader's, in both directions.
    const open = chosen ?? false;
    const named = namesSender && speakers;
    // What the run last did, beside its count: a folded group that only says "8 calls" is a blank
    // card in a subagent's transcript, while the reference client's tool rows keep a one-line summary visible when
    // collapsed. The intent is the engine's own sentence; a call without one falls back to the
    // argument summary the single row would title itself with.
    const latest = tools.at(-1);
    const latestTitle =
      latest === undefined
        ? ""
        : (latest.intent ?? (summarizeToolArgs(latest.argsText) || latest.name));

    return (
      <Message from="assistant" animateIn={animateIn}>
        <MessageContent className="gap-2">
          {/* A turn whose first drawn row is a run of calls names its speaker here, the way the
              answer's row does: the reader's own prompt is above, and the agent is who is working. */}
          {named ? (
            <MessageHeader>
              <span>{copy.agentLabel}</span>
              <span>{formatClock(tools[0]?.at ?? 0)}</span>
            </MessageHeader>
          ) : null}
          {/* The pill and the calls it holds are one column with no gap of its own: the 8px that
              separates the pill from its body belongs inside the fold, so a folded run costs
              nothing under its pill. A gap here reserved that space even when the body was gone —
              which is what made a thought sit nearer the call under it than the call above it
              (2026-11-02, user report: 思考与调用的间隔为什么不都是一样的 有的思考离上一个调用远). */}
          <div className="flex w-full min-w-0 flex-col">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => onDisclosureChange(rowId, !open)}
              className="flex h-8 w-fit min-w-0 items-center gap-2 rounded-lg border border-border px-2.5 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              {open ? (
                <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              {running ? (
                <TextShimmer as="span" className="font-medium">
                  {copy.toolCalls(tools.length)}
                </TextShimmer>
              ) : (
                <span className="font-medium">{copy.toolCalls(tools.length)}</span>
              )}
              {failed > 0 ? (
                <span className="flex items-center gap-2">
                  {succeeded > 0 ? (
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {copy.toolSucceeded(succeeded)}
                    </span>
                  ) : null}
                  <span className="text-destructive">{copy.toolFailedCount(failed)}</span>
                </span>
              ) : null}
              {latestTitle === "" ? null : (
                <span className="min-w-0 max-w-[44ch] truncate font-normal text-muted-foreground">
                  {latestTitle}
                </span>
              )}
            </button>
            {/* `w-full` is what the rows inside this disclosure are sized against: it is a flex
                item of `MessageContent`, whose `items-start` makes a child's cross size
                fit-content, so without it the run shrank to the width of its own header and every
                call in it — whose own root is `w-full` — came out narrower than the same call
                standing on its own. */}
            <AgentDisclosure open={open} className="w-full min-w-0">
              {/* The body's 8px above its first call lives inside the fold: clipped away with the
                  body while the run is folded, and there when it is open. */}
              <div className="flex w-full min-w-0 flex-col gap-2 pt-2">
                {tools.map((tool) => (
                  // A call inside an opened run carries its own body and its own decision, read
                  // from the same map the row outside a run reads: a call the reader opened stays
                  // open, and one they left alone folds when its work ends.
                  <ConversationToolRow
                    key={tool.id}
                    message={tool}
                    subagents={subagents}
                    backgroundJobs={backgroundJobs}
                    chosen={disclosures.get(tool.id) ?? null}
                    onDisclosureChange={(openInner) => onDisclosureChange(tool.id, openInner)}
                    onOpenSubagent={onOpenSubagent}
                  />
                ))}
              </div>
            </AgentDisclosure>
          </div>
          {tail === null ? null : (
            <ConversationTurnTail
              tail={tail}
              onContinue={onContinue}
              messageId={latest?.id ?? tools[0]?.id}
            />
          )}
        </MessageContent>
      </Message>
    );
  },
  // The group's array is rebuilt whenever the transcript changes, so the default comparison would
  // never hold; what matters is whether the calls in it are the same rows, whether the roster they
  // read is the same object, and whether the reader has decided anything about the line.
  (previous, next) =>
    previous.subagents === next.subagents &&
    previous.backgroundJobs === next.backgroundJobs &&
    previous.namesSender === next.namesSender &&
    previous.speakers === next.speakers &&
    previous.tail === next.tail &&
    previous.chosen === next.chosen &&
    previous.disclosures === next.disclosures &&
    previous.onContinue === next.onContinue &&
    previous.onOpenSubagent === next.onOpenSubagent &&
    previous.tools.length === next.tools.length &&
    previous.tools.every((tool, index) => tool === next.tools[index]),
);

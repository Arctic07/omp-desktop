import { ChevronDown, Sparkles } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { memo, useMemo } from "react";

import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { ThinkingShimmer } from "@/components/agents/loading-states/thinking-shimmer";
import { Markdown } from "@/components/agents/markdown";
import { Message, MessageContent, MessageHeader } from "@/components/agents/message";
import { MessageBubble, MessageBubbleContent } from "@/components/agents/message-bubble";
import { StreamingResponse } from "@/components/agents/streaming-response";
import { JobDeliveryCard, SystemNoticeCard } from "@/components/agents/system-notice";
import { useSmoothText } from "@/components/agents/use-smooth-text";
import { PluginSlot, usePluginSlotSessionId } from "@/components/plugins/plugin-slot";
import type { ChatMessage } from "@/api/session-types";
import { ConversationImages } from "@/home/ConversationImages";
import { ConversationTurnTail } from "@/home/ConversationTurnTail";
import { StrayCallCards } from "@/home/StrayCallCards";
import { TurnEndingNote } from "@/home/TurnEndingNote";
import { formatClock } from "@/home/conversation-format";
import type { RowEnding, TurnTail } from "@/home/conversation-rows";
import { COPY } from "@/home/homeCopy";
import { parseJobDelivery, splitSystemNotices, stripModelTags } from "@/home/system-notice";
import type { StrayToolCall } from "@/home/tool-call-markup";
import { SPRING_SWAP } from "@/lib/ease";
import { useCopy } from "@/lib/i18n";

type AssistantMessage = Extract<ChatMessage, { kind: "assistant" }>;

export interface AssistantRowProps {
  message: AssistantMessage
  /** Whether this row is where the turn names its speaker (see `buildRows`). */
  namesSender: boolean
  /**
   * Whether the rows name their speaker at all.
   *
   * `false` for a transcript drawn without speakers — a subagent's own conversation in the right
   * column, where there is one voice, the panel already names it, and an avatar and a "智能体 + 时刻"
   * line would be the same fact three times. The rows then draw neither, and the content fills the
   * column the avatar stood in.
   */
  speakers: boolean
  /** The stretch of reasoning this step thought, drawn above its own words. */
  thinking: string
  thinkingLive: boolean
  streaming: boolean
  /** How the turn ended, when this row is the one that states it. */
  ending: RowEnding | null
  /** The tool call this step wrote as markup instead of an answer, when it wrote one. */
  stray: StrayToolCall | null
  /** What the turn cost, when this row is the one that carries its footer. */
  tail: TurnTail | null
  animateIn: boolean
  chosen: boolean | null
  onDisclosureChange: (id: string, open: boolean) => void
  /** Absent where the surface has no conversation to fork (a subagent's transcript). */
  onContinue?: (entryId: string) => Promise<void>
}

/**
 * One answer of the conversation, as the agent wrote it.
 *
 * Memoized on its message, like the reader's own row: a turn streaming into the conversation replaces
 * the transcript on every frame, and every row the frame did not touch keeps its own object — so only
 * the row that is actually growing is redrawn.
 */
export const AssistantRow = memo(function AssistantRow({
  message,
  namesSender,
  speakers,
  thinking,
  thinkingLive,
  streaming,
  ending,
  stray,
  tail,
  animateIn,
  chosen,
  onDisclosureChange,
  onContinue,
}: AssistantRowProps) {
  const copy = useCopy(COPY);
  // The avatar and the name belong to the turn, not to each of the messages it was written in: an
  // answer that follows a tool call is the same agent still talking, and naming it again puts two
  // avatars over one turn's output. The placeholder keeps the column, the way a tool row does — and
  // a surface with no speakers keeps nothing at all, because there is no column to keep.
  const named = namesSender && speakers;
  return (
    <Message from="assistant" animateIn={animateIn}>
      <MessageContent className="gap-3">
        {named ? (
          <MessageHeader>
            <span>{copy.agentLabel}</span>
            <span>{formatClock(message.at)}</span>
          </MessageHeader>
        ) : null}
        <AssistantBodyOf
          message={message}
          thinking={thinking}
          thinkingLive={thinkingLive}
          streaming={streaming}
          ending={ending}
          stray={stray}
          tail={tail}
          chosen={chosen}
          onDisclosureChange={onDisclosureChange}
          onContinue={onContinue}
        />
      </MessageContent>
    </Message>
  );
});

/** Everything an answer draws under its sender line: the reasoning, the text, and its outcome. */
function AssistantBodyOf({
  message,
  thinking,
  thinkingLive,
  streaming,
  ending,
  stray,
  tail,
  chosen,
  onDisclosureChange,
  onContinue,
}: {
  message: AssistantMessage
  thinking: string
  thinkingLive: boolean
  streaming: boolean
  ending: RowEnding | null
  stray: StrayToolCall | null
  tail: TurnTail | null
  chosen: boolean | null
  onDisclosureChange: (id: string, open: boolean) => void
  onContinue?: (entryId: string) => Promise<void>
}) {
  const copy = useCopy(COPY);
  const sessionId = usePluginSlotSessionId();
  return (
    <>
      {thinking ? (
        <ThinkingRow
          // The row's own id, so the reader's decision about it outlives the windowed rows.
          rowId={message.id}
          thinking={thinking}
          // The reasoning is the live output until the answer itself starts arriving: the engine
          // thinks first, and a collapsed block over that stretch is a turn that looks like nothing
          // is happening.
          live={thinkingLive}
          chosen={chosen}
          onDisclosureChange={onDisclosureChange}
        />
      ) : null}
      {/* The call a step wrote as markup instead of answering: the engine ran none of it, and the
          card states the call it aimed at rather than drawing its brackets as prose. */}
      {stray === null ? null : <StrayCallCards calls={stray.calls} />}
      {/* No words, no bubble. An empty answer's bubble is invisible, but it is still a flex child
          of the content column, so it costs that column's gap under the reasoning — the wider gap
          the reader sees between a step's last thought and the call it goes on to make, which
          disappears once the answer itself starts arriving and there is text to draw. */}
      {message.text.trim() ? (
        <MessageBubble variant="ghost" className="w-full">
          <MessageBubbleContent>
            {/* The response's own action row is off: what a turn offers — its copy, its fork and what
                it cost — is the footer under the row the turn ended on, and a second copy button
                inside the bubble would be the same action twice. */}
            <StreamingResponse
              // The bubble's own state is the answer's: a step the engine retried away is drawn as
              // it was written, and the turn's ending is stated once, below.
              status={streaming ? "streaming" : "complete"}
              showActions={false}
              // A plugin's block below this reply (`message.extra`). Nothing registered draws
              // nothing: the slot renders null and the response's box is unchanged.
              extra={
                <PluginSlot
                  slot="message.extra"
                  props={{
                    // The slot's content is the answer as the bubble reads it, the same reading the
                    // user slot hands over: the model's own wrappers are markup, not words.
                    message: { id: message.id, role: "assistant", content: stripModelTags(message.text) },
                    messageId: message.id,
                    sessionId,
                  }}
                />
              }
            >
              <AssistantBody text={message.text} streaming={streaming} />
            </StreamingResponse>
          </MessageBubbleContent>
        </MessageBubble>
      ) : null}
      {ending === null ? null : <TurnEndingNote ending={ending} />}
      {/* The step's pictures are output, not detail: they are drawn at their own size, always, and
          a click opens one at the size of the window (`ConversationImages`). */}
      {message.images?.length ? (
        <ConversationImages images={message.images} label={copy.toolImages} />
      ) : null}
      {tail === null ? null : (
        <ConversationTurnTail tail={tail} onContinue={onContinue} messageId={message.id} />
      )}
    </>
  );
}

/**
 * The answer's own text.
 *
 * Two readings of one string. The engine writes its own blocks — a finished background job's
 * delivery, a reminder — straight into a message body as tagged text, and those read as what they
 * are rather than as angle brackets; everything else is the answer, and reads as Markdown. A message
 * that carries no block at all takes the plain path, so the common case costs one split and no
 * wrapper element.
 */
const AssistantBody = memo(function AssistantBody({
  text,
  streaming,
}: {
  text: string
  streaming: boolean
}) {
  // A delivery that arrived with no wrapper at all — a backgrounded shell, whose whole body is the
  // result — is still a delivery, and is read before the wrappers are looked for.
  const delivery = useMemo(() => parseJobDelivery(text), [text]);
  const parts = useMemo(() => (delivery === null ? splitSystemNotices(text) : []), [delivery, text]);
  // The common path — one plain answer — is the one the reader watches being written, so it is the
  // one that is revealed by the frame. Tagged blocks are already whole lines by the time they parse.
  const displayed = useSmoothText(text, streaming);
  if (delivery !== null) {
    return <JobDeliveryCard delivery={delivery} />;
  }
  const plain = parts.length === 1 && parts[0].kind === "text";
  if (plain) {
    // A block still being written has no closer yet (`splitSystemNotices` reads only closed
    // blocks), so its tag line would be drawn as text for the stretch the answer takes to arrive.
    // The line goes; its words read as prose until the block closes and becomes a card.
    return <Markdown text={stripModelTags(displayed)} streaming={streaming} />;
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {parts.map((part, index) =>
        part.kind === "text" ? (
          <Markdown
            key={index}
            text={stripModelTags(part.text)}
            streaming={streaming}
          />
        ) : (
          <SystemNoticeCard key={index} notice={part} />
        ),
      )}
    </div>
  );
});

/**
 * The agent's reasoning, folded above its reply: a shimmering label that opens onto the text.
 *
 * It opens itself while the reasoning is still arriving and folds when the answer itself starts —
 * that stretch is where the reasoning *is* the output, and a collapsed block over it is a turn that
 * looks like nothing is happening. A reader who opened or closed it by hand keeps their choice.
 *
 * The fold must not move the running line under it: in a transcript that still fits its scrollport
 * it did, once per step, and the reader watched the foot of the conversation bounce (2026-10-24).
 * That is a property of the feed, not of this block — `ConversationFeed` anchors a transcript
 * shorter than its scrollport to the bottom, so the foot stays where it is while the content above
 * it grows and folds.
 */
function ThinkingRow({
  rowId,
  thinking,
  live,
  chosen,
  onDisclosureChange,
}: {
  rowId: string
  thinking: string
  live: boolean
  chosen: boolean | null
  onDisclosureChange: (id: string, open: boolean) => void
}) {
  const copy = useCopy(COPY);
  const reduce = useReducedMotion() ?? false;
  const open = chosen ?? live;
  // The reasoning is written the same way the answer is, so it is revealed the same way: a model
  // that thinks in sentence-sized chunks would otherwise put a whole paragraph on screen at once
  // while the reader is watching the turn, which is the one stretch where a collapsed block would
  // read as nothing happening.
  const shownThinking = useSmoothText(thinking, live);
  return (
    <div className="flex min-w-0 flex-col">
      {/* The tool row's glyph is a 16px box at the column's left edge with an 8px gap to its
          title (`tool-result.tsx`), so reasoning starts on the same x as a call instead of one
          padding step to the right of it (2026-10-20). */}
      <button
        type="button"
        aria-expanded={open}
        aria-label={copy.thinkingToggle}
        onClick={() => onDisclosureChange(rowId, !open)}
        className="flex h-7 w-fit min-w-0 items-center gap-2 rounded-lg pr-1.5 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Sparkles aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        {/* The shimmer belongs to reasoning still arriving: a row whose turn is over is a record of
            what was thought, and animating it would claim something is still being thought. */}
        {live ? (
          <ThinkingShimmer className="text-xs">{copy.thinkingLabel}</ThinkingShimmer>
        ) : (
          <span className="font-medium">{copy.thinkingLabel}</span>
        )}
        {/* The arrow turns rather than being swapped for another glyph: the fold it announces
            starts in the same commit, and a hard flip beside a box that is still moving is the
            part of the moment that reads as a stutter (the keyed swap is one frame, the fold is
            half a second). Same spring as the activity groups' own arrow. */}
        <motion.span
          aria-hidden="true"
          animate={{ rotate: open ? 0 : -90 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="inline-flex shrink-0 text-muted-foreground"
        >
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>
      <AgentDisclosure open={open}>
        {/* `wrap-anywhere`, not `break-words`: this paragraph is a `fit-content` item in the
            transcript's content column (`items-start`), and its width is floored by its own
            *min-content* — which `break-words` leaves at the longest unbreakable run, so one
            reasoning token written as a long comma list (`'html','head','body',…`) laid the whole
            block out at ~4800px inside a 768px lane and every line of it read unwrapped, clipped
            by the scrollport (2026-11-04 reader report: 思考单行超出宽度了). `anywhere` is the
            value that lowers that floor, so the block stays in the lane and the token breaks. */}
        <p className="mt-1 whitespace-pre-wrap wrap-anywhere border-border border-l pl-3 text-xs text-muted-foreground">
          {shownThinking}
        </p>
      </AgentDisclosure>
    </div>
  );
}

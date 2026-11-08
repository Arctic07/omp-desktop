"use client";

import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Card } from "@/components/motion/card";
import { Markdown } from "@/components/agents/markdown";
import type { ParsedIrcMessage } from "@/home/irc-message";
import { useCopy, type Localized } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A peer agent's message, drawn as the card it is rather than as the engine's envelope.
 *
 * The engine delivers an inter-agent message as message text wrapped in `<irc>` — who wrote it, what
 * they said, and three sentences of instruction to the model about how to answer
 * (`prompts/system/irc-incoming.md`). `home/irc-message.ts` reads those facts back out; this file
 * decides only what to draw.
 *
 * What is *not* drawn is the reply instruction. It is addressed to the model, not to the reader:
 * "reply via `write` (`path: "agent://…"`)" is a tool call the reader cannot make, and the engine's
 * own terminal card leaves it out for the same reason. What the reader is shown is the message, who
 * sent it, whether it answered another one, and — the one fact that changes how the row above reads
 * — whether it cut into a turn that was still working.
 *
 * Everything is built from the app's own BeUI surface: `Card` frames it, `AnimatedBadge` carries the
 * chips, and the body is the transcript's Markdown at the size the notice cards use. No colour is
 * written here: every surface is a token from `index.css`, so light and dark both hold.
 */
interface IrcMessageCopy {
  /** The chip naming what this block is, in the reader's language. */
  label: string
  /** The chip saying this message arrived while the turn was working. */
  interrupting: string
  /** The label a message being answered is named under. */
  replyTo: string
  /** The accessible name of the card. */
  cardLabel: (from: string) => string
}

const COPY: Localized<IrcMessageCopy> = {
  en: {
    label: "Agent message",
    interrupting: "Interrupted the turn",
    replyTo: "reply to",
    cardLabel: (from) => `Message from ${from === "" ? "another agent" : from}`,
  },
  zh: {
    label: "代理消息",
    interrupting: "打断了本轮",
    replyTo: "回复",
    cardLabel: (from) => `来自 ${from === "" ? "其他代理" : from} 的消息`,
  },
};

export interface IrcMessageCardProps {
  /** One `<irc>` block, already read apart by `parseIrcMessage`. */
  message: ParsedIrcMessage;
  className?: string;
}

export function IrcMessageCard({ message, className }: IrcMessageCardProps) {
  const copy = useCopy(COPY);

  return (
    <Card
      size="compact"
      aria-label={copy.cardLabel(message.from)}
      className={cn("gap-2 rounded-xl px-3 py-2.5", className)}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <AnimatedBadge
          size="sm"
          // A label, not a status that changes under the reader's eyes: nothing here swaps.
          animated={false}
          status="info"
        >
          {copy.label}
        </AnimatedBadge>
        {message.from === "" ? null : (
          <span className="font-semibold break-all text-foreground">{message.from}</span>
        )}
        {message.replyTo === null ? null : (
          <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            <span className="shrink-0">{copy.replyTo}</span>
            <span className="min-w-0 truncate">{message.replyTo}</span>
          </span>
        )}
        {/* Why the turn above this row stopped mid-step: the engine reads an interrupting message
            as soon as it lands, and the reader is owed that reason on the row that caused it. */}
        {message.interrupting ? (
          <AnimatedBadge size="sm" animated={false} status="warning" className="ml-auto">
            {copy.interrupting}
          </AnimatedBadge>
        ) : null}
      </header>
      {/* A block that carries no words draws as its header alone: an empty paragraph is a gap the
          reader has no text to account for. */}
      {message.body === "" ? null : (
        <Markdown
          text={message.body}
          className="text-[13px] leading-relaxed text-foreground/80"
        />
      )}
    </Card>
  );
}

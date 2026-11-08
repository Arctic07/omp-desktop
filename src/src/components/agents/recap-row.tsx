"use client";

import { Sparkles } from "lucide-react";

import type { NoticeMessage } from "@/home/conversation-rows";
import { oneLinePreview } from "@/home/conversation-format";
import { useCopy, type Localized } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The engine's idle recap, drawn where the conversation is.
 *
 * The engine writes this when it has summarized a stretch of quiet: where things stand, what is next.
 * Its own terminal draws it as one line in the transcript, and so does this row — the summary is a
 * sentence about the conversation, not a card about the machinery, which is why it is here rather
 * than in the notice strip above the composer (`state/transcript.ts` routes by the frame's code).
 *
 * One line, cut at the engine's own recap width: the whole text is journaled by the engine into its
 * history database, and a paragraph in the middle of a transcript pushes the work it describes off
 * the screen it is describing.
 */

interface RecapCopy {
  /** What the row is called. */
  label: string
}

const COPY: Localized<RecapCopy> = {
  en: { label: "Idle recap" },
  zh: { label: "空闲回顾" },
};

export interface RecapRowProps {
  message: NoticeMessage;
  className?: string;
}

export function RecapRow({ message, className }: RecapRowProps) {
  const copy = useCopy(COPY);
  const line = oneLinePreview(message.text);
  if (line === "") return null;

  return (
    <div
      data-notice="engine_recap"
      className={cn(
        "flex h-7 min-w-0 items-center gap-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <Sparkles aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/70" />
      <span className="shrink-0 font-medium">{copy.label}</span>
      <span className="min-w-0 truncate text-muted-foreground/80">{line}</span>
    </div>
  );
}

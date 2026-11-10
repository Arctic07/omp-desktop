"use client";

import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import { Markdown } from "@/components/agents/markdown";
import {
  ENGINE_COMPACTION_REPORT_CODE,
  ENGINE_RECAP_CODE,
  type TranscriptNoticeCode,
} from "@/api/session-types";
import type { NoticeMessage } from "@/home/conversation-rows";
import { oneLinePreview } from "@/home/conversation-format";
import { useCopy, type Localized } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The engine's own notices, drawn where the conversation is.
 *
 * Two codes belong here rather than in the strip above the field, and the code is the whole routing
 * rule (`state/transcript.ts`): the idle recap, and the report a compaction prints when its pass
 * finishes. A compaction an endpoint performs on its own keeps its notice instead
 * (`host/src/upstream-compaction.ts` emits one, on the engine's notice channel).
 *
 * The two read differently on purpose. A recap is a labelled one-line chip because "Idle recap"
 * names a fact its sentence does not, and because the engine journals the whole sentence into its
 * history database: a paragraph in the middle of a transcript pushes the work it describes off the
 * screen it is describing. A compaction report is the agent's closing line on work the reader asked
 * for — `Compaction complete. Tokens: …` or `Compaction failed: …` — and on screen it is the only
 * copy, so it is drawn whole, as prose, in the same typography an answer uses.
 */

interface NoticeCopy {
  /** What the recap row is called. */
  recapLabel: string;
}

const COPY: Localized<NoticeCopy> = {
  en: { recapLabel: "Idle recap" },
  zh: { recapLabel: "空闲回顾" },
};

export interface NoticeRowProps {
  message: NoticeMessage;
  className?: string;
}

/** One renderer per routed code; the record keeps this component in step with the union. */
const RENDERERS: Readonly<
  Record<TranscriptNoticeCode, (message: NoticeMessage, className?: string) => ReactNode>
> = {
  [ENGINE_COMPACTION_REPORT_CODE]: (message, className) =>
    message.text.trim() === "" ? null : (
      // `Markdown` draws its blocks with the answer's own vocabulary, so this reads as the agent's
      // words rather than as a card: no icon, no label, no dismissal. The pane gives it the speaker
      // line (`智能体 + 时刻`) the same way an answer's row gets one.
      <div data-notice={message.code} className={cn("w-full", className)}>
        <Markdown text={message.text} />
      </div>
    ),
  [ENGINE_RECAP_CODE]: (message, className) => (
    <RecapLine message={message} className={className} />
  ),
};

export function NoticeRow({ message, className }: NoticeRowProps) {
  return RENDERERS[message.code](message, className);
}

/**
 * The recap's one labelled line, cut at the engine's own recap width.
 *
 * Its own component because the label is copy and `useCopy` is a hook: called inside the renderers'
 * closures it would run conditionally.
 */
function RecapLine({ message, className }: NoticeRowProps) {
  const copy = useCopy(COPY);
  const line = oneLinePreview(message.text);
  if (line === "") return null;

  return (
    <div
      data-notice={message.code}
      className={cn(
        "flex h-7 min-w-0 items-center gap-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <Sparkles aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/70" />
      <span className="shrink-0 font-medium">{copy.recapLabel}</span>
      <span className="min-w-0 truncate text-muted-foreground/80">{line}</span>
    </div>
  );
}

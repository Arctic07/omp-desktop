import { AlertCircle, CircleSlash } from "lucide-react";

import type { RowEnding } from "@/home/conversation-rows";
import { COPY } from "@/home/homeCopy";
import { Alert, AlertContent, AlertDescription, AlertIcon } from "@/components/motion/alert";
import { useCopy } from "@/lib/i18n";

/**
 * Why a step ended without answering, as the row it ended on states it.
 *
 * Three outcomes are worth a line, and only three: a turn the reader stopped, one that failed, and a
 * step whose words were a tool call nothing executed. Every other reason the engine records —
 * `toolUse` on the step that called a tool, `stop` on the answer that finished the turn — is its own
 * bookkeeping, and a line under each of them turns a conversation into a log.
 *
 * A stop is the reader's own act, so it reads as a quiet note rather than as a failure. A failure
 * keeps the engine's reason, because it exists nowhere else — and it is an `Alert`, the same surface
 * the composer reports its failures with, so the two read as one kind of thing.
 */
export function TurnEndingNote({ ending }: { ending: RowEnding }) {
  const copy = useCopy(COPY);
  if (ending.outcome === "miscall") {
    return (
      <Alert variant="warning" className="items-start gap-2 py-1.5 pr-2 pl-2.5 text-xs">
        <AlertIcon>
          <AlertCircle aria-hidden="true" className="size-3.5" />
        </AlertIcon>
        <AlertContent>
          <AlertDescription className="text-xs">{copy.turnMiscall}</AlertDescription>
        </AlertContent>
      </Alert>
    );
  }
  if (ending.outcome === "aborted") {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <CircleSlash aria-hidden="true" className="size-3 shrink-0" />
        {copy.turnStopped}
      </p>
    );
  }
  return (
    <Alert variant="destructive" className="items-start gap-2 py-1.5 pr-2 pl-2.5 text-xs">
      <AlertIcon>
        <AlertCircle aria-hidden="true" className="size-3.5" />
      </AlertIcon>
      <AlertContent>
        <AlertDescription className="text-xs">{ending.error ?? copy.turnFailed}</AlertDescription>
      </AlertContent>
    </Alert>
  );
}

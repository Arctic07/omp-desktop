import { useMemo } from "react";

import { AgentProgress } from "@/components/agents/loading-states/agent-progress";
import { Message, MessageContent } from "@/components/agents/message";
import type { SessionRetry } from "@/api/session-types";
import { useCopy } from "@/lib/i18n";
import { COPY } from "@/home/homeCopy";
import { turnElapsedSeconds } from "@/home/turn-elapsed";

/**
 * The wait at the foot of the transcript: a turn in flight, or a context rewrite.
 *
 * One row covers both. A turn is in flight from the moment the prompt is sent, before the engine has
 * said anything, and stays on screen while it works — the running component is the answer to "is it
 * doing anything?". No avatar: the rows draw none, and the running line starts where the answers do.
 *
 * A context rewrite the engine performs between turns (`/compact`, a handoff, an automatic
 * compaction) draws this row with the compacting verb and without the turn's retry: the retry
 * belongs to a turn, and there is none. Beside a live turn the flag adds nothing, because that
 * turn's row already says what the wait is (`home/ConversationFeed.tsx` decides which it is).
 *
 * A turn the engine is retrying says so here, in place of the plain verb: the retry is a wait the
 * reader would otherwise read as "working" for as long as the backoff lasts, and it is the line that
 * tells them the request failed and is being tried again — with the attempt it is on. The engine's
 * own words for the failure are the row's title, so the reason is one hover away without a second
 * line on screen.
 *
 * The clock beside the verb counts the *turn*, not the visit: it is handed over as the counter's own
 * zero point (`startedAt`, read from the host's stamp for this turn), so leaving the conversation and
 * coming back — which draws this row again from nothing — shows the same reading rather than a fresh
 * stopwatch. It is read once per turn, because a value that moved on every frame would restart the
 * counter and freeze the reading at the age of the frame it was read on. A wait nothing stamped (the
 * compaction's, which runs between turns) is counted from the moment this row was drawn, which is
 * what the row has always done.
 */
export interface ConversationFootRowProps {
  /** A turn is in flight: its clock and its retry belong to it. */
  streaming: boolean
  /** The engine is rewriting the context with no turn over it. */
  compacting: boolean
  /** The retry the engine is waiting out, when it is waiting on one. */
  retry: SessionRetry | null
  /** The turn's own zero point for the clock, from the host's stamp. */
  startedAt: number | null
  /** The verb for this surface, when the caller has its own. */
  runningLabel?: string
}

export function ConversationFootRow({
  streaming,
  compacting,
  retry,
  startedAt,
  runningLabel,
}: ConversationFootRowProps) {
  const copy = useCopy(COPY);
  const compactingAlone = compacting && !streaming;
  const initialSeconds = useMemo(
    // oxlint-disable-next-line react/purity -- the clock is the reading here, taken once per wait.
    () => turnElapsedSeconds(compactingAlone ? null : startedAt, Date.now()) ?? 0,
    [compactingAlone, startedAt],
  );
  const waitRetry = compactingAlone ? null : retry;
  const label = compactingAlone
    ? copy.compactingLabel
    : waitRetry === null
      ? (runningLabel ?? copy.workingLabel)
      : copy.retryingLabel(waitRetry.attempt, Math.max(waitRetry.maxAttempts, waitRetry.attempt));
  return (
    <Message from="assistant">
      <MessageContent>
        <span title={waitRetry?.errorMessage ?? undefined} className="inline-flex">
          <AgentProgress label={label} initialSeconds={initialSeconds} />
        </span>
      </MessageContent>
    </Message>
  );
}

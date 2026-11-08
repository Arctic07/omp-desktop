import { useCallback, useEffect, useState } from "react";
import { Alert, AlertAction, AlertContent, AlertDescription, AlertIcon } from "@/components/motion/alert";
import { Button } from "@/components/motion/button";
import { useCopy } from "@/lib/i18n";
import { COPY } from "@/home/homeCopy";
import { keepWaiting, reclaimSession, stallWatchStore, type StallWatchState } from "@/state/session-stall";
import { useStoreSelector } from "@/state/store";

/**
 * The row over the field for a conversation whose turn stopped producing anything.
 *
 * It exists because "running" is otherwise indistinguishable from "wedged": the stop control is the
 * first thing to try, and this row is the step after it — a forced stop that takes the session down
 * and reloads its history. The row states the silence in whole minutes, because a number that keeps
 * ticking is the fact that makes it believable.
 *
 * *Keep waiting* is a real answer, not a dismissal: some legitimate work is quiet for longer than the
 * threshold, and the reader knows their own task. It silences the automatic step for
 * {@link STALL_SNOOZE_MS}; the row itself goes away, and a conversation that starts producing again
 * clears the row either way.
 */
export function ConversationStall({ sessionId }: { sessionId: string | null }) {
  const copy = useCopy(COPY);
  const selectSince = useCallback(
    (state: StallWatchState) => (sessionId === null ? 0 : (state.stalled[sessionId] ?? 0)),
    [sessionId],
  );
  const since = useStoreSelector(stallWatchStore, selectSince);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [reclaiming, setReclaiming] = useState(false);

  useEffect(() => {
    if (since === 0) return;
    const ticker = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(ticker);
  }, [since]);

  if (sessionId === null || since === 0) return null;

  const minutes = Math.max(1, Math.floor((nowMs - since) / 60_000));
  const title = copy.stallTitle(minutes);

  return (
    <Alert variant="warning" className="py-1.5 pr-1.5 pl-2.5 text-xs" contentClassName="items-center">
      <AlertIcon className="mt-0" />
      <AlertContent className="space-y-0">
        <AlertDescription className="text-xs text-current">{title}</AlertDescription>
        <AlertAction className="pt-1.5">
          <Button
            variant="secondary"
            size="sm"
            disabled={reclaiming}
            onClick={() => {
              setReclaiming(true);
              void reclaimSession(sessionId).finally(() => setReclaiming(false));
            }}
          >
            {copy.stallReclaim}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={reclaiming}
            onClick={() => keepWaiting(sessionId)}
          >
            {copy.stallKeepWaiting}
          </Button>
        </AlertAction>
      </AlertContent>
    </Alert>
  );
}

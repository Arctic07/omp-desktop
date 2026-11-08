import { Clock, Database, GitFork } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { TurnTail } from "@/home/conversation-rows";
import { CopyButton } from "@/home/CopyButton";
import { PluginSlot, usePluginSlotSessionId } from "@/components/plugins/plugin-slot";
import { formatClock, formatDuration } from "@/home/conversation-format";
import { COPY } from "@/home/homeCopy";
import { useCopy } from "@/lib/i18n";
import { formatTokenCount, formatTokensPerSecond } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import { modelStore, providerLabel, providerNameIndex } from "@/state/model-store";
import { useStoreSelector } from "@/state/store";

/**
 * What one settled turn cost, under the row it ended on.
 *
 * It hangs off the turn rather than off the answer, because a turn does not end at its prose: the
 * calls of its last step come after the answer that made them, and a footer drawn with the answer
 * would sit inside the turn it closes (`buildRows` places it, `TurnTail` carries the facts).
 *
 * Every reading here is the engine's or the host's own, and a reading it never reported is not
 * drawn: a turn whose usage the engine did not state shows no usage rather than a zero it never
 * claimed. The one action that is not a reading is the fork, which is offered only where the turn
 * has an entry to name *and* the surface has a conversation to fork: a fork with nowhere to
 * continue from is not a fork, and a subagent's transcript is read here, never branched.
 *
 * **The newest turn keeps its footer in view; every earlier one waits for the reader to come to
 * it.** A long conversation read as a wall of numbers is not a conversation, so the metrics fade out
 * and come back on the pointer or the keyboard anywhere on the row the footer belongs to — not just
 * on the footer's own line, since a reader looking at the answer had to find the line under it to
 * read what the turn cost. `opacity` rather than `visibility` keeps the row's box, and the actions'
 * place in the tab order, intact, and the reveal is guarded to devices that can hover: a touch
 * screen never hides them at all.
 */
export function ConversationTurnTail({
  tail,
  onContinue,
  messageId,
}: {
  tail: TurnTail
  /** Carries the conversation on from the entry this turn ended with; absent where it cannot. */
  onContinue?: (entryId: string) => Promise<void>
  /**
   * The row this turn's footer belongs to, for the plugin action bar.
   *
   * The footer *is* the assistant's action row in this transcript (copy, fork), so a plugin's
   * `message.actions.assistant` items are appended to it. The id is the row the turn ended on: an
   * answer, or the last call of a run.
   */
  messageId?: string
}) {
  const copy = useCopy(COPY);
  const sessionId = usePluginSlotSessionId();
  const [pending, setPending] = useState(false);
  const continueFrom = tail.continueEntryId;
  const forking = continueFrom !== null && onContinue !== undefined;

  const handleContinue = useCallback(() => {
    if (continueFrom === null || onContinue === undefined || pending) return;
    setPending(true);
    void onContinue(continueFrom).finally(() => setPending(false));
  }, [continueFrom, onContinue, pending]);

  const usage = tail.usage;
  // What the turn cost: the prompt billed fresh plus the answer. `cacheRead` is not one of them — a
  // re-read of the same context is the same tokens billed again, and the engine's own per-turn tally
  // counts exactly these two buckets (`TurnUsageTally` in `pi-tui/overlays/usage-row`). It stays in
  // the tooltip, named for what it is, rather than being folded into the figure.
  const total = usage === null ? null : usage.input + usage.cacheWrite + usage.output;
  // What the figure is made of, so the reader can see which bucket the cache re-reads went to.
  const detail =
    usage === null
      ? undefined
      : usage.cacheRead > 0
        ? copy.usageDetailCached(
            formatTokenCount(usage.input + usage.cacheWrite),
            formatTokenCount(usage.output),
            formatTokenCount(usage.cacheRead),
          )
        : copy.usageDetail(
            formatTokenCount(usage.input + usage.cacheWrite),
            formatTokenCount(usage.output),
          );
  const model = tail.model;
  // What each provider is called. The id is not a name a reader can use — a provider this app
  // generated the id for reads `custom-ba937c28` — so the footer names one the way the picker does
  // (2026-10-21, user report). A provider the catalogue does not carry keeps its id, the one true
  // thing left to say about it.
  const providers = useStoreSelector(modelStore, (state) => state.providers);
  const providerNames = useMemo(() => providerNameIndex(providers), [providers]);
  const pill =
    "inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-muted px-2 text-[11px] tabular-nums text-muted-foreground";
  const plain = "shrink-0 text-[11px] tabular-nums text-muted-foreground";

  return (
    <div
      data-slot="turn-tail"
      className={cn(
        // 6px to the left of the prose, so the 24px action's glyph lines up with the text's own edge.
        // It wraps rather than scrolls: the column is the flex remainder beside the tool panel, so
        // its width is the reader's to take away — the readings move to a second line instead of
        // being clipped by a fixed-height row.
        "-ml-1.5 flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-1",
        // A turn the reader has moved past keeps its metrics out of the prose until they come to it:
        // the pointer or the keyboard anywhere on the row the footer belongs to brings them back.
        !tail.latest &&
          "transition-opacity can-hover:opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100",
      )}
    >
      <CopyButton text={tail.text} />
      {/* A plugin's items on the assistant's own action row, after this app's copy and fork. */}
      {messageId === undefined ? null : (
        <PluginSlot
          slot="message.actions.assistant"
          props={{
            message: { id: messageId, role: "assistant", content: tail.text },
            messageId,
            sessionId,
            position: "right",
          }}
        />
      )}
      {forking ? (
        <button
          type="button"
          aria-label={copy.continueFromHere}
          title={copy.continueFromHere}
          disabled={pending}
          onClick={handleContinue}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <GitFork aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
      {total === null ? null : (
        <span className={pill} title={detail}>
          <Database aria-hidden="true" className="size-3.5" />
          {copy.usageLabel(formatTokenCount(total))}
        </span>
      )}
      {tail.durationMs === null ? null : (
        <span className={pill}>
          <Clock aria-hidden="true" className="size-3.5" />
          {copy.ranForLabel(formatDuration(tail.durationMs))}
        </span>
      )}
      {tail.tps === null ? null : (
        <span className={plain}>{copy.tokensPerSecond(formatTokensPerSecond(tail.tps))}</span>
      )}
      {model === null ? null : (
        <span className={pill}>
          {providerLabel(providerNames, model.provider)}/{model.id}
        </span>
      )}
      {tail.at === null ? null : <span className={plain}>{formatClock(tail.at)}</span>}
    </div>
  );
}

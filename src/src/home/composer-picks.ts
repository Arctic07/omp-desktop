/**
 * The composer's two pick controls: which model a conversation runs on, and how hard it thinks.
 *
 * Both are a write to **one** record — the conversation on screen — except on the hero screen,
 * where there is no conversation and the pick edits the engine's `default` role, i.e. what the next
 * conversation starts on. Keeping that decision in one place is what makes "the conversation follows
 * the model I picked last" true of both controls: a pick made between a click and its open used to
 * be read as "no conversation" and written to the role, leaving the conversation on the model it
 * started with while the field showed the new one (2026-10-29, user report).
 *
 * The pick a still-opening conversation is waiting for lives here (`pendingPick`), because it is the
 * same window for both controls and only one conversation can be opening: whichever the reader
 * touched last is what waits, and `home/composer-model.ts::pendingPickHolds` decides whether it
 * still belongs to the open it was made for.
 */
import { useCallback, useEffect, useState } from "react";

import type { ApiError } from "@/api/client";
import { toApiError } from "@/api/client";
import type { ConversationPhase } from "@/home/conversation-phase";
import { pendingPickHolds, type PendingPick } from "@/home/composer-model";
import { assignRole } from "@/state/model-store";
import { setSessionModel, setSessionThinking } from "@/state/session-store";

/** What the controls need of the composer they sit in. */
export interface ComposerPicksInput {
  /** The conversation on screen, or null while it is still opening. */
  readonly sessionId: string | null
  /** Which screen is on — the hero is the only one with no conversation to write. */
  readonly phase: ConversationPhase
  /** The engine's `default` role, as `provider/id`; undefined when the catalogue has none. */
  readonly defaultModel: string | undefined
  /** The pick is being aimed somewhere: the failure line above the field is no longer about it. */
  readonly begin: () => void
  /** Report a refusal beside the conversation it happened in. */
  readonly fail: (error: ApiError, session: string | null) => void
}

export interface ComposerPicks {
  /** The pick a still-opening conversation is waiting for, for the field to name meanwhile. */
  readonly pending: PendingPick | null
  readonly changeModel: (selector: string) => void
  readonly changeThinking: (level: string) => void
}

export function useComposerPicks(input: ComposerPicksInput): ComposerPicks {
  const { sessionId, phase, defaultModel, begin, fail } = input;
  const [pending, setPending] = useState<PendingPick | null>(null);

  const write = useCallback(
    (run: (session: string) => Promise<ApiError | null>) => {
      if (sessionId === null) return;
      void run(sessionId).then((error) => {
        if (error !== null) fail(error, sessionId);
      });
    },
    [fail, sessionId],
  );

  const changeModel = useCallback(
    (selector: string) => {
      const cut = selector.indexOf("/");
      if (cut <= 0) return;
      begin();
      if (sessionId === null) {
        if (phase !== "hero") {
          setPending({ model: selector, at: Date.now() });
          return;
        }
        void assignRole("default", selector).catch((error: unknown) => fail(toApiError(error), sessionId));
        return;
      }
      setPending(null);
      write((session) => setSessionModel(session, selector.slice(0, cut), selector.slice(cut + 1)));
    },
    [begin, fail, phase, sessionId, write],
  );

  const changeThinking = useCallback(
    (level: string) => {
      begin();
      if (sessionId === null) {
        // Only the hero has no conversation to write: there the pick edits the `default` role's
        // level, which is what the next conversation starts on. `auto` clears the pin instead of
        // writing the word into the selector.
        if (phase !== "hero") {
          setPending({ thinking: level, at: Date.now() });
          return;
        }
        if (defaultModel === undefined) return;
        void assignRole("default", level === "auto" ? defaultModel : `${defaultModel}:${level}`).catch(
          (error: unknown) => fail(toApiError(error), sessionId),
        );
        return;
      }
      setPending(null);
      write((session) => setSessionThinking(session, level as Parameters<typeof setSessionThinking>[1]));
    },
    [begin, defaultModel, fail, phase, sessionId, write],
  );

  /**
   * The held pick, written the moment its conversation has an id.
   *
   * One slot, not a queue: the control the reader just used. A pick whose open failed, or whose open
   * never came, is dropped rather than handed to the next conversation.
   */
  useEffect(() => {
    if (pending === null) return;
    const verdict = pendingPickHolds(pending, { sessionId, phase, now: Date.now() });
    if (verdict === "hold") return;
    setPending(null);
    if (verdict === "drop" || sessionId === null) return;
    const model = pending.model;
    const cut = model === undefined ? -1 : model.indexOf("/");
    if (model !== undefined && cut > 0) {
      void setSessionModel(sessionId, model.slice(0, cut), model.slice(cut + 1)).then((error) => {
        if (error !== null) fail(error, sessionId);
      });
      return;
    }
    if (pending.thinking !== undefined) {
      void setSessionThinking(sessionId, pending.thinking as Parameters<typeof setSessionThinking>[1]).then((error) => {
        if (error !== null) fail(error, sessionId);
      });
    }
  }, [fail, pending, phase, sessionId]);

  return { pending, changeModel, changeThinking };
}

"use client";

import { ChevronDown, FolderOpen } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useState } from "react";
import { Button } from "@/components/motion/button";
import { chooseFolder } from "@/api/dialog";
import { NO_HOVER_GROWTH } from "@/lib/hover-motion";
import { EASE_IN_OUT, EASE_OUT } from "@/lib/ease";
import { useCopy } from "@/lib/i18n";
import { COPY } from "@/home/homeCopy";
import { ConversationWelcome } from "@/home/ConversationWelcome";
import { addWorkspace, workspaceStore } from "@/state/workspace-store";
import { useStoreSelector } from "@/state/store";

/**
 * The hero: the conversation column's body when there is nothing in it yet.
 *
 * It covers both of the states that mean "nothing yet" — no workspace at all, and a conversation
 * whose first message has not been written — because they are the same question asked of two
 * surfaces: which workspace am I working in, and what do I want the agent to do.
 *
 * **It is the body, not the dock.** The block fills the room above the composer, which is the room
 * the transcript takes once a conversation has one, so the field below it is exactly as high here as
 * it is under a transcript. Nothing about the composer changes when this block comes or goes — the
 * workspace row that asks for a workspace is the block's own foot, not a row inside the field's stack
 * — which is what makes the hand-over a cross-fade rather than a jump.
 *
 * **It leaves with the first message.** `conversationPhase` turns from `hero` to `conversation` the
 * moment the reader's own row lands, and `ChatAppHome` keeps this under an `AnimatePresence`: the
 * block lifts and fades while the transcript fades in below it, both on the same easing and without
 * either of them moving the field.
 */
export function ConversationHero() {
  const copy = useCopy(COPY);
  const reduce = useReducedMotion() ?? false;
  const rootPath = useStoreSelector(workspaceStore, selectActiveRootPath);
  const [picking, setPicking] = useState(false);

  const pick = useCallback(async () => {
    setPicking(true);
    try {
      const folder = await chooseFolder(copy.chooseWorkspace);
      if (folder !== null) await addWorkspace(folder);
    } catch {
      // A picker the desktop refuses, or a folder it will not take, leaves the hero as it was.
    } finally {
      setPicking(false);
    }
  }, [copy.chooseWorkspace]);

  return (
    <motion.div
      // Drawn, not faded in — the same rule the transcript follows (`ConversationEntrance`): what
      // arrives is there at full weight and rises into place, what leaves fades. Fading this one in
      // under the loading mark's own fade-out made the middle of the hand-over dim, which is the
      // screen going blank for a beat (2026-10-27).
      initial={reduce ? false : { y: 8 }}
      animate={{ y: 0 }}
      // Only the exit animates opacity. The two halves of it sit on different curves on purpose: the
      // lift keeps `EASE_OUT`'s fast start so it reads as leaving at once, while the fade rides
      // `EASE_IN_OUT` — `EASE_OUT` on an opacity drops three quarters of the block in the first
      // 40ms, which is a blink, not a fade.
      exit={{ opacity: 0, y: reduce ? 0 : -8 }}
      transition={
        reduce
          ? { duration: 0 }
          : {
              y: { duration: 0.22, ease: EASE_OUT },
              opacity: { duration: 0.2, ease: EASE_IN_OUT },
            }
      }
      className="absolute inset-0 flex min-h-0 flex-col"
    >
      {/* The welcome only has somewhere to write to once a workspace is open: with none, the row at
          the foot is the whole screen, exactly as it was before the welcome existed.

          It sits on the conversation's lane — the same `--omp-conversation-lane` the field and the
          transcript use — so the starters are exactly as wide as the box they will be typed into. */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-3">
        {rootPath === null ? null : (
          <div className="mx-auto flex w-full min-w-0 max-w-(--omp-conversation-lane) flex-col">
            <ConversationWelcome />
          </div>
        )}
      </div>
      {/* The workspace row: a path is not something to type by hand, so the row opens the desktop's
          own folder picker — the same control the rail's own entry uses (`WorkspaceRail.tsx`). It is
          a button rather than a label: pressing it is how a reader who has none gets one, and how one
          who has another gets that one. It sits on the lane the field and the transcript share, so the
          three stay flush at every width the right column leaves behind. */}
      <div className="shrink-0 px-3 pb-1">
        <div className="mx-auto flex w-full max-w-(--omp-conversation-lane) min-w-0 items-center">
          <Button
            {...NO_HOVER_GROWTH}
            type="button"
            variant="ghost"
            size="sm"
            disabled={picking}
            aria-label={rootPath ?? copy.chooseWorkspace}
            title={rootPath ?? copy.chooseWorkspace}
            onClick={() => void pick()}
            className="max-w-[22rem] gap-1.5 rounded-full px-3 text-[13px] text-foreground"
          >
            <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{rootPath ?? copy.chooseWorkspace}</span>
            <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

/** The workspace being worked in, by the path the row names. */
function selectActiveRootPath(state: {
  items: { id: number; rootPath: string }[];
  activeId: number | null;
}): string | null {
  if (state.activeId === null) return null;
  return state.items.find((item) => item.id === state.activeId)?.rootPath ?? null;
}

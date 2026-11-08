/**
 * The composer's readings: its store selectors and the few values it builds for its own controls.
 *
 * They are here rather than in `home/ConversationComposer.tsx` because they are rules about the
 * data — which record is on screen, whether its turn is moving, what the gauge says — and because
 * the component itself is already the largest surface in this directory. Nothing here renders; the
 * selector identities are stable module constants, which is what `useStoreSelector` requires.
 */

import type { ApiError } from "@/api/client";
import type { SessionRuntimeState, UiRequest } from "@/api/session-types";
import type { EngineModel } from "@/api/types";
import type { ContextGaugeUsage } from "@/components/agents/context-gauge";
import type { AttachmentRefusal } from "@/state/composer-attachments";
import type { DesktopDropState } from "@/state/desktop-drop";
import type { FileDragState } from "@/state/file-drag-store";
import {
  activeRecord,
  isStoppable,
  isStreaming,
  type SessionNotice,
  type SessionStoreState,
} from "@/state/session-store";
import { conversationDraftKey } from "@/state/composer-draft-store";
import type { HomeCopy } from "@/home/homeCopy";

/** The engine's own level vocabulary, mapped onto the composer's control. */
export function composerLevel(level: string | null): string {
  // `inherit` and `auto` are the same choice; the control only knows the second name.
  return !level || level === "inherit" ? "auto" : level;
}

/**
 * The effort levels the composer draws, for the model it names.
 *
 * The conversation's own report wins — it is what the engine will run at. Before one arrives (the
 * hero screen, and the frame while a conversation opens) the catalogue's entry for the same model
 * answers, because it is the same fact read from the other side: a model with no reasoning surface
 * reports an empty list there too, and standing on the full ladder instead would draw a strength
 * control in front of a model that has none, then fold it away a frame later.
 *
 * `undefined` means nothing is known yet, which is the one case that keeps the ladder standing in
 * (`home/../lib/thinking-levels.ts::thinkingLadder`): a model this app does not carry gets no
 * invented answer either.
 */
export function composerThinkingLevels(
  reported: readonly string[] | undefined,
  model: string | null,
  catalogue: readonly EngineModel[],
): readonly string[] | undefined {
  if (reported !== undefined) return reported;
  if (model === null) return undefined;
  return catalogue.find((entry) => `${entry.provider}/${entry.id}` === model)?.thinkingLevels;
}

/**
 * The engine's own context accounting, as the gauge reads it.
 *
 * Built from the runtime snapshot rather than derived: the window, the occupancy, the split and the
 * session's totals are each one field the host publishes, and a figure this side computed would be
 * a second answer to a question the engine already answered.
 */
export function contextUsageOf(runtime: SessionRuntimeState | null): ContextGaugeUsage | null {
  if (runtime === null) return null;
  return {
    usedTokens: runtime.contextTokens,
    windowTokens: runtime.contextWindow,
    anchored: runtime.contextAnchored !== false,
    categories: runtime.contextCategories ?? null,
    autoCompactPercent: runtime.autoCompactPercent,
    usage: runtime.sessionUsage,
  };
}

/**
 * A failure the composer is showing, and the row the notice list draws it as.
 *
 * The row is made once, where the failure happened, because it carries an id the reader's dismissal
 * is remembered against: an id minted on every render would be a new row each time, and dismissing
 * one would bring it straight back.
 */
export interface ComposerFailure {
  sessionId: string | null;
  notice: SessionNotice;
}

/** Numbered downwards from zero, so a composer row never collides with a session's own notice ids. */
let failureSeq = 0;

/** One failure's notice, made where it happened so the reader's dismissal sticks to its id. */
export function failureNotice(error: ApiError): SessionNotice {
  failureSeq -= 1;
  return {
    id: failureSeq,
    level: "error",
    code: error.code,
    message: error.message,
    at: Date.now(),
  };
}

/**
 * A refusal in this app's words, where this side is the one that knows what happened.
 *
 * A folder among the paths and a file past the desktop's size budget are both the desktop's own
 * refusals, but their sentences belong here: the reader chose a folder, or a file too large to send,
 * and that is what the notice line says. Everything else the desktop said travels as it stands.
 */
export function attachmentFailure(refusal: AttachmentRefusal, copy: HomeCopy): ApiError {
  if (refusal.kind === "directory") {
    return { code: "attachment_directory", message: copy.droppedDirectory };
  }
  if (refusal.kind === "too_large") {
    return { code: "attachment_too_large", message: copy.attachmentTooLarge(refusal.name) };
  }
  return refusal.error;
}

/** Whether a dragged file is over the field, which is what the drop face is drawn on. */
export const selectDroppingOver = (state: DesktopDropState) => state.dragging && state.over;

/** The same question for a drag that started in this app's own file tree. */
export const selectFileDroppingOver = (state: FileDragState) => state.drag !== null && state.over;

/**
 * Whether a drag is over the overlay drawn above the field — a dialog's answer box.
 *
 * Its own reading rather than `over`: both surfaces can be on screen at once, and a drag over the
 * dialog's box is not a drag over the field stacked below it.
 */
export const selectDroppingOverOverlay = (state: DesktopDropState) =>
  state.dragging && state.overlayOver;

/** The same question for the file tree's own drag. */
export const selectFileDroppingOverOverlay = (state: FileDragState) =>
  state.drag !== null && state.overlayOver;

/** The conversation on screen, which is the one the queue belongs to. */
export const selectActiveId = (state: SessionStoreState) => state.activeId;

/** The active conversation's engine snapshot; one object per state frame, not per token. */
export const selectRuntime = (state: SessionStoreState) => activeRecord(state)?.runtime ?? null;
/** Whether a turn is in flight here, as a boolean: stable between the edges that move it. */
export const selectStreaming = (state: SessionStoreState) => isStreaming(activeRecord(state));
/** Whether the agent is still answering here, as a boolean: the field's send/stop pair reads it. */
export const selectStoppable = (state: SessionStoreState) => isStoppable(activeRecord(state));
/** Whether a stop this side asked for is still on its way back. */
export const selectStopPending = (state: SessionStoreState) =>
  activeRecord(state)?.stopPending === true;
export const selectNotices = (state: SessionStoreState) =>
  activeRecord(state)?.notices ?? NO_NOTICES;
export const selectDialogs = (state: SessionStoreState) => activeRecord(state)?.dialogs ?? NO_DIALOGS;
export const selectRecordFile = (state: SessionStoreState) => activeRecord(state)?.filePath ?? null;
export const selectRecordWorkspaceId = (state: SessionStoreState) =>
  activeRecord(state)?.workspaceId ?? null;

/** No notices and no dialogs, as the arrays the readings hold between writes. */
const NO_NOTICES: readonly SessionNotice[] = [];
/** No dialogs at all, as one array: the field's own reading has to keep its identity between reads. */
const NO_DIALOGS: UiRequest[] = [];

/**
 * The seat the composer's draft belongs to (`state/composer-draft-store.ts`).
 *
 * A pin set while a conversation is opening wins over the record still on screen: the reader
 * clicked the one they want, and the box must follow the click immediately rather than after the
 * round trip — otherwise what they type while it loads is written into the conversation they are
 * leaving. With no pin, the record on screen decides; with neither, the empty seat, which the box
 * keeps (the layout effect ignores it) instead of blanking the reader's words.
 */
export const selectDraftKey = (state: SessionStoreState) =>
  state.openingSeat ?? conversationDraftKey(activeRecord(state));

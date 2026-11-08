"use client";
// The composer's field: the reader's words and the files they carry, in one flow.

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import { AttachmentPreviewCard } from "@/components/agents/attachment-preview-card";
import { Tooltip } from "@/components/motion/tooltip";
import type { PromptSubmitGesture } from "@/components/agents/prompt-input";
import {
  chipTokensInDom,
  isCompositionKey,
  paintDraft,
  placeCaret,
  readDraft,
  selectionRange,
  setLineBreakParagraphs,
} from "@/components/agents/composer-editor";
import {
  emptyComposerUndo,
  recordComposerEdit,
  redoComposerEdit,
  undoComposerEdit,
  type ComposerUndoState,
  type ComposerUndoStep,
} from "@/components/agents/composer-undo";
import {
  draftProse,
  planClipboardPaste,
  type ClipboardPaste,
  type ComposerAttachment,
} from "@/state/composer-draft";
import { openAttachmentViewer } from "@/state/attachment-viewer-store";
import { copyTextWithFiles, recallOwnCopy, recoverPastedText } from "@/lib/clipboard";
import { textWithFileMentions } from "@/lib/file-mention";
import { cn } from "@/lib/utils";

/**
 * The field a prompt is written in: one `contenteditable` box holding text *and* files.
 *
 * A chip is one character of the draft and one element of the box, so a file added where the caret
 * is stays there, and the caret, the selection and backspace all move through it the way they move
 * through a letter. That is the whole reason this is not a `<textarea>`: no text input can hold an
 * element, and a row of chips above the text is a different sentence than the one the reader is
 * writing.
 *
 * The box is *not* a controlled component, and that is deliberate. The reader types into the DOM and
 * the browser owns the caret; React re-rendering the children of a `contenteditable` would rewrite
 * the nodes that caret lives in — the classic way a field loses a character mid-word, or loses an
 * IME composition entirely. So the draft is read back out of the box on `input`, and written back
 * into it only when it changed somewhere else: an import's chips, the field's own ✕, a send that
 * cleared it, a conversation switched under a draft that was another one's. The two are reconciled
 * by comparing the chips the box holds with the records the draft names.
 *
 * What the field hands outward is a string (`onValueChange`) and, for a paste, what the clipboard
 * carried: the `File`s themselves (`onFiles`) or the paths a copy of this page's own names
 * (`onPaths`). The import, the store and the prompt belong to the composer, and this side has no
 * opinion about where a file came from.
 *
 * What the pointer finds on a chip is the file itself: the card it opens is drawn by this component
 * (the chip is its own element, so it is the one that can say which chip the pointer is on) and its
 * content is the shared preview `components/agents/attachment-preview-card.tsx` renders. A click on
 * an image's chip — or on the picture the card is showing — opens that file at the size of the
 * window (`home/AttachmentViewer.tsx`): the card is a glance, not a look.
 *
 * Two edits are the component's own because the browser's native behaviour cannot express them.
 * Undo is here (`composer-undo.ts`): every programmatic paint resets Chromium's stack, so Ctrl+Z
 * walks the steps this field recorded for the draft instead. A copy that has chips in its selection
 * is here too: the browser would write their visible labels as text, and the files behind them would
 * be lost, so the copy carries the files' own paths — as mention lines in the text and, where the
 * platform can, as a real file list on the clipboard. A paste of that same copy is read back here
 * as well (`lib/clipboard.ts::recallOwnCopy`), so the words and the chips are what returns, not the
 * mention lines.
 */
export interface ComposerFieldHandle {
  /**
   * Remember where the next imported chips should land: the selection, or the caret as it was.
   *
   * The caret is the answer even for a drop, which is why this takes no position: a file dragged in
   * from outside the window was released by a pointer that has nothing to do with where the reader
   * was writing, and the caret the field last knew is the place they left. It is captured *before*
   * the import, because the import is a round trip through the desktop and the caret moves meanwhile.
   */
  captureAnchor: () => void
  /** Write freshly imported chips at the remembered spot, and leave the caret after them. */
  insertChips: (attachments: readonly ComposerAttachment[]) => void
  focus: () => void
}

/**
 * A key a popup riding on the field may own, before the field's own readings see it.
 *
 * The command list is the one such popup today: while it is up, Up/Down move through it, Enter and
 * Tab take the row, and Escape folds it away — none of which is a caret move, a submission or a
 * history walk. The field asks on every key and only prevents the ones the popup answers, so a
 * closed list leaves typing, Enter, Tab and the caret exactly as they were.
 */
export type ComposerPopupKey = "previous" | "next" | "accept" | "dismiss";

export interface ComposerFieldProps {
  /** The field's own id, for a caller that has something to point at it. */
  id?: string
  /** The draft the field is showing, tokens included. */
  value: string
  attachments: readonly ComposerAttachment[]
  /** The draft as the box now holds it, which is what a prompt is written out of. */
  onValueChange: (next: string) => void
  /**
   * The whole draft after an undo: its words and the records behind its chips.
   *
   * The field keeps the history, but the records live in the composer's draft store, and a chip the
   * reader deleted has already been taken out of it — so putting the character back is not enough;
   * the caller has to put the record back too, or the chip would stand for a file nothing holds.
   */
  onRestoreDraft: (draft: string, attachments: readonly ComposerAttachment[]) => void
  /** The ✕: a file the reader took out of this prompt. */
  onRemoveAttachment: (token: string) => void
  /** Files pasted into the field, which the composer imports. */
  onFiles: (files: readonly File[]) => void
  /**
   * Paths a paste named itself — a copy this page wrote — which the composer attaches as files.
   *
   * A copy of a message carries the files' own addresses, so it comes back as those files rather
   * than as a second copy of their bytes. Absent, that paste attaches nothing.
   */
  onPaths?: (paths: readonly string[]) => void
  /** Enter, and Enter with the accelerator — the two gestures a textarea would report. */
  onSubmitGesture: (gesture: PromptSubmitGesture) => void
  /**
   * Up and Down over the reader's earlier prompts, each answering whether it consumed the key.
   *
   * The composer owns the history — which prompts, which one is showing, what was typed before the
   * walk began — so the field only asks, on the one gate that makes a recall rather than a caret
   * move (`handleKeyDown`): an empty box, or a walk already in progress.
   */
  onHistoryPrevious?: () => boolean
  onHistoryNext?: () => boolean
  /**
   * A popup riding on the field asks for a key before anything else reads it.
   *
   * It answers whether it consumed the key; a `false` leaves the key to the caret, the history walk
   * or the submission exactly as if this prop were absent.
   */
  onPopupKey?: (key: ComposerPopupKey) => boolean
  /**
   * The reader changed the draft: typed, pasted, pressed a chip's ✕, or dropped files in.
   *
   * A programmatic paint (a send clearing the box, a recalled draft arriving) is not this — which is
   * what lets the composer end its history walk on the reader's own edit only.
   */
  onDraftEdited?: () => void
  /** The ✕'s accessible name for one file, in the reader's own language. */
  removeLabel: (name: string) => string
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
  minRows?: number
  maxRows?: number
  className?: string
  ref?: Ref<ComposerFieldHandle>
}

/** The field's own line height, which is `leading-6` and what its row limits are counted in. */
const LINE_HEIGHT_PX = 24;

/** What one draft index would be if it were a selection: the caret's own reading of it. */
interface DraftAnchor {
  start: number
  end: number
}

/**
 * The key a popup on the field would answer, if this is one of them.
 *
 * Modifiers stay the reader's: Ctrl/Cmd+Enter still submits, Shift+Enter is still a newline, and
 * Alt combinations still belong to the platform. What is left — the bare arrows, Enter, Tab and
 * Escape — is what a list riding on the field can own.
 */
function popupKeyOf(event: KeyboardEvent<HTMLDivElement>): ComposerPopupKey | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === "Escape") return "dismiss";
  if (event.shiftKey) return null;
  if (event.key === "ArrowUp") return "previous";
  if (event.key === "ArrowDown") return "next";
  if (event.key === "Tab") return "accept";
  if (event.key === "Enter") return "accept";
  return null;
}

/**
 * This render's callbacks and records, for everything that outlives a render.
 *
 * A painted chip holds a closure for the ✕ the reader may press a minute later, and a conversation
 * can be switched in between — so nothing the DOM carries reads a prop directly.
 */
interface LatestState {
  attachments: readonly ComposerAttachment[]
  onValueChange: (next: string) => void
  onRestoreDraft: (draft: string, attachments: readonly ComposerAttachment[]) => void
  onRemoveAttachment: (token: string) => void
  onFiles: (files: readonly File[]) => void
  onPaths: (paths: readonly string[]) => void
  onSubmitGesture: (gesture: PromptSubmitGesture) => void
  onHistoryPrevious: () => boolean
  onHistoryNext: () => boolean
  onPopupKey: (key: ComposerPopupKey) => boolean
  onDraftEdited: () => void
  removeLabel: (name: string) => string
  /** The ✕'s act, kept here because the chips painted before it was written still call it. */
  onRemoveChip: (token: string) => void
  /** The chip's own hover, kept here for the same reason: a painted chip outlives a render. */
  onHoverChip: (element: HTMLElement | null, attachment: ComposerAttachment | null) => void
}

/**
 * How long the preview card waits, both ways.
 *
 * The same delay the window's other labels use: a pointer crossing the field on its way somewhere
 * else does not flash a picture, and a pointer that has left the chip has that long to reach the
 * picture before the card closes under it.
 */
const HOVER_DELAY_MS = 120;

export function ComposerField({
  id,
  value,
  attachments,
  onValueChange,
  onRestoreDraft,
  onRemoveAttachment,
  onFiles,
  onPaths,
  onSubmitGesture,
  onHistoryPrevious,
  onHistoryNext,
  onPopupKey,
  onDraftEdited,
  removeLabel,
  placeholder,
  ariaLabel,
  disabled = false,
  minRows = 2,
  maxRows = 8,
  className,
  ref,
}: ComposerFieldProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  /** The draft the box is holding: the DOM's own reading, not the prop's. */
  const draftRef = useRef("");
  /** Where an import lands, in draft coordinates, and the caret as last seen. */
  const anchorRef = useRef<DraftAnchor | null>(null);
  const caretRef = useRef(0);
  /**
   * The drafts Ctrl+Z and Ctrl+Shift+Z walk.
   *
   * Owned by this field and released with it; bounded by `COMPOSER_UNDO_LIMIT` steps in each
   * direction. The browser's own stack is unusable here — every paint through `render` replaces the
   * box's nodes, which resets it — so each edit is recorded where it happens.
   */
  const undoRef = useRef<ComposerUndoState>(emptyComposerUndo());
  const latest = useRef<LatestState>({
    attachments,
    onValueChange,
    onRestoreDraft,
    onRemoveAttachment,
    onFiles,
    onPaths: () => {},
    onSubmitGesture,
    onHistoryPrevious: () => false,
    onHistoryNext: () => false,
    onPopupKey: () => false,
    onDraftEdited: () => {},
    removeLabel,
    onRemoveChip: () => {},
    onHoverChip: () => {},
  });
  /** The tokens on hand, as one string: what the reconciliation below is keyed on. */
  const tokenKey = attachments.map((attachment) => attachment.token).join("");
  const [hovered, setHovered] = useState<ComposerAttachment | null>(null);
  /** The one timer between the pointer and the card, whichever direction it is standing for. */
  const hoverTimer = useRef<number | null>(null);
  /**
   * The chip the card hangs over, as the anchor the tooltip reads.
   *
   * It is written by the gesture that opens the card, *before* the state that opens it, so the
   * tooltip's own layout pass sees the element in the same commit — a card drawn a frame after the
   * chip it points at would be a card pointing at where the chip used to be.
   */
  const hoverAnchor = useRef<HTMLElement | null>(null);

  const stopHoverTimer = useCallback(() => {
    if (hoverTimer.current === null) return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  }, []);

  /** Close the card now, and forget the chip it belonged to. */
  const closeCard = useCallback(() => {
    stopHoverTimer();
    hoverAnchor.current = null;
    setHovered(null);
  }, [stopHoverTimer]);

  /**
   * The chip's own hover: wait, then show.
   *
   * Both directions wait, and both are the same timer: entering a chip asks for the card in
   * `HOVER_DELAY_MS`, leaving it asks for the close in the same time, so a pointer that travels from
   * one chip to the next — or from a chip onto the picture — never sees the card blink.
   */
  const hoverChip = useCallback(
    (element: HTMLElement | null, attachment: ComposerAttachment | null) => {
      stopHoverTimer();
      const leaving = element === null || attachment === null;
      hoverTimer.current = window.setTimeout(() => {
        hoverTimer.current = null;
        hoverAnchor.current = leaving ? null : element;
        setHovered(leaving ? null : attachment);
      }, HOVER_DELAY_MS);
    },
    [stopHoverTimer],
  );

  // The timer belongs to this component, so leaving the field takes it along: a chip's hover must not
  // close a card that belongs to a composer the reader has already left.
  useEffect(() => stopHoverTimer, [stopHoverTimer]);

  /**
   * Write a draft into the box, and tell the composer what the box now holds.
   *
   * `extra` is a record the store's list does not have yet — the chips an import just produced,
   * painted on the frame they arrive rather than one frame later. The report is unconditional (a
   * paint always changes what the box holds) and cheap: a composer state update with the value it
   * already has is the same state, which React discards.
   */
  const render = useCallback(
    (draft: string, caret: number | null, extra: readonly ComposerAttachment[] = []) => {
      const root = rootRef.current;
      if (root === null) return;
      const state = latest.current;
      // The chips the box is holding are replaced here, so a card hanging over one of them is
      // pointing at an element that is about to leave the document.
      closeCard();
      const painted = paintDraft(
        draft,
        extra.length === 0 ? state.attachments : [...state.attachments, ...extra],
        {
          removeLabel: (name) => state.removeLabel(name),
          onRemove: (token) => latest.current.onRemoveChip(token),
          onHover: (element, attachment) => latest.current.onHoverChip(element, attachment),
          // A picture chip's click, from a chip painted at any point in this field's life: the card
          // it is under is this component's own, so it closes here before the viewer takes the
          // window.
          onOpen: (attachment) => {
            closeCard();
            openAttachmentViewer(attachment);
          },
        },
      );
      root.replaceChildren(...painted.nodes);
      draftRef.current = painted.text;
      state.onValueChange(painted.text);
      if (caret !== null) {
        // A paint puts the caret somewhere, and the field's memory of it follows: a drop, a paste
        // and the ✕ all anchor at that memory when the box has no selection of its own, so a paint
        // that moved the caret without recording it would place the next file where the last one
        // used to be.
        const at = Math.min(caret, painted.text.length);
        caretRef.current = at;
        placeCaret(root, at);
      }
    },
    [closeCard],
  );

  /**
   * One edit the reader made, recorded as the state it replaced.
   *
   * `typing` is the only kind that coalesces (`composer-undo.ts`); a paint, a paste or a chip's ✕ is
   * a step of its own. The attachments are read here, before the composer has been told about the
   * new draft: a chip the edit removed is still held by the store at this instant, and the step has
   * to be able to put it back.
   */
  const rememberEdit = useCallback((before: string, caret: number, typing: boolean) => {
    undoRef.current = recordComposerEdit(
      undoRef.current,
      { draft: before, caret, attachments: latest.current.attachments },
      performance.now(),
      typing,
    );
  }, []);

  /** Put one recorded step back into the box and into the composer's store. */
  const applyStep = useCallback(
    (step: ComposerUndoStep) => {
      // `step.attachments` are painted here as well: the store may already have dropped a record the
      // step is bringing back, and the chip has to be on screen in the same commit it is restored in.
      render(step.draft, step.caret, step.attachments);
      caretRef.current = Math.min(step.caret, step.draft.length);
      latest.current.onRestoreDraft(step.draft, step.attachments);
      latest.current.onDraftEdited();
      rootRef.current?.focus();
    },
    [render],
  );

  const undoDraft = useCallback(() => {
    const result = undoComposerEdit(undoRef.current, {
      draft: draftRef.current,
      caret: caretRef.current,
      attachments: latest.current.attachments,
    });
    if (result === null) return;
    undoRef.current = result.state;
    applyStep(result.step);
  }, [applyStep]);

  const redoDraft = useCallback(() => {
    const result = redoComposerEdit(undoRef.current, {
      draft: draftRef.current,
      caret: caretRef.current,
      attachments: latest.current.attachments,
    });
    if (result === null) return;
    undoRef.current = result.state;
    applyStep(result.step);
  }, [applyStep]);

  /**
   * The ✕'s own act: take one character out of the draft.
   *
   * It is the same edit as backspacing over the chip — the character goes, the file follows — and it
   * is written as that edit rather than as DOM surgery, so the draft, the paint and the store stay
   * one story.
   */
  const removeChip = useCallback(
    (token: string) => {
      const draft = draftRef.current;
      const at = draft.indexOf(token);
      if (at < 0) return;
      rememberEdit(draft, at, false);
      render(`${draft.slice(0, at)}${draft.slice(at + 1)}`, at);
      latest.current.onRemoveAttachment(token);
      latest.current.onDraftEdited();
      rootRef.current?.focus();
    },
    [rememberEdit, render],
  );

  useLayoutEffect(() => {
    latest.current = {
      attachments,
      onValueChange,
      onRestoreDraft,
      onRemoveAttachment,
      onFiles,
      onPaths: onPaths ?? (() => {}),
      onSubmitGesture,
      onHistoryPrevious: onHistoryPrevious ?? (() => false),
      onHistoryNext: onHistoryNext ?? (() => false),
      onPopupKey: onPopupKey ?? (() => false),
      onDraftEdited: onDraftEdited ?? (() => {}),
      removeLabel,
      onRemoveChip: removeChip,
      onHoverChip: hoverChip,
    };
  });

  useLayoutEffect(() => {
    setLineBreakParagraphs();
  }, []);

  // A draft that changed somewhere else — cleared by a send, restored, replaced — is written back
  // into the box. The reader's own typing is not one of those: it never changes this prop without
  // having changed the DOM first, so the two are equal and there is nothing to write. A paint from
  // the outside is a different draft (another conversation's, a sent one's), so Ctrl+Z must not walk
  // back into it: the history starts again here.
  useLayoutEffect(() => {
    if (value === draftRef.current) return;
    undoRef.current = emptyComposerUndo();
    render(value, value.length);
  }, [render, value]);

  /**
   * The records and the chips, reconciled.
   *
   * The two drift apart in exactly two ways. A record the reader took out of the draft is already
   * gone from both — nothing to do. A chip whose record is gone is what a paint drops: the files of
   * another conversation, left in a draft written before the reader switched. Comparing the two
   * lists is what keeps a backspace from repainting the box under the reader's own caret.
   *
   * The comparison is keyed on the tokens rather than on the array: the composer rebuilds that array
   * on every keystroke (it is derived from the draft), and reading the box's own chips back on each
   * one of them would be work per letter for an answer that never changes.
   */
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const named = namedTokens(draftRef.current, attachments);
    const painted = chipTokensInDom(root);
    if (named.length === painted.length && named.every((token, at) => token === painted[at])) return;
    // The records moved under the draft without the reader editing it, so the steps holding the
    // old ones are no longer states this draft can return to.
    undoRef.current = emptyComposerUndo();
    render(draftRef.current, null);
  }, [attachments, render, tokenKey]);

  /** Keep the caret the field last knew, for a gesture that arrives without a selection. */
  const rememberCaret = () => {    const root = rootRef.current;
    if (root === null) return;
    const selection = selectionRange(root);
    if (selection !== null) caretRef.current = selection.end;
  };

  /** The caret as a draft range, for a gesture the webview forwards with no selection of its own. */
  const caretAnchor = (): DraftAnchor => {
    const at = Math.min(caretRef.current, draftRef.current.length);
    return { start: at, end: at };
  };

  /** Where an edit made right now goes: the selection, or the last caret this box knew of. */
  const currentAnchor = (): DraftAnchor => {
    const root = rootRef.current;
    return (root === null ? null : selectionRange(root)) ?? caretAnchor();
  };

  /** Write the box back into a draft. This is the only place the composer's draft is read from. */
  const handleInput = (event: FormEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (root === null) return;
    const read = readDraft(root);
    // A box holding nothing but the browser's own break reads back as a newline: as far as the
    // draft, the hint and the prompt are concerned, that box is empty.
    const draft = read.trim() === "" ? "" : read;
    if (draft === draftRef.current) return;
    // The state this keystroke (or native edit) replaced, with the caret it stood at. Typing
    // coalesces into a burst, so a sentence is one Ctrl+Z rather than one per letter — but an edit
    // the browser made on its own (a cut with no chip in the selection, a dropped word) is a step of
    // its own: folded into the burst before it, Ctrl+Z would take the sentence as well.
    const inputType = (event.nativeEvent as InputEvent).inputType ?? "";
    const ownEdit = inputType === "deleteByCut" || inputType === "insertFromDrop";
    rememberEdit(draftRef.current, caretRef.current, !ownEdit);
    draftRef.current = draft;
    const selection = selectionRange(root);
    caretRef.current = selection === null ? draft.length : selection.end;
    latest.current.onValueChange(draft);
    latest.current.onDraftEdited();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isCompositionKey(event.nativeEvent)) return;
    // A popup riding on this field — the command list — reads its own keys first: while it is up a
    // bare Up/Down moves through it, Enter or Tab takes the row, and Escape folds it away. A popup
    // that says the key is not its own (no list is open) leaves every one of those to the carets,
    // the history walk and the submission below, exactly as it was.
    const popup = popupKeyOf(event);
    if (popup !== null && latest.current.onPopupKey(popup)) {
      event.preventDefault();
      return;
    }
    // Undo and redo are this field's own stack, not the browser's: every paint replaces the box's
    // nodes, which is what resets Chromium's history, so the browser's Ctrl+Z would stop working
    // the first time a file arrived. Ctrl+Z / Cmd+Z, Ctrl+Shift+Z and Ctrl+Y are the platform's
    // three spellings of the pair.
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redoDraft();
        else undoDraft();
        return;
      }
      if (key === "y" && !event.shiftKey) {
        event.preventDefault();
        redoDraft();
        return;
      }
    }
    // Up and Down walk the prompts the reader already sent, the way a terminal's own history does.
    // The composer decides whether the key belongs to that walk (an empty box, or one it is still
    // walking); with a draft being written they are the caret's, and nothing is prevented here.
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      const consumed =
        event.key === "ArrowUp"
          ? latest.current.onHistoryPrevious()
          : latest.current.onHistoryNext();
      if (consumed) event.preventDefault();
      return;
    }
    // Shift and Alt are the reader's own: a newline, or whatever the platform makes of them.
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    event.preventDefault();
    latest.current.onSubmitGesture(event.ctrlKey || event.metaKey ? "accelerated" : "enter");
  };

  /**
   * Put words into the draft where the paste's anchor is, as one undo step.
   *
   * The caret moves past the text so an import that follows lands its chips where the words end.
   * The anchor is the one the paste captured, in draft coordinates: the read that recovers a
   * hidden text is a round trip, and the caret may have moved by then.
   */
  const insertPastedWords = useCallback(
    (text: string) => {
      const draft = draftRef.current;
      const anchor = anchorRef.current ?? currentAnchor();
      const at = Math.min(anchor.start, draft.length);
      const to = Math.min(Math.max(anchor.end, at), draft.length);
      rememberEdit(draft, at, false);
      render(`${draft.slice(0, at)}${text}${draft.slice(to)}`, at + text.length);
      latest.current.onDraftEdited();
      anchorRef.current = { start: at + text.length, end: at + text.length };
      caretRef.current = at + text.length;
      rootRef.current?.focus();
    },
    // `currentAnchor` and the undo helpers read refs only, so the paste path stays one stable
    // function across renders.
    [rememberEdit, render],
  );

  /**
   * Write one paste's plan into the box: its words, then its files.
   *
   * The words go in first and the chips after them, because the chips are what the desktop imports
   * (a round trip), and only the words can be written on this frame. `insertChips` reads the anchor
   * this leaves, so a paste of words and files keeps them in that order.
   */
  const applyPaste = useCallback(
    (plan: ClipboardPaste, files: readonly File[]) => {
      if (plan.words.length > 0) insertPastedWords(plan.words);
      if (plan.paths.length > 0) latest.current.onPaths(plan.paths);
      if (plan.importFiles) latest.current.onFiles(files);
    },
    [insertPastedWords],
  );

  /**
   * A paste is files or it is words, never markup.
   *
   * A clipboard holds one of three things (`planClipboardPaste`): a copy this application wrote (the
   * words, the files, and the mention lines that name them), a snapshot out of a browser or a
   * document (a sentence and a picture of it), or files alone. The first and last import the files
   * as chips and keep only the words; the snapshot keeps only the words, because the picture is not
   * an attachment anybody asked for. What no case does is let the browser paste HTML: a prompt is
   * text, and another application's styles (and its own inline pictures) have no business inside this
   * box.
   *
   * A copy this page wrote is recognized first, by its exact text (`recallOwnCopy`): the words it
   * stood for and the paths behind its chips come back as they were, so a cut or a copied message
   * pastes back as the same sentence with the same files — including the case a clipboard reports as
   * text alone, where the mention lines used to land in the box as prose.
   */
  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const data = event.clipboardData;
    if (data === null) return;
    const files = Array.from(data.files);
    const pasted = data.getData("text/plain");
    // Our own copy, when the clipboard still holds it (`recallOwnCopy`): its words and the paths
    // behind its chips come back as they were — including the case a clipboard reports as text
    // alone, which used to paste the mention lines as prose.
    const own = recallOwnCopy(pasted);
    // A clipboard this side has nothing to say about — words with no files, not one of its own
    // copies — is left to the browser's own paste, which already puts words at the caret.
    if (files.length === 0 && own === null && pasted.length === 0) return;
    event.preventDefault();
    // Where an import lands is where the caret is, and the import is a round trip: the anchor is
    // taken before anything is awaited.
    anchorRef.current = currentAnchor();
    if (files.length === 0) {
      applyPaste(planClipboardPaste(pasted, [], own), files);
      return;
    }
    void (async () => {
      // A clipboard holding `CF_HDROP` gives the page `Files` and no `text/plain` at all, so the
      // words are read back through the desktop (`recoverPastedText`) — which is why the decision is
      // made on the text that is *actually* there rather than on what the page could see.
      const text = pasted.length > 0 ? pasted : await recoverPastedText();
      applyPaste(planClipboardPaste(text, files, recallOwnCopy(text)), files);
    })();
  };

  /**
   * Put the selection's words *and* its files on the clipboard; the draft range it stood for.
   *
   * The words are read off the draft, not off the selection: what the browser puts on the clipboard
   * for a chip is its visible label, and a label pasted back into a composer is the file's name
   * written as prose — a second copy of the chip the engine then reads as something the reader
   * typed. The draft's own slice is the sentence without the labels, and the chips inside the slice
   * are the files that travel with it: as mention lines in the text (so a text editor learns their
   * addresses) and, where the platform publishes one, as a real file list on the clipboard.
   *
   * `null` is a selection with no file in it: the browser's own copy and cut are already right for
   * that, and they are left to run.
   */
  const writeSelection = (event: ClipboardEvent<HTMLDivElement>): DraftAnchor | null => {
    const root = rootRef.current;
    if (root === null) return null;
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;
    const selected = selectionRange(root);
    if (selected === null) return null;
    const sentence = draftRef.current.slice(selected.start, selected.end);
    const byToken = new Map(
      latest.current.attachments.map((attachment) => [attachment.token, attachment]),
    );
    const paths: string[] = [];
    for (const char of sentence) {
      const attachment = byToken.get(char);
      if (attachment !== undefined) paths.push(attachment.path);
    }
    if (paths.length === 0) return null;
    const words = draftProse(sentence);
    event.preventDefault();
    event.clipboardData?.setData("text/plain", textWithFileMentions(words, paths));
    // The event's own write is the text; the files can only go through the desktop, so the command
    // repeats the text beside them (one clipboard replace rather than two writes racing).
    void copyTextWithFiles(words, paths).catch(() => undefined);
    return selected;
  };

  /** A copy whose selection holds a chip copies the file as well as the words (`writeSelection`). */
  const handleCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    writeSelection(event);
  };

  /**
   * A cut is a copy that also takes the words out — with the same clipboard, file list included.
   *
   * Left to the browser, a cut writes only what is visible, so cutting a sentence with a file in it
   * would paste back as the file's *name* as prose (the report this fixes, alongside plain copy).
   * The removal is this field's own, in draft coordinates: one undo step, the chips the cut took go
   * with the characters (`onValueChange` → `pruneAttachments`), and the caret lands where the
   * sentence was.
   */
  const handleCut = (event: ClipboardEvent<HTMLDivElement>) => {
    const selected = writeSelection(event);
    if (selected === null) return;
    const draft = draftRef.current;
    rememberEdit(draft, selected.start, false);
    render(
      `${draft.slice(0, selected.start)}${draft.slice(selected.end)}`,
      selected.start,
    );
    latest.current.onDraftEdited();
    anchorRef.current = null;
    caretRef.current = selected.start;
    rootRef.current?.focus();
  };

  useImperativeHandle(
    ref,
    () => ({
      captureAnchor: () => {
        const root = rootRef.current;
        const selection = root === null ? null : selectionRange(root);
        const fallback = caretAnchor();
        const start = selection?.start ?? fallback.start;
        const end = selection?.end ?? fallback.end;
        anchorRef.current = { start, end };
        caretRef.current = end;
      },
      insertChips: (records) => {
        if (records.length === 0) return;
        const draft = draftRef.current;
        const anchor = anchorRef.current ?? caretAnchor();
        const at = Math.min(anchor.start, draft.length);
        const to = Math.min(Math.max(anchor.end, at), draft.length);
        const tokens = records.map((record) => record.token).join("");
        rememberEdit(draft, at, false);
        render(`${draft.slice(0, at)}${tokens}${draft.slice(to)}`, at + tokens.length, records);
        latest.current.onDraftEdited();
        anchorRef.current = null;
        caretRef.current = at + tokens.length;
        rootRef.current?.focus();
      },
      focus: () => rootRef.current?.focus(),
    }),
    [rememberEdit, render],
  );

  return (
    <>
      <div
        ref={rootRef}
        id={id}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        contentEditable={!disabled}
        suppressContentEditableWarning
        // The hint is drawn by the stylesheet from this attribute, and only while the box is empty. A
        // chip is content, so a prompt holding a file has something to send with no words in it.
        data-placeholder={value.trim() === "" ? (placeholder ?? "") : ""}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onKeyUp={rememberCaret}
        onMouseUp={rememberCaret}
        onFocus={rememberCaret}
        onPaste={handlePaste}
        onCopy={handleCopy}
        onCut={handleCut}
        onBlur={() => {
          rememberCaret();
          // Nothing is left in the box, so the browser's own leftover break goes with the focus:
          // keeping it would read back as a leading newline on the next keystroke.
          if (draftRef.current === "") rootRef.current?.replaceChildren();
        }}
        className={cn("omp-composer-field", className)}
        style={{
          // Two lines and no more, in the same line height the composer's fields have always used: the
          // box grows with the draft up to its limit and scrolls past it, so a long prompt cannot push
          // the conversation off the screen and a short one does not hide what is being written.
          minHeight: minRows * LINE_HEIGHT_PX,
          maxHeight: maxRows * LINE_HEIGHT_PX,
        }}
      />
      {/* What a chip holds, over the chip the pointer is on.
          The anchor is the chip element itself — a chip is built by this component's own editor, not
          rendered by React, so it is handed over rather than wrapped — and the card is only drawn
          once there is one to point at. The surface takes the pointer, which is what lets the reader
          move onto the picture: entering the card cancels the close the chip's leave asked for. */}
      <Tooltip
        anchorRef={hoverAnchor}
        open={hovered !== null}
        onOpenChange={(open) => {
          if (!open) closeCard();
        }}
        content={
          hovered === null ? null : (
            <span
              onPointerEnter={stopHoverTimer}
              onPointerLeave={closeCard}
              // The picture the pointer is already on is the one worth clicking: the same file the
              // chip opens, with the card folded away first.
              onClick={() => {
                closeCard();
                openAttachmentViewer(hovered);
              }}
            >
              <AttachmentPreviewCard attachment={hovered} />
            </span>
          )
        }
      />
    </>
  );
}

/** The tokens a draft names, in the order it names them. */
function namedTokens(draft: string, attachments: readonly ComposerAttachment[]): string[] {
  const byToken = new Set(attachments.map((attachment) => attachment.token));
  const tokens: string[] = [];
  for (const char of draft) {
    if (byToken.has(char)) tokens.push(char);
  }
  return tokens;
}

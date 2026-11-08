/**
 * The composer field's own undo history.
 *
 * The box is a `contenteditable` whose content this app writes by hand: a paste, an imported chip,
 * a chip's ✕ and an external paint all replace the box's nodes (`composer-field.tsx`), and every
 * such replacement resets Chromium's native undo stack. The reader's Ctrl+Z therefore cannot be the
 * browser's: the history has to be the app's, taken at the same moments the draft changes.
 *
 * A step is the whole draft, not a diff: the draft is one string and a few records, so an undo that
 * restores a chip has to restore the record behind it too (the ✕ takes both away).
 *
 * Typing is coalesced into a burst. Every keystroke is an edit, and a step per keystroke would make
 * Ctrl+Z walk back one character at a time — the browser's own behaviour is a run of typing. A burst
 * ends at a pause (`TYPE_PAUSE_MS`), after `TYPE_BURST_MS` of continuous typing, or at any edit that
 * is not typing (a paste, a chip, an external paint).
 */

import type { ComposerAttachment } from "@/state/composer-draft";

/** One place the draft has been: what to put back, and where the caret stood. */
export interface ComposerUndoStep {
  draft: string
  caret: number
  attachments: readonly ComposerAttachment[]
}

/**
 * Owned by one `ComposerField` instance; released with the component.
 *
 * Bounded in both directions — by `COMPOSER_UNDO_LIMIT` steps and by `COMPOSER_UNDO_CHARS`
 * characters of draft, whichever comes first. A prompt may be a pasted megabyte, so counting steps
 * alone would let a hundred of those stand in memory; the size drops the oldest steps instead. The
 * newest step is always kept, however large it is: an undo that could not put the current edit back
 * would be a control that does nothing.
 */
export interface ComposerUndoState {
  past: readonly ComposerUndoStep[]
  future: readonly ComposerUndoStep[]
  /** Characters of draft in `past`, kept so the size cap does not re-sum the steps per keystroke. */
  pastChars: number
  futureChars: number
  /** When the last edit happened, for the pause between bursts. */
  lastEditAt: number
  /** When the current typing burst began, so a long burst still breaks into steps. */
  burstStartedAt: number
}

export const COMPOSER_UNDO_LIMIT = 100

/** What both directions together may hold of draft text: about 8 MB of UTF-16. */
export const COMPOSER_UNDO_CHARS = 4_000_000

/** A pause this long ends a typing burst; the next keystroke is a step of its own. */
const TYPE_PAUSE_MS = 700

/** No burst runs longer than this, however uninterrupted the typing is. */
const TYPE_BURST_MS = 2000

export function emptyComposerUndo(): ComposerUndoState {
  return {
    past: [],
    future: [],
    pastChars: 0,
    futureChars: 0,
    lastEditAt: 0,
    burstStartedAt: 0,
  }
}

/**
 * One direction of the history with `step` on the end, dropping the oldest past either bound.
 *
 * The newest step survives even when it alone is past `COMPOSER_UNDO_CHARS`; the cap is about the
 * list's growth, not about refusing the draft the reader actually has.
 */
function withStep(
  steps: readonly ComposerUndoStep[],
  chars: number,
  step: ComposerUndoStep,
): { steps: ComposerUndoStep[]; chars: number } {
  const next = [...steps, step]
  let size = chars + step.draft.length
  let start = 0
  while (
    next.length - start > COMPOSER_UNDO_LIMIT ||
    (size > COMPOSER_UNDO_CHARS && next.length - start > 1)
  ) {
    size -= next[start]?.draft.length ?? 0
    start += 1
  }
  return { steps: start === 0 ? next : next.slice(start), chars: size }
}

/**
 * One edit just happened; `before` is the draft it replaced.
 *
 * `typing` says whether the edit was the reader typing (an `input` event that is not a programmatic
 * paint), which is the only kind that coalesces. A step that does coalesce keeps the state the burst
 * started from, so Ctrl+Z after a sentence puts back the sentence rather than its last letter.
 */
export function recordComposerEdit(
  state: ComposerUndoState,
  before: ComposerUndoStep,
  now: number,
  typing: boolean,
): ComposerUndoState {
  const inBurst =
    typing &&
    state.past.length > 0 &&
    now - state.lastEditAt < TYPE_PAUSE_MS &&
    now - state.burstStartedAt < TYPE_BURST_MS
  if (inBurst) {
    return { ...state, future: [], futureChars: 0, lastEditAt: now }
  }
  const past = withStep(state.past, state.pastChars, before)
  return {
    past: past.steps,
    future: [],
    pastChars: past.chars,
    futureChars: 0,
    lastEditAt: now,
    burstStartedAt: now,
  }
}

/** The step Ctrl+Z takes, and the state after taking it; null when there is nothing to undo. */
export function undoComposerEdit(
  state: ComposerUndoState,
  current: ComposerUndoStep,
): { state: ComposerUndoState; step: ComposerUndoStep } | null {
  const step = state.past[state.past.length - 1]
  if (step === undefined) return null
  const future = withStep(state.future, state.futureChars, current)
  return {
    step,
    state: {
      past: state.past.slice(0, -1),
      pastChars: state.pastChars - step.draft.length,
      future: future.steps,
      futureChars: future.chars,
      lastEditAt: 0,
      burstStartedAt: 0,
    },
  }
}

/** The step Ctrl+Shift+Z / Ctrl+Y takes; null after a fresh edit has cleared the future. */
export function redoComposerEdit(
  state: ComposerUndoState,
  current: ComposerUndoStep,
): { state: ComposerUndoState; step: ComposerUndoStep } | null {
  const step = state.future[state.future.length - 1]
  if (step === undefined) return null
  const past = withStep(state.past, state.pastChars, current)
  return {
    step,
    state: {
      past: past.steps,
      pastChars: past.chars,
      future: state.future.slice(0, -1),
      futureChars: state.futureChars - step.draft.length,
      lastEditAt: 0,
      burstStartedAt: 0,
    },
  }
}

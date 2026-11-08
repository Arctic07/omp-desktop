/**
 * The window's own file drop, as the desktop delivers it.
 *
 * A drag that starts outside the application is an *OS* drag, and on Windows the host owns those:
 * `dragDropEnabled` is set in the window config, which is what makes Tauri replace WebView2's own
 * drag-drop handler. The consequence is the one thing this module exists for — the page never sees
 * an HTML5 `drop` for such a drag, and the only channel that learns the dropped files' **absolute
 * paths** is `onDragDropEvent`. A DOM `drop` handler could only ever read the bytes of a `File` with
 * no path on it, which is not what a prompt needs: the engine reads a file mention from its path.
 *
 * The events come from the application's own target on Windows (`services::file_drop`), which
 * answers a drag from Explorer *and* one from a Chromium editor whose only trace of the file is the
 * path in `text/plain`; Tauri's own target knows only the first. Either way the event names and the
 * payload are Tauri's, so nothing below has to know which target answered.
 *
 * So this subscribes once for the window and hands each drag to whoever registered a target. The
 * target is the composer's own box, and a release anywhere else imports nothing — the same shape the
 * Vue front end settled on (`src/stores/desktopDropStore.ts` + `src/stores/composerDropStore.ts`),
 * where a whole-window drop hint was deliberately removed.
 *
 * A dialog's answer box is a second surface drawn above the field, and it registers as an overlay
 * instead of replacing the field's target: the pointer decides which one a release belongs to
 * (`targetAt`), because both are on screen while the dialog asks.
 */

import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview'

// Relative, with its extension: this module is read by the test runner as well as by the bundler,
// and the runner has no alias to resolve.
import { createStore } from './store.ts'

/** A drop point in CSS pixels, matching client coordinates inside the window. */
export interface DesktopDropPoint {
  x: number
  y: number
}

/**
 * One registered drop target: the box that accepts a release, and what to do with it.
 *
 * `contains` is asked on every move of the drag as well as on the release, because the surface that
 * accepts the drop is the surface that has to light up while the pointer is over it. `accept` is
 * handed the point the release happened at as well as the paths: a target that draws a face where
 * the pointer is may also want to place what it accepts there. The composer's field does not — a
 * file lands at the caret the reader left, not under a pointer that came in from another window.
 */
export interface DesktopDropTarget {
  contains: (point: DesktopDropPoint) => boolean
  accept: (paths: readonly string[], point: DesktopDropPoint) => void
}

export interface DesktopDropState {
  /** Whether an OS drag is in flight over the window. */
  dragging: boolean
  /** Where that drag's pointer is, in CSS pixels; null when nothing is in flight. */
  point: DesktopDropPoint | null
  /** Whether the pointer is inside the field's own target, which is what the field's drop face reads. */
  over: boolean
  /**
   * Whether the pointer is inside the overlay drawn above the field (a dialog's answer box).
   *
   * Kept beside `over` rather than folded into it: both surfaces are on screen at once, and each
   * draws its own drop face — a drag over the dialog must not light up the field it is stacked on.
   */
  overlayOver: boolean
}

const IDLE: DesktopDropState = { dragging: false, point: null, over: false, overlayOver: false }

export const desktopDropStore = createStore<DesktopDropState>(IDLE)

let target: DesktopDropTarget | null = null
let overlay: DesktopDropTarget | null = null
let release: (() => void) | null = null
let listening = false

/** The host reports physical pixels; the drop contract speaks the CSS pixels the page draws in. */
function cssPoint(position: { x: number; y: number }): DesktopDropPoint {
  const scale = window.devicePixelRatio === 0 ? 1 : window.devicePixelRatio
  return { x: position.x / scale, y: position.y / scale }
}

/**
 * The surface under one point: the overlay that is drawn above the field first, the field's own
 * target otherwise.
 *
 * Two surfaces can be on screen at once — the composer's field, and an engine dialog's answer field
 * stacked above it — and pointer position alone decides which one a release belongs to. Ordering by
 * position rather than by registration keeps that true however often either surface re-registers:
 * the composer re-registers whenever its import callback changes, and a registration order would
 * then move it above a dialog that is still drawn on top of it.
 */
function targetAt(point: DesktopDropPoint): DesktopDropTarget | null {
  if (overlay !== null && overlay.contains(point)) return overlay
  if (target !== null && target.contains(point)) return target
  return null
}

/** Which faces light up for one pointer position: one per registered surface, or neither. */
function facesAt(point: DesktopDropPoint): Pick<DesktopDropState, "over" | "overlayOver"> {
  return {
    over: target !== null && target.contains(point),
    overlayOver: overlay !== null && overlay.contains(point),
  }
}

/**
 * Offer a release to the surface under the pointer, and answer whether it was taken.
 *
 * Exported rather than private because it is the one seam a test can drive: an OS drag cannot be
 * staged from the page, so this is where "inside the accepting surface accepts, outside it refuses"
 * is checked.
 */
export function deliverDroppedPaths(paths: readonly string[], point: DesktopDropPoint): boolean {
  if (paths.length === 0) return false
  const taken = targetAt(point)
  if (taken === null) return false
  taken.accept(paths, point)
  return true
}

function handleDrag(payload: DragDropEvent): void {
  if (payload.type === 'leave') {
    desktopDropStore.set(IDLE)
    return
  }
  if (payload.type === 'enter' || payload.type === 'over') {
    const at = cssPoint(payload.position)
    desktopDropStore.set({ dragging: true, point: at, ...facesAt(at) })
    return
  }
  const at = cssPoint(payload.position)
  desktopDropStore.set(IDLE)
  deliverDroppedPaths(payload.paths, at)
}

/**
 * Subscribe to the host's drag-and-drop channel. The shell calls this once, on mount, and
 * `stopDesktopDrop` on unmount: the subscription belongs to the window, not to a component.
 */
export function startDesktopDrop(): void {
  if (listening) return
  listening = true
  // A preview outside the shell has no native channel, so a failure here is the absence of that
  // channel rather than a broken drop target.
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      handleDrag(event.payload)
    })
    .then((unlisten) => {
      release = unlisten
    })
    .catch(() => {
      release = null
    })
}

export function stopDesktopDrop(): void {
  listening = false
  release?.()
  release = null
  desktopDropStore.set(IDLE)
}

/**
 * Register the surface that accepts a drop, or clear it with `null`.
 *
 * The field's own target, and the only one without an overlay above it: there is one composer on
 * screen, and a target left behind by a surface that has gone would accept drops for a field nobody
 * can see.
 */
export function setDesktopDropTarget(next: DesktopDropTarget | null): void {
  target = next
  refreshOver()
}

/**
 * Register the surface drawn *above* the field — an engine dialog's answer box — or clear it.
 *
 * A dialog is stacked over the composer while it asks, so both surfaces are registered at once and
 * the pointer decides: a release inside the dialog's own box belongs to the dialog, and one below it
 * stays the field's (`targetAt`).
 */
export function setDesktopDropOverlay(next: DesktopDropTarget | null): void {
  overlay = next
  refreshOver()
}

/** Re-answer which faces light up after a registration changed, without disturbing the drag. */
function refreshOver(): void {
  const state = desktopDropStore.get()
  if (!state.dragging || state.point === null) return
  const faces = facesAt(state.point)
  if (faces.over === state.over && faces.overlayOver === state.overlayOver) return
  desktopDropStore.set({ ...state, ...faces })
}

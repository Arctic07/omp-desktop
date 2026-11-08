/**
 * The pointer drag from the file tree into the composer.
 *
 * A drag that starts inside the page cannot use HTML5 drag-and-drop here: the window has Tauri's
 * own file-drop channel enabled (`dragDropEnabled: true` in `tauri.conf.json`), which is what makes
 * a drop from Explorer or VS Code carry absolute paths — and on Windows that same switch keeps the
 * webview's HTML5 drop events out of the page. So the file row drives the gesture itself: a pointer
 * that moves past a few pixels becomes a drag, a window-level pointerup delivers the path to the
 * registered target, and the composer decides whether the release was inside its field.
 *
 * One target at a time, and the last registration wins — exactly the contract of
 * `state/desktop-drop.ts`. The file tree and the composer are the only two participants.
 */

// Relative, with its extension: this module is read by the test runner as well as by the bundler,
// and the runner has no alias to resolve (the same reason `state/desktop-drop.ts` does it).
import { createStore } from './store.ts'

export interface FileDragPoint {
  x: number
  y: number
}

export interface FileDragPayload {
  /** Absolute path, the same address the desktop's import command re-validates. */
  path: string
  /** The leaf, drawn on the ghost and used by the refusal message if the import fails. */
  name: string
}

export interface FileDragTarget {
  contains: (point: FileDragPoint) => boolean
  accept: (payload: FileDragPayload, point: FileDragPoint) => void
}

export interface FileDragState {
  drag: FileDragPayload | null
  point: FileDragPoint | null
  /** Whether the pointer is inside the field's own target, which is what the field's face reads. */
  over: boolean
  /** Whether it is inside the overlay drawn above the field — a dialog's answer box. */
  overlayOver: boolean
}

const IDLE: FileDragState = { drag: null, point: null, over: false, overlayOver: false }

export const fileDragStore = createStore<FileDragState>(IDLE)

let target: FileDragTarget | null = null
let overlay: FileDragTarget | null = null

/**
 * The surface under one point: the overlay drawn above the field first, the field's own target
 * otherwise — the same ordering the OS drop uses (`state/desktop-drop.ts::targetAt`), so a drag from
 * the file tree and a drag from Explorer land on the same surface.
 */
function targetAt(point: FileDragPoint): FileDragTarget | null {
  if (overlay !== null && overlay.contains(point)) return overlay
  if (target !== null && target.contains(point)) return target
  return null
}

/** Which faces light up for one pointer position: one per registered surface, or neither. */
function facesAt(point: FileDragPoint): Pick<FileDragState, "over" | "overlayOver"> {
  return {
    over: target !== null && target.contains(point),
    overlayOver: overlay !== null && overlay.contains(point),
  }
}

export function beginFileDrag(payload: FileDragPayload, point: FileDragPoint): void {
  fileDragStore.set({ drag: payload, point, ...facesAt(point) })
}

export function moveFileDrag(point: FileDragPoint): void {
  const state = fileDragStore.get()
  if (state.drag === null) return
  const faces = facesAt(point)
  if (
    faces.over === state.over &&
    faces.overlayOver === state.overlayOver &&
    state.point?.x === point.x &&
    state.point?.y === point.y
  ) {
    return
  }
  fileDragStore.set({ ...state, point, ...faces })
}

/** End the gesture; answers whether the release was taken by the surface under the pointer. */
export function finishFileDrag(point: FileDragPoint): boolean {
  const state = fileDragStore.get()
  fileDragStore.set(IDLE)
  if (state.drag === null) return false
  const taken = targetAt(point)
  if (taken === null) return false
  taken.accept(state.drag, point)
  return true
}

export function cancelFileDrag(): void {
  if (fileDragStore.get().drag === null) return
  fileDragStore.set(IDLE)
}

export function setFileDragTarget(next: FileDragTarget | null): void {
  target = next
  refreshFileDragOver()
}

/** Register the surface drawn above the field — a dialog's answer box — or clear it. */
export function setFileDragOverlay(next: FileDragTarget | null): void {
  overlay = next
  refreshFileDragOver()
}

function refreshFileDragOver(): void {
  const state = fileDragStore.get()
  if (state.drag === null || state.point === null) return
  const faces = facesAt(state.point)
  if (faces.over === state.over && faces.overlayOver === state.overlayOver) return
  fileDragStore.set({ ...state, ...faces })
}

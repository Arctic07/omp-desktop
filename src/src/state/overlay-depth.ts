/**
 * Whether a blocking surface (a menu, a dialog, the settings page) is above the document.
 *
 * The built-in browser's page is a native child webview: it always paints above HTML, so a menu or
 * a dialog cannot cover it the way it covers an iframe. The answer is to hide the guest while a
 * blocking overlay is open; this store is the shell's half of that answer.
 *
 * Two kinds of surface register, because "above the document" is not the same as "above the
 * browser". A full-window surface — settings, a dialog, a lightbox — registers with
 * `useBlockingOverlayWhile` and covers every rectangle. A popover registers the element it paints
 * into (`pushBlockingOverlayElement`), and only a rectangle that actually intersects that element
 * is covered: the File menu above the title bar and the context gauge's card above the composer
 * sit nowhere near the work panel's hole, and hiding the native guest for them was what blacked
 * the browser out whenever a menu opened.
 */

import { useEffect, useSyncExternalStore } from 'react'

/** A viewport rectangle, as `getBoundingClientRect` reports one. */
export interface OverlayRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Full-window surfaces: open while the count is above zero. */
let depth = 0
/** Element surfaces: the popover panels currently painted above the document. */
const surfaces = new Set<Element>()
/** Bumped on every change, so a panel can re-measure when the set changes. */
let revision = 0
const listeners = new Set<() => void>()

function emit(): void {
  revision += 1
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('an overlay-depth listener failed', error)
    }
  }
}

/** Register one full-window overlay; the returned release is idempotent. */
export function pushBlockingOverlay(): () => void {
  depth += 1
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    depth = Math.max(0, depth - 1)
    emit()
  }
}

/**
 * Register one popover panel by its element; the returned release is idempotent.
 *
 * The element's rectangle is read live, not cached: a popover is measured and placed a frame
 * after it mounts, and its portal moves with the window.
 */
export function pushBlockingOverlayElement(element: Element): () => void {
  surfaces.add(element)
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    surfaces.delete(element)
    emit()
  }
}

/** Whether any registered surface covers `rect` (a full-window one covers every rect). */
export function blockingOverlayCovers(rect: OverlayRect): boolean {
  if (depth > 0) return true
  for (const element of surfaces) {
    const surface = element.getBoundingClientRect()
    if (surface.width <= 0 || surface.height <= 0) continue
    if (
      surface.left < rect.right &&
      surface.right > rect.left &&
      surface.top < rect.bottom &&
      surface.bottom > rect.top
    ) {
      return true
    }
  }
  return false
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The overlay set as a React value: changes whenever a surface opens, closes or moves out. */
export function useBlockingOverlayRevision(): number {
  return useSyncExternalStore(subscribe, () => revision, () => revision)
}

/** Hold the counter for as long as `active` is true. */
export function useBlockingOverlayWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return
    return pushBlockingOverlay()
  }, [active])
}

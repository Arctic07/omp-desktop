/**
 * The card that follows the pointer while a file is dragged out of the tree.
 *
 * It is a portal to the document body because the right column is animated with a transform, and a
 * `position: fixed` child of a transformed ancestor is positioned against that ancestor instead of
 * the window. The ghost itself takes no pointer events — the pointer belongs to the gesture.
 */

import { createPortal } from 'react-dom'
import { File } from 'lucide-react'

import { useStoreSelector } from '@/state/store'
import { fileDragStore } from '@/state/file-drag-store'

export function FileDragGhost() {
  const name = useStoreSelector(fileDragStore, (state) => state.drag?.name ?? null)
  const point = useStoreSelector(fileDragStore, (state) => state.point)

  if (name === null || point === null) return null

  return createPortal(
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-50 flex max-w-64 items-center gap-1.5 rounded-lg border border-border bg-popover px-2 py-1.5 font-mono text-xs text-popover-foreground shadow-lg"
      style={{ left: point.x + 14, top: point.y + 12 }}
    >
      <File className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
    </div>,
    document.body,
  )
}

/**
 * A picture in the file preview, with a lightbox for its detail.
 *
 * The preview is a glance: a screenshot at panel width is a few hundred pixels, which is not enough
 * to read its text or tell two similar shots apart. Clicking it opens the file's own bytes at the
 * window's size; the zoom/pan gestures themselves are `react-zoom-pan-pinch` (wheel, drag, double
 * click, pinch), so this file only owns the app's chrome: the portal, the toolbar, focus return and
 * Escape.
 *
 * The lightbox is a portal because the preview lives inside a virtualized, transformed panel — a
 * fixed box drawn there would be positioned against the row it was drawn in.
 */

import { X, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchContentRef,
} from 'react-zoom-pan-pinch'

import { Button } from '@/components/motion/button'
import { FILE_PANEL_COPY } from '@/components/workspace/file-panel-copy'
import { useCopy } from '@/lib/i18n'

const MIN_SCALE = 1
const MAX_SCALE = 8
const BUTTON_STEP = 0.5

export interface ImageViewerProps {
  src: string
  alt: string
  /** The file's name, drawn over the lightbox and used as its accessible name. */
  label: string
}

export function ImageViewer({ src, alt, label }: ImageViewerProps) {
  const copy = useCopy(FILE_PANEL_COPY)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  return (
    <>
      <button
        type="button"
        aria-label={copy.zoomImage}
        title={copy.zoomImage}
        onClick={() => setOpen(true)}
        className="max-h-full max-w-full cursor-zoom-in rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img src={src} alt={alt} className="block max-h-full max-w-full object-contain" />
      </button>
      {open ? (
        <ImageLightbox src={src} alt={alt} label={label} onClose={close} />
      ) : null}
    </>
  )
}

function ImageLightbox({
  src,
  alt,
  label,
  onClose,
}: {
  src: string
  alt: string
  label: string
  onClose: () => void
}) {
  const copy = useCopy(FILE_PANEL_COPY)
  const controlsRef = useRef<ReactZoomPanPinchContentRef | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const [scale, setScale] = useState(MIN_SCALE)

  const zoomBy = useCallback((step: number) => {
    const controls = controlsRef.current
    if (controls === null) return
    void (step > 0 ? controls.zoomIn(step) : controls.zoomOut(-step))
  }, [])

  const reset = useCallback(() => {
    void controlsRef.current?.resetTransform(180)
  }, [])

  useEffect(() => {
    // The page kept the focus when the picture was asked for; dismissing puts it back there.
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => {
      if (before !== null && before.isConnected) before.focus()
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        zoomBy(BUTTON_STEP)
      } else if (event.key === '-') {
        event.preventDefault()
        zoomBy(-BUTTON_STEP)
      } else if (event.key === '0') {
        event.preventDefault()
        reset()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, zoomBy, reset])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-[10000] flex flex-col bg-background/90 backdrop-blur-sm"
    >
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-border/60 border-b px-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={label}>
          {label}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {Math.round(scale * 100)}%
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={copy.zoomOut}
          title={copy.zoomOut}
          onClick={() => zoomBy(-BUTTON_STEP)}
          disabled={scale <= MIN_SCALE}
          className="size-7 shrink-0 rounded-md"
        >
          <ZoomOut className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={copy.zoomIn}
          title={copy.zoomIn}
          onClick={() => zoomBy(BUTTON_STEP)}
          disabled={scale >= MAX_SCALE}
          className="size-7 shrink-0 rounded-md"
        >
          <ZoomIn className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={copy.zoomReset}
          title={copy.zoomReset}
          onClick={reset}
          disabled={scale === MIN_SCALE}
          className="size-7 shrink-0 rounded-md"
        >
          <span className="font-mono text-[10px] leading-none">1:1</span>
        </Button>
        <Button
          ref={closeRef}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={copy.zoomClose}
          title={copy.zoomClose}
          onClick={onClose}
          className="size-7 shrink-0 rounded-md"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <TransformWrapper
          ref={controlsRef}
          initialScale={MIN_SCALE}
          minScale={MIN_SCALE}
          maxScale={MAX_SCALE}
          centerOnInit
          limitToBounds
          wheel={{ step: 0.005 }}
          doubleClick={{ mode: 'toggle', step: 2 }}
          panning={{ velocityDisabled: true }}
          onTransform={(_ref, state) => setScale(state.scale)}
        >
          <TransformComponent
            wrapperStyle={{ width: '100%', height: '100%' }}
            contentStyle={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            contentProps={{
              onClick: (event) => {
                // The empty area around a fitted picture dismisses; once zoomed, a click is the
                // start of a pan and only the toolbar and Escape close.
                if (scale <= MIN_SCALE && event.target === event.currentTarget) onClose()
              },
            }}
          >
            <img
              src={src}
              alt={alt}
              draggable={false}
              className="max-h-full max-w-full origin-center select-none object-contain"
            />
          </TransformComponent>
        </TransformWrapper>
        <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-[11px] text-muted-foreground select-none">
          {copy.zoomHint}
        </p>
      </div>
    </div>,
    document.body,
  )
}

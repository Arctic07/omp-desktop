"use client";
// beui.dev/components/motion/image-viewer, adapted to the conversation's own pictures.

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ChatImage } from "@/api/session-types";
import { Button } from "@/components/motion/button";
import { COPY } from "@/home/homeCopy";
import { imageBox } from "@/home/image-box";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useBlockingOverlayWhile } from "@/state/overlay-depth";

export interface ConversationImagesProps {
  images: readonly ChatImage[];
  /** The gallery's own accessible name. */
  label: string;
  className?: string;
}

/**
 * The pictures one step produced, on screen whether the reader opened that step or not.
 *
 * A tool call folds — its arguments and its result are detail — but a picture is output: a browser
 * run's screenshot *is* what the call was for, and folding it put the one thing the row had to show
 * behind a click. So this surface is drawn outside the disclosure (`ToolResult`'s `afterHeader`),
 * and a call that produced pictures keeps its own row rather than joining a folded run.
 *
 * The grid is beUI's Image Viewer gallery (`grid-cols-2`, one `ImageViewerThumbnail` per picture)
 * with the difference the conversation needs: pictures here are screenshots of every shape, so a
 * cell holds the whole picture instead of cropping it to fill, and a single picture stands alone at
 * its own size. The viewer is the app's one-picture full-window reading (`home/AttachmentViewer.tsx`
 * has the same shape for a file): fit inside the window, arrows between the step's pictures, Esc or
 * a click outside to close. Zoom stays out of it deliberately — the project's zoomable lightbox is
 * `react-zoom-pan-pinch` in the file panel, and a second hand-written transform would be a second
 * body of math to keep right.
 */
export function ConversationImages({ images, label, className }: ConversationImagesProps) {
  const [open, setOpen] = useState<number | null>(null);
  useBlockingOverlayWhile(open !== null);
  const close = useCallback(() => setOpen(null), []);
  if (images.length === 0) return null;
  // A running call re-sends its pictures as the result grows; a viewer left on an index the newest
  // frame no longer has is a dialog with no picture to show, so it closes instead.
  const shown = open !== null && open < images.length ? open : null;
  const single = images.length === 1;
  return (
    <>
      <div
        role="group"
        aria-label={label}
        className={cn("grid min-w-0 gap-2", single ? "grid-cols-1" : "grid-cols-2", className)}
      >
        {images.map((image, index) => (
          <ImageThumbnail
            key={`${image.mimeType}-${image.bytes}-${index}`}
            image={image}
            index={index}
            total={images.length}
            single={single}
            onOpen={() => setOpen(index)}
          />
        ))}
      </div>
      <AnimatePresence>
        {shown === null ? null : (
          <ImageViewer
            images={images}
            index={shown}
            onIndex={setOpen}
            onClose={close}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function ImageThumbnail({
  image,
  index,
  total,
  single,
  onOpen,
}: {
  image: ChatImage
  index: number
  total: number
  single: boolean
  onOpen: () => void
}) {
  const copy = useCopy(COPY);
  /**
   * The box this picture takes, from its own header.
   *
   * An `<img>` with no size is zero high until its bytes arrive, so a row holding one grows by up to
   * the viewer's ceiling the moment it loads — under a reader who is scrolling, that is a layout
   * correction per picture, which is what a picture-heavy conversation felt like (2026-11-05). The
   * header carries the size, so the box is reserved before the picture is decoded; the classes below
   * still bound it (`max-w-full`, `max-h-[26rem]`), they only have a shape to bound now.
   */
  const box = imageBox(image);
  return (
    <button
      type="button"
      aria-label={copy.imageOpen(index + 1, total)}
      aria-haspopup="dialog"
      onClick={onOpen}
      className={cn(
        "group/image cursor-zoom-in overflow-hidden rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        single ? "w-fit max-w-full" : "aspect-[4/3] w-full border border-border bg-muted/40",
      )}
    >
      <img
        src={image.dataUrl}
        alt=""
        width={box?.width}
        height={box?.height}
        // A definite width and the picture's own ratio, not `auto`: an `auto` width inside a `w-fit`
        // button resolves against the picture's intrinsic size, which does not exist until the bytes
        // are decoded — so the box collapsed to nothing for the frames before the load and the row
        // grew when it landed. The ratio keeps the two `max-` classes honest: they bound a box that
        // already has the picture's shape, instead of letterboxing a fixed rectangle. A grid cell is
        // its own fixed shape, so it is left to its own classes.
        style={
          single && box !== null
            ? { width: box.width, aspectRatio: `${box.width} / ${box.height}` }
            : undefined
        }
        loading="lazy"
        decoding="async"
        draggable={false}
        className={cn(
          "block select-none",
          single
            ? "max-h-[26rem] max-w-full rounded-xl border border-border bg-muted/40 object-contain"
            : "size-full object-contain",
        )}
      />
    </button>
  );
}

/**
 * The step's pictures, one at a time, at the size the window allows.
 *
 * A portal because the transcript is a transformed, virtualized column: a fixed box drawn inside a
 * row would be positioned against that row.
 */
function ImageViewer({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: readonly ChatImage[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const copy = useCopy(COPY);
  const reduce = useReducedMotion() ?? false;
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const total = images.length;

  useEffect(() => {
    // What had the focus when the picture was asked for — the thumbnail. Dismissing puts it back
    // there, so a keyboard reader is where they left rather than on the document.
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      if (before !== null && before.isConnected) before.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (total < 2) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onIndex((index - 1 + total) % total);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onIndex((index + 1) % total);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, onClose, onIndex, total]);

  const image = images[index];
  if (image === undefined) return null;

  return createPortal(
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={copy.toolImages}
      className="fixed inset-0 z-[10000] flex flex-col bg-background/90 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0.12 : 0.16 }}
      onClick={onClose}
    >
      <div
        className="flex shrink-0 items-center gap-1.5 px-3 py-2"
        onClick={(event) => event.stopPropagation()}
      >
        <span
          aria-live="polite"
          className="font-mono text-[11px] tabular-nums text-muted-foreground"
        >
          {index + 1} / {total}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {total < 2 ? null : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={copy.imagePrevious}
                title={copy.imagePrevious}
                onClick={() => onIndex((index - 1 + total) % total)}
                className="size-8 shrink-0 rounded-md bg-card text-foreground hover:bg-muted"
              >
                <ChevronLeft aria-hidden="true" className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={copy.imageNext}
                title={copy.imageNext}
                onClick={() => onIndex((index + 1) % total)}
                className="size-8 shrink-0 rounded-md bg-card text-foreground hover:bg-muted"
              >
                <ChevronRight aria-hidden="true" className="size-4" />
              </Button>
            </>
          )}
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={copy.imageClose}
            title={copy.imageClose}
            onClick={onClose}
            className="size-8 shrink-0 rounded-md bg-card text-foreground hover:bg-muted"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 place-items-center p-4">
        <ImageSlide
          key={`${image.mimeType}-${image.bytes}-${index}`}
          image={image}
          reduce={reduce}
          failedText={copy.imageFailed}
        />
      </div>
    </motion.div>,
    document.body,
  );
}

/** One picture of the viewer, or the engine's picture failing to decode at all. */
function ImageSlide({
  image,
  reduce,
  failedText,
}: {
  image: ChatImage
  reduce: boolean
  failedText: string
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {failedText}
      </p>
    );
  }
  return (
    <motion.img
      src={image.dataUrl}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
      onClick={(event) => event.stopPropagation()}
      initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.99 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: reduce ? 0 : 0.16 }}
      className="max-h-[calc(100dvh-9rem)] max-w-[calc(100vw-3rem)] rounded-lg object-contain shadow-2xl"
    />
  );
}

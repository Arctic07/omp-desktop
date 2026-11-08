"use client";
// The picture a chip holds, at the size the window allows.

import { X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import type { ChatAttachmentRef } from "@/api/session-types";
import { Loader } from "@/components/motion/loader";
import { COPY } from "@/home/homeCopy";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { previewOf, type AttachmentPreview } from "@/state/attachment-preview";
import {
  attachmentPreviewStore,
  requestAttachmentPreview,
} from "@/state/attachment-preview-store";
import { attachmentViewerStore, closeAttachmentViewer } from "@/state/attachment-viewer-store";
import { useBlockingOverlayWhile } from "@/state/overlay-depth";
import { useStoreSelector } from "@/state/store";

/** The open attachment itself, so the selector answers a reference the state already holds. */
const selectAttachment = (state: ChatAttachmentRef | null): ChatAttachmentRef | null => state;

/**
 * The viewer, mounted once by the shell for either surface that can open it.
 *
 * A chip's hover card is a glance — 256 pixels, which is not enough to read a screenshot's text or
 * tell two similar pictures apart. This is the answer to that: the file's own bytes at the size the
 * window has, with the path under them, opened by a click on the chip (or on the picture the hover
 * card is already showing) and closed by Escape, a click outside the picture, or the ✕.
 *
 * It is a portal rather than a layer in either surface because the transcript is a transformed,
 * virtualized column and the composer's field is a `contenteditable` — a fixed box inside either
 * would be positioned against the row it was drawn in. The bytes are the chip cache's own
 * (`state/attachment-preview-store.ts`), so opening the viewer reads the file at most once per path.
 */
export function AttachmentViewer() {
  const attachment = useStoreSelector(attachmentViewerStore, selectAttachment);
  return createPortal(
    <AnimatePresence>
      {attachment === null ? null : (
        <AttachmentView key={attachment.path} attachment={attachment} />
      )}
    </AnimatePresence>,
    document.body,
  );
}

/**
 * One open picture.
 *
 * Keyed on the path by its parent, so it starts from its own state for every file: the read above
 * and the focus the close button takes are all that file's.
 */
function AttachmentView({ attachment }: { attachment: ChatAttachmentRef }) {
  useBlockingOverlayWhile(true);
  const copy = useCopy(COPY);
  const reduce = useReducedMotion() ?? false;
  const close = useRef<HTMLButtonElement | null>(null);

  const selectPreview = useCallback(
    (cache: ReadonlyMap<string, AttachmentPreview>) => previewOf(cache, attachment.path),
    [attachment.path],
  );
  const preview = useStoreSelector(attachmentPreviewStore, selectPreview);

  // A chip the pointer merely crossed has the picture already; one clicked straight from the field
  // does not. The read is the store's, once per path either way.
  useEffect(() => {
    requestAttachmentPreview(attachment.path);
  }, [attachment.path]);

  useEffect(() => {
    // What had the focus when the picture was asked for: the field the chip sits in, or the chip
    // itself on a sent message. Dismissing the viewer puts it back there, so a keyboard reader is
    // where they left rather than on the document.
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAttachmentViewer();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (before !== null && before.isConnected) before.focus();
    };
  }, []);

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={copy.attachmentView}
      className="fixed inset-0 z-[10000] grid place-items-center bg-background/85 p-6 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0.12 : 0.16 }}
      onClick={closeAttachmentViewer}
    >
      <motion.div
        className="flex max-h-full max-w-full min-w-0 flex-col items-center gap-2"
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.99 }}
        transition={{ duration: reduce ? 0.12 : 0.18 }}
        // A click on the picture itself is not a click outside it: only the scrim dismisses.
        onClick={(event) => event.stopPropagation()}
      >
        {preview === undefined ? (
          <Loader variant="spinner" size={28} label={copy.attachmentLoading} />
        ) : preview === null ? null : (
          <img
            src={preview}
            alt={attachment.name}
            className="max-h-[calc(100dvh-9rem)] max-w-[calc(100vw-3rem)] rounded-lg object-contain shadow-2xl"
          />
        )}
        {/* The file's own address: what the picture is, when the picture alone could be any of
            several, and the whole of the answer for a file the desktop refused to read. */}
        <span
          className={cn(
            "max-w-[calc(100vw-3rem)] truncate font-mono text-[11px] text-muted-foreground",
            preview === null && "break-all whitespace-normal text-foreground",
          )}
          title={attachment.path}
        >
          {attachment.path}
        </span>
      </motion.div>
      <button
        ref={close}
        type="button"
        aria-label={copy.attachmentClose}
        onClick={closeAttachmentViewer}
        className="absolute top-4 right-4 grid size-9 place-items-center rounded-full bg-card/90 text-muted-foreground shadow-lg outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </motion.div>
  );
}

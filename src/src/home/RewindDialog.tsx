import { X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/motion/button";
import { COPY } from "@/home/homeCopy";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useBlockingOverlayWhile } from "@/state/overlay-depth";

export interface RewindDialogProps {
  /** Whether a rewind is waiting for the reader's answer. */
  open: boolean;
  /** The rewind is in flight: the buttons stay up but refuse a second press. */
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The confirmation a rewind asks for, in beUI's own card, field and buttons.
 *
 * The gesture edits the conversation rather than the working tree, and that difference is the whole
 * reason it asks first: a reader who expects "undo" to put the files back would otherwise find out
 * afterwards. The sentence states both halves — what leaves the context, what does not come back —
 * so the answer is informed rather than just safe.
 *
 * Rendered in a portal because the transcript is a transformed, virtualized column: a fixed layer
 * inside it would be positioned against the row it was drawn in, not against the window.
 */
export function RewindDialog({ open, busy, onCancel, onConfirm }: RewindDialogProps) {
  useBlockingOverlayWhile(open);
  const copy = useCopy(COPY);
  const reduce = useReducedMotion() ?? false;
  // The confirm button takes focus when the dialog opens, so a keyboard reader answers at once.
  const confirm = useRef<HTMLButtonElement>(null);

  const dismiss = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);

  useEffect(() => {
    if (!open) return;
    confirm.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dismiss]);

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          key="rewind"
          className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0.12 : 0.16 }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) dismiss();
          }}
        >
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="omp-rewind-title"
            aria-describedby="omp-rewind-body"
            className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-xl"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 4 }}
            transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.7 }}
          >
            <div className="flex items-start justify-between gap-3 p-5 pb-3">
              <h2 id="omp-rewind-title" className="text-sm font-semibold">
                {copy.rewindTitle}
              </h2>
              <button
                type="button"
                aria-label={copy.cancel}
                onClick={dismiss}
                disabled={busy}
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  "disabled:pointer-events-none disabled:opacity-50",
                )}
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </div>
            <p id="omp-rewind-body" className="px-5 pb-5 text-xs leading-relaxed text-muted-foreground">
              {copy.rewindBody}
            </p>
            <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
              <Button variant="outline" size="sm" disabled={busy} onClick={dismiss}>
                {copy.cancel}
              </Button>
              <Button ref={confirm} size="sm" disabled={busy} onClick={onConfirm}>
                {copy.rewindConfirm}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

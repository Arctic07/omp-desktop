"use client";
// The answer field of a dialog: a prompt of the reader's own, with the files it carries.

import { FileText, Image, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, type ClipboardEvent } from "react";
import {
  attachmentFailure,
  selectDroppingOverOverlay,
  selectFileDroppingOverOverlay,
} from "@/home/composer-readings";
import { COPY } from "@/home/homeCopy";
import { recallOwnCopy } from "@/lib/clipboard";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AttachmentRefusal } from "@/state/composer-attachments";
import { chipLabel, planClipboardPaste, type ComposerAttachment } from "@/state/composer-draft";
import { desktopDropStore, setDesktopDropOverlay } from "@/state/desktop-drop";
import { fileDragStore, setFileDragOverlay } from "@/state/file-drag-store";
import { useStoreSelector } from "@/state/store";

/**
 * What a dialog asks for, as the box it is answered in.
 *
 * An engine dialog's answer is a prompt — `/goal` with no objective asks for the objective itself —
 * so the box is the composer's, not a one-line form field: two lines of text that wrap, and the
 * files the answer carries, whether they were pasted or dropped.
 *
 * The files are a strip under the text rather than characters inside it (the composer's chips sit in
 * a `contenteditable` sentence; a textarea holds text only). What they become is decided one level up
 * (`home/ConversationDialogs.tsx`): each one is written into the submitted answer as its `@<path>`
 * mention line, the shape the desktop's prompt path appends and the transcript reads back as a chip.
 */
export interface DialogAnswerFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  attachments: readonly ComposerAttachment[];
  onRemove: (token: string) => void;
  /** Absolute paths, from a drop or from the clipboard's file list. */
  onPaths: (paths: readonly string[]) => void;
  /** Bytes the clipboard held, with no path on them. */
  onFiles: (files: readonly File[]) => void;
  refusal: AttachmentRefusal | null;
}

/**
 * The answer field of a dialog whose answer is a credential.
 *
 * The engine marks such a dialog with `secret` (`ExtensionUIDialogOptions.secret`, a key that must
 * not be shown on screen), so the box is a single masked line instead of the prompt box: masking a
 * multi-line textarea is not possible, and a credential is one value rather than words with files
 * attached. The dialog's other text — title, and the line the caller wrote — is drawn above it by
 * the card, so nothing is lost by the narrower box.
 */
export interface SecretDialogAnswerFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}

export function SecretDialogAnswerField({
  value,
  onChange,
  placeholder,
}: SecretDialogAnswerFieldProps) {
  return (
    <input
      type="password"
      // The answer is a credential: no browser autofill, no spell check, no remembered value.
      autoComplete="off"
      spellCheck={false}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="block w-full rounded-xl bg-background/70 px-3 py-2.5 text-sm leading-5 text-foreground caret-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:bg-background focus-visible:ring-2 focus-visible:ring-ring/40"
    />
  );
}

export function DialogAnswerField({
  value,
  onChange,
  placeholder,
  attachments,
  onRemove,
  onPaths,
  onFiles,
  refusal,
}: DialogAnswerFieldProps) {
  const copy = useCopy(COPY);
  const boxRef = useRef<HTMLDivElement>(null);
  const dropping = useStoreSelector(desktopDropStore, selectDroppingOverOverlay);
  const fileDropping = useStoreSelector(fileDragStore, selectFileDroppingOverOverlay);
  const dropActive = dropping || fileDropping;

  // The handlers a drag or a paste reaches are read at the moment they fire: registering the target
  // once keeps both stores at their own answer, and the ref keeps the callbacks current.
  const latest = useRef({ onPaths, onFiles });
  useLayoutEffect(() => {
    latest.current = { onPaths, onFiles };
  }, [onFiles, onPaths]);

  useEffect(() => {
    const contains = (point: { x: number; y: number }) => {
      const box = boxRef.current?.getBoundingClientRect();
      if (box === undefined) return false;
      return (
        point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom
      );
    };
    const accept = (paths: readonly string[]) => latest.current.onPaths(paths);
    setDesktopDropOverlay({ contains, accept });
    setFileDragOverlay({
      contains,
      accept: (payload) => accept([payload.path]),
    });
    return () => {
      setDesktopDropOverlay(null);
      setFileDragOverlay(null);
    };
  }, []);

  /**
   * Words land where the caret is; files are handed up as the files they are.
   *
   * A clipboard holding both is read by the composer's own rule (`planClipboardPaste`): a copy this
   * application wrote comes back as its words plus the files it names, a browser snapshot is only its
   * words, and anything else is the files. The copy this page wrote is recognized by its exact text
   * (`recallOwnCopy`), which is also the only way a clipboard reports files and no text at all. The
   * words are written into the textarea at the caret by the browser's own range, so nothing about the
   * reader's selection is re-invented here.
   */
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const data = event.clipboardData;
      if (data === null) return;
      const files = Array.from(data.files);
      const pasted = data.getData("text/plain");
      const own = recallOwnCopy(pasted);
      if (files.length === 0 && own === null) return;
      event.preventDefault();
      const plan = planClipboardPaste(pasted, files, own);
      if (plan.words.length > 0) {
        const field = event.currentTarget;
        field.setRangeText(plan.words, field.selectionStart, field.selectionEnd, "end");
        onChange(field.value);
      }
      if (plan.paths.length > 0) latest.current.onPaths(plan.paths);
      if (plan.importFiles) latest.current.onFiles(files);
    },
    [onChange],
  );

  return (
    <div
      ref={boxRef}
      className={cn(
        "relative rounded-xl bg-background/70 transition-colors focus-within:bg-background",
        dropActive && "ring-2 ring-ring/40",
      )}
    >
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
          {attachments.map((attachment) => (
            <span key={attachment.token} className="omp-file-chip omp-file-chip-field" title={attachment.path}>
              {attachment.mimeType.startsWith("image/") ? (
                <Image aria-hidden="true" className="omp-file-chip-icon" />
              ) : (
                <FileText aria-hidden="true" className="omp-file-chip-icon" />
              )}
              {chipLabel(attachment.name)}
              <button
                type="button"
                aria-label={`${copy.attachmentRemove}: ${attachment.name}`}
                onClick={() => onRemove(attachment.token)}
                className="omp-file-chip-remove"
              >
                <X aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <textarea
        rows={2}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onPaste={handlePaste}
        // Exactly two lines: `rows` fixes the height, `resize-none` keeps the reader from dragging it
        // taller, and a longer answer wraps and scrolls inside the box instead of growing the dialog
        // over the composer it is asking about. A single-line input showed nothing of a wrapped
        // objective and could not hold a line break at all (2026-10-28, user report).
        className="block w-full resize-none overflow-y-auto bg-transparent px-3 py-2.5 text-sm leading-5 text-foreground caret-foreground outline-none placeholder:text-muted-foreground/60"
      />

      {refusal === null ? null : (
        <p className="px-3 pb-2 text-xs text-destructive">
          {attachmentFailure(refusal, copy).message}
        </p>
      )}

      {dropActive ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl border-2 border-border bg-field/95 text-xs text-muted-foreground">
          {copy.dropFiles}
        </div>
      ) : null}
    </div>
  );
}

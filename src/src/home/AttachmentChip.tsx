"use client";
// The attachment chip: one file a message carries, where the message's own words carry it.

import { FileText, Image } from "lucide-react";
import { AttachmentPreviewCard } from "@/components/agents/attachment-preview-card";
import { Tooltip } from "@/components/motion/tooltip";
import type { ChatAttachmentRef } from "@/api/session-types";
import { COPY } from "@/home/homeCopy";
import { useCopy } from "@/lib/i18n";
import { chipLabel } from "@/state/composer-draft";
import { openAttachmentViewer } from "@/state/attachment-viewer-store";
import { cn } from "@/lib/utils";

/**
 * One file a message carries: the file's own name, and the picture an image shows while the pointer
 * is over it.
 *
 * It is drawn *inside* the message's words, at the place the file stands in them, and it is the same
 * chip the composer's field draws a file as (`styles/file-chip.css`): what was sent reads as what was
 * written, with one box standing for one file in both. The ✕ the field's chips carry is the one
 * difference, and deliberately so — a draft can still lose a file, and a message that has gone
 * cannot, so a control that could take one back out of it would be a control that does nothing.
 *
 * The preview is a beUI tooltip with the picture in it. Its surface is hoverable, which is what a
 * preview needs — the pointer travels from the chip into the picture — and its content is the
 * desktop's own `read_external_file` answer, read once per path by `state/attachment-preview-store`
 * when the card mounts.
 *
 * An image's chip is also the way to see the image: a click on the chip, or on the picture the card
 * is already showing, opens the file at the size of the window (`home/AttachmentViewer.tsx`). The
 * card is a glance; the picture a screenshot carries is not readable in it.
 */
export interface AttachmentChipProps {
  attachment: ChatAttachmentRef;
  className?: string;
}

export function AttachmentChip({ attachment, className }: AttachmentChipProps) {
  const copy = useCopy(COPY);
  const image = attachment.mimeType.startsWith("image/");
  const Icon = image ? Image : FileText;

  const open = image ? () => openAttachmentViewer(attachment) : undefined;

  return (
    <Tooltip
      content={
        <span onClick={open}>
          <AttachmentPreviewCard attachment={attachment} />
        </span>
      }
    >
      <span
        className={cn(
          "omp-file-chip omp-file-chip-bubble",
          image && "omp-file-chip-openable",
          className,
        )}
        // The file a selection copy has to carry: the browser would write the label as text, and the
        // path is what turns that selection into the file itself (`ConversationFeed`'s copy handler).
        data-copy-file={attachment.path}
        role={image ? "button" : undefined}
        tabIndex={image ? 0 : undefined}
        onClick={open}
        onKeyDown={
          image
            ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                openAttachmentViewer(attachment);
              }
            : undefined
        }
        // A picture's chip says what a click does — the name alone would not tell a reader the
        // picture can be opened — and a file's keeps the address the message does not show.
        aria-label={
          image ? `${attachment.name} — ${copy.attachmentView}` : `${attachment.name} — ${attachment.path}`
        }
        title={attachment.path}
      >
        <Icon aria-hidden="true" className="omp-file-chip-icon" />
        {chipLabel(attachment.name)}
      </span>
    </Tooltip>
  );
}

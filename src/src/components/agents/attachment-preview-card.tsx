"use client";
// The picture a file shows while the pointer is over the chip that names it.

import { useCallback, useEffect } from "react";
import type { ChatAttachmentRef } from "@/api/session-types";
import { previewOf, type AttachmentPreview } from "@/state/attachment-preview";
import {
  attachmentPreviewStore,
  requestAttachmentPreview,
} from "@/state/attachment-preview-store";
import { useStoreSelector } from "@/state/store";

/**
 * What a chip's hover shows: the picture an image file holds, or where a file that has no picture
 * lives.
 *
 * It is mounted by the surface that opens on the pointer — the composer's chips
 * (`components/agents/composer-field.tsx`) and the chips a sent message carries
 * (`home/AttachmentChip.tsx`) — and mounting *is* the read: a preview is a file's own bytes, so
 * nothing is read for a chip the pointer never reached, and the answer lands in the one cache both
 * surfaces draw from (`state/attachment-preview-store`).
 *
 * A file the desktop will not read — one that has been swept out of the scratch store, a picture
 * whose format nothing here renders — answers with no picture, and the path stands in its place, so
 * a hover still says which file the chip names. The picture takes that place the moment it arrives.
 */
export function AttachmentPreviewCard({ attachment }: { attachment: ChatAttachmentRef }) {
  // An image is the one file with a picture to show, and the only one worth reading.
  const isImage = attachment.mimeType.startsWith("image/");
  const selectPreview = useCallback(
    (cache: ReadonlyMap<string, AttachmentPreview>) => previewOf(cache, attachment.path),
    [attachment.path],
  );
  const preview = useStoreSelector(attachmentPreviewStore, selectPreview);

  useEffect(() => {
    if (isImage) requestAttachmentPreview(attachment.path);
  }, [attachment.path, isImage]);

  if (preview) {
    return <img src={preview} alt={attachment.name} className="max-h-64 max-w-full rounded-lg" />;
  }
  return <span className="text-[11px] leading-4 break-all">{attachment.path}</span>;
}

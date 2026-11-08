/**
 * The prompts waiting behind the turn that is running.
 *
 * One row per message, oldest first: the wait a queued prompt is in, as the reader wrote it. The
 * files a row carries sit inside its words, where they stood in the sentence, because a queued
 * message is still the draft it was written as — the same reading the composer's field gives it, and
 * the same one it gets back once its turn comes (`state/composer-draft.ts::messageSegments`).
 *
 * The head row can also be interrupted into the conversation: the press ends the running turn and
 * that row goes out as the next one (`state/session-send.ts::interruptQueuedPrompt`). Only an
 * ending makes it a send — a steer would join the run and wait for a boundary, which is the reader
 * pressing a row and watching the same answer keep streaming. That verb belongs to the head alone:
 * interrupting for a row behind it would deliver the wrong order, and a turn — not a stop — has to
 * be running for it to mean anything, so it is drawn disabled with that said rather than taken away.
 */

import { useMemo } from "react";
import { ArrowUp, X } from "lucide-react";

import { AttachmentChip } from "@/home/AttachmentChip";
import { COPY } from "@/home/homeCopy";
import { messageSegments } from "@/state/composer-draft";
import type { QueuedPrompt } from "@/state/prompt-queue";
import { useCopy } from "@/lib/i18n";

export interface ComposerQueueProps {
  /** The conversation's waiting prompts, oldest first. */
  queued: readonly QueuedPrompt[];
  /** Whether there is a turn to end — nothing else can be paused for a row to go out. */
  running: boolean;
  onInterrupt: (id: number) => void;
  onRemove: (id: number) => void;
}

export function ComposerQueue({ queued, running, onInterrupt, onRemove }: ComposerQueueProps) {
  const copy = useCopy(COPY);
  if (queued.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border/60 bg-muted/40 px-3 py-2">
      <span className="text-[11px] leading-4 text-muted-foreground">
        {copy.queueTitle(queued.length)}
      </span>
      {queued.map((prompt, index) => (
        <QueuedRow
          key={prompt.id}
          prompt={prompt}
          head={index === 0}
          running={running}
          onInterrupt={onInterrupt}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

/**
 * One waiting message, read as the draft it was written as.
 *
 * The row holds the field's own reading of that draft (`messageSegments`): the reader's words with
 * each file standing where its character stands in the sentence, one chip per file, exactly the
 * bubble that message becomes once its turn comes. Drawing the files on a second line instead would
 * show a reader a message they did not write.
 *
 * A row is one line, cut with an ellipsis: a queue is read as what is waiting and where each row
 * stands, and a wrapped paragraph per message would push the head row — the one a press can send —
 * out of the panel. The words a cut hides stay at the pointer, in the row's own `title`.
 */
function QueuedRow({
  prompt,
  head,
  running,
  onInterrupt,
  onRemove,
}: {
  prompt: QueuedPrompt
  /** Whether this is the row an interrupt may take. */
  head: boolean
  running: boolean
  onInterrupt: (id: number) => void
  onRemove: (id: number) => void
}) {
  const copy = useCopy(COPY);
  // A queued message's files were paired by position when it was written (`QueuedPrompt.attachments`
  // is that draft's own file list), so the same positional pairing a sent message uses reads it back.
  const segments = useMemo(
    () => messageSegments(prompt.text, prompt.attachments),
    [prompt.text, prompt.attachments],
  );

  return (
    <span className="flex min-w-0 items-start gap-2">
      <span
        className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground/90"
        title={prompt.text}
      >
        {segments.map((segment, index) =>
          segment.attachment === null ? (
            <span key={index}>{segment.text}</span>
          ) : (
            <AttachmentChip
              key={`${index}-${segment.attachment.path}`}
              attachment={segment.attachment}
            />
          ),
        )}
      </span>
      {head ? (
        <button
          type="button"
          aria-label={copy.queueInterrupt}
          title={running ? copy.queueInterrupt : copy.queueInterruptUnavailable}
          disabled={!running}
          onClick={() => onInterrupt(prompt.id)}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <ArrowUp aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={copy.queueRemove}
        title={copy.queueRemove}
        onClick={() => onRemove(prompt.id)}
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </span>
  );
}

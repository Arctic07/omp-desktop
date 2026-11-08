import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { COPY } from "@/home/homeCopy";
import { copyTextWithFiles } from "@/lib/clipboard";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** How long the check stays up: long enough to be read, short enough not to claim the control. */
const COPIED_MS = 1000;

/** A message that carried no files keeps one empty list across renders. */
const NO_FILES: readonly string[] = [];

/**
 * The copy action of the transcript, wherever it stands.
 *
 * One control serves both places text is copied from — a message's own words, and the answer a turn
 * ended with — because the two are the same gesture and the reader should not have to learn two. It
 * writes *exactly* what it was handed, and says so with its own glyph: a swap to the check is the
 * whole confirmation, and a clipboard that refused (no API, no permission) is reported beside it
 * rather than swallowed, because a copy that silently did nothing is worse than one that failed.
 *
 * A message that carried files hands them over as well: the control copies the words *and* the
 * images and files behind its chips, so a message can be pasted back into another app as what it
 * actually was. A message with no files is the plain text copy it always was.
 */
export function CopyButton({
  text,
  files = NO_FILES,
  className,
}: {
  text: string
  /** The files this message carried, in the order it named them. */
  files?: readonly string[]
  className?: string
}) {
  const copy = useCopy(COPY);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    setCopied(false);
    setFailed(false);
    void copyTextWithFiles(text, files).then((ok) => {
      if (!ok) {
        setFailed(true);
        return;
      }
      setCopied(true);
      timer.current = window.setTimeout(() => {
        setCopied(false);
        timer.current = undefined;
      }, COPIED_MS);
    });
  }, [files, text]);

  const label = copied ? copy.copiedAction : copy.copyAction;

  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={onCopy}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {copied ? (
          <Check aria-hidden="true" className="size-3.5" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
      </button>
      {failed ? (
        <span role="alert" className="text-[11px] text-destructive">
          {copy.copyFailed}
        </span>
      ) : null}
    </>
  );
}

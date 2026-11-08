import { MessageSquareText } from "lucide-react";

import { Button } from "@/components/motion/button";
import { useCopy } from "@/lib/i18n";
import { COPY } from "@/home/homeCopy";

/**
 * A one-question dialog, compactly.
 *
 * The engine's `confirm` and `select` requests are a sentence and a short list of answers; the
 * approval card the tool prompts use draws a header, a status line and a submit row for a shape
 * that needs none of them, which is what left a two-option question in a mostly empty box. This
 * card is the same width and material as the composer, with the question as its first line and the
 * answers as the buttons that answer it.
 */
export interface ChoiceDialogProps {
  /** The dialog's own heading (for a select, the question the engine asked). */
  title: string;
  /** An optional second line; empty for a select, which carries its question in the title. */
  message?: string;
  /** The answers, in the engine's order. */
  options: readonly string[];
  /** A confirm's two answers arrive as one question with an approve/deny pair. */
  confirm?: boolean;
  onAnswer: (choice: string | boolean) => void;
  onCancel: () => void;
}

export function ChoiceDialog({ title, message, options, confirm, onAnswer, onCancel }: ChoiceDialogProps) {
  const copy = useCopy(COPY);
  const answers = confirm ? [copy.dialogApprove, copy.dialogDeny] : options;
  return (
    <section className="w-full overflow-hidden rounded-2xl border border-border/70 bg-pane">
      <div className="flex items-start gap-2.5 px-3.5 pt-3">
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground">
          <MessageSquareText aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="whitespace-pre-wrap break-words text-sm leading-5 text-foreground/90">{title}</p>
          {message === undefined ? null : (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
              {message}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-3.5 pt-2.5 pb-3">
        {answers.map((option, index) => (
          <Button
            key={option}
            type="button"
            variant={index === 0 ? "primary" : "outline"}
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => {
              if (confirm) onAnswer(index === 0 ? true : false);
              else onAnswer(option);
            }}
          >
            {option}
          </Button>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-8 px-2 text-xs text-muted-foreground"
          onClick={onCancel}
        >
          {copy.dialogCancel}
        </Button>
      </div>
    </section>
  );
}

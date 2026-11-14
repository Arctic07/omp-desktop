import { Check, MessageSquareText } from "lucide-react";

import { Button } from "@/components/motion/button";
import { useCopy } from "@/lib/i18n";
import { COPY } from "@/home/homeCopy";
import { cn } from "@/lib/utils";

/**
 * A one-question dialog, compactly.
 *
 * The engine's `confirm` and `select` requests are a sentence and a short list of answers; the
 * approval card the tool prompts use draws a header, a status line and a submit row for a shape
 * that needs none of them, which is what left a two-option question in a mostly empty box. This
 * card is the same width and material as the composer, with the question as its first line and the
 * answers as the buttons that answer it.
 *
 * A `select` carrying the engine's preselection facts draws them, because the answer depends on
 * them: a checkbox list is re-shown once per toggle by its caller, and the rows the engine marked
 * checked are the state that caller is about to read back. A marker therefore always means "this
 * row is the one currently chosen" - for a checkbox by membership in `checkedIndices`, for a radio
 * by being the row the engine's cursor sits on. Without the marker the same list read as a row of
 * plain buttons with no way to tell what was already selected.
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
  /** The row the engine wants focused first (`ExtensionUIDialogOptions.initialIndex`). */
  initialIndex?: number;
  /** `radio` or `checkbox`: the marker the engine draws beside each markable row. */
  selectionMarker?: "radio" | "checkbox";
  /** For `checkbox`, the rows already checked. */
  checkedIndices?: readonly number[];
  /** Leading rows that carry a marker; trailing ones are actions such as "Done". */
  markableCount?: number;
  onAnswer: (choice: string | boolean) => void;
  onCancel: () => void;
}

export function ChoiceDialog({
  title,
  message,
  options,
  confirm,
  initialIndex,
  selectionMarker,
  checkedIndices,
  markableCount,
  onAnswer,
  onCancel,
}: ChoiceDialogProps) {
  const copy = useCopy(COPY);
  const answers = confirm ? [copy.dialogApprove, copy.dialogDeny] : options;
  const checked = new Set(checkedIndices ?? []);
  // Every row is markable unless the engine named a shorter run: its trailing rows are the list's
  // own actions ("Done selecting"), and a marker beside them would misdescribe one as an answer.
  const markable = markableCount ?? answers.length;
  // The row the engine named, or `undefined` when it named none. The two facts it drives are kept
  // apart on purpose: the first row is drawn as the dialog's default answer either way, but focus
  // is only moved when the engine actually asked for a row - a `confirm` names none, and focusing
  // its approve button would put an Enter meant for the composer onto a tool call's approval.
  const cursor = initialIndex !== undefined && initialIndex < answers.length ? initialIndex : undefined;
  const isRadio = selectionMarker === "radio";
  /**
   * The marker shows whether this row is currently chosen, which is one question with two answers:
   * a `checkbox` list says so by membership in `checkedIndices`, a `radio` marker by being the row
   * the engine's cursor sits on (`initialIndex`) - the engine sends no `checkedIndices` with a
   * radio, and its own selector fills the cursor row (`pi-tui/overlays/hook-selector.ts`).
   */
  const chosen = (index: number): boolean => (isRadio ? index === (cursor ?? 0) : checked.has(index));
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
      <div
        className="flex flex-wrap items-center gap-1.5 px-3.5 pt-2.5 pb-3"
        {...(selectionMarker === undefined
          ? {}
          : { role: isRadio ? "radiogroup" : "group", "aria-label": title })}
      >
        {answers.map((option, index) => {
          const marked = selectionMarker !== undefined && index < markable;
          const selected = marked && chosen(index);
          return (
            <Button
              key={`${index}:${option}`}
              type="button"
              variant={index === (cursor ?? 0) ? "primary" : "outline"}
              size="sm"
              autoFocus={cursor !== undefined && index === cursor}
              className={cn("h-8 px-3 text-xs", selected && "ring-1 ring-ring")}
              aria-checked={marked ? selected : undefined}
              role={marked ? (isRadio ? "radio" : "checkbox") : undefined}
              onClick={() => {
                if (confirm) onAnswer(index === 0 ? true : false);
                else onAnswer(option);
              }}
            >
              {marked ? (
                // The marker's geometry is the design system's own control (`motion/radio`,
                // `motion/checkbox`): a 20px 2px-bordered disc or square that fills with the primary
                // colour when chosen. It is drawn inside the answer button rather than as a nested
                // `RadioGroupItem`, because a row here *is* the answer - pressing it submits - and a
                // nested button would be an invalid control inside a control.
                <span
                  aria-hidden="true"
                  className={cn(
                    "mr-2 grid size-5 shrink-0 place-items-center border-2",
                    isRadio ? "rounded-full" : "rounded-md",
                    selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-muted-foreground/50",
                  )}
                >
                  {selected ? (
                    isRadio ? (
                      <span className="size-2 rounded-full bg-primary-foreground" />
                    ) : (
                      <Check className="size-3" strokeWidth={3} />
                    )
                  ) : null}
                </span>
              ) : null}
              {option}
            </Button>
          );
        })}
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

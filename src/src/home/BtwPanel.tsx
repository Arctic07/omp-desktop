import { MessageSquareText } from "lucide-react";

import { Button } from "@/components/motion/button";
import { useCopy } from "@/lib/i18n";
import { COPY } from "@/home/homeCopy";
import { readModelReasoning } from "@/home/reasoning-echo";
import { stripModelTags } from "@/home/system-notice";
import type { BtwView } from "@/state/transcript";
import { sendPrompt } from "@/state/session-send";

/**
 * The side question, as the panel its tab opens onto.
 *
 * `/btw` is an aside: the answer never enters the transcript, so this panel is the only place it
 * is read. The shape is the other composer panels' (one header, rows at one height, an action row
 * at the foot), and the text wraps rather than scrolls sideways, so a narrow conversation column -
 * the work panel open beside it - is still readable.
 */
export function BtwPanel({ btw, onCollapse }: { btw: BtwView; onCollapse: () => void }) {
  const copy = useCopy(COPY);
  const running = btw.status === "running";
  // The aside is prose only — there is no reasoning block to fold into — so a model that thinks in
  // envelopes (`readModelReasoning`) is read as its answer, and as its thinking when it has said
  // nothing outside them. The wrappers a model puts around the answer itself (`stripModelTags`) are
  // markup as well: either way the brackets never reach the panel.
  const read = readModelReasoning(btw.answer, "");
  const shown = stripModelTags(read.answer.trim().length > 0 ? read.answer : read.reasoning);
  return (
    <section className="w-full overflow-hidden rounded-2xl border border-border/70">
      <button
        type="button"
        aria-expanded
        onClick={onCollapse}
        className="group flex h-11 w-full items-center gap-2.5 rounded-2xl px-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="grid size-6 shrink-0 place-items-center text-muted-foreground">
          <MessageSquareText aria-hidden="true" className="size-4" />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
          {btw.question || copy.btwTitle}
        </h3>
        <span className="shrink-0 text-xs text-muted-foreground">
          {running ? copy.btwRunning : copy.btwStatus(btw.status)}
        </span>
      </button>
      <div className="scrollbar-hide max-h-[220px] overflow-y-auto px-2 pb-3">
        <p className="whitespace-pre-wrap break-words px-1.5 py-1 text-sm leading-5 text-foreground/90">
          {shown.trim().length === 0 ? (
            <span className="text-muted-foreground">{running ? copy.btwWaiting : copy.btwEmpty}</span>
          ) : (
            shown
          )}
        </p>
        {btw.error === undefined ? null : (
          <p className="px-1.5 py-1 text-xs leading-5 text-rose-600 dark:text-rose-400">{btw.error}</p>
        )}
        <div className="flex flex-wrap items-center gap-1.5 px-1.5 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => void sendPrompt(running ? "/btw cancel" : "/btw clear")}
          >
            {running ? copy.btwCancel : copy.btwClose}
          </Button>
        </div>
      </div>
    </section>
  );
}

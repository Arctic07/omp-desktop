import { Bot, FileText, Repeat, Target } from "lucide-react";
import { Button } from "@/components/motion/button";
import { Tooltip } from "@/components/motion/tooltip";
import { useCopy } from "@/lib/i18n";
import { COPY } from "@/home/homeCopy";
import type { SessionModes } from "@/api/session-types";
import { toggleModeBlock, type ModeBlockKind } from "@/state/block-panel-store";

/**
 * The mode strip inside the composer's own control row.
 *
 * A mode is a fact about the conversation, not a tool, so it sits with the field rather than in the
 * title bar: a reader typing into a planning or directing conversation sees the mode where their
 * hands are, and can open its report without leaving the field. Each chip is beUI's small `Button`
 * — the same pill the block row above the field uses — and pressing one opens (or closes) that
 * mode's panel through the one store both surfaces read.
 */
export function ModeBar({ modes }: { modes: SessionModes }) {
  const copy = useCopy(COPY);
  const chips: Array<{ kind: ModeBlockKind; label: string; hint: string; icon: typeof Target }> = [];
  if (modes.goal !== undefined) {
    chips.push({ kind: "goal", label: copy.goalTitle, hint: copy.goalModeHint, icon: Target });
  }
  if (modes.plan !== undefined) {
    chips.push({ kind: "plan", label: copy.planModeTitle, hint: copy.planModeHint, icon: FileText });
  }
  if (modes.vibe !== undefined) {
    chips.push({
      kind: "vibe",
      label: copy.vibeTitle,
      hint: copy.vibeModeHint,
      icon: Bot,
    });
  }
  if (modes.loop !== undefined) {
    chips.push({ kind: "loop", label: copy.loopTitle, hint: copy.loopModeHint, icon: Repeat });
  }
  if (chips.length === 0) return null;
  return (
    <div role="group" aria-label={copy.modeStripLabel} className="flex min-w-0 shrink-0 items-center gap-1">
      {chips.map(({ kind, label, hint, icon: Icon }) => (
        <Tooltip key={kind} content={hint}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-label={hint}
            onClick={() => toggleModeBlock(kind)}
            className="h-7 gap-1 rounded-full px-2 text-[11px]"
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="max-w-24 truncate">{label}</span>
            {kind === "vibe" ? (
              <span className="shrink-0 tabular-nums text-muted-foreground/70">
                {modes.vibe?.workers.length ?? 0}
              </span>
            ) : null}
          </Button>
        </Tooltip>
      ))}
    </div>
  );
}

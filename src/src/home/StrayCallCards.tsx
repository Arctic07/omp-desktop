import { ToolResult, ToolResultOutput } from "@/components/agents/tool-result";
import { COPY } from "@/home/homeCopy";
import type { StrayCall } from "@/home/tool-call-markup";
import { useCopy } from "@/lib/i18n";

/**
 * The calls a step wrote as markup instead of answering, drawn as the calls they are.
 *
 * A model that falls back to the legacy spelling (`<Browser><action>screenshot</action></Browser>`)
 * wrote a call, not an answer, and the engine executed none of it. Drawn as text it is a wall of
 * brackets where a reply belongs; drawn through the tool card the transcript already uses, it reads
 * as the call the step aimed at, with its arguments one disclosure away and the row's own note
 * stating that nothing ran (`TurnEndingNote`).
 *
 * The card is the library's `ToolResult` rather than a second surface: a call the engine did not
 * execute is still a call, and the transcript's vocabulary for one is already settled.
 */

/** The argument fields worth putting on the card's title, in the order they are tried. */
const TITLE_KEYS = ["i", "intent", "description", "action", "command", "query", "path"] as const;

/** What the call was aimed at: its own intent or action, when it wrote one. */
function titleOf(call: StrayCall): string {
  for (const key of TITLE_KEYS) {
    const value = call.args[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  // No field the transcript knows: the first argument is still more than the tool's name twice.
  for (const value of Object.values(call.args)) {
    if (value.trim() !== "") return value.trim();
  }
  return call.name ?? "";
}

export function StrayCallCards({ calls }: { calls: readonly StrayCall[] }) {
  const copy = useCopy(COPY);
  // A fragment that lost its opener names no tool; the note under the row already states that, and
  // an unnamed card would be a blank frame over it.
  const named = calls.filter(
    (call): call is StrayCall & { name: string } => call.name !== null,
  );
  if (named.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {named.map((call, index) => {
        const args = call.args;
        const hasArgs = Object.keys(args).length > 0;
        return (
          <ToolResult
            // The name is not unique on its own: one step may write the same call twice.
            key={`${call.name}-${index}`}
            tool={call.name}
            title={titleOf(call)}
            status="error"
            kind="custom"
            meta={<span>{copy.strayCallNotRun}</span>}
            defaultOpen={false}
            collapseOnComplete={false}
            className="min-w-0"
          >
            <div className="flex min-w-0 flex-col gap-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {copy.strayCallBody}
              </p>
              {hasArgs ? (
                <section className="flex min-w-0 flex-col gap-1.5">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    {copy.toolArgs}
                  </h4>
                  <ToolResultOutput language="json">
                    {JSON.stringify(args, null, 2)}
                  </ToolResultOutput>
                </section>
              ) : null}
            </div>
          </ToolResult>
        );
      })}
    </div>
  );
}

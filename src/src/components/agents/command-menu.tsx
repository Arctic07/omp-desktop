"use client";
// beui.dev/components/motion/combobox — its list, label, row and empty row, adapted to a palette
// that rides on the composer's own field instead of a trigger of its own.

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import type { EngineCommand } from "@/api/session-types";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

/**
 * The commands a slash opens, drawn above the field that is asking for one.
 *
 * It is a list, not a second input: the query is the draft itself, so the field keeps the caret and
 * the list only answers Up/Down/Enter through the composer (`PromptInput`). Rows never take focus —
 * a pointer press is cancelled before the field could lose it — and the words of every row come
 * straight from the engine's advertisement, which is the only owner of which commands exist.
 */
export interface CommandMenuProps {
  commands: readonly EngineCommand[];
  /** Which row Up/Down has landed on, as an index into `commands`. */
  activeIndex: number;
  onActiveChange: (index: number) => void;
  onSelect: (command: EngineCommand) => void;
  /** The list's accessible name, and the heading over its rows. */
  label: string;
  /** What the menu calls a command the engine registered from a skill. */
  skillLabel: string;
  className?: string;
}

export function CommandMenu({
  commands,
  activeIndex,
  onActiveChange,
  onSelect,
  label,
  skillLabel,
  className,
}: CommandMenuProps) {
  const reduce = useReducedMotion() ?? false;
  const listRef = useRef<HTMLDivElement>(null);

  // The row the keyboard landed on has to be readable: a list taller than its box would otherwise
  // keep the selection past its edge while the reader arrows through it.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, commands]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={reduce ? { duration: 0 } : { duration: 0.16, ease: EASE_OUT }}
      className={cn(
        "absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-lg",
        className,
      )}
    >
      <span className="block border-b border-border/60 px-3 py-1.5 text-[11px] leading-4 font-medium text-muted-foreground">
        {label}
      </span>
      <div role="listbox" aria-label={label} ref={listRef} className="max-h-64 overflow-y-auto p-1.5 scrollbar-hide">
        {commands.map((command, index) => {
          const active = index === activeIndex;
          return (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={active}
              data-active={active}
              // The field keeps the caret: a focusable row would take it on press, and the reader
              // would be typing into the list instead of the prompt.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onActiveChange(index)}
              onClick={() => onSelect(command)}
              className={cn(
                "flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors",
                active ? "bg-muted" : "hover:bg-muted/60",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate font-mono text-[12px] leading-5 text-foreground">
                    /{command.name}
                  </span>
                  {command.source === "skill" ? (
                    <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
                      {skillLabel}
                    </span>
                  ) : null}
                  {command.inputHint ? (
                    <span className="ml-auto shrink-0 truncate pl-2 text-[11px] leading-4 text-muted-foreground/80">
                      {command.inputHint}
                    </span>
                  ) : null}
                </span>
                {command.description ? (
                  <span className="mt-0.5 block truncate text-xs leading-4 text-muted-foreground">
                    {command.description}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}

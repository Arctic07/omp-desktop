"use client";

import { AlertTriangle, ChevronDown } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";

import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { Markdown } from "@/components/agents/markdown";
import type { ReminderMessage } from "@/home/conversation-rows";
import { parseReminder } from "@/home/reminder";
import { SPRING_SWAP } from "@/lib/ease";
import { useCopy, type Localized } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * One rule check the harness fired on a tool call, drawn where it happened.
 *
 * The engine writes it into a **developer** message — context for the model — and that message is
 * also the only place the reader can see why the call beside it was refused or altered. Everything
 * here is the transcript's own row vocabulary rather than a new surface: the same 16px glyph column
 * and `h-7` line as a folded call or a reasoning row, the same muted ink, the same fold
 * (`AgentDisclosure`, behind the same left rule). One line until the reader opens it, so a turn that
 * trips three rules is three annotations rather than three cards.
 */

interface ReminderCopy {
  /** What the row is called before it names the rule that fired. */
  label: string
  /** How a run of the same reminder reads: twice, three times. */
  times: (count: number) => string
  /** The row's accessible name when the tag carried no rule of its own. */
  unnamed: string
}

const COPY: Localized<ReminderCopy> = {
  en: {
    label: "Rule reminder",
    times: (count) => `×${count}`,
    unnamed: "Rule reminder",
  },
  zh: {
    label: "规则提醒",
    times: (count) => `×${count}`,
    unnamed: "规则提醒",
  },
};

export interface ReminderRowProps {
  /** The row's id, which is what the reader's open/closed decision is remembered under. */
  rowId: string
  /** The run of reminders this row draws, folded by `buildRows`: one rule, one or more firings. */
  reminders: readonly ReminderMessage[]
  /** The reader's own decision for this row, or null while they have not made one. */
  chosen: boolean | null
  onDisclosureChange: (id: string, open: boolean) => void
  className?: string
}

export function ReminderRow({
  rowId,
  reminders,
  chosen,
  onDisclosureChange,
  className,
}: ReminderRowProps) {
  const copy = useCopy(COPY);
  const reduce = useReducedMotion() ?? false;
  // Folded until the reader opens it: the rule's name is the fact they need, and the rule's own
  // sentence is what they came for when they do.
  const open = chosen ?? false;
  const parsed = useMemo(() => reminders.map((reminder) => parseReminder(reminder.text)), [reminders]);
  const rule = parsed[0]?.rule ?? null;
  // One paragraph per firing, without repeating a rule body the harness wrote twice unchanged.
  const body = [...new Set(parsed.map((candidate) => candidate?.text ?? ""))].filter(
    (text) => text !== "",
  ).join("\n\n");

  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={rule === null ? copy.unnamed : `${copy.label}: ${rule}`}
        onClick={() => onDisclosureChange(rowId, !open)}
        className="flex h-7 w-fit min-w-0 items-center gap-2 rounded-lg pr-1.5 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{copy.label}</span>
        {rule === null ? null : (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/55">
            {rule}
          </span>
        )}
        {reminders.length > 1 ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
            {copy.times(reminders.length)}
          </span>
        ) : null}
        <motion.span
          aria-hidden="true"
          animate={{ rotate: open ? 0 : -90 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="inline-flex shrink-0 text-muted-foreground"
        >
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>
      <AgentDisclosure open={open}>
        <div className="mt-1 break-words border-border border-l pl-3">
          <Markdown text={body} className="text-xs leading-relaxed text-muted-foreground" />
        </div>
      </AgentDisclosure>
    </div>
  );
}

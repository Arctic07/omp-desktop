"use client";
// The mark a conversation row carries, in one place: the left rail draws it on its rows
// (`ai-sidebar-row.tsx`) and the vibe roster draws it on its workers (`home/mode-panels.tsx`), so
// "running / unread / cancelled / pending / error" cannot become two vocabularies with two glyphs.
//
// `running` is the beUI spinner, not a lucide `LoaderCircle`: the rail's own rule (src/AGENTS.md)
// is that every in-flight glyph is this ring, on the one shared clock `loader.tsx` keeps, so a
// column of them turns together instead of each spinning from its own mount.

import { Circle, CircleAlert, CircleDashed, CircleSlash } from "lucide-react";
import { Loader } from "@/components/motion/loader";
import { cn } from "@/lib/utils";

/**
 * What a status mark says about a row.
 *
 * `completed` is a settled row and carries no mark at all — the rail draws nothing there rather
 * than a tick on every finished conversation; `unread` is a result the reader has not looked at,
 * `cancelled` and `pending` an ending that stopped or never arrived, and `error` one that failed.
 */
export type ConversationStatus =
  | "running"
  | "completed"
  | "unread"
  | "cancelled"
  | "pending"
  | "error";

export interface StatusMarkProps {
  status: ConversationStatus | undefined;
  /** Classes for the caller's own slot: the mark itself is always 14px. */
  className?: string;
}

/** One row's mark, sized for the rail's 14px status slot, in the colour that state reads as. */
export function StatusMark({ status, className }: StatusMarkProps) {
  switch (status) {
    case "running":
      return (
        <span
          aria-hidden="true"
          className={cn("flex size-3.5 items-center justify-center", className)}
        >
          <Loader variant="spinner" size={14} speed={1.1} className="text-[var(--omp-running)]" />
        </span>
      );
    case "unread":
      return (
        <Circle aria-hidden="true" className={cn("size-3.5 text-emerald-500", className)} />
      );
    case "cancelled":
      return (
        <CircleSlash aria-hidden="true" className={cn("size-3.5 text-amber-500", className)} />
      );
    case "pending":
      return (
        <CircleDashed aria-hidden="true" className={cn("size-3.5 text-amber-500", className)} />
      );
    case "error":
      return (
        <CircleAlert aria-hidden="true" className={cn("size-3.5 text-destructive", className)} />
      );
    default:
      return null;
  }
}

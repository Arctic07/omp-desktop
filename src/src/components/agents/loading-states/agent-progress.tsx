"use client";
// beui.dev/components/agents/loading-states

import { useEffect, useState } from "react";
import { Loader } from "@/components/motion/loader";
import { cn } from "@/lib/utils";

export interface AgentProgressProps {
  /** Verb describing the agent's current activity. */
  label?: string;
  /** Controlled elapsed time in seconds. */
  elapsedSeconds?: number;
  /** Starting time for the internal timer, in seconds. */
  initialSeconds?: number;
  /** Whether the internal timer should advance. Ignored when elapsedSeconds is provided. */
  running?: boolean;
  className?: string;
}

function formatElapsed(totalSeconds: number) {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = (safeSeconds % 60).toFixed(1);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function AgentProgress({
  label = "Churning",
  elapsedSeconds,
  initialSeconds = 0,
  running = true,
  className,
}: AgentProgressProps) {
  const [internalSeconds, setInternalSeconds] = useState(initialSeconds);

  useEffect(() => {
    if (elapsedSeconds !== undefined || !running) return;

    const startedAt = performance.now() - initialSeconds * 1000;
    const timer = window.setInterval(() => {
      setInternalSeconds((performance.now() - startedAt) / 1000);
    }, 100);

    return () => window.clearInterval(timer);
  }, [elapsedSeconds, initialSeconds, running]);

  const elapsed = elapsedSeconds ?? internalSeconds;

  return (
    <span
      role="status"
      // The registry appends ", in progress" to the verb. This app's verb is already the whole
      // reading — `工作中…`, `Working…` — and an English suffix would be the one string in the
      // announcement its reader did not choose.
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-3 font-mono text-sm text-muted-foreground",
        className,
      )}
    >
      {/* The glyph is beUI's helix loader, drawn on its side — the turn and why is written in
          `components/motion/loader.tsx`. It is hidden from screen readers and painted in the
          row's own ink: the `aria-label` above is already the verb, and a second `role="status"`
          inside this one would say the row is working twice. */}
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center"
      >
        <Loader size={20} variant="helix" className="text-current" />
      </span>
      <span className="font-sans font-medium">{label}</span>
      <span
        aria-hidden="true"
        className="tabular-nums text-muted-foreground/70"
      >
        {formatElapsed(elapsed)}
      </span>
    </span>
  );
}

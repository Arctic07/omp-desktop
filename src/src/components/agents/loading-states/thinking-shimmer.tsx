import type { ReactNode } from "react";
import { TextShimmer } from "@/components/motion/text-shimmer";
import { useCopy, type Localized } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface ThinkingShimmerCopy {
  /** The message shown while the agent is thinking. */
  thinking: string;
}

const COPY: Localized<ThinkingShimmerCopy> = {
  en: { thinking: "Thinking…" },
  zh: { thinking: "思考中…" },
};

export interface ThinkingShimmerProps {
  /** Loading message shown to the user. */
  children?: ReactNode;
  /** Seconds taken for one shimmer pass. */
  duration?: number;
  className?: string;
}

export function ThinkingShimmer({
  children,
  duration = 1.8,
  className,
}: ThinkingShimmerProps) {
  const copy = useCopy(COPY);

  return (
    <TextShimmer
      as="span"
      duration={duration}
      className={cn("font-medium", className)}
    >
      {children === undefined ? copy.thinking : children}
    </TextShimmer>
  );
}

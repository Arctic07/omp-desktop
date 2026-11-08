import type { ReactNode } from "react";

export type AgentActivityStatus = "working" | "complete";
export type AgentStepStatus = "pending" | "active" | "complete";

export interface AgentActivityStep {
  id: string;
  type: "step";
  label: ReactNode;
  status?: AgentStepStatus;
  meta?: ReactNode;
}

export interface AgentActivityText {
  id: string;
  type: "text";
  content: ReactNode;
}

export interface AgentSearchResult {
  id: string;
  title: ReactNode;
  domain?: ReactNode;
  url?: string;
  /** The page's own excerpt, when the search reported one. */
  snippet?: ReactNode;
  icon?: ReactNode;
}

export interface AgentActivitySearch {
  id: string;
  type: "search";
  query: ReactNode;
  /**
   * The provider's own answer to the query, as markdown, when it wrote one.
   *
   * LLM-mediated search providers (xAI, Anthropic, Perplexity) return prose beside their sources;
   * a pure search engine returns only the source list. When it is here it leads the row, because it
   * is what the reader came for, and the sources follow as the evidence under it.
   */
  answer?: string;
  results?: AgentSearchResult[];
  moreCount?: number;
}

export interface AgentActivityTool {
  id: string;
  type: "tool";
  action: "read" | "edit" | "run" | (string & {});
  target: ReactNode;
  additions?: number;
  deletions?: number;
}

export type AgentTraceKind =
  | "thinking"
  | "message"
  | "write"
  | "run"
  | "read"
  | (string & {});

/**
 * The status a trace row draws in place of its kind glyph.
 *
 * A `task` call's children are a roster of runs, not a list of things the parent did: the mark is
 * what says whether that child is working, finished or failed, and the kind glyph only fills in
 * when nothing states a status. The word is carried beside it for a reader who cannot see it.
 */
export type AgentTraceMark = "running" | "done" | "idle" | "failed";

export interface AgentActivityTrace {
  id: string;
  type: "trace";
  kind: AgentTraceKind;
  label: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  mark?: AgentTraceMark;
  markLabel?: string;
}

export type AgentActivityItem =
  | AgentActivityStep
  | AgentActivityText
  | AgentActivitySearch
  | AgentActivityTool
  | AgentActivityTrace;

export type AgentActivityContentType = AgentActivityItem["type"] | "mixed";

export interface AgentActivityProps {
  /** Chronological activity entries. Append or update items as events stream. */
  items: AgentActivityItem[];
  /** Expected activity kind before the first streamed item arrives. */
  contentType?: AgentActivityContentType;
  /** Current run phase. Active runs always stay expanded. */
  status?: AgentActivityStatus;
  /** Elapsed run time, in seconds. Used by the step-only summary. */
  duration?: number;
  /** Controlled expanded state used after the run completes. */
  open?: boolean;
  /** Initial expanded state used after the run completes. */
  defaultOpen?: boolean;
  /** Called when the completed activity disclosure changes state. */
  onOpenChange?: (open: boolean) => void;
  /** Collapse the disclosure when status changes from working to complete. */
  collapseOnComplete?: boolean;
  /** Optional label shown while the run is active. */
  activeLabel?: ReactNode;
  /** Optional completed summary. Derived from the item types by default. */
  summary?: ReactNode;
  /** Optional renderer for the contents of the active status row. */
  renderWorkingStatus?: (context: {
    label: ReactNode;
    duration: number;
  }) => ReactNode;
  /** Optional renderer for the contents before the built-in disclosure chevron. */
  renderCompletedStatus?: (context: {
    summary: ReactNode;
    duration: number;
  }) => ReactNode;
  /** Maximum visible activity height before the stream begins gliding. */
  maxHeight?: number;
  /**
   * Called when the reader picks one item.
   *
   * Only a trace row is selectable, and only when a handler is given: the item it stands for is
   * openable in this app (a `task` call's child has a conversation of its own), and a row that opens
   * nothing stays the plain line it is.
   */
  onItemSelect?: (item: AgentActivityItem) => void;
  className?: string;
  contentClassName?: string;
}

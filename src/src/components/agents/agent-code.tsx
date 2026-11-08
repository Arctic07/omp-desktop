"use client";

import {
  type CSSProperties,
  Fragment,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

import {
  acquireCodeHighlightSlot,
  cancelCodeHighlightRequest,
  releaseCodeHighlightSlot,
  requestCodeHighlight,
} from "@/components/agents/code-highlight-client";
import type {
  AgentCodeLanguage,
  AgentCodeToken,
  AgentCodeTokenLines,
} from "@/components/agents/code-language";

export type { AgentCodeLanguage, AgentCodeToken, AgentCodeTokenLines };

export interface AgentCodeProps {
  code: string;
  language?: AgentCodeLanguage;
  className?: string;
}

export interface AgentCodeLineProps {
  code: string;
  tokens?: AgentCodeToken[];
  className?: string;
}

/**
 * The longest input this hook will ask the worker to tokenize.
 *
 * A tool row is highlighted twice — once for its arguments and once for its result — and the
 * result of a streamed call is a new string on every update frame. Past this bound the row is
 * drawn as plain text rather than tokenized: a hundred-kilobyte result would otherwise become tens
 * of thousands of spans in one row. The text itself is still shown whole.
 *
 * The worker in `code-highlight.worker.ts` owns the grammar table, the token cache and the actual
 * tokenizing, so this file holds no syntax-highlighting runtime at all.
 */
const HIGHLIGHT_MAX_CHARS = 24 * 1024;

interface CodeResult {
  code: string;
  language: AgentCodeLanguage;
  lines: AgentCodeTokenLines;
}

export function useAgentCodeTokens(
  code: string,
  language: AgentCodeLanguage,
  /** The longest input this caller is willing to tokenize; see `HIGHLIGHT_MAX_CHARS`. */
  maxChars = HIGHLIGHT_MAX_CHARS,
) {
  const slotRef = useRef<symbol | null>(null);
  const [result, setResult] = useState<CodeResult | null>(null);

  useEffect(() => {
    if (slotRef.current === null) slotRef.current = acquireCodeHighlightSlot();
    const slot = slotRef.current;
    return () => {
      releaseCodeHighlightSlot(slot);
      if (slotRef.current === slot) slotRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Effect order guarantees the slot's own effect ran first; the fallback covers a strict-mode
    // remount whose first cleanup already released the previous slot.
    const slot = slotRef.current ?? acquireCodeHighlightSlot();
    slotRef.current = slot;
    if (language === "text" || code.length > maxChars) {
      cancelCodeHighlightRequest(slot);
      setResult(null);
      return () => cancelCodeHighlightRequest(slot);
    }
    requestCodeHighlight(slot, { code, language, maxChars }, (lines) => {
      setResult(lines === null ? null : { code, language, lines });
    });
    return () => cancelCodeHighlightRequest(slot);
  }, [code, language, maxChars]);

  // `text` never tokenizes, and a file past the bound is deliberately plain.
  if (language === "text" || code.length > maxChars) return null;
  if (result?.code === code && result.language === language) return result.lines;
  // A streamed row grows in place: the previous token lines still describe its prefix, so they
  // are drawn until the worker answers for the longer string.
  if (result?.language === language && code.startsWith(result.code)) {
    return result.lines;
  }
  return null;
}

export function AgentCodeLine({
  code,
  tokens,
  className,
}: AgentCodeLineProps) {
  return (
    <span className={className}>
      {tokens
        ? tokens.map((token) => (
            <span
              key={`${token.offset}-${token.content}`}
              style={
                {
                  "--agent-code-light": token.light ?? "currentColor",
                  "--agent-code-dark": token.dark ?? token.light ?? "currentColor",
                } as CSSProperties
              }
              className="text-[var(--agent-code-light)] dark:text-[var(--agent-code-dark)]"
            >
              {token.content}
            </span>
          ))
        : code}
    </span>
  );
}

export function AgentCode({
  code,
  language = "shellscript",
  className,
}: AgentCodeProps) {
  const tokens = useAgentCodeTokens(code, language);
  let offset = 0;
  const lines = code.split("\n").map((content) => {
    const line = { content, offset };
    offset += content.length + 1;
    return line;
  });

  return (
    <pre
      className={cn(
        "m-0 overflow-x-auto whitespace-pre font-mono text-xs leading-5 text-foreground/85",
        className,
      )}
    >
      <code>
        {lines.map((line, index) => (
          <Fragment key={line.offset}>
            <AgentCodeLine code={line.content} tokens={tokens?.[index]} />
            {index < lines.length - 1 ? "\n" : null}
          </Fragment>
        ))}
      </code>
    </pre>
  );
}

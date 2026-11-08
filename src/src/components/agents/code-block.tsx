"use client";
// beui.dev/components/agents/chat-app

import { Check, Copy, FileCode2, LoaderCircle } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type AgentCodeLanguage,
  AgentCodeLine,
  useAgentCodeTokens,
} from "@/components/agents/agent-code";
import { PluginCodeBlock } from "@/components/plugins/plugin-slot";
import { SPRING_PRESS } from "@/lib/ease";
import { useCopy, type Localized } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The code block's own wording: its streaming state and its copy control. */
interface CodeBlockCopy {
  writing: string
  ready: string
  copyCode: string
  copied: string
}

const COPY: Localized<CodeBlockCopy> = {
  en: {
    writing: "Writing",
    ready: "Ready",
    copyCode: "Copy code",
    copied: "Copied",
  },
  zh: {
    writing: "生成中",
    ready: "就绪",
    copyCode: "复制代码",
    copied: "已复制",
  },
};

export type CodeBlockStatus = "streaming" | "complete";

export interface CodeBlockProps {
  code: string;
  language?: AgentCodeLanguage;
  /**
   * What the header states the block is, when the language alone does not say it.
   *
   * A markdown fence is the reason this exists: its tag is the model's own word (`js`, `mermaid`,
   * or nothing at all), and the header should repeat that word rather than the grammar the tag was
   * resolved to. An empty string draws no label — a fence opened with nothing after the backticks
   * has no name to state. A tag written `<pluginId>:<lang>` also names a plugin's own renderer for
   * that block (`components/plugins/plugin-slot.tsx`): the plugin draws the block instead, and the
   * default card is what a tag no plugin answers keeps.
   */
  languageLabel?: string;
  filename?: ReactNode;
  status?: CodeBlockStatus;
  showLineNumbers?: boolean;
  highlightLines?: number[];
  maxHeight?: number;
  copyable?: boolean;
  onCopy?: () => void | Promise<void>;
  className?: string;
}

/**
 * The code block, or the plugin renderer that owns this fence's tag.
 *
 * A fence tagged `<pluginId>:<lang>` is a plugin's to draw when that plugin registered a renderer
 * for `<lang>`; everything else is this component's own card. The branch happens here rather than in
 * the Markdown renderer because this is already the one component every fence becomes.
 */
export function CodeBlock(props: CodeBlockProps) {
  const tag = props.languageLabel ?? "";
  if (!tag.includes(":")) return <CodeBlockSurface {...props} />;
  return (
    <PluginCodeBlock
      tag={tag}
      source={props.code}
      streaming={props.status === "streaming"}
      fallback={<CodeBlockSurface {...props} />}
    />
  );
}

function CodeBlockSurface({
  code,
  language = "typescript",
  languageLabel,
  filename,
  status = "complete",
  showLineNumbers = true,
  highlightLines = [],
  maxHeight = 280,
  copyable = true,
  onCopy,
  className,
}: CodeBlockProps) {
  const copy = useCopy(COPY);
  const reduce = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const streaming = status === "streaming";
  const tokens = useAgentCodeTokens(code, language);
  const highlighted = useMemo(
    () => new Set(highlightLines),
    [highlightLines],
  );
  let offset = 0;
  const lines = code.split("\n").map((content) => {
    const line = { content, offset };
    offset += content.length + 1;
    return line;
  });
  // `undefined` is "state the language", which is the caller that named a grammar directly; a
  // caller that passes a label owns it, including the empty one that draws nothing.
  const tag = languageLabel === undefined ? language : languageLabel;

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !streaming) return;

    const frame = requestAnimationFrame(() => {
      if (viewport.scrollHeight <= viewport.clientHeight) return;
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: reduce ? "auto" : "smooth",
        });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  });

  const handleCopy = useCallback(async () => {
    if (onCopy) await onCopy();
    else await navigator.clipboard?.writeText(code);

    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }, [code, onCopy]);

  return (
    <div
      data-state={status}
      aria-busy={streaming}
      className={cn(
        "w-full overflow-hidden rounded-2xl bg-muted/80 text-sm",
        className,
      )}
    >
      <div className="flex h-10 items-center gap-2.5 px-3">
        <FileCode2
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground/70"
        />
        {filename ? (
          <span className="min-w-0 truncate font-mono text-xs text-foreground/80">
            {filename}
          </span>
        ) : null}
        {tag ? (
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/55">
            {tag}
          </span>
        ) : null}
        <span
          className={cn(
            "ml-auto inline-flex shrink-0 items-center gap-1 text-[10px] font-medium",
            streaming
              ? "text-blue-600 dark:text-blue-400"
              : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {streaming ? (
            <LoaderCircle className={cn("size-3", !reduce && "animate-spin")} />
          ) : (
            <Check className="size-3" />
          )}
          {streaming ? copy.writing : copy.ready}
        </span>
        {copyable || onCopy ? (
          <motion.button
            type="button"
            aria-label={copied ? copy.copied : copy.copyCode}
            title={copied ? copy.copied : copy.copyCode}
            onClick={handleCopy}
            whileTap={reduce ? undefined : { scale: 0.9 }}
            transition={SPRING_PRESS}
            className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </motion.button>
        ) : null}
      </div>

      <div
        ref={viewportRef}
        role={streaming ? "log" : undefined}
        aria-live={streaming ? "polite" : undefined}
        className="scrollbar-hide overflow-auto border-t border-foreground/[0.06] py-2"
        style={{ maxHeight }}
      >
        <pre className="m-0 w-full font-mono text-xs leading-5 text-foreground/85">
          <code>
            {lines.map((line, index) => {
              const lineNumber = index + 1;
              return (
                <span
                  key={line.offset}
                  className={cn(
                    "grid min-h-5",
                    showLineNumbers
                      ? "grid-cols-[2.75rem_minmax(0,1fr)]"
                      : "grid-cols-1",
                    highlighted.has(lineNumber) && "bg-blue-500/[0.07]",
                  )}
                >
                  {showLineNumbers ? (
                    <span className="select-none pr-3 text-right tabular-nums text-muted-foreground/35">
                      {lineNumber}
                    </span>
                  ) : null}
                  <AgentCodeLine
                    code={line.content}
                    tokens={tokens?.[index]}
                    className={cn(
                      "pr-4 whitespace-pre-wrap break-words",
                      showLineNumbers ? "pl-1" : "pl-4",
                    )}
                  />
                </span>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
}

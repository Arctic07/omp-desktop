"use client";
// beui.dev/components/agents/chat-app (the composer's context gauge)

import { useRef, useState } from "react";

import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import type { ContextCategories } from "@/api/session-types";
import { useCopy, type Localized } from "@/lib/i18n";
import { formatTokenCount } from "@/lib/tokens";

/**
 * The composer's context gauge: how much of the model's window this conversation is holding, and
 * what it is holding it in.
 *
 * Every figure is the engine's own. The occupancy and the window come from its context breakdown,
 * the split from the same reading, and the cache rate from the totals it keeps for the session —
 * this draws them and states the two shares in words, and derives nothing. A conversation whose
 * window the host has not reported has no share to draw, so the card states the used count alone
 * rather than over a denominator nobody gave.
 */

interface ContextGaugeCopy {
  /** The gauge's own name: the share of the window in use. */
  usage: (percent: number) => string
  /** What is used, and — when the window is known — of what. */
  total: (used: string, window: string) => string
  /** The same figure over a window nothing stated: the used count stands alone. */
  used: (used: string) => string
  percent: (percent: string) => string
  autoCompact: (percent: string, tokens: string) => string
  autoCompactOff: string
  categorySystemPrompt: string
  categorySystemTools: string
  categorySystemContext: string
  categorySkills: string
  categoryMessages: string
  cacheRate: (percent: string) => string
}

const COPY: Localized<ContextGaugeCopy> = {
  en: {
    usage: (percent) => `Context used: ${percent}%`,
    total: (used, window) => `${used} / ${window} tok`,
    used: (used) => `${used} tok`,
    percent: (percent) => `${percent}% of the context window`,
    autoCompact: (percent, tokens) => `Compacts at about ${percent}% (≈${tokens} tok)`,
    autoCompactOff: "Auto-compaction is off",
    categorySystemPrompt: "System prompt",
    categorySystemTools: "Tool definitions",
    categorySystemContext: "System context",
    categorySkills: "Skills",
    categoryMessages: "Conversation",
    cacheRate: (percent) => `Cache hit rate ${percent}%`,
  },
  zh: {
    usage: (percent) => `上下文用量 ${percent}%`,
    total: (used, window) => `${used} / ${window} tok`,
    used: (used) => `${used} tok`,
    percent: (percent) => `占上下文窗口 ${percent}%`,
    autoCompact: (percent, tokens) => `约 ${percent}% 时自动压缩（≈${tokens} tok）`,
    autoCompactOff: "自动压缩已关闭",
    categorySystemPrompt: "系统提示词",
    categorySystemTools: "工具定义",
    categorySystemContext: "系统上下文",
    categorySkills: "技能",
    categoryMessages: "对话消息",
    cacheRate: (percent) => `缓存命中率 ${percent}%`,
  },
};

/**
 * What the gauge reads, as the engine reported it.
 *
 * `anchored` is the engine's own statement that the occupancy stands on usage a provider actually
 * sent; when it is false the figure is its own tokenizer estimate of what the next request would
 * carry, and the card marks it rather than presenting an estimate as a reading.
 */
export interface ContextGaugeUsage {
  usedTokens: number
  /** The window the tokens sit in; `0` when the host reported none. */
  windowTokens: number
  anchored: boolean
  /** The engine's split of the occupancy, or null when the host cannot report one. */
  categories: ContextCategories | null
  /**
   * Where the engine would compact this conversation — `null` when it will not, `undefined` when
   * the host never stated a boundary. The two are different facts and are worded differently.
   */
  autoCompactPercent?: number | null
  /** This session's cumulative prompt traffic, which is what the cache rate divides. */
  usage: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
}

/** One line of the legend: the engine's category, under this app's word for it. */
interface ContextRow {
  key: keyof ContextCategories
  label: string
  tokens: number
  /** One hue per category, in the engine's own order. */
  dot: string
}

const ROW_HUE: Readonly<Record<keyof ContextCategories, string>> = {
  systemPrompt: "bg-muted-foreground",
  systemTools: "bg-orange-400",
  systemContext: "bg-emerald-500",
  skills: "bg-slate-300",
  messages: "bg-blue-500",
}

/** The ring's geometry: one 20-unit viewBox, so the arc is a fraction of a circle by construction. */
const RING_RADIUS = 8
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** The engine's own order, with a category it reports as empty left out. */
function contextRows(copy: ContextGaugeCopy, tokens: ContextCategories | null): ContextRow[] {
  if (tokens === null) return []
  const rows: ContextRow[] = [
    { key: "systemPrompt", label: copy.categorySystemPrompt, tokens: tokens.systemPrompt, dot: ROW_HUE.systemPrompt },
    { key: "systemTools", label: copy.categorySystemTools, tokens: tokens.systemTools, dot: ROW_HUE.systemTools },
    { key: "systemContext", label: copy.categorySystemContext, tokens: tokens.systemContext, dot: ROW_HUE.systemContext },
    { key: "skills", label: copy.categorySkills, tokens: tokens.skills, dot: ROW_HUE.skills },
    { key: "messages", label: copy.categoryMessages, tokens: tokens.messages, dot: ROW_HUE.messages },
  ]
  return rows.filter((row) => row.tokens > 0)
}

/**
 * The session's cache hit rate: of the prompt tokens the provider billed for, the share it served
 * from its cache rather than reading fresh.
 *
 * The denominator is the whole prompt — fresh input, cache reads **and** cache writes: a write
 * happens because that prefix was *not* in the cache, so a rate that leaves writes out reports a
 * higher hit share than the provider served (100k written against 10k read is 10%, not 100%).
 * Nothing is stated until something was actually served from cache: a session with no hit has no
 * rate to report, and `0%` would read as a measurement where there is none.
 */
function cacheRate(usage: ContextGaugeUsage["usage"]): number | null {
  if (usage.cacheReadTokens <= 0) return null
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  if (prompt <= 0) return null
  return Math.round((usage.cacheReadTokens / prompt) * 100)
}

export interface ContextGaugeProps {
  /** The engine's accounting, or null before a conversation has reported one. */
  usage: ContextGaugeUsage | null
  className?: string
}

export function ContextGauge({ usage, className }: ContextGaugeProps) {
  const copy = useCopy(COPY);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);

  const openCard = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const closeCard = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 100);
  };

  const usedTokens = usage?.usedTokens ?? 0;
  const windowTokens = usage?.windowTokens ?? 0;
  const anchored = usage?.anchored ?? true;
  // The mark an estimate wears, or nothing when the number is a measurement.
  const estimate = anchored ? "" : "≈";
  const share =
    windowTokens > 0 ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : null;
  const percent = share === null ? null : `${estimate}${share}`;
  const used = `${estimate}${formatTokenCount(usedTokens)}`;
  const usageLabel =
    windowTokens > 0 ? copy.total(used, formatTokenCount(windowTokens)) : copy.used(used);
  const rows = contextRows(copy, usage?.categories ?? null);

  /**
   * The gauge's third line: where the engine would compact this conversation, or that it will not.
   * An absent boundary — a host that never sent one — leaves the line out rather than claiming a
   * switch state nothing stated.
   */
  const auto = usage?.autoCompactPercent;
  const autoLabel =
    auto === undefined
      ? ""
      : auto === null || !Number.isFinite(auto)
        ? copy.autoCompactOff
        : copy.autoCompact(String(Math.round(auto)), formatTokenCount(Math.round((windowTokens * auto) / 100)));

  const rate = usage === null ? null : cacheRate(usage.usage);
  const cacheLabel = rate === null ? "" : copy.cacheRate(String(rate));

  // One list, so the sentence a screen reader reads and the lines a pointer reveals cannot say
  // different things. An empty phrase is dropped — a row with no words would be a divider for
  // nothing.
  const label = [
    percent === null ? "" : copy.percent(percent),
    usageLabel,
    ...rows.map((row) => `${row.label} ≈${formatTokenCount(row.tokens)}`),
    autoLabel,
    cacheLabel,
  ]
    .filter((line) => line.length > 0)
    .join(" · ");

  // The ring is a stroke over a circle, so its length *is* the share: the dash is the whole
  // circumference and the offset is what is left of it. A ring whose arc only rotated — which is
  // what a pair of transparent borders gives — drew the same quarter turn at 2% and at 50%, and the
  // reader had no way to tell an almost empty context from a half-full one.
  const filled = Math.min(Math.max(share ?? 0, 0), 100) / 100;

  return (
    <MorphPopover open={open} onOpenChange={setOpen} className={className}>
      <div onMouseEnter={openCard} onMouseLeave={closeCard}>
        <MorphPopoverTrigger>
          <button
            type="button"
            aria-label={label.length > 0 ? label : copy.usage(0)}
            className="grid size-8 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {/* Twelve o'clock is where the arc starts, so it reads as a gauge rather than as a
                decoration that happens to have a gap in it. */}
            <svg aria-hidden="true" viewBox="0 0 20 20" className="size-[18px] -rotate-90">
              <circle
                cx="10"
                cy="10"
                r={RING_RADIUS}
                fill="none"
                strokeWidth="2"
                className="stroke-muted"
              />
              <circle
                cx="10"
                cy="10"
                r={RING_RADIUS}
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={RING_CIRCUMFERENCE * (1 - filled)}
                className="stroke-primary transition-[stroke-dashoffset] duration-150 ease-out"
              />
            </svg>
          </button>
        </MorphPopoverTrigger>
        <MorphPopoverContent side="top" align="end" sideOffset={8} radius={12} className="w-72 p-3">
          <div onMouseEnter={openCard} onMouseLeave={closeCard}>
            <div className="flex items-center justify-between gap-4 text-xs">
              <span className="min-w-0 truncate text-muted-foreground">
                {percent === null ? "" : copy.percent(percent)}
              </span>
              <span className="shrink-0 font-medium tabular-nums text-foreground">{usageLabel}</span>
            </div>
            {share === null ? null : (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
              </div>
            )}
            {rows.length === 0 ? null : (
              <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                {rows.map((row) => (
                  <div key={row.key} className="flex items-center justify-between">
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden="true" className={`size-2 shrink-0 rounded-sm ${row.dot}`} />
                      <span className="min-w-0 truncate">{row.label}</span>
                    </span>
                    <span className="shrink-0 tabular-nums">≈{formatTokenCount(row.tokens)}</span>
                  </div>
                ))}
              </div>
            )}
            {autoLabel.length === 0 && cacheLabel.length === 0 ? null : (
              <div className="mt-3 border-t border-border/60 pt-2 text-xs text-muted-foreground">
                {autoLabel.length === 0 ? null : <div>{autoLabel}</div>}
                {cacheLabel.length === 0 ? null : <div className="mt-2">{cacheLabel}</div>}
              </div>
            )}
          </div>
        </MorphPopoverContent>
      </div>
    </MorphPopover>
  );
}

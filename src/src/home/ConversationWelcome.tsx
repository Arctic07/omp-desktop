"use client";

import { Bug, Compass, GitPullRequest, Puzzle, type LucideIcon } from "lucide-react";
import { motion, useReducedMotion, type Variants } from "motion/react";
import { useEffect, useState } from "react";
import { Card } from "@/components/motion/card";
import { EASE_OUT } from "@/lib/ease";
import { useCopy, type Localized } from "@/lib/i18n";
import { NEW_CHAT_STARTERS, greetingSlot, type GreetingSlot, type NewChatStarterId } from "@/home/new-chat";
import { prefillComposer } from "@/state/composer-prefill";

/**
 * The blank conversation's welcome: a greeting, and four ways to begin.
 *
 * It is the middle of the hero (`ConversationHero`), which owns the room above the composer. Nothing
 * here is engine state: the greeting is the reader's own clock (`home/new-chat.ts`) and the four
 * starters are this application's suggestions — not a skill the engine advertised, not a conversation
 * that exists, and not a claim about what the agent will do.
 *
 * Pressing a card writes its prompt into the composer and never sends it: the reader still writes the
 * sentence and still presses Enter, the way ZCode's own draft screen behaves.
 */
interface WelcomeCopy {
  /** One greeting per bucket of the day (`home/new-chat.ts::greetingSlot`). */
  greeting: Readonly<Record<GreetingSlot, string>>
  subtitle: string
  /** The four starters, in the order the grid draws them. */
  starters: Readonly<Record<NewChatStarterId, { label: string; hint: string; prompt: string }>>
  /** What the keys do, under the grid. */
  keys: string
  /** The grid's accessible name. */
  startersLabel: string
}

const COPY: Localized<WelcomeCopy> = {
  en: {
    greeting: {
      morning: "Good morning",
      afternoon: "Good afternoon",
      evening: "Good evening",
      night: "Working late",
    },
    subtitle: "Describe what you want done, or start from one of these.",
    starters: {
      explore: {
        label: "Read this project",
        hint: "Structure first, then what is worth reading",
        prompt:
          "Walk me through this project's structure: the main modules, the entry points, and how they fit together. Start with what is most worth reading.",
      },
      fix: {
        label: "Track down a bug",
        hint: "Describe the symptom and I will find the cause",
        prompt: "Help me find and fix a problem: ",
      },
      review: {
        label: "Review my changes",
        hint: "Risks, edge cases, anything simpler",
        prompt:
          "Review my current changes and point out risks, edge cases, and anything that could be simpler.",
      },
      plugin: {
        label: "Build a plugin",
        hint: "Theme, sidebar entry, or agent tool — it asks first",
        prompt: "/skill:plugin-creator I want to build a plugin: ",
      },
    },
    keys: "/ for commands · Enter to send · Shift+Enter for a new line",
    startersLabel: "Ways to begin",
  },
  zh: {
    greeting: {
      morning: "早上好",
      afternoon: "下午好",
      evening: "晚上好",
      night: "夜深了",
    },
    subtitle: "说说你想完成的事，或者从下面挑一个开始。",
    starters: {
      explore: {
        label: "读懂这个项目",
        hint: "先讲结构，再挑最值得读的地方",
        prompt:
          "先带我过一遍这个项目的结构：主要模块、入口，以及它们怎么协作。从最值得先读的地方开始。",
      },
      fix: {
        label: "排查一个问题",
        hint: "说出看到的现象，我来定位根因",
        prompt: "帮我定位并修复一个问题：",
      },
      review: {
        label: "评审当前改动",
        hint: "风险、边界，以及可以简化的地方",
        prompt: "评审我当前的改动，指出风险、边界问题和可以简化的地方。",
      },
      plugin: {
        label: "创建一个插件",
        hint: "主题、侧边栏或工具，先问清楚再动手",
        prompt: "/skill:plugin-creator 我想做一个插件：",
      },
    },
    keys: "/ 查看命令 · Enter 发送 · Shift+Enter 换行",
    startersLabel: "开始的方式",
  },
};

/** One icon per starter, in the order the grid draws them. */
const STARTER_ICON: Readonly<Record<NewChatStarterId, LucideIcon>> = {
  explore: Compass,
  fix: Bug,
  review: GitPullRequest,
  plugin: Puzzle,
};

/**
 * The hour the greeting was read at, re-read when the clock crosses into the next hour.
 *
 * One timeout to the next hour rather than a timer that wakes every minute: the greeting only
 * changes on the hour, so that is the only moment worth waking for. A window left on this screen
 * across midnight says the new day's greeting instead of yesterday's.
 */
function useGreetingSlot(): GreetingSlot {
  const [slot, setSlot] = useState(() => greetingSlot(new Date().getHours()));
  useEffect(() => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(now.getHours() + 1, 0, 0, 0);
    const timer = setTimeout(
      () => setSlot(greetingSlot(new Date().getHours())),
      next.getTime() - now.getTime() + 50,
    );
    return () => clearTimeout(timer);
  }, [slot]);
  return slot;
}

const STACK: Variants = {
  hidden: {},
  show: { transition: { delayChildren: 0.05, staggerChildren: 0.05 } },
};

const STACK_STILL: Variants = {
  hidden: {},
  show: {},
};

const ROW: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.26, ease: EASE_OUT } },
};

const ROW_STILL: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.18, ease: EASE_OUT } },
};

export function ConversationWelcome() {
  const copy = useCopy(COPY);
  const slot = useGreetingSlot();
  const reduce = useReducedMotion() ?? false;
  const row = reduce ? ROW_STILL : ROW;

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={reduce ? STACK_STILL : STACK}
      className="flex w-full min-w-0 flex-col items-center gap-6"
    >
      <motion.div variants={row} className="flex flex-col items-center gap-1.5 text-center">
        <h2 className="text-[22px] font-medium tracking-tight text-foreground">
          {copy.greeting[slot]}
        </h2>
        <p className="text-[13px] text-muted-foreground">{copy.subtitle}</p>
      </motion.div>

      <motion.div
        variants={row}
        role="group"
        aria-label={copy.startersLabel}
        className="grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2"
      >
        {NEW_CHAT_STARTERS.map((id) => (
          <StarterCard
            key={id}
            id={id}
            label={copy.starters[id].label}
            hint={copy.starters[id].hint}
            prompt={copy.starters[id].prompt}
          />
        ))}
      </motion.div>

      <motion.p variants={row} className="text-[11px] text-muted-foreground/70">
        {copy.keys}
      </motion.p>
    </motion.div>
  );
}

/**
 * One starter: a beUI card whose whole surface is the button that writes its prompt.
 *
 * The card is a `div` and never a tab stop, so the control inside is what a keyboard reaches and what
 * carries the name (`Card`'s own contract). The body is `pointer-events-none`, so a press on the words
 * lands on the control and not on the label.
 */
function StarterCard({
  id,
  label,
  hint,
  prompt,
}: {
  id: NewChatStarterId;
  label: string;
  hint: string;
  prompt: string;
}) {
  const Icon = STARTER_ICON[id];
  return (
    <Card interactive variant="outlined" size="compact" className="relative gap-0 p-0">
      <button
        type="button"
        aria-label={label}
        onClick={() => prefillComposer(prompt)}
        className="absolute inset-0 z-10 rounded-2xl outline-none"
      />
      <div className="pointer-events-none flex min-w-0 items-start gap-3 px-4 py-3.5">
        <span
          aria-hidden="true"
          className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-foreground">{label}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{hint}</span>
        </span>
      </div>
    </Card>
  );
}

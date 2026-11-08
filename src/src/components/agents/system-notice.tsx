"use client";

import { useMemo } from "react";
import { AnimatedBadge, type AnimatedBadgeStatus } from "@/components/motion/animated-badge";
import { Card } from "@/components/motion/card";
import { IrcMessageCard } from "@/components/agents/irc-message";
import { ToolResultOutput } from "@/components/agents/tool-result";
import { Markdown } from "@/components/agents/markdown";
import {
  stripModelTags,
  type NoticeSpan,
  type ParsedJob,
  type ParsedJobDelivery,
  type ParsedSystemNotice,
  type SystemNoticeTag,
} from "@/home/system-notice";
import { useCopy, type Localized } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The engine's own wrapper blocks, drawn as the blocks they are.
 *
 * The engine writes context inside angle brackets — a background job's delivery, a user's own
 * mid-turn interjection, a nudge it injected — and this app's transcript draws text as text, so
 * without these cards the reader gets a wall of brackets with an empty code block at the end of it.
 * `home/system-notice.ts` reads the facts back out of that text (it decides nothing about how they
 * look); this file decides only what to draw, and every word on it is the engine's own — the labels
 * in the reader's language are the only thing added.
 *
 * Two cards, because the engine writes two things:
 *
 * - `SystemNoticeCard` is one wrapper block. A block that carries a background job's delivery keeps
 *   the delivery card instead of the frame around it: the card states the job's outcome, its output
 *   and where its payload lives, which is more than the wrapper knows.
 * - `JobDeliveryCard` is a whole delivery — the case where the message *is* one, wrapper or not. A
 *   row checks this first (see the reading order in `home/system-notice.ts`).
 *
 * Both are built from components this app already vendors: `Card` is the framed block, `AnimatedBadge`
 * the chips, and a JSON `<output>` is drawn through the agent code surface's own tokens. Nothing here
 * writes a colour: every surface is a token from `index.css`, so light and dark both hold.
 */

/** This surface's own wording. The Chinese is the desktop app's, from `src/i18nCopyZh.ts`. */
interface SystemNoticeCopy {
  /** What each of the engine's wrappers is labelled in the reader's language. */
  labels: Readonly<Record<SystemNoticeTag, string>>
  /** The delivery's accessible name. */
  jobDelivery: string
  /** The label the engine's abort reason is drawn under. */
  reason: string
  /** The label a job's own failure is drawn under. */
  error: string
  /** The label the untruncated result's path is drawn under. */
  fullOutput: string
  /** The engine's own outcome words, keyed by the spelling the engine wrote. */
  statuses: Readonly<Record<string, string>>
}

const COPY: Localized<SystemNoticeCopy> = {
  en: {
    labels: {
      analysis: "Analysis",
      important: "Important",
      summary: "Summary",
      irc: "Agent message",
      "system-notice": "System notice",
      "system-reminder": "System reminder",
      "system-notification": "System notification",
      "system-injection": "System injection",
    },
    jobDelivery: "Background jobs",
    reason: "Reason",
    error: "Error",
    fullOutput: "Full output",
    statuses: {
      completed: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
      aborted: "Aborted",
    },
  },
  zh: {
    labels: {
      analysis: "分析",
      important: "重点",
      summary: "摘要",
      irc: "代理消息",
      "system-notice": "系统通知",
      "system-reminder": "系统提醒",
      "system-notification": "系统通知",
      "system-injection": "系统注入",
    },
    jobDelivery: "后台任务",
    reason: "原因",
    error: "错误",
    fullOutput: "完整输出",
    statuses: {
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
      aborted: "已中止",
    },
  },
};

/**
 * The tone an outcome is drawn in: work that ended well, work that ended badly, work that was cut
 * short. An outcome this build does not know is neither of those, and reads as the neutral chip
 * rather than being guessed at — the engine's own word is still what the chip says.
 */
function statusTone(status: string): AnimatedBadgeStatus {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "neutral";
}

export interface SystemNoticeCardProps {
  /** One wrapper block, already read apart by `splitSystemNotices`. */
  notice: ParsedSystemNotice;
  className?: string;
}

/**
 * One block the engine wrapped in its own tags.
 *
 * The chip says which wrapper it was, in the reader's language; the body is the engine's own words.
 * The body keeps the line breaks the engine wrote — this card frames the block, it does not
 * re-typeset it — and a delivery's card is the one reading that goes further than that.
 *
 * An `<important>` block is the exception in this family: the tag is the model's own emphasis on its
 * own answer, not a fact about the turn, so it draws with no chip and with the answer's own ink. It
 * keeps the frame — the one thing the reader needs is that this stretch was meant to stand out.
 *
 * The model's section tags (`analysis`, `summary`) take the ordinary frame with their own chip: the
 * reader's question about a block of scratch work followed by a conclusion is where one ends, and a
 * chip that says 摘要 answers it without a heading the model never wrote.
 */
export function SystemNoticeCard({ notice, className }: SystemNoticeCardProps) {
  const copy = useCopy(COPY);

  if (notice.irc !== null) {
    return <IrcMessageCard message={notice.irc} className={className} />;
  }

  if (notice.delivery !== null) {
    return <JobDeliveryCard delivery={notice.delivery} className={className} />;
  }

  if (notice.tag === "important") {
    // An emphasized block around nothing is nothing: a frame with no text in it is a gap the reader
    // has no words to account for.
    if (notice.text === "") return null;
    return (
      <Card
        size="compact"
        data-tag="important"
        aria-label={copy.labels.important}
        className={cn(
          "gap-0 rounded-xl border-l-2 border-l-primary px-3 py-2.5",
          className,
        )}
      >
        <Markdown
          text={stripModelTags(notice.text)}
          className="text-[13px] leading-relaxed text-foreground"
        />
      </Card>
    );
  }

  return (
    <Card
      size="compact"
      data-tag={notice.tag}
      aria-label={copy.labels[notice.tag]}
      className={cn("gap-1.5 rounded-xl px-3 py-2.5", className)}
    >
      <AnimatedBadge
        size="sm"
        // The chip is a label, not a status that changes under the reader's eyes: nothing here
        // swaps, so nothing here rolls.
        animated={false}
        // A reminder is the engine asking for something rather than telling the reader something,
        // which is the one wrapper that carries a tone of its own.
        status={notice.tag === "system-reminder" ? "warning" : "neutral"}
        className="self-start"
      >
        {copy.labels[notice.tag]}
      </AnimatedBadge>
      {/* A block the engine wrapped around nothing draws as the chip alone: an empty paragraph is
          a gap the reader has no text to account for. */}
      {notice.text !== "" ? (
        // The body is the engine's own text, and it reads as Markdown — the same reading the Vue
        // front end gives it, and the one a reminder with a list or a code span in it needs.
        <Markdown
          text={stripModelTags(notice.text)}
          className="text-[13px] leading-relaxed text-foreground/80"
        />
      ) : null}
    </Card>
  );
}

export interface JobDeliveryCardProps {
  /** A whole delivery, already read apart by `parseJobDelivery`. */
  delivery: ParsedJobDelivery;
  className?: string;
}

/**
 * A background job's delivery, as the row it should have been.
 *
 * A job that finishes outside its turn comes back as message text: a headline, then a `<task-result>`
 * element per `task` or a background shell's own result. This draws the facts instead — one card per
 * job with the outcome the engine reported, why it was cut short, what it returned and where its
 * payload lives. The cards are the reading, not a summary of it: a delivery with three jobs draws
 * three of them, in the order the engine wrote them.
 */
export function JobDeliveryCard({ delivery, className }: JobDeliveryCardProps) {
  const copy = useCopy(COPY);

  return (
    <section
      aria-label={copy.jobDelivery}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      {delivery.summary !== "" ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{delivery.summary}</p>
      ) : null}
      {delivery.jobs.map((job, index) => (
        // The engine's ids are its own and a job may carry none of them, so the position is what
        // makes the key unique.
        <JobCard key={`${index}-${job.id}`} job={job} />
      ))}
    </section>
  );
}

/** One job: what the engine named it, how it ended, what it returned and where the rest of it is. */
function JobCard({ job }: { job: ParsedJob }) {
  const copy = useCopy(COPY);
  const status = job.status === "" ? null : (copy.statuses[job.status] ?? job.status);

  return (
    <Card size="compact" className="gap-2 rounded-xl px-3 py-2.5">
      <header className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        {job.id !== "" ? (
          <span className="font-semibold text-foreground">{job.id}</span>
        ) : null}
        {job.agent !== "" ? (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {job.agent}
          </span>
        ) : null}
        {status !== null ? (
          <AnimatedBadge size="sm" animated={false} status={statusTone(job.status)}>
            {status}
          </AnimatedBadge>
        ) : null}
        {job.duration !== "" ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">{job.duration}</span>
        ) : null}
        {/* The engine's own `<meta>` summary is the right-most detail: it describes the output
            beside it, so it sits at the row's other end. */}
        {job.meta !== null ? (
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/70">
            {job.meta}
          </span>
        ) : null}
      </header>

      {job.abortReason !== null ? (
        <p className="flex gap-1.5 text-xs leading-relaxed">
          <span className="shrink-0 text-muted-foreground">{copy.reason}</span>
          <span className="min-w-0 text-foreground/80">{job.abortReason}</span>
        </p>
      ) : null}

      {job.error !== null ? (
        <p className="flex gap-1.5 text-xs leading-relaxed">
          <span className="shrink-0 text-muted-foreground">{copy.error}</span>
          <span className="min-w-0 text-destructive">{job.error}</span>
        </p>
      ) : null}

      {job.output !== "" ? <JobOutput output={job.output} /> : null}

      {/* A result over the engine's ceiling arrives as a preview: the path beside it is where the
          rest of it lives, so it is drawn as the address it is rather than as a sentence about it. */}
      {job.fullOutput !== null ? (
        <p className="flex min-w-0 gap-1.5 text-xs leading-relaxed">
          <span className="shrink-0 text-muted-foreground">{copy.fullOutput}</span>
          <code className="min-w-0 break-all rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground/80">
            {job.fullOutput}
          </code>
        </p>
      ) : null}

      {job.noteSpans.length > 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {job.noteSpans.map((span, index) => (
            <NoteSpan key={index} span={span} />
          ))}
        </p>
      ) : null}
    </Card>
  );
}

/** One run of the closing sentence: the engine's prose, or the command it wrote in backticks. */
function NoteSpan({ span }: { span: NoticeSpan }) {
  if (span.kind === "text") {
    return <>{span.text}</>;
  }
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground/80">
      {span.text}
    </code>
  );
}

/**
 * What the job returned.
 *
 * A `task`'s `<output>` is JSON and a background shell's is whatever it printed, so JSON is drawn
 * with the agent code surface's own tokens and anything else as plain pre-wrapped text. The clip is
 * a maximum height with its own scroll rather than a fold: the output is the thing this card exists
 * to show, and a payload that ran to five hundred lines should not push the conversation off screen.
 */
function JobOutput({ output }: { output: string }) {
  // Read once per payload rather than once per render: a background shell can return a megabyte of
  // text, and a row inside a transcript that is streaming is redrawn on every frame.
  const json = useMemo(() => isJson(output), [output]);
  const clipped = "scrollbar-hide max-h-80 overflow-auto rounded-lg bg-muted/60 px-2.5 py-2";

  if (json) {
    return (
      <div className={clipped}>
        <ToolResultOutput language="json" className="whitespace-pre-wrap break-words">
          {output}
        </ToolResultOutput>
      </div>
    );
  }

  return (
    <pre
      className={cn(
        clipped,
        "m-0 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-foreground/80",
      )}
    >
      {output}
    </pre>
  );
}

/**
 * Whether the payload is JSON, which is what a `task`'s own `<output>` is written in.
 *
 * The test is the whole shape — an object or an array that parses — rather than the first character
 * alone, so a shell's output that happens to start with a brace is not highlighted as a language it
 * is not.
 */
function isJson(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

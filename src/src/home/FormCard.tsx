"use client";
// beui.dev/components/agents/chat-app, adapted to the engine's own HTML form.

import { ChevronRight, CircleHelp, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/motion/button";
import { Checkbox } from "@/components/motion/checkbox";
import { Input } from "@/components/motion/input";
import { RadioGroup, RadioGroupItem } from "@/components/motion/radio";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
import type {
  UiFormAnswer,
  UiFormBlock,
  UiFormChoice,
  UiFormField,
  UiFormSection,
  UiFormSpan,
  UiFormText,
} from "@/api/session-types";
import { useCopy, type Localized } from "@/lib/i18n";
import { assertNever, cn } from "@/lib/utils";
import { answersOf, draftError, initialDraft, isGroup, type DraftValue, type DraftError } from "@/home/form-draft";

/** This card's own wording, in both languages. */
interface FormCardCopy {
  title: string
  submit: string
  cancel: string
  /** The free-text row a choice group gains, matching the engine's own label. */
  other: string
  otherPlaceholder: string
  selectPlaceholder: string
  /** Why a submit was refused, per `draftError`'s reason. */
  errors: {
    required: string
    number: string
    min: (bound: number) => string
    max: (bound: number) => string
    minLength: (bound: number) => string
    maxLength: (bound: number) => string
    email: string
    url: string
    pattern: string
  }
  /** A picture whose source would not load. */
  imageUnavailable: string
}

const COPY: Localized<FormCardCopy> = {
  en: {
    title: "The agent needs an answer",
    submit: "Submit",
    cancel: "Cancel",
    other: "Other",
    otherPlaceholder: "Type your own…",
    selectPlaceholder: "Choose…",
    errors: {
      required: "required",
      number: "enter a number",
      min: (bound) => `must be at least ${bound}`,
      max: (bound) => `must be at most ${bound}`,
      minLength: (bound) => `needs at least ${bound} characters`,
      maxLength: (bound) => `at most ${bound} characters`,
      email: "enter an email address",
      url: "enter a full URL",
      pattern: "does not match the required format",
    },
    imageUnavailable: "Image not available here",
  },
  zh: {
    title: "智能体在等待回答",
    submit: "提交",
    cancel: "取消",
    other: "其他",
    otherPlaceholder: "输入你自己的答案…",
    selectPlaceholder: "请选择…",
    errors: {
      required: "必填",
      number: "请输入数字",
      min: (bound) => `不能小于 ${bound}`,
      max: (bound) => `不能大于 ${bound}`,
      minLength: (bound) => `至少 ${bound} 个字符`,
      maxLength: (bound) => `最多 ${bound} 个字符`,
      email: "请输入邮箱地址",
      url: "请输入完整链接",
      pattern: "格式不符合要求",
    },
    imageUnavailable: "此处无法显示图片",
  },
};

/**
 * The engine's `ask` tool as an HTML form.
 *
 * Since engine 18.18.3 the tool asks by writing one `<form>` (`tools/ask.ts`), and a host that can
 * draw it is expected to: the alternative is the engine walking the same form one prompt at a time,
 * which loses the form's context - the findings, tradeoffs, diffs and tables the model put *inside*
 * the form precisely so the reader decides with them in view.
 *
 * The document arrives already parsed and bounded by the host (`host/src/ui-form.ts`, using the
 * engine's own `parseHtmlForm`), so this component is a renderer: sections in order, each block
 * drawn by kind, each field answering into the draft the submit button reads. The submit gate and
 * the answer shape live beside it in `home/form-draft.ts`.
 */
export interface FormCardProps {
  sections: readonly UiFormSection[];
  fields: readonly UiFormField[];
  onSubmit: (answers: UiFormAnswer[]) => void;
  onCancel: () => void;
  className?: string;
}

/** One run of spans, keeping the emphasis the model wrote. */
function Spans({ spans, className }: { spans: readonly UiFormSpan[]; className?: string }) {
  return (
    <span className={className}>
      {spans.map((span, index) => {
        const key = `${index}-${span.text.slice(0, 8)}`;
        if (span.style === "code") {
          return (
            <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
              {span.text}
            </code>
          );
        }
        if (span.style === "strong") {
          return (
            <strong key={key} className="font-medium text-foreground">
              {span.text}
            </strong>
          );
        }
        if (span.style === "em") {
          return <em key={key}>{span.text}</em>;
        }
        return <span key={key}>{span.text}</span>;
      })}
    </span>
  );
}

function ChoiceField({
  field,
  value,
  disabled,
  onChange,
  copy,
}: {
  field: UiFormChoice;
  value: DraftValue | undefined;
  disabled: boolean;
  onChange: (next: DraftValue) => void;
  copy: FormCardCopy;
}) {
  const group = isGroup(field);
  const selectedMany: string[] = group && Array.isArray(value) ? value : [];
  const selectedOne = !group && typeof value === "string" ? value : "";
  const [other, setOther] = useState("");

  // A `<select>` with `multiple` is a multi-value control: this design system's Select holds one
  // value, so a multi-select is drawn as the checkbox group it means. Rendering it as a single
  // select would send a scalar where the engine expects an array, and the answer would be dropped.
  if (field.select && !group) {
    return (
      <Select value={selectedOne} onValueChange={(next) => onChange(next)} disabled={disabled}>
        <SelectTrigger className="mt-1.5 w-full">
          <SelectValue placeholder={copy.selectPlaceholder} />
        </SelectTrigger>
        <SelectContent className="w-full">
          {field.options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (group) {
    return (
      <div className="mt-1.5 grid gap-0.5">
        {field.options.map((option) => (
          <Checkbox
            key={option.value}
            checked={selectedMany.includes(option.value)}
            disabled={disabled || option.disabled}
            label={option.label}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...selectedMany, option.value]
                  : selectedMany.filter((entry) => entry !== option.value),
              )
            }
            className="min-h-9 rounded-lg px-1.5 py-1"
          />
        ))}
        {field.other ? (
          <Input
            value={other}
            disabled={disabled}
            placeholder={copy.otherPlaceholder}
            onChange={(next) => {
              setOther(next);
              // The typed text is an extra entry of the group, exactly as the engine's own form
              // reads an "Other" answer into a checkbox array.
              const kept = selectedMany.filter((entry) => field.options.some((option) => option.value === entry));
              onChange(next.trim() === "" ? kept : [...kept, next]);
            }}
            className="mt-1 p-0.5"
            classNames={{
              field: "h-10 rounded-xl border-0 bg-background/70 focus-within:bg-background",
              input: "px-3 text-sm",
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-1.5">
      <RadioGroup
        value={selectedOne}
        onValueChange={(next) => onChange(next)}
        className="gap-0.5"
      >
        {field.options.map((option) => (
          <RadioGroupItem
            key={option.value}
            value={option.value}
            label={option.label}
            disabled={disabled || option.disabled}
            className="min-h-9 rounded-lg px-1.5 py-1"
          />
        ))}
      </RadioGroup>
      {field.other ? (
        <Input
          value={other}
          disabled={disabled}
          placeholder={copy.otherPlaceholder}
          onChange={(next) => {
            setOther(next);
            // A typed answer stands in for the radio's value, which is how the engine's own form
            // reads "Other" on a single-choice group.
            onChange(next.trim() === "" ? "" : next);
          }}
          className="mt-1 p-0.5"
          classNames={{
            field: "h-10 rounded-xl border-0 bg-background/70 focus-within:bg-background",
            input: "px-3 text-sm",
          }}
        />
      ) : null}
    </div>
  );
}

function TextField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: UiFormText;
  value: DraftValue | undefined;
  disabled: boolean;
  onChange: (next: DraftValue) => void;
}) {
  const text = typeof value === "string" ? value : "";
  if (field.multiline) {
    return (
      <textarea
        value={text}
        disabled={disabled}
        rows={Math.min(Math.max(field.rows, 2), 12)}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 w-full resize-y rounded-xl border-0 bg-background/70 px-3 py-2 text-sm text-foreground outline-none focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      />
    );
  }
  return (
    <Input
      value={text}
      disabled={disabled}
      placeholder={field.placeholder || undefined}
      onChange={(next) => onChange(next)}
      className="mt-1.5 p-0.5"
      classNames={{
        field: "h-10 rounded-xl border-0 bg-background/70 focus-within:bg-background",
        input: "px-3 text-sm",
      }}
    />
  );
}

function FieldBlock({
  field,
  value,
  disabled,
  onChange,
  copy,
}: {
  field: UiFormField;
  value: DraftValue | undefined;
  disabled: boolean;
  onChange: (next: DraftValue) => void;
  copy: FormCardCopy;
}) {
  const label = field.label;
  return (
    <div className="mt-2">
      {label.length > 0 ? (
        <p className="text-sm font-medium leading-5 text-foreground">
          <Spans spans={label} />
          {field.required ? (
            <span aria-hidden="true" className="ml-0.5 text-destructive">
              *
            </span>
          ) : null}
        </p>
      ) : null}
      {field.kind === "choice" ? (
        <ChoiceField
          field={field}
          value={value}
          disabled={disabled}
          onChange={onChange}
          copy={copy}
        />
      ) : (
        <TextField
          field={field}
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
      )}
    </div>
  );
}

/** One renderable block: the form's context, or a control. */
function Block({
  block,
  value,
  disabled,
  onChange,
  copy,
  imageUnavailable,
}: {
  block: UiFormBlock;
  value: DraftValue | undefined;
  disabled: boolean;
  onChange: (next: DraftValue) => void;
  copy: FormCardCopy;
  imageUnavailable: string;
}) {
  switch (block.kind) {
    case "text":
      return block.heading ? (
        <h4 className="mt-3 text-sm font-medium leading-5 text-foreground">
          <Spans spans={block.spans} />
        </h4>
      ) : (
        <p className="mt-2 text-sm leading-5 text-muted-foreground">
          <Spans spans={block.spans} />
        </p>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index} className="leading-5">
          <Spans spans={item} />
        </li>
      ));
      return block.ordered ? (
        <ol className="mt-2 ml-5 list-decimal text-sm text-muted-foreground">{items}</ol>
      ) : (
        <ul className="mt-2 ml-5 list-disc text-sm text-muted-foreground">{items}</ul>
      );
    }
    case "pre":
      return (
        <pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-2 font-mono text-xs leading-5 text-foreground">
          {block.text}
        </pre>
      );
    case "table":
      return (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-border/60 last:border-0">
                  {row.map((cell, cellIndex) =>
                    rowIndex < block.headerRows ? (
                      <th
                        key={cellIndex}
                        scope="col"
                        className="px-2 py-1 text-left font-medium text-foreground"
                      >
                        <Spans spans={cell} />
                      </th>
                    ) : (
                      <td key={cellIndex} className="px-2 py-1 text-muted-foreground">
                        <Spans spans={cell} />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "image":
      return (
        <img
          src={block.src}
          alt={block.alt}
          className="mt-2 max-h-80 w-auto max-w-full rounded-lg border border-border/60 object-contain"
          onError={(event) => {
            // A source that will not load leaves the alt text, which is the honest surface here:
            // the picture is gone and the words the model wrote for it are not.
            event.currentTarget.replaceWith(
              Object.assign(document.createElement("p"), {
                textContent: block.alt || imageUnavailable,
                className: "mt-2 text-sm text-muted-foreground",
              }),
            );
          }}
        />
      );
    case "svg": {
      // The markup arrived already sanitized: the host reduces it to an allowlist of drawing
      // elements and attributes before the frame is built (`host/src/ui-form-svg.ts`), because the
      // engine's parser serializes an `<svg>` subtree whole and never descends into it.
      const markup = block.markup
      if (markup === "") {
        return (
          <p className="mt-2 text-sm text-muted-foreground">{block.alt || imageUnavailable}</p>
        );
      }
      return (
        <div
          className="mt-2 max-h-80 overflow-auto rounded-lg border border-border/60 p-2 [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: markup }}
          role="img"
          aria-label={block.alt}
        />
      );
    }
    case "field":
      return (
        <FieldBlock
          field={block.field}
          value={value}
          disabled={disabled}
          onChange={onChange}
          copy={copy}
        />
      );
    default:
      // The block union is this repository's own vocabulary (`api/session-types.ts`), so a new kind
      // is a compile error here rather than a silently undrawn block
      // (`rules.md#exhaustiveness-follows-who-owns-the-vocabulary`).
      return assertNever(block);
  }
}

/**
 * What to call one field in an error line: its own label when the model wrote one, else its section
 * heading, else its control `name` - the same fallback order the engine's `fieldQuestions` uses.
 */
function questionOf(field: UiFormField | undefined, name: string): string {
  if (field === undefined) return name;
  const label = field.label.map((span) => span.text).join("").replace(/\s+/g, " ").trim();
  return label === "" ? name : label;
}

/** The reason in the reader's language, carrying the bound the field states. */
function describeError(problem: DraftError, copy: FormCardCopy): string {
  switch (problem.reason) {
    case "required":
      return copy.errors.required;
    case "number":
      return copy.errors.number;
    case "email":
      return copy.errors.email;
    case "url":
      return copy.errors.url;
    case "pattern":
      return copy.errors.pattern;
    case "min":
      return copy.errors.min(problem.bound);
    case "max":
      return copy.errors.max(problem.bound);
    case "minLength":
      return copy.errors.minLength(problem.bound);
    case "maxLength":
      return copy.errors.maxLength(problem.bound);
    default:
      // `DraftError` is this repository's own vocabulary, so a new reason fails `typecheck` here.
      return assertNever(problem);
  }
}

export function FormCard({ sections, fields, onSubmit, onCancel, className }: FormCardProps) {
  const copy = useCopy(COPY);
  const [draft, setDraft] = useState<Record<string, DraftValue>>(() => initialDraft(fields));
  const [attempted, setAttempted] = useState(false);

  const errors = useMemo(() => {
    const problems = new Map<string, DraftError>();
    for (const field of fields) {
      const problem = draftError(field, draft[field.name]);
      if (problem !== undefined) problems.set(field.name, problem);
    }
    return problems;
  }, [draft, fields]);

  const setValue = useCallback((name: string, next: DraftValue) => {
    setDraft((held) => ({ ...held, [name]: next }));
  }, []);

  const submit = () => {
    setAttempted(true);
    if (errors.size > 0) return;
    onSubmit(answersOf(fields, draft));
  };

  return (
    <div
      className={cn("w-full overflow-hidden rounded-2xl bg-muted p-4 text-sm", className)}
      role="form"
      aria-label={copy.title}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center text-muted-foreground">
          <CircleHelp className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-3">
            <h3 className="min-w-0 flex-1 text-base font-medium leading-5 text-foreground">
              {copy.title}
            </h3>
            <button
              type="button"
              aria-label={copy.cancel}
              onClick={onCancel}
              className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="mt-1">
            {sections.map((section, index) => (
              <section key={index}>
                {section.title.length > 0 ? (
                  <h4 className="mt-3 text-sm font-medium leading-5 text-foreground">
                    <Spans spans={section.title} />
                  </h4>
                ) : null}
                {section.blocks.map((block, blockIndex) => (
                  <Block
                    key={blockIndex}
                    block={block}
                    value={block.kind === "field" ? draft[block.field.name] : undefined}
                    disabled={false}
                    onChange={(next) => {
                      if (block.kind === "field") setValue(block.field.name, next);
                    }}
                    copy={copy}
                    imageUnavailable={copy.imageUnavailable}
                  />
                ))}
              </section>
            ))}
          </div>

          {attempted && errors.size > 0 ? (
            <ul className="mt-3 grid gap-0.5 text-xs text-destructive">
              {[...errors.entries()].map(([name, problem]) => {
                const field = fields.find((candidate) => candidate.name === name);
                return (
                  <li key={name}>
                    {questionOf(field, name)}: {describeError(problem, copy)}
                  </li>
                );
              })}
            </ul>
          ) : null}

          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" onClick={submit} className="ml-auto rounded-full">
              {copy.submit}
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

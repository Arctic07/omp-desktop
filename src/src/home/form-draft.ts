import type { UiFormAnswer, UiFormField } from "@/api/session-types";

/** One field's current answer, as the card holds it while the reader edits. */
export type DraftValue = string | string[];

/**
 * The answer a field starts with: its own preselection, else empty.
 *
 * A form opens showing what the model recommended (`checked`/`selected`/`value`), which is also
 * what a timeout submits - so the draft is the form's own default and nothing else.
 *
 * A choice field reports an array only when the engine would: a checkbox group or multi-select of
 * more than one option (`isArrayChoice` in `@oh-my-pi/pi-tui/html-form/data`). A **lone** checkbox
 * is `multi` too, but the engine reports its value as a scalar, so its draft is a string here.
 */
export function initialDraft(fields: readonly UiFormField[]): Record<string, DraftValue> {
  const draft: Record<string, DraftValue> = {};
  for (const field of fields) {
    if (field.kind === "text") {
      draft[field.name] = field.value;
      continue;
    }
    const checked = field.options.filter((option) => option.checked).map((option) => option.value);
    draft[field.name] = isGroup(field) ? checked : (checked[0] ?? "");
  }
  return draft;
}

/**
 * Whether a choice field reports an array - the engine's own rule, restated for the draft.
 *
 * `isArrayChoice` is `multi && options.length > 1`; the host applies it again when it builds the
 * data, so this copy only decides what the control looks like and what shape the draft holds. Both
 * sides agreeing is what keeps a lone checkbox from being drawn as a one-item group.
 */
export function isGroup(field: Extract<UiFormField, { kind: "choice" }>): boolean {
  return field.multi && field.options.length > 1;
}

/** Why one field is not answerable yet; the bounded reasons carry the limit they name. */
export type DraftError =
  | { reason: "required" }
  | { reason: "number" }
  | { reason: "email" }
  | { reason: "url" }
  | { reason: "pattern" }
  | { reason: "min"; bound: number }
  | { reason: "max"; bound: number }
  | { reason: "minLength"; bound: number }
  | { reason: "maxLength"; bound: number };

/**
 * Longest `pattern` this gate will compile, and the longest value it will test against one.
 *
 * A pattern is agent-written, and a backtracking expression over a long input is a frozen renderer:
 * both sides are bounded so a hostile or careless pattern costs a fixed amount of work rather than
 * growing with the reader's text. A pattern beyond the cap is ignored, exactly as an invalid one is.
 */
const PATTERN_MAX = 512;
const PATTERN_INPUT_MAX = 4_000;

/**
 * Why one field is not answerable yet, or `undefined` when it is.
 *
 * These are the rules the engine's own form surface enforces (`fieldError` in
 * `@oh-my-pi/pi-tui/html-form/data`), restated against the wire shape the host already bounded:
 * `required`, numeric `min`/`max`, `minlength`/`maxlength`, `email` and `url` shapes, and `pattern`
 * anchored as HTML anchors it. They live here rather than in the host because they validate a
 * *draft*, which only the window holds; the host validates nothing and forwards what the reader
 * answered.
 *
 * The reason is structured rather than a bare code so the card can say *why* in the reader's own
 * language, including the bound the field states.
 */
export function draftError(
  field: UiFormField,
  value: DraftValue | undefined,
): DraftError | undefined {
  if (field.kind === "choice") {
    const empty = value === undefined || (Array.isArray(value) ? value.length === 0 : value === "");
    return field.required && empty ? { reason: "required" } : undefined;
  }
  const text = typeof value === "string" ? value : "";
  if (text.trim() === "") return field.required ? { reason: "required" } : undefined;
  if (field.type === "number" || field.type === "range") {
    const number = Number(text);
    if (!Number.isFinite(number)) return { reason: "number" };
    if (field.min !== undefined && field.min !== null && number < field.min) {
      return { reason: "min", bound: field.min };
    }
    if (field.max !== undefined && field.max !== null && number > field.max) {
      return { reason: "max", bound: field.max };
    }
  }
  if (field.minLength !== undefined && field.minLength !== null && text.length < field.minLength) {
    return { reason: "minLength", bound: field.minLength };
  }
  if (field.maxLength !== undefined && field.maxLength !== null && text.length > field.maxLength) {
    return { reason: "maxLength", bound: field.maxLength };
  }
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return { reason: "email" };
  if (field.type === "url" && !URL.canParse(text)) return { reason: "url" };
  if (field.pattern && field.pattern.length <= PATTERN_MAX && text.length <= PATTERN_INPUT_MAX) {
    try {
      if (!new RegExp(`^(?:${field.pattern})$`, "v").test(text)) return { reason: "pattern" };
    } catch {
      // An invalid pattern is ignored, exactly as the engine's own reader ignores it.
    }
  }
  return undefined;
}

/**
 * The answers to send: one entry per field the reader touched, addressed by its control `name`.
 *
 * The value is the draft as the control holds it - a string, or the values of a group. **The shape
 * rule is not decided here**: the host normalizes it with the engine's own `isArrayChoice` and
 * `textValue` (`host/src/ui-form.ts::formResponseData`), so a lone checkbox, a multi-select and a
 * `number` input all report what the engine expects without this file knowing the difference.
 *
 * A field the reader never touched is absent, which the host reads as "keep the form's default" -
 * the same rule a timeout uses. A field they *emptied* is sent as an empty value, so clearing a
 * prefilled field is an answer rather than a silent revert to the model's recommendation.
 */
export function answersOf(
  fields: readonly UiFormField[],
  draft: Record<string, DraftValue>,
): UiFormAnswer[] {
  return fields.flatMap((field) => {
    const value = draft[field.name];
    if (value === undefined) return [];
    return [{ name: field.name, value }];
  });
}

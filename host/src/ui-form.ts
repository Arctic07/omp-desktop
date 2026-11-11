/**
 * The `ask` tool's HTML form, projected onto the wire and answered back as form data.
 *
 * Since engine `18.18.3` the tool takes one `<form>` instead of a `questions[]` array
 * (`tools/ask.ts`): it prefers `ui.formDialog(html)`, and only falls back to walking the fields one
 * prompt at a time through `select`/`input`/`editor`. This host draws a real form, so it implements
 * the form surface rather than letting the tool degrade.
 *
 * Two things stay the engine's own:
 *
 * - the **parse**: `parseHtmlForm` is the same function the engine's TUI and ACP hosts call, so the
 *   form the reader sees is the form the engine would have drawn - radio/checkbox groups merged
 *   across table cells, sections split at `<fieldset>`, `required`/`min`/`max`/`pattern` read the
 *   way the model was told they would be;
 * - the **value rules**: `defaultFormData` is what a form opens with, `isArrayChoice` decides which
 *   choice fields report an array, and `textValue` turns a text field's text into the value the
 *   engine reports (a number for a `number` input). All three are imported from the package that
 *   owns them, so a second implementation cannot drift from the prompt the model writes against.
 *
 * What is this host's own is the wire shape: a parsed form is a document (sections, context blocks,
 * images, fields), and the desktop renders documents, so the frame carries the document instead of
 * a question list. `formResponseData` is the way back: the reader's per-field values become the
 * `HtmlFormData` the tool reports to the model.
 */

import type { ChoiceField, FormField, FormSpan, HtmlForm, TextField } from '@oh-my-pi/pi-tui/html-form/parse'
import type { HtmlFormData, HtmlFormValue } from './sdk.ts'
import { sanitizeSvg } from './ui-form-svg.ts'

/**
 * Largest form this host forwards.
 *
 * The frame comes from this project's own host, but a form is agent-written and therefore
 * unbounded: a document larger than any reader would answer is bounded here rather than shipped to
 * the window. The engine's prompt already asks for "a few questions", so the ceilings are generous
 * rather than tight - they bound a runaway model, not a normal form.
 *
 * Every dimension is capped, not just the field count: a document's size is the product of its
 * sections, blocks, spans and table cells, so a cap on one of them alone still lets a form blow the
 * frame budget. The Rust side repeats these caps on arrival, for the same reason the ask questions
 * have a second pass there.
 */
export const FORM_SECTIONS_MAX = 64
export const FORM_BLOCKS_MAX = 200
export const FORM_FIELDS_MAX = 64
export const FORM_OPTIONS_MAX = 64
export const FORM_SPANS_MAX = 64
export const FORM_LIST_ITEMS_MAX = 64
export const FORM_ROWS_MAX = 64
export const FORM_CELLS_MAX = 64
/** Longest text this host forwards for one span, label or context line. */
export const FORM_TEXT_MAX = 4_000

/** One styled run of form text, as the parser reports it. */
export interface FormWireSpan {
  readonly text: string
  readonly style?: 'code' | 'strong' | 'em'
}

/** One answer of a choice field. */
export interface FormWireOption {
  readonly value: string
  readonly label: string
  readonly checked: boolean
  readonly disabled: boolean
}

/** A radio group, checkbox group or `<select>`. */
export interface FormWireChoice {
  readonly kind: 'choice'
  readonly name: string
  /** A checkbox group or multi-select: the answer is an array. */
  readonly multi: boolean
  /** From a `<select>`: drawn as one row rather than an option list. */
  readonly select: boolean
  /** The UI adds a free-text "Other" answer for this group. */
  readonly other: boolean
  /** The control's own label; empty for groups, whose question is the surrounding text. */
  readonly label: readonly FormWireSpan[]
  readonly options: readonly FormWireOption[]
  readonly required: boolean
}

/** A single-line `<input>` or a `<textarea>`. */
export interface FormWireText {
  readonly kind: 'text'
  readonly name: string
  /** The `<input type>`, or `textarea`. */
  readonly type: string
  readonly multiline: boolean
  readonly label: readonly FormWireSpan[]
  readonly value: string
  readonly placeholder: string
  readonly required: boolean
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly minLength?: number
  readonly maxLength?: number
  readonly rows: number
}

export type FormWireField = FormWireChoice | FormWireText

/** One renderable unit of a section, in document order. */
export type FormWireBlock =
  | { readonly kind: 'text'; readonly spans: readonly FormWireSpan[]; readonly heading: boolean }
  | { readonly kind: 'list'; readonly items: readonly (readonly FormWireSpan[])[]; readonly ordered: boolean }
  | { readonly kind: 'pre'; readonly text: string }
  | { readonly kind: 'table'; readonly rows: readonly (readonly (readonly FormWireSpan[])[])[]; readonly headerRows: number }
  /** A picture the desktop can draw itself: an `http(s)` URL or a `data:` URI. */
  | { readonly kind: 'image'; readonly src: string; readonly alt: string }
  | { readonly kind: 'svg'; readonly markup: string; readonly alt: string }
  | { readonly kind: 'field'; readonly field: FormWireField }

/** A `<fieldset>` (titled by its `<legend>`) or loose content between fieldsets. */
export interface FormWireSection {
  readonly title: readonly FormWireSpan[]
  readonly blocks: readonly FormWireBlock[]
}

/** One field's answer as the reader gave it; absent means "left at its default". */
export interface FormWireAnswer {
  readonly name: string
  readonly value: HtmlFormValue
}

/** Cuts `text` to {@link FORM_TEXT_MAX} characters, keeping the head. */
function bound(text: string): string {
  return text.length <= FORM_TEXT_MAX ? text : `${text.slice(0, FORM_TEXT_MAX - 1)}…`
}

function spans(input: readonly FormSpan[]): FormWireSpan[] {
  return input.slice(0, FORM_SPANS_MAX).map((span) => ({
    text: bound(span.text),
    ...(span.style === undefined ? {} : { style: span.style }),
  }))
}

function choiceField(field: ChoiceField): FormWireChoice {
  return {
    kind: 'choice',
    name: field.name,
    multi: field.multi,
    select: field.select,
    other: field.other,
    label: spans(field.label),
    options: field.options.slice(0, FORM_OPTIONS_MAX).map((option) => ({
      value: bound(option.value),
      // The reader picks by label, but the answer travels as the option's value, so the label is
      // flattened to the one line a row can hold - the same `spansText(...).replace(/\s+/g,' ')`
      // the engine's own field-by-field fallback applies.
      label: bound(option.label.map((span) => span.text).join('').replace(/\s+/g, ' ').trim() || option.value),
      checked: option.checked,
      disabled: option.disabled,
    })),
    required: field.required,
  }
}

function textField(field: TextField): FormWireText {
  return {
    kind: 'text',
    name: field.name,
    type: field.type,
    multiline: field.multiline,
    label: spans(field.label),
    value: bound(field.value),
    placeholder: bound(field.placeholder),
    required: field.required,
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.pattern === undefined ? {} : { pattern: field.pattern }),
    ...(field.minLength === undefined ? {} : { minLength: field.minLength }),
    ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
    rows: field.rows,
  }
}

function wireField(field: FormField): FormWireField {
  return field.kind === 'choice' ? choiceField(field) : textField(field)
}

/**
 * The parsed form as the wire document.
 *
 * Pictures are the one place this host decides rather than forwards: only a source the window can
 * load on its own - an `http(s)` URL or a `data:` URI - travels as an image. A local path is a file
 * the model pointed at in the workspace, and turning it into a URL would mean handing the webview a
 * file-read capability the form surface has no business adding, so it travels as its `alt` text
 * instead (the same thing the terminal does inside a `<label>`).
 */
export function wireForm(form: HtmlForm): { sections: FormWireSection[]; fields: FormWireField[] } {
  const fields: FormWireField[] = []
  const sections: FormWireSection[] = []
  for (const section of form.sections) {
    // A document's size is the product of its parts, so the section count is capped too: without
    // this, N sections each under the block cap still exceed the frame budget.
    if (sections.length >= FORM_SECTIONS_MAX) break
    const blocks: FormWireBlock[] = []
    for (const block of section.blocks) {
      if (blocks.length >= FORM_BLOCKS_MAX) break
      switch (block.kind) {
        case 'text':
          blocks.push({ kind: 'text', spans: spans(block.spans), heading: block.heading })
          break
        case 'list':
          blocks.push({
            kind: 'list',
            items: block.items.slice(0, FORM_LIST_ITEMS_MAX).map(spans),
            ordered: block.ordered,
          })
          break
        case 'pre':
          blocks.push({ kind: 'pre', text: bound(block.text) })
          break
        case 'table':
          blocks.push({
            kind: 'table',
            rows: block.rows
              .slice(0, FORM_ROWS_MAX)
              .map(row => row.slice(0, FORM_CELLS_MAX).map(spans)),
            headerRows: block.headerRows,
          })
          break
        case 'image': {
          const src = block.src.trim()
          if (/^(?:https?:\/\/|data:)/i.test(src)) {
            blocks.push({ kind: 'image', src: bound(src), alt: bound(block.alt) })
          } else {
            // A path this window cannot open: the alt text is what the reader gets, and a blank alt
            // is still a picture the model meant to show, so it keeps its own line.
            blocks.push({
              kind: 'text',
              spans: [{ text: bound(block.alt || src) }],
              heading: false,
            })
          }
          break
        }
        case 'svg': {
          // The parser serializes an `<svg>` subtree whole and never descends into it, so the
          // script/style stripping it applies elsewhere does not run inside a drawing. Sanitize here,
          // at the boundary the agent's bytes cross, so the window only ever receives a string this
          // process composed (`host/src/ui-form-svg.ts`).
          const markup = sanitizeSvg(block.markup)
          if (markup !== '') blocks.push({ kind: 'svg', markup: bound(markup), alt: bound(block.alt) })
          break
        }
        case 'field': {
          if (fields.length >= FORM_FIELDS_MAX) break
          const field = wireField(block.field)
          fields.push(field)
          blocks.push({ kind: 'field', field })
          break
        }
      }
    }
    sections.push({ title: spans(section.title), blocks })
  }
  return { sections, fields }
}

/**
 * The `HtmlFormData` a response reports: every named field, normalized to the shape the engine's own
 * form surface produces for it.
 *
 * This is the single owner of that rule. The wire carries what the reader left in each control -
 * a string, or the values of a group - and this function decides what the engine receives:
 *
 * - a text field goes through the engine's `textValue`, so a `number` input arrives as a number and
 *   an emptied one arrives as `""` (a cleared field is an answer, not an omission);
 * - a choice field uses the engine's own `isArrayChoice` rule (a checkbox group or multi-select of
 *   more than one option is an array; a radio, a lone checkbox and a single select are scalars), and
 *   an emptied group is *removed* rather than reported as `[]` - which is what the engine's own
 *   field-by-field path does (`tools/ask.ts` `askFieldByField`).
 *
 * A value of the wrong shape for its field is dropped rather than coerced: the engine validates the
 * data against the form it parsed, and a coerced value would be an answer the reader never gave.
 */
export function formResponseData(
  form: HtmlForm,
  defaults: HtmlFormData,
  answers: readonly FormWireAnswer[],
  isArrayChoice: (field: ChoiceField) => boolean,
  textValue: (field: TextField, text: string) => HtmlFormValue,
): HtmlFormData {
  const byName = new Map(form.fields.filter(field => field.name !== '').map(field => [field.name, field]))
  const data: HtmlFormData = { ...defaults }
  for (const answer of answers) {
    const field = byName.get(answer.name)
    if (field === undefined) continue
    if (field.kind === 'choice') {
      if (isArrayChoice(field)) {
        if (!Array.isArray(answer.value)) continue
        const values = answer.value.filter(value => typeof value === 'string')
        // An emptied group is absent, not an empty array: the engine's own fallback deletes it.
        if (values.length === 0) delete data[answer.name]
        else data[answer.name] = values
        continue
      }
      if (Array.isArray(answer.value)) continue
      if (answer.value === '') delete data[answer.name]
      else data[answer.name] = answer.value
      continue
    }
    if (Array.isArray(answer.value)) continue
    // `textValue` takes the control's text; a number already typed on the wire is its own text.
    data[answer.name] = textValue(field, String(answer.value))
  }
  return data
}

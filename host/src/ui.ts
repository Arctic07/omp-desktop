/**
 * UI request bridge (contract §2.5-8, ruling F4).
 *
 * The engine's dialogs (confirm/select/input/editor) become `extension_ui_request` frames and are
 * answered by `session_ui_response`. The host always bottoms out: a request the caller never
 * answers is voided with `extension_ui_cancel` and resolved with the dialog's default, so a lost
 * answer can never stall a turn.
 */

import type {
  ExtensionAskDialogQuestion,
  ExtensionAskDialogResult,
  ExtensionFormDialogResult,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionUISelectItem,
  HtmlFormData,
  HtmlFormValue,
  Theme,
} from '@oh-my-pi/pi-coding-agent'
import type { ChoiceField, HtmlForm, TextField } from '@oh-my-pi/pi-tui/html-form/parse'

import { UI_REQUEST_TIMEOUT_ENV, UI_REQUEST_TIMEOUT_MS } from './constants.ts'
import type { SessionEvents } from './events.ts'
import { formResponseData, wireForm, type FormWireAnswer } from './ui-form.ts'

/** Engine values the UI context needs but the host cannot import statically. */
export interface UiEngineBindings {
  /** Label of one select option, matching how the engine labels them for other frontends. */
  readonly selectOptionLabel: (option: ExtensionUISelectItem) => string
  /** Shared default theme object (this host renders no TUI, but extensions read it). */
  readonly theme: Theme
  /** The engine's own answer to an `ask` dialog whose deadline elapsed; see `sdk.ts`'s binding. */
  readonly timedOutAsk: (questions: ExtensionAskDialogQuestion[]) => ExtensionAskDialogResult
  /**
   * The engine's own HTML-form reader and value rules (`sdk.ts`'s `htmlForm`).
   *
   * `parse` turns the model's HTML into the document the frame carries; `defaults` is what a field
   * keeps when the reader leaves it alone, which is also what a timeout submits; `isArrayChoice` and
   * `textValue` decide what shape each answer takes on the way back to the engine.
   */
  readonly htmlForm: {
    readonly parse: (html: string) => HtmlForm
    readonly defaults: (form: HtmlForm) => HtmlFormData
    readonly isArrayChoice: (field: ChoiceField) => boolean
    readonly textValue: (field: TextField, text: string) => HtmlFormValue
  }
}

/** One dialog this host is waiting on. */
interface PendingDialog {
  readonly settle: (response: Record<string, unknown>) => void
  readonly abandon: () => void
}

/** A dialog request before it is serialized into a frame. */
interface DialogSpec<T> {
  readonly method: string
  readonly fields: Record<string, unknown>
  /** Engine-supplied deadline; the host default applies when this is absent. */
  readonly timeoutMs: number | undefined
  readonly signal: AbortSignal | undefined
  readonly onTimeout: (() => void) | undefined
  readonly fallback: T
  /**
   * What an elapsed deadline answers, when that is not the same as being abandoned. The engine's
   * ask tool documents its own behaviour here: a question that times out is answered with its
   * recommended option rather than cancelled, so its expiry carries a value while a closed session
   * still resolves the fallback.
   *
   * A thunk, not a value: the answer is only needed when the deadline actually elapses, and the
   * engine's rule should not run once for every dialog that is answered in time.
   */
  readonly expireValue?: () => T
  readonly parse: (response: Record<string, unknown>) => T
}

/**
 * The per-field answers of a form response, as the reader gave them.
 *
 * The wire carries one entry per control, because a form is a document rather than a question list:
 * `name` addresses the field, `value` is what the reader left in it. A response without answers is
 * an empty list, which `formResponseData` reads as "every field keeps its default".
 */
function formAnswersOf(response: Record<string, unknown>): FormWireAnswer[] {
  const rows = Array.isArray(response.answers) ? response.answers : []
  const answers: FormWireAnswer[] = []
  for (const entry of rows) {
    const row = (entry ?? {}) as Record<string, unknown>
    const name = typeof row.name === 'string' ? row.name : ''
    if (name === '') continue
    const value = row.value
    if (typeof value === 'string' || typeof value === 'number') answers.push({ name, value })
    else if (Array.isArray(value)) {
      answers.push({ name, value: value.filter((item): item is string => typeof item === 'string') })
    }
  }
  return answers
}

/** One ask response as the engine's result type; a cancelled dialog is `undefined`. */
function parseAskResult(
  response: Record<string, unknown>,
  onTimeout: (() => void) | undefined,
): ExtensionAskDialogResult | undefined {
  if (response.cancelled === true) {
    if (response.timedOut === true) onTimeout?.()
    return undefined
  }
  const results = Array.isArray(response.results) ? response.results : []
  return {
    kind: response.kind === 'chat' ? 'chat' : 'submit',
    results: results.map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>
      const selected = Array.isArray(row.selectedOptions) ? row.selectedOptions : []
      const options = Array.isArray(row.options) ? row.options : []
      return {
        id: typeof row.id === 'string' ? row.id : '',
        question: typeof row.question === 'string' ? row.question : '',
        options: options.filter((value): value is string => typeof value === 'string'),
        multi: row.multi === true,
        selectedOptions: selected.filter((value): value is string => typeof value === 'string'),
        ...(typeof row.customInput === 'string' ? { customInput: row.customInput } : {}),
        ...(typeof row.note === 'string' ? { note: row.note } : {}),
        ...(row.timedOut === true ? { timedOut: true } : {}),
      }
    }),
  }
}

/**
 * The engine's preselection facts for one `select`, as the frame carries them.
 *
 * Only facts the engine actually set travel: an absent field means "the engine said nothing", which
 * is a different statement from "index 0" or "no markers", and the dialog draws its own default for
 * it. `markableCount` and `checkedIndices` are meaningless without `selectionMarker` - the engine
 * documents them as its companions - so they travel only alongside it.
 *
 * The two numbers are bounded by what they count, and the two bounds are not the same one: an index
 * addresses a row, so it must be `< optionCount`; `markableCount` counts the leading rows and may
 * equal the whole list (the engine sends exactly that when its "Done" row is absent). Indices the
 * caller sent outside the list are dropped rather than carried to a window that cannot point at
 * them, and the surviving set is deduped and capped: an extension can call `ui.select` directly,
 * and a list of a hundred thousand duplicate indices is a frame this process should not relay.
 */
function selectPreselection(
  dialogOptions: Pick<
    ExtensionUIDialogOptions,
    'initialIndex' | 'selectionMarker' | 'checkedIndices' | 'markableCount'
  > | undefined,
  optionCount: number,
): Record<string, unknown> {
  if (dialogOptions === undefined) return {}
  const isIndex = (value: number): boolean => Number.isInteger(value) && value >= 0 && value < optionCount
  const isCount = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= optionCount
  const fields: Record<string, unknown> = {}
  if (typeof dialogOptions.initialIndex === 'number' && isIndex(dialogOptions.initialIndex)) {
    fields.initialIndex = dialogOptions.initialIndex
  }
  const marker = dialogOptions.selectionMarker
  if (marker === 'radio' || marker === 'checkbox') {
    fields.selectionMarker = marker
    if (typeof dialogOptions.markableCount === 'number' && isCount(dialogOptions.markableCount)) {
      fields.markableCount = dialogOptions.markableCount
    }
    if (dialogOptions.checkedIndices !== undefined) {
      const unique = [...new Set(dialogOptions.checkedIndices.filter(isIndex))].slice(0, optionCount)
      fields.checkedIndices = unique
    }
  }
  return fields
}

/** The UI timeout in effect for dialogs the engine did not give a deadline for. */
export function configuredUiTimeoutMs(): number {
  const raw = process.env[UI_REQUEST_TIMEOUT_ENV]
  if (raw === undefined || raw === '') return UI_REQUEST_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : UI_REQUEST_TIMEOUT_MS
}

/** Bridges one session's engine dialogs to the wire protocol. */
export class UiBridge {
  readonly #events: SessionEvents
  readonly #engine: UiEngineBindings
  readonly #defaultTimeoutMs: number
  readonly #pending = new Map<string, PendingDialog>()
  #counter = 0

  constructor(events: SessionEvents, engine: UiEngineBindings, defaultTimeoutMs: number) {
    this.#events = events
    this.#engine = engine
    this.#defaultTimeoutMs = defaultTimeoutMs
  }

  /** Dialogs still waiting for an answer. */
  get openRequests(): number {
    return this.#pending.size
  }

  /** The engine-facing UI context. Read-only or fire-and-forget methods stay local. */
  context(): ExtensionUIContext {
    const engine = this.#engine
    return {
      // See `rerenderMessage`: no terminal surface to redraw.
      refreshTranscript: () => {},
      confirm: (title, message, dialogOptions) =>
        this.#dialog({
          method: 'confirm',
          fields: { title, message },
          timeoutMs: dialogOptions?.timeout,
          signal: dialogOptions?.signal,
          onTimeout: dialogOptions?.onTimeout,
          fallback: false,
          parse: response => {
            if (response.cancelled === true) {
              if (response.timedOut === true) dialogOptions?.onTimeout?.()
              return false
            }
            return response.confirmed === true
          },
        }),
      select: (title, options, dialogOptions) => {
        const labels = options.map(option => engine.selectOptionLabel(option))
        const details = options.map(option => (typeof option === 'string' ? {} : { description: option.description ?? '' }))
        return this.#dialog({
          method: 'select',
          // The engine's own preselection facts (`ExtensionUIDialogOptions`): which row it named as
          // the cursor, whether rows carry a radio or checkbox marker, which of them are already
          // checked, and how many leading rows are markable at all (a trailing "Other" or "Done"
          // row is an action, not an answer). Forwarded as facts rather than interpreted here: a
          // checkbox list is re-shown once per toggle by its caller, so only the dialog can draw
          // the state the caller is about to read back.
          fields: {
            title,
            options: labels,
            optionDetails: details,
            ...selectPreselection(dialogOptions, labels.length),
          },
          timeoutMs: dialogOptions?.timeout,
          signal: dialogOptions?.signal,
          onTimeout: dialogOptions?.onTimeout,
          fallback: undefined,
          parse: response => this.#close(response, dialogOptions?.onTimeout),
        })
      },
      input: (title, placeholder, dialogOptions) =>
        this.#dialog({
          method: 'input',
          // `secret` is the engine's own host hint (`ExtensionUIDialogOptions`): the caller is
          // asking for a credential, and the field must not show what is typed. Forwarded as a
          // boolean fact rather than left to the dialog surface, which cannot know.
          fields: { title, placeholder, ...(dialogOptions?.secret === true ? { secret: true } : {}) },
          timeoutMs: dialogOptions?.timeout,
          signal: dialogOptions?.signal,
          onTimeout: dialogOptions?.onTimeout,
          fallback: undefined,
          parse: response => this.#close(response, dialogOptions?.onTimeout),
        }),
      editor: (title, prefill, dialogOptions, editorOptions) =>
        this.#dialog({
          method: 'editor',
          fields: { title, prefill, promptStyle: editorOptions?.promptStyle },
          timeoutMs: dialogOptions?.timeout,
          signal: dialogOptions?.signal,
          onTimeout: dialogOptions?.onTimeout,
          fallback: undefined,
          parse: response => this.#close(response, dialogOptions?.onTimeout),
        }),
      askDialog: (questions, dialogOptions) =>
        this.#dialog<ExtensionAskDialogResult | undefined>({
          method: 'ask',
          fields: { questions },
          timeoutMs: dialogOptions?.timeout,
          signal: dialogOptions?.signal,
          onTimeout: dialogOptions?.onTimeout,
          fallback: undefined,
          expireValue: () => engine.timedOutAsk(questions),
          // Two owners can reach the deadline: this host's own timer, and the desktop's expiry of
          // the same request. Both mean "the question timed out", so a timed-out response is
          // answered here rather than cancelled.
          parse: (response) => {
            if (response.timedOut === true) {
              dialogOptions?.onTimeout?.()
              return engine.timedOutAsk(questions)
            }
            return parseAskResult(response, dialogOptions?.onTimeout)
          },
        }),
      // The `ask` tool's surface since engine 18.18.3: one HTML form, drawn whole. The tool prefers
      // this over walking its fields through `select`/`input`, which is why the host implements it -
      // the field-by-field path loses the form's context blocks, its images and its validation.
      formDialog: (html, dialogOptions) => {
        const form = engine.htmlForm.parse(html)
        const defaults = engine.htmlForm.defaults(form)
        // A form with no named control is not answerable: the tool answers its own error for that,
        // so the host declines the surface and lets the engine's path handle it.
        if (form.fields.every(field => field.name === '')) return Promise.resolve(undefined)
        return this.#dialog<ExtensionFormDialogResult | undefined>({
          method: 'form',
          fields: wireForm(form),
          timeoutMs: dialogOptions?.timeout,
          signal: dialogOptions?.signal,
          onTimeout: dialogOptions?.onTimeout,
          fallback: undefined,
          // A deadline submits the form's current values, which is the contract the engine's own
          // form surface documents - and what the model was told its preselected answer means.
          expireValue: () => ({ data: defaults, timedOut: true }),
          parse: (response) => {
            // Two owners can reach the deadline: this host's own timer (handled by `expireValue`
            // above) and the desktop's expiry of the same request, which arrives as
            // `cancelled + timedOut`. Both mean "the form timed out", which the engine answers by
            // submitting its current values - not by cancelling the turn, so a timed-out response is
            // answered here rather than closed, exactly as `askDialog` does.
            if (response.timedOut === true) {
              dialogOptions?.onTimeout?.()
              return { data: defaults, timedOut: true }
            }
            if (response.cancelled === true) return undefined
            const answers = formAnswersOf(response)
            return {
              data: formResponseData(form, defaults, answers, engine.htmlForm.isArrayChoice, engine.htmlForm.textValue),
            }
          },
        })
      },
      notify: (message, type) => this.#announce('notify', { message, notifyType: type }),
      setStatus: (key, text) => this.#announce('setStatus', { statusKey: key, statusText: text }),
      setWidget: (key, content, options) => {
        // Component factories need terminal access this host does not have; string lines do not.
        if (content === undefined || Array.isArray(content)) {
          this.#announce('setWidget', {
            widgetKey: key,
            widgetLines: content ?? null,
            widgetPlacement: options?.placement,
          })
        }
      },
      setTitle: title => this.#announce('setTitle', { title }),
      setEditorText: text => this.#announce('set_editor_text', { text }),
      pasteToEditor: text => this.#announce('set_editor_text', { text }),
      getEditorText: () => '',
      onTerminalInput: () => () => {},
      // Both belong to the engine's terminal surfaces: the transcript redraw exists so an extension
      // text renderer can change what it draws after a click, and a link click needs a terminal
      // that picks one. This host draws neither (the desktop renders the transcript itself), so
      // nothing is redrawn and no renderer is told a link is pickable - the same answers the
      // engine's own headless and RPC contexts give (`modes/rpc/rpc-mode.ts`).
      rerenderMessage: () => {},
      getLinkClicksAvailable: () => false,
      setWorkingMessage: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setEditorComponent: () => {},
      // The desktop host draws no TUI editor, so nothing was ever installed — which is what the
      // engine's own headless contexts answer too (`session/agent-session.ts`). An extension that
      // wraps the factory gets `undefined` and keeps its own editor, which is the honest answer here
      // rather than a factory over a terminal the host does not have.
      getEditorComponent: () => undefined,
      addAutocompleteProvider: () => {},
      custom: () => Promise.resolve(undefined as never),
      get theme() {
        return engine.theme
      },
      getAllThemes: async () => [],
      getTheme: async () => undefined,
      setTheme: async () => ({ success: false, error: 'Theme switching is not supported by the desktop host' }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    }
  }

  /**
   * Asks the reader for one free-form text on behalf of this host, not the engine.
   *
   * The wire is the engine's own `editor` dialog, so the desktop draws it with the dialog surface
   * it already has (a titled field over the column) and answers through the same
   * `session_ui_response`. Used by the commands this host owns because the engine ships them only
   * for its terminal: `/goal` with no objective has to ask for one, which is what the terminal
   * command does with its editor.
   */
  requestText(title: string, message: string, placeholder: string): Promise<string | undefined> {
    return this.#dialog({
      method: 'editor',
      fields: { title, message, placeholder },
      timeoutMs: undefined,
      signal: undefined,
      onTimeout: undefined,
      fallback: undefined,
      parse: response => this.#close(response, undefined),
    })
  }

  /** Answers one dialog; false when the id was already settled or voided. */
  respond(requestId: string, response: Record<string, unknown>): boolean {
    const pending = this.#pending.get(requestId)
    if (pending === undefined) return false
    this.#pending.delete(requestId)
    pending.settle(response)
    return true
  }

  /** Voids every open dialog of this session; used by close, eviction, shutdown and a stop. */
  cancelAll(): number {
    let cancelled = 0
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id)
      this.#events.emit({ type: 'extension_ui_cancel', id, requestId: id })
      pending.abandon()
      cancelled += 1
    }
    return cancelled
  }

  #announce(method: string, fields: Record<string, unknown>): void {
    this.#counter += 1
    this.#events.emit({ type: 'extension_ui_request', id: `ui-${this.#counter}`, method, ...fields })
  }

  #close(response: Record<string, unknown>, onTimeout: (() => void) | undefined): string | undefined {
    if (response.cancelled === true) {
      if (response.timedOut === true) onTimeout?.()
      return undefined
    }
    return typeof response.value === 'string' ? response.value : undefined
  }

  #dialog<T>(spec: DialogSpec<T>): Promise<T> {
    if (spec.signal?.aborted === true) return Promise.resolve(spec.fallback)
    this.#counter += 1
    const id = `ui-${this.#counter}`
    const { promise, resolve } = Promise.withResolvers<T>()

    // The one teardown path: a dialog is taken down by whichever of the four endings arrives - the
    // answer, the session's own cancel, the abort signal, or the deadline - and each of them has to
    // leave nothing behind. Without it the answer path left the timer armed for the rest of the
    // dialog's deadline and kept the abort listener subscribed, so a long-timeout dialog was pinned
    // in memory after it had already been answered.
    const teardown = (): void => {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
      this.#pending.delete(id)
    }
    const onAbort = (): void => {
      if (!this.#pending.has(id)) return
      teardown()
      this.#events.emit({ type: 'extension_ui_request', id: `ui-cancel-${id}`, method: 'cancel', targetId: id })
      resolve(spec.fallback)
    }
    const timeoutMs = spec.timeoutMs ?? this.#defaultTimeoutMs
    const timer = setTimeout(() => {
      if (!this.#pending.has(id)) return
      teardown()
      // Host-side expiry: the caller is told the dialog is void, and the engine continues with
      // the dialog's default rather than waiting forever.
      this.#events.emit({ type: 'extension_ui_cancel', id, requestId: id })
      spec.onTimeout?.()
      resolve(spec.expireValue?.() ?? spec.fallback)
    }, timeoutMs)

    this.#pending.set(id, {
      settle: response => {
        teardown()
        resolve(spec.parse(response))
      },
      abandon: () => {
        teardown()
        resolve(spec.fallback)
      },
    })
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    this.#events.emit({
      type: 'extension_ui_request',
      id,
      method: spec.method,
      ...spec.fields,
      ...(spec.timeoutMs === undefined ? {} : { timeout: spec.timeoutMs }),
    })
    return promise
  }
}

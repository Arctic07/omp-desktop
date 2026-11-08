/**
 * The object one renderer module is handed: the application's own React, a slot registry, the
 * dispatch vocabulary, and a stylesheet channel.
 *
 * This is the frozen half of the contract (`rules.md#plugin-system`). The module runs in this
 * document's realm with this application's React — there is no second React copy, no import map and
 * no `window` global — so the host is deliberately small: it is the set of things a slot component
 * may do, and every one of them is bounded here. The rules themselves (vocabularies, registration
 * validation, the dispatch whitelist) live in `plugin-slot-rules.ts`, which has no IPC; this file is
 * where they meet the application's stores and the one command.
 *
 * Three rules the loader relies on:
 *
 * - **Nothing throws out of a slot's own action.** `dispatch` answers with `{ ok, code }` and surfaces
 *   the refusal as one notice; a component that awaits it sees the answer, never an exception it
 *   cannot handle.
 * - **A registration is data, not code the loader trusts.** `component` must be a function, the slot
 *   token must be in the closed set, and the key fields (`toolName`, `language`) must be well formed;
 *   the owner (the loader) decides ownership and the per-plugin bound.
 * - **A load ends exactly once.** `dispose()` removes every `ui.injectStyle` element that load
 *   appended and makes the host refuse further registrations, styles and dispatches with
 *   `PLUGIN_UNLOADED`.
 *
 * Draft and attachment actions go through this application's own stores (`state/composer-draft-store.ts`,
 * `state/composer-attachments.ts`); only `plugin.call` crosses IPC, and only for a method the row
 * declared and this side re-checked.
 */

import * as React from 'react'

import { toApiError } from '@/api/client'
import { callPluginRenderer } from '@/api/plugins'
import type { EnginePluginRendererCallResult } from '@/api/plugins-types'
import { reportClientError } from '@/lib/client-errors'
import {
  addAttachmentPaths,
  pruneAttachments,
  removeAttachment,
} from '@/state/composer-attachments'
import {
  conversationDraftKey,
  putComposerDraft,
  readComposerDraft,
  setComposerDraftText,
} from '@/state/composer-draft-store'
import {
  PLUGIN_DRAFT_TEXT_MAX_BYTES,
  PLUGIN_INSERT_TEXT_MAX_BYTES,
  dispatchRefusal,
  type PluginRendererAction,
  type PluginSlotRegistration,
} from '@/state/plugin-slot-rules'
import { activeRecord, sessionStore } from '@/state/session-store'
import { workspaceStore } from '@/state/workspace-store'

/**
 * How many stylesheets one load may append.
 *
 * Owner / bound / release (`rules.md#resource-bounds-and-release-points`): owned by the one load; at most this many `<style>`
 * elements per load (and one load per installed plugin), each capped at {@link MAX_STYLE_CHARS};
 * released by `dispose()` — the same point that unregisters the load's slots. A plugin that asks
 * for more is refused rather than allowed to grow the document without limit.
 */
export const MAX_STYLE_SHEETS_PER_LOAD = 8

/** The largest stylesheet one `injectStyle` call may append. */
const MAX_STYLE_CHARS = 256 * 1024

/** One dispatch's answer. A refusal is data: `code` is a stable token, never a sentence. */
export interface PluginDispatchAnswer {
  ok: boolean
  value?: unknown
  code?: string | null
  message?: string | null
}

/** The object a renderer module's `onLoad` receives. One per load, never written to `window`. */
export interface PluginSlotHost {
  readonly react: typeof React
  readonly plugin: {
    readonly id: string
    readonly scope: string
    readonly installId: string | null
  }
  readonly slots: {
    register(registration: PluginSlotRegistration): () => void
    unregister(handle: () => void): void
  }
  dispatch(action: string, payload?: unknown): Promise<PluginDispatchAnswer>
  readonly ui: {
    injectStyle(css: string): () => void
  }
}

/** What the loader supplies: the row's facts and the sinks the load owns. */
export interface PluginSlotHostOwner {
  readonly pluginId: string
  readonly scope: string
  readonly installId: string | null
  /** The row's declared whitelists, as the manifest wrote them. */
  readonly actions: readonly string[]
  readonly callMethods: readonly string[]
  /** Hand one validated registration to the registry; answers its disposer. */
  register(registration: PluginSlotRegistration): () => void
  /** Claim one stylesheet slot for this load; false when the budget is spent. */
  claimStyleSheet(): boolean
  /** One console-free notice for a refusal the reader can see. */
  notice(token: string): void
  /** Whether this load has ended (unloaded, disabled, replaced, or its module failed). */
  ended(): boolean
}

/** The host, together with what only the loader may call. */
export interface PluginSlotHostHandle {
  readonly host: PluginSlotHost
  /** End the load's side effects: every style element it appended goes with it. */
  dispose(): void
}

/** A refusal a plugin's own code can catch (`injectStyle` has no answer object to fill). */
export class PluginHostError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PluginHostError'
    this.code = code
  }
}

function refusal(code: string, message: string | null = null): PluginDispatchAnswer {
  return { ok: false, code, message }
}

/** `plugin.call`'s payload, parsed once at the boundary: the method is the only required field. */
function callPayload(payload: unknown): { method: string; params: unknown } | null {
  if (typeof payload !== 'object' || payload === null) return null
  if (!('method' in payload) || typeof payload.method !== 'string') return null
  return { method: payload.method, params: 'params' in payload ? payload.params : null }
}

/** `composer.insertText` / `composer.replaceDraft`: the replacement text, or null when absent. */
function textPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  if (!('text' in payload) || typeof payload.text !== 'string') return null
  return payload.text
}

/** `attachments.add`: every well-formed path the plugin handed over. */
function pathPayload(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  if (!('paths' in payload) || !Array.isArray(payload.paths)) return []
  return payload.paths.filter((path): path is string => typeof path === 'string')
}

/** `attachments.remove`: the token naming one attachment of this draft. */
function tokenPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  if (!('token' in payload) || typeof payload.token !== 'string') return null
  return payload.token
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * The seat the composer's draft belongs to right now.
 *
 * The same reading the composer's own controls use: a pin set while a conversation opens wins,
 * otherwise the record on screen decides, otherwise the empty seat. An insertion lands in the draft
 * the reader is looking at, never in another conversation's.
 */
function activeDraftKey(): string {
  const state = sessionStore.get()
  return state.openingSeat ?? conversationDraftKey(activeRecord(state))
}

/** The attachments as JSON the plugin can read: the record's own fields, nothing derived. */
function attachmentRecords(key: string): Record<string, unknown>[] {
  return readComposerDraft(key).attachments.map((attachment) => ({
    token: attachment.token,
    name: attachment.name,
    path: attachment.path,
    mimeType: attachment.mimeType,
    bytes: attachment.bytes,
  }))
}

/** `@import` is not a rule this document runs: the stylesheet channel is the plugin's own CSS. */
const STYLE_IMPORT = /@import\b/i

/** A `url()` that names anything but a `data:` payload would reach the network off the CSS. */
function hasRemoteUrl(css: string): boolean {
  for (const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const target = (match[2] ?? '').trim().toLowerCase()
    if (!target.startsWith('data:')) return true
  }
  return false
}

/**
 * Build one load's host.
 *
 * `ended()` and the owner's own registry are the only two facts the host reads from the loader;
 * everything else is the row's whitelist and this application's stores. No value here is cached
 * across loads, and nothing here is shared between two installations of the same plugin.
 */
export function createPluginSlotHost(owner: PluginSlotHostOwner): PluginSlotHostHandle {
  const declaration = { actions: owner.actions, callMethods: owner.callMethods }
  const styles = new Set<HTMLStyleElement>()
  let disposed = false

  const live = (): boolean => !disposed && !owner.ended()

  const refuse = (code: string): PluginDispatchAnswer => {
    owner.notice(code)
    return refusal(code)
  }

  async function pluginCall(request: { method: string; params: unknown }): Promise<PluginDispatchAnswer> {
    let answer: EnginePluginRendererCallResult
    try {
      answer = await callPluginRenderer(
        workspaceStore.get().activeId,
        owner.pluginId,
        owner.scope,
        request.method,
        request.params,
      )
    } catch (error) {
      const failure = toApiError(error)
      owner.notice(failure.code)
      return refusal(failure.code, failure.message)
    }
    // The worker's refusal is its own answer: the component states the code beside its own control.
    if (!answer.ok) owner.notice(answer.code ?? 'PLUGIN_CALL_FAILED')
    return answer
  }

  function insertText(payload: unknown): PluginDispatchAnswer {
    const text = textPayload(payload)
    if (text === null || utf8Length(text) > PLUGIN_INSERT_TEXT_MAX_BYTES) {
      return refuse('PLUGIN_ACTION_INVALID_PAYLOAD')
    }
    const key = activeDraftKey()
    // The draft store is the only text this side can write; the caret belongs to the field, which
    // is not reachable from a slot. An insert therefore appends, and the reader's caret is left
    // where it was — the honest shape of "against the composer draft store" (plan §7.3).
    setComposerDraftText(key, `${readComposerDraft(key).text}${text}`)
    return { ok: true, value: { ok: true } }
  }

  function replaceDraft(payload: unknown): PluginDispatchAnswer {
    const text = textPayload(payload)
    if (text === null || utf8Length(text) > PLUGIN_DRAFT_TEXT_MAX_BYTES) {
      return refuse('PLUGIN_ACTION_INVALID_PAYLOAD')
    }
    const key = activeDraftKey()
    putComposerDraft(key, text, readComposerDraft(key).attachments)
    // Records the replacement no longer names are files the reader took out of the prompt.
    pruneAttachments(key, text)
    return { ok: true, value: { ok: true } }
  }

  async function addAttachments(payload: unknown): Promise<PluginDispatchAnswer> {
    const wanted = pathPayload(payload)
    if (wanted.length === 0) return refuse('PLUGIN_ACTION_INVALID_PAYLOAD')
    const imported = await addAttachmentPaths(activeDraftKey(), wanted)
    if (imported.refusal !== null) {
      return refuse(
        imported.refusal.kind === 'desktop'
          ? imported.refusal.error.code
          : 'PLUGIN_ATTACHMENT_REFUSED',
      )
    }
    return {
      ok: true,
      value: {
        added: imported.added.map((attachment) => ({
          token: attachment.token,
          name: attachment.name,
          path: attachment.path,
          mimeType: attachment.mimeType,
          bytes: attachment.bytes,
        })),
      },
    }
  }

  function removeAttachments(payload: unknown): PluginDispatchAnswer {
    const token = tokenPayload(payload)
    if (token === null) return refuse('PLUGIN_ACTION_INVALID_PAYLOAD')
    removeAttachment(activeDraftKey(), token)
    return { ok: true, value: { ok: true } }
  }

  async function dispatch(action: string, payload?: unknown): Promise<PluginDispatchAnswer> {
    if (!live()) return refusal('PLUGIN_UNLOADED')
    const request = action === 'plugin.call' ? callPayload(payload) : null
    const refused = dispatchRefusal(action, declaration, request?.method)
    if (refused !== null) return refuse(refused)
    // A slot's action never rejects: a store write that throws is a failure of this side, answered
    // as one line in the log and a refusal the component can read.
    try {
      switch (action as PluginRendererAction) {
        case 'plugin.call':
          return request === null
            ? refuse('PLUGIN_ACTION_INVALID_PAYLOAD')
            : await pluginCall(request)
        case 'composer.insertText':
          return insertText(payload)
        case 'composer.readDraft': {
          const key = activeDraftKey()
          return {
            ok: true,
            value: { text: readComposerDraft(key).text, attachments: attachmentRecords(key) },
          }
        }
        case 'composer.replaceDraft':
          return replaceDraft(payload)
        case 'attachments.add':
          return await addAttachments(payload)
        case 'attachments.list':
          return { ok: true, value: { attachments: attachmentRecords(activeDraftKey()) } }
        case 'attachments.remove':
          return removeAttachments(payload)
      }
    } catch (error) {
      reportClientError('a plugin action failed', error, action)
      return refuse('PLUGIN_ACTION_FAILED')
    }
  }

  function injectStyle(css: string): () => void {
    if (!live()) throw new PluginHostError('PLUGIN_UNLOADED', 'This renderer load has ended.')
    if (typeof css !== 'string' || css.trim() === '') {
      throw new PluginHostError('PLUGIN_STYLE_INVALID', 'injectStyle takes a non-empty string.')
    }
    if (css.length > MAX_STYLE_CHARS) {
      throw new PluginHostError('PLUGIN_STYLE_INVALID', 'This stylesheet is past the size ceiling.')
    }
    if (STYLE_IMPORT.test(css)) {
      throw new PluginHostError('PLUGIN_STYLE_INVALID', '@import is not accepted here.')
    }
    if (hasRemoteUrl(css)) {
      throw new PluginHostError('PLUGIN_STYLE_INVALID', 'url() must be a data: URL.')
    }
    if (!owner.claimStyleSheet()) {
      throw new PluginHostError('PLUGIN_STYLE_INVALID', 'This load has appended enough stylesheets.')
    }
    const element = document.createElement('style')
    element.dataset.plugin = owner.pluginId
    // Untrusted text: it is CSS source for this document's style engine, never markup.
    element.textContent = css
    document.head.append(element)
    styles.add(element)
    return () => {
      styles.delete(element)
      element.remove()
    }
  }

  const host: PluginSlotHost = {
    react: React,
    plugin: Object.freeze({
      id: owner.pluginId,
      scope: owner.scope,
      installId: owner.installId,
    }),
    slots: {
      register(registration: PluginSlotRegistration): () => void {
        if (!live()) {
          owner.notice('PLUGIN_UNLOADED')
          return () => {}
        }
        return owner.register(registration)
      },
      unregister(handle: () => void): void {
        if (typeof handle === 'function') handle()
      },
    },
    dispatch,
    ui: { injectStyle },
  }

  return {
    host,
    dispose() {
      disposed = true
      for (const element of styles) element.remove()
      styles.clear()
    },
  }
}

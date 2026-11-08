/**
 * The renderer-slot contract, as rules: the closed vocabularies, the registration registry, the
 * fence-tag parser, the dispatch whitelist and the load plan.
 *
 * This module is deliberately free of React components, IPC and application stores (it imports only
 * the store primitive): everything here is decided from data, which is what lets the slot contract
 * be tested without a window, a plugin module or a host process. `plugin-slot-host.ts` builds the
 * object a module is handed on top of it, and `plugin-slots.ts` runs the module lifecycle.
 *
 * The three closed sets are the contract (`rules.md#plugin-system`): the slot tokens that may be
 * mounted, the dispatch vocabulary a manifest may whitelist, and the sides a composer control may
 * occupy. A token outside its set is refused, never guessed at.
 */

import type { ComponentType } from 'react'

import type { PluginRow } from '../api/plugins-types'
import { createStore } from './store.ts'

/* ------------------------------------------------------------------ the contract */

/** The slots this build mounts. Nothing else is a slot, and nothing else is accepted. */
export const PLUGIN_SLOT_TOKENS = [
  'composer.toolbar',
  'composer.suggestion',
  'message.actions.user',
  'message.actions.assistant',
  'message.extra',
  'tool.card',
  'code.block',
] as const

export type PluginSlotToken = (typeof PLUGIN_SLOT_TOKENS)[number]

/** The sides a `composer.toolbar` control may occupy. */
export const PLUGIN_SLOT_POSITIONS = ['left', 'right'] as const

export type PluginSlotPosition = (typeof PLUGIN_SLOT_POSITIONS)[number]

/** The closed dispatch vocabulary (`manifest.rendererActions` may only name these). */
export const PLUGIN_RENDERER_ACTIONS = [
  'plugin.call',
  'composer.insertText',
  'composer.readDraft',
  'composer.replaceDraft',
  'attachments.add',
  'attachments.list',
  'attachments.remove',
] as const

export type PluginRendererAction = (typeof PLUGIN_RENDERER_ACTIONS)[number]

/** The vocabulary as a lookup; the prototype is not part of it (`constructor` is not an action). */
const ACTION_LOOKUP: Readonly<Record<string, true>> = Object.fromEntries(
  PLUGIN_RENDERER_ACTIONS.map((action) => [action, true as const]),
)

const SLOT_LOOKUP: Readonly<Record<string, true>> = Object.fromEntries(
  PLUGIN_SLOT_TOKENS.map((slot) => [slot, true as const]),
)

const POSITION_LOOKUP: Readonly<Record<string, true>> = Object.fromEntries(
  PLUGIN_SLOT_POSITIONS.map((position) => [position, true as const]),
)

/** `composer.insertText`'s ceiling, in UTF-8 bytes (the manifest's own limit, plan §7.1). */
export const PLUGIN_INSERT_TEXT_MAX_BYTES = 32 * 1024

/** `composer.replaceDraft`'s ceiling, in UTF-8 bytes: the whole draft, not an insertion. */
export const PLUGIN_DRAFT_TEXT_MAX_BYTES = 256 * 1024

/**
 * How many registrations one installation may hold.
 *
 * Owner / bound / release (`rules.md#resource-bounds-and-release-points`): owned by the installation's load; at most this many
 * live entries per `(id, scope)`; released by the load's end — the same point that ends the module,
 * and the only one that can (a registration's own disposer releases it earlier, which is also how a
 * plugin replaces a component).
 */
export const MAX_REGISTRATIONS_PER_PLUGIN = 32

/** A slot component: a React function component, built with the React the host hands over. */
export type PluginSlotComponent = ComponentType<Record<string, unknown>>

/** What `host.slots.register` is handed. Untrusted: every field is validated here. */
export interface PluginSlotRegistration {
  readonly slot: string
  /** The component itself; validated as a function before anything is mounted. */
  readonly component: unknown
  /** `composer.toolbar` only: the sides it occupies; omitted means both. */
  readonly positions?: readonly string[]
  /** `tool.card` only: the bare tool name this card draws. */
  readonly toolName?: string
  /** `code.block` only: `<lang>` (or the full `<pluginId>:<lang>` tag) this renderer answers. */
  readonly language?: string
  /** `composer.suggestion` only: the lines the suggestion offers. */
  readonly items?: readonly string[]
  /**
   * `composer.suggestion` only: what Tab's accept gesture does.
   *
   * The component draws the line, but the keystroke belongs to the composer field, so the plugin has
   * to hand the accept's own act over: without it Tab only folds the line away. Additive to the
   * frozen registration shape, and refused on every other slot.
   */
  readonly onAccept?: () => void
}

/* ------------------------------------------------------------------ the registry */

/** One registration, as the mount points address it. */
export interface PluginSlotEntry {
  readonly id: number
  readonly pluginKey: string
  readonly pluginId: string
  readonly scope: string
  readonly slot: PluginSlotToken
  readonly component: PluginSlotComponent
  /** `null` for "both sides"; only `composer.toolbar` reads this. */
  readonly positions: readonly PluginSlotPosition[] | null
  readonly toolName: string | null
  /** `code.block`: the `<lang>` half, lower-cased. */
  readonly language: string | null
  readonly items: readonly string[]
  readonly onAccept: (() => void) | null
}

export interface PluginSlotsState {
  readonly entries: readonly PluginSlotEntry[]
}

/** The one array a store with no registrations holds, so its subscribers see one identity. */
const NO_ENTRIES: readonly PluginSlotEntry[] = []

export const pluginSlotStore = createStore<PluginSlotsState>({ entries: NO_ENTRIES })

/** Why a registration was refused. Every one is a token, never a sentence. */
export type SlotRefusalToken =
  | 'renderer_slot_unknown'
  | 'renderer_slot_invalid_component'
  | 'renderer_slot_invalid_key'
  | 'renderer_slot_invalid_position'
  | 'renderer_slot_not_owned'
  | 'renderer_slot_duplicate'
  | 'renderer_slot_limit'

/** Who one registration belongs to: the installation, as the row names it. */
export interface SlotOwnerIdentity {
  readonly pluginKey: string
  readonly pluginId: string
  readonly scope: string
}

/**
 * The engine's own tool names, mirrored from `packages/coding-agent/src/tools/builtin-names.ts`.
 *
 * A renderer's `tool.card` draws *its plugin's* tool, never one of the engine's: a plugin that could
 * skin `read` or `bash` would be drawing a card for a call it does not own. The list is closed, so
 * it is refused at registration rather than guessed at mount time, and `Object.hasOwn` keeps a
 * prototype key (`constructor`) from reading as a built-in.
 */
const ENGINE_TOOL_NAMES: Readonly<Record<string, true>> = Object.fromEntries(
  [
    'read',
    'bash',
    'edit',
    'ast_grep',
    'ast_edit',
    'ask',
    'debug',
    'eval',
    'github',
    'glob',
    'grep',
    'find',
    'lsp',
    'checkpoint',
    'rewind',
    'context_notes',
    'new_context',
    'security_scan',
    'task',
    'hub',
    'todo',
    'web_search',
    'write',
    'memory_edit',
    'retain',
    'recall',
    'reflect',
    'learn',
    'manage_skill',
    // Hidden built-ins: the model never calls them by name, but they are still the engine's.
    'yield',
    'goal',
    'think',
    // The legacy alias `normalizeToolName` folds into `grep`.
    'search',
  ].map((name) => [name, true as const]),
)

/** The language half of a fence tag this build will consider, or null. */
const BLOCK_LANGUAGE = /^[a-z0-9][a-z0-9_+-]*$/

/** The plugin id half of a fence tag: the shape a plugin id may take. */
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]*$/

/** The token a slot name stands for, or null when it is outside the closed set. */
export function slotTokenOf(value: unknown): PluginSlotToken | null {
  return typeof value === 'string' && Object.hasOwn(SLOT_LOOKUP, value)
    ? (value as PluginSlotToken)
    : null
}

/**
 * `positions` as the closed set: `undefined` when absent (both sides), `null` when malformed.
 */
export function positionsOf(value: unknown): readonly PluginSlotPosition[] | null | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  const sides: PluginSlotPosition[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !Object.hasOwn(POSITION_LOOKUP, item)) return null
    if (!sides.includes(item as PluginSlotPosition)) sides.push(item as PluginSlotPosition)
  }
  return sides
}

/** The component, when the registration carries one; anything else is not mountable. */
export function componentOf(value: unknown): PluginSlotComponent | null {
  return typeof value === 'function' ? (value as PluginSlotComponent) : null
}

/**
 * Split a fence tag written as `<pluginId>:<lang>`.
 *
 * The host parses the tag before it looks anything up (`§7.2`): no colon, an empty half, a second
 * colon or a character either half may not carry is "not a plugin fence" and the block stays this
 * application's own code block. Both halves are lower-cased for comparison — a model writes
 * `MyPlugin:Mermaid` as readily as the canonical spelling.
 */
export function parsePluginFenceLanguage(tag: string): { pluginId: string; language: string } | null {
  const trimmed = tag.trim()
  const separator = trimmed.indexOf(':')
  if (separator <= 0 || separator === trimmed.length - 1) return null
  if (trimmed.indexOf(':', separator + 1) !== -1) return null
  const pluginId = trimmed.slice(0, separator).trim().toLowerCase()
  const language = trimmed.slice(separator + 1).trim().toLowerCase()
  if (!PLUGIN_ID.test(pluginId) || !BLOCK_LANGUAGE.test(language)) return null
  return { pluginId, language }
}

type BlockLanguage = { readonly language: string } | { readonly refusal: SlotRefusalToken }

/**
 * The language a `code.block` registration answers, or why it cannot.
 *
 * A registration may name the bare language (`mermaid`) or the full tag (`omp.charts:mermaid`); the
 * prefixed form has to name *this* plugin, which is what keeps one plugin from answering another's
 * fences. The answer is tagged: a refusal is a token and a language is a token-shaped string, so
 * "is it a string" cannot tell them apart.
 */
function registeredBlockLanguage(value: unknown, pluginId: string): BlockLanguage {
  if (typeof value !== 'string') return { refusal: 'renderer_slot_invalid_key' }
  const bare = value.trim().toLowerCase()
  const tagged = parsePluginFenceLanguage(value)
  if (tagged !== null) {
    return tagged.pluginId === pluginId.toLowerCase()
      ? { language: tagged.language }
      : { refusal: 'renderer_slot_not_owned' }
  }
  return BLOCK_LANGUAGE.test(bare)
    ? { language: bare }
    : { refusal: 'renderer_slot_invalid_key' }
}

/**
 * Resolve one `slots.register` into an entry, or the token saying why it was refused.
 *
 * Pure: the caller owns the id counter and the live entry list, which is what lets the registration
 * rules be tested without starting a module or a window.
 */
export function slotEntryFor(
  owner: SlotOwnerIdentity,
  registration: unknown,
  existing: readonly PluginSlotEntry[],
  id: number,
): PluginSlotEntry | SlotRefusalToken {
  if (typeof registration !== 'object' || registration === null) {
    return 'renderer_slot_invalid_component'
  }
  const slot = 'slot' in registration ? slotTokenOf(registration.slot) : null
  if (slot === null) return 'renderer_slot_unknown'
  const component = 'component' in registration ? componentOf(registration.component) : null
  if (component === null) return 'renderer_slot_invalid_component'
  if (
    existing.filter((entry) => entry.pluginKey === owner.pluginKey).length >=
    MAX_REGISTRATIONS_PER_PLUGIN
  ) {
    return 'renderer_slot_limit'
  }
  const declaredPositions = 'positions' in registration ? positionsOf(registration.positions) : undefined
  if (declaredPositions === null) return 'renderer_slot_invalid_position'
  const positions = declaredPositions ?? null
  if (positions !== null && positions.length > 0 && slot !== 'composer.toolbar') {
    return 'renderer_slot_invalid_position'
  }

  let toolName: string | null = null
  let language: string | null = null
  let items: readonly string[] = []
  let onAccept: (() => void) | null = null

  if (slot === 'tool.card') {
    const declared = 'toolName' in registration ? registration.toolName : undefined
    toolName = typeof declared === 'string' ? declared.trim() : ''
    if (toolName === '') return 'renderer_slot_invalid_key'
    // Ownership, as far as the row can state it: an engine tool is not a plugin's, and one tool
    // name belongs to one plugin at a time. The second is not a latch — when the winner's load ends
    // its entry leaves this list, so the next plugin to register that name gets it (t3-host, 10-26).
    if (Object.hasOwn(ENGINE_TOOL_NAMES, toolName)) return 'renderer_slot_not_owned'
    if (existing.some((entry) => entry.slot === 'tool.card' && entry.toolName === toolName)) {
      return 'renderer_slot_duplicate'
    }
  }

  if (slot === 'code.block') {
    const declared = 'language' in registration ? registration.language : undefined
    const resolved = registeredBlockLanguage(declared, owner.pluginId)
    if ('refusal' in resolved) return resolved.refusal
    language = resolved.language
    const taken = existing.some(
      (entry) =>
        entry.slot === 'code.block' &&
        entry.pluginId === owner.pluginId &&
        entry.language === language,
    )
    if (taken) return 'renderer_slot_duplicate'
  }

  if (slot === 'composer.suggestion') {
    const declared = 'items' in registration ? registration.items : undefined
    if (declared !== undefined) {
      if (!Array.isArray(declared) || !declared.every((item) => typeof item === 'string')) {
        return 'renderer_slot_invalid_key'
      }
      items = declared
    }
    const accept = 'onAccept' in registration ? registration.onAccept : undefined
    if (accept !== undefined) {
      if (typeof accept !== 'function') return 'renderer_slot_invalid_key'
      // The plugin is plain JS: the only readable fact is that it is callable.
      onAccept = accept as () => void
    }
  }

  return {
    id,
    pluginKey: owner.pluginKey,
    pluginId: owner.pluginId,
    scope: owner.scope,
    slot,
    component,
    positions: slot === 'composer.toolbar' ? positions : null,
    toolName,
    language,
    items,
    onAccept,
  }
}

/* The live registrations. `nextEntryId` never resets: an entry's id is its identity in the store. */
let nextEntryId = 1
const liveEntries = new Map<number, PluginSlotEntry>()

function publish(): void {
  const entries = liveEntries.size === 0 ? NO_ENTRIES : [...liveEntries.values()]
  pluginSlotStore.set({ entries })
}

/** What `registerSlot` answered: the entry now mounted, or the token that refused it. */
export type SlotRegistrationOutcome =
  | { readonly entry: PluginSlotEntry }
  | { readonly refusal: SlotRefusalToken }

/**
 * Validate and mount one registration.
 *
 * The only writer of the registry's live map; `releaseSlot` is the only remover. Both are reached
 * from the loader, which is also where the per-load notices live — a refusal handed back here is
 * shown once per load by the caller.
 */
export function registerSlot(
  owner: SlotOwnerIdentity,
  registration: unknown,
): SlotRegistrationOutcome {
  const resolved = slotEntryFor(owner, registration, [...liveEntries.values()], nextEntryId)
  if (typeof resolved === 'string') return { refusal: resolved }
  nextEntryId += 1
  liveEntries.set(resolved.id, resolved)
  publish()
  return { entry: resolved }
}

/** Unmount one registration; calling it again does nothing. */
export function releaseSlot(id: number): void {
  if (!liveEntries.delete(id)) return
  publish()
}

/* ------------------------------------------------------------------ selectors */

/** The entries one mount point renders, in registration order. */
export function slotEntriesFor(
  entries: readonly PluginSlotEntry[],
  slot: PluginSlotToken,
  position?: PluginSlotPosition,
): readonly PluginSlotEntry[] {
  return entries.filter(
    (entry) =>
      entry.slot === slot &&
      (position === undefined || entry.positions === null || entry.positions.includes(position)),
  )
}

/**
 * The renderer for one fenced block, or null.
 *
 * Two facts have to line up: the fence names `<pluginId>:<lang>`, and a registration of *that*
 * plugin answers `<lang>`. A tag naming a plugin that registered nothing, or naming another plugin
 * than the one that registered the language, mounts nothing — the block stays a code block.
 */
export function codeBlockEntryFor(
  entries: readonly PluginSlotEntry[],
  tag: string,
): PluginSlotEntry | null {
  const parsed = parsePluginFenceLanguage(tag)
  if (parsed === null) return null
  return (
    entries.find(
      (entry) =>
        entry.slot === 'code.block' &&
        entry.pluginId.toLowerCase() === parsed.pluginId &&
        entry.language === parsed.language,
    ) ?? null
  )
}

/** The card for one tool call, keyed by the tool name; ownership was settled at registration. */
export function toolCardEntryFor(
  entries: readonly PluginSlotEntry[],
  toolName: string,
): PluginSlotEntry | null {
  return entries.find((entry) => entry.slot === 'tool.card' && entry.toolName === toolName) ?? null
}

/** The two engine tools a plugin's own tool is reached through (`xd://<name>` device calls). */
const DEVICE_CARRIER_NAMES: Readonly<Record<string, true>> = { read: true, write: true }

/** The device scheme a plugin tool is addressed by. */
const DEVICE_SCHEME = 'xd://'

/**
 * The name a `tool.card` should be looked up by for one call.
 *
 * A plugin's custom tool does not arrive as a tool of its own name in this build: the engine exposes
 * it as a *device*, so the transcript row is the carrier (`read` for the docs, `write` for the call)
 * and the tool it actually ran is the `xd://<name>` path in its arguments. Looking the card up by
 * the carrier's name would therefore never match anything a plugin registered, which is why the
 * name is read out of the call rather than off the row.
 *
 * Everything else keeps its own name: a carrier call that is not a device (a real `read` of a file),
 * a device that is not a plugin tool (`skill://`, `rule://`), and any tool this build does not route
 * through a carrier all look up under the name the row already has.
 */
export function toolCardNameOf(call: { name: string; argsText: string }): string {
  const name = call.name.trim()
  if (DEVICE_CARRIER_NAMES[name] !== true) return name
  const args = parseArgsText(call.argsText)
  if (args === null || typeof args !== 'object' || !('path' in args)) return name
  const target = args.path
  if (typeof target !== 'string') return name
  const trimmed = target.trim()
  if (!trimmed.startsWith(DEVICE_SCHEME)) return name
  const device = trimmed.slice(DEVICE_SCHEME.length)
  return device === '' ? name : device
}

/** One call's arguments as JSON, or null when they are not JSON this side reads. */
function parseArgsText(argsText: string): Record<string, unknown> | null {
  if (argsText.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(argsText)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------- dispatch */

/** The row's declared whitelists, as the manifest wrote them. */
export interface DispatchDeclaration {
  readonly actions: readonly string[]
  readonly callMethods: readonly string[]
}

/**
 * Why one dispatch may not run, or null when it may.
 *
 * The order is the contract's: a word outside the vocabulary is `PLUGIN_ACTION_UNKNOWN`; a word the
 * vocabulary has but the manifest did not whitelist is `PLUGIN_ACTION_UNDECLARED`; and a
 * `plugin.call` whose method is not in `rendererCallMethods` is refused before it can reach the
 * worker (`§7.3`). The slot host calls exactly this, so what is tested is what is enforced.
 */
export function dispatchRefusal(
  action: unknown,
  declaration: DispatchDeclaration,
  method?: unknown,
): string | null {
  if (typeof action !== 'string' || !Object.hasOwn(ACTION_LOOKUP, action)) {
    return 'PLUGIN_ACTION_UNKNOWN'
  }
  if (!declaration.actions.includes(action)) return 'PLUGIN_ACTION_UNDECLARED'
  if (action === 'plugin.call') {
    if (typeof method !== 'string' || !declaration.callMethods.includes(method)) {
      return 'PLUGIN_ACTION_UNDECLARED'
    }
  }
  return null
}

/* --------------------------------------------------------------------- loading */

/** What one installation's renderer looks like from the row. */
export interface SlotRendererTarget {
  readonly pluginKey: string
  readonly pluginId: string
  readonly scope: string
  readonly installId: string | null
  /** The fixed-host URL the Rust boundary served; the only field that makes a load possible. */
  readonly url: string
  readonly actions: readonly string[]
  readonly callMethods: readonly string[]
  /** Same revision means the same module: a plain list refresh must not reload it. */
  readonly revision: string
}

/** The identity half of a live load, which is all a reconcile plan reads. */
export interface SlotLoadIdentity {
  readonly pluginKey: string
  readonly revision: string
}

export interface SlotReconcilePlan {
  /** Installations whose load must end: gone, disabled, invalid, or replaced by a new revision. */
  readonly unload: readonly string[]
  readonly load: readonly SlotRendererTarget[]
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * The renderer one row asks this build to load, or null.
 *
 * `available === false` is the boundary refusing the installation; a missing `available` (a Rust
 * build that serves `url` without the verdict) reads as true. `renderer` absent is a pre-T3 host:
 * nothing declared, not a failure.
 */
export function rendererTargetOf(row: PluginRow): SlotRendererTarget | null {
  if (!row.enabled) return null
  const desktop = row.desktop
  if (desktop === null || !desktop.valid) return null
  const renderer = desktop.renderer ?? null
  if (renderer === null) return null
  if (renderer.available === false) return null
  const url = typeof renderer.url === 'string' ? renderer.url.trim() : ''
  if (url === '') return null
  const installId = row.installId
  return {
    pluginKey: `${row.id}\u0000${row.scope}`,
    pluginId: row.id,
    scope: row.scope,
    installId,
    url,
    actions: stringsOf(renderer.actions),
    callMethods: stringsOf(renderer.callMethods),
    revision: [installId ?? '', row.lastUpdated ?? '', row.version ?? '', url].join('\u0000'),
  }
}

/** Which loads a list read starts and ends. Pure, so the lifecycle rules are testable. */
export function planSlotReconcile(
  current: readonly SlotLoadIdentity[],
  rows: readonly PluginRow[],
): SlotReconcilePlan {
  const wanted = new Map<string, SlotRendererTarget>()
  for (const row of rows) {
    const target = rendererTargetOf(row)
    if (target !== null) wanted.set(target.pluginKey, target)
  }
  const known = new Map(current.map((load) => [load.pluginKey, load.revision]))
  const unload: string[] = []
  for (const load of current) {
    const target = wanted.get(load.pluginKey)
    if (target === undefined || target.revision !== load.revision) unload.push(load.pluginKey)
  }
  const load: SlotRendererTarget[] = []
  for (const [key, target] of wanted) {
    if (known.get(key) !== target.revision) load.push(target)
  }
  return { unload, load }
}

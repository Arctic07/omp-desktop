/**
 * The renderer modules installed plugins ship: when each one loads, and when it ends.
 *
 * One module per installation, fetched lazily from the URL the Rust boundary serves (the fixed slot
 * host of plan §D2), evaluated in this document's realm and handed a fresh `host` object
 * (`state/plugin-slot-host.ts`). What it registers becomes an entry in the registry
 * (`state/plugin-slot-rules.ts`); the six mount points resolve their slot out of that registry.
 *
 * Three invariants hold the whole thing together:
 *
 * - **One load per installation.** The map is keyed by `(id, scope)`, and a load's identity is
 *   `(installId, lastUpdated, version, url)`: a plain list refresh keeps the module, an upgrade,
 *   a disable or an uninstall ends it (`planSlotReconcile`). Ending a load unregisters everything it
 *   registered, removes every stylesheet it injected and calls its `onUnload`.
 * - **A failure mounts nothing, and stays failed.** A fetch error, a module with no `onLoad`, a
 *   throw out of `onLoad` or a refused registration marks the load failed with its reason token and
 *   publishes one inline notice; the surrounding UI never sees an exception. The failed record stays
 *   until its revision changes, so a list refresh does not retry a module that cannot load.
 * - **Every code path is bounded.** At most one load per installation and at most
 *   `MAX_STYLE_SHEETS_PER_LOAD` injected stylesheets per load (`plugin-slot-host.ts`); registrations
 *   are bounded by `MAX_REGISTRATIONS_PER_PLUGIN` (`plugin-slot-rules.ts`). The only release point is
 *   `endLoad`, which `reconcileSlots`, a disable and an uninstall all reach (`rules.md#resource-bounds-and-release-points`).
 *
 * A module runs in this application's realm and can read the document. That is not a sandbox and is
 * not claimed to be one: `renderer.extension` is the permission that trusts it (plan §D2).
 */

import type { PluginRow } from '@/api/plugins-types'
import { reportClientError } from '@/lib/client-errors'
import { showPluginNotice } from '@/state/plugin-notice'
import {
  MAX_STYLE_SHEETS_PER_LOAD,
  PluginHostError,
  createPluginSlotHost,
  type PluginSlotHost,
  type PluginSlotHostHandle,
  type PluginSlotHostOwner,
} from '@/state/plugin-slot-host'
import {
  planSlotReconcile,
  registerSlot,
  releaseSlot,
  type PluginSlotRegistration,
  type SlotRendererTarget,
} from '@/state/plugin-slot-rules'

/** What a renderer module may export (`desktop/renderer.mjs`). */
interface RendererModule {
  onLoad?: (host: PluginSlotHost) => unknown
  onUnload?: () => unknown
}

type LoadPhase = 'loading' | 'ready' | 'failed'

interface RendererLoad {
  readonly target: SlotRendererTarget
  phase: LoadPhase
  reason: string | null
  ended: boolean
  module: RendererModule | null
  host: PluginSlotHostHandle | null
  /** Ids this load registered, so ending it removes exactly its own entries. */
  readonly registered: Set<number>
  readonly notices: Set<string>
  styles: number
}

/** The live loads, keyed by `(id, scope)` — one per installation, by construction. */
const loads = new Map<string, RendererLoad>()

/**
 * One console-free notice per load.
 *
 * A plugin that fires the same refusal in a render loop says one thing once; the stack is the
 * window's only inline notice surface, and the token is the vocabulary the page states verbatim.
 */
function notice(load: RendererLoad, token: string): void {
  if (load.notices.has(token)) return
  load.notices.add(token)
  showPluginNotice({
    pluginId: load.target.pluginId,
    pluginName: load.target.pluginId,
    title: token,
    body: '',
  })
}

/**
 * The module's own exports, read defensively.
 *
 * A renderer entry is plain JavaScript authored by someone else: this is the boundary that decides
 * whether it is module-shaped at all, and the only unchecked cast is the callable's signature (a
 * function cannot be checked for its parameters at runtime).
 */
function asRendererModule(value: unknown): RendererModule {
  if (typeof value !== 'object' || value === null) return {}
  const module: RendererModule = {}
  const onLoad = 'onLoad' in value ? value.onLoad : undefined
  if (typeof onLoad === 'function') module.onLoad = onLoad as (host: PluginSlotHost) => unknown
  const onUnload = 'onUnload' in value ? value.onUnload : undefined
  if (typeof onUnload === 'function') module.onUnload = onUnload as () => unknown
  return module
}

/** Take back every registration a load made. */
function releaseRegistrations(load: RendererLoad): void {
  for (const id of load.registered) releaseSlot(id)
  load.registered.clear()
}

/** End one load: unregister, remove styles, tell the module, forget it. */
function endLoad(load: RendererLoad): void {
  load.ended = true
  try {
    load.module?.onUnload?.()
  } catch (error) {
    reportClientError('a plugin renderer module failed to unload', error, load.target.pluginKey)
  }
  load.host?.dispose()
  load.host = null
  releaseRegistrations(load)
  loads.delete(load.target.pluginKey)
}

/** Mark one load failed and take back everything it did manage to mount. */
function failLoad(load: RendererLoad, reason: string): void {
  load.ended = true
  load.phase = 'failed'
  load.reason = reason
  notice(load, reason)
  load.host?.dispose()
  load.host = null
  releaseRegistrations(load)
}

/** The host's owner half: registration, the stylesheet budget, notices and the load's end. */
function hostOwnerFor(load: RendererLoad): PluginSlotHostOwner {
  return {
    pluginId: load.target.pluginId,
    scope: load.target.scope,
    installId: load.target.installId,
    actions: load.target.actions,
    callMethods: load.target.callMethods,
    register(registration: PluginSlotRegistration): () => void {
      if (load.ended) return () => {}
      const outcome = registerSlot(
        {
          pluginKey: load.target.pluginKey,
          pluginId: load.target.pluginId,
          scope: load.target.scope,
        },
        registration,
      )
      if ('refusal' in outcome) {
        notice(load, outcome.refusal)
        // A malformed registration is the plugin failing to load correctly, and the contract's
        // answer is the whole load: mount nothing further (`§7.3`). A contested key — a duplicate
        // tool name or fence language, a foreign plugin id — is a refusal of that one registration,
        // because the other plugin owning it is not this one's failure.
        if (
          outcome.refusal !== 'renderer_slot_duplicate' &&
          outcome.refusal !== 'renderer_slot_not_owned'
        ) {
          failLoad(load, outcome.refusal)
        }
        return () => {}
      }
      load.registered.add(outcome.entry.id)
      return () => {
        // A disposer calls back into the registry, which may have ended already.
        releaseSlot(outcome.entry.id)
        load.registered.delete(outcome.entry.id)
      }
    },
    claimStyleSheet(): boolean {
      if (load.styles >= MAX_STYLE_SHEETS_PER_LOAD) return false
      load.styles += 1
      return true
    },
    notice(token: string): void {
      notice(load, token)
    },
    ended(): boolean {
      return load.ended
    },
  }
}

async function runLoad(load: RendererLoad): Promise<void> {
  let module: RendererModule
  try {
    // The URL is chosen at runtime — one per installation, served by this application's fixed slot
    // host (plan §D2) — so no static import can name it. No bare imports: the module gets this
    // application's React through the host, not an import map.
    const imported: unknown = await import(/* @vite-ignore */ load.target.url)
    if (load.ended) return
    module = asRendererModule(imported)
    if (module.onLoad === undefined) {
      failLoad(load, 'renderer_module_invalid')
      return
    }
    load.module = module
  } catch (error) {
    if (load.ended) return
    reportClientError(
      'a plugin renderer module could not be fetched',
      error,
      load.target.pluginKey,
    )
    failLoad(load, 'renderer_module_fetch_failed')
    return
  }
  const handle = createPluginSlotHost(hostOwnerFor(load))
  load.host = handle
  try {
    await module.onLoad(handle.host)
  } catch (error) {
    if (load.ended) return
    reportClientError('a plugin renderer module threw while loading', error, load.target.pluginKey)
    failLoad(load, error instanceof PluginHostError ? error.code : 'renderer_module_failed')
    return
  }
  if (load.ended) return
  load.phase = 'ready'
}

function startLoad(target: SlotRendererTarget): void {
  const load: RendererLoad = {
    target,
    phase: 'loading',
    reason: null,
    ended: false,
    module: null,
    host: null,
    registered: new Set(),
    notices: new Set(),
    styles: 0,
  }
  loads.set(target.pluginKey, load)
  void runLoad(load)
}

/** End one installation's renderer by its own identity, whether or not it finished loading. */
export function unloadPluginRenderer(pluginId: string, scope: string): void {
  const load = loads.get(`${pluginId}\u0000${scope}`)
  if (load !== undefined) endLoad(load)
}

/**
 * Bring the loaded modules in line with one list read.
 *
 * Called after every plugin list answer (the wiring subscribes to the resource), so disabling,
 * uninstalling or upgrading an installation ends its load on the same answer that stops serving it,
 * and a plain refresh changes nothing.
 */
export function reconcileSlots(rows: readonly PluginRow[]): void {
  const plan = planSlotReconcile(
    [...loads.values()].map((load) => ({
      pluginKey: load.target.pluginKey,
      revision: load.target.revision,
    })),
    rows,
  )
  for (const key of plan.unload) {
    const load = loads.get(key)
    if (load !== undefined) endLoad(load)
  }
  for (const target of plan.load) startLoad(target)
}

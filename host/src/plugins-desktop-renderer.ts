/**
 * The renderer-slot block of `omp.desktop` (plan §7.1): `renderer`, `rendererActions` and
 * `rendererCallMethods`, as the row projects them.
 *
 * Split out of `plugins-desktop.ts` at the line limit (`rules.md#single-file-line-limit`), by responsibility rather
 * than by size: this file is the whole slot-module half of the manifest, and the row's entry lists,
 * themes and scopes stay in the parent. The shared text rules (`safeRelativePath`) live in
 * `plugins-desktop-text.ts`, so the dependency direction is text → this file → the parent, with no
 * cycle.
 *
 * Shapes only, like the process block: the module is served from the fixed slot host by the Rust
 * boundary (plan §D2), which also resolves the declared path against the row's `rootPath` and adds
 * the `url` a page imports. This side never produces a URL, a resolution result or a runnability
 * verdict - it only decides whether the block is one the other side could honour at all.
 */

import {
  PLUGIN_RENDERER_ACTIONS,
  PLUGIN_RENDERER_ACTIONS_MAX,
  PLUGIN_RENDERER_CALL_METHODS_MAX,
  PLUGIN_RENDERER_METHOD_MAX,
  PLUGIN_RENDERER_METHOD_NAME,
  PLUGIN_RENDERER_PATH_MAX,
} from './constants.ts'
import { safeRelativePath } from './plugins-desktop-text.ts'

/**
 * The slot module one block declares (plan §7.1), or `null` when it declares none.
 *
 * `path` is the package-relative entry *as the manifest wrote it*: the Rust boundary resolves it
 * against the row's root, serves the file from the fixed slot host and gives the page a `url`. The
 * two lists are the dispatch whitelist the frontend slot host enforces - `actions` against the
 * closed token vocabulary, `callMethods` against the worker methods `plugin.call` may reach.
 */
export interface DesktopRendererView {
  readonly path: string
  readonly actions: string[]
  readonly callMethods: string[]
}

/** The action vocabulary as a lookup: a token outside it is a request this build cannot honour. */
const RENDERER_ACTIONS: Record<string, true> = Object.fromEntries(
  PLUGIN_RENDERER_ACTIONS.map(action => [action, true] as const),
)

/**
 * The renderer-slot block (`omp.desktop.renderer`, plan §7.1), projected for the row.
 *
 * Three shapes, each refused whole rather than trimmed: `renderer` is one package-relative `.js` /
 * `.mjs` module outside `node_modules` (the same lexical rule `main` gets), `rendererActions` is at
 * most {@link PLUGIN_RENDERER_ACTIONS_MAX} unique tokens from the closed vocabulary, and
 * `rendererCallMethods` is at most {@link PLUGIN_RENDERER_CALL_METHODS_MAX} unique bounded method
 * names. A duplicate in either list is refused rather than deduplicated: a whitelist with two of one
 * entry is not the list its author wrote.
 *
 * One permission covers all three: the module runs in the application's own realm (plan §D2), so a
 * manifest that declares any of them without `renderer.extension` has the whole block refused - the
 * same answer a panel without `ui.panel` gets (spec §6.2). The permission alone, with nothing
 * declared, is legal, and so is a declared module with no actions: it simply cannot dispatch.
 */
export function desktopRenderer(
  raw: Record<string, unknown>,
  granted: ReadonlySet<string>,
): { readonly view: DesktopRendererView | null; readonly reason: string | null } {
  let entry: string | null = null
  const declaredEntry = raw.renderer
  if (declaredEntry !== undefined && declaredEntry !== null) {
    if (
      typeof declaredEntry !== 'string'
      || !safeRelativePath(declaredEntry, PLUGIN_RENDERER_PATH_MAX)
      || !/\.(?:js|mjs)$/i.test(declaredEntry)
      || declaredEntry.split('/').some(segment => segment.toLowerCase() === 'node_modules')
    ) {
      return { view: null, reason: 'invalid_renderer_path' }
    }
    entry = declaredEntry
  }

  const actions: string[] = []
  const declaredActions = raw.rendererActions
  if (declaredActions !== undefined && declaredActions !== null) {
    if (!Array.isArray(declaredActions) || declaredActions.length > PLUGIN_RENDERER_ACTIONS_MAX) {
      return { view: null, reason: 'invalid_renderer_actions' }
    }
    for (const item of declaredActions) {
      // A non-string is a shape this host cannot read at all; a string outside the vocabulary is a
      // dispatch the slot host would have to guess at - and `PLUGIN_ACTION_UNKNOWN` is the runtime's
      // answer to exactly that (plan §7.3), so the manifest is refused here instead.
      if (typeof item !== 'string' || RENDERER_ACTIONS[item] !== true || actions.includes(item)) {
        return { view: null, reason: 'invalid_renderer_actions' }
      }
      actions.push(item)
    }
  }

  const callMethods: string[] = []
  const declaredMethods = raw.rendererCallMethods
  if (declaredMethods !== undefined && declaredMethods !== null) {
    if (!Array.isArray(declaredMethods) || declaredMethods.length > PLUGIN_RENDERER_CALL_METHODS_MAX) {
      return { view: null, reason: 'invalid_renderer_call_methods' }
    }
    for (const item of declaredMethods) {
      if (
        typeof item !== 'string'
        || item.length > PLUGIN_RENDERER_METHOD_MAX
        || !PLUGIN_RENDERER_METHOD_NAME.test(item)
        || callMethods.includes(item)
      ) {
        return { view: null, reason: 'invalid_renderer_call_methods' }
      }
      callMethods.push(item)
    }
  }

  // The permission is checked last, so every shape failure above reports its own reason: a manifest
  // with both problems is answered with the one this host can describe, and the permission is never
  // read as covering a field that was malformed anyway.
  if ((entry !== null || actions.length > 0 || callMethods.length > 0) && !granted.has('renderer.extension')) {
    return { view: null, reason: 'entry_permission_missing' }
  }

  // A module is what makes the rest reachable: a declared action or method with no `renderer` names
  // nothing that can be loaded or called, so the block projects no renderer at all - the same answer
  // an `activationEvents`-only process block gets, and for the same reason. The permission check
  // above still applies, because the manifest did declare those rights.
  if (entry === null) return { view: null, reason: null }
  return { view: { path: entry, actions, callMethods }, reason: null }
}

/**
 * What the host knows about models: one summary shape, the role table, and role writes.
 *
 * The summary mapping lives here alone because three responses describe models - `models_reload`,
 * `session_config` and `model_role_candidates` - and a model has to look the same wherever the
 * frontend meets it.
 *
 * The role table mirrors pi-tui's `resolveRoleAssignments`
 * (`@oh-my-pi/pi-tui/src/overlays/model-browser.ts`): the engine exposes the pieces of that
 * resolution (`getKnownRoleIds` / `getRoleInfo` / `roleCandidatePool` / `resolveModelRoleValue`)
 * but not the helper itself, and "which model does this role actually use" has to be the answer
 * the engine's own browsers show.
 */

import type { RoleInfo } from '@oh-my-pi/pi-coding-agent/config/model-roles'
import type { ResolvedModelRoleValue } from '@oh-my-pi/pi-coding-agent/config/model-resolver'

import type { BootServices } from './boot.ts'
import { invalidInput } from './protocol/errors.ts'
import type { SdkBundle } from './sdk.ts'

/**
 * A model, in the shape every model-bearing response publishes.
 *
 * The two token budgets stay nullable because the engine reports "unknown" that way - a summary
 * carries what the engine said instead of inventing a zero - and declaring the shape once is what
 * keeps `models_reload`, `session_config` and `model_role_candidates` from drifting apart.
 */
export interface ModelSummary {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly contextWindow: number | null
  readonly maxTokens: number | null
  readonly input: readonly ('text' | 'image')[]
  readonly reasoning: boolean
  /** Concrete levels a role may pin; `auto` is a session-level choice and is intentionally absent. */
  readonly thinkingLevels: string[]
}

/**
 * Thinking metadata read structurally instead of imported from the catalogue. This mirrors what
 * the SDK's `getSupportedEfforts` reads (`reasoning` and `thinking.efforts`); the host deliberately
 * adds no dependency because `@oh-my-pi/pi-catalog` is not declared by `host/package.json`.
 */
interface EngineModelThinkingFields {
  readonly reasoning: boolean
  readonly thinking?: {
    readonly efforts?: readonly string[]
  }
}

/**
 * What the mapping reads. A catalogue entry supplies at least these fields - it carries many
 * more - so the projection can be stated once instead of as a second field list. `thinkingLevels`
 * is omitted because the summary derives it from the engine's thinking metadata.
 */
export type EngineModelFields = Omit<ModelSummary, 'thinkingLevels'> & EngineModelThinkingFields

/** The provider/id/name reference a role row carries; the rest of the model is not the point there. */
export interface ModelRef {
  readonly provider: string
  readonly id: string
  readonly name: string
}

/** One row of the model-role table, mirroring what the engine's own role browsers display. */
export interface RoleRow {
  readonly id: string
  readonly tag: string | null
  readonly name: string
  readonly section: RoleInfo['section']
  readonly configured: boolean
  /** The raw configured selector, which may carry a `:level` thinking suffix. */
  readonly value: string | null
  readonly source: 'global' | 'project' | 'default'
  /** The model this role resolves to right now; `null` when nothing in its pool matches. */
  readonly model: ModelRef | null
  /** Set only when the selector itself names a thinking level. */
  readonly thinkingLevel: string | null
  /** True when the role has no configured value and fell back to auto-selection. */
  readonly autoSelected: boolean
}

/** The candidate answer for one role. */
export interface RoleCandidates {
  readonly role: string
  readonly models: ModelSummary[]
  readonly truncated: boolean
}

/** Candidate rows one answer may carry: a wide catalogue must not become one unbounded frame. */
const MAX_ROLE_CANDIDATES = 2000

/** The single model mapping: one catalogue entry in, the published summary out. */
export function modelSummary(model: EngineModelFields): ModelSummary {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: model.input,
    reasoning: model.reasoning,
    thinkingLevels: model.reasoning ? ['off', ...(model.thinking?.efforts ?? [])] : [],
  }
}

/** The model a role resolved to, or `null` when it resolved to nothing. */
function modelRef(resolved: ResolvedModelRoleValue): ModelRef | null {
  return resolved.model === undefined
    ? null
    : { provider: resolved.model.provider, id: resolved.model.id, name: resolved.model.name }
}

/**
 * The model a session with no recorded model starts on: the engine's own startup order.
 *
 * `createAgentSession` with no explicit model resolves the `default` role against the allowed
 * models and, when that resolves nothing, picks the first concretely-authenticated one
 * (`sdk.ts`'s `pickDefaultAvailableModel` call). Both halves are the engine's own functions, so an
 * unassigned `default` row reports that decision instead of a second implementation of it -
 * including the `enabledModels` scoping `resolveAllowedModels` applies.
 *
 * The answer is computed against the settings this host was initialized with, i.e. the scope every
 * other read in this module already uses; a conversation opened elsewhere resolves its own
 * `enabledModels` scope at creation time and may differ when those path-scoped settings are used.
 */
async function startupModel(services: BootServices, sdk: SdkBundle): Promise<ModelRef | null> {
  const { settings, registry } = services
  const allowed = await sdk.resolveAllowedModels(registry, settings, sdk.getModelMatchPreferences(settings))
  const pick = sdk.pickDefaultAvailableModel(
    allowed.filter(model => registry.hasConfiguredAuth(model)),
    provider => registry.hasConcreteAuth(provider),
  )
  return pick === undefined ? null : { provider: pick.provider, id: pick.id, name: pick.name }
}

/** The current role table: every known role, with the model it resolves to and where it came from. */
export async function roleRows(services: BootServices, sdk: SdkBundle): Promise<RoleRow[]> {
  const { settings, registry } = services
  const rows: RoleRow[] = []
  for (const role of sdk.getKnownRoleIds(settings)) {
    const info = sdk.getRoleInfo(role, settings)
    // `getModelRole` reports the merged value; an empty string is a cleared role, not a selector.
    const assigned = settings.getModelRole(role)
    const value = assigned === undefined || assigned === '' ? null : assigned
    // One pool per role, already narrowed to what the role accepts, so a configured value and an
    // auto-selected one are resolved against the same candidates.
    const pool = sdk.roleCandidatePool(role, settings, registry)
    // An unconfigured role is resolved through its alias, which is how the engine walks the role's
    // priority chain before giving up. The alias is written with the engine's own formatter
    // (`@<role>`, legacy `pi/<role>` is still accepted by the resolver but is not what the engine
    // documents), so this host never keeps a second spelling of the vocabulary.
    const resolved = value === null
      ? sdk.resolveModelRoleValue(sdk.formatModelRoleAlias(role), pool, { settings })
      : sdk.resolveModelRoleValue(value, pool, { settings })
    // `default` is the one role whose own answer a conversation's model comes from, so an
    // unassigned one reports the model the engine would start the next conversation on; the
    // composer names it, and the panel draws it as the auto-resolved row it is. Every other role
    // keeps its own chain - their consumers' fallbacks (a session's model, `smol`, `tiny`) are
    // another layer this table deliberately does not invent.
    const model = modelRef(resolved)
      ?? (value === null && role === 'default' ? await startupModel(services, sdk) : null)
    rows.push({
      id: role,
      tag: info.tag ?? null,
      name: info.name,
      section: info.section,
      configured: value !== null,
      value,
      source: settings.getModelRoleSource(role),
      model,
      thinkingLevel: resolved.explicitThinkingLevel && typeof resolved.thinkingLevel === 'string'
        ? resolved.thinkingLevel
        : null,
      autoSelected: value === null,
    })
  }
  return rows
}

/**
 * The models one role may be assigned from.
 *
 * The role id arrives normalized (the dispatcher rejects an empty one), and an unknown id is not
 * refused here: the engine answers for any role id it is asked about - its fallback metadata
 * widens unknown roles to chat models - while membership is enforced where it matters, on the
 * write path. The cap is published rather than applied silently, so a picker can say that it is
 * showing a subset.
 */
export function roleCandidates(services: BootServices, sdk: SdkBundle, role: string): RoleCandidates {
  const pool = sdk.roleCandidatePool(role, services.settings, services.registry)
  const models = pool.slice(0, MAX_ROLE_CANDIDATES).map(model => modelSummary(model))
  return { role, models, truncated: pool.length > models.length }
}

/**
 * Whether this engine knows a role by that id.
 *
 * The engine owns the role vocabulary (`getKnownRoleIds`), and a write or an import that names
 * anything else is refused here rather than stored as a key nothing reads.
 */
export function assignableRole(services: BootServices, sdk: SdkBundle, role: string): boolean {
  return sdk.getKnownRoleIds(services.settings).includes(role)
}

/**
 * Whether `selector` names a model the role could actually use.
 *
 * Resolved against the same pool the role picker offers, so a value that resolves nowhere - an
 * unknown provider, a model this catalogue does not carry - is refused instead of being stored and
 * silently ignored by the engine.
 */
export function assignableSelector(
  services: BootServices,
  sdk: SdkBundle,
  role: string,
  selector: string,
): boolean {
  const pool = sdk.roleCandidatePool(role, services.settings, services.registry)
  return sdk.resolveModelRoleValue(selector, pool, { settings: services.settings }).model !== undefined
}

/**
 * Assigns one role in the engine's own config file, then answers with the table those settings imply.
 *
 * This command is deliberately **not** gated on idle turns (contract §5.3 gates GC, import, list,
 * health, model refresh and shutdown on that): it writes only the engine's own global config layer
 * through the SDK's `Settings` API - the SDK owns that file's write lock, per-role merge and
 * debounce - and touches neither a session file nor a session write handle, so no in-flight turn can
 * observe a half-written role. Nothing outside `modelRoles` is writable here: a role write must not
 * become a back door for settings.
 */
export async function setRole(
  services: BootServices,
  sdk: SdkBundle,
  role: string,
  selector: string | null,
): Promise<RoleRow[]> {
  const { settings } = services
  if (!assignableRole(services, sdk, role)) {
    throw invalidInput(`No model role is named "${role}".`)
  }
  if (selector !== null && !assignableSelector(services, sdk, role, selector)) {
    throw invalidInput(`No model assignable to the "${role}" role matches "${selector}".`)
  }
  // `undefined` clears the role, which is what makes it fall back to auto-selection on the next read.
  settings.setModelRole(role, selector ?? undefined)
  await settings.flush()
  return roleRows(services, sdk)
}

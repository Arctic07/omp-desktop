/**
 * The engine's model catalogue: what it offers, what each role resolves to, and where the keys for
 * each provider live.
 *
 * Read whole and replaced whole. The engine owns every one of these facts — the catalogue comes from
 * its model registry, the role table from its settings, the provider list from its own discovery —
 * so nothing is derived or defaulted here, and a write is followed by the answer the desktop
 * returns rather than by an optimistic guess.
 */

import type { ApiError } from '@/api/client'
import {
  customProviderFetchModels,
  customProviderList,
  customProviderRemove,
  customProviderSave,
  engineDataPaths,
  engineModelRoles,
  engineModels,
  engineRoleCandidates,
  engineSetModelRole,
  providerClearKey,
  providerList,
  providerKeysApply,
  runtimeStatus,
} from '@/api/agent'
import type {
  CustomModelDefinition,
  CustomProvider,
  CustomProviderInput,
  EngineDataPaths,
  EngineModel,
  ModelRoleRow,
  ProviderSummary,
  RuntimeStatus,
} from '@/api/types'
import { createStore } from '@/state/store'

export interface ModelState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: ApiError | null
  models: EngineModel[]
  roles: ModelRoleRow[]
  providers: ProviderSummary[]
  customProviders: CustomProvider[]
  runtime: RuntimeStatus | null
  paths: EngineDataPaths | null
}

const EMPTY: ModelState = {
  status: 'idle',
  error: null,
  models: [],
  roles: [],
  providers: [],
  customProviders: [],
  runtime: null,
  paths: null,
}

/**
 * Providers this application does not offer anywhere.
 *
 * `cline-pass` is a subscription pass rather than an endpoint a key is entered for: the engine lists
 * it among its providers and carries its models in the catalogue, and neither is something this app
 * is meant to offer — a new conversation was starting on its model because the composer fell back to
 * the catalogue's first entry, which is one of its.
 *
 * One list, applied where the catalogue arrives and wherever a model is *named*, so hiding a provider
 * hides it in the settings' provider rows, in the role candidate lists, in the roles table's resolved
 * models and in the composer's own menu at once, and there is one place to change the decision.
 */
const HIDDEN_PROVIDERS = new Set(['cline-pass'])

function isOffered(provider: string): boolean {
  return !HIDDEN_PROVIDERS.has(provider)
}

/** Whether a model from the engine's catalogue is one this application offers. */
export function isModelOffered(model: { provider: string }): boolean {
  return isOffered(model.provider)
}

export const modelStore = createStore<ModelState>(EMPTY)

function patch(state: Partial<ModelState>): void {
  modelStore.set((previous) => ({ ...previous, ...state }))
}

/** Load everything the model surfaces read. `refresh` re-scans the engine's catalogue. */
export async function loadModels(refresh = false): Promise<void> {
  patch({ status: 'loading', error: null })
  try {
    const [catalogue, roles, providers, custom, runtime, paths] = await Promise.all([
      engineModels(refresh),
      engineModelRoles(),
      providerList(),
      customProviderList(),
      runtimeStatus(),
      engineDataPaths(),
    ])
    patch({
      status: 'ready',
      error: null,
      models: catalogue.models.filter((model) => isOffered(model.provider)),
      roles: roles.roles,
      providers: providers.filter((provider) => isOffered(provider.id)),
      customProviders: custom,
      runtime,
      paths,
    })
  } catch (error) {
    patch({ status: 'error', error: error as ApiError })
  }
}

/** The models a role may be pointed at, as the engine narrows them. */
export function roleCandidates(role: string): Promise<EngineModel[]> {
  return engineRoleCandidates(role).then((answer) =>
    answer.models.filter((model) => isOffered(model.provider)),
  )
}

/** Assign a role, or clear it with `selector: null`. The answer replaces the whole table. */
export async function assignRole(role: string, selector: string | null): Promise<void> {
  const table = await engineSetModelRole(role, selector)
  patch({ roles: table.roles })
}

/**
 * Re-reads the catalogue after a write that changes the engine's model inputs.
 *
 * The host parses `models.yml` while it hydrates its credential-scoped model cache and keeps
 * serving that cache, so a landed write only reaches a *running* host through a re-hydration:
 * `refresh` is that read, and the host answers it with `models_reload`. Without it a provider, a
 * model or a key saved since the host booted stays invisible — in the composer's model menu and in
 * the settings' role lists alike, since both read this one store — until the application restarts.
 */
async function refreshAfterWrite(): Promise<void> {
  await loadModels(true)
}

/** Removes the named saved rows and appends new keys; the engine rotates across the result. */
export async function applyProviderKeys(
  providerId: string,
  remove: number[],
  add: string[],
): Promise<boolean> {
  const result = await providerKeysApply(providerId, remove, add)
  await refreshAfterWrite()
  return result.live
}

export async function clearProviderKey(providerId: string): Promise<void> {
  await providerClearKey(providerId)
  await refreshAfterWrite()
}

export async function saveCustomProvider(provider: CustomProviderInput): Promise<void> {
  await customProviderSave(provider)
  await refreshAfterWrite()
}

export async function removeCustomProvider(providerId: string): Promise<void> {
  await customProviderRemove(providerId)
  await refreshAfterWrite()
}

/** Probe an OpenAI-compatible endpoint's catalogue with the first stored key; nothing is stored. */
export function fetchCustomModels(
  baseUrl: string,
  apiKey: string | null,
  providerId: string | null,
): Promise<CustomModelDefinition[]> {
  return customProviderFetchModels(baseUrl, apiKey, providerId).then((answer) => answer.models)
}

/** A model's own label: `<provider>/<id>` as the selector stores it. */
export function modelSelector(model: EngineModel): string {
  return `${model.provider}/${model.id}`
}

/** The names the provider list carries, keyed by provider id, for `providerLabel`. */
export function providerNameIndex(
  providers: readonly ProviderSummary[],
): ReadonlyMap<string, string> {
  return new Map(providers.map((provider) => [provider.id, provider.name]))
}

/**
 * What a provider is called where one is named.
 *
 * A provider this application generated the id for (`custom-ba937c28`) has no readable id at all, so
 * every surface that names one writes the name the reader gave it — which is also the only thing that
 * tells two providers of the same models apart. A provider the list does not carry keeps its id:
 * that is the one true thing left to say about it.
 */
export function providerLabel(names: ReadonlyMap<string, string>, provider: string): string {
  return names.get(provider) ?? provider
}

/** Split a stored selector back into the model and the level pinned to it, if any. */
export function parseSelector(
  selector: string | null,
): { model: string; level: string | null } | null {
  if (!selector) return null
  const cut = selector.lastIndexOf(':')
  if (cut === -1) return { model: selector, level: null }
  return { model: selector.slice(0, cut), level: selector.slice(cut + 1) }
}

/**
 * The model's own id: a selector is `<provider>/<id>[:level]`, and the id is the part a reader
 * recognises (`gpt-5.6-luna`), not the provider key in front of it.
 *
 * A provider's key can be generated (`custom-ba937c28`) and a level is a setting rather than a
 * model, so neither belongs where one model is named.
 */
export function modelIdOf(selector: string): string {
  const parsed = parseSelector(selector)
  const model = parsed?.model ?? selector
  const cut = model.indexOf('/')
  return cut === -1 ? model : model.slice(cut + 1)
}

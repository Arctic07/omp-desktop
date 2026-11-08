import {
  CUSTOM_PROVIDER_APIS,
  type CustomModelDefinition,
  type CustomProvider,
  type CustomProviderInput,
} from '@/api/types'

/**
 * The custom provider editor's draft, and the checks it makes before writing.
 *
 * Sizes are edited as text so an empty field stays empty while it is typed, and `models.yml` only
 * ever sees the numbers `toInput` produces. The checks are the desktop app's own
 * (`src/utils/modelSettings.ts` in the Vue frontend), so both frontends refuse the same drafts.
 */

export interface ModelDraft {
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  supportsImages: boolean
  supportsReasoning: boolean
}

export interface ProviderDraft {
  id: string
  name: string
  baseUrl: string
  /** The dialect as stored: a value this build does not know is kept, not silently replaced. */
  api: string
  models: ModelDraft[]
}

/** What the user still has to fix before the draft can be written. */
export type DraftProblem = 'id' | 'name' | 'base-url' | 'model-id' | 'model-id-duplicate'

/** The provider key the engine accepts in `models.yml`: `[a-z0-9][a-z0-9-]{1,31}`. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{1,31}$/

/** Only `http`/`https` addresses reach the engine; local services on other ports are fine. */
export function isHttpUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return false
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
}

/** A row with no metadata yet; the user fills the context window and max output by hand. */
export function emptyModelDraft(): ModelDraft {
  return {
    id: '',
    name: '',
    contextWindow: '',
    maxTokens: '',
    supportsImages: false,
    supportsReasoning: false,
  }
}

function sizeText(value: number): string {
  return value > 0 ? `${value}` : ''
}

/** A row the user never touched; it carries no model they asked for. */
export function isEmptyModel(model: ModelDraft): boolean {
  return (
    model.id.trim() === '' &&
    model.name.trim() === '' &&
    model.contextWindow.trim() === '' &&
    model.maxTokens.trim() === ''
  )
}

/** `null` starts a new provider, on the first dialect the engine accepts. */
export function draftFrom(provider: CustomProvider | null): ProviderDraft {
  if (provider === null) {
    return {
      id: '',
      name: '',
      baseUrl: '',
      api: CUSTOM_PROVIDER_APIS[0],
      models: [emptyModelDraft()],
    }
  }
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.api,
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: sizeText(model.contextWindow),
      maxTokens: sizeText(model.maxTokens),
      supportsImages: model.supportsImages,
      supportsReasoning: model.supportsReasoning,
    })),
  }
}

function size(value: string): number {
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

/** Trimmed copy of the draft, so the file never carries stray whitespace or negative sizes. */
export function toInput(draft: ProviderDraft): CustomProviderInput {
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    api: draft.api,
    models: draft.models
      .filter((model) => !isEmptyModel(model))
      .map((model) => ({
        id: model.id.trim(),
        name: model.name.trim(),
        contextWindow: size(model.contextWindow),
        maxTokens: size(model.maxTokens),
        supportsImages: model.supportsImages,
        supportsReasoning: model.supportsReasoning,
      })),
  }
}

/** A stable 8-hex-digit digest of a name, used when the name has no ASCII form to slug. */
function idSeed(name: string): string {
  let hash = 0x811c9dc5
  for (const char of name) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * The provider id a name gets: generated, never typed.
 *
 * The engine keys `models.yml` by this id, so it has to satisfy `PROVIDER_ID` and be unique; the
 * reader only ever names the provider (`2026-10-17`: the editor shows the name alone). An ASCII name
 * slugs to itself, anything else (a Chinese name, say) falls back to `custom-<digest>` - and a taken
 * id gets a numeric suffix rather than overwriting the provider that already owns it.
 */
export function providerIdFor(name: string, taken: readonly string[]): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = slug.length >= 2 ? slug.slice(0, 24) : `custom-${idSeed(name)}`
  const ids = new Set(taken)
  let candidate = base
  for (let suffix = 2; ids.has(candidate); suffix += 1) {
    candidate = `${base.slice(0, 27)}-${suffix}`
  }
  return candidate
}

/** First problem only: the form highlights one thing to fix at a time. */
export function validateDraft(draft: ProviderDraft): DraftProblem | null {
  if (!PROVIDER_ID.test(draft.id.trim())) {
    return 'id'
  }
  if (draft.name.trim() === '') {
    return 'name'
  }
  if (!isHttpUrl(draft.baseUrl)) {
    return 'base-url'
  }

  const ids = new Set<string>()
  for (const model of draft.models) {
    if (isEmptyModel(model)) {
      continue
    }
    const id = model.id.trim()
    if (id === '') {
      return 'model-id'
    }
    if (ids.has(id)) {
      return 'model-id-duplicate'
    }
    ids.add(id)
  }
  return null
}

/** Adds every fetched model the draft does not carry yet; existing rows keep the user's metadata. */
export function mergeFetched(
  models: readonly ModelDraft[],
  fetched: readonly CustomModelDefinition[],
): ModelDraft[] {
  const merged = models.map((model) => ({ ...model }))
  const known = new Set(merged.map((model) => model.id.trim()))
  for (const candidate of fetched) {
    const id = candidate.id.trim()
    if (id === '' || known.has(id)) {
      continue
    }
    known.add(id)
    merged.push({
      id: candidate.id,
      name: candidate.name,
      contextWindow: sizeText(candidate.contextWindow),
      maxTokens: sizeText(candidate.maxTokens),
      supportsImages: candidate.supportsImages,
      supportsReasoning: candidate.supportsReasoning,
    })
  }
  return merged
}

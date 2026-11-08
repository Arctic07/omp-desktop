import type { EngineMcpDefinitionInput } from '@/api/capabilities-types'

/**
 * Reading a pasted definition: the JSON editor's own parsing, apart from the form that renders it.
 *
 * Both editors write the same thing, so what a draft means is decided here once, as pure functions
 * over text. Three shapes are accepted, because three are what a reader has to hand: a bare
 * definition, a single `name → definition` entry, and the `mcpServers` wrapper another tool's file
 * uses. The name comes from the key when the draft carries one.
 *
 * `null` is the one answer for "this is not a definition" — a draft that does not parse, is not an
 * object, or names a transport the engine does not know. The wording that reaches the screen belongs
 * to the caller's copy, so these functions carry none.
 */

/** The keys a definition may carry here: anything else a draft holds would be dropped on write. */
export const DEFINITION_KEYS: Readonly<Record<string, true>> = {
  type: true,
  transport: true,
  command: true,
  args: true,
  env: true,
  url: true,
  headers: true,
  cwd: true,
  timeout: true,
  timeoutMs: true,
}

/** One JSON draft read as a definition, the name its own key carries, and the keys it would lose. */
export interface JsonDefinition {
  name: string | null
  definition: EngineMcpDefinitionInput
  unknown: string[]
}

/** One object as a string map; anything else reads as none. */
export function asStringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      out[key] = entry
    }
  }
  return out
}

/** One optional object typed into a textarea as a string map, or null when it is not an object. */
export function objectField(text: string): Record<string, string> | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  return asStringMap(parsed)
}

/** One JSON draft as a definition, or null when the text is not one. */
export function definitionFromJson(text: string): JsonDefinition | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim())
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const record = parsed as Record<string, unknown>
  const wrapped = record.mcpServers
  const container =
    typeof wrapped === 'object' && wrapped !== null && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : record
  const entries = Object.entries(container)
  const single = entries.length === 1 ? entries[0] : undefined
  const looksLikeDefinition = 'type' in container || 'command' in container || 'url' in container
  const named =
    single !== undefined && typeof single[1] === 'object' && single[1] !== null
      ? ([single[0], single[1] as Record<string, unknown>] as const)
      : null
  const body = looksLikeDefinition ? container : named === null ? null : named[1]
  if (body === null) {
    return null
  }
  const transportValue = body.type ?? body.transport
  const transportText = typeof transportValue === 'string' ? transportValue : 'stdio'
  if (transportText !== 'stdio' && transportText !== 'http' && transportText !== 'sse') {
    return null
  }
  const args = Array.isArray(body.args)
    ? body.args.filter((entry): entry is string => typeof entry === 'string')
    : []
  const timeout =
    typeof body.timeoutMs === 'number'
      ? body.timeoutMs
      : typeof body.timeout === 'number'
        ? body.timeout
        : null
  return {
    name: named === null ? null : named[0],
    unknown: Object.keys(body).filter((key) => DEFINITION_KEYS[key] !== true),
    definition: {
      transport: transportText,
      command: typeof body.command === 'string' ? body.command : null,
      args,
      env: asStringMap(body.env),
      url: typeof body.url === 'string' ? body.url : null,
      headers: asStringMap(body.headers),
      cwd: typeof body.cwd === 'string' ? body.cwd : null,
      timeoutMs: timeout,
    },
  }
}

/**
 * The desktop's rotation pools, installed as in-memory credentials over the engine's store.
 *
 * A provider can hold several keys in the OS keyring, but the engine's own credential pool is
 * backed by `agent.db`, and this application never writes a secret there. The engine still has to
 * *see* every key, because that pool is what rotates across them on an auth failure or an exhausted
 * quota window. This store is the seam: it wraps the SQLite store and appends one ephemeral
 * `api_key` row per pooled key, with stable negative row ids so blocks and affinity survive a
 * reload. Every write for a synthetic row is handled in memory; the durable store only ever sees
 * rows that were already its own.
 *
 * Owner: the boot-time services, one instance per host process. Bound: `PROVIDER_POOLS_MAX`
 * providers, `KEYS_MAX` keys each, `KEY_CHARS_MAX` characters per key. Release: the instance lives
 * as long as the host; `clear(provider)` drops one pool, `deleteAuthCredentials` drops the
 * provider's, and nothing else grows the map.
 *
 * The pool arrives two ways: `OMP_DESKTOP_PROVIDER_KEYS` at spawn (a JSON object, removed from the
 * process environment as soon as it is read), and `provider_keys_set` while the host is running.
 * The environment variable a frame names is never trusted: the host writes or deletes only the name
 * this file knows for that provider (`envNames` from spawn, or the derived custom-provider name).
 */

import type {
  AuthCredential,
  AuthCredentialStore,
  DisabledCredentialSummary,
  StoredAuthCredential,
  StoredCredentialBlock,
} from '@oh-my-pi/pi-ai'

/** One provider's pool: the environment variable its single-key form uses, and its keys. */
export interface ProviderKeyPool {
  readonly provider: string
  readonly env: string
  readonly keys: readonly string[]
}

/** The parsed spawn payload: pools to install, every keyed provider's variable, and bad entries. */
export interface ProviderKeyPools {
  readonly pools: readonly ProviderKeyPool[]
  /** Every provider that had a key at spawn, mapped to the variable its key was injected into. */
  readonly envNames: ReadonlyMap<string, string>
  /** Built-in provider ids: a derived custom variable must never be written for one of these. */
  readonly builtinIds: ReadonlySet<string>
  /** One line per entry that was refused; the caller logs them, the rest of the payload still lands. */
  readonly errors: readonly string[]
}

/** Longest key accepted; mirrors the Rust keyring write's own bound. */
const KEY_CHARS_MAX = 4_096
/** Most keys one provider may carry; mirrors `credentials::PROVIDER_KEYS_MAX`. */
const KEYS_MAX = 8
/** Most providers one host will hold pools for; mirrors `credentials::PROVIDER_POOLS_MAX`. */
const PROVIDER_POOLS_MAX = 64
/** Most built-in ids one payload may carry; the table is far below this. */
const BUILTIN_IDS_MAX = 512
/** Provider id shape the Rust side can store and inject. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Environment name shape the host may write or delete. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** The generated custom-provider variable, matching `custom_providers::key_env` in Rust. */
const CUSTOM_ENV_PREFIX = 'OMP_DESKTOP_CUSTOM_'
const CUSTOM_ENV_SUFFIX = '_API_KEY'

/**
 * The variable a custom provider's key is injected into, derived the way the Rust writer does
 * (`custom_providers::key_env`).
 *
 * The spelling collapses every non-alphanumeric to `_` and upper-cases the rest, so ids that differ
 * only in case or in `.`/`_`/`-` would share one variable; a digest is appended for those, keeping
 * one variable per id.
 */
export function deriveCustomEnv(provider: string): string {
  let name = CUSTOM_ENV_PREFIX
  for (const character of provider) {
    name += /[A-Za-z0-9]/.test(character) ? character.toUpperCase() : '_'
  }
  if (!/^[a-z0-9-]*$/.test(provider)) {
    name += `_${idDigest(provider)}`
  }
  return `${name}${CUSTOM_ENV_SUFFIX}`
}

/** FNV-1a over the id's UTF-8 bytes, as 8 uppercase hex digits; mirrors the Rust `id_digest`. */
function idDigest(value: string): string {
  let hash = 2_166_136_261
  for (const byte of new TextEncoder().encode(value)) {
    hash = Math.imul((hash ^ byte) >>> 0, 16_777_619) >>> 0
  }
  return hash.toString(16).toUpperCase().padStart(8, '0')
}

/**
 * Parses the spawn payload. A bad entry is refused whole - half a pool would rotate onto a key the
 * user did not save - but the rest of the payload still lands, and every refusal is reported so the
 * caller can log it instead of booting silently without credentials.
 *
 * Shape: `{ "pools": { "<provider>": { "env": "…", "keys": ["…"] } }, "env": { "<provider>": "…" } }`.
 */
export function parseProviderKeyPools(raw: string | undefined): ProviderKeyPools {
  const errors: string[] = []
  const builtinIds = new Set<string>()
  const empty: ProviderKeyPools = { pools: [], envNames: new Map(), builtinIds, errors }
  if (raw === undefined || raw.trim() === '') {
    return empty
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    errors.push('OMP_DESKTOP_PROVIDER_KEYS is not valid JSON')
    return empty
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push('OMP_DESKTOP_PROVIDER_KEYS must be an object')
    return empty
  }
  const pools: ProviderKeyPool[] = []
  const envNames = new Map<string, string>()
  const envSource = 'env' in parsed ? parsed.env : undefined
  if (envSource !== undefined) {
    if (envSource === null || typeof envSource !== 'object' || Array.isArray(envSource)) {
      errors.push('OMP_DESKTOP_PROVIDER_KEYS carries an invalid env map')
    } else {
      for (const [provider, env] of Object.entries(envSource)) {
        if (PROVIDER_ID.test(provider) && typeof env === 'string' && ENV_NAME.test(env)) {
          envNames.set(provider, env)
        } else {
          errors.push(`OMP_DESKTOP_PROVIDER_KEYS carries an invalid env entry for ${provider}`)
        }
      }
    }
  }
  const builtinSource = 'builtin' in parsed ? parsed.builtin : undefined
  if (Array.isArray(builtinSource)) {
    for (const id of builtinSource.slice(0, BUILTIN_IDS_MAX)) {
      if (typeof id === 'string' && PROVIDER_ID.test(id)) {
        builtinIds.add(id)
      } else {
        errors.push('OMP_DESKTOP_PROVIDER_KEYS carries an invalid built-in id')
      }
    }
  } else if (builtinSource !== undefined) {
    errors.push('OMP_DESKTOP_PROVIDER_KEYS carries an invalid built-in list')
  }
  const poolSource = 'pools' in parsed ? parsed.pools : undefined
  if (poolSource === undefined) {
    return { pools, envNames, builtinIds, errors }
  }
  if (poolSource === null || typeof poolSource !== 'object' || Array.isArray(poolSource)) {
    errors.push('OMP_DESKTOP_PROVIDER_KEYS carries an invalid pool map')
    return { pools, envNames, builtinIds, errors }
  }
  for (const [provider, value] of Object.entries(poolSource)) {
    if (!PROVIDER_ID.test(provider)) {
      errors.push('OMP_DESKTOP_PROVIDER_KEYS carries an invalid provider id')
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`OMP_DESKTOP_PROVIDER_KEYS carries an invalid pool for ${provider}`)
      continue
    }
    if (!('env' in value) || typeof value.env !== 'string' || !ENV_NAME.test(value.env)) {
      errors.push(`OMP_DESKTOP_PROVIDER_KEYS carries an invalid environment name for ${provider}`)
      continue
    }
    if (!('keys' in value) || !Array.isArray(value.keys)) {
      errors.push(`OMP_DESKTOP_PROVIDER_KEYS carries no key list for ${provider}`)
      continue
    }
    try {
      pools.push({ provider, env: value.env, keys: normalizeKeys(value.keys) })
      envNames.set(provider, value.env)
    } catch (error) {
      errors.push(
        `${provider}: ${error instanceof Error ? error.message : 'the key list was refused'}`,
      )
    }
  }
  if (pools.length > PROVIDER_POOLS_MAX) {
    errors.push(`OMP_DESKTOP_PROVIDER_KEYS carries more than ${PROVIDER_POOLS_MAX} pools`)
    return { pools: [], envNames, builtinIds, errors }
  }
  return { pools, envNames, builtinIds, errors }
}

/** Trims, drops empty rows, dedupes, and enforces the same bounds as the keyring writer. */
export function normalizeKeys(values: readonly unknown[]): string[] {
  if (values.length === 0 || values.length > KEYS_MAX) {
    throw new Error('a provider pool carries the wrong number of keys')
  }
  const keys: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') {
      throw new Error('a provider pool carries a non-string key')
    }
    const key = value.trim()
    if (key === '') {
      continue
    }
    if (key.length > KEY_CHARS_MAX || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new Error('a provider pool carries an invalid key')
    }
    if (!keys.includes(key)) {
      keys.push(key)
    }
  }
  if (keys.length === 0) {
    throw new Error('a provider pool carries no key')
  }
  return keys
}

/** Stable negative row id for one (provider, key) pair: never collides with SQLite's positive ids. */
function syntheticId(provider: string, key: string, taken: ReadonlySet<number>): number {
  let hash = 2_166_136_261
  for (const character of `${provider}\u0000${key}`) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  let id = -(Math.abs(hash | 0) + 1)
  while (taken.has(id)) {
    id -= 1
  }
  return id
}

interface PoolEntry {
  env: string
  rows: Array<{ id: number; key: string }>
}

/** `AuthCredentialStore` over the engine's SQLite store, plus this process's key pools. */
export class ProviderKeyStore implements AuthCredentialStore {
  readonly #inner: AuthCredentialStore
  readonly #pools = new Map<string, PoolEntry>()
  /** Every keyed provider's variable, from spawn; the allow-list a live frame is checked against. */
  readonly #envNames: ReadonlyMap<string, string>
  /** Built-in provider ids, whose variable is the table's and must never be derived. */
  readonly #builtinIds: ReadonlySet<string>

  constructor(
    inner: AuthCredentialStore,
    parsed: ProviderKeyPools = {
      pools: [],
      envNames: new Map(),
      builtinIds: new Set(),
      errors: [],
    },
  ) {
    this.#inner = inner
    this.#envNames = parsed.envNames
    this.#builtinIds = parsed.builtinIds
    for (const pool of parsed.pools) {
      this.set(pool.provider, pool.env, pool.keys)
    }
  }

  /**
   * Replaces one provider's pool. The caller reloads `AuthStorage` afterwards.
   *
   * `keys` is already normalized by the boundary that read it (`parseProviderKeyPools` for spawn,
   * `normalizeKeys` in `auth-keys.ts` for a live frame), so it is stored as given.
   */
  set(provider: string, env: string, keys: readonly string[]): void {
    if (!this.#pools.has(provider) && this.#pools.size >= PROVIDER_POOLS_MAX) {
      throw new Error(`at most ${PROVIDER_POOLS_MAX} providers may hold a key pool`)
    }
    const taken = new Set<number>()
    for (const [other, pool] of this.#pools) {
      if (other === provider) continue
      for (const row of pool.rows) taken.add(row.id)
    }
    const rows = keys.map(key => {
      const id = syntheticId(provider, key, taken)
      taken.add(id)
      return { id, key }
    })
    this.#pools.set(provider, { env, rows })
  }

  /** Drops one provider's pool. */
  clear(provider: string): void {
    this.#pools.delete(provider)
  }

  /**
   * The only environment variable this host may write or delete for `provider`: the one it was
   * spawned with, or the custom-provider name derived from the id. A frame-supplied name that is
   * not this one is ignored, so a compromised or buggy frame cannot touch `PATH` or `HOME`.
   */
  allowedEnv(provider: string): string {
    const known = this.#envNames.get(provider)
    if (known !== undefined) return known
    // A built-in provider's variable comes from the engine's table; deriving a custom name for it
    // would export the key into a variable nothing reads.
    if (this.#builtinIds.has(provider)) return ''
    const derived = deriveCustomEnv(provider)
    return ENV_NAME.test(derived) ? derived : ''
  }

  #rows(provider: string): StoredAuthCredential[] {
    const pool = this.#pools.get(provider)
    if (pool === undefined) return []
    return pool.rows.map(row => ({
      id: row.id,
      provider,
      credential: { type: 'api_key', key: row.key },
      disabledCause: null,
    }))
  }

  #find(id: number): { provider: string; row: { id: number; key: string }; index: number } | undefined {
    for (const [provider, pool] of this.#pools) {
      const index = pool.rows.findIndex(row => row.id === id)
      const row = pool.rows[index]
      if (row !== undefined) return { provider, row, index }
    }
    return undefined
  }

  #remove(id: number): boolean {
    const found = this.#find(id)
    if (found === undefined) return false
    const pool = this.#pools.get(found.provider)
    if (pool === undefined) return false
    pool.rows.splice(found.index, 1)
    if (pool.rows.length === 0) this.#pools.delete(found.provider)
    return true
  }

  /* ------------------------------------------------------------ durable rows */

  listAuthCredentials(provider?: string): StoredAuthCredential[] {
    if (provider !== undefined) {
      return [...this.#inner.listAuthCredentials(provider), ...this.#rows(provider)]
    }
    const rows = this.#inner.listAuthCredentials()
    for (const pooled of this.#pools.keys()) rows.push(...this.#rows(pooled))
    return rows
  }

  updateAuthCredential(id: number, credential: AuthCredential): void {
    const found = this.#find(id)
    if (found === undefined) {
      this.#inner.updateAuthCredential(id, credential)
      return
    }
    if (credential.type !== 'api_key') {
      this.#remove(id)
      return
    }
    const pool = this.#pools.get(found.provider)
    if (pool === undefined) return
    found.row.key = credential.key
    // Every other row is taken, this one included's siblings: an id colliding with a sibling would
    // make `#find` resolve the wrong credential for delete/disable/update.
    const taken = new Set<number>()
    for (const other of this.#pools.values()) {
      for (const row of other.rows) {
        if (row === found.row) continue
        taken.add(row.id)
      }
    }
    found.row.id = syntheticId(found.provider, credential.key, taken)
  }

  async deleteAuthCredential(id: number, _disabledCause: string): Promise<boolean> {
    if (this.#find(id) !== undefined) {
      return this.#remove(id)
    }
    return this.#inner.deleteAuthCredential(id, _disabledCause)
  }

  tryDisableAuthCredentialIfMatches(id: number, _expectedData: string, _disabledCause: string): boolean {
    if (this.#find(id) !== undefined) {
      return this.#remove(id)
    }
    return this.#inner.tryDisableAuthCredentialIfMatches(id, _expectedData, _disabledCause)
  }

  tryUpdateAuthCredentialIfMatches(id: number, expectedData: string, credential: AuthCredential): boolean {
    const found = this.#find(id)
    if (found === undefined) {
      return this.#inner.tryUpdateAuthCredentialIfMatches?.(id, expectedData, credential) ?? false
    }
    this.updateAuthCredential(id, credential)
    return true
  }

  /** Keys this provider's pool already holds, so an engine write cannot persist a copy. */
  #poolKeys(provider: string): ReadonlySet<string> {
    const pool = this.#pools.get(provider)
    return new Set(pool?.rows.map(row => row.key) ?? [])
  }

  async replaceAuthCredentials(provider: string, credentials: AuthCredential[]): Promise<StoredAuthCredential[]> {
    // A pooled key must never reach `agent.db` through an engine-side replace; the synthetic row
    // already serves it, and writing it would put the secret on disk.
    const pooled = this.#poolKeys(provider)
    const filtered = credentials.filter(
      credential => !(credential.type === 'api_key' && pooled.has(credential.key)),
    )
    const stored = await this.#inner.replaceAuthCredentials(provider, filtered)
    return [...stored, ...this.#rows(provider)]
  }

  async upsertAuthCredential(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]> {
    if (credential.type === 'api_key' && this.#poolKeys(provider).has(credential.key)) {
      return this.#rows(provider)
    }
    const stored = await this.#inner.upsertAuthCredential(provider, credential)
    return [...stored, ...this.#rows(provider)]
  }

  async deleteAuthCredentials(provider: string, disabledCause: string): Promise<void> {
    this.#pools.delete(provider)
    await this.#inner.deleteAuthCredentials(provider, disabledCause)
  }

  close(): void {
    this.#inner.close()
  }

  pollExternalChanges(): boolean {
    return this.#inner.pollExternalChanges?.() ?? false
  }

  acknowledgeLocalChanges(): void {
    this.#inner.acknowledgeLocalChanges?.()
  }

  refreshSnapshot(): Promise<unknown> {
    return this.#inner.refreshSnapshot?.() ?? Promise.resolve()
  }

  listDisabledCredentials(provider?: string): Promise<DisabledCredentialSummary[]> {
    return this.#inner.listDisabledCredentials?.(provider) ?? Promise.resolve([])
  }

  /**
   * A pooled key that failed auth is dropped for this process; the keyring still holds it.
   *
   * The last row is kept. Removing it would leave the provider with no credential at all, and a
   * pool is described as `auth: none` in `models.yml`, so the engine would flip to keyless and send
   * no authorization header while the page still shows the saved keys. The engine's own block (the
   * caller marks the failed index) keeps the key out of selection; a later request fails visibly
   * with the provider's 401 instead of going out unauthenticated.
   */
  async markCredentialSuspect(credentialId: number): Promise<void> {
    const found = this.#find(credentialId)
    if (found === undefined) {
      await this.#inner.markCredentialSuspect?.(credentialId)
      return
    }
    const pool = this.#pools.get(found.provider)
    if (pool !== undefined && pool.rows.length > 1) {
      this.#remove(credentialId)
    }
  }

  /* --------------------------------------------------------------- cache rows */

  getCache(key: string, options?: { includeExpired?: boolean }): string | null {
    return this.#inner.getCache(key, options)
  }

  setCache(key: string, value: string, expiresAtSec: number): void {
    this.#inner.setCache(key, value, expiresAtSec)
  }

  deleteCachePrefix(prefix: string): void {
    this.#inner.deleteCachePrefix?.(prefix)
  }

  cleanExpiredCache(): void {
    this.#inner.cleanExpiredCache()
  }

  /* ------------------------------------------------------------------- blocks */

  getCredentialBlock(credentialId: number, providerKey: string, blockScope: string): number | undefined {
    return this.#inner.getCredentialBlock?.(credentialId, providerKey, blockScope)
  }

  getCredentialBlockScopes(credentialId: number, providerKey: string): ReadonlyMap<string, number> {
    return this.#inner.getCredentialBlockScopes?.(credentialId, providerKey) ?? new Map()
  }

  getCredentialBlockReconcileAfter(credentialId: number, providerKey: string, blockScope: string): number | undefined {
    return this.#inner.getCredentialBlockReconcileAfter?.(credentialId, providerKey, blockScope)
  }

  upsertCredentialBlock(block: StoredCredentialBlock): void {
    this.#inner.upsertCredentialBlock?.(block)
  }

  deleteCredentialBlock(credentialId: number, providerKey: string, blockScope: string): void {
    this.#inner.deleteCredentialBlock?.(credentialId, providerKey, blockScope)
  }

  deleteCredentialBlocks(credentialId: number): void {
    this.#inner.deleteCredentialBlocks?.(credentialId)
  }

  cleanExpiredCredentialBlocks(nowMs: number): void {
    this.#inner.cleanExpiredCredentialBlocks?.(nowMs)
  }

  listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
    return this.#inner.listCredentialBlocks?.(credentialIds) ?? []
  }
}

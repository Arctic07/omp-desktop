/**
 * Provider credentials: the desktop's keyring-backed keys, pushed into the *running* engine.
 *
 * The desktop stores keys in its own keyring and cannot make the engine read that store, so these
 * commands hand them over for the run the engine is serving. `provider_keys_set` installs a
 * rotation pool as in-memory credential rows, which is what the engine's selector rotates across;
 * a single key in a pool also goes back into the provider's environment variable.
 * `provider_key_clear` drops the pool and the variable. `provider_key_set` is the older single-key
 * runtime override, kept for the local-configuration import path.
 *
 * Nothing is persisted by the engine on any path - no key is written to `models.yml` or to the
 * engine's credential store - so the keyring stays the one place the secret lives. Because a value
 * passes through this process on its way to the engine, it must never be logged or echoed: every
 * answer carries the provider id and the auth source *kind* the engine now resolves, and nothing
 * else.
 */

import type { BootServices } from './boot.ts'
import { requireText } from './capabilities.ts'
import { PROVIDER_ID_MAX, PROVIDER_KEY_CHARS_MAX } from './constants.ts'
import { invalidInput } from './protocol/errors.ts'
import { normalizeKeys } from './provider-keys.ts'

/**
 * `provider_key_set`: validates the pair, installs the runtime override, then answers with the
 * provider and the source kind the engine now resolves for it - never the key itself.
 */
export function setProviderKey(services: BootServices, providerId: unknown, apiKey: unknown): Record<string, unknown> {
  const provider = requireText(providerId, 'providerId', PROVIDER_ID_MAX)
  const key = requireText(apiKey, 'apiKey', PROVIDER_KEY_CHARS_MAX)
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw invalidInput('apiKey must not contain control characters.')
  }
  services.auth.keys.setRuntime(provider, key)
  return { provider, source: services.auth.keys.source(provider)?.kind ?? null }
}

/**
 * `provider_keys_set`: installs a whole rotation pool as in-memory credentials.
 *
 * The engine rotates across stored `api_key` rows on an auth failure or an exhausted quota window,
 * so the pool must be visible to its own selector. A single key also goes back into the provider's
 * environment variable, which is what engine paths that open a fresh auth storage read; a pool of
 * two or more cannot be expressed that way, so the variable is removed and the stored rows serve.
 * Nothing is persisted: the keyring remains the one place a secret lives.
 */
export async function setProviderKeys(
  services: BootServices,
  providerId: unknown,
  apiKeys: unknown,
): Promise<Record<string, unknown>> {
  const provider = requireText(providerId, 'providerId', PROVIDER_ID_MAX)
  let keys: string[]
  try {
    keys = normalizeKeys(Array.isArray(apiKeys) ? apiKeys : [])
  } catch (error) {
    throw invalidInput(error instanceof Error ? error.message : 'apiKeys is not a valid key list.')
  }
  // The environment name is never taken from the frame: the store's allow-list decides what may be
  // written, so a buggy or hostile frame cannot name `PATH` or `HOME`.
  const env = services.providerKeys.allowedEnv(provider)
  const single = keys.length === 1 && env !== ''
  // The pool is installed first: it is the only step that can refuse (the provider cap), and a
  // refusal must leave the environment and the previous pool untouched.
  try {
    services.providerKeys.set(provider, env, keys)
  } catch (error) {
    throw invalidInput(error instanceof Error ? error.message : 'the key pool was refused.')
  }
  const previousEnv = single ? process.env[env] : undefined
  if (single) process.env[env] = keys[0]
  // The Rust side rewrote `models.yml` before this frame, and the two directions need opposite
  // orders around the environment variable. A one-key provider's new `apiKey: <variable>` line is
  // resolved only once the variable holds the key, so the write comes first. A pool's new
  // `auth: none` drops that line, so the re-parse comes first and the variable is deleted after it;
  // deleting first would leave the old config resolver reading the variable's own name as a bearer.
  try {
    await services.registry.refresh('offline')
  } catch (error) {
    // Put back what this frame changed so a failed re-parse does not leave a key in the environment
    // (or a pool) that the answer says was not installed.
    if (single) {
      if (previousEnv === undefined) delete process.env[env]
      else process.env[env] = previousEnv
    }
    services.providerKeys.clear(provider)
    throw invalidInput(
      error instanceof Error ? error.message : 'the model configuration could not be re-read.',
    )
  }
  services.auth.keys.removeRuntime(provider)
  if (!single && env !== '') delete process.env[env]
  await services.auth.credentials.reload()
  return {
    provider,
    source: services.auth.keys.source(provider)?.kind ?? null,
    count: keys.length,
    // The rows are installed whatever the cascade resolves for the provider now: an OAuth login
    // outranks them, but the pool is in place and the page must not say "after a restart".
    live: true,
  }
}

/**
 * `provider_key_clear`: drops the runtime override, the in-memory pool and the provider's
 * environment variable, so the provider falls back to whatever the engine's own precedence finds
 * next (a `models.yml` config key, a stored credential, or nothing), and answers with the source
 * kind that fallback resolves to.
 */
export async function clearProviderKey(
  services: BootServices,
  providerId: unknown,
): Promise<Record<string, unknown>> {
  const provider = requireText(providerId, 'providerId', PROVIDER_ID_MAX)
  await services.registry.refresh('offline')
  const env = services.providerKeys.allowedEnv(provider)
  services.providerKeys.clear(provider)
  services.auth.keys.removeRuntime(provider)
  if (env !== '') delete process.env[env]
  await services.auth.credentials.reload()
  return { provider, source: services.auth.keys.source(provider)?.kind ?? null }
}

/**
 * Process-level engine initialization (contract §5).
 *
 * The shared `settings` + `auth` + `registry` trio (and the key pool layered into `auth`) is built
 * once and injected into every session:
 * omitting it makes each `createAgentSession` re-read `models.yml` and refresh in the background,
 * which the SDK measures at 1.3-1.5 s per session.
 */

import * as path from 'node:path'

import type { AuthStorage, ModelRegistry, Settings } from './sdk.ts'
import type { HostPaths } from './env.ts'
import type { SdkBundle } from './sdk.ts'
import { logError, logLine } from './log.ts'
import { parseProviderKeyPools, ProviderKeyStore } from './provider-keys.ts'
import { convergeProductDefaults } from './settings.ts'

/** The process-wide engine services every session shares. */
export interface BootServices {
  readonly settings: Settings
  readonly auth: AuthStorage
  /** This process's rotation pools, updated by `provider_keys_set` while it runs. */
  readonly providerKeys: ProviderKeyStore
  readonly registry: ModelRegistry
}

/** How long each initialization step took, for `ready.initMs` evidence. */
export interface BootTiming {
  readonly settingsMs: number
  readonly authMs: number
  readonly registryMs: number
  readonly modelsAvailable: number
}

/** Builds the shared engine services. Called exactly once per host process. */
export async function bootServices(paths: HostPaths, sdk: SdkBundle): Promise<{ services: BootServices; timing: BootTiming }> {
  const settingsStart = performance.now()
  const settings = await sdk.Settings.init({ cwd: paths.defaultWorkspace, agentDir: paths.agentDir })
  const settingsMs = performance.now() - settingsStart

  const authStart = performance.now()
  // The spawn payload is read once and removed from the environment: a tool child must never
  // inherit every provider's whole key pool.
  const rawPools = process.env.OMP_DESKTOP_PROVIDER_KEYS
  delete process.env.OMP_DESKTOP_PROVIDER_KEYS
  const parsedPools = parseProviderKeyPools(rawPools)
  // A refused entry is loud: the alternative is a provider that starts keyless with only a
  // successful-looking boot to show for it.
  for (const error of parsedPools.errors) {
    logError('the provider key pools in the spawn environment carried a refused entry', error)
  }
  const store = await sdk.SqliteAuthCredentialStore.open(path.join(paths.agentDir, 'agent.db'))
  const providerKeys = new ProviderKeyStore(store, parsedPools)
  const auth = new sdk.AuthStorage(providerKeys)
  // The engine's pool is an in-process cache that starts empty; without this read neither the
  // stored credentials nor the pools above are visible to the first request.
  await auth.credentials.reload()
  const authMs = performance.now() - authStart

  // The product's own defaults, written only where the reader has never chosen a value. Before the
  // registry so the first session of this process already runs under them.
  await convergeProductDefaults({ settings })

  const registryStart = performance.now()
  const registry = new sdk.ModelRegistry(auth, path.join(paths.agentDir, 'models.yml'), { settings })
  await registry.hydrateCredentialScopedModelCaches()
  const registryMs = performance.now() - registryStart

  const models = registry.getAvailable()
  logLine(`engine services ready: ${models.length} model(s) available, registry error=${registry.getError() ?? 'none'}`)

  return {
    services: { settings, auth, providerKeys, registry },
    timing: {
      settingsMs: Math.round(settingsMs * 10) / 10,
      authMs: Math.round(authMs * 10) / 10,
      registryMs: Math.round(registryMs * 10) / 10,
      modelsAvailable: models.length,
    },
  }
}

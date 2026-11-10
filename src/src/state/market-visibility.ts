import { createStore, useStore } from '@/state/store'

/**
 * Which marketplace sources are switched off for browsing in this process.
 *
 * The switch is a browsing filter, not registry state: the engine keeps every source registered and
 * removable, and a restart starts with everything on. It is process-level rather than a persisted
 * preference for that reason — a source switched off for one look is not a permanent configuration,
 * and a page that reopened on a placeholder because the only source was left off had no default to
 * fall back to.
 */
const disabledMarketplacesStore = createStore<readonly string[]>([])

export function useDisabledMarketplaces(): readonly string[] {
  return useStore(disabledMarketplacesStore)
}

/** Switch one source on or off; naming a source that is already in that state changes nothing. */
export function setMarketplaceEnabled(name: string, enabled: boolean): void {
  disabledMarketplacesStore.set((current) => {
    if (enabled) return current.includes(name) ? current.filter((entry) => entry !== name) : current
    return current.includes(name) ? current : [...current, name]
  })
}

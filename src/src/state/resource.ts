/**
 * One host-backed list, as this frontend holds it.
 *
 * Every settings section that reads engine state reads it the same way: a whole payload, replaced
 * wholesale by the host's own answer, with a read in flight, a read that failed, and the value from
 * the last read all distinguishable. That is one shape, so it is one implementation — six
 * near-identical stores would be six places for the same three bugs.
 *
 * Three rules the callers depend on:
 *
 * - **A later answer always wins.** Each read takes a sequence number and only the newest one is
 *   applied, so a slow read that started before a write cannot put its stale value back on screen.
 * - **A read in flight is not doubled.** `read()` answers with the promise already running rather
 *   than starting a second round trip; `{ force: true }` is the caller saying "ask again anyway",
 *   which is what a refresh button means.
 * - **A write's answer is adopted, not patched.** `adopt` installs the view a write returned, and it
 *   also invalidates any read still in flight — the write is newer than anything that started before
 *   it.
 */

import type { ApiError } from '@/api/client'
import { toApiError } from '@/api/client'
import { createStore, type Store } from '@/state/store'
import { useSyncExternalStore } from 'react'

export interface ResourceState<T> {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: ApiError | null
  /** The last answer, kept while a re-read runs so a refresh does not blank the page. */
  value: T | null
}

interface Resource<T> {
  store: Store<ResourceState<T>>
  /** Read the host's answer. Resolves when this read settles, whether it applied or not. */
  read(options?: { force?: boolean }): Promise<void>
  /** Install a write's own answer: it is newer than anything in flight. */
  adopt(value: T): void
  /** Forget everything, so the next read is a first read. */
  reset(): void
}

/** The three rules above, written once; `fetchValue` is called afresh for every read. */
function createCore<T>(fetchValue: () => Promise<T>): Resource<T> {
  const store = createStore<ResourceState<T>>({ status: 'idle', error: null, value: null })
  let sequence = 0
  let inFlight: Promise<void> | null = null

  function run(): Promise<void> {
    const mine = ++sequence
    store.set({ status: 'loading', error: null, value: store.get().value })
    const settled = fetchValue().then(
      (value) => {
        if (mine !== sequence) return
        store.set({ status: 'ready', error: null, value })
      },
      (error: unknown) => {
        if (mine !== sequence) return
        store.set({ status: 'error', error: toApiError(error), value: store.get().value })
      },
    )
    inFlight = settled
    return settled.finally(() => {
      if (inFlight === settled) inFlight = null
    })
  }

  return {
    store,
    read({ force = false } = {}) {
      if (!force) {
        if (inFlight !== null) return inFlight
        if (store.get().status === 'ready') return Promise.resolve()
      }
      return run()
    },
    adopt(value) {
      sequence += 1
      store.set({ status: 'ready', error: null, value })
    },
    reset() {
      sequence += 1
      store.set({ status: 'idle', error: null, value: null })
    },
  }
}

export function createResource<T>(fetchValue: () => Promise<T>): Resource<T> {
  return createCore(fetchValue)
}

/**
 * A resource whose payload belongs to one key.
 *
 * The engine answers most of these payloads per project or per subject, so a value read for one key
 * is not an answer for another. `read(key)` therefore asks the host whenever the key differs from
 * the one the last answer (or the read in flight) belongs to, and does nothing when it does not —
 * which is what makes it safe to call from an effect that also fires on mount and under a
 * double-invoked render.
 *
 * `force` is the retry/refresh path and always asks.
 */
interface KeyedResource<K, T> {
  store: Store<ResourceState<T>>
  /** Read the answer for one key. Idempotent for the key already answered. */
  read(key: K, options?: { force?: boolean }): Promise<void>
  adopt(value: T): void
  reset(): void
}

export function createKeyedResource<K, T>(
  fetchValue: (key: K) => Promise<T>,
  sameKey: (a: K, b: K) => boolean = Object.is,
): KeyedResource<K, T> {
  /** The key the current value, or the read in flight, belongs to. */
  let target: K | undefined
  const resource = createCore<T>(() => fetchValue(target as K))

  return {
    store: resource.store,
    read(key, { force = false } = {}) {
      if (!force && target !== undefined && sameKey(target, key) && resource.store.get().status !== 'idle') {
        return resource.read()
      }
      target = key
      return resource.read({ force: true })
    },
    adopt(value) {
      resource.adopt(value)
    },
    reset() {
      target = undefined
      resource.reset()
    },
  }
}

/** A resource keyed by the workspace its payload belongs to. */
type WorkspaceResource<T> = KeyedResource<number | null, T>

export function createWorkspaceResource<T>(
  fetchValue: (workspaceId: number | null) => Promise<T>,
): WorkspaceResource<T> {
  return createKeyedResource<number | null, T>(fetchValue)
}

/**
 * The whole state of one resource.
 *
 * The state object is replaced on every write and every read, so this re-renders on each of them —
 * which is what a section wants, and cheap: a resource is written by a host round trip, never by a
 * keystroke.
 */
export function useResourceState<T>(resource: {
  store: Store<ResourceState<T>>
}): ResourceState<T> {
  const { store } = resource
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

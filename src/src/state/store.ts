/**
 * A minimal external store, bound to React with `useSyncExternalStore`.
 *
 * There is no state library in this project and none is added for this: a conversation, a workspace
 * list and a model catalogue are each one object replaced wholesale, which is all this needs. A
 * store owns exactly one piece of state, and every writer goes through `set`, so "who changed this"
 * has one answer.
 *
 * `useStoreSelector` caches by state identity, so a selector that builds a new object each call
 * would report a change on every read and loop. Selectors here therefore return a field, a length,
 * or a reference the state already holds — never a fresh array or object literal.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react'

export interface Store<T> {
  get(): T
  set(next: T | ((previous: T) => T)): void
  subscribe(listener: () => void): () => void
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set(next) {
      const value = typeof next === 'function' ? (next as (previous: T) => T)(state) : next
      if (Object.is(value, state)) return
      state = value
      for (const listener of listeners) {
        // One subscriber throwing must not keep the others from seeing the new state, and must not
        // make the write itself fail: a writer like `sendPromptTo` appends the reader's row first
        // and sends the prompt second, so an exception escaping here would leave a prompt on screen
        // that never reached the engine (2026-10-22). React's error boundaries catch a render, not a
        // `useSyncExternalStore` listener body, so this is the one place the fan-out can be held.
        try {
          listener()
        } catch (error) {
          console.error('a store listener failed', error)
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** The whole state, re-rendering on every write. */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/**
 * One field of a store's state.
 *
 * `select` must be stable across renders or return a value the state already holds: the cache below
 * is keyed on the state object **and** the selector, so an unstable selector costs a recompute but
 * never an answer from the previous selector. A selector that closes over a prop (a conversation id)
 * changes identity when that prop changes while the store does not, and caching by state alone would
 * hand the caller the value it computed for the previous prop — a value React then compares equal to
 * the last render and never corrects.
 */
export function useStoreSelector<T, S>(store: Store<T>, select: (state: T) => S): S {
  const cache = useRef<{ state: T; select: (state: T) => S; value: S } | null>(null)
  const getSnapshot = useCallback(() => {
    const state = store.get()
    const cached = cache.current
    if (cached && cached.select === select && Object.is(cached.state, state)) return cached.value
    const value = select(state)
    cache.current = { state, select, value }
    return value
  }, [store, select])
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

/**
 * The notices plugins asked for, as the shell shows them.
 *
 * A notice is the one thing a plugin can say that the reader does not have to answer: the bridge call
 * that asked for it is already answered by the time it is drawn (`notify` is granted with the
 * plugin), so this module owns only the display — a short stack in a corner, each line dismissed by
 * the reader or by its own timer.
 *
 * Three rules keep it from becoming noise:
 *
 * - **Bounded and newest-first.** At most `MAX_VISIBLE_NOTICES` are on screen; a fourth drops the
 *   oldest, because a plugin that floods the corner is a plugin whose notices the reader stops
 *   reading either way.
 * - **Every notice expires.** A notice that never leaves is a permanent overlay nobody asked for, so
 *   each one carries its own timer, and a notice dropped early has its timer cleared with it.
 * - **Nothing here is interactive.** The stack takes no focus and blocks no click outside itself: it
 *   is a corner, not a dialog, and its only control is the dismiss button.
 *
 * Owner / bound / release: owned by the shell's process, like the listener that fills it; bounded by
 * `MAX_VISIBLE_NOTICES` (so at most that many timers are ever live); released by its own timer and by
 * the dismiss button. There is no teardown to write, because the shell that owns it lives as long as
 * the process does.
 */

import { useSyncExternalStore } from 'react'

import type { PluginNoticeEvent } from '@/api/plugins-types'
import { createStore } from '@/state/store'

/** How many notices may be on screen at once. */
const MAX_VISIBLE_NOTICES = 3

/** How long one notice stays before it dismisses itself, in milliseconds. */
const NOTICE_LIFETIME_MS = 6_000

/** One notice as the stack draws it: what the plugin said, plus the key its timer and button use. */
interface ShownPluginNotice extends PluginNoticeEvent {
  key: number
}

const pluginNoticeStore = createStore<readonly ShownPluginNotice[]>([])

let nextKey = 0
const timers = new Map<number, number>()

function forget(key: number): void {
  const timer = timers.get(key)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timers.delete(key)
  }
  pluginNoticeStore.set(pluginNoticeStore.get().filter((notice) => notice.key !== key))
}

/** Draw one notice, newest first, dropping the oldest when the stack is full. */
export function showPluginNotice(notice: PluginNoticeEvent): void {
  nextKey += 1
  const key = nextKey
  const shown: ShownPluginNotice = { ...notice, key }
  pluginNoticeStore.set((previous) => {
    const next = [shown, ...previous]
    for (const dropped of next.slice(MAX_VISIBLE_NOTICES)) forget(dropped.key)
    return next.slice(0, MAX_VISIBLE_NOTICES)
  })
  timers.set(key, window.setTimeout(() => forget(key), NOTICE_LIFETIME_MS))
}

export function dismissPluginNotice(key: number): void {
  forget(key)
}

/** The notices on screen, newest first. */
export function usePluginNotices(): readonly ShownPluginNotice[] {
  return useSyncExternalStore(
    pluginNoticeStore.subscribe,
    pluginNoticeStore.get,
    pluginNoticeStore.get,
  )
}

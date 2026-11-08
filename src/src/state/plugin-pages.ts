/**
 * The current workspace's plugin page projection and its React-facing resource hook.
 *
 * Pure placement and compatibility rules live in `plugin-pages-rules.ts`; this file owns only the
 * host-backed resource subscription. Keeping the two apart prevents a page-list regression from
 * requiring a running Tauri shell to test.
 */

import { useMemo } from 'react'

import { useLanguage } from '@/lib/i18n'
import { pluginsResource } from '@/state/plugins-store'
import { useResourceState } from '@/state/resource'

export {
  pageForKey,
  pluginPageKey,
  pluginPagesOf,
  toolAvailability,
} from './plugin-pages-rules'
export type {
  PluginPageKind,
  PluginPageRef,
  PluginPages,
  PluginWorkTabRef,
} from './plugin-pages-rules'
import type { PluginPages } from './plugin-pages-rules'
import { pluginPagesOf } from './plugin-pages-rules'

/**
 * The pages the current workspace's installed plugins contribute.
 *
 * The shell reads the list once per workspace (`App.tsx`), and every surface that offers a page —
 * the rail's plugin group, the work panel's tabs and a plugin's settings page — reads this one
 * projection. The memo is keyed on the resource's whole answer, so a write's adopted view or a
 * language switch is exactly what recomputes it.
 */
export function usePluginPages(): PluginPages {
  const state = useResourceState(pluginsResource)
  const { language } = useLanguage()
  const pages = useMemo(
    () => pluginPagesOf(state.value?.plugins ?? [], language),
    [state.value, language],
  )
  console.log(
    `[probe] plugin pages rows=${state.value?.plugins.length ?? -1} sidebar=${pages.sidebar.length} workTabs=${pages.workTabs.length} error=${state.error ?? 'none'}`,
  )
  return pages
}

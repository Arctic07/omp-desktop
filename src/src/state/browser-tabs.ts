/**
 * Browser tabs as the shell opens them: one call to the desktop, one tab in the strip.
 *
 * The desktop owns the guest page; this module is the join between the panel's tab records and the
 * page ids the desktop issues. Every opener here is idempotent: a plain "open Browser" reuses the
 * conversation's default tab, while an address or a preview gets a tab of its own.
 */

import {
  browserOpenTab,
  browserPages,
  type BrowserOpened,
  type BrowserState,
} from '@/api/browser'
import { openBrowserTab, restoreBrowserTabs, updateBrowserTab } from '@/state/panel-store'
import { browserTabLabel, type BrowserTab } from '@/state/panel-tabs'
import { terminalTargetOf } from '@/state/terminal-tabs'

/** The workspace root a conversation's local previews resolve against. */
export function browserWorkspaceRoot(sessionId: string): string | null {
  const root = terminalTargetOf(sessionId)?.cwd
  return root === undefined || root === '' ? null : root
}

/** One page's state as the strip's tab record. */
export function browserTabFromState(state: BrowserState): BrowserTab {
  return {
    tabId: state.tabId,
    location: state.url,
    label: !state.isLoading && !state.loadError && state.title ? state.title : browserTabLabel(state.url),
    loading: state.isLoading,
    loadError: state.loadError,
  }
}

function adopt(sessionId: string, opened: BrowserOpened): string {
  openBrowserTab(sessionId, {
    tabId: opened.tabId,
    location: opened.state?.url ?? '',
    label: opened.state
      ? browserTabFromState(opened.state).label
      : '浏览器',
    loading: opened.state?.isLoading ?? false,
    loadError: opened.state?.loadError,
  })
  if (opened.state) updateBrowserTab(sessionId, opened.state)
  return opened.tabId
}

/**
 * Open the conversation's Browser tab, or jump to the one it already has.
 *
 * A plain open does not create a second tab: the reader asked for the browser, not for another
 * copy of it. `url` is the link/preview path, which always gets a tab of its own.
 */
export async function openBrowserForSession(
  sessionId: string,
  url?: string,
  path?: string,
  preview?: boolean,
): Promise<string | null> {
  if (!url && !path && !preview) {
    const existing = (await browserPages(sessionId)).find((page) => page.tabId === 'default')
    if (existing) {
      // `openBrowserTab` both records the tab and opens the column; a plain select would leave a
      // closed panel closed when the reader asked for the browser.
      openBrowserTab(sessionId, browserTabFromState(existing))
      updateBrowserTab(sessionId, existing)
      return existing.tabId
    }
  }
  try {
    const opened = await browserOpenTab({
      sessionId,
      workspaceRoot: browserWorkspaceRoot(sessionId),
      url,
      path,
      preview,
    })
    return adopt(sessionId, opened)
  } catch {
    return null
  }
}

/** Rebuild the conversation's browser tabs from the pages the desktop still holds. */
export async function restoreBrowserTabsForSession(sessionId: string): Promise<void> {
  try {
    const pages = await browserPages(sessionId)
    restoreBrowserTabs(sessionId, pages)
  } catch {
    // A desktop that cannot answer leaves the strip as it was; the next open recreates the page.
  }
}

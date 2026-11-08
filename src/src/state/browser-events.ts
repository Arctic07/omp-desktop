/**
 * The browser's two shell-side events: the agent/link asking for a tab, and a guest's `window.open`.
 *
 * The work panel owns tabs, so the desktop never opens one itself: it says which conversation and
 * page asked, and this module records the tab the reader sees. Every event that arrives here names a
 * conversation (`browserEventSession`): a plugin's own built-in-browser page (`pi.browser.*`) belongs
 * to an installation, and `services::browser` announces nothing about it - so no plugin can draw a
 * tab here, or name a conversation it does not have. A page's own state arrives on the separate
 * `browser-state` channel, which the chrome subscribes to.
 */

import { useEffect } from 'react'

import { onBrowserOpen, onBrowserReveal, onBrowserState } from '@/api/browser'
import { browserEventSession, browserTabLabel } from '@/state/panel-tabs'
import { browserTabsOf, openBrowserTab, selectBrowserTab } from '@/state/panel-store'
import { browserTabFromState, openBrowserForSession } from '@/state/browser-tabs'

/** Wire the browser's shell events for the life of the window. */
export function useBrowserEvents(): void {
  useEffect(() => {
    let live = true
    const stops: (() => void)[] = []
    void onBrowserReveal((event) => {
      const sessionId = browserEventSession(event)
      const tabId = event.tabId?.trim()
      if (!live || sessionId === null || !tabId) return
      const known = browserTabsOf(sessionId).some((tab) => tab.tabId === tabId)
      if (known) {
        selectBrowserTab(sessionId, tabId)
        return
      }
      const url = event.url ?? ''
      openBrowserTab(sessionId, {
        tabId,
        location: url,
        label: browserTabLabel(url),
        loading: false,
      })
    }).then((stop) => {
      if (live) stops.push(stop)
      else stop()
    })
    void onBrowserOpen((event) => {
      const sessionId = browserEventSession(event)
      if (!live || sessionId === null || !event.url) return
      void openBrowserForSession(sessionId, event.url)
    }).then((stop) => {
      if (live) stops.push(stop)
      else stop()
    })
    // A page the desktop holds but the strip does not is a tab the reader lost (a reveal that
    // crossed a renderer reload, say). The page's own state is enough to put it back.
    void onBrowserState((event) => {
      const sessionId = browserEventSession(event)
      if (!live || sessionId === null || !event.tabId) return
      if (browserTabsOf(sessionId).some((tab) => tab.tabId === event.tabId)) return
      openBrowserTab(sessionId, browserTabFromState(event))
    }).then((stop) => {
      if (live) stops.push(stop)
      else stop()
    })
    return () => {
      live = false
      for (const stop of stops) stop()
    }
  }, [])
}

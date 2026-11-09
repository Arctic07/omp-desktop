/**
 * Every web address this document is asked to open, opened in the built-in browser by default.
 *
 * One source: a click on an anchor. One listener at the document rather than a handler per anchor,
 * so workspace links in a conversation's Markdown, a settings page's own documentation link and
 * anything a later surface adds all end here, and none of them can forget to. The reference
 * desktop's default is the work-panel browser; a modified click (Ctrl/Cmd/Shift/Alt) asks for the
 * machine's own browser instead, which is also the fallback when no conversation is on screen. An
 * anchor marked `data-external` states that the machine's own browser is its only destination — the
 * About page's resource rows say so in their own description — so it opens there on a plain click
 * too.
 *
 * Nothing is navigated here: the application's own webview must never replace itself with a web
 * page. A refusal is swallowed — the reader can see that nothing opened, and an error dialog over a
 * link click is worse than the click doing nothing.
 */

import { useEffect } from 'react'

import { openExternal } from '@/api/system'
import { openBrowserForSession } from '@/state/browser-tabs'
import { activeRecord, sessionStore } from '@/state/session-store'

export function useDocumentLinks(): void {
  useEffect(() => {
    function onClick(event: MouseEvent): void {
      // A non-primary click belongs to the platform's own conventions; a handler that has already
      // answered the click keeps its answer.
      if (event.defaultPrevented || event.button !== 0) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a[href]')
      const href = anchor?.getAttribute('href')
      if (href === null || href === undefined) return
      // Every anchor belongs to this document's own answer, never to the webview's navigation: the
      // application's page must not be replaced by a site it cannot show.
      event.preventDefault()
      if (!/^https?:\/\//i.test(href)) return
      const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
      const sessionId = activeRecord(sessionStore.get())?.id ?? null
      if (modified || sessionId === null || anchor?.hasAttribute('data-external')) {
        void openExternal(href).catch(() => undefined)
        return
      }
      void openBrowserForSession(sessionId, href).then((tabId) => {
        if (tabId === null) void openExternal(href).catch(() => undefined)
      })
    }

    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])
}

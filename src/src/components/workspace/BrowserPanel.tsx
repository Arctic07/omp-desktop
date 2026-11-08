/**
 * The built-in browser's chrome: back / forward / reload / address / open externally, and the hole
 * the native guest sits in.
 *
 * The guest is a child webview the desktop owns (`src-tauri/src/services/browser`), so this
 * component draws everything *around* it and measures the hole: the empty/loading/stopped/failed
 * states, the address bar that keeps what the reader is typing, and the visibility handshake that
 * keeps the native page from covering a popover or dialog that actually sits over it. The agent's
 * own hold of the page is *not* a reason to hide it — it is named by a band above the hole
 * (`state/browser-agent.ts`).
 */

import { ExternalLink, Globe, Loader2, RotateCw, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import {
  browserAction,
  browserGetState,
  browserNavigate,
  browserOpenExternal,
  browserSetBounds,
  browserSetVisible,
  browserShowTab,
  onBrowserState,
  type BrowserState,
} from '@/api/browser'
import { Loader } from '@/components/motion/loader'
import { useCopy, type Localized } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { agentBrowserIntent, agentDrivesBrowser } from '@/state/browser-agent'
import {
  blockingOverlayCovers,
  useBlockingOverlayRevision,
} from '@/state/overlay-depth'
import { browserWorkspaceRoot } from '@/state/browser-tabs'
import type { BrowserTab } from '@/state/panel-tabs'
import { updateBrowserTab } from '@/state/panel-store'
import { sessionStore, type SessionStoreState } from '@/state/session-record'
import { useStoreSelector } from '@/state/store'

interface BrowserCopy {
  back: string
  forward: string
  reload: string
  stop: string
  external: string
  placeholder: string
  emptyTitle: string
  emptyBody: string
  loadingTitle: string
  loadingBody: string
  stoppedTitle: string
  stoppedBody: string
  failedTitle: string
  failedBody: string
  localFileBody: string
  agentTitle: string
  agentBody: string
}

const COPY: Localized<BrowserCopy> = {
  en: {
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    stop: 'Stop',
    external: 'Open externally',
    placeholder: 'Search or enter a URL',
    emptyTitle: 'No page open',
    emptyBody: 'Enter an address, or preview an HTML file from the conversation.',
    loadingTitle: 'Loading page…',
    loadingBody: 'Waiting for the website to respond. You can stop or enter another address.',
    stoppedTitle: 'Loading stopped',
    stoppedBody: 'Enter an address to try again.',
    failedTitle: 'Could not open this page',
    failedBody: 'Check the address or connection, then try again.',
    localFileBody: 'Only existing local files can be opened.',
    agentTitle: 'The agent is driving this page',
    agentBody: 'The page stays live; the toolbar returns when its turn ends.',
  },
  zh: {
    back: '后退',
    forward: '前进',
    reload: '重新加载',
    stop: '停止',
    external: '在外部打开',
    placeholder: '搜索或输入网址',
    emptyTitle: '尚未打开页面',
    emptyBody: '输入地址，或从对话预览 HTML 文件。',
    loadingTitle: '正在加载网页…',
    loadingBody: '正在等待网站响应，可以停止加载或输入其他地址。',
    stoppedTitle: '已停止加载',
    stoppedBody: '输入网址可重新打开页面。',
    failedTitle: '无法打开此页面',
    failedBody: '请检查网址或网络连接，然后重试。',
    localFileBody: '只能打开已存在的本地文件。',
    agentTitle: 'Agent 正在操作此页面',
    agentBody: '页面保持可见，这一轮结束后工具栏恢复。',
  },
}

/** One icon control in the toolbar. */
function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  )
}

export interface BrowserPanelProps {
  sessionId: string
  tab: BrowserTab
  /** The tab is the one on screen in an open work panel. */
  active: boolean
}

export function BrowserPanel({ sessionId, tab, active }: BrowserPanelProps) {
  const copy = useCopy(COPY)
  const [state, setState] = useState<BrowserState | null>(null)
  const [address, setAddress] = useState(tab.location)
  const [focused, setFocused] = useState(false)
  /** Changes whenever a popover or dialog opens or closes; the hole may now be covered. */
  const overlayRevision = useBlockingOverlayRevision()
  /**
   * Whether the agent is driving this conversation's page, and what it is doing with it.
   *
   * Two selectors, not one object: a selector that built `{ driving, intent }` would be a new
   * reference on every read and loop the store (`state/store.ts`).
   */
  const selectDriving = useCallback(
    (state: SessionStoreState) => agentDrivesBrowser(state.records[sessionId]),
    [sessionId],
  )
  const selectIntent = useCallback(
    (state: SessionStoreState) => agentBrowserIntent(state.records[sessionId]),
    [sessionId],
  )
  const agentDriving = useStoreSelector(sessionStore, selectDriving)
  const agentIntent = useStoreSelector(sessionStore, selectIntent)
  const focusedRef = useRef(focused)
  useLayoutEffect(() => {
    focusedRef.current = focused
  }, [focused])
  const holeRef = useRef<HTMLDivElement | null>(null)
  /** The running layout-tracking frame, and when it may stop. */
  const frameRef = useRef(0)
  const deadlineRef = useRef(0)
  /** The last rect sent, so a frame that finds nothing moved sends nothing. */
  const lastRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const visibleRef = useRef(false)
  const activeRef = useRef(active)
  const locationRef = useRef(tab.location)
  useLayoutEffect(() => {
    activeRef.current = active
    locationRef.current = tab.location
  }, [active, tab.location])
  const workspaceRoot = browserWorkspaceRoot(sessionId)

  const paint = useCallback((next: BrowserState | null) => {
    setState(next)
    if (!focusedRef.current && next) setAddress(next.url)
  }, [])

  // One page's state events, filtered to this tab. The desktop emits one event per page; the tab
  // that hears it is the one whose id matches, and the strip's label follows the same event.
  useEffect(() => {
    let live = true
    const stop = onBrowserState((event) => {
      if (!live || event.sessionId !== sessionId || event.tabId !== tab.tabId) return
      setState(event)
      if (!focusedRef.current) setAddress(event.url)
      updateBrowserTab(sessionId, event)
    })
    return () => {
      live = false
      void stop.then((unlisten) => unlisten())
    }
  }, [sessionId, tab.tabId])

  /**
   * Measure the hole and tell the desktop where the guest sits.
   *
   * This runs on a short frame loop, not only on resize: switching conversations changes the work
   * column's width *and* its x, and a native child webview is placed in window coordinates. A
   * `ResizeObserver` sees the width change but not a position-only move (the left column or a
   * transition moving the panel), so the loop compares the whole rect for a few frames after every
   * layout commit. It sends an IPC only when the rect or visibility actually changed.
   */
  const report = useCallback(() => {
    const hole = holeRef.current
    if (!hole) return
    const rect = hole.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) {
      // A zero-sized hole is a transient layout (a closing panel, a transition's first frame). It
      // is not a visibility decision: hiding here is what left an active tab black until the next
      // conversation switch re-reported its hole.
      lastRectRef.current = null
      return
    }
    // A native guest always paints above this document, so a surface can only show over it by
    // hiding it — and only a surface whose rectangle actually covers the hole is over it. A menu
    // above the title bar or a card above the composer is not, and hiding for those was what
    // blacked the browser out whenever one opened.
    const visible = activeRef.current && !blockingOverlayCovers(rect)
    const last = lastRectRef.current
    const moved =
      last === null ||
      Math.abs(last.x - rect.x) > 0.5 ||
      Math.abs(last.y - rect.y) > 0.5 ||
      Math.abs(last.width - rect.width) > 0.5 ||
      Math.abs(last.height - rect.height) > 0.5
    if (moved) {
      const next = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      // Bounds first, then the visibility wish: the desktop applies the wish to the rectangle it
      // holds, and a failed bounds send leaves the last rectangle unrecorded so the next frame
      // retries it.
      void browserSetBounds({ sessionId, tabId: tab.tabId, rect: next })
        .then(() => {
          lastRectRef.current = next
          if (visible !== visibleRef.current) {
            visibleRef.current = visible
            void browserSetVisible({ sessionId, tabId: tab.tabId, visible }).catch(() => undefined)
          }
        })
        .catch(() => {
          lastRectRef.current = null
        })
      return
    }
    if (visible !== visibleRef.current) {
      visibleRef.current = visible
      void browserSetVisible({ sessionId, tabId: tab.tabId, visible }).catch(() => undefined)
    }
  }, [sessionId, tab.tabId])

  /** Track the hole for a settle window, so a transition's position-only movement is not missed. */
  const track = useCallback(() => {
    deadlineRef.current = performance.now() + 700
    if (frameRef.current) return
    const tick = () => {
      frameRef.current = 0
      report()
      if (performance.now() < deadlineRef.current) {
        frameRef.current = requestAnimationFrame(tick)
      }
    }
    frameRef.current = requestAnimationFrame(tick)
  }, [report])

  // The page this chrome is showing, as the desktop needs to hear it. The call is what puts the
  // page in the main window; the geometry arrives on the next layout.
  useEffect(() => {
    if (!active) return
    let live = true
    // A page the desktop recreated has no bounds of its own; force the next report to send them,
    // and let that report state the visibility again as well.
    lastRectRef.current = null
    visibleRef.current = false
    void browserShowTab({
      sessionId,
      tabId: tab.tabId,
      url: locationRef.current || null,
      workspaceRoot,
    }).then(() => {
      if (!live) return
      // The layout effect may already have reported before this call landed; `show_tab` marked the
      // page's bounds stale, so force the next frame to send the rectangle again.
      lastRectRef.current = null
      track()
      void browserGetState({ sessionId, tabId: tab.tabId })
        .then((next) => {
          if (live && next) paint(next)
        })
        .catch(() => undefined)
    }).catch(() => undefined)
    return () => {
      live = false
      visibleRef.current = false
      lastRectRef.current = null
      cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
      deadlineRef.current = 0
      void browserSetVisible({ sessionId, tabId: tab.tabId, visible: false }).catch(() => undefined)
    }
  }, [active, sessionId, tab.tabId, workspaceRoot, paint, track])

  useEffect(() => {
    const hole = holeRef.current
    if (!hole) return
    const observer = new ResizeObserver(track)
    observer.observe(hole)
    // The work column can move without its own size changing (the rail or the conversation column
    // beside it resizes); the stage it sits in changes size in both cases.
    const stage = hole.closest('[data-slot="sidebar-inset"]')
    if (stage) observer.observe(stage)
    window.addEventListener('resize', track)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', track)
      cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
  }, [track])

  // A surface opening or closing over the hole hides or shows the guest immediately; the frame
  // loop also catches a surface that was placed a frame late, but this is the state change that
  // must not wait for a layout. The agent's hold is not one of them: the page stays where it is,
  // and only the band above the hole appears (`report` never hears of it).
  useEffect(() => {
    if (active) track()
  }, [active, overlayRevision, track])

  const navigate = useCallback(() => {
    const value = address.trim()
    if (!value) return
    setState((current) => ({
      sessionId,
      tabId: tab.tabId,
      url: value,
      title: '',
      isLoading: true,
      canGoBack: current?.canGoBack ?? false,
      canGoForward: current?.canGoForward ?? false,
    }))
    void browserNavigate({ sessionId, tabId: tab.tabId, workspaceRoot, url: value })
      .then((next) => {
        if (next) paint(next)
      })
      .catch(() => {
        setState((current) =>
          current ? { ...current, isLoading: false, loadError: 'navigation failed' } : current,
        )
      })
  }, [address, paint, sessionId, tab.tabId, workspaceRoot])

  const run = useCallback(
    (action: 'back' | 'forward' | 'reload' | 'stop') => {
      void browserAction({ sessionId, tabId: tab.tabId, action }).catch(() => undefined)
    },
    [sessionId, tab.tabId],
  )

  const started = Boolean(state?.url) && !state?.loadError
  const phase = state?.loadError === 'ERR_ABORTED'
    ? 'stopped'
    : state?.loadError
      ? 'failed'
      : state?.isLoading
        ? 'loading'
        : 'empty'
  const title = phase === 'stopped'
    ? copy.stoppedTitle
    : phase === 'failed'
      ? copy.failedTitle
      : phase === 'loading'
        ? copy.loadingTitle
        : copy.emptyTitle
  const body = state?.loadError === 'LOCAL_FILE_NOT_ALLOWED'
    ? copy.localFileBody
    : phase === 'stopped'
      ? copy.stoppedBody
      : phase === 'failed'
        ? copy.failedBody
        : phase === 'loading'
          ? copy.loadingBody
          : copy.emptyBody

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col bg-pane">
      {/* The agent's turn owns the page: the toolbar is inert rather than merely disabled, so the
          address field cannot be focused or typed into and every control is out of the tab order.
          A navigation from here would replace the document the agent is working in. */}
      <div
        inert={agentDriving}
        className={cn(
          'flex h-10 shrink-0 items-center gap-1 border-border border-b px-2',
          agentDriving && 'opacity-60',
        )}
      >
        <IconButton label={copy.back} disabled={!state?.canGoBack} onClick={() => run('back')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </IconButton>
        <IconButton label={copy.forward} disabled={!state?.canGoForward} onClick={() => run('forward')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </IconButton>
        <IconButton
          label={state?.isLoading ? copy.stop : copy.reload}
          disabled={!started}
          onClick={() => run(state?.isLoading ? 'stop' : 'reload')}
        >
          {state?.isLoading ? <X className="size-3.5" /> : <RotateCw className="size-3.5" />}
        </IconButton>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            navigate()
          }}
        >
          <input
            value={address}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={copy.placeholder}
            aria-label={copy.placeholder}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              setFocused(true)
              event.currentTarget.select()
            }}
            onBlur={() => setFocused(false)}
            className="h-7 w-full rounded-md border border-border/80 bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </form>
        <IconButton
          label={copy.external}
          disabled={!state?.url}
          onClick={() => {
            void browserOpenExternal({ sessionId, tabId: tab.tabId }).catch(() => undefined)
          }}
        >
          <ExternalLink className="size-3.5" />
        </IconButton>
      </div>
      {/* The agent's hold, named above the page rather than over it. A native guest paints above
          this document, so a wall drawn in the hole would only exist by hiding the guest — and a
          parked page is the one state the agent's own captures have to move it out of. The band
          sits outside the hole, so the page stays visible, live and reachable by the agent, and the
          hole resizes on its own (the loop re-measures it). */}
      {agentDriving ? (
        <div
          role="status"
          aria-live="polite"
          className="flex h-7 shrink-0 items-center gap-2 border-border border-b bg-muted/40 px-2.5 text-xs"
        >
          <Loader variant="spinner" size={12} className="shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium text-foreground">{copy.agentTitle}</span>
          <span
            className="min-w-0 truncate text-muted-foreground"
            title={agentIntent ?? copy.agentBody}
          >
            {agentIntent ?? copy.agentBody}
          </span>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <div ref={holeRef} className="absolute inset-0" aria-hidden />
        {!started || phase === 'loading' || phase === 'failed' || phase === 'stopped' ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
            {phase === 'loading' ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : (
              <Globe className="size-5 text-muted-foreground" />
            )}
            <p className="font-medium text-sm text-foreground">{title}</p>
            <p className="max-w-60 text-xs text-muted-foreground">{body}</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

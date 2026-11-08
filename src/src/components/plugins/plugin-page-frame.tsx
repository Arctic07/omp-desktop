import { AlertTriangle, RotateCw } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/motion/button'
import { useLanguage, useCopy, type Localized } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { activeRecord, sessionStore } from '@/state/session-store'
import type { PluginPageRef } from '@/state/plugin-pages'
import { useStoreSelector } from '@/state/store'
import { pluginsResource } from '@/state/plugins-store'
import { useResourceState } from '@/state/resource'
import { activatePluginView } from '@/state/plugin-process'
import { pluginViewActivatable } from '@/settings/sections/plugins/process-rows'
import { workspaceStore, type WorkspaceState } from '@/state/workspace-store'

/** One frame copy per language; the failure's retry is the only control this surface owns. */
interface FrameCopy {
  failedTitle: string
  failedBody: string
  retry: string
}

const COPY: Localized<FrameCopy> = {
  en: {
    failedTitle: 'This plugin page could not be shown',
    failedBody:
      'The page left its own address or failed to load. The plugin itself is still installed; its settings page can disable it.',
    retry: 'Try again',
  },
  zh: {
    failedTitle: '无法显示这个插件页面',
    failedBody:
      '页面离开了它自己的地址，或者加载失败。插件本身仍然安装着；可以在它的设置页停用它。',
    retry: '重试',
  },
}

/**
 * The origin a plugin page's messages must be addressed to.
 *
 * `new URL(url).origin` is the string `"null"` for this application's custom protocol, and posting
 * to it reaches nobody (spec §14.4-22): the serialized `协议//主机` is what both platform spellings
 * of the page agree on, so it is built from the URL's parts rather than from `origin`.
 */
function targetOriginOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return url
  }
}

/**
 * One plugin page, loaded in a sandboxed iframe and wired to the shell's own facts.
 *
 * The page is its own origin and reaches this application only through its bridge endpoint (spec
 * §7.2): no Tauri IPC, no host DOM, no popups, no top-level navigation. What travels the other way
 * is one `postMessage` channel — facts only, never requests — so a page can react to the appearance,
 * the workspace and the conversation without being able to ask for anything it was not granted:
 *
 * | event                 | payload                                     |
 * | --------------------- | ------------------------------------------- |
 * | `appearance:changed`  | `{ base, locale }`                          |
 * | `workspace:changed`   | `{ id, rootPath }` (`id` null when none)    |
 * | `session:activated`   | `{ sessionId }` (`null` when none)          |
 * | `session:turnEnded`   | `{ sessionId, turnId, outcome, at }`        |
 *
 * **A broken page is one broken page.** A document that fails to load, or one that navigated itself
 * into this application's own origin (the one escape an iframe's sandbox does not stop being a
 * document), is removed and stated here with a retry. The conversation, the rail and every other
 * plugin tab are unaffected.
 */
export function PluginPageFrame({
  page,
  active,
  className,
}: {
  page: PluginPageRef
  /** Whether this page is the one on screen; a hidden frame stays mounted and is not activated. */
  active: boolean
  className?: string
}) {
  const copy = useCopy(COPY)
  const { language } = useLanguage()
  const { resolvedTheme } = useTheme()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [failed, setFailed] = useState(false)
  /** Bumped by a retry: a new document is the only way back from a load that never finished. */
  const [attempt, setAttempt] = useState(0)
  /** Bumped after a load, so the first push happens again on the new document. */
  const [loaded, setLoaded] = useState(0)
  const targetOrigin = useMemo(() => targetOriginOf(page.url), [page.url])

  const post = useCallback(
    (type: string, payload: unknown) => {
      const frame = frameRef.current?.contentWindow
      if (!frame) return
      frame.postMessage({ from: 'omp-desktop', type, payload }, targetOrigin)
    },
    [targetOrigin],
  )

  // The page's first push and every later one: sending on load is what makes a reloaded document
  // see the current appearance instead of opening on the defaults it was built with.
  useEffect(() => {
    post('appearance:changed', {
      base: resolvedTheme === 'light' ? 'light' : 'dark',
      locale: language,
    })
  }, [language, loaded, post, resolvedTheme])

  // The workspace the shell is showing, which is the root a page's file reads resolve against first
  // (`engine_plugin_workspace_set` is what tells the desktop; this tells the page).
  const workspaceId = useStoreSelector(workspaceStore, activeWorkspaceId)

  const plugins = useResourceState(pluginsResource)
  useEffect(() => {
    if (!active) return
    const row = plugins.value?.plugins.find(
      (candidate) => candidate.id === page.pluginId && candidate.scope === page.scope,
    )
    if (row !== undefined && pluginViewActivatable(row, page.pageId)) {
      activatePluginView(workspaceId, page.pluginId, page.scope, page.pageId)
    }
  }, [active, page.pageId, page.pluginId, page.scope, plugins.value, workspaceId])
  useEffect(() => {
    const workspace = workspaceStore.get().items.find((item) => item.id === workspaceId)
    post('workspace:changed', {
      id: workspaceId,
      rootPath: workspace?.rootPath ?? null,
    })
  }, [loaded, post, workspaceId])

  // The conversation on screen, and its endings. One subscription, because both are the same store
  // and the ending is compared against what this document was last told.
  useEffect(() => {
    let told: string | null = null
    const push = (): void => {
      const state = sessionStore.get()
      const sessionId = state.activeId
      const ending = activeRecord(state)?.lastTurn ?? null
      post('session:activated', { sessionId })
      if (ending === null) return
      const key = `${sessionId ?? ''}\u0000${ending.turnId}\u0000${ending.at}`
      if (key === told) return
      told = key
      post('session:turnEnded', {
        sessionId,
        turnId: ending.turnId,
        outcome: ending.outcome,
        at: ending.at,
      })
    }
    push()
    return sessionStore.subscribe(push)
  }, [loaded, post])

  const onLoad = (): void => {
    // Reading the frame's location throws while the document is its own origin. A value means the
    // document is now this application's, which it has no business being: remove it and say so.
    try {
      const href = frameRef.current?.contentWindow?.location.href
      if (href !== undefined) {
        setFailed(true)
        return
      }
    } catch {
      // Expected for a cross-origin page: it is the proof the document is not this application.
    }
    setFailed(false)
    setLoaded((count) => count + 1)
  }

  if (failed) {
    return (
      <div className={cn('flex h-full flex-col items-center justify-center gap-3 px-8 text-center', className)}>
        <AlertTriangle aria-hidden="true" className="size-5 text-destructive" />
        <p className="text-[13px] leading-5 font-medium text-foreground">{copy.failedTitle}</p>
        <p className="max-w-sm text-xs leading-[18px] text-muted-foreground">{copy.failedBody}</p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            setFailed(false)
            setLoaded(0)
            setAttempt((count) => count + 1)
          }}
          className="rounded-lg font-normal"
        >
          <RotateCw aria-hidden="true" className="size-3.5" />
          {copy.retry}
        </Button>
      </div>
    )
  }

  return (
    <iframe
      key={attempt}
      ref={frameRef}
      src={page.url}
      title={page.title}
      sandbox="allow-scripts allow-forms allow-same-origin"
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      onError={() => setFailed(true)}
      className={cn('h-full w-full border-0 bg-transparent', className)}
    />
  )
}

/** The active workspace's id, as the one field this component reads from its store. */
const activeWorkspaceId = (state: WorkspaceState): number | null => state.activeId

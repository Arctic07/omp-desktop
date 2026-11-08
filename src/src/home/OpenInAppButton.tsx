/**
 * The frame's "open this project in…" control: a split button, and the beUI popover behind its
 * chevron.
 *
 * The left half opens the active workspace in the remembered application (the first installed entry
 * the first time); the chevron lists every application the desktop resolved on this machine, then a
 * `copy path` row. Icons are the installed application's own, extracted by the desktop
 * (`open_in_app_icon`) and warmed at idle (`state/open-in-app-store.ts`), so a menu that opens late
 * still opens onto artwork; a row the desktop serves no artwork for draws the same generic window
 * glyph every such row draws, so the menu reads as one set instead of a mix of brands and shapes.
 *
 * The menu is drawn with BeUI's own pieces: `MorphPopover` for the panel, `Button` for both halves
 * and every row, `Tooltip` for what the icon-only half does, and `Alert` for a launch or copy that
 * the machine refused. Rows do not grow under the pointer: a scaled row is a scrollable overflow of the
 * menu, which is what put a horizontal scrollbar under it.
 */

import { AppWindow, Check, ChevronDown, Copy } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { openInAppLaunch } from '@/api/open-in-app'
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from '@/components/motion/popover-morph'
import { Alert, AlertClose, AlertContent, AlertDescription, AlertIcon } from '@/components/motion/alert'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import {
  OPEN_IN_APP_COPY,
  defaultOpenInAppFor,
  orderedOpenInApps,
} from '@/home/open-in-app-copy'
import { copyText } from '@/lib/clipboard'
import { NO_HOVER_GROWTH } from '@/lib/hover-motion'
import { useCopy } from '@/lib/i18n'
import {
  ensureOpenInAppIcon,
  loadOpenInApps,
  openInAppStore,
  rememberOpenInApp,
} from '@/state/open-in-app-store'
import { useStoreSelector } from '@/state/store'
import { workspaceStore, type WorkspaceState } from '@/state/workspace-store'

/** The split button's own icon, beside a 24px control. */
const MAIN_ICON_SIZE = 15

/** A menu row's icon: the size the Vue build drew, in an 8px-padding row. */
const ROW_ICON_SIZE = 18

/** The active workspace's root, or null while none is open. A string, so the selector is stable. */
function selectActiveRoot(state: WorkspaceState): string | null {
  const workspace = state.items.find((item) => item.id === state.activeId && !item.missing)
  return workspace?.rootPath ?? null
}

export function OpenInAppButton() {
  const copy = useCopy(OPEN_IN_APP_COPY)
  const root = useStoreSelector(workspaceStore, selectActiveRoot)
  const status = useStoreSelector(openInAppStore, (state) => state.status)
  const apps = useStoreSelector(openInAppStore, (state) => state.apps)
  const rememberedId = useStoreSelector(openInAppStore, (state) => state.rememberedId)
  const icons = useStoreSelector(openInAppStore, (state) => state.icons)
  const [menuOpen, setMenuOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)

  useEffect(() => {
    void loadOpenInApps()
  }, [])

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  useEffect(() => {
    if (failure === null) return
    const timer = window.setTimeout(() => setFailure(null), 4000)
    return () => window.clearTimeout(timer)
  }, [failure])

  const ordered = useMemo(() => orderedOpenInApps(apps), [apps])
  const defaultId = useMemo(
    () => defaultOpenInAppFor(apps, rememberedId),
    [apps, rememberedId],
  )

  // The warm-up in the store covers every installed id, so this only answers for a menu opened
  // before that run reached the row: the ask joins the run already going and costs nothing.
  const wanted = useMemo(
    () => (menuOpen ? ordered : defaultId === null ? [] : [defaultId]),
    [menuOpen, ordered, defaultId],
  )
  useEffect(() => {
    for (const id of wanted) void ensureOpenInAppIcon(id)
  }, [wanted])

  const launch = useCallback(
    async (id: string) => {
      if (root === null) return
      setMenuOpen(false)
      rememberOpenInApp(id)
      try {
        await openInAppLaunch(id, root)
      } catch {
        setFailure(copy.launchFailed)
      }
    },
    [root, copy],
  )

  const copyPath = useCallback(async () => {
    if (root === null) return
    if (!(await copyText(root))) {
      setFailure(copy.copyFailed)
      return
    }
    setCopied(true)
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => {
      copyTimer.current = null
      setCopied(false)
    }, 1600)
  }, [root, copy])

  if (root === null || status !== 'ready' || defaultId === null) {
    return null
  }
  const defaultName = copy.names[defaultId] ?? defaultId

  return (
    <MorphPopover open={menuOpen} onOpenChange={setMenuOpen}>
      <div className="flex h-7 items-center rounded-md border border-border/70 bg-card/40">
        <Tooltip content={copy.openIn(defaultName)}>
          <Button
            {...NO_HOVER_GROWTH}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={copy.openIn(defaultName)}
            onClick={() => void launch(defaultId)}
            className="h-6 w-7 shrink-0 rounded-l-md rounded-r-none text-muted-foreground hover:text-foreground"
          >
            <AppIcon dataUrl={icons[defaultId]} size={MAIN_ICON_SIZE} />
          </Button>
        </Tooltip>
        <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-border/70" />
        <MorphPopoverTrigger>
          <Button
            {...NO_HOVER_GROWTH}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={copy.choose}
            className="h-6 w-6 shrink-0 rounded-l-none rounded-r-md text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className="size-3" />
          </Button>
        </MorphPopoverTrigger>
      </div>
      <MorphPopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        radius={12}
        className="w-60 p-1"
      >
        <div className="flex max-h-[min(60vh,22rem)] flex-col overflow-x-hidden overflow-y-auto overscroll-contain">
          {ordered.map((id) => {
            const name = copy.names[id] ?? id
            return (
              <Button
                {...NO_HOVER_GROWTH}
                key={id}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void launch(id)}
                className="h-8 w-full justify-start gap-2 rounded-lg px-2 text-xs"
              >
                <AppIcon dataUrl={icons[id]} size={ROW_ICON_SIZE} />
                <span className="min-w-0 flex-1 truncate text-left">{name}</span>
                {id === defaultId ? (
                  <Check aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                ) : null}
              </Button>
            )
          })}
          <div className="my-1 h-px shrink-0 bg-border" />
          <Button
            {...NO_HOVER_GROWTH}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void copyPath()}
            className="h-8 w-full justify-start gap-2 rounded-lg px-2 text-xs"
          >
            <Copy aria-hidden="true" size={ROW_ICON_SIZE} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">
              {copied ? copy.copied : copy.copyPath}
            </span>
          </Button>
        </div>
      </MorphPopoverContent>
      <Alert
        variant="destructive"
        open={failure !== null}
        onOpenChange={(open) => {
          if (!open) setFailure(null)
        }}
        className="absolute top-full right-0 z-[60] mt-2 w-64 py-2 pr-2 pl-3 text-xs"
      >
        <AlertIcon />
        <AlertContent>
          <AlertDescription className="text-xs">{failure}</AlertDescription>
        </AlertContent>
        <AlertClose />
      </Alert>
    </MorphPopover>
  )
}

/**
 * One row's icon: the application's own artwork when the desktop served it, the generic window
 * glyph otherwise. The fallback is the Vue build's and is the same for every application on
 * purpose - per-kind shapes (a folder for the file manager, `>_` for terminals) mixed a coloured
 * brand mark with line art in one list.
 */
function AppIcon({ dataUrl, size }: { dataUrl: string | undefined; size: number }) {
  if (dataUrl !== undefined && dataUrl !== '') {
    return (
      <img
        src={dataUrl}
        alt=""
        width={size}
        height={size}
        className="shrink-0 object-contain"
        draggable={false}
      />
    )
  }
  return <AppWindow aria-hidden="true" size={size} className="shrink-0 text-muted-foreground" />
}

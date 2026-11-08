import { useCallback, useEffect, useState } from 'react'

import {
  DESKTOP_COMMAND_EVENT,
  TERMINAL_EVENT,
  type DesktopCommand,
  type TerminalUiEvent,
} from '@/api/types'
import { subscribe } from '@/api/client'
import { terminalListLive } from '@/api/terminal'
import {
  exitTerminalTab,
  openAttachedTerminalTab,
  recoverLiveTerminals,
} from '@/state/terminal-tabs'
import { activeRecord, sessionStore, setConversationCovered, startNewSession } from '@/state/session-store'
import { pickAndAddWorkspace, workspaceStore } from '@/state/workspace-store'

import { ChatAppHome } from '@/home/ChatAppHome'
import { AttachmentViewer } from '@/home/AttachmentViewer'
import { COPY } from '@/home/homeCopy'
import { OmpImportDialog } from '@/home/OmpImportDialog'
import { PluginNoticeStack } from '@/home/PluginNoticeStack'
import { PluginPromptCard } from '@/home/PluginPromptCard'
import { TitleBar } from '@/home/TitleBar'
import { SettingsPage, type SettingsSectionId } from '@/settings/SettingsPage'
import { useBlockingOverlayWhile } from '@/state/overlay-depth'
import { useBrowserEvents } from '@/state/browser-events'
import { useDocumentFileLinks } from '@/lib/file-links'
import { useDocumentLinks } from '@/lib/links'
import { useLanguage } from '@/lib/i18n'
import { ErrorBoundary } from '@/lib/error-boundary'
import { sameFilePath } from '@/lib/file-path'
import { pushTrayLanguage } from '@/state/app-settings'
import { checkFirstRunImport } from '@/state/omp-import-store'
import { startDesktopDrop, stopDesktopDrop } from '@/state/desktop-drop'
import { pluginsResource, readPlugins, startPluginWiring } from '@/state/plugins-store'
import { setPluginWorkspace } from '@/api/plugins'
import { startSessionWiring } from '@/state/session-store'
import { startStallWatch, stopStallWatch } from '@/state/session-stall'

type View = 'chat' | 'settings'

/**
 * Ask the desktop what the active conversation already has running, and show it.
 *
 * This is the path that recovers a shell the page did not create — one the agent started through
 * `workspace_terminal`, or one that outlived a page reload. It is deliberately not a polling loop:
 * the live `omp:terminal` event is the fast path, and this runs when the conversation or its
 * workspace changes, which is exactly when the page may have missed an event.
 *
 * The comparison is by canonical path, case-insensitively: the desktop answers with the plain
 * canonical session file and workspace root it validated, while the record carries whatever the
 * engine reported.
 */
async function reconcileCurrentSession(): Promise<void> {
  const session = activeRecord(sessionStore.get())
  if (!session?.filePath) return
  const filePath = session.filePath
  const workspace = workspaceStore.get().items.find((item) => item.id === session.workspaceId)
  if (!workspace) return
  const rootPath = workspace.rootPath
  try {
    const terminals = await terminalListLive(filePath, rootPath)
    const current = activeRecord(sessionStore.get())
    if (!current || current.id !== session.id || current.filePath !== filePath) return
    // A shell this page already has a tab for is exactly where the reader left it: this pass runs
    // on every switch of conversation, so recovery must only add the shells that have no tab
    // (`recoverLiveTerminals`) — re-attaching them every switch pulled the reader off the tab they
    // were on and onto the first terminal (2026-10-21, user report).
    recoverLiveTerminals(
      session.id,
      terminals.filter(
        (terminal) =>
          sameFilePath(terminal.ownerSessionFile, filePath) &&
          sameFilePath(terminal.workspaceKey, rootPath),
      ),
    )
  } catch {
    // Reconciliation is best effort; the live event remains the primary fast path.
  }
}

function App() {
  const [view, setView] = useState<View>('chat')
  /**
   * Which section the settings page opens on.
   *
   * 帮助 → 关于 asks for `about`; the rail's own Settings entry asks for nothing, and the page then
   * starts at its first section. Kept beside the view rather than inside the page because the page
   * unmounts when it is closed, and a remount always starts from this answer.
   */
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | undefined>(undefined)
  // The settings page is a full-window blocking surface: the native browser guest must go away
  // while it is up, exactly as it does under a dialog.
  useBlockingOverlayWhile(view === 'settings')
  // It covers the conversation as well, and the conversation stays mounted under it. Nothing of it
  // is on screen, so it must not be rebuilt on the display clock: an answer still streaming is
  // folded four times a second and its reveal snapped, which is what keeps the page the reader is
  // actually scrolling at the frame rate the display can give it.
  useEffect(() => {
    setConversationCovered(view === 'settings')
  }, [view])
  const openSettings = useCallback((section?: SettingsSectionId) => {
    setSettingsSection(section)
    setView('settings')
  }, [])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const { language } = useLanguage()

  // Registered once for the process: the conversation follows the active workspace and the runtime
  // channel, neither of which belongs to whichever screen happens to be mounted. The plugin channels
  // are the same kind of thing — a long install keeps reporting after the page that started it is
  // gone — so they are wired here too rather than by the plugins section. The window's own file drop
  // is the same shape again: the OS reports a drag to the window, and the surface that accepts one is
  // the composer, which mounts and unmounts as the reader moves between conversations.
  useEffect(() => {
    startSessionWiring()
    startStallWatch()
    startPluginWiring()
    let unlisten: (() => void) | undefined
    let reconcileInFlight = false
    let reconcileQueued = false
    /** What the last reconcile was for. Only a change of identity is worth asking about again. */
    let lastKey = ''
    const currentKey = (): string => {
      const session = activeRecord(sessionStore.get())
      if (!session?.filePath) return ''
      const workspace = workspaceStore.get().items.find((item) => item.id === session.workspaceId)
      return workspace === undefined ? '' : `${session.id}\u0000${session.filePath}\u0000${workspace.rootPath}`
    }
    const scheduleReconcile = (): void => {
      // A conversation streams hundreds of frames per turn, and every one of them replaces the
      // session state. Asking the desktop what is running on each of them is a round trip per token
      // for an answer that can only change when the conversation or its workspace does.
      const key = currentKey()
      if (key === '' || key === lastKey) return
      lastKey = key
      run()
    }
    const run = (): void => {
      if (reconcileInFlight) {
        reconcileQueued = true
        return
      }
      reconcileInFlight = true
      void reconcileCurrentSession().finally(() => {
        reconcileInFlight = false
        if (reconcileQueued) {
          reconcileQueued = false
          run()
        }
      })
    }
    const stopSessionWatch = sessionStore.subscribe(() => {
      scheduleReconcile()
    })
    /**
     * Reads the plugin list for one workspace, and reads it again when the first answer cannot be
     * the final one.
     *
     * The host boots asynchronously and the bundled plugins are installed *by this read* the first
     * time it runs (`services::plugins::builtin`), so a read that lands while the host is still
     * starting fails, and a read that lands mid-install can answer before the rows exist. Either
     * way the empty answer used to be cached for the rest of the process, which left every
     * plugin-contributed surface (the terminal's tab, the rail's entries)
     * missing until Settings → Plugins was opened by hand. So: retry while the read fails, and give
     * an empty answer one more chance after the installs have had time to finish.
     */
    let pluginRetry: ReturnType<typeof setTimeout> | undefined
    const readPluginsUntilSettled = (workspaceId: number | null, attempt: number): void => {
      void readPlugins(workspaceId, attempt > 0).then(() => {
        if (pluginRetry !== undefined) clearTimeout(pluginRetry)
        pluginRetry = undefined
        if (workspaceStore.get().activeId !== workspaceId) return
        const state = pluginsResource.store.get()
        const empty = state.status === 'ready' && (state.value?.plugins.length ?? 0) === 0
        if (attempt >= 6 || (state.status === 'ready' && !empty)) return
        pluginRetry = setTimeout(() => readPluginsUntilSettled(workspaceId, attempt + 1), attempt === 0 ? 2000 : 1500)
      })
    }
    const syncPluginWorkspace = (): void => {
      const workspaceId = workspaceStore.get().activeId
      void setPluginWorkspace(workspaceId).catch(() => undefined)
      readPluginsUntilSettled(workspaceId, 0)
    }
    const stopWorkspaceWatch = workspaceStore.subscribe(() => {
      syncPluginWorkspace()
      scheduleReconcile()
    })
    syncPluginWorkspace()
    void subscribe<TerminalUiEvent>(TERMINAL_EVENT, (event) => {
      const current = sessionStore.get()
      const workspaces = workspaceStore.get()
      const exact = Object.values(current.records).find((record) => {
        const workspace = workspaces.items.find((item) => item.id === record.workspaceId)
        return (
          record.filePath !== null &&
          sameFilePath(record.filePath, event.terminal.ownerSessionFile) &&
          workspace !== undefined &&
          sameFilePath(workspace.rootPath, event.terminal.workspaceKey)
        )
      })
      if (event.terminal.ownerSessionFile.length === 0 || exact === undefined) {
        // The event names a conversation this page is not holding (not opened yet, or already
        // evicted). Asking the desktop again is the recovery: the conversation that owns it may
        // have just become the active one.
        lastKey = ''
        scheduleReconcile()
        return
      }
      const mapped = exact
      if (event.kind === 'exit') {
        exitTerminalTab(mapped.id, event.terminal.id)
        return
      }
      // A shell belongs to the conversation that started it. The reader sees the column come up only
      // when that conversation is the one on screen; a shell in another conversation gets its tab
      // there and waits (2026-10-24: a background shell used to open the panel over whatever the
      // reader was looking at).
      openAttachedTerminalTab(
        mapped.id,
        event.terminal.id,
        event.terminal.shell,
        mapped.id === current.activeId,
      )
    }).then((stop) => {
      unlisten = stop
      // The listener registered after the first pass started: anything published in between was
      // missed, so the pass runs once more now that the channel is live.
      lastKey = ''
      scheduleReconcile()
    })
    startDesktopDrop()
    return () => {
      stopSessionWatch()
      stopStallWatch()
      stopWorkspaceWatch()
      unlisten?.()
      stopDesktopDrop()
    }
  }, [])

  // The tray's menu is drawn by the shell, so its language is told to the shell once per change.
  // The theme used to be pushed from here as well, on mount and on every change; it is not, because
  // a mount is not a choice: `src/main.tsx` adopts the shell's record at start-up and the settings
  // page records a new choice before applying it, so a push from here could only repeat or overwrite
  // one of those (`state/startup-theme`).
  useEffect(() => {
    pushTrayLanguage(language)
  }, [language])

  // The one first-run question this application asks: a terminal omp beside it means a
  // configuration that can be copied over, and the desktop answers whether there is one and whether
  // the question was already answered. It is asked once per installation (`omp_import_prompted`),
  // never again, and a machine with no such directory sees nothing.
  useEffect(() => {
    void checkFirstRunImport()
  }, [])

  // The tray's forwarding entries hand their action to this document (`services::presence`). They
  // are the same actions the window's own buttons run, so nothing is reimplemented here: the tray
  // only names one. Re-subscribed on a language switch because the folder picker's title is copy.
  useEffect(() => {
    const copy = COPY[language]
    let stop: (() => void) | undefined
    let cancelled = false
    void subscribe<DesktopCommand>(DESKTOP_COMMAND_EVENT, (command) => {
      if (command === 'new-session') {
        void startNewSession()
        return
      }
      if (command === 'open-workspace') {
        // A picker the desktop refuses, or a folder it will not take, leaves the rail as it was.
        void pickAndAddWorkspace(copy.chooseWorkspace).catch(() => undefined)
      }
    }).then((unlisten) => {
      if (cancelled) unlisten()
      else stop = unlisten
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [language])

  // Every link in the document, wherever it came from: the conversation's Markdown, a settings row,
  // anything a plugin page adds later. A file path in an answer is not an address, so it has its
  // own listener — one that opens the file in the work panel instead of the system browser.
  useDocumentLinks()
  useDocumentFileLinks()
  useBrowserEvents()

  /**
   * The window's own frame, drawn once for whichever screen is under it.
   *
   * The window has no decorations (`src-tauri/tauri.conf.json`), so this is the drag region,
   * the menu bar and the three window controls — and it belongs to the shell rather than to a screen,
   * because the settings page is opened *over* the conversation rather than instead of it. Replacing
   * the whole view used to take the frame down with it, which left a window that could not be dragged,
   * moved or closed while settings was open. The conversation stays mounted underneath for the same
   * reason it does in the desktop app: a turn streaming into it is not interrupted by reading a
   * setting, and its own scroll position and half-typed prompt are still there on the way back.
   */
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-window-frame">
      <TitleBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((current) => !current)}
        onOpenAbout={() => openSettings('about')}
        onLeaveSettings={() => setView('chat')}
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          inert={view === 'settings'}
          aria-hidden={view === 'settings' || undefined}
          className="flex min-h-0 flex-1 flex-col"
        >
          {/* The whole screen is behind a boundary as well as its transcript: a failure anywhere in
              the shell — the rail, a dialog, a settings page — must leave a window that still has a
              title bar and a way to draw itself again, not an empty one. */}
          <ErrorBoundary>
            <ChatAppHome
              className="flex-1"
              sidebarOpen={sidebarOpen}
              onSidebarOpenChange={setSidebarOpen}
              onOpenSettings={() => openSettings()}
            />
          </ErrorBoundary>
        </div>
        {view === 'settings' ? (
          <ErrorBoundary className="absolute inset-0 z-30 bg-background">
            <SettingsPage
              onClose={() => setView('chat')}
              onOpenWorkspace={() => setView('chat')}
              initialSection={settingsSection}
            />
          </ErrorBoundary>
        ) : null}
      </div>
      <PluginNoticeStack />
      <PluginPromptCard />
      {/* The import card, mounted by the shell because either surface raises it: the first-run
          check above, and the models page's button inside the settings overlay. */}
      <OmpImportDialog />
      {/* The picture a chip opens: mounted by the shell because either surface can raise it — the
          composer's field and a sent message's bubble — and because it covers the whole window,
          settings page included. */}
      <AttachmentViewer />
    </div>
  )
}

export default App

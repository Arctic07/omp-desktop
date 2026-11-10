import {
  Bot,
  Compass,
  File,
  GitBranch,
  Maximize2,
  Minimize2,
  PanelRightClose,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ActionSwapIcon } from "@/components/motion/action-swap";
import { useSidebarWidth } from "@/components/workspace/use-sidebar-width";
import { FileDragGhost } from "@/components/workspace/file-drag-ghost";
import { FilePanel } from "@/components/workspace/file-panel";
import { FileSourcePanel } from "@/components/workspace/file-source-panel";
import { BrowserPanel } from "@/components/workspace/BrowserPanel";
import { GitReviewPanel } from "@/components/workspace/git-review";
import {
  AnimatedSidebar,
  AnimatedSidebarProvider,
  AnimatedSidebarTrigger,
} from "@/components/motion/animated-sidebar";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { AllTerminalPanels } from "@/components/workspace/AllTerminalPanels";
import { SubagentPanel } from "@/components/workspace/subagent-panel";
import { ToolMenuList } from "@/components/workspace/tool-menu";
import {
  servedToolEntries,
  toolEntryLocked,
  type ToolMenuEntry,
} from "@/components/workspace/tool-menu-entries";
import { usePanelShortcuts } from "@/components/workspace/use-panel-shortcuts";
import { openToolTab } from "@/state/panel-tools";
import type { PanelTabRef, SourceFileTabRef } from "@/state/panel-tabs";
import {
  browserTabIdOf,
  isSourceFileRef,
  pluginPageKeyOf,
  pluginTabRefOf,
  sourceFilePathOf,
  subagentChildIdOf,
} from "@/state/panel-tabs";
import { pluginOpenOf, subagentOpenOf, usePanelState } from "@/state/panel-state";
import { PluginPageFrame } from "@/components/plugins/plugin-page-frame";
import { PluginPageIcon } from "@/components/plugins/plugin-page-icon";
import { pageForKey, toolAvailability, usePluginPages } from "@/state/plugin-pages";
import { setWorkspaceWatch, subscribeWorkspaceChanged } from "@/api/git";
import { fileLeafName } from "@/lib/file-path";
import { useHorizontalWheel } from "@/lib/hooks/use-horizontal-wheel";
import { useCopy } from "@/lib/i18n";
import { COPY } from "@/home/homeCopy";
import { TERMINAL_COPY } from "@/home/terminal-copy";
import {
  browserTabsOf,
  closeBrowserTab,
  closeFileTab,
  closeGitTab,
  closeSubagentTab,
  closePluginTab,
  neighbouringTabOf,
  prunePluginTabs,
  selectBrowserTab,
  selectFileTab,
  selectGitTab,
  selectPluginTab,
  closeSourceFileTab,
  openPluginTab,
  selectSourceFileTab,
  selectSubagentTab,
} from "@/state/panel-store";
import {
  closeTerminalTab,
  renameTerminalTab,
  selectTerminalTab,
} from "@/state/terminal-tabs";
import { bumpWorkspaceChange, reportTouchesRefs } from "@/state/workspace-watch-store";
import {
  activeRecord,
  sessionStore,
  type SessionStoreState,
} from "@/state/session-store";
import { useStoreSelector } from "@/state/store";
import { restoreBrowserTabsForSession } from "@/state/browser-tabs";
import { isUnwritten } from "@/state/transcript";

/** The git tab's own label, as it reads in the strip. */
const GIT_TAB_LABEL = "改动";

/** The file tab's own label, as it reads in the strip. */
const FILE_TAB_LABEL = "文件";

/** What a subagent tab reads as when its `task` roster row carried no name of its own. */
const SUBAGENT_TAB_LABEL = "子代理";

/**
 * Whether the conversation on screen has nothing in it yet, read from the same record the composer
 * reads. A conversation that is still an empty shell has no transcript file, so the column offers
 * only the tools that work without one.
 */
function selectActiveUnwritten(state: SessionStoreState): boolean {
  const record = activeRecord(state);
  return record !== null && isUnwritten(record.engineEmpty, record.messages);
}

export interface RightSidebarProps {
  /** The conversation this column belongs to; null is the brief no-active-session transition. */
  sessionId: string | null;
  open: boolean;
  /** Whether the column has the whole inset to itself; the conversation column folds away then. */
  expanded: boolean;
  onToggleExpanded: () => void;
  onOpenChange: (open: boolean) => void;
  /**
   * A shortcut asked for a work-panel tab.
   *
   * The shortcuts are window-level and fire whatever surface is up; the shell uses this to leave a
   * covering page (the plugin marketplace) so the tab it just opened is the one on screen.
   */
  onOpenPanel?: () => void;
  className?: string;
}

/**
 * The right-hand tool column.
 *
 * **The terminal, the git review and the file panel are wired.** A terminal tab starts
 * a real pty in the active workspace (`components/workspace/TerminalPanel.tsx`, `api/terminal.ts`):
 * the desktop resolves the shell (PowerShell 7, then Windows PowerShell, then `cmd`), streams what
 * it prints, and takes its keystrokes. The git tab (`components/workspace/git-review.tsx`) and the
 * file tab (`components/workspace/file-panel.tsx`) are singleton strip tabs: asking for either jumps
 * to the existing tab or opens the one there is. A **subagent tab** (`components/workspace/subagent-panel.tsx`) is one `task` child's own
 * conversation, opened from its row in the roster, read from the child's transcript and drawn without
 * speakers. The column's `Ctrl B` binding is off because the rail already answers that key.
 *
 * **Whether the column is open — and expanded — is the conversation's; what it shows is too**
 * (`state/panel-store.ts`). A conversation the reader never opened it in draws none, and one they did
 * comes back as they left it: the one being left folds away while its open runs
 * (`home/ChatAppHome.tsx`). A tab that is not this conversation's is out of sight but still mounted —
 * its shell keeps running, and its git review or file tree keeps the rows, expansion and open diff
 * the reader left on it, because a tab out of sight was never closed.
 *
 * **A conversation nothing has been sent in offers only the terminal.** Its transcript does not
 * exist yet, so the git review and the file panel arrive with the first message.
 *
 * The shell's working directory follows the active workspace: a tab belongs to the folder it was
 * opened in, so a terminal opened after a workspace switch starts in that workspace's folder rather
 * than in a reused one. The git and file tabs carry that folder too, so a panel mounted for another
 * conversation reads its own tree, not the one the reader happens to be looking at.
 */
export function RightSidebar({
  sessionId,
  open,
  expanded,
  onToggleExpanded,
  onOpenChange,
  onOpenPanel,
  className,
}: RightSidebarProps) {
  const copy = useCopy(TERMINAL_COPY);
  /** The window menu's own wording: the greyed rows say why in it (`homeCopy.menuLockedHint`). */
  const menuCopy = useCopy(COPY);
  const panel = usePanelState();
  const terminalTabsRaw = sessionId === null ? [] : (panel.tabs[sessionId] ?? []);
  const browserTabs = browserTabsOf(sessionId);
  const activeTab = sessionId === null ? null : (panel.activeTab[sessionId] ?? null);
  const activeBrowserTabId = browserTabIdOf(activeTab);
  const tabOrder = sessionId === null ? [] : (panel.tabOrder[sessionId] ?? []);
  const gitTab = sessionId !== null && panel.gitOpen[sessionId] !== undefined;
  const fileTab = sessionId !== null && panel.fileOpen[sessionId] !== undefined;
  /** The outside files this conversation has open, in strip order (the ref is the whole record). */
  const sourceRefs = tabOrder.filter(isSourceFileRef);
  const subagentTabs = subagentOpenOf(sessionId);
  /** The plugin pages this build can offer, and the ones this conversation has as tabs. */
  const pluginPages = usePluginPages();
  /**
   * What the plugin chain serves right now, read from the same projection the pages are drawn
   * from: the terminal's tab exists a `workPanelTabs[]` entry names the `terminal` renderer.
   *
   * The terminal's tab is hidden rather than closed when a contribution goes away: the state that
   * owns it is per conversation (`state/panel-store.ts`), and a plugin switch is not a reason to
   * end a reader's shell. Switching the plugin back on brings the same tabs back.
   */
  const availability = useMemo(() => toolAvailability(pluginPages), [pluginPages]);
  /**
   * Whether this conversation has nothing in it yet.
   *
   * Its transcript does not exist (a new conversation creates its file with the first message), so
   * the two tools that read one are drawn greyed rather than left out: the reader unlocks them by
   * sending a message, and a row that vanished would never say so (2026-10-26, user request). The
   * terminal writes nothing into the conversation and works from the first moment.
   * Everything else about the column stays as it is, including being open at all.
   */
  const unwritten = useStoreSelector(sessionStore, selectActiveUnwritten);
  /**
   * What this column can offer right now.
   *
   * Every one of these tools needs a conversation to belong to (its tab, its shell, its tree), so a
   * column that is open during the brief no-conversation transition — a workspace switch, a
   * conversation being opened, a window with no workspace — offers nothing rather than rows that
   * return without doing anything.
   */
  const menuEntries = useMemo(
    () => (sessionId === null ? [] : servedToolEntries(availability, pluginPages)),
    [availability, pluginPages, sessionId],
  );
  const terminalTabs = availability.terminal ? terminalTabsRaw : [];
  const openPluginKeys = pluginOpenOf(sessionId);
  const servedPluginKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const page of pluginPages.sidebar) keys.add(page.key);
    for (const page of pluginPages.views) keys.add(page.key);
    return keys;
  }, [pluginPages]);
  const { asideRef, width, animating, snap, setWidth, toggle: toggleExpanded } =
    useSidebarWidth(sessionId, expanded, onToggleExpanded);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  /**
   * The strip itself scrolls sideways with a wheel: its scrollbar is hidden and the row's tabs pile
   * up past the column's width, so a mouse had no way to reach the rest of them (2026-10-26).
   */
  const tabStripRef = useRef<HTMLDivElement>(null);
  useHorizontalWheel(tabStripRef);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  /** Whether the git tab is the one on screen, which decides its reads and the watch. */
  const gitActive = gitTab && activeTab === "git";
  const fileActive = fileTab && activeTab === "file";
  /**
   * The root the tab on screen reads. It comes off the tab, which captured it when it was opened:
   * the panels stay mounted for their own conversation, so the workspace the reader happens to be
   * in elsewhere says nothing about the tree this one is looking at.
   */
  const watchRoot =
    sessionId === null
      ? null
      : (gitActive ? panel.gitOpen[sessionId] : fileActive ? panel.fileOpen[sessionId] : null) ??
        null;
  /** The child whose own conversation is the tab on screen, if one is. */
  const activeSubagentChildId = subagentChildIdOf(activeTab as PanelTabRef);
  const activeSourcePath = sourceFilePathOf(activeTab);
  /** The plugin page on screen, when the strip's active tab is one of them. */
  const activePluginPage = (() => {
    const key = pluginPageKeyOf(activeTab);
    return key === null ? null : pageForKey(pluginPages, key);
  })();
  /** Whether the tab on screen is one of the strip's non-terminal tabs, which cover the box. */
  const stripTabActive =
    gitActive ||
    fileActive ||
    activeSourcePath !== null ||
    activeSubagentChildId !== null ||
    activePluginPage !== null ||
    activeBrowserTabId !== null;

  // A list read can take a page away (the plugin was disabled, uninstalled or upgraded into a
  // package that no longer declares it). The open conversation's tab closes in the same turn,
  // rather than pointing at a frame this build cannot resolve. Only this conversation is pruned:
  // the list belongs to the active workspace, so applying it to a session in another workspace
  // would close tabs that workspace still serves. Another session is pruned when it is opened,
  // because `sessionId` is what brings its own workspace's list on screen.
  useEffect(() => {
    if (sessionId !== null) prunePluginTabs(sessionId, servedPluginKeys);
  }, [sessionId, servedPluginKeys]);

  // A renderer reload forgets the strip while the desktop keeps the guest pages. Rebuild the tabs
  // the conversation still holds, so a renderer reload does not lose them.
  useEffect(() => {
    if (sessionId !== null) void restoreBrowserTabsForSession(sessionId);
  }, [sessionId]);


  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.startX - event.clientX;
      setWidth(
        Math.min(640, Math.max(320, resizeRef.current.startWidth + delta)),
      );
    };
    const stopResize = () => {
      resizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
    };
  }, [setWidth]);

  const renameTerminal = (owner: string, tabId: number, label: string) => {
    renameTerminalTab(owner, tabId, label);
  };

  const closeTerminal = (id: number) => {
    if (sessionId !== null) closeTerminalTab(sessionId, id);
  };

  const selectEntry = useCallback(
    (entry: Pick<ToolMenuEntry, "action" | "pageKey">) => {
      const { action } = entry;
      // A plugin page: the same opener the sidebar group and the plugin's settings page use, so the
      // page never becomes two tabs (`state/panel-store.ts`).
      if (action === null) {
        if (
          entry.pageKey !== null &&
          sessionId !== null &&
          servedPluginKeys.has(entry.pageKey)
        ) {
          onOpenPanel?.();
          openPluginTab(sessionId, entry.pageKey);
        }
        return;
      }
      // A tool whose built-in plugin is not served is not offered; the strip hides the row, and
      // this is the second half of the same answer for a shortcut or a stale popup window.
      if (action === "terminal" && !availability.terminal) return;
      if (action === "browser" && !availability.browser) return;
      // A tool a conversation cannot use yet is drawn greyed; a shortcut reaches this guard the
      // same way a disabled row does, so pressing the key does nothing rather than opening a tab
      // that has no transcript to read.
      if (toolEntryLocked(action, unwritten)) return;
      if (sessionId === null) return;
      // The one opener every surface shares (`state/panel-tools.ts`): the tab, and the column up.
      onOpenPanel?.();
      openToolTab(sessionId, action, copy.title);
    },
    [
      availability.browser,
      availability.terminal,
      copy.title,
      onOpenPanel,
      servedPluginKeys,
      sessionId,
      unwritten,
    ],
  );

  // Bring one tab of the strip on screen: the same three `select…` calls the strip's own tab buttons
  // make, so a keyboard walk and a click land in exactly the same place.
  const showTab = useCallback(
    (ref: PanelTabRef) => {
      if (sessionId === null) return;
      if (ref === "git") selectGitTab(sessionId);
      else if (ref === "file") selectFileTab(sessionId);
      else if (typeof ref === "number") selectTerminalTab(sessionId, ref);
      else {
        // The string kinds left are told apart by the same test the strip's own branch uses;
        // the cast is what the union needs, not what the ref is.
        const childId = subagentChildIdOf(ref);
        const pageKey = pluginPageKeyOf(ref);
        const sourcePath = sourceFilePathOf(ref);
        const browserTabId = browserTabIdOf(ref);
        if (childId !== null) selectSubagentTab(sessionId, childId);
        else if (pageKey !== null) selectPluginTab(sessionId, pageKey);
        else if (browserTabId !== null) selectBrowserTab(sessionId, browserTabId);
        else if (sourcePath !== null) selectSourceFileTab(sessionId, ref as SourceFileTabRef);
      }
    },
    [sessionId],
  );

  const leaveCoveringPage = useRef(onOpenPanel);
  useEffect(() => {
    leaveCoveringPage.current = onOpenPanel;
  }, [onOpenPanel]);

  const cycleTab = useCallback(
    (step: number) => {
      const next = neighbouringTabOf(sessionId, step);
      if (next === null) return;
      leaveCoveringPage.current?.();
      showTab(next);
    },
    [sessionId, showTab],
  );

  usePanelShortcuts({ cycleTab, selectEntry });

  return (
    <AnimatedSidebarProvider
      open={open}
      onOpenChange={onOpenChange}
      keyboardShortcut={false}
      className={cn("contents", animating && "omp-sidebar-width-animated")}
      style={{ "--sidebar-width": `${width}px` }}
    >
      <AnimatedSidebar
        ref={asideRef}
        side="right"
        collapsible="offcanvas"
        widthTransition={snap ? { duration: 0 } : undefined}
        ariaLabel={copy.title}
        className={className}
        panelClassName="border-border border-l bg-pane"
      >
        <WorkspaceWatch root={watchRoot} />
        {/* The drag ghost is a portal to `document.body`, so where it sits in this tree does not
            decide where it is painted — but it does have to be mounted for as long as a drag is
            possible. It used to live inside the file panel, which left a drag started in the git
            review with nothing to draw. */}
        <FileDragGhost />
        {/* While the column has the whole inset there is no boundary to drag: its left edge is the
            rail's, which is not this column's to move. Collapsing first puts the handle back. */}
        {expanded ? null : (
          <div
            role="separator"
            aria-label="调整右侧边栏宽度"
            aria-orientation="vertical"
            onPointerDown={(event) => {
              resizeRef.current = { startX: event.clientX, startWidth: width };
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
            }}
            className="absolute inset-y-0 left-0 z-30 hidden w-1 cursor-col-resize transition-colors hover:bg-border lg:block"
          />
        )}
        <div className="flex h-11 shrink-0 items-center border-border border-b px-3">
          {/* One strip for every tab the conversation has: the git review and the file panel sit
              beside the terminal tabs exactly as one of them, closed by their ✕ like any other. */}
          <div
            ref={tabStripRef}
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {tabOrder.map((tabRef) => {
              if (tabRef === "git") {
                if (!gitTab) return null;
                return (
                  <div
                    key="git"
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-sm",
                      activeTab === "git"
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/60",
                    )}
                  >
                    <button
                      type="button"
                      aria-label="切换到改动标签页"
                      onClick={() => {
                        if (sessionId !== null) selectGitTab(sessionId);
                      }}
                      className="flex items-center gap-2 outline-none"
                    >
                      <GitBranch className="size-3.5 shrink-0" />
                      <span className="max-w-40 truncate">{GIT_TAB_LABEL}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`关闭 ${GIT_TAB_LABEL} 标签页`}
                      onClick={() => {
                        if (sessionId !== null) closeGitTab(sessionId);
                      }}
                      className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                );
              }
              if (tabRef === "file") {
                if (!fileTab) return null;
                return (
                  <div
                    key="file"
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-sm",
                      fileActive
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/60",
                    )}
                  >
                    <button
                      type="button"
                      aria-label="切换到文件标签页"
                      onClick={() => {
                        if (sessionId !== null) selectFileTab(sessionId);
                      }}
                      className="flex items-center gap-2 outline-none"
                    >
                      <File className="size-3.5 shrink-0" />
                      <span className="max-w-40 truncate">{FILE_TAB_LABEL}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`关闭 ${FILE_TAB_LABEL} 标签页`}
                      onClick={() => {
                        if (sessionId !== null) closeFileTab(sessionId);
                      }}
                      className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                );
              }
              const browserTabId = browserTabIdOf(tabRef);
              if (browserTabId !== null) {
                const browserTab = browserTabs.find((entry) => entry.tabId === browserTabId);
                if (browserTab === undefined) return null;
                return (
                  <div
                    key={tabRef}
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-sm",
                      activeBrowserTabId === browserTabId
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/60",
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`切换到 ${browserTab.label} 标签页`}
                      title={browserTab.location}
                      onClick={() => {
                        if (sessionId !== null) selectBrowserTab(sessionId, browserTabId);
                      }}
                      className="flex items-center gap-2 outline-none"
                    >
                      <Compass className="size-3.5 shrink-0" />
                      <span className="max-w-40 truncate">{browserTab.label}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`关闭 ${browserTab.label} 标签页`}
                      onClick={() => {
                        if (sessionId !== null) closeBrowserTab(sessionId, browserTabId);
                      }}
                      className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                );
              }
              const sourcePath = sourceFilePathOf(tabRef);
              if (sourcePath !== null) {
                const label = fileLeafName(sourcePath);
                return (
                  <div
                    key={tabRef}
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-sm",
                      activeTab === tabRef
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/60",
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`切换到 ${label} 标签页`}
                      title={sourcePath}
                      onClick={() => {
                        if (sessionId !== null) {
                          selectSourceFileTab(sessionId, tabRef as SourceFileTabRef);
                        }
                      }}
                      className="flex items-center gap-2 outline-none"
                    >
                      <File className="size-3.5 shrink-0" />
                      <span className="max-w-40 truncate">{label}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`关闭 ${label} 标签页`}
                      onClick={() => {
                        if (sessionId !== null) {
                          closeSourceFileTab(sessionId, tabRef as SourceFileTabRef);
                        }
                      }}
                      className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                );
              }
              const childId = subagentChildIdOf(tabRef);
              if (childId !== null) {
                const subagentTab = subagentTabs.find((entry) => entry.childId === childId);
                if (subagentTab === undefined) return null;
                const label = subagentTab.label.trim() || SUBAGENT_TAB_LABEL;
                return (
                  <div
                    key={tabRef}
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-sm",
                      activeSubagentChildId === childId
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/60",
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`切换到 ${label} 标签页`}
                      onClick={() => {
                        if (sessionId !== null) selectSubagentTab(sessionId, childId);
                      }}
                      className="flex items-center gap-2 outline-none"
                    >
                      <Bot className="size-3.5 shrink-0" />
                      <span className="max-w-40 truncate">{label}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`关闭 ${label} 标签页`}
                      onClick={() => {
                        if (sessionId !== null) closeSubagentTab(sessionId, childId);
                      }}
                      className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                );
              }
              const pageKey = pluginPageKeyOf(tabRef);
              if (pageKey !== null) {
                const page = pageForKey(pluginPages, pageKey);
                if (page === null) return null;
                return (
                  <div
                    key={tabRef}
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-sm",
                      activePluginPage?.key === pageKey
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/60",
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`切换到 ${page.title} 标签页`}
                      onClick={() => {
                        if (sessionId !== null) selectPluginTab(sessionId, pageKey);
                      }}
                      className="flex items-center gap-2 outline-none"
                    >
                      <PluginPageIcon token={page.icon} className="size-3.5 shrink-0" />
                      <span className="max-w-40 truncate">{page.title}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`关闭 ${page.title} 标签页`}
                      onClick={() => {
                        if (sessionId !== null) closePluginTab(sessionId, pageKey);
                      }}
                      className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                );
              }
              const tab = terminalTabs.find((entry) => entry.id === tabRef);
              if (tab === undefined) return null;
              return (
                <div
                  key={tab.id}
                  className={cn(
                    "flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-sm",
                    activeTab === tab.id
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  <button
                    type="button"
                    aria-label={`切换到 ${tab.label} 标签页`}
                    onClick={() => {
                      if (sessionId !== null) selectTerminalTab(sessionId, tab.id);
                    }}
                    className="flex items-center gap-2 outline-none"
                  >
                    <SquareTerminal className="size-3.5 shrink-0" />
                    <span className="max-w-40 truncate">{tab.label}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={copy.closeTab(tab.label)}
                    onClick={() => closeTerminal(tab.id)}
                    className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* The column's own expand switch: the whole inset for the tools, the conversation
                folded away (`ChatAppHome`). Its icon swaps with beUI's `ActionSwapIcon`, so the two
                states are a crossfade-and-scale rather than a replaced glyph. Hidden where the
                column is a drawer (`AnimatedSidebar`'s mobile layout) — there is no conversation
                column beside it to give the room to — and with no conversation at all, where there
                is nothing to give the room *from* either. */}
            {sessionId === null ? null : (
              <button
                type="button"
                aria-label={expanded ? "还原工作面板" : "展开工作面板"}
                aria-pressed={expanded}
                onClick={toggleExpanded}
                className="hidden size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:grid"
              >
                <ActionSwapIcon value={expanded ? "restore" : "expand"} className="size-4">
                  {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                </ActionSwapIcon>
              </button>
            )}
            {/* The "+" opens the same entries an empty column offers; with no conversation there is
                none of them, so the control that would only ever open an empty surface is not drawn. */}
            {sessionId === null ? null : (
              <MorphPopover open={toolMenuOpen} onOpenChange={setToolMenuOpen}>
                <MorphPopoverTrigger>
                  <button
                    type="button"
                    aria-label="新建侧边工具"
                    className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Plus className="size-4" />
                  </button>
                </MorphPopoverTrigger>
                {/* One surface, always: this portal, drawn over whichever tab is on screen. */}
                <MorphPopoverContent
                  side="bottom"
                  align="end"
                  sideOffset={8}
                  radius={12}
                  className="w-72 p-1.5"
                >
                  <ToolMenuList
                    entries={menuEntries}
                    unwritten={unwritten}
                    onSelect={(entry) => {
                      selectEntry(entry);
                      setToolMenuOpen(false);
                    }}
                  />
                </MorphPopoverContent>
              </MorphPopover>
            )}
            <AnimatedSidebarTrigger
              aria-label="收起侧边栏"
              className="text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <PanelRightClose className="size-4" />
            </AnimatedSidebarTrigger>
          </div>
        </div>

        {/* Every conversation's tabs stay mounted, whichever conversation is on screen: a tab's
            shell lives exactly as long as its panel is mounted, so switching conversations — including
            the brief no-active-session transition — never ends a shell nobody closed. The panels that
            are not this conversation's (or not this tab) remain mounted and out of sight. `cwd` is
            where the tab's shell was started. */}
        {/* The panel area is `relative` so each tab's `absolute inset-0` fills it; only the visible
            tab is interactive, the rest are `invisible` but still laid out (so xterm keeps its grid
            and a tab is not torn down on switch). A strip tab's panel stays mounted while the tab
            exists - scroll, expansion, the open diff and the drafted message survive looking away -
            and closing it unmounts the panel. The empty-state nav covers the same box. */}
        <div className="relative min-h-0 flex-1">
          {/* The git and file panels are mounted once per conversation that has their tab, exactly
              as the terminals are: a look at another conversation is a visibility change, not an
              unmount, so the review keeps its rows, its expanded files, its open diff and the
              reader's drafted message. Each panel reads the root its own tab was opened on. */}
          {Object.entries(panel.gitOpen).map(([owner, root]) => {
            const visible = owner === sessionId && activeTab === "git";
            return (
              <div
                key={`git:${owner}`}
                className={cn("absolute inset-0", !visible && "invisible")}
                aria-hidden={!visible}
              >
                <GitReviewPanel workspaceRoot={root} active={visible && open} />
              </div>
            );
          })}
          {Object.entries(panel.tabOrder).map(([owner, refs]) =>
            refs.map((ref) => {
              const path = sourceFilePathOf(ref);
              if (path === null) return null;
              const visible = owner === sessionId && activeTab === ref && open;
              return (
                <div
                  key={`source:${owner}:${ref}`}
                  className={cn("absolute inset-0", !visible && "invisible")}
                  aria-hidden={!visible}
                >
                  <FileSourcePanel path={path} active={visible} />
                </div>
              );
            }),
          )}
          {Object.entries(panel.fileOpen).map(([owner, root]) => {
            const visible = owner === sessionId && activeTab === "file";
            return (
              <div
                key={`file:${owner}`}
                className={cn("absolute inset-0", !visible && "invisible")}
                aria-hidden={!visible}
              >
                <FilePanel sessionId={owner} workspaceRoot={root} active={visible && open} />
              </div>
            );
          })}
          {/* A subagent's own conversation stays mounted like every other tab: its rows, its
              disclosures and its reading position are the reader's, and a look at another tab must
              not throw them away. Closing the tab is what releases the child's read. */}
          {sessionId === null
            ? null
            : subagentTabs.map((subagentTab) => {
                const visible = activeSubagentChildId === subagentTab.childId && open;
                return (
                  <div
                    key={subagentTab.childId}
                    className={cn("absolute inset-0", !visible && "invisible")}
                    aria-hidden={!visible}
                  >
                    <SubagentPanel
                      ownerSessionId={sessionId}
                      tab={subagentTab}
                      active={visible}
                    />
                  </div>
                );
              })}
          {/* One frame per open plugin page, mounted for as long as its tab exists, exactly as the
              other panels are: switching tabs is a visibility change, so the page keeps its
              document, its scroll and whatever the reader half-typed into it. A page that is no
              longer served is dropped above (`prunePluginTabs`), which is what unmounts it. */}
          {/* One native guest per browser tab, mounted for as long as its tab exists. Only the
              visible one is placed; the rest are parked by the desktop and keep running for the
              agent. A surface that actually covers the hole hides the guest whole (the panel asks
              `state/overlay-depth.ts`), because a native child webview always paints above the
              document. */}
          {Object.entries(panel.browserOpen).map(([owner, tabs]) =>
            tabs.map((browserTab) => {
              const visible =
                owner === sessionId && activeBrowserTabId === browserTab.tabId && open;
              return (
                <div
                  key={`${owner}:${browserTab.tabId}`}
                  className={cn("absolute inset-0", !visible && "invisible")}
                  aria-hidden={!visible}
                >
                  <BrowserPanel
                    sessionId={owner}
                    tab={browserTab}
                    active={visible}
                  />
                </div>
              );
            }),
          )}
          {Object.entries(panel.pluginOpen).map(([owner, keys]) =>
            keys.map((key) => {
              const page = pageForKey(pluginPages, key);
              if (page === null) return null;
              const visible = owner === sessionId && activeTab === pluginTabRefOf(key) && open;
              return (
                <div
                  key={`${owner}:${key}`}
                  className={cn("absolute inset-0", !visible && "invisible")}
                  aria-hidden={!visible}
                >
                  <PluginPageFrame page={page} active={visible} />
                </div>
              );
            }),
          )}
          <div
            className={cn("absolute inset-0", stripTabActive && "invisible")}
            aria-hidden={stripTabActive}
          >
            <AllTerminalPanels
              visibleSessionId={sessionId}
              visibleTabId={typeof activeTab === "number" ? activeTab : null}
              onShellLabel={renameTerminal}
            />
            {terminalTabs.length === 0 &&
            !gitTab &&
            !fileTab &&
            sourceRefs.length === 0 &&
            subagentTabs.length === 0 &&
            openPluginKeys.length === 0 &&
            browserTabs.length === 0 ? (
              <nav
                className="absolute inset-0 flex flex-col justify-center gap-3 px-8"
                aria-label="工作区工具"
              >
                <div className="mx-auto flex w-full max-w-sm flex-col gap-3">
                {menuEntries.map((entry) => {
                  const Icon = entry.icon;
                  const locked = toolEntryLocked(entry.action, unwritten);
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      disabled={locked}
                      title={locked ? menuCopy.menuLockedHint : undefined}
                      onClick={() => selectEntry(entry)}
                      className="flex h-10 items-center gap-3 rounded-lg px-2.5 text-left text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {entry.shortcut.map((key) => (
                          <kbd
                            key={key}
                            className="rounded-md border border-border/80 bg-background px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground"
                          >
                            {key}
                          </kbd>
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
            </nav>
            ) : null}
          </div>
        </div>
      </AnimatedSidebar>
    </AnimatedSidebarProvider>
  );
}

/**
 * The workspace watch, pointed where the git review or the file tab is looking.
 *
 * The watch is a process-wide singleton the desktop re-points on command, so the component that owns
 * the visible surface owns the pointer too: it follows that surface's root while it is on screen and
 * stops the watch when neither is, so a panel nobody is reading costs no inotify handles. The
 * coalesced reports bump one revision in `state/workspace-watch-store.ts`; each surface folds it
 * into the quiet refresh it knows how to do. A report that could have moved git's refs also bumps
 * the second revision the branch row reads, so a file save does not cost it a git process.
 */
function WorkspaceWatch({ root }: { root: string | null }) {
  useEffect(() => {
    void setWorkspaceWatch(root).catch(() => undefined);
    return () => {
      void setWorkspaceWatch(null).catch(() => undefined);
    };
  }, [root]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void subscribeWorkspaceChanged((report) => {
      if (disposed) return;
      if (root !== null && report.root !== root) return;
      // Reads the report before any listener can throw and take the rest of this dispatch with it:
      // `bumpWorkspaceChange` guards its own listeners, and `reportTouchesRefs` tolerates a report
      // whose `paths` are not what the type says (it is an event payload, not a local value).
      bumpWorkspaceChange(reportTouchesRefs(report));
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [root]);
  return null;
}

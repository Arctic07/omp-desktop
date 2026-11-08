/**
 * The right-hand column's actions: its flags and its non-terminal tabs, per conversation.
 *
 * A conversation is the thing the column belongs to, so everything it carries is kept per session
 * id rather than for the window. The maps themselves are `state/panel-state.ts` (which also holds the
 * subscription and the readings the strip takes), and the shells are `state/terminal-tabs.ts`; this
 * module is what the column's doors, menus and the session store call:
 *
 * ① **Whether the column is open — and expanded — is the conversation's** (2026-10-24, user request;
 * it was one window-wide flag before, and the reader saw every other conversation's column open with
 * it). A conversation they never opened it in draws none; going back to one they did shows it as they
 * left it. Tabs are per conversation for the same reason.
 * ② **Which terminals it has.** A conversation owns a list of tabs, and "open a terminal" always adds
 * one. The agent's own shell joins the list as a tab of its own rather than replacing what the reader
 * has open: the reader may be watching a build in one shell while the agent types into another, and
 * the two are different pty's. A tab that is not the active conversation's stays mounted and live; it
 * comes back when its conversation does.
 * ③ **The mixed tab order.** Terminal and git tabs share one per-conversation opening order, so the
 * strip reflects how the reader actually opened them rather than a fixed component order.
 * ④ **The git review and the file panel are tabs too, and only ever one each.** "改动" and
 * "文件" join the same strip as the terminal tabs (`components/workspace/git-review.tsx`,
 * `components/workspace/file-panel.tsx`); asking for either jumps to the existing tab or opens the
 * one tab there is — both are one view of one working tree, so unlike a terminal they never
 * multiply. Closing one is closing a tab: the strip loses the entry, and the panel's own state is
 * released with it (a closed review or file tab starts fresh the next time it is opened). Like a
 * terminal tab, an open one stays mounted while another conversation is on screen, so a reader who
 * looked away comes back to the same rows, the same expanded files and the same open diff; the tab
 * carries the workspace root it was opened on, because it is not the on-screen conversation that
 * decides which tree it reads.
 * ⑤ **A subagent's conversation is a tab of its own.** Clicking one row of a `task` call's roster
 * opens that child's transcript beside the conversation that spawned it, under the child's own name
 * (`components/workspace/subagent-panel.tsx`, `state/subagent-view.ts`). The tab carries the target
 * it was created with — the child's id and the spawning conversation's file — so the panel only
 * reads. One tab per child, and closing it is what releases the child's listener and rows.
 * ⑥ **A file outside the workspace is a tab of its own.** A transcript path under the conversation's
 * root opens the file tab; every other path gets a tab here, read by `read_external_file`
 * (`components/workspace/file-source-panel.tsx`).
 *
 * The state lives outside React because the column and the header's door both read it, and because a
 * conversation's tabs must survive the column being closed and reopened — only closing a tab ends a
 * shell. What the reader did here is also what keeps a conversation nothing has been sent in alive
 * (`ownsPanelState`, read by `state/session-store.ts::letGo`), so a blank conversation with a shell in
 * it is not handed back.
 */

import { browserCloseSession, browserCloseTab } from '@/api/browser'
import { terminalCloseSession } from '@/api/terminal'
import {
  activeTabOf,
  closed,
  opened,
  panelState,
  pluginOpenOf,
  subagentOpenOf,
  tabOrderOf,
  tabsOf,
  updatePanel,
  visibleTabOrder,
  type PanelState,
} from '@/state/panel-state'
import {
  browserTabLabel,
  browserTabRefOf,
  isSourceFileRef,
  pluginTabRefOf,
  sourceFileRefOf,
  sourceFilePathOf,
  subagentRefOf,
  type BrowserTab,
  type PanelTabRef,
  type SourceFileTabRef,
  type SubagentTab,
  type SubagentTabRef,
} from '@/state/panel-tabs'
import { sameFilePath } from '@/lib/file-path'
import { sessionsOverBound } from '@/state/panel-bound'
import { visitRank } from '@/state/session-visits'
import { openSubagentView } from '@/state/subagent-view'
import { terminalTargetOf } from '@/state/terminal-tabs'

/** Whether this conversation's column is open. */
export function isPanelOpen(sessionId: string | null): boolean {
  return sessionId !== null && panelState().open[sessionId] === true
}

/** Open or close one conversation's column. A conversation keeps the answer for its own lifetime. */
export function setPanelOpen(sessionId: string, open: boolean): void {
  const current = panelState()
  if (open === (current.open[sessionId] === true)) return
  updatePanel({ open: open ? opened(current.open, sessionId) : closed(current.open, sessionId) })
}

/** Whether this conversation's column has the whole inset. */
export function isPanelExpanded(sessionId: string | null): boolean {
  return sessionId !== null && panelState().expanded[sessionId] === true
}

/** Expand or restore one conversation's column. */
export function setPanelExpanded(sessionId: string, expanded: boolean): void {
  const current = panelState()
  if (expanded === (current.expanded[sessionId] === true)) return
  const flags = expanded ? opened(current.expanded, sessionId) : closed(current.expanded, sessionId)
  updatePanel({ expanded: flags })
}

/**
 * The tab `step` places along from the one on screen, for the column's `Ctrl+Tab`.
 *
 * The walk is over the strip's own order — the tabs that exist, in the order they were opened — so the
 * key moves between the tabs the reader can see, and a step past either end wraps around. `null` means
 * there is nowhere to go: no conversation, or fewer than two tabs on the strip.
 */
export function neighbouringTabOf(sessionId: string | null, step: number): PanelTabRef | null {
  if (sessionId === null) return null
  const order = visibleTabOrder(sessionId, tabsOf(sessionId))
  if (order.length < 2) return null
  const index = order.indexOf(activeTabOf(sessionId) as PanelTabRef)
  if (index === -1) return step > 0 ? (order[0] ?? null) : (order.at(-1) ?? null)
  return order[(index + step + order.length) % order.length] ?? null
}

/** The workspace root a conversation stands in right now, or null when its record is gone. */
function sessionRootOf(sessionId: string): string | null {
  const root = terminalTargetOf(sessionId)?.cwd
  return root === undefined || root === '' ? null : root
}

/**
 * Bring the git review tab forward: jump to it when it exists, open the one tab there is when it
 * does not (④ above: one view of one working tree). A new tab carries the root it was opened on.
 */
export function openGitTab(sessionId: string): void {
  if (panelState().gitOpen[sessionId] !== undefined) {
    updatePanel({ open: opened(panelState().open, sessionId), activeTab: { ...panelState().activeTab, [sessionId]: 'git' } })
    return
  }
  updatePanel({
    gitOpen: { ...panelState().gitOpen, [sessionId]: sessionRootOf(sessionId) },
    tabOrder: { ...panelState().tabOrder, [sessionId]: [...tabOrderOf(sessionId), 'git'] },
    activeTab: { ...panelState().activeTab, [sessionId]: 'git' },
    open: opened(panelState().open, sessionId),
  })
}

/** Close the git review tab. Its panel unmounts with it, releasing the review it held. */
export function closeGitTab(sessionId: string): void {
  if (panelState().gitOpen[sessionId] === undefined) return
  const gitOpen = { ...panelState().gitOpen }
  delete gitOpen[sessionId]
  const order = tabOrderOf(sessionId)
  const nextOrder = order.filter((entry) => entry !== 'git')
  const next = nextOrder.at(-1)
  updatePanel({
    gitOpen,
    tabOrder: { ...panelState().tabOrder, [sessionId]: nextOrder },
    activeTab: { ...panelState().activeTab, [sessionId]: panelState().activeTab[sessionId] === 'git' ? (next ?? null) : panelState().activeTab[sessionId] },
  })
}

/**
 * Bring one plugin page forward: jump to it when it is already a tab, open it when it is not.
 *
 * A page is opened by whatever entry the reader used — a sidebar row, the workspace's own launcher,
 * a button on the plugin's settings page — and every one of them lands here, so the same page never
 * becomes two tabs. The tab carries only the page's key; the URL and the title are read from the
 * plugin list each time the surfaces draw, which is what makes an upgrade or a disable take effect
 * without a second source of truth.
 */
export function openPluginTab(sessionId: string, pageKey: string): void {
  const ref = pluginTabRefOf(pageKey)
  if (pluginOpenOf(sessionId).includes(pageKey)) {
    updatePanel({
      open: opened(panelState().open, sessionId),
      activeTab: { ...panelState().activeTab, [sessionId]: ref },
    })
    return
  }
  updatePanel({
    pluginOpen: { ...panelState().pluginOpen, [sessionId]: [...pluginOpenOf(sessionId), pageKey] },
    tabOrder: { ...panelState().tabOrder, [sessionId]: [...tabOrderOf(sessionId), ref] },
    activeTab: { ...panelState().activeTab, [sessionId]: ref },
    open: opened(panelState().open, sessionId),
  })
}

/** Bring a plugin page's tab forward; nothing happens when the page is not open. */
export function selectPluginTab(sessionId: string, pageKey: string): void {
  if (!pluginOpenOf(sessionId).includes(pageKey)) return
  updatePanel({
    activeTab: { ...panelState().activeTab, [sessionId]: pluginTabRefOf(pageKey) },
  })
}

/** Close one plugin page's tab. Its frame unmounts with it, ending the page's document. */
export function closePluginTab(sessionId: string, pageKey: string): void {
  const openPages = pluginOpenOf(sessionId)
  if (!openPages.includes(pageKey)) return
  const ref = pluginTabRefOf(pageKey)
  const nextOrder = tabOrderOf(sessionId).filter((entry) => entry !== ref)
  const closes: Record<string, string[]> = { ...panelState().pluginOpen }
  const remaining = openPages.filter((key) => key !== pageKey)
  if (remaining.length === 0) delete closes[sessionId]
  else closes[sessionId] = remaining
  updatePanel({
    pluginOpen: closes,
    tabOrder: { ...panelState().tabOrder, [sessionId]: nextOrder },
    activeTab: {
      ...panelState().activeTab,
      [sessionId]:
        panelState().activeTab[sessionId] === ref ? (nextOrder.at(-1) ?? null) : panelState().activeTab[sessionId],
    },
  })
}

/**
 * Drop the plugin tabs whose page the current list no longer serves.
 *
 * A list read is when a plugin can disappear, be disabled, or be upgraded into a package that no
 * longer declares the page its tab was opened on. The tab is closed (not left pointing at a page
 * this build cannot resolve), and if it was the tab on screen the strip moves to what is left. The
 * caller passes the keys the list still serves; a key not in that set is gone.
 */
export function prunePluginTabs(sessionId: string, served: ReadonlySet<string>): void {
  const openPages = pluginOpenOf(sessionId)
  const stale = openPages.filter((key) => !served.has(key))
  if (stale.length === 0) return
  const staleRefs = new Set<string>(stale.map(pluginTabRefOf))
  const remaining = openPages.filter((key) => served.has(key))
  const nextOrder = tabOrderOf(sessionId).filter(
    (entry) => typeof entry !== 'string' || !staleRefs.has(entry),
  )
  const active = panelState().activeTab[sessionId]
  const closes: Record<string, string[]> = { ...panelState().pluginOpen }
  if (remaining.length === 0) delete closes[sessionId]
  else closes[sessionId] = remaining
  updatePanel({
    pluginOpen: closes,
    tabOrder: { ...panelState().tabOrder, [sessionId]: nextOrder },
    activeTab: {
      ...panelState().activeTab,
      [sessionId]:
        typeof active === 'string' && staleRefs.has(active)
          ? (nextOrder.at(-1) ?? null)
          : active,
    },
  })
}

/**
 * Bring the file tab forward: jump to it when it exists, open the one tab there is when it does not.
 * A new tab carries the root it was opened on, exactly as the git review's does.
 */
export function openFileTab(sessionId: string): void {
  if (panelState().fileOpen[sessionId] !== undefined) {
    updatePanel({
      open: opened(panelState().open, sessionId),
      activeTab: { ...panelState().activeTab, [sessionId]: 'file' },
    })
    return
  }
  updatePanel({
    fileOpen: { ...panelState().fileOpen, [sessionId]: sessionRootOf(sessionId) },
    tabOrder: { ...panelState().tabOrder, [sessionId]: [...tabOrderOf(sessionId), 'file'] },
    activeTab: { ...panelState().activeTab, [sessionId]: 'file' },
    open: opened(panelState().open, sessionId),
  })
}

/** Close the file tab. The panel unmounts with it, releasing its tree and preview. */
export function closeFileTab(sessionId: string): void {
  if (panelState().fileOpen[sessionId] === undefined) return
  const fileOpen = { ...panelState().fileOpen }
  delete fileOpen[sessionId]
  const order = tabOrderOf(sessionId)
  const nextOrder = order.filter((entry) => entry !== 'file')
  const next = nextOrder.at(-1)
  updatePanel({
    fileOpen,
    tabOrder: { ...panelState().tabOrder, [sessionId]: nextOrder },
    activeTab: {
      ...panelState().activeTab,
      [sessionId]: panelState().activeTab[sessionId] === 'file' ? (next ?? null) : panelState().activeTab[sessionId],
    },
  })
}

/** Bring the strip's file tab forward. */
export function selectFileTab(sessionId: string): void {
  if (panelState().fileOpen[sessionId] === undefined) return
  updatePanel({ activeTab: { ...panelState().activeTab, [sessionId]: 'file' } })
}

/**
 * Open one outside file in the strip and show it (⑥ above). The ref is the whole record, and the
 * comparison is `sameFilePath`; the stored spelling uses `/`.
 */
export function openSourceFileTab(sessionId: string, path: string): SourceFileTabRef {
  const order = tabOrderOf(sessionId)
  let known: SourceFileTabRef | undefined
  for (const entry of order) {
    if (!isSourceFileRef(entry)) continue
    if (sameFilePath(sourceFilePathOf(entry) ?? '', path)) {
      known = entry
      break
    }
  }
  const ref = known ?? sourceFileRefOf(path)
  updatePanel({
    tabOrder: { ...panelState().tabOrder, [sessionId]: known === undefined ? [...order, ref] : [...order] },
    activeTab: { ...panelState().activeTab, [sessionId]: ref },
    open: opened(panelState().open, sessionId),
  })
  return ref
}

/** Close one outside file's tab. Its viewer unmounts with it, releasing the read. */
export function closeSourceFileTab(sessionId: string, ref: SourceFileTabRef): void {
  if (!tabOrderOf(sessionId).includes(ref)) return
  const order = tabOrderOf(sessionId).filter((entry) => entry !== ref)
  updatePanel({
    tabOrder: { ...panelState().tabOrder, [sessionId]: order },
    activeTab: {
      ...panelState().activeTab,
      [sessionId]:
        panelState().activeTab[sessionId] === ref ? (order.at(-1) ?? null) : panelState().activeTab[sessionId],
    },
  })
}

/** Bring one outside file's tab forward. */
export function selectSourceFileTab(sessionId: string, ref: SourceFileTabRef): void {
  if (!tabOrderOf(sessionId).includes(ref)) return
  updatePanel({ activeTab: { ...panelState().activeTab, [sessionId]: ref } })
}

/** Bring the strip's git review tab forward. */
export function selectGitTab(sessionId: string): void {
  if (panelState().gitOpen[sessionId] === undefined) return
  updatePanel({ activeTab: { ...panelState().activeTab, [sessionId]: 'git' } })
}

/**
 * Open one child's own conversation in the strip.
 *
 * Idempotent per child: a tab that already carries this child is jumped to rather than joined by a
 * second one — the reader asked to see that conversation, and there is one of it. A new tab joins
 * the mixed opening order and becomes the active tab, and the column opens with it, exactly as a
 * terminal's does.
 */
export function openSubagentTab(sessionId: string, tab: SubagentTab): SubagentTabRef {
  const ref = subagentRefOf(tab.childId)
  const current = subagentOpenOf(sessionId)
  if (current.some((entry) => entry.childId === tab.childId)) {
    updatePanel({
      open: opened(panelState().open, sessionId),
      activeTab: { ...panelState().activeTab, [sessionId]: ref },
    })
    return ref
  }
  updatePanel({
    subagentOpen: { ...panelState().subagentOpen, [sessionId]: [...current, tab] },
    tabOrder: { ...panelState().tabOrder, [sessionId]: [...tabOrderOf(sessionId), ref] },
    activeTab: { ...panelState().activeTab, [sessionId]: ref },
    open: opened(panelState().open, sessionId),
  })
  return ref
}

/**
 * Open one child's conversation in the strip and start reading it.
 *
 * The tab belongs to the conversation the reader is in, and the file to resolve the child against
 * is that conversation's: the child's transcript is written beside its parent. A parent with no
 * file has spawned nothing addressable, so the call is a no-op rather than a tab that cannot read.
 */
export function openSubagentConversation(
  ownerSessionId: string,
  ownerFile: string | null,
  childId: string,
  label: string,
): void {
  if (ownerFile === null) return
  openSubagentTab(ownerSessionId, { childId, label, parentFile: ownerFile })
  openSubagentView(childId, ownerSessionId, ownerFile)
}

/** Close one child's tab. Its panel unmounts with it, which is what releases the view. */
export function closeSubagentTab(sessionId: string, childId: string): void {
  const ref = subagentRefOf(childId)
  const current = subagentOpenOf(sessionId)
  if (!current.some((entry) => entry.childId === childId)) return
  const order = tabOrderOf(sessionId).filter((entry) => entry !== ref)
  updatePanel({
    subagentOpen: {
      ...panelState().subagentOpen,
      [sessionId]: current.filter((entry) => entry.childId !== childId),
    },
    tabOrder: { ...panelState().tabOrder, [sessionId]: order },
    activeTab: {
      ...panelState().activeTab,
      [sessionId]:
        panelState().activeTab[sessionId] === ref ? (order.at(-1) ?? null) : panelState().activeTab[sessionId],
    },
  })
}

/** Bring one child's tab forward. */
export function selectSubagentTab(sessionId: string, childId: string): void {
  if (!subagentOpenOf(sessionId).some((entry) => entry.childId === childId)) return
  updatePanel({ activeTab: { ...panelState().activeTab, [sessionId]: subagentRefOf(childId) } })
}

/** The browser pages one conversation has open, in the order they were opened. */
export function browserTabsOf(sessionId: string | null): readonly BrowserTab[] {
  return sessionId === null ? [] : (panelState().browserOpen[sessionId] ?? [])
}

/**
 * Open one browser page in the strip and show it.
 *
 * Idempotent per tab id: a page the desktop already holds is jumped to rather than joined by a
 * second tab. The desktop creates the guest; this only records the tab the reader sees.
 */
export function openBrowserTab(sessionId: string, tab: BrowserTab): void {
  const ref = browserTabRefOf(tab.tabId)
  const current = browserTabsOf(sessionId)
  if (current.some((entry) => entry.tabId === tab.tabId)) {
    updatePanel({
      open: opened(panelState().open, sessionId),
      activeTab: { ...panelState().activeTab, [sessionId]: ref },
    })
    return
  }
  updatePanel({
    browserOpen: { ...panelState().browserOpen, [sessionId]: [...current, tab] },
    tabOrder: { ...panelState().tabOrder, [sessionId]: [...tabOrderOf(sessionId), ref] },
    activeTab: { ...panelState().activeTab, [sessionId]: ref },
    open: opened(panelState().open, sessionId),
  })
}

/** Bring one browser page's tab forward; nothing happens when it is not open. */
export function selectBrowserTab(sessionId: string, tabId: string): void {
  if (!browserTabsOf(sessionId).some((tab) => tab.tabId === tabId)) return
  updatePanel({ activeTab: { ...panelState().activeTab, [sessionId]: browserTabRefOf(tabId) } })
}

/**
 * Apply one `browser-state` event to the tab it names.
 *
 * The label follows the document title, else the address's host or file name; a loading or failed
 * page keeps the address label.
 */
export function updateBrowserTab(
  sessionId: string,
  state: {
    tabId: string
    url: string
    title: string
    isLoading: boolean
    loadError?: string
  },
): void {
  const current = browserTabsOf(sessionId)
  if (!current.some((tab) => tab.tabId === state.tabId)) return
  const tabs = current.map((tab) =>
    tab.tabId === state.tabId
      ? {
          ...tab,
          location: state.url,
          label:
            !state.isLoading && !state.loadError && state.title
              ? state.title
              : browserTabLabel(state.url),
          loading: state.isLoading,
          loadError: state.loadError,
        }
      : tab,
  )
  updatePanel({ browserOpen: { ...panelState().browserOpen, [sessionId]: tabs } })
}

/** Close one browser tab, and tell the desktop to destroy its guest. */
export function closeBrowserTab(sessionId: string, tabId: string): void {
  const current = browserTabsOf(sessionId)
  if (!current.some((tab) => tab.tabId === tabId)) return
  void browserCloseTab({ sessionId, tabId }).catch(() => undefined)
  const ref = browserTabRefOf(tabId)
  const order = tabOrderOf(sessionId).filter((entry) => entry !== ref)
  updatePanel({
    browserOpen: {
      ...panelState().browserOpen,
      [sessionId]: current.filter((tab) => tab.tabId !== tabId),
    },
    tabOrder: { ...panelState().tabOrder, [sessionId]: order },
    activeTab: {
      ...panelState().activeTab,
      [sessionId]:
        panelState().activeTab[sessionId] === ref
          ? (order.at(-1) ?? null)
          : panelState().activeTab[sessionId],
    },
  })
}

/**
 * Rebuild the browser tabs one conversation still holds in the desktop after a renderer reload.
 * A tab that is already in the strip is left as it is; the last restored tab becomes active only
 * when the strip had no active tab of its own.
 */
export function restoreBrowserTabs(
  sessionId: string,
  pages: readonly { tabId: string; url: string; title: string; isLoading: boolean; loadError?: string }[],
): void {
  const current = browserTabsOf(sessionId)
  const missing = pages.filter(
    (page) => page.tabId && !current.some((tab) => tab.tabId === page.tabId),
  )
  if (missing.length === 0) return
  const added: BrowserTab[] = missing.map((page) => ({
    tabId: page.tabId,
    location: page.url,
    label: page.title || browserTabLabel(page.url),
    loading: page.isLoading,
    loadError: page.loadError,
  }))
  const contextOrder = tabOrderOf(sessionId)
  const nextOrder = [...contextOrder, ...added.map((tab) => browserTabRefOf(tab.tabId))]
  updatePanel({
    browserOpen: { ...panelState().browserOpen, [sessionId]: [...current, ...added] },
    tabOrder: { ...panelState().tabOrder, [sessionId]: nextOrder },
    activeTab: {
      ...panelState().activeTab,
      [sessionId]: panelState().activeTab[sessionId] ?? browserTabRefOf(added[added.length - 1].tabId),
    },
  })
}

/**
 * Every conversation the column holds any state for.
 *
 * Read from **every** per-session map rather than from the terminal tabs alone: a conversation whose
 * only tab was a git, file or subagent one has state here too, and a reader deleting that
 * conversation has to have it dropped (`forgetSession`) rather than kept for the life of the process.
 * The maps hold different kinds of value on purpose — what this reads is which ids they name.
 */
export function panelOwners(current: PanelState = panelState()): string[] {
  const maps: readonly Record<string, unknown>[] = [
    // A conversation whose column the reader opened holds state here even with no tab in it.
    current.open,
    current.expanded,
    current.tabs,
    current.activeTab,
    current.tabOrder,
    current.gitOpen,
    current.fileOpen,
    current.subagentOpen,
    current.pluginOpen,
    current.browserOpen,
  ]
  const owners = new Set<string>()
  for (const map of maps) {
    for (const owner of Object.keys(map)) owners.add(owner)
  }
  return [...owners]
}

/**
 * Whether the column holds any key of its own for this conversation — what {@link forgetSession}
 * has to drop. Presence, not content: a closed tab's empty list is still a key to remove.
 */
function hasColumnKeys(sessionId: string): boolean {
  const current = panelState()
  return (
    current.open[sessionId] !== undefined ||
    current.expanded[sessionId] !== undefined ||
    current.tabs[sessionId] !== undefined ||
    current.activeTab[sessionId] !== undefined ||
    current.gitOpen[sessionId] !== undefined ||
    current.fileOpen[sessionId] !== undefined ||
    current.subagentOpen[sessionId] !== undefined ||
    current.pluginOpen[sessionId] !== undefined ||
    current.browserOpen[sessionId] !== undefined ||
    current.tabOrder[sessionId] !== undefined
  )
}

/**
 * Keep the column's per-conversation maps to the conversations the reader was in most recently.
 *
 * The maps were only ever released by {@link forgetSession}, which runs when a conversation is gone
 * for good - so a reader who opened a shell in a hundred conversations kept a hundred entries, and
 * kept those conversations from being shed at all: {@link ownsPanelState} refuses the record ceiling
 * any conversation whose column holds something. The bound, the ranking and the counter rule are
 * `state/panel-bound.ts`; this is where they meet the release path, because releasing is
 * {@link forgetSession} and nothing else (it closes the shells and clears every map).
 *
 * Called by the session store's own prune (`session-store.ts::pruneRecords`), before it decides what
 * to shed - the conversations this released are exactly the ones it may then reclaim.
 *
 * Answers how many it released.
 */
export function trimPanelSessions(activeId: string | null): number {
  const releasing = sessionsOverBound(panelOwners(), activeId, visitRank)
  for (const sessionId of releasing) forgetSession(sessionId)
  return releasing.length
}

/**
 * Whether this conversation owns anything in the work column at all.
 *
 * Read by the session store, which is what decides whether a conversation nothing has been sent in
 * is handed back whole when the reader leaves it. This is the fact that says it must not be: the
 * reader's own work in it — a shell, a review, a page — lives exactly as long as the column's state
 * naming it does, and handing the conversation back would close the shell and lose the state
 * (2026-10-26, user report: a terminal opened in a new conversation was gone after a switch).
 *
 * Read as "is there anything left", not "is the key there": closing the last tab of a conversation
 * leaves its list empty rather than dropping it (`closeTerminalTab` and its siblings), so presence
 * alone would keep every conversation whose column was ever open alive forever.
 */
export function ownsPanelState(sessionId: string): boolean {
  const current = panelState()
  return (
    current.open[sessionId] === true ||
    current.expanded[sessionId] === true ||
    (current.tabs[sessionId]?.length ?? 0) > 0 ||
    (current.tabOrder[sessionId]?.length ?? 0) > 0 ||
    (current.activeTab[sessionId] ?? null) !== null ||
    current.gitOpen[sessionId] !== undefined ||
    current.fileOpen[sessionId] !== undefined ||
    (current.subagentOpen[sessionId]?.length ?? 0) > 0 ||
    (current.pluginOpen[sessionId]?.length ?? 0) > 0 ||
    (current.browserOpen[sessionId]?.length ?? 0) > 0
  )
}

/**
 * Forget everything a conversation owned.
 *
 * Called when the conversation is gone from the workspace's own list — a deleted or archived
 * session, which is the only moment its tabs can never come back.
 */
export function forgetSession(sessionId: string): void {
  if (!hasColumnKeys(sessionId)) return
  void terminalCloseSession(sessionId).catch(() => undefined)
  void browserCloseSession(sessionId).catch(() => undefined)
  const open = closed(panelState().open, sessionId)
  const expanded = closed(panelState().expanded, sessionId)
  const tabs = { ...panelState().tabs }
  const activeTab = { ...panelState().activeTab }
  const gitOpen = { ...panelState().gitOpen }
  const fileOpen = { ...panelState().fileOpen }
  const subagentOpen = { ...panelState().subagentOpen }
  const pluginOpen = { ...panelState().pluginOpen }
  const browserOpen = { ...panelState().browserOpen }
  const tabOrder = { ...panelState().tabOrder }
  delete tabs[sessionId]
  delete activeTab[sessionId]
  delete gitOpen[sessionId]
  delete fileOpen[sessionId]
  delete subagentOpen[sessionId]
  delete pluginOpen[sessionId]
  delete browserOpen[sessionId]
  delete tabOrder[sessionId]
  updatePanel({
    open,
    expanded,
    tabs,
    activeTab,
    gitOpen,
    fileOpen,
    subagentOpen,
    pluginOpen,
    browserOpen,
    tabOrder,
  })
}


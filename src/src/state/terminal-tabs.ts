/**
 * The terminal tabs: one shell per tab, owned by the conversation the reader opened it in.
 *
 * A conversation owns a list of them, and "open a terminal" always adds one. The agent's own shell
 * joins the list as a tab of its own rather than replacing what the reader has open: the reader may
 * be watching a build in one shell while the agent types into another, and the two are different
 * pty's. A tab that is not the active conversation's stays mounted and live; it comes back when its
 * conversation does — only closing the tab ends a shell, which is why the tab carries the target it
 * was created with (`ownerSessionFile`, `cwd`) rather than reading the conversation on screen.
 *
 * The state itself is `state/panel-state.ts`; the strip's other tabs are `state/panel-store.ts`.
 */

import { terminalClose, terminalLabelSet } from '@/api/terminal'
import {
  opened,
  panelState,
  tabOrderOf,
  tabsOf,
  updatePanel,
  visibleTabOrder,
} from '@/state/panel-state'
import {
  nextTerminalNumber,
  terminalTabLabel,
  type PanelTabRef,
  type TerminalTab,
} from '@/state/panel-tabs'
import { sessionStore } from '@/state/session-record'
import { workspaceStore } from '@/state/workspace-store'

/**
 * Tell the desktop what a tab reads as, so the agent's own `list` shows the same name the reader
 * says out loud. A tab with no shell yet has nothing to name.
 *
 * A failed call is not the reader's problem: the tab still reads correctly here, and the agent's
 * `list` falls back to the shell's own name.
 */
function shareLabel(tab: TerminalTab): void {
  if (tab.terminalId === undefined) return
  void terminalLabelSet(tab.terminalId, tab.label).catch(() => undefined)
}

/**
 * Where a conversation's terminal stands: its session file and its workspace root.
 *
 * Resolved from the records this process already holds, at the moment the tab is created. Reading it
 * at mount instead would hand an empty directory to every tab whose conversation is not the one on
 * screen — which is most of them, because all tabs stay mounted.
 */
export function terminalTargetOf(sessionId: string): { ownerSessionFile: string; cwd: string } | null {
  const record = sessionStore.get().records[sessionId]
  if (record === undefined) return null
  const workspace = workspaceStore.get().items.find((item) => item.id === record.workspaceId)
  if (workspace === undefined) return null
  return { ownerSessionFile: record.filePath ?? '', cwd: workspace.rootPath }
}

/** Replace one conversation's tab list and make `active` the tab on screen. */
function writeTabs(
  sessionId: string,
  tabs: TerminalTab[],
  active: PanelTabRef,
  reveal: boolean,
): void {
  const order = visibleTabOrder(sessionId, tabs)
  const nextOrder = order.includes(active) ? order : [...order, active]
  updatePanel({
    tabs: { ...panelState().tabs, [sessionId]: tabs },
    tabOrder: { ...panelState().tabOrder, [sessionId]: nextOrder },
    activeTab: { ...panelState().activeTab, [sessionId]: active },
    // A tab that belongs to a conversation the reader is not in is added, not shown: the column is
    // the window's, and only the conversation on screen may bring it up.
    ...(reveal ? { open: opened(panelState().open, sessionId) } : {}),
  })
}

/**
 * Add a terminal to the conversation and show it.
 *
 * Every entry that means "a new terminal" lands here — the column's empty-state row and its "+" menu
 * — and each press is a new tab with a new shell. Reusing the open tab was wrong: a reader who asks
 * for another terminal wants another shell, and the menu said "new side tool".
 *
 * The tab takes the conversation's lowest free number at once, so it reads `终端-1` / `Terminal-1`
 * while the shell starts and `PowerShell-1` once the desktop names it.
 */
export function openTerminalTab(sessionId: string, name: string): number {
  const target = terminalTargetOf(sessionId)
  const current = tabsOf(sessionId)
  const id = panelState().nextTabId
  const number = nextTerminalNumber(current)
  const tab: TerminalTab = {
    id,
    number,
    label: terminalTabLabel(name, number),
    ownerSessionFile: target?.ownerSessionFile ?? '',
    cwd: target?.cwd ?? '',
  }
  updatePanel({ nextTabId: id + 1 })
  writeTabs(sessionId, [...current, tab], id, true)
  return id
}

/** Mark a tab whose shell could not be started, so its message stays and a new tab can be added. */
export function failTerminalTab(sessionId: string, tabId: number): void {
  const current = tabsOf(sessionId)
  if (!current.some((tab) => tab.id === tabId)) return
  updatePanel({
    tabs: {
      ...panelState().tabs,
      [sessionId]: current.map((tab) => (tab.id === tabId ? { ...tab, failed: true } : tab)),
    },
  })
}

/**
 * Show a terminal the agent started for this conversation.
 *
 * A tab of its own: the agent's shell is a different pty from whatever the reader has open, so it is
 * added (or selected, when this page already holds that id) rather than taking over the reader's
 * tab. A pending tab — one the reader opened a moment ago, whose pty the desktop has not answered for
 * yet — is bound to this id instead of leaving an empty tab beside it, but only when it is the only
 * one: with several tabs open, the reader's own shells must not be repurposed.
 *
 * `reveal` is the caller saying the shell started in the conversation on screen. A shell another
 * conversation started gets its tab and nothing else — the column is the window's, and a
 * conversation the reader is not in must not bring it up (2026-10-24, the same rule the expand
 * switch follows).
 */
export function openAttachedTerminalTab(
  sessionId: string,
  terminalId: string,
  shell: string,
  reveal: boolean,
): number {
  const current = tabsOf(sessionId)
  const known = current.find((tab) => tab.terminalId === terminalId && tab.exited !== true)
  if (known !== undefined) {
    updatePanel({
      activeTab: { ...panelState().activeTab, [sessionId]: known.id },
      ...(reveal ? { open: opened(panelState().open, sessionId) } : {}),
    })
    return known.id
  }
  const pending = current.find((tab) => tab.terminalId === undefined && tab.mode === undefined && tab.failed !== true)
  const target = terminalTargetOf(sessionId)
  if (pending !== undefined) {
    const bound: TerminalTab = {
      ...pending,
      terminalId,
      mode: 'attach',
      label: terminalTabLabel(shell, pending.number),
      ownerSessionFile: pending.ownerSessionFile || target?.ownerSessionFile || '',
      cwd: pending.cwd || target?.cwd || '',
    }
    writeTabs(sessionId, current.map((tab) => (tab.id === pending.id ? bound : tab)), bound.id, reveal)
    shareLabel(bound)
    return bound.id
  }
  const id = panelState().nextTabId
  updatePanel({ nextTabId: id + 1 })
  const number = nextTerminalNumber(current)
  const tab: TerminalTab = {
    id,
    number,
    label: terminalTabLabel(shell, number),
    terminalId,
    mode: 'attach',
    ownerSessionFile: target?.ownerSessionFile ?? '',
    cwd: target?.cwd ?? '',
  }
  writeTabs(sessionId, [...current, tab], id, reveal)
  shareLabel(tab)
  return id
}

/**
 * Show the live shells a conversation has running that this page has no tab for.
 *
 * The desktop's answer to "what does this conversation already have running" is the recovery path
 * for a shell this page did not create: the agent's `create`, or a shell that outlived a page
 * reload. This runs every time the conversation on screen changes, so it must not touch the strip
 * of a shell that already has a tab: that tab is exactly where the reader left it — the git review,
 * a file, another terminal — and re-attaching the shell on every switch is what pulled them back to
 * the first terminal (2026-10-21, user report). A conversation whose column the reader closed also
 * stays closed while every live shell is accounted for.
 */
export function recoverLiveTerminals(
  sessionId: string,
  terminals: readonly { id: string; shell: string }[],
): void {
  const known = new Set(
    tabsOf(sessionId)
      .filter((tab) => tab.exited !== true)
      .map((tab) => tab.terminalId),
  )
  for (const terminal of terminals) {
    if (known.has(terminal.id)) continue
    // The tab is added and made the conversation's active one; the column's open flag is the
    // reader's, and a recovery pass on a switch is not them asking to see it.
    openAttachedTerminalTab(sessionId, terminal.id, terminal.shell, false)
  }
}

/** Bind the tab that opened a pty to the id the desktop answered with. */
export function bindTerminalTab(sessionId: string, tabId: number, terminalId: string, shell: string): void {
  const current = tabsOf(sessionId)
  const tab = current.find((entry) => entry.id === tabId)
  if (tab === undefined) return
  const bound: TerminalTab = { ...tab, terminalId, label: terminalTabLabel(shell, tab.number) }
  if (tab.terminalId === terminalId && tab.label === bound.label) {
    shareLabel(bound)
    return
  }
  updatePanel({
    tabs: {
      ...panelState().tabs,
      [sessionId]: current.map((entry) => (entry.id === tabId ? bound : entry)),
    },
  })
  shareLabel(bound)
}

/** Mark a tab whose shell ended. The tab keeps the last screen; opening it again starts a new one. */
export function exitTerminalTab(sessionId: string, terminalId: string): void {
  const current = tabsOf(sessionId)
  if (!current.some((tab) => tab.terminalId === terminalId)) return
  updatePanel({
    tabs: {
      ...panelState().tabs,
      [sessionId]: current.map((tab) =>
        tab.terminalId === terminalId ? { ...tab, terminalId: undefined, exited: true } : tab,
      ),
    },
  })
}

/** The shell named itself after the panel attached: the tab takes that name plus its own number. */
export function renameTerminalTab(sessionId: string, id: number, shell: string): void {
  const current = tabsOf(sessionId)
  const tab = current.find((entry) => entry.id === id)
  if (tab === undefined) return
  const renamed: TerminalTab = { ...tab, label: terminalTabLabel(shell, tab.number) }
  if (tab.label !== renamed.label) {
    updatePanel({
      tabs: {
        ...panelState().tabs,
        [sessionId]: current.map((entry) => (entry.id === id ? renamed : entry)),
      },
    })
  }
  shareLabel(renamed)
}

/**
 * Close one tab. This is what ends a shell the reader owns: the pty outlives the view that draws it
 * (a layout change remounts that view without closing anything, `TerminalPanel.tsx` ③), so the tab
 * itself carries the teardown. A tab that only attached to a shell the agent started leaves it
 * running — that shell's life is the conversation's, not the strip's.
 */
export function closeTerminalTab(sessionId: string, id: number): void {
  const current = tabsOf(sessionId)
  const tab = current.find((entry) => entry.id === id)
  if (tab === undefined) return
  const next = current.filter((entry) => entry.id !== id)
  const order = tabOrderOf(sessionId).filter((entry) => entry !== id)
  const active = panelState().activeTab[sessionId] ?? null
  const nextActive = active === id ? (order.at(-1) ?? null) : active
  // The tab leaves first: the exit this close makes the desktop report names an id no tab carries
  // any more, so it cannot mark a live tab as exited.
  updatePanel({
    tabs: { ...panelState().tabs, [sessionId]: next },
    tabOrder: { ...panelState().tabOrder, [sessionId]: order },
    activeTab: { ...panelState().activeTab, [sessionId]: nextActive },
  })
  if (tab.mode !== 'attach' && tab.terminalId !== undefined) {
    void terminalClose(tab.terminalId).catch(() => undefined)
  }
}

export function selectTerminalTab(sessionId: string, id: number): void {
  if (!tabsOf(sessionId).some((tab) => tab.id === id)) return
  updatePanel({ activeTab: { ...panelState().activeTab, [sessionId]: id } })
}

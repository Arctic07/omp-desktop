/**
 * The work column's state object: every per-conversation map, the subscription, and the readings the
 * strip takes of them.
 *
 * The state lives outside React because the column and the header's door both read it, and because a
 * conversation's tabs must survive the column being closed and reopened — only closing a tab ends a
 * shell. What the reader did in the column is asked of this module
 * (`state/panel-store.ts::ownsPanelState`), so the maps here are the answer to "does this
 * conversation own anything" as well.
 *
 * The actions live next door: `state/panel-store.ts` for the column's flags and the non-terminal
 * tabs, `state/terminal-tabs.ts` for the shells. They all write through {@link updatePanel}, so the
 * state is only ever replaced whole and every listener sees one version of it.
 */

import { useSyncExternalStore } from 'react'

import { counterAfterWrite } from '@/state/panel-bound'
import {
  browserTabIdOf,
  pluginPageKeyOf,
  sourceFilePathOf,
  subagentChildIdOf,
  type BrowserTab,
  type PanelTabRef,
  type SubagentTab,
  type TerminalTab,
} from '@/state/panel-tabs'

export interface PanelState {
  /** Session id → the column is open for that conversation (absent = closed). */
  open: Record<string, boolean>
  /** Session id → that conversation's column is expanded onto the whole inset. */
  expanded: Record<string, boolean>
  /** Session id → that conversation's terminal tabs, in the order they were opened. */
  tabs: Record<string, TerminalTab[]>
  /** Session id → the tab on screen: a terminal tab's id, `'git'`, `'file'`, or a prefixed ref. */
  activeTab: Record<string, PanelTabRef | null>
  /** Session id → all mixed tabs in the order they were opened. */
  tabOrder: Record<string, PanelTabRef[]>
  /**
   * Session id → the workspace root the git review tab was opened on; the key's presence is the
   * tab. The target is resolved when the tab is created and stored on it, the way a terminal's is:
   * the panel is mounted for as long as the tab exists — including while another conversation is on
   * screen — and reading the root from the conversation on screen would point it at the wrong tree.
   */
  gitOpen: Record<string, string | null>
  /** Session id → the workspace root the file tab was opened on; there is never more than one. */
  fileOpen: Record<string, string | null>
  /** Session id → the subagent conversations opened in the strip, in the order they were opened. */
  subagentOpen: Record<string, SubagentTab[]>
  /** Session id → the plugin pages opened as tabs, by page key, in the order they were opened. */
  pluginOpen: Record<string, string[]>
  /** Session id → the browser pages opened as tabs, in the order they were opened. */
  browserOpen: Record<string, BrowserTab[]>
  /** Names the tabs. One counter for every conversation, so an id is never reused. */
  nextTabId: number
}

const EMPTY: PanelState = {
  open: {},
  expanded: {},
  tabs: {},
  activeTab: {},
  tabOrder: {},
  gitOpen: {},
  fileOpen: {},
  subagentOpen: {},
  pluginOpen: {},
  browserOpen: {},
  nextTabId: 1,
}

let state = EMPTY
const listeners = new Set<() => void>()

function emit(next: PanelState): void {
  state = next
  for (const listener of listeners) {
    // One surface throwing must not keep the others from seeing the new state: React's error
    // boundaries catch a render, not a `useSyncExternalStore` listener body, so an exception here
    // would make every later listener miss the emit — and every panel action that caused it fail.
    try {
      listener()
    } catch (error) {
      console.error("a panel state listener failed", error)
    }
  }
}

/** Replace the state with this version of it; every action in the column writes through here. */
export function updatePanel(patch: Partial<PanelState>): void {
  const next = { ...state, ...patch }
  // The id counter only has to keep the live tabs apart (`state/panel-bound.ts`): once no
  // conversation is named, the next tab may take the first id again.
  emit({
    ...next,
    nextTabId: counterAfterWrite(next.nextTabId, [
      next.open,
      next.expanded,
      next.tabs,
      next.activeTab,
      next.tabOrder,
      next.gitOpen,
      next.fileOpen,
      next.subagentOpen,
      next.pluginOpen,
      next.browserOpen,
    ]),
  })
}

export function subscribePanelState(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function panelState(): PanelState {
  return state
}

/** One conversation's column flag set, on. */
export function opened(flags: Record<string, boolean>, sessionId: string): Record<string, boolean> {
  return flags[sessionId] === true ? flags : { ...flags, [sessionId]: true }
}

/** The same map without this conversation: `false` is the absence of the entry, so a closed column
 * costs nothing and is not a panel owner (`panelOwners`, read by the prune) for the rest of its life. */
export function closed(flags: Record<string, boolean>, sessionId: string): Record<string, boolean> {
  if (flags[sessionId] === undefined) return flags
  const next = { ...flags }
  delete next[sessionId]
  return next
}

export function tabsOf(sessionId: string | null): readonly TerminalTab[] {
  return sessionId === null ? [] : (state.tabs[sessionId] ?? [])
}

export function activeTabOf(sessionId: string | null): PanelTabRef | null {
  return sessionId === null ? null : (state.activeTab[sessionId] ?? null)
}

export function tabOrderOf(sessionId: string | null): readonly PanelTabRef[] {
  return sessionId === null ? [] : (state.tabOrder[sessionId] ?? [])
}

/** The subagent conversations one conversation has open in its strip. */
export function subagentOpenOf(sessionId: string | null): readonly SubagentTab[] {
  return sessionId === null ? [] : (state.subagentOpen[sessionId] ?? [])
}

/** The plugin pages one conversation has open in its strip, by page key, oldest first. */
export function pluginOpenOf(sessionId: string | null): readonly string[] {
  return sessionId === null ? [] : (state.pluginOpen[sessionId] ?? [])
}

/** The browser pages one conversation has open in its strip, oldest first. */
export function browserOpenOf(sessionId: string | null): readonly BrowserTab[] {
  return sessionId === null ? [] : (state.browserOpen[sessionId] ?? [])
}

/** The tabs one conversation actually has on its strip, in the order they were opened. */
export function visibleTabOrder(sessionId: string, tabs: readonly TerminalTab[]): PanelTabRef[] {
  const knownIds = new Set(tabs.map((tab) => tab.id))
  const exists = (entry: PanelTabRef): boolean => {
    if (entry === 'git') return state.gitOpen[sessionId] !== undefined
    if (entry === 'file') return state.fileOpen[sessionId] !== undefined
    const childId = subagentChildIdOf(entry)
    if (childId !== null) return subagentOpenOf(sessionId).some((tab) => tab.childId === childId)
    const pageKey = pluginPageKeyOf(entry)
    if (pageKey !== null) return pluginOpenOf(sessionId).includes(pageKey)
    const browserTabId = browserTabIdOf(entry)
    if (browserTabId !== null) {
      return browserOpenOf(sessionId).some((tab) => tab.tabId === browserTabId)
    }
    if (sourceFilePathOf(entry) !== null) return true // the order is the whole record (⑥)
    return typeof entry === 'number' && knownIds.has(entry)
  }
  return tabOrderOf(sessionId).filter(exists)
}

/** Read the whole panel state from a component. */
export function usePanelState(): PanelState {
  return useSyncExternalStore(subscribePanelState, panelState, panelState)
}

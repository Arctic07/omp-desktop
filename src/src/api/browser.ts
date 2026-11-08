/**
 * The built-in browser's commands and events.
 *
 * The native guest is a child webview the desktop owns (`src-tauri/src/services/browser`); this
 * module is the React chrome's whole channel to it. One page is addressed by its conversation and
 * tab, which is also how the work panel stores it.
 */

import type { UnlistenFn } from '@tauri-apps/api/event'

import { call, subscribe } from '@/api/client'
import {
  BROWSER_OPEN_EVENT,
  BROWSER_REVEAL_EVENT,
  BROWSER_STATE_EVENT,
  COMMANDS,
} from '@/api/types'

/** One page's visible state, as the chrome draws it. */
export interface BrowserState {
  sessionId: string
  tabId: string
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** A navigation failure; the previous document must not be presented as ready. */
  loadError?: string
}

/** What `browser_open_tab` answers. */
export interface BrowserOpened {
  tabId: string
  state: BrowserState | null
}

/** The hole the React chrome measured, in logical pixels relative to the window's client area. */
export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

/** The actions beside the address bar. */
export type BrowserAction = 'back' | 'forward' | 'reload' | 'stop'

/** Open a Browser tab for one conversation; `preview` always gets a tab of its own. */
export function browserOpenTab(input: {
  sessionId: string
  workspaceRoot: string | null
  url?: string
  path?: string
  preview?: boolean
}): Promise<BrowserOpened> {
  return call<BrowserOpened>(COMMANDS.browserOpenTab, {
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot ?? null,
    url: input.url ?? null,
    path: input.path ?? null,
    preview: input.preview === true,
  })
}

/** Navigate one conversation's page (the connected/selected tab when `tabId` is omitted). */
export function browserNavigate(input: {
  sessionId: string
  tabId?: string
  workspaceRoot: string | null
  url?: string
  path?: string
}): Promise<BrowserState | null> {
  return call<BrowserState | null>(COMMANDS.browserNavigate, {
    sessionId: input.sessionId,
    tabId: input.tabId ?? null,
    workspaceRoot: input.workspaceRoot ?? null,
    url: input.url ?? null,
    path: input.path ?? null,
  })
}

/**
 * Names one show report; the desktop ignores an older one that crosses it on the wire.
 *
 * The clock is part of the number because the desktop outlives a renderer reload: a counter that
 * restarted at 1 would be older than every report the previous page sent, and the first tab switch
 * after a reload would be ignored.
 */
let showSequence = 0
function nextShowSequence(): number {
  showSequence = Math.max(Date.now(), showSequence + 1)
  return showSequence
}

/** Tell the desktop which page the mounted chrome is showing. */
export function browserShowTab(input: {
  sessionId: string | null
  tabId?: string | null
  url?: string | null
  workspaceRoot?: string | null
}): Promise<void> {
  return call<void>(COMMANDS.browserShowTab, {
    sessionId: input.sessionId,
    tabId: input.tabId ?? null,
    url: input.url ?? null,
    workspaceRoot: input.workspaceRoot ?? null,
    seq: nextShowSequence(),
  })
}

/** Names one bounds report, so a rectangle measured before a tab switch cannot land after it. */
let boundsSequence = 0
function nextBoundsSequence(): number {
  boundsSequence = Math.max(Date.now(), boundsSequence + 1)
  return boundsSequence
}

/** The hole the guest sits in. */
export function browserSetBounds(input: {
  sessionId: string
  tabId: string
  rect: BrowserRect
}): Promise<void> {
  return call<void>(COMMANDS.browserSetBounds, { ...input, seq: nextBoundsSequence() })
}

/** Whether the guest is on screen. */
export function browserSetVisible(input: {
  sessionId: string
  tabId: string
  visible: boolean
}): Promise<void> {
  return call<void>(COMMANDS.browserSetVisible, { ...input, seq: nextBoundsSequence() })
}

/** Back, forward, reload or stop. */
export function browserAction(input: {
  sessionId: string
  tabId: string
  action: BrowserAction
}): Promise<void> {
  return call<void>(COMMANDS.browserAction, input)
}

/** One page's current state. */
export function browserGetState(input: {
  sessionId: string
  tabId: string
}): Promise<BrowserState | null> {
  return call<BrowserState | null>(COMMANDS.browserGetState, input)
}

/** Every page one conversation holds, for rehydrating its tabs. */
export function browserPages(sessionId: string): Promise<BrowserState[]> {
  return call<BrowserState[]>(COMMANDS.browserPages, { sessionId })
}

/** Hand the current page to the machine's own browser (or default file handler). */
export function browserOpenExternal(input: {
  sessionId: string
  tabId: string
}): Promise<void> {
  return call<void>(COMMANDS.browserOpenExternal, input)
}

/** Close one tab and destroy its guest. */
export function browserCloseTab(input: {
  sessionId: string
  tabId: string
}): Promise<void> {
  return call<void>(COMMANDS.browserCloseTab, input)
}

/** Close every page one conversation owns. */
export function browserCloseSession(sessionId: string): Promise<void> {
  return call<void>(COMMANDS.browserCloseSession, { sessionId })
}

/** One page's state changed. */
export function onBrowserState(handler: (state: BrowserState) => void): Promise<UnlistenFn> {
  return subscribe<BrowserState>(BROWSER_STATE_EVENT, handler)
}

/** The agent or a link asked to open/focus a tab. */
export function onBrowserReveal(
  handler: (event: { sessionId: string; tabId?: string; url?: string }) => void,
): Promise<UnlistenFn> {
  return subscribe(BROWSER_REVEAL_EVENT, handler)
}

/** A guest's `window.open` asked for a new tab. */
export function onBrowserOpen(
  handler: (event: { sessionId: string; url: string }) => void,
): Promise<UnlistenFn> {
  return subscribe(BROWSER_OPEN_EVENT, handler)
}

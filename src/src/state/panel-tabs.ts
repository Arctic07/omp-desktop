/**
 * The strip's tabs: how each kind is spelled, how a ref is read back, and what a tab record carries.
 *
 * A ref is one string (or a terminal's own number), and the prefix is what keeps every kind from
 * reading as another: a child id, a plugin page key or a file path can never be mistaken for a
 * terminal id, and the literals `'git'` / `'file'` can never collide with one of the prefixed kinds.
 * The same spelling is used by the state that owns the tab (`state/panel-state.ts`,
 * `state/terminal-tabs.ts`, `state/panel-store.ts`) and by the strip that draws it
 * (`components/workspace/right-sidebar.tsx`), so this module is the one place that decides it — and
 * the one place that says which fields a terminal or subagent tab is made of.
 */

/** A child's own conversation, opened in the strip. */
export type SubagentTabRef = `subagent:${string}`

/** A plugin page shown as a work-panel tab; the rest of the ref is the page's own key. */
export type PluginTabRef = `plugin:${string}`

/** One file read from an absolute path outside the conversation's workspace. */
export type SourceFileTabRef = `file:${string}`

/** One browser page shown as a work-panel tab; the rest of the ref is the page's tab id. */
export type BrowserTabRef = `browser:${string}`

export type PanelTabRef =
  | number
  | 'git'
  | 'file'
  | SubagentTabRef
  | PluginTabRef
  | SourceFileTabRef
  | BrowserTabRef

/** The prefix that keeps a subagent tab's ref from ever reading as a terminal id. */
const SUBAGENT_TAB_PREFIX = 'subagent:'

/** The prefix that keeps a plugin page's tab from reading as any other kind of tab. */
const PLUGIN_TAB_PREFIX = 'plugin:'

/** The prefix that keeps an outside file's tab from reading as any other kind of tab. */
const SOURCE_FILE_TAB_PREFIX = 'file:'

/** The prefix that keeps a browser page's tab from reading as any other kind of tab. */
const BROWSER_TAB_PREFIX = 'browser:'

/** The ref a plugin page's tab is addressed by. */
export function pluginTabRefOf(pageKey: string): PluginTabRef {
  return `${PLUGIN_TAB_PREFIX}${pageKey}`
}

/** The page key a `plugin:` ref names, or null for any other ref. */
export function pluginPageKeyOf(ref: PanelTabRef | null): string | null {
  return typeof ref === 'string' && ref.startsWith(PLUGIN_TAB_PREFIX)
    ? ref.slice(PLUGIN_TAB_PREFIX.length)
    : null
}

/** The ref a child's own tab is addressed by, from the one place that knows its spelling. */
export function subagentRefOf(childId: string): SubagentTabRef {
  return `${SUBAGENT_TAB_PREFIX}${childId}`
}

/** The child id a `subagent:` ref names, or null for any other ref. */
export function subagentChildIdOf(ref: PanelTabRef): string | null {
  return typeof ref === 'string' && ref.startsWith(SUBAGENT_TAB_PREFIX)
    ? ref.slice(SUBAGENT_TAB_PREFIX.length)
    : null
}

/** The ref a browser page's tab is addressed by. */
export function browserTabRefOf(tabId: string): BrowserTabRef {
  return `${BROWSER_TAB_PREFIX}${tabId}`
}

/** The tab id a `browser:` ref names, or null for any other ref. */
export function browserTabIdOf(ref: PanelTabRef | null): string | null {
  return typeof ref === 'string' && ref.startsWith(BROWSER_TAB_PREFIX)
    ? ref.slice(BROWSER_TAB_PREFIX.length)
    : null
}

/** The ref a file read from an absolute path is addressed by. */
export function sourceFileRefOf(path: string): SourceFileTabRef {
  return `${SOURCE_FILE_TAB_PREFIX}${path}`
}

/** The path a `file:` ref names, or null for any other ref. */
export function sourceFilePathOf(ref: PanelTabRef | null): string | null {
  return typeof ref === 'string' && ref.startsWith(SOURCE_FILE_TAB_PREFIX)
    ? ref.slice(SOURCE_FILE_TAB_PREFIX.length)
    : null
}

/** Whether a ref names an outside file's tab; narrows it to the ref that carries the path. */
export function isSourceFileRef(ref: PanelTabRef): ref is SourceFileTabRef {
  return sourceFilePathOf(ref) !== null
}

/**
 * The number the next terminal tab of one conversation takes: the lowest positive integer no tab of
 * that conversation holds.
 *
 * Numbers are per conversation, so every conversation reads `PowerShell-1`, `-2`, … on its own, and
 * a number comes back once the tab that held it is closed — a closed shell that still has its tab
 * in the strip (the tab keeps the last screen) goes on holding its number, so two tabs of one
 * conversation never read alike.
 */
export function nextTerminalNumber(tabs: readonly TerminalTab[]): number {
  const used = new Set(tabs.map((tab) => tab.number))
  let number = 1
  while (used.has(number)) number += 1
  return number
}

/**
 * What a terminal tab reads as: the name it was opened with, plus its number (`PowerShell-2`).
 *
 * The desktop is told this name (`terminal_label_set`), and the agent's `list` shows it beside the
 * pty id — so a tab the reader names out loud is one the agent can address, in the conversation
 * they are both looking at.
 */
export function terminalTabLabel(name: string, number: number): string {
  return `${name}-${number}`
}

/** What a browser tab reads as before its document has a title: the host, else the file name. */
export function browserTabLabel(location: string): string {
  const trimmed = location.trim()
  if (!trimmed) return '浏览器'
  const leaf = trimmed.split(/[\\/]/).filter(Boolean).at(-1) || trimmed
  try {
    return new URL(trimmed).host || leaf
  } catch {
    return leaf
  }
}

/**
 * The conversation one browser shell event belongs to, or null when it names none.
 *
 * Every browser event the desktop sends (`browser-reveal`, `browser-state`, `browser-open`) names the
 * conversation whose page it is as `sessionId`, because the strip holds one Browser tab list per
 * conversation and the desktop announces nothing else: a plugin's own built-in-browser page belongs
 * to an installation and `services::browser` announces nothing about it. An event that names no
 * conversation has no tab to live in, so it draws nothing — which is what keeps a plugin from
 * materialising a conversation the reader does not have.
 */
export function browserEventSession(event: { sessionId?: string }): string | null {
  const sessionId = event.sessionId?.trim()
  return sessionId ? sessionId : null
}

/** One browser page a conversation owns, as the strip and the chrome read it. */
export interface BrowserTab {
  /** The desktop's own page id (`default`, `tab-3`, …). */
  tabId: string
  /** The address the page holds; empty until its first navigation. */
  location: string
  /** What the strip draws: the document title, else the address's host or file name. */
  label: string
  /** Whether a load is in flight. */
  loading: boolean
  /** The last navigation failure, when the page could not commit. */
  loadError?: string
}

/** One terminal tab a conversation owns. */
export interface TerminalTab {
  id: number
  /** The number this tab reads as inside its conversation; allocated once, kept until closed. */
  number: number
  /** What the strip draws: the name the tab was opened with plus its number, `PowerShell-2`. */
  label: string
  terminalId?: string
  mode?: 'open' | 'attach'
  /** The session file that owns the shell: the desktop's own owner key for it. */
  ownerSessionFile: string
  /** Where the shell was started. Resolved when the tab was created, not when it mounts. */
  cwd: string
  /** The shell exited on its own: the tab stays as a record, and opening it again starts a new one. */
  exited?: boolean
  /**
   * The last attempt to start this tab's shell failed (no shell found, a pty that refused).
   *
   * The tab is kept — the message it drew is what the reader has to see — and the next "new
   * terminal" adds a fresh tab rather than retrying this one, so a failure never becomes a tab that
   * cannot be got past.
   */
  failed?: boolean
}

/**
 * One subagent's own conversation, opened as a tab in the strip.
 *
 * The target is resolved when the tab is created and stored on it, exactly as a terminal tab's is:
 * the panel only reads, and the conversation a child belongs to may not be the one on screen by the
 * time the tab is drawn.
 */
export interface SubagentTab {
  /** The engine's own id for the child, which is the file stem its transcript was written under. */
  childId: string
  /** What the tab reads as: the `task` roster row's own name for the child. */
  label: string
  /** The spawning conversation's own session file; the child's transcript lives beside it. */
  parentFile: string
}

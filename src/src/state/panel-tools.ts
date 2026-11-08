/**
 * Opening one tool in the work panel, as one rule.
 *
 * The three tools are reachable from three places — the panel's "+" menu, its empty-state rows, and
 * the window's 文件 menu — and all of them mean the same thing: open that tool for the conversation
 * on screen, and bring the column up to show it. Each opener in `panel-store.ts` already does both
 * halves (it sets the tab *and* marks the column open), so this module is the one place that says
 * which opener a menu row stands for, and the only thing the three surfaces have to agree on.
 *
 * A terminal's label is the caller's, because a new tab is named for the panel it opens in; the
 * other two carry their own names in `panel-store.ts`.
 */

import { openFileTab, openGitTab } from '@/state/panel-store'
import { openBrowserForSession } from '@/state/browser-tabs'
import { openTerminalTab } from '@/state/terminal-tabs'

/** The tools a menu can open in the work panel. */
export type ToolTabKind = 'git' | 'terminal' | 'browser' | 'file'

/**
 * Open one tool for a conversation, and show the column on it.
 *
 * Whether the tool *may* be opened right now (its plugin is served, the conversation has been
 * written in) is the caller's business: it is decided where the rows are drawn
 * (`components/workspace/tool-menu-entries.ts`), so a row that is greyed and a shortcut that is
 * pressed answer the same question in the same place.
 */
export function openToolTab(
  sessionId: string,
  kind: ToolTabKind,
  terminalLabel: string,
): void {
  console.log(`[probe] openToolTab ${kind} -> ${sessionId}`)
  if (kind === 'git') openGitTab(sessionId)
  else if (kind === 'file') openFileTab(sessionId)
  else if (kind === 'browser') void openBrowserForSession(sessionId)
  else openTerminalTab(sessionId, terminalLabel)
}

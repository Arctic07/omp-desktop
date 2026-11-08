import type { LucideIcon } from "lucide-react";
import { Compass, File, GitBranch, Plug, SquareTerminal } from "lucide-react";

import type { PluginPages } from "@/state/plugin-pages";
import type { ToolTabKind } from "@/state/panel-tools";

/**
 * One row of the work panel's "new tab" menu.
 *
 * Two kinds of row, one shape: the three built-in tools (`action` names the tab they open) and the
 * pages an installed plugin contributes (`pageKey` names the page the work panel shows as a tab).
 * Keeping them in one list is what makes the "+" popover, the empty column's nav and the window's
 * 文件 menu offer the same entries — a plugin tab that appeared in one surface and not the others
 * would be a second copy of the menu, which is the thing this module exists to prevent.
 */
export interface ToolMenuEntry {
  /** Stable row identity: the action for a built-in, `plugin:<page key>` for a page. */
  id: string;
  label: string;
  shortcut: string[];
  icon: LucideIcon;
  /** The built-in tool this row opens, or null when it opens a plugin page. */
  action: ToolTabKind | null;
  /** The plugin page this row opens (`PluginPageRef.key`), or null for a built-in tool. */
  pageKey: string | null;
}

/** Which plugin-gated tools this build is currently serving. */
export interface ToolAvailability {
  terminal: boolean;
  browser: boolean;
}

/**
 * Whether one entry's tool is served right now.
 *
 * A missing tool is *left out* rather than drawn disabled: the reason it is gone is a plugin state
 * the reader can change in Settings, not a condition on this conversation, and a row that can never
 * succeed is noise. A plugin page is served exactly when it is in the list it came from.
 */
export function entryAvailable(action: ToolTabKind | null, availability: ToolAvailability): boolean {
  if (action === "terminal") return availability.terminal;
  if (action === "browser") return availability.browser;
  return true;
}

/**
 * The strip's three built-in entries — the one copy every surface renders.
 *
 * Three surfaces draw these words: the strip's own "+" popover, the empty-state nav the column
 * shows when it has no tab at all, and the window's 文件 menu. They differ in dress, never in
 * entries: a new built-in entry is added here and nowhere else. Plugin pages are appended by
 * {@link servedToolEntries}, from the list the plugin chain is serving.
 */
export const TOOL_MENU_ENTRIES: ToolMenuEntry[] = [
  { id: "git", label: "改动", shortcut: ["Ctrl", "Shift", "G"], icon: GitBranch, action: "git", pageKey: null },
  { id: "terminal", label: "终端", shortcut: ["Ctrl", "Shift", "Z"], icon: SquareTerminal, action: "terminal", pageKey: null },
  { id: "browser", label: "浏览器", shortcut: ["Ctrl", "Shift", "B"], icon: Compass, action: "browser", pageKey: null },
  { id: "file", label: "文件", shortcut: ["Shift", "Ctrl", "E"], icon: File, action: "file", pageKey: null },
];

/**
 * The entries this build serves right now, in the strip's own order: the built-in tools, then one
 * row per plugin page the reader can open as a tab.
 *
 * One rule, one place: a tool whose plugin is not served is left out — that is a setting, not a
 * condition on this conversation. Everything that *is* served is listed, including the two tools a
 * conversation cannot use yet: those are drawn disabled by {@link toolEntryLocked} rather than
 * hidden, because the reader unlocks them by sending a message and a row that vanished would never
 * say so (2026-10-26, user request: 新会话里「文件」「改动」是灰的).
 *
 * Which plugin pages: the `views[]` and `sidebarTabs[]` pages — both land in the work panel as a
 * tab, which is what this menu opens.
 */
export function servedToolEntries(
  availability: ToolAvailability,
  pages?: PluginPages,
): ToolMenuEntry[] {
  const entries = TOOL_MENU_ENTRIES.filter((entry) => entryAvailable(entry.action, availability));
  if (pages === undefined) return entries;
  const seen = new Set(entries.map((entry) => entry.id));
  for (const page of [...pages.sidebar, ...pages.views]) {
    const id = `plugin:${page.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      label: page.title,
      // A contributed page has no keystroke of its own; the row is the menu's own door.
      shortcut: [],
      // The tab strip draws the page's declared icon token; the menu keeps one shape, so every
      // contributed row wears the same plug (a row is a door, not the page's own header).
      icon: Plug,
      action: null,
      pageKey: page.key,
    });
  }
  return entries;
}

/**
 * Whether a served entry cannot be used in this conversation yet.
 *
 * The git review and the file panel read a conversation's transcript; one nothing has been sent
 * in has no file for them to read. The terminal and a plugin page write nothing into the
 * conversation, so they work from the first moment.
 */
export function toolEntryLocked(action: ToolTabKind | null, unwritten: boolean): boolean {
  return unwritten && (action === "git" || action === "file");
}

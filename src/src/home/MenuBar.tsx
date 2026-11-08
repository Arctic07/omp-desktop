"use client";
// The window's menu bar: 文件 / 视图 / 帮助, each a real menu.

import { Download, Info, RotateCw } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/motion/button";
import { MenuList, type MenuItem } from "@/components/motion/menu-list";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import {
  servedToolEntries,
  toolEntryLocked,
} from "@/components/workspace/tool-menu-entries";
import { COPY } from "@/home/homeCopy";
import { TERMINAL_COPY } from "@/home/terminal-copy";
import { NO_HOVER_GROWTH } from "@/lib/hover-motion";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { openPluginTab } from "@/state/panel-store";
import { openToolTab } from "@/state/panel-tools";
import { toolAvailability, usePluginPages } from "@/state/plugin-pages";
import { activeRecord, sessionStore, type SessionStoreState } from "@/state/session-store";
import { useStoreSelector } from "@/state/store";
import { checkForUpdates } from "@/state/update-store";
import { isUnwritten } from "@/state/transcript";

export interface MenuBarProps {
  /** Open the settings page on its About section. */
  onOpenAbout: () => void;
  /**
   * Leave the settings page for the conversation column.
   *
   * The 文件 menu's rows open a tab in the work panel, which the settings overlay covers: opening a
   * tool while that overlay is up would otherwise change something the reader cannot see. The shell
   * owns the view, so the row asks it to come back rather than the bar knowing about it.
   */
  onLeaveSettings: () => void;
  className?: string;
}

/**
 * The window's menu bar.
 *
 * Three menus, and each one does what its rows say:
 *
 * - **文件** is the work panel's "+" menu, opened from the window's frame instead of from the panel
 *   (`components/workspace/tool-menu-entries.ts` is the one list both draw). A row opens the tool
 *   for the conversation on screen and brings the column up — `state/panel-tools.ts::openToolTab`
 *   is the one call that does it. The two tools that read a transcript (改动 / 文件) are greyed in a
 *   conversation nothing has been sent in, because there is no file for them to read yet; a tool
 *   whose plugin this build does not serve is left out entirely.
 * - **视图** reloads the document. The engine's turns run in the host process, not in this page, so
 *   a reload re-attaches to whatever is running instead of interrupting it.
 * - **帮助** opens the settings page's About section, and 检查更新 asks the fixed release feed and
 *   takes the reader there: the answer — a newer version, the newest, a failure — is a sentence the
 *   About page draws, not a menu that closes before it can say anything. When a release is
 *   announced, the title bar's update pill appears beside this menu
 *   (`rules.md#release-versions-and-publishing`).
 *
 * No 编辑 menu: nothing on this screen has a document-level edit verb a menu could own
 * (2026-10-26, user request).
 */
export function MenuBar({ onOpenAbout, onLeaveSettings, className }: MenuBarProps) {
  const copy = useCopy(COPY);
  const terminalCopy = useCopy(TERMINAL_COPY);
  const pluginPages = usePluginPages();
  const availability = useMemo(() => toolAvailability(pluginPages), [pluginPages]);
  const sessionId = useStoreSelector(sessionStore, (state) => state.activeId);
  const unwritten = useStoreSelector(sessionStore, selectUnwritten);
  const [open, setOpen] = useState<MenuName | null>(null);

  const toolRows = useMemo<MenuItem[]>(() => {
    const entries = servedToolEntries(availability, pluginPages);
    return entries.map((entry) => {
      const locked = sessionId === null || toolEntryLocked(entry.action, unwritten);
      return {
        id: entry.id,
        label: entry.label,
        icon: entry.icon,
        shortcut: entry.shortcut,
        disabled: locked,
        hint: copy.menuLockedHint,
        onSelect: () => {
          setOpen(null);
          if (sessionId === null) return;
          // A plugin page opens the same tab the sidebar group and the "+" menu open; a built-in
          // tool goes through the one opener every surface shares.
          if (entry.action === null) {
            if (entry.pageKey !== null) openPluginTab(sessionId, entry.pageKey);
          } else {
            openToolTab(sessionId, entry.action, terminalCopy.title);
          }
          // The column this opened is behind the settings overlay when that is up; the reader asked
          // to see a tool, so the shell takes them to it.
          onLeaveSettings();
        },
      };
    });
  }, [
    availability,
    copy.menuLockedHint,
    onLeaveSettings,
    sessionId,
    terminalCopy.title,
    unwritten,
  ]);

  const viewRows: MenuItem[] = [
    { id: "reload", label: copy.menuReload, icon: RotateCw, onSelect: reloadDocument },
  ];

  const helpRows: MenuItem[] = [
    {
      id: "about",
      label: copy.menuAbout,
      icon: Info,
      onSelect: () => {
        setOpen(null);
        onOpenAbout();
      },
    },
    {
      id: "updates",
      label: copy.menuCheckUpdates,
      icon: Download,
      onSelect: () => {
        setOpen(null);
        void checkForUpdates();
        onOpenAbout();
      },
    },
  ];

  return (
    <nav aria-label={copy.menuLabel} className={cn("flex items-center", className)}>
      <Menu label={copy.menuFile} name="file" open={open} onOpenChange={setOpen} items={toolRows} />
      <Menu label={copy.menuView} name="view" open={open} onOpenChange={setOpen} items={viewRows} />
      <Menu label={copy.menuHelp} name="help" open={open} onOpenChange={setOpen} items={helpRows} />
    </nav>
  );
}

/** Which menu of the bar is down. One at a time: opening another closes the first. */
type MenuName = "file" | "view" | "help";

/**
 * One label of the bar, and the panel behind it.
 *
 * The panel is beUI's morph popover — the same surface the "+" menu opens — with nothing extra
 * asked of the caller.
 */
function Menu({
  label,
  name,
  open,
  onOpenChange,
  items,
}: {
  label: string;
  name: MenuName;
  open: MenuName | null;
  onOpenChange: (open: MenuName | null) => void;
  items: readonly MenuItem[];
}) {
  const shown = open === name;
  return (
    <MorphPopover open={shown} onOpenChange={(next) => onOpenChange(next ? name : null)}>
      <MorphPopoverTrigger>
        <Button
          {...NO_HOVER_GROWTH}
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 shrink-0 rounded-md px-2 text-sm leading-none font-normal text-titlebar-muted hover:text-titlebar-ink",
            shown && "bg-muted text-titlebar-ink",
          )}
        >
          {label}
        </Button>
      </MorphPopoverTrigger>
      <MorphPopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        radius={12}
        className="w-64 p-1.5"
      >
        <MenuList items={items} />
      </MorphPopoverContent>
    </MorphPopover>
  );
}

/** Whether the conversation on screen has nothing in it yet, for the 文件 menu's greyed rows. */
function selectUnwritten(state: SessionStoreState): boolean {
  const record = activeRecord(state);
  return record !== null && isUnwritten(record.engineEmpty, record.messages);
}

/**
 * Reload this document.
 *
 * Nothing is sent to the desktop first: the host holds the sessions and their turns, and a page that
 * reloads re-attaches to them (`session_open` on a live session answers its current state). That is
 * why a reload cannot interrupt a running conversation — the one thing it must not do.
 */
function reloadDocument(): void {
  window.location.reload();
}

/**
 * The work column's window shortcuts: `Ctrl Tab` walks the strip, and `Ctrl Shift G/E/B/Z` bring
 * the git / file / browser / terminal tab forward — jump-or-open, like the + menu's own entries.
 *
 * The listener is registered once and reads the latest `selectEntry` through a ref: rebinding it
 * every render would tear down and re-add a window listener on every keystroke in the app.
 */

import { useEffect, useRef } from "react";

import type { ToolMenuEntry } from "@/components/workspace/tool-menu-entries";
import { toolShortcutTarget } from "@/components/workspace/tool-shortcut";

export interface PanelShortcutsOptions {
  cycleTab: (step: number) => void;
  selectEntry: (entry: Pick<ToolMenuEntry, "action" | "pageKey">) => void;
}

export function usePanelShortcuts({
  cycleTab,
  selectEntry,
}: PanelShortcutsOptions): void {
  const selectEntryRef = useRef(selectEntry);
  useEffect(() => {
    selectEntryRef.current = selectEntry;
  }, [selectEntry]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      // `Ctrl Tab` walks the column's tabs. It is the one binding here that fires wherever the
      // reader is — a shell and a field included, which is what a tab walk is for — so it is
      // answered before the field guards below. The shell does not see the keystroke either
      // (`TerminalPanel` keeps xterm off it): a tab strip that types a tab into the shell on its
      // way past is not a shortcut.
      if (event.key === "Tab") {
        event.preventDefault();
        cycleTab(event.shiftKey ? -1 : 1);
        return;
      }
      // `Ctrl Shift G` / `Ctrl Shift E` / `Ctrl Shift B` / `Ctrl Shift Z` bring the git / file /
      // browser / terminal tab forward — jump-or-open, like the + menu's own entries. A field and a
      // shell keep E, B and Z: the shortcuts are not worth losing a typed E, B, or the shell's redo.
      const shortcutTarget = toolShortcutTarget(event);
      if (shortcutTarget === null) return;
      // `Ctrl Shift G` is the one chord that is not left to the focus: it types no letter and the
      // webview's own find dialog no longer owns a `G` accelerator (`services::webview_keys`), so
      // the changes column answers it over a field and a shell too, before either can swallow it.
      // `selectEntry` is what decides there is nothing to show (no conversation, or one with no
      // transcript yet): an unavailable column stays silent rather than opening something else.
      if (shortcutTarget === "git") {
        event.preventDefault();
        event.stopPropagation();
        selectEntryRef.current({ action: shortcutTarget, pageKey: null });
        return;
      }
      const shiftTarget = event.target instanceof Element ? event.target : null;
      if (shiftTarget?.closest(".xterm, input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      selectEntryRef.current({ action: shortcutTarget, pageKey: null });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cycleTab]);
}

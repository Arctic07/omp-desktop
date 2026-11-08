import { Minus, PanelLeftClose, PanelLeftOpen, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Button } from "@/components/motion/button";
import { Tooltip } from "@/components/motion/tooltip";
import { useCopy } from "@/lib/i18n";
import { NO_HOVER_GROWTH } from "@/lib/hover-motion";
import { cn } from "@/lib/utils";
import { COPY } from "@/home/homeCopy";
import { MenuBar } from "@/home/MenuBar";

export interface TitleBarProps {
  /** The sidebar's own state, for the toggle's icon and its pressed reading. */
  sidebarOpen?: boolean
  /**
   * The one control that changes the sidebar. Omitted where no sidebar is on screen — the settings
   * page covers it — so the frame never draws a toggle for something the reader cannot see, and the
   * key binding goes with it.
   */
  onToggleSidebar?: () => void
  /** 帮助 → 关于: the shell's settings page, opened on its About section. */
  onOpenAbout: () => void
  /** The 文件 menu's rows open a work-panel tab, so the shell leaves the settings overlay. */
  onLeaveSettings: () => void
  className?: string
}

/**
 * Windows' own restore glyph: the window at the bottom left, and behind it at the top right the
 * window it shrinks back to. lucide has no such icon — its `Copy` is the same two squares mirrored
 * and rounded — so it is drawn here on lucide's grid (24 units, 2-unit stroke, round joins) to carry
 * the weight of the `Square` it replaces while reading as two windows.
 *
 * The back square's outlines stop on the front square's edge: a stroke drawn through the front would
 * show inside a window that is supposed to cover it. It is drawn a size larger than the square so
 * both glyphs cover about the same pixels.
 */
function RestoreGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M7 8V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-4" />
      <rect x="3" y="8" width="13" height="13" rx="1.5" />
    </svg>
  );
}

/**
 * The window's own frame.
 *
 * The window is created without decorations (`src-tauri/tauri.conf.json`), so everything a
 * native title bar would draw is drawn here: the drag region, the sidebar's toggle, the menu bar and
 * the three window controls. The drag region is a data attribute rather than a listener — the
 * webview hands the press to the window manager, which is what keeps dragging smooth.
 *
 * Every control is beUI's `Button` in its ghost variant, which is where the hover fill comes from,
 * and the icon-only ones are wrapped in beUI's `Tooltip` so each says what it does before it is
 * pressed — the sidebar toggle advertises `Ctrl B`, and `Ctrl B` works. Its icon is the panel the
 * press would leave behind, not one icon for both states — as does the maximize control, which draws
 * `RestoreGlyph` once the window is maximized. The menu bar itself is `home/MenuBar.tsx`:
 * 文件 is the work panel's own tool list, 视图 reloads the document, and 帮助 opens the About page.
 */
export function TitleBar({
  sidebarOpen = false,
  onToggleSidebar,
  onOpenAbout,
  onLeaveSettings,
  className,
}: TitleBarProps) {
  const copy = useCopy(COPY);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const window = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void window.isMaximized().then(setMaximized);
    void window
      .onResized(() => {
        void window.isMaximized().then(setMaximized);
      })
      .then((stop) => {
        unlisten = stop;
      });
    return () => unlisten?.();
  }, []);

  // Ctrl+B is the key the toggle's own label advertises, so it has to work — and only while the
  // toggle is on screen: a key that moved a sidebar the reader cannot see would be a surprise.
  useEffect(() => {
    if (onToggleSidebar === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      onToggleSidebar();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onToggleSidebar]);

  const run = (action: () => Promise<void>) => () => {
    void action().catch(() => {
      // A window control that the desktop refuses leaves the window as it is; there is nothing to
      // report and nothing the user could do about it.
    });
  };

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex h-11 shrink-0 select-none items-center gap-1 border-border border-b bg-window-frame pr-0 pl-3 text-sm text-titlebar-muted",
        className,
      )}
    >
      <span data-tauri-drag-region className="flex items-center gap-2">
        <img src="/favicon.svg" alt="" className="size-4" />
        <span data-tauri-drag-region className="font-medium text-foreground">
          {copy.appName}
        </span>
      </span>

      {onToggleSidebar === undefined ? null : (
        <Tooltip content={sidebarOpen ? copy.collapseSidebarHint : copy.expandSidebarHint}>
          <Button
            {...NO_HOVER_GROWTH}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={copy.toggleSidebar}
            aria-pressed={sidebarOpen}
            onClick={onToggleSidebar}
            className="ml-1 h-7 w-7 shrink-0 rounded-md text-titlebar-muted hover:text-titlebar-ink"
          >
            {sidebarOpen ? (
              <PanelLeftClose className="size-3.5" />
            ) : (
              <PanelLeftOpen className="size-3.5" />
            )}
          </Button>
        </Tooltip>
      )}

      <MenuBar
        onOpenAbout={onOpenAbout}
        onLeaveSettings={onLeaveSettings}
        className="ml-1"
      />

      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />

      <div className="flex h-full shrink-0 items-stretch">
        <Tooltip content={copy.windowMinimize}>
          <Button
            {...NO_HOVER_GROWTH}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={copy.windowMinimize}
            onClick={run(() => getCurrentWindow().minimize())}
            className="h-full w-11 shrink-0 rounded-none text-titlebar-muted hover:text-titlebar-ink"
          >
            <Minus className="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content={maximized ? copy.windowRestore : copy.windowMaximize}>
          <Button
            {...NO_HOVER_GROWTH}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={maximized ? copy.windowRestore : copy.windowMaximize}
            onClick={run(() => getCurrentWindow().toggleMaximize())}
            className="h-full w-11 shrink-0 rounded-none text-titlebar-muted hover:text-titlebar-ink"
          >
            {maximized ? (
              <RestoreGlyph className="size-3.5" />
            ) : (
              <Square className="size-3" />
            )}
          </Button>
        </Tooltip>
        <Tooltip content={copy.windowClose}>
          <Button
            {...NO_HOVER_GROWTH}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={copy.windowClose}
            onClick={run(() => getCurrentWindow().close())}
            className="h-full w-11 shrink-0 rounded-none text-titlebar-muted hover:bg-destructive hover:text-titlebar-ink"
          >
            <X className="size-3.5" />
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}

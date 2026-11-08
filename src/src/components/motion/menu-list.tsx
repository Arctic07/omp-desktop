"use client";
// One list of menu rows, wherever a menu is drawn.

import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * One row of a menu.
 *
 * `shortcut` is drawn only when the key actually does what the row says — the + menu's four tools
 * have window listeners behind their labels, and a menu that advertised a key nothing answers
 * would be a lie the reader only finds out by pressing it.
 */
export interface MenuItem {
  /** Stable identity for the list; the action's own name. */
  id: string;
  label: string;
  icon?: LucideIcon;
  shortcut?: readonly string[];
  /**
   * The row is shown and cannot be chosen.
   *
   * A condition on *this* conversation (nothing has been said in it yet) is stated by greying the
   * row: the tool exists and the reader can make it work by sending a message. A tool this build
   * does not serve at all is left out of the list instead — the reason for that one is a setting,
   * and a row that can never succeed is noise.
   */
  disabled?: boolean;
  /** Why the row is greyed, as the row's own title. Ignored on rows that can be chosen. */
  hint?: string;
  /** Omitted for a row that only states something (a reserved entry). */
  onSelect?: () => void;
}

/**
 * A menu's rows: icon, label, and the keys that do the same thing.
 *
 * Two surfaces draw these — the work panel's "+" popover and the window's menu bar — and they must
 * read as the same menu, because the 文件 menu *is* the "+" menu opened from another place. What
 * differs between them is the surface around the list, never a row.
 */
export function MenuList({
  items,
  className,
}: {
  items: readonly MenuItem[];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled === true}
            title={item.disabled === true ? item.hint : undefined}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect()
              console.log(
                `[probe] menu row ${item.label} box.top=${box.top.toFixed(0)} box.left=${box.left.toFixed(0)} box.h=${box.height.toFixed(0)} click=(${event.clientX},${event.clientY}) under=${document.elementFromPoint(event.clientX, event.clientY)?.closest('button')?.textContent ?? 'none'}`,
              )
              item.onSelect?.()
            }}
            className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
          >
            {Icon === undefined ? null : (
              <Icon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.shortcut === undefined ? null : (
              <span className="flex shrink-0 items-center gap-1">
                {item.shortcut.map((key) => (
                  <kbd
                    key={key}
                    className="rounded-md border border-border/80 bg-background px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground"
                  >
                    {key}
                  </kbd>
                ))}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

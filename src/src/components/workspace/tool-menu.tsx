import { MenuList, type MenuItem } from "@/components/motion/menu-list";
import {
  toolEntryLocked,
  type ToolMenuEntry,
} from "@/components/workspace/tool-menu-entries";
import { COPY } from "@/home/homeCopy";
import { useCopy } from "@/lib/i18n";

/**
 * The "+" menu's entries, as one list.
 *
 * The rows are the shared menu list's (`components/motion/menu-list.tsx`), which is also what the
 * window's 文件 menu draws — the two are the same tools, and a row may not read differently in one
 * of them. The caller decides which entries exist (a plugin-gated tool that is not served is left
 * out); `unwritten` greys the two that need a transcript instead of hiding them.
 */
export function ToolMenuList({
  entries,
  unwritten,
  onSelect,
}: {
  entries: readonly ToolMenuEntry[];
  /** Whether the conversation on screen has nothing in it yet. */
  unwritten: boolean;
  onSelect: (entry: ToolMenuEntry) => void;
}) {
  const copy = useCopy(COPY);
  const items: MenuItem[] = entries.map((entry) => {
    const disabled = toolEntryLocked(entry.action, unwritten);
    return {
      id: entry.id,
      label: entry.label,
      icon: entry.icon,
      shortcut: entry.shortcut,
      disabled,
      hint: copy.menuLockedHint,
      onSelect: () => onSelect(entry),
    };
  });
  return <MenuList items={items} />;
}

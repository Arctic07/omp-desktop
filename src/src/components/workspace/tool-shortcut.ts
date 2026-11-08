import type { ToolTabKind } from "@/state/panel-tools";

/** The part of a keydown this module reads; a real `KeyboardEvent` satisfies it. */
export interface ToolShortcutKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The tool tab each `Ctrl/Cmd Shift <letter>` chord names.
 *
 * The letters are the ones `TOOL_MENU_ENTRIES` prints beside the rows, and
 * `tool-shortcut.test.ts` holds the two in step: a chord the menu advertises opens its tab, and a
 * chord nothing advertises opens nothing.
 */
const TOOL_SHIFT_CHORDS: Record<string, ToolTabKind> = {
  g: "git",
  z: "terminal",
  b: "browser",
  e: "file",
};

/**
 * The tool tab a chord names, or null when the key belongs to the surface that has focus.
 *
 * One mapping answers both the window listener and the menu's promise, so the only thing between
 * them is the advertised list, and a mismatch is a failing test rather than a label that lies.
 */
export function toolShortcutTarget(event: ToolShortcutKey): ToolTabKind | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || !event.shiftKey) return null;
  return TOOL_SHIFT_CHORDS[event.key.toLowerCase()] ?? null;
}

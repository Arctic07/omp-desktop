/**
 * The commands the composer offers, and the draft that asks for one.
 *
 * The engine owns every command a session can run, and advertises them
 * (`available_commands_update`, projected into the session's `commands` snapshot): builtins, the
 * `/skill:<name>` commands of every enabled skill, extensions, custom commands, file commands and
 * MCP prompts. This module reads that advertisement and answers the two questions the field has:
 * "is this draft asking for a command?" and "which command should be showing?".
 *
 * The one addition is a navigation command the engine ships only for its terminal: `/new`. Its
 * body in the terminal is "start a new conversation and switch to it", which is this application's
 * own workspace navigation rather than engine work, so the composer carries it (`DESKTOP_UI_COMMANDS`)
 * and the conversation column performs it instead of sending the text to the engine.
 *
 * A command is the first word of a prompt, so that is where the list lives. Once the reader writes
 * a space the word after the slash is an argument, and the engine runs the command with it — a
 * list drawn over that sentence would hide the text it is about.
 */

// Types are erased; the one runtime import is relative with its extension, because this module is
// read by the test runner as well as by the bundler and the runner has no alias to resolve.
import type { EngineCommand } from "../api/session-types.ts";

/**
 * Commands the desktop owns because the engine only implements them for its terminal.
 *
 * A command here must have a handler on this side; listing one without a handler would offer a
 * command that can only be sent to the model as prose. `/new` is handled by the conversation
 * column (`home/ConversationComposer.tsx`), which opens the workspace's blank conversation and
 * switches to it — the terminal command's own effect.
 */
export const DESKTOP_UI_COMMANDS: readonly EngineCommand[] = [
  {
    name: "new",
    description: "Start a new conversation in this workspace",
    aliases: [],
    inputHint: "",
    subcommands: [],
    source: "desktop",
  },
];

/**
 * The engine's advertisement with the desktop's navigation commands added.
 *
 * A name is one command, and the desktop's handler decides what it does, so an engine entry with
 * the same name is replaced rather than drawn twice. The additions sit after the engine's builtins
 * so the palette keeps the engine's grouping.
 */
export function withDesktopUiCommands(
  commands: readonly EngineCommand[],
): EngineCommand[] {
  const engine = commands.filter(
    (command) => !DESKTOP_UI_COMMANDS.some((desktop) => desktop.name === command.name),
  );
  const afterBuiltins = engine.findLastIndex((command) => command.source === "builtin") + 1;
  return [...engine.slice(0, afterBuiltins), ...DESKTOP_UI_COMMANDS, ...engine.slice(afterBuiltins)];
}

/**
 * What the draft is asking for, or null.
 *
 * Empty means the box is not writing a command: `/` must be the very first character (the engine
 * expands a command at the start of a prompt only), and a whitespace after it means the name is
 * finished and arguments have begun.
 */
export function commandQuery(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  const body = draft.slice(1);
  if (/\s/.test(body)) return null;
  return body.toLowerCase();
}

/**
 * The commands worth showing for a query, best first.
 *
 * An empty query is "everything, in the engine's own order" — it has already put builtins before
 * the capabilities they belong to, and re-sorting it would be this side claiming to know the
 * engine's catalog better than the engine. A typed query ranks an exact name, then a name that
 * begins with it, then an alias, then any other mention, so `/sk` finds `/skill:` commands before
 * it finds some builtin whose description happens to say "skill". Ties keep the engine's order, so
 * the same query always lists the same commands in the same places.
 */
export function matchCommands(
  commands: readonly EngineCommand[],
  query: string,
): EngineCommand[] {
  if (query.length === 0) return [...commands];
  const ranked: Array<{ command: EngineCommand; rank: number; order: number }> = [];
  commands.forEach((command, order) => {
    const rank = commandRank(command, query);
    if (rank !== Number.POSITIVE_INFINITY) ranked.push({ command, rank, order });
  });
  ranked.sort((left, right) => left.rank - right.rank || left.order - right.order);
  return ranked.map(({ command }) => command);
}

/** How well one command answers a query; larger is worse, infinity is "not at all". */
function commandRank(command: EngineCommand, query: string): number {
  const name = command.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  const aliases = command.aliases.map((alias) => alias.toLowerCase());
  if (aliases.some((alias) => alias.startsWith(query))) return 2;
  if (name.includes(query)) return 3;
  if (aliases.some((alias) => alias.includes(query))) return 4;
  if (command.description.toLowerCase().includes(query)) return 5;
  return Number.POSITIVE_INFINITY;
}

/**
 * The draft a chosen command leaves in the field.
 *
 * The engine runs a slash command from the start of the prompt, so picking one replaces what asked
 * for it. The trailing space is the field's own courtesy: the next key is an argument, not the
 * rest of the name, and the reader would otherwise have to type the separator the menu already
 * knows is coming.
 */
export function commandDraft(name: string): string {
  return `/${name} `;
}

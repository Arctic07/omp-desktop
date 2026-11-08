/**
 * The thinking ladder, weakest first.
 *
 * `off` is the floor: a control that opens on the staircase puts "no thinking" below every other
 * stop. `auto` is the first stop above it — still the engine's own choice, but a choice that may
 * think at all. The engine reports its levels in its own order (`auto`, `inherit`, `off`, …); the
 * ladder here is the order the control draws them in, so never read the reported order as this one.
 */
export const THINKING_LEVELS = [
  "off",
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * The stops a control may offer: the reported levels, deduplicated and put on the ladder's order.
 *
 * Two empty answers, two meanings, and they must not be the same one:
 *
 * - `undefined` is "nothing reported yet", and the full ladder stands in.
 * - `[]` is the report: the model has no reasoning surface at all (the host answers empty for a
 *   non-reasoning model). That is no control, not a two-stop one — padding `off`/`auto` onto it
 *   drew a strength control on a model that cannot think, and an `off` the user had to read as if
 *   it were a choice (2026-10-29, user report).
 *
 * `inherit` is the engine's spelling of `auto`, so it folds onto that stop instead of becoming a
 * second stop that does nothing different. Levels this app does not know keep their reported order
 * after the known ones, so an engine that grows a stop is still reachable rather than silently gone.
 */
export function thinkingLadder(levels: readonly string[] | undefined): readonly string[] {
  if (levels === undefined) return THINKING_LEVELS;
  if (levels.length === 0) return [];
  const wanted = new Set(levels.map((level) => (level === "inherit" ? "auto" : level)));
  // The slider always reserves its first two stops for the shared controls: off, then auto.
  // Model-specific levels follow them in the canonical order.
  wanted.add("off");
  wanted.add("auto");
  const known = THINKING_LEVELS.filter((level) => wanted.has(level));
  const unknown = [...wanted].filter(
    (level) => !(THINKING_LEVELS as readonly string[]).includes(level),
  );
  return [...known, ...unknown];
}

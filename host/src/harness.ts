/**
 * Fixtures the host's tests share.
 *
 * `bun test` parallelizes files and the seam check keeps the engine out of test modules, so a rule
 * the engine owns and a test must restate lives here once rather than in a second `*.test.ts`
 * (`rules.md#a-spec-that-passes-only-when-run-alone-is-a-defect-in-the-spec`).
 */

/**
 * The engine's `parsePluginId` (`marketplace/types.ts`): split at the last `@`, reject an empty
 * segment on either side. The production callers pass `sdk.parsePluginId` itself.
 */
export function parsePluginId(
  id: string,
): { name: string; marketplace: string } | null {
  const at = id.lastIndexOf('@')
  if (at <= 0 || at === id.length - 1) return null
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) }
}

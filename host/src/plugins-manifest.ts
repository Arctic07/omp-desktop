/**
 * A plugin directory's manifest: its `package.json`, and the manifest/file primitives every
 * reader of that directory needs.
 *
 * The engine's own manifest rule is modelled here rather than re-invented: a plugin's manifest is
 * `omp`, else the legacy `pi`, else nothing this host can read - and a manifest it cannot read
 * is a *reason* on the row (`package.json could not be read`, `package.json is not valid JSON`),
 * never an error that stops a list, because the engine loaded the plugin from its own copy.
 *
 * The entry-list readers are deliberately different, because the engine's own reading is:
 * `manifestList` is a spec list field (a non-list is not a list at all) and `manifestText` is a
 * single-string field; the entry-point reader that wraps a single string
 * (`resolvePluginManifestEntries`), `manifestEntries`, lives with the code facts it feeds
 * (`plugins-facts.ts`). The file and directory probes are the same kind of fact: "is there a
 * `hooks/` directory" is answered about the tree, never guessed from the manifest.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { logLine } from './log.ts'

/** True when `value` is a JSON object rather than an array or a scalar. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A string member of a manifest block, or `null` when it is absent or not a usable string. */
export function manifestText(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The string members of a manifest list; anything else in the list is ignored, not guessed at. */
export function manifestList(source: Record<string, unknown>, key: string): string[] {
  const value = source[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/**
 * True when `target` is a directory; a missing or unreadable path is not one.
 *
 * The plugin tree is read for its shape, not opened: a manifest that declares a `hooks/` directory
 * which is not there is a fact the row reports, never an error that stops the list.
 */
export function pathIsDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** True when `target` is a file; a missing or unreadable path is not one. */
export function pathIsFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

/** The plugin directory's real path, so the facts describe the package rather than a link to it. */
export function realRoot(target: string): string {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return target
  }
}

/** A plugin's `package.json`, plus why the row has none when it could not be used (spec §3.3). */
interface ManifestRead {
  readonly pkg: Record<string, unknown> | null
  /** A redacted sentence for the row's `desktopError`; `null` when the file was read and parsed. */
  readonly error: string | null
}

/**
 * The plugin's `package.json`, parsed; a null package carries the reason.
 *
 * A plugin whose manifest is unreadable is still listed - the engine loaded it from its own copy -
 * so the failure is reported as missing facts (a null description, a null desktop block) and the
 * reason travels with the row: the page has to tell a plugin that declares no desktop block (an
 * engine-only plugin, the ordinary case) from one whose manifest is broken. The reason is a fixed
 * sentence, never the parser's own text, so nothing a file contains reaches the caller; the detail
 * goes to the host log, which is redacted at the sink (`sanitizeMessage`).
 */
export function readPackageJson(root: string): ManifestRead {
  const file = path.join(root, 'package.json')
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    logLine(`plugin manifest ${file} could not be read: ${error instanceof Error ? error.message : String(error)}`)
    return { pkg: null, error: 'package.json could not be read' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    logLine(`plugin manifest ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return { pkg: null, error: 'package.json is not valid JSON' }
  }
  if (!isRecord(parsed)) {
    logLine(`plugin manifest ${file} is not a JSON object`)
    return { pkg: null, error: 'package.json is not a JSON object' }
  }
  return { pkg: parsed, error: null }
}

/** The engine's manifest rule: `omp`, else the legacy `pi`, else nothing this host can read. */
export function manifestOf(pkg: Record<string, unknown> | null): Record<string, unknown> {
  if (pkg === null) return {}
  if (isRecord(pkg.omp)) return pkg.omp
  if (isRecord(pkg.pi)) return pkg.pi
  return {}
}

/**
 * True when the package carries a manifest block this host cannot read as an object.
 *
 * The engine selects its block with `omp || pi` (`extensibility/plugins/loader.ts:189`), so a
 * *truthy* value that is not an object - `"omp": "…"`, `"omp": 1` - is the manifest the engine
 * loads, while {@link manifestOf} can only answer `{}` for it. That is the gap this predicate
 * exists for: the row has to fail closed rather than report "no code" for a manifest it cannot
 * enumerate (spec §15.1-4). A block that is absent, empty or `null` is *not* this case - the engine
 * has no manifest either, which is the ordinary engine-only plugin.
 */
export function manifestBlockUnreadable(pkg: Record<string, unknown> | null): boolean {
  if (pkg === null) return true
  const block = pkg.omp || pkg.pi
  return block !== undefined && block !== null && !isRecord(block)
}

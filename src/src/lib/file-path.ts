/**
 * The few path operations this front end needs, and no others.
 *
 * Workspace-relative paths use `/` on every platform (the desktop's listings and searches answer
 * that way). Absolute paths are only ever composed for a drop payload or read back from one, so the
 * separator is decided by the root the reader's machine gave us rather than by `navigator.platform`.
 */

/** The same path with `\` folded to `/`; display and comparison only. */
export function normaliseFilePath(path: string): string {
  return path.replaceAll('\\', '/')
}

/**
 * Whether two absolute paths name the same file.
 *
 * The desktop answers with the canonical path it validated while the engine reports the one it was
 * given, and on Windows the two spell the same file differently (`D:\a\b` and `D:/a/b`, and either
 * case). Identity is what the comparisons are for - which conversation a terminal or a page belongs
 * to - so separator and case are folded, nothing else.
 */
export function sameFilePath(left: string, right: string): boolean {
  return normaliseFilePath(left).toLowerCase() === normaliseFilePath(right).toLowerCase()
}

/** The leaf of a relative or absolute path. */
export function fileLeafName(path: string): string {
  const normalised = normaliseFilePath(path)
  const cut = normalised.lastIndexOf('/')
  return cut < 0 ? normalised : normalised.slice(cut + 1)
}

/**
 * A path's stem: its leaf with the last extension dropped.
 *
 * The engine names each subagent's transcript after the subagent (`<childId>.jsonl`), so a child's
 * id is read back off the file it was written in — which is the one fact a caller has to match a
 * live roster row against the file `session_children` answered with.
 */
export function fileStemName(path: string): string {
  const leaf = fileLeafName(path)
  const cut = leaf.lastIndexOf('.')
  return cut <= 0 ? leaf : leaf.slice(0, cut)
}

/** The directory above a path, or null for a bare name / a drive root. */
export function fileParentPath(path: string): string | null {
  const normalised = normaliseFilePath(path)
  const cut = normalised.lastIndexOf('/')
  return cut <= 0 ? null : normalised.slice(0, cut)
}

/** One workspace-relative name under a directory; the root is `.`. */
export function joinRelativePath(parent: string, name: string): string {
  return parent === '.' || parent === '' ? name : `${parent}/${name}`
}

/**
 * The absolute path behind a workspace-relative path, for a drag payload and the desktop's own
 * re-validation on the other side of the drop.
 */
export function absolutePathOf(root: string, relative: string): string {
  const separator = root.includes('\\') || /^[A-Za-z]:/.test(root) ? '\\' : '/'
  const trimmed = root.replace(/[\\/]+$/, '')
  return `${trimmed}${separator}${relative.replaceAll('/', separator)}`
}

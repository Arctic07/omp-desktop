/**
 * The file paths a transcript may hand the reader, and where they sit.
 *
 * An answer prints a file as inline code (`C:\project\静夜思.txt`, `src/App.tsx`), and the reader
 * expects to open it the way the file panel opens one. Two questions have to be answered before
 * that click can be routed:
 *
 * ① **Is this text a path at all?** Inline code also holds identifiers, commands and snippets, so
 * the test is conservative: an absolute path under either platform's spelling, or a relative one
 * that carries a separator and a file extension. A bare word is never a path — `console.log` would
 * otherwise be a click that opens nothing.
 * ② **Is it inside a workspace?** The desktop reads a workspace file through its root and an
 * outside file through `read_external_file`, and the root is what decides which of the two a click
 * uses. The comparison is by normalised, case-folded spelling, exactly like `sameFilePath`.
 *
 * Nothing here touches the filesystem: whether the file exists is the read's answer, not this
 * module's. A path that fails to open draws its error in the viewer it asked for, which is the same
 * surface the file panel uses for a file it cannot read.
 */

import { normaliseFilePath } from './file-path.ts'

/** The longest text this desktop treats as a path; `services/workspace.rs` refuses longer ones. */
const PATH_LIMIT = 4096

/** A Windows drive path: `C:\project\a.txt`, `D:/work/a.md`. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/

/** A UNC path: `\\server\share\a.txt`. */
const UNC_ABSOLUTE = /^\\\\[^\\/]/

/** A trailing `:line`, `:line:column` or `:line-line` reference, as agents print one. */
const LINE_SUFFIX = /:\d{1,7}(?:[:-]\d{1,7})?$/

/** Whether `path` is spelled as an absolute path on either platform this app runs on. */
export function isAbsoluteFilePath(path: string): boolean {
  if (WINDOWS_ABSOLUTE.test(path) || UNC_ABSOLUTE.test(path)) return true
  return path.startsWith('/') && path.length > 1 && !path.startsWith('//')
}

/**
 * The file path one inline-code span names, or null when it names something else.
 *
 * The answer is the text with a trailing line reference dropped, so `src/a.ts:12` opens `src/a.ts`.
 * E.g. `C:\project\新建 文本文档.txt`, `/home/me/notes.md`, `src/src/App.tsx`.
 */
export function filePathInText(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > PATH_LIMIT) return null
  if (/[\0\r\n\t]/.test(trimmed)) return null
  // An address is `lib/links.ts`'s, not a file's, however much it looks like one.
  if (trimmed.includes('://')) return null
  // `C:\work\a.ts:12` opens the file at line 12; the reference is not part of its name.
  const path = trimmed.replace(LINE_SUFFIX, '')
  if (isAbsoluteFilePath(path)) return path
  // A relative path needs a separator and a leaf extension; `src/` and `1/2` are not files.
  if (/[*?"<>|]/.test(path)) return null
  if (!/[\\/]/.test(path) || path.endsWith('\\') || path.endsWith('/')) return null
  // `..` is the root's to refuse (`services/workspace.rs`), not a click's to follow out of it.
  if (path.split(/[\\/]/).includes('..')) return null
  return /\.[A-Za-z0-9]{1,10}$/.test(path) ? path : null
}

/**
 * The path's spelling relative to one workspace root, or null when it lies outside it.
 *
 * `.` and `..` segments make the answer null rather than resolved: the desktop canonicalizes every
 * path it reads, and a click that walks out of the root is not a workspace file.
 */
export function relativePathInsideRoot(root: string, path: string): string | null {
  const normalRoot = normaliseFilePath(root).replace(/\/+$/, '')
  const normalPath = normaliseFilePath(path)
  const prefix = `${normalRoot.toLowerCase()}/`
  if (normalRoot === '' || !normalPath.toLowerCase().startsWith(prefix)) return null
  const relative = normalPath.slice(normalRoot.length + 1)
  if (relative === '') return null
  if (relative.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null
  }
  return relative
}

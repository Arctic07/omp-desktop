/**
 * A markdown fence's tag, read into what the code block needs to draw it.
 *
 * A conversation writes fences on a model's word, and a model's word is any spelling: `js`,
 * `JavaScript`, `ts`, `shell`, `py`, `json`, `text`, or something this app has never heard of. The
 * renderer therefore answers every tag rather than forking over the ones it likes — a fence is a
 * code block in the reader's eye whatever it names, and drawing it as bare `<pre>` text (no header,
 * no line numbers, no copy control) is a second look for the same kind of content.
 *
 * The grammar comes from `code-language.ts`, this build's curated table: its canonical ids and the
 * aliases a model actually writes both name a grammar the worker can load on demand, so `js` and
 * `javascript` alike tokenize. A tag outside that table — `mermaid`, `text`, the empty tag of a
 * fence opened with nothing after the backticks, or a grammar this build does not ship — keeps the
 * fence as plain text inside the same block, and the header still states what the model called it.
 */

import { resolveCodeLanguage } from './code-language.ts'
import type { AgentCodeLanguage } from './code-language.ts'

export interface FenceLanguage {
  /** The grammar to tokenize with; `text` when the tag names no shipped grammar. */
  language: AgentCodeLanguage
  /** The tag as the model wrote it, which is what the header's own label shows (`'js'`). An empty
   *  tag is a fence with no label, and the header draws none. */
  label: string
}

export function resolveFenceLanguage(tag: string): FenceLanguage {
  const label = tag.trim()
  return {
    language: resolveCodeLanguage(label) ?? 'text',
    label,
  }
}

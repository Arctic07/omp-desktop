/**
 * How a file is written when a copy has to carry it as text.
 *
 * The line is the host's own mention format (`src-tauri/src/services/attachment_mentions.rs`):
 * `@<path>`, quoted when the path holds a space. Writing the same shape here is what makes a copied
 * message readable by anything that understands the conversation's file vocabulary — the engine,
 * the transcript reader, and this app's own Markdown copy — instead of naming a file in a form only
 * this surface could read back.
 */

/** One path as the mention line that names it. */
export function fileMentionLine(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`
}

/**
 * A copy's text: what the reader selected, then the files that went with it.
 *
 * The files are appended rather than inserted at their chips because a selection is a contiguous
 * run of characters — the chip a reader selected is already named (visibly) in it, and the lines
 * below are the addresses behind those names. Duplicates collapse, so a message that carries the
 * same file twice does not write its path twice.
 */
export function textWithFileMentions(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text
  const lines = [...new Set(paths)].map(fileMentionLine).join("\n")
  const written = text.trimEnd()
  return written.length === 0 ? lines : `${written}\n\n${lines}`
}

/**
 * Whether a clipboard's text is, byte for byte, the copy this page wrote.
 *
 * A copy this application wrote is the only clipboard whose words and files it already knows, and
 * knowing them is what makes the paste exact: the words as they were, one chip per path, no second
 * trip through the desktop to guess a name back to a file. Line ends are the one difference the
 * platform may introduce on the way through `CF_UNICODETEXT`, and they are not part of the copy.
 */
export function isWrittenCopy(text: string, written: string): boolean {
  return text.replace(/\r\n/g, "\n") === written.replace(/\r\n/g, "\n")
}

/** What this page knows about the copy it wrote: the words it stood for and the files it named. */
export interface WrittenFileCopy {
  words: string
  paths: readonly string[]
}

/**
 * A prompt's own text with the files it carries: the words, then one mention line per file.
 *
 * This is the shape the desktop's prompt path writes when it appends an attachment's mention line
 * (`src-tauri/src/services/runtime/session.rs::build_prompt`), and the block is separated from the
 * words by a single line break — not the blank line a copy puts before its addresses
 * (`textWithFileMentions`). The transcript reads a sent prompt back into words and files by taking
 * the mention lines *directly* behind the text (`attachment_mentions.rs::read_prompt`), so an empty
 * line between them would leave the files behind and the message would come back as prose.
 *
 * A dialog's answer carries its files this way: a dialog returns one string, and the engine reads
 * `@<path>` out of a prompt itself, so the mention lines are both the address the agent reads the
 * file from and the record the transcript draws the chip from.
 */
export function promptTextWithFiles(text: string, paths: readonly string[]): string {
  const lines = [...new Set(paths)].map(fileMentionLine).join("\n")
  if (lines.length === 0) return text
  const written = text.trimEnd()
  return written.length === 0 ? lines : `${written}\n${lines}`
}

/**
 * The same copy, without the mention lines its files no longer need.
 *
 * A copy that is pasted back into a composer which also takes the files as attachments would
 * otherwise name every one of them twice: once as the mention line the copy appended, and once as
 * the chip the paste imported — and the engine appends its own mention line for every attachment,
 * so the prompt would carry the same path twice more. The copy's own block is the last one and is
 * separated by a blank line (`textWithFileMentions` above), so it is dropped when every line in it
 * names one of the files this same paste is attaching.
 *
 * Names are compared as leaf names because that is all a clipboard file list tells the page; a
 * block with anything else in it — the reader's own words, a mention of a file this paste does not
 * carry — is left exactly as it was.
 */
export function textWithoutFileMentions(text: string, names: readonly string[]): string {
  const wanted = new Set(
    names.map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0),
  )
  if (wanted.size === 0) return text
  const cut = text.lastIndexOf("\n\n")
  const head = cut < 0 ? "" : text.slice(0, cut)
  const tail = cut < 0 ? text : text.slice(cut + 2)
  const mentionsOnly = tail
    .split("\n")
    .every((line) => {
      const named = mentionPath(line)
      if (named === null) return false
      // The path and the leaf name are both answers a clipboard gives for the same file: a file
      // list reports the leaf, while a file the page could not path still carries its name.
      const whole = named.trim().toLowerCase()
      const leaf = (named.trim().split(/[\\/]/).pop() ?? "").toLowerCase()
      return wanted.has(leaf) || wanted.has(whole)
    })
  return mentionsOnly ? head.trimEnd() : text
}

/** The path one mention line names, or null when the line is not one. */
function mentionPath(line: string): string | null {
  const trimmed = line.trim()
  if (trimmed.startsWith('@"')) {
    const end = trimmed.indexOf('"', 2)
    return end < 0 ? null : trimmed.slice(2, end)
  }
  if (!trimmed.startsWith("@")) return null
  const path = trimmed.slice(1).trim()
  return path.length === 0 ? null : path
}

/**
 * Whether a copy's text names the files that came with it.
 *
 * A copy this application wrote always ends with the block `textWithFileMentions` appends, so the
 * clipboard carries its own provenance: the words, then the addresses of the files beside them.
 * That is the one thing that tells such a paste apart from a sentence copied out of a browser, which
 * is also words plus a picture and must not import the picture
 * (`state/composer-draft.ts::planClipboardPaste`).
 */
export function carriesOwnFileMentions(text: string, names: readonly string[]): boolean {
  return text.trim().length > 0 && textWithoutFileMentions(text, names) !== text
}

/**
 * The files a composer draft is holding.
 *
 * A prompt carries its attachments beside its text, not inside it: `session_prompt` takes
 * `attachments` as its own array, and the engine reads each one from the path it names. That is also
 * why nothing is copied here — the desktop re-checks every path and hands back a record that points
 * at the file where it lives, so a tool the agent runs against it edits the reader's own file rather
 * than a copy (`src-tauri/src/services/attachments.rs::import_composer_files`).
 *
 * What the reader *sees* is one flow: the draft string names each file by a token
 * (`state/composer-draft.ts`), so a chip sits in the sentence it was dropped into and can be
 * backspaced out of it. This module is the other half of that pairing — the records the tokens stand
 * for — and it is the only place that talks to the desktop about them.
 *
 * The records live in the draft that names them, not in a list of their own
 * (`state/composer-draft-store.ts`): every function here takes the seat of the draft it works on, so
 * a file is imported for the conversation the reader imported it in, and switching conversations
 * shows each one's own files with its own words. The files and the characters that stand for them
 * are written together, which is what keeps a draft from coming back as text whose chips have no
 * records behind them.
 *
 * An engine dialog's answer is the second surface that holds files (`home/DialogAnswerField.tsx`),
 * and it has no draft to write them into. So the import itself is here twice over: `importAttachmentPaths`
 * and `importClipboardFiles` ask the desktop and answer with its records without holding anything,
 * and the draft-bound `addAttachmentPaths` / `addClipboardFiles` are those two plus `hold`. A dialog
 * keeps the records in its own state and writes their mention lines into the answer it submits.
 */

import { importComposerFiles, resolveClipboardFilePaths, saveComposerPaste, type ImportedComposerFile } from '@/api/agent'
import { toApiError, type ApiError } from '@/api/client'
import {
  readComposerDraft,
  setComposerDraftAttachments,
} from '@/state/composer-draft-store'
import {
  createChipToken,
  draftAttachments,
  pastedFileName,
  pastedMimeType,
  type ComposerAttachment,
} from '@/state/composer-draft'

/** How many files one prompt may carry; the desktop's own import path is the outer bound. */
export const MAX_COMPOSER_ATTACHMENTS = 10

/** Mirrors `MAX_FILE_BYTES` in `src-tauri/src/services/attachments.rs`. */
export const MAX_ATTACHMENT_FILE_BYTES = 24 * 1024 * 1024

/** The scope the desktop stages pasted bytes under when no conversation is open yet. */
const DRAFT_SCOPE = 'draft'

/** Stable empty list for the desktop's own records, before any surface holds them. */
const EMPTY_IMPORTED: readonly ImportedComposerFile[] = []

/**
 * Why an import produced no record for one of the files it was handed.
 *
 * Typed rather than a message, because the sentence belongs to the surface that owns both languages:
 * the desktop's own refusal travels as it stands (`desktop`), and the two this side detects — a
 * folder where an attachment has to be a file, a file past the desktop's budget — are named here so
 * the composer can say them in the reader's words.
 */
export type AttachmentRefusal =
  | { kind: 'directory' }
  | { kind: 'too_large'; name: string }
  | { kind: 'desktop'; error: ApiError }

/**
 * What an import did: the records it added, and the one refusal it can report.
 *
 * Both are answered rather than thrown, because every caller is a gesture — a pick, a drop, a paste
 * — and a file the desktop would not take belongs on the composer's own notice line, where the
 * reader is already looking, instead of in a rejection nobody catches.
 */
export interface AttachmentImport {
  added: readonly ComposerAttachment[]
  refusal: AttachmentRefusal | null
}

/**
 * What the desktop made of one batch of files, before any surface holds them.
 *
 * This half of the story is a draft's *or* a dialog's: a goal objective is typed into a dialog whose
 * answer is one string, so its files never reach the composer's draft store — the dialog holds the
 * same records in its own state and writes their mention lines into the answer it submits. What both
 * callers share is this import, so the validation, the paste staging and the refusals are stated
 * once here and only the holding differs.
 */
export interface ImportedAttachmentFiles {
  files: readonly ImportedComposerFile[]
  refusal: AttachmentRefusal | null
}

const NO_FILES: ImportedAttachmentFiles = { files: EMPTY_IMPORTED, refusal: null }

/**
 * Take imported files into a list that already holds some: mint each one its token, skip what is
 * already held, and stop at the cap.
 *
 * The token is minted here rather than by the caller because it is the surface's own address for the
 * record — the caller only ever writes the characters it is handed into the draft, and reads them
 * back out. Skipping a path already held is what makes picking the same file twice one chip; the cap
 * is applied here rather than at the picker so a drop of twenty files is bounded the same way a
 * paste is.
 */
export function holdAttachments(
  held: readonly ComposerAttachment[],
  incoming: readonly ImportedComposerFile[],
): ComposerAttachment[] {
  const seen = new Set(held.map((attachment) => attachment.path))
  const added: ComposerAttachment[] = []
  for (const file of incoming) {
    if (seen.has(file.path)) continue
    if (held.length + added.length >= MAX_COMPOSER_ATTACHMENTS) break
    seen.add(file.path)
    added.push({
      token: createChipToken(),
      name: file.name,
      path: file.path,
      mimeType: file.mimeType,
      bytes: file.size,
    })
  }
  return added
}

/** Take imported files into one draft: the records, then the chips they are addressed by. */
function hold(key: string, incoming: readonly ImportedComposerFile[]): AttachmentImport {
  const held = readComposerDraft(key).attachments
  const added = holdAttachments(held, incoming)
  if (added.length > 0) {
    setComposerDraftAttachments(key, [...held, ...added])
  }
  return { added, refusal: null }
}

/**
 * Ask the desktop what it makes of picked or dropped paths, without holding them anywhere.
 *
 * The desktop re-checks every path — absolute, existing, a regular file, inside the size budget — so
 * a path that vanished between the picker and this call fails here rather than in the prompt. A
 * directory among the paths is reported as its own code, which is a sentence this side owns.
 */
export async function importAttachmentPaths(
  paths: readonly string[],
): Promise<ImportedAttachmentFiles> {
  const wanted = paths.filter((path) => path.trim().length > 0)
  if (wanted.length === 0) return NO_FILES
  let result
  try {
    result = await importComposerFiles(wanted)
  } catch (error) {
    return { files: EMPTY_IMPORTED, refusal: { kind: 'desktop', error: toApiError(error) } }
  }
  return {
    files: result.files,
    refusal: result.skippedDirectories > 0 ? { kind: 'directory' } : null,
  }
}

/**
 * Ask the desktop what it makes of a clipboard's files, without holding them anywhere.
 *
 * A file copied in Explorer reaches the page as bytes with no path, but the clipboard still holds
 * the file *list* — so the desktop is asked whether it names the same file, and where it does the
 * attachment is the reader's own file rather than a copy of it. Whatever the clipboard does not name
 * keeps its bytes, which the desktop stages under its own scratch scope and answers with a path.
 *
 * A file past the desktop's own size budget is refused here, before its bytes are read: reading a
 * hundred megabytes into a base64 string to be told it is too large is the failure this guard is
 * for. The name in that refusal is the clipboard's, which is the only name the reader saw.
 *
 * `sessionId` names the scratch scope pasted bytes are staged under, and nothing else.
 */
export async function importClipboardFiles(
  sessionId: string | null,
  files: readonly File[],
): Promise<ImportedAttachmentFiles> {
  if (files.length === 0) return NO_FILES
  const oversizedAt = files.findIndex((file) => file.size > MAX_ATTACHMENT_FILE_BYTES)
  if (oversizedAt >= 0) {
    const oversized = files[oversizedAt]
    return {
      files: EMPTY_IMPORTED,
      refusal: { kind: 'too_large', name: pastedFileName(oversized?.name ?? '', oversizedAt) },
    }
  }

  const names = files.map((file, index) => pastedFileName(file.name, index))
  let resolved: (string | null)[]
  try {
    resolved = await resolveClipboardFilePaths(
      files.map((file, index) => ({ name: names[index] ?? '', size: file.size })),
    )
  } catch (error) {
    return { files: EMPTY_IMPORTED, refusal: { kind: 'desktop', error: toApiError(error) } }
  }

  const referenced: string[] = []
  const staged: { name: string; mimeType: string; data: string }[] = []
  for (let index = 0; index < files.length; index += 1) {
    const path = resolved[index] ?? null
    if (path !== null) {
      referenced.push(path)
      continue
    }
    const file = files[index]
    if (file === undefined) continue
    staged.push({
      name: names[index] ?? '',
      mimeType: pastedMimeType(file.type),
      data: await readFileBase64(file),
    })
  }

  const imported: ImportedComposerFile[] = []
  let refusal: AttachmentRefusal | null = null
  if (referenced.length > 0) {
    const fromPaths = await importAttachmentPaths(referenced)
    imported.push(...fromPaths.files)
    refusal = fromPaths.refusal
  }
  if (staged.length > 0) {
    try {
      imported.push(...(await saveComposerPaste(sessionId ?? DRAFT_SCOPE, staged)))
    } catch (error) {
      return { files: imported, refusal: { kind: 'desktop', error: toApiError(error) } }
    }
  }
  return { files: imported, refusal }
}

/** Turn picked or dropped paths into attachments for one draft. */
export async function addAttachmentPaths(
  key: string,
  paths: readonly string[],
): Promise<AttachmentImport> {
  const imported = await importAttachmentPaths(paths)
  const held = hold(key, imported.files)
  return { added: held.added, refusal: imported.refusal }
}

/**
 * Turn pasted files into attachments for one draft.
 *
 * `key` is the draft the records are added to — the one the reader pasted into. `sessionId` names
 * the scratch scope pasted bytes are staged under, and nothing else.
 */
export async function addClipboardFiles(
  key: string,
  sessionId: string | null,
  files: readonly File[],
): Promise<AttachmentImport> {
  const imported = await importClipboardFiles(sessionId, files)
  const held = hold(key, imported.files)
  return { added: held.added, refusal: imported.refusal }
}

/** Drop one file the reader no longer wants on this draft. */
export function removeAttachment(key: string, token: string): void {
  const held = readComposerDraft(key).attachments
  setComposerDraftAttachments(
    key,
    held.filter((attachment) => attachment.token !== token),
  )
}

/**
 * Forget the records a draft no longer names.
 *
 * A chip can be taken out of a sentence the way any character can — backspace, select and type over
 * it, cut — and a record the draft no longer names is a file the reader took out of the prompt. It
 * is read from the draft rather than from the ✕ alone because the two are the same fact, and only
 * the draft knows about all the ways a chip can leave.
 */
export function pruneAttachments(key: string, draft: string): void {
  const held = readComposerDraft(key).attachments
  if (held.length === 0) return
  const named = new Set(draftAttachments(draft, held).map((attachment) => attachment.token))
  const kept = held.filter((attachment) => named.has(attachment.token))
  if (kept.length === held.length) return
  setComposerDraftAttachments(key, kept)
}

/** A pasted file's bytes as bare base64, which is what the desktop's paste command reads. */
async function readFileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Chunked because `String.fromCharCode` takes its arguments on the stack: a whole image in one
  // call is a range error, not a slow path.
  const CHUNK = 0x8000
  let binary = ''
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK))
  }
  return btoa(binary)
}

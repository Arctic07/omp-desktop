/**
 * Every command this front end issues, one function each.
 *
 * These are thin: they name the command, shape its arguments and hand back the typed answer. No
 * caching, retrying or defaulting happens here — the desktop already defines what each command
 * means, and a wrapper that invented a fallback would be a second, quieter contract.
 */

import { Channel } from '@tauri-apps/api/core'

import { call } from '@/api/client'
import {
  SESSION_COMMANDS,
  type AbortOutcome,
  type ChatAttachmentRef,
  type ForceStopOutcome,
  type HistoryChunk,
  type SessionBranchFrom,
  type SessionChildren,
  type SessionColdStatus,
  type SessionHistory,
  type SessionOrderEntry,
  type SessionReadMark,
  type SessionRewind,
  type SessionSearchHit,
  type SessionSummary,
  type SessionThinkingLevel,
  type SessionView,
  type StopJobOutcome,
  type StreamingBehavior,
  type UiResponse,
} from '@/api/session-types'
import {
  COMMANDS,
  type CustomModelList,
  type CustomProvider,
  type CustomProviderInput,
  type EngineDataPaths,
  type EngineModelList,
  type EngineRoleCandidates,
  type ModelRoleTable,
  type ProviderKeyResult,
  type ProviderSummary,
  type RuntimeStatus,
  type WorkspaceSummary,
} from '@/api/types'

/* ------------------------------------------------------------------ runtime */

export function runtimeStatus(): Promise<RuntimeStatus> {
  return call(COMMANDS.runtimeStatus)
}

export function runtimeRestart(): Promise<void> {
  return call(COMMANDS.runtimeRestart)
}

/** `refresh: true` asks the engine to re-scan its catalogue; the cached read is the default. */
export function engineModels(refresh = false): Promise<EngineModelList> {
  return call(COMMANDS.engineModels, refresh ? { refresh: true } : undefined)
}

export function engineModelRoles(): Promise<ModelRoleTable> {
  return call(COMMANDS.engineModelRoles)
}

export function engineRoleCandidates(role: string): Promise<EngineRoleCandidates> {
  return call(COMMANDS.engineRoleCandidates, { role })
}

/** `selector: null` clears the role back to the engine's default. */
export function engineSetModelRole(role: string, selector: string | null): Promise<ModelRoleTable> {
  return call(COMMANDS.engineSetModelRole, { role, selector })
}

/**
 * Make sure the one host is running and past its handshake.
 *
 * Idempotent, and the boot call that settles the engine's tool approval mode. The workspace id is
 * accepted by the desktop and ignored — one host serves every workspace — but the argument is
 * required, so it is passed rather than omitted.
 */
export function engineWarm(workspaceId: number): Promise<void> {
  return call(COMMANDS.engineWarm, { workspaceId })
}

export function engineDataPaths(): Promise<EngineDataPaths> {
  return call(COMMANDS.engineDataPaths)
}

/* --------------------------------------------------------------- providers */

export function providerList(): Promise<ProviderSummary[]> {
  return call(COMMANDS.providerList)
}

/** Removes the named saved rows and appends new keys; the engine rotates across the result. */
export function providerKeysApply(
  providerId: string,
  remove: number[],
  add: string[],
): Promise<ProviderKeyResult> {
  return call(COMMANDS.providerKeysApply, { providerId, remove, add })
}

export function providerClearKey(providerId: string): Promise<ProviderKeyResult> {
  return call(COMMANDS.providerClearKey, { providerId })
}

export function customProviderList(): Promise<CustomProvider[]> {
  return call(COMMANDS.customProviderList)
}

/** Answers the whole list, not the row that was saved. */
export function customProviderSave(provider: CustomProviderInput): Promise<CustomProvider[]> {
  return call(COMMANDS.customProviderSave, { provider })
}

export function customProviderRemove(providerId: string): Promise<CustomProvider[]> {
  return call(COMMANDS.customProviderRemove, { providerId })
}

/** Probes the endpoint with the first stored key when no key is typed; nothing is stored here. */
export function customProviderFetchModels(
  baseUrl: string,
  apiKey: string | null,
  providerId: string | null,
): Promise<CustomModelList> {
  return call(COMMANDS.customProviderFetchModels, { baseUrl, apiKey, providerId })
}

/* -------------------------------------------------------------- workspaces */

export function workspaceList(): Promise<WorkspaceSummary[]> {
  return call(COMMANDS.workspaceList)
}

export function workspaceAdd(rootPath: string): Promise<WorkspaceSummary> {
  return call(COMMANDS.workspaceAdd, { rootPath })
}

export function workspaceRename(workspaceId: number, name: string): Promise<WorkspaceSummary> {
  return call(COMMANDS.workspaceRename, { workspaceId, name })
}

export function workspaceRemove(workspaceId: number): Promise<void> {
  return call(COMMANDS.workspaceRemove, { workspaceId })
}

export function workspaceTouch(workspaceId: number): Promise<void> {
  return call(COMMANDS.workspaceTouch, { workspaceId })
}

/** Rewrite the rail's workspace order: each workspace stands where its id sits in the list. */
export function workspaceReorder(workspaceIds: readonly number[]): Promise<void> {
  return call(COMMANDS.workspaceReorder, { workspaceIds })
}

export function currentWorkingDirectory(): Promise<string> {
  return call(COMMANDS.currentWorkingDirectory)
}

export function openDirectoryInFileManager(path: string): Promise<boolean> {
  return call(COMMANDS.openDirectoryInFileManager, { path })
}

/* ---------------------------------------------------------------- sessions */

export function sessionList(workspaceId: number): Promise<SessionSummary[]> {
  return call(SESSION_COMMANDS.sessionList, { workspaceId })
}

export function sessionOpen(workspaceId: number, sessionFile?: string | null): Promise<SessionView> {
  return call(SESSION_COMMANDS.sessionOpen, { workspaceId, sessionFile: sessionFile ?? null })
}

export function sessionClose(sessionId: string, dropFile = false): Promise<void> {
  return call(SESSION_COMMANDS.sessionClose, { sessionId, dropFile })
}

/**
 * Tell the desktop whether this conversation is on screen.
 *
 * A conversation on screen streams at the display cadence; one the reader has left is coalesced
 * over a wider window, so several conversations running side by side no longer each cost an event
 * per frame. The answer is whether the desktop still holds the session: `false` means it was
 * evicted or its host restarted, which is what a warm record checks when the reader comes back.
 */
export function sessionWatch(sessionId: string, watched: boolean): Promise<boolean> {
  return call(SESSION_COMMANDS.sessionWatch, { sessionId, watched })
}

/**
 * Tell the desktop whether a subagent's transcript tab is open.
 *
 * A child's own events arrive once per token, and the desktop projects them only for a tab that is
 * drawing them. Closing the tab stops the projection; opening it later reads the transcript from
 * disk and follows it from there.
 */
export function childWatch(sessionId: string, watched: boolean): Promise<void> {
  return call(SESSION_COMMANDS.childWatch, { sessionId, watched })
}

export function sessionDelete(sessionId: string, sessionFile: string): Promise<void> {
  return call(SESSION_COMMANDS.sessionDelete, { sessionId, sessionFile })
}

/**
 * The subagents one conversation spawned, read from the directory the engine wrote beside its file.
 *
 * `sessionFile` is the conversation's own transcript: the children are the directory named after it,
 * so a caller holding no file has no children to ask about. Each child's `filePath` is what
 * addresses its rows (`sessionHistory` with a file) and its `id` is what its live frames arrive on.
 */
export function sessionChildren(
  sessionId: string,
  sessionFile: string,
): Promise<SessionChildren> {
  return call(SESSION_COMMANDS.sessionChildren, { sessionId, sessionFile })
}

/**
 * Conversations whose own words mention `query`, newest first.
 *
 * The search runs over the desktop's own projection of the engine's transcripts - the words of each
 * conversation, indexed by the scan that read it - so it costs the index and not the store, and it
 * answers for conversations this process has never opened. Archived conversations are left out:
 * they were put away on purpose, and the rail hides them too.
 *
 * `limit` bounds the conversations answered, not the matches inside one: each hit carries its own
 * count and up to three snippets, which is what a result row draws.
 */
export function sessionSearch(query: string, limit = 20): Promise<SessionSearchHit[]> {
  return call(SESSION_COMMANDS.sessionSearch, { query, limit })
}

/**
 * Read a whole transcript.
 *
 * The desktop walks the host's pages itself and answers once, so a conversation costs one round
 * trip however long it is. `onProgress` receives the desktop's own reports in order; the channel
 * behind it is released by the desktop when the read ends, so nothing is unregistered here.
 *
 * `streamRows` asks for the rows on that same channel as they become final: a surface painting the
 * conversation as it opens appends them and does not wait for the whole transcript to cross as one
 * payload. The answer carries every row either way, and a caller that does not set it only sees
 * progress.
 *
 * `sessionFile` addresses a transcript no live session owns — a subagent's own. `taskPrompt` says
 * the file is a subagent's, so the assignment its `task` call wrote as its opening user message is
 * read back as a row: the desktop hides engine-authored user messages everywhere else (steers,
 * automatic continuations), and that one is the only thing a child was asked.
 */
export function sessionHistory(
  sessionId: string,
  onProgress: (chunk: HistoryChunk) => void,
  sessionFile: string | null = null,
  options: { taskPrompt?: boolean; streamRows?: boolean } = {},
): Promise<SessionHistory> {
  const channel = new Channel<HistoryChunk>(onProgress)
  return call(SESSION_COMMANDS.sessionHistory, {
    sessionId,
    sessionFile,
    includeTaskPrompt: options.taskPrompt === true,
    // Rows on the channel while the walk runs: the caller appends them and paints as it goes.
    streamRows: options.streamRows === true,
    onChunk: channel,
  })
}

export function sessionPrompt(
  sessionId: string,
  text: string,
  attachments: ChatAttachmentRef[] = [],
  streamingBehavior: StreamingBehavior | null = null,
): Promise<void> {
  return call(SESSION_COMMANDS.sessionPrompt, {
    sessionId,
    text,
    attachments,
    streamingBehavior,
  })
}

export function sessionAbort(sessionId: string): Promise<AbortOutcome> {
  return call(SESSION_COMMANDS.sessionAbort, { sessionId })
}

export function sessionForceStop(sessionId: string): Promise<ForceStopOutcome> {
  return call(SESSION_COMMANDS.sessionForceStop, { sessionId })
}

export function sessionStopJob(sessionId: string, jobId: string): Promise<StopJobOutcome> {
  return call(SESSION_COMMANDS.sessionStopJob, { sessionId, jobId })
}

export function sessionSetModel(
  sessionId: string,
  provider: string,
  modelId: string,
): Promise<void> {
  return call(SESSION_COMMANDS.sessionSetModel, { sessionId, provider, modelId })
}

export function sessionSetThinking(
  sessionId: string,
  level: SessionThinkingLevel,
): Promise<void> {
  return call(SESSION_COMMANDS.sessionSetThinking, { sessionId, level })
}

export function sessionRename(sessionId: string, name: string): Promise<void> {
  return call(SESSION_COMMANDS.sessionRename, { sessionId, name })
}

/** Every conversation the desktop has recorded a reading for. */
export function sessionReadMarks(): Promise<SessionReadMark[]> {
  return call(SESSION_COMMANDS.sessionReadMarks)
}

/** Record that the reader has seen this conversation's cold status. */
export function sessionMarkRead(sessionId: string, status: SessionColdStatus): Promise<void> {
  return call(SESSION_COMMANDS.sessionMarkRead, { sessionId, status })
}

/** Keep one conversation's row at the top of its workspace's list, or stop doing so. */
export function sessionSetPinned(sessionId: string, pinned: boolean): Promise<void> {
  return call(SESSION_COMMANDS.sessionSetPinned, { sessionId, pinned })
}

/** Put one conversation away, or bring it back into the workspace's list. */
export function sessionSetArchived(sessionId: string, archived: boolean): Promise<void> {
  return call(SESSION_COMMANDS.sessionSetArchived, { sessionId, archived })
}

/**
 * One workspace's conversations, in the order the reader dragged them into, each with the row's
 * last-write time at the moment it was placed.
 *
 * Empty for a workspace that was never rearranged, which is what keeps the list reading by
 * recency until the reader says otherwise.
 */
export function sessionOrderGet(workspaceId: number): Promise<SessionOrderEntry[]> {
  return call(SESSION_COMMANDS.sessionOrderGet, { workspaceId })
}

/** Record the order the reader dragged one workspace's conversations into. */
export function sessionOrderSet(
  workspaceId: number,
  entries: readonly SessionOrderEntry[],
): Promise<void> {
  return call(SESSION_COMMANDS.sessionOrderSet, { workspaceId, entries })
}

export function sessionUiRespond(
  sessionId: string,
  requestId: string,
  response: UiResponse,
): Promise<void> {
  return call(SESSION_COMMANDS.sessionUiRespond, { sessionId, requestId, response })
}

/**
 * Start a conversation of its own that continues from an entry inside this one.
 *
 * The engine moves the session's leaf onto that entry and forks the conversation into a file of its
 * own, so the one being read keeps every message it had and a second one appears, ending where the
 * reader pointed. Nothing is re-sent, so no draft comes back with it.
 */
export function sessionBranchFrom(sessionId: string, entryId: string): Promise<SessionBranchFrom> {
  return call(SESSION_COMMANDS.sessionBranchFrom, { sessionId, entryId })
}

/**
 * Take a conversation back to just before one of its user messages, in place.
 *
 * The engine moves the conversation's active branch to end before the message inside the same
 * session, so the message and everything after it leave the conversation the reader continues
 * with — and the conversation keeps its id, its file, its title and its one row in the list. The
 * answer echoes the same id and carries the message's own text. The row is addressed by its entry
 * id when the transcript named one, or by its own message timestamp when it was written by the
 * live stream.
 */
export function sessionRewind(
  sessionId: string,
  target: { entryId?: string; at?: number },
): Promise<SessionRewind> {
  return call(SESSION_COMMANDS.sessionRewind, {
    sessionId,
    entryId: target.entryId ?? null,
    at: target.at ?? null,
  })
}

/* ------------------------------------------------------------- attachments */

/**
 * A file the composer is holding, as the desktop described it.
 *
 * `size` is the desktop's field name for the byte count; `ChatAttachmentRef.bytes` is the engine's,
 * and the two are the same number under two names — the mapping happens in the attachment store, so
 * nothing downstream has to remember which side it came from.
 */
export interface ImportedComposerFile {
  path: string
  name: string
  /** The desktop's own classification: `image`, `text`, `pdf`, … */
  kind: string
  mimeType: string
  size: number
}

export interface ImportComposerFilesResult {
  files: ImportedComposerFile[]
  /** How many of the requested paths were directories, which an attachment cannot be. */
  skippedDirectories: number
}

/**
 * Resolve picked or dropped paths into attachments that name the files themselves.
 *
 * The desktop re-checks each path — absolute, existing, a regular file, inside the size budget — so
 * a caller cannot smuggle a directory or a path the renderer invented into a prompt. A path the
 * check refuses fails the whole call; a directory is reported in `skippedDirectories` instead.
 */
export function importComposerFiles(paths: readonly string[]): Promise<ImportComposerFilesResult> {
  return call(COMMANDS.importComposerFiles, { paths: [...paths] })
}

/** One pasted file's bytes, as the renderer read them off the clipboard. */
export interface ComposerPasteFile {
  /** The leaf name the clipboard reported, when it had one. */
  name?: string
  mimeType?: string
  /** The file's bytes, base64, with no data-URL prefix. */
  data: string
}

/**
 * Stage pasted bytes the desktop could not find a real path for.
 *
 * A file copied inside this application — a screenshot, an image out of a browser — reaches the page
 * as bytes with no path, and the engine reads a mention from a path. The desktop writes those bytes
 * under its own scratch scope and answers with the records to attach, so a pasted picture becomes a
 * file the agent can open like any other. The scope is the conversation's id, which is also what the
 * desktop's scratch sweep reads.
 */
export function saveComposerPaste(
  sessionId: string,
  files: readonly ComposerPasteFile[],
): Promise<ImportedComposerFile[]> {
  return call(COMMANDS.saveComposerPaste, { sessionId, files: [...files] })
}

/** One pasted file as the renderer saw it, for asking whether the clipboard names the real file. */
export interface ClipboardFileQuery {
  name: string
  size: number
}

/**
 * The real path behind each pasted file, when the platform can name one.
 *
 * Windows keeps a copied *file list* on the clipboard that the web layer cannot see, so a paste of
 * files copied in Explorer arrives as bytes whose owner is knowable only by asking. A `null` entry
 * means the clipboard does not name that file, and its bytes are staged instead — an attachment the
 * agent edits is then the reader's own file rather than a copy of it.
 */
export function resolveClipboardFilePaths(
  files: readonly ClipboardFileQuery[],
): Promise<(string | null)[]> {
  return call(COMMANDS.resolveClipboardFilePaths, { files: [...files] })
}

/**
 * Replace the clipboard with text and the files that go with it.
 *
 * Resolves whether the desktop wrote it; `false` is a clipboard that refused (held by another
 * process, or text past the size it takes), and the caller writes the words through the web API
 * instead. Platforms without a file list still write the text.
 */
export function copyTextAndFiles(text: string, files: readonly string[]): Promise<boolean> {
  return call(COMMANDS.copyTextAndFiles, { text, files: [...files] })
}

/**
 * The clipboard's own text, for a paste the webview reports as files only.
 *
 * A clipboard holding a file list hides its text from the page (Chromium, WebView2's engine,
 * exposes `Files` and no `text/plain`), so a copy this app wrote as "words and files" pastes back
 * as the files alone. The words are still there; this reads them, and an empty string is the honest
 * answer when there is nothing to recover.
 */
export function readClipboardText(): Promise<string> {
  return call(COMMANDS.readClipboardText)
}

/** One file's bytes, as either text or a data URL, for a preview the reader asked to see. */
export interface ExternalFileRead {
  kind: string
  content?: string
  dataUrl?: string
  size: number
}

/** Read a file the workspace does not own — an attachment the reader picked from anywhere. */
export function readExternalFile(path: string): Promise<ExternalFileRead> {
  return call(COMMANDS.readExternalFile, { path })
}

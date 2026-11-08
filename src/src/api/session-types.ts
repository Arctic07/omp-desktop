/**
 * Wire types for one conversation: its list row, its runtime state, its transcript rows and the
 * frames it streams.
 *
 * Field names mirror `src-tauri/src/models/agent.rs`, `models/agent/chat.rs`,
 * `models/agent/work.rs` and `models/agent/stop.rs` one for one. Optional means the Rust side
 * omits the key when empty (`skip_serializing_if`); nullable means it always serializes, as `null`.
 */

/** Commands that address one open conversation. */
export const SESSION_COMMANDS = {
  sessionList: 'session_list',
  sessionChildren: 'session_children',
  sessionSearch: 'session_search',
  sessionOpen: 'session_open',
  sessionClose: 'session_close',
  sessionWatch: 'session_watch',
  childWatch: 'child_watch',
  sessionDelete: 'session_delete',
  sessionHistory: 'session_history',
  sessionPrompt: 'session_prompt',
  sessionAbort: 'session_abort',
  sessionForceStop: 'session_force_stop',
  sessionStopJob: 'session_stop_job',
  sessionSetModel: 'session_set_model',
  sessionSetThinking: 'session_set_thinking',
  sessionRename: 'session_rename',
  sessionUiRespond: 'session_ui_respond',
  sessionReadMarks: 'session_read_marks',
  sessionMarkRead: 'session_mark_read',
  sessionSetPinned: 'session_set_pinned',
  sessionSetArchived: 'session_set_archived',
  sessionOrderGet: 'session_order_get',
  sessionOrderSet: 'session_order_set',
  sessionBranchFrom: 'session_branch_from',
  sessionRewind: 'session_rewind',
} as const

export type SessionColdStatus =
  | 'complete'
  | 'interrupted'
  | 'aborted'
  | 'error'
  | 'pending'
  | 'unknown'

/**
 * One row of a workspace's stored arrangement: a conversation, and when it was last written when
 * the reader placed it. Mirrors `models/agent.rs::SessionOrderEntry`.
 */
export interface SessionOrderEntry {
  id: string
  /** The row's own `updatedAt` when it was placed; a later write takes it out of the arrangement. */
  at: number
}

/** One row of a workspace's conversation list, read from disk — not from a live session. */
export interface SessionSummary {
  id: string
  title: string
  cwd: string
  status: SessionColdStatus
  updatedAt: number
  filePath: string
  /** The engine's compressed form (`*.jsonl.gz`), not a transcript this app can open. */
  compressed: boolean
  /** The user pinned the conversation to the top of its workspace's list. */
  pinned: boolean
  /** The user put the conversation away: the rail hides its row until asked for the archived ones. */
  archived: boolean
  /** The transcript holds no message yet. */
  blank: boolean
}

/**
 * One subagent transcript of a conversation, as `session_children` lists it.
 *
 * `id` is the id this desktop routes the child's file by (`session_index::host_session_id`), which
 * is also the id the child's own live frames are published under — it is *not* the engine's own
 * subagent id, which is the file's stem and is what a `task` call's roster carries (`filePath`).
 */
export interface SessionChild {
  id: string
  /** The title the transcript carries, or the file name it was written under. */
  title: string
  filePath: string
  updatedAt: number
  status: SessionColdStatus
}

/** What `session_children` answers. */
export interface SessionChildren {
  /** Oldest first, the order the subagents were spawned in. */
  children: SessionChild[]
  /** True when children were left out: a conversation with more than one read keeps is cut. */
  truncated: boolean
}

/**
 * The cold status one conversation has already been read at.
 *
 * The file never records a reading, so this is the desktop's own: a status the user has seen stops
 * marking the row, and the next status the engine writes marks it again.
 */
export interface SessionReadMark {
  sessionId: string
  status: SessionColdStatus
  /** When the reader saw it, as the host clock wrote it; compared with a session's `updatedAt`. */
  seenAt: number
}

/** What `session_open` answers, including the first runtime snapshot. */
export interface SessionView {
  sessionId: string
  workspaceId: number
  workspaceRoot: string
  sessionFile: string | null
  title: string | null
  modelProvider: string | null
  modelId: string | null
  thinkingLevel: string | null
  streaming: boolean
  state: SessionRuntimeState
}

export interface SessionRetry {
  attempt: number
  maxAttempts: number
  delayMs: number
  errorMessage: string | null
}

export interface ContextCategories {
  systemPrompt: number
  systemTools: number
  systemContext: number
  skills: number
  messages: number
}

export interface SessionUsageTotals {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface EngineSubcommand {
  name: string
  description: string
}

export interface EngineCommand {
  name: string
  description: string
  aliases: string[]
  inputHint: string
  subcommands: EngineSubcommand[]
  source: string
}

export interface BackgroundJob {
  id: string
  type: string
  label: string
  startedAt: number
}

/** One goal-mode row: the objective and the accounting the engine keeps for it. */
export interface SessionGoalMode {
  enabled: boolean
  status: string
  objective: string
  tokensUsed: number
  tokenBudget: number | null
  timeUsedSeconds: number
}

/** One plan-mode row: the plan file the conversation is planning into. */
export interface SessionPlanMode {
  planFilePath: string
}

/** One vibe worker, as the engine's own fleet snapshot reports it. */
export interface SessionVibeWorker {
  id: string
  cli: 'fast' | 'good'
  state: string
  killed: boolean
  model?: string
  turns: number
  queued: number
  turnStartedAt?: number
  turnMessage?: string
  currentTool?: string
  currentToolArgs?: string
  lastIntent?: string
  lastActivityAt: number
}

/** One loop-mode row: the repeating prompt and whatever bounds it. */
export interface SessionLoopMode {
  enabled: boolean
  paused: boolean
  prompt?: string
  limit?: string
  condition?: string
}

/** The modes one conversation is in; a mode that is off is absent. */
export interface SessionModes {
  goal?: SessionGoalMode
  plan?: SessionPlanMode
  vibe?: { workers: readonly SessionVibeWorker[] }
  loop?: SessionLoopMode
}

export type TodoStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'abandoned'
  | 'blocked'
  | 'unknown'

export interface TodoItem {
  content: string
  status: TodoStatus
  blocker?: string
}

export interface TodoPhase {
  name: string
  tasks: TodoItem[]
}

/**
 * The whole of what a conversation is right now, as the desktop projects it.
 *
 * The optional members are omitted when empty; the rest always serialize.
 */
export interface SessionRuntimeState {
  sessionId: string
  tipEntryId?: string
  modelProvider: string | null
  modelId: string | null
  thinkingLevel: string | null
  /**
   * Levels this conversation accepts, `auto` first. Empty is a fact — the model cannot think, and
   * the composer shows no strength control at all (a lone `auto` would still read as one choice).
   */
  thinkingLevels: string[]
  isStreaming: boolean
  /**
   * The engine is rewriting the context (a compaction or a handoff). It runs with no turn in
   * flight, so the stop control and the lifetime gates have to read this beside `isStreaming`; a
   * host that predates the field sends nothing, which reads as "not compacting".
   */
  isCompacting?: boolean
  /**
   * The modes this conversation is in, keyed by mode name. A mode that is off is absent; a host
   * that predates the field sends nothing, which draws the same empty strip.
   */
  modes?: SessionModes
  retry?: SessionRetry
  messageCount: number
  contextTokens: number
  contextWindow: number
  contextPercent: number
  /** null when the engine will not compact on its own. */
  autoCompactPercent: number | null
  contextAnchored: boolean
  contextCategories: ContextCategories
  sessionUsage: SessionUsageTotals
  commands: EngineCommand[]
  interrupted?: boolean
  todoPhases?: TodoPhase[]
  pendingAsyncWork: boolean
  cancellableSubagents: number
  /** Epoch ms; 0 means the host never saw an event for this conversation. */
  lastEventAt: number
  backgroundJobs?: BackgroundJob[]
}

/* ------------------------------------------------------------- transcript */

export interface ChatAttachmentRef {
  name: string
  path: string
  mimeType: string
  bytes: number
}

export interface ChatTokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** null when the engine reported no reasoning bucket for the turn. */
  reasoning: number | null
  costUsd: number
}

export interface ChatImage {
  mimeType: string
  bytes: number
  dataUrl: string
}

export interface ToolFileChange {
  path: string
  diff?: string
  firstChangedLine?: number
  isError?: boolean
  errorText?: string
}

export interface ToolSubagent {
  name?: string
  id?: string
  agent: string
  description?: string
  exitCode: number
  durationMs: number
  tokens: number
  truncated?: boolean
  status?: string
  toolCount?: number
  currentTool?: string
  lastIntent?: string
  /** The model it ran on, as `<provider>/<id>`; absent when the engine resolved none. */
  model?: string
}

export interface ToolSource {
  title: string
  url: string
  snippet: string
}

export interface ToolDetails {
  path?: string
  diff?: string
  firstChangedLine?: number
  files?: ToolFileChange[]
  subagents?: ToolSubagent[]
  /** Only on `task` calls: `running` | `completed` | `failed`. */
  subagentState?: string
  sources?: ToolSource[]
  /** A search provider's synthesized answer, when the provider writes prose (not every one does). */
  answer?: string
  /**
   * The minimizer's rewrite of a shell call's output.
   *
   * The result text a row draws is already the minimized capture, so it cannot say a larger one
   * exists; a `bash` call is the only tool the engine reports this for.
   */
  minimized?: ToolMinimized
}

/** One shell call's minimizer record: the filter that ran and the bytes before and after. */
export interface ToolMinimized {
  filter: string
  inputBytes: number
  outputBytes: number
}

/**
 * A `task` call's live roster row.
 *
 * Every field always serializes, as `null` when the host does not know it yet.
 */
export interface SubagentRow {
  id: string
  agent: string
  index: number
  parentToolCallId: string | null
  detached: boolean
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | string
  description: string | null
  assignment: string | null
  toolCount: number | null
  currentTool: string | null
  currentToolArgs: string | null
  lastIntent: string | null
  /** The model it runs on, as `<provider>/<id>`; null until a frame resolved one. */
  model: string | null
  tokens: number | null
  durationMs: number | null
  startedAt: number
  recentTools: { tool: string; args: string }[]
  recentOutput: string[]
}

/** One row of a conversation, discriminated on `kind` (lowercase). */
export type ChatMessage =
  | {
      kind: 'user'
      id: string
      at: number
      text: string
      attachments: ChatAttachmentRef[]
      entryId?: string
    }
  | {
      kind: 'assistant'
      id: string
      at: number
      text: string
      thinking: string
      error: string | null
      entryId?: string
      stopReason?: string
      startedAt: number | null
      endedAt: number | null
      usage: ChatTokenUsage | null
      modelProvider: string | null
      modelId: string | null
      images?: ChatImage[]
    }
  | {
      /**
       * An engine notice the reader asked to keep in the transcript: the idle recap.
       *
       * Every other notice is a line about the machinery (a retry, a backpressure pause) and lives
       * above the composer, where it can be dismissed. A recap is about the conversation itself, so
       * it is drawn where the conversation is, as the one line the engine's own terminal draws.
       */
      kind: 'notice'
      id: string
      at: number
      text: string
    }
  | {
      /**
       * An injected reminder the reader is meant to see: a rule check that fired on a tool call.
       *
       * The engine writes it as a **developer** message, which is context for the model rather than
       * conversation — except this one, which explains something the reader just watched happen. The
       * text is the harness block as it was written (`<system-reminder …>…</system-reminder>`), read
       * apart by `home/reminder.ts`.
       */
      kind: 'reminder'
      id: string
      at: number
      text: string
    }
  | {
      kind: 'tool'
      id: string
      at: number
      toolCallId: string
      entryId?: string
      name: string
      state: string
      argsText: string
      resultText: string
      startedAt: number | null
      endedAt: number | null
      intent: string | null
      details?: ToolDetails
      images?: ChatImage[]
    }

export interface SessionHistory {
  messages: ChatMessage[]
  totalMessages: number
}

/**
 * A conversation started from an entry inside another one.
 *
 * No draft comes with it: the point a reader picks is where the new conversation carries on from,
 * not a message to write again. The conversation it was taken from keeps every message it had.
 */
export interface SessionBranchFrom {
  sessionId: string
  sessionFile: string
  /** The file the new conversation was taken from; it stays openable. */
  previousSessionFile: string
}

/**
 * The conversation a rewind left: the same one, ending before the message, and that message's own
 * text for the composer.
 *
 * The rewrite is in place — the engine moves the active branch inside the same file — so there is
 * no new identity here. The conversation keeps its id, its title and its one row in the list, and
 * the entries the cut dropped stay in the file as an off-branch sibling. What is gone from the
 * conversation is the message and the output after it.
 */
export interface SessionRewind {
  /** The conversation's own id, echoed from the live registration. */
  sessionId: string
  /** The message's own text, as the engine stored it. */
  text: string
}

/**
 * What `session_history` reports while it walks: how far it is, and — when the caller asked to
 * paint while reading (`streamRows`) — the rows that are already final.
 *
 * A `rows` chunk carries the counters too, so a surface that appends its messages does not have to
 * read two chunks per page. `reset` means the walk started over (a turn wrote and made its cursor
 * stale): the rows read so far are not a prefix of the transcript any more and must be replaced.
 */
export type HistoryChunk =
  | { kind: 'progress'; loaded: number; total: number }
  | { kind: 'rows'; loaded: number; total: number; messages: ChatMessage[]; reset?: boolean }

/* ----------------------------------------------------------------- dialogs */

export interface UiAskOption {
  label: string
  description?: string | null
  preview?: string | null
}

export interface UiAskQuestion {
  id: string
  question: string
  header?: string | null
  options: UiAskOption[]
  multi: boolean
  recommended: number | null
}

export type UiRequest =
  | { method: 'confirm'; id: string; title: string; message: string; timeoutMs: number | null }
  | {
      method: 'select'
      id: string
      title: string
      message: string
      options: string[]
      optionDescriptions: string[]
      timeoutMs: number | null
    }
  | {
      method: 'input'
      id: string
      title: string
      message: string
      placeholder: string
      /**
       * The engine's host hint that the answer is a credential (`ExtensionUIDialogOptions.secret`):
       * the field masks what is typed. Absent when it did not ask for masking.
       */
      secret?: boolean
      timeoutMs: number | null
    }
  | {
      method: 'editor'
      id: string
      title: string
      message: string
      placeholder: string
      timeoutMs: number | null
    }
  | { method: 'ask'; id: string; questions: UiAskQuestion[]; timeoutMs: number | null }

export interface UiAskResult {
  id: string
  question: string
  options: string[]
  multi: boolean
  selectedOptions: string[]
  customInput?: string | null
  note?: string | null
  timedOut?: boolean | null
}

export interface UiResponse {
  value?: string | null
  confirmed?: boolean | null
  cancelled?: boolean | null
  /** `submit` | `chat`, for an `ask` dialog. */
  kind?: string | null
  results?: UiAskResult[] | null
}

/* ------------------------------------------------------------------ frames */

export type SessionNoticeLevel = 'info' | 'warning' | 'error'

export type TurnOutcome = 'completed' | 'aborted' | 'failed'

/**
 * Everything a conversation streams on its own channel, `omp:session:<sessionId>`.
 *
 * The session id is in the channel name, not in the payload. Every frame may also carry `seq`,
 * which is the host's own frame counter and not a dedupe key.
 */
/** The side question the side panel draws: streamed deltas, then the engine's record snapshot. */
export type BtwFrame =
  | { type: 'btw'; kind: 'delta'; delta: string; seq?: number }
  | {
      type: 'btw'
      kind: 'record'
      question: string
      answer: string
      status: string
      error?: string
      seq?: number
    }
  | { type: 'btw'; kind: 'cleared'; seq?: number }

export type SessionEvent =
  | { type: 'state'; state: SessionRuntimeState; seq?: number }
  | BtwFrame
  | { type: 'title_changed'; title: string; seq?: number }
  | { type: 'turn_started'; turnId: string; at: number; seq?: number }
  | {
      type: 'turn_finished'
      turnId: string
      outcome: TurnOutcome
      error: string | null
      at: number
      seq?: number
    }
  | {
      type: 'message_started'
      messageId: string
      role: 'user' | 'assistant'
      at: number | null
      seq?: number
    }
  | {
      type: 'delta'
      messageId: string
      textDelta: string | null
      thinkingDelta: string | null
      seq?: number
    }
  | {
      type: 'message_finished'
      messageId: string
      startedAt: number | null
      endedAt: number
      usage: ChatTokenUsage | null
      modelProvider: string | null
      modelId: string | null
      /**
       * The message's whole words, as the engine recorded them.
       *
       * The row is set to these rather than to whatever its deltas happened to add up to: a shed
       * increment, a listener that was not attached for part of the stream, or an answer the engine
       * rewrote all end on the same complete row as one that arrived in full. Absent from an older
       * host, and null when the message has no words at all (the delta path is then the only one).
       */
      text?: string | null
      /** The message's whole reasoning, under the same rule as {@link text}. */
      thinking?: string | null
      /** The engine's own reason this answer stopped, when it reported one. */
      stopReason?: string
      /** The engine's own words for a stop that carried a failure, when it said any. */
      error?: string | null
      images?: ChatImage[]
      seq?: number
    }
  | {
      type: 'tool_started'
      toolCallId: string
      name: string
      argsText: string
      startedAt: number
      intent: string | null
      seq?: number
    }
  | {
      type: 'tool_updated'
      toolCallId: string
      resultText: string
      details?: ToolDetails
      images?: ChatImage[]
      seq?: number
    }
  | {
      type: 'tool_finished'
      toolCallId: string
      name: string
      state: 'success' | 'error'
      resultText: string
      endedAt: number
      details?: ToolDetails
      images?: ChatImage[]
      seq?: number
    }
  | {
      /**
       * An injected reminder that arrived whole.
       *
       * A reminder is written into the conversation as one finished developer message, so it has no
       * stream of its own: the frame that announces it carries all of its words, and there is no
       * `delta` to follow it.
       */
      type: 'reminder'
      messageId: string
      at: number
      text: string
      seq?: number
    }
  | { type: 'subagent_updated'; subagent: SubagentRow; seq?: number }
  | {
      type: 'notice'
      level: SessionNoticeLevel
      code?: string
      message: string
      seq?: number
    }
  | { type: 'error'; code: string; message: string; seq?: number }
  | { type: 'ui_request'; request: UiRequest; seq?: number }
  | { type: 'ui_cancelled'; requestId: string; seq?: number }

export type SessionEventType = SessionEvent['type']

/* -------------------------------------------------------------- stop results */

export interface AbortOutcome {
  aborted: boolean
  cancelledSubagents: number
  cancelledJobs: number
  /** Stable tokens: `turn` | `background` | `children` | `queued`. */
  remaining: string[]
  /**
   * The reader's own queued input the stop withdrew, oldest first.
   *
   * A steering message waiting behind the turn is a turn the engine starts the moment the abort
   * unwinds, so the host withdraws the queue first and answers with what it took. The screen returns
   * the words to the composer instead of dropping input nobody sent.
   */
  restored: string[]
}

export interface ForceStopOutcome {
  forced: boolean
  cancelledSubagents: number
  cancelledJobs: number
  /** The same withdrawal a normal stop reports (see {@link AbortOutcome.restored}). */
  restored: string[]
  sessionFile: string | null
}

export interface StopJobOutcome {
  stopped: boolean
}

/* ---------------------------------------------------------------- thinking */

/**
 * The levels `session_set_thinking` accepts.
 *
 * It is a superset of the preference list: `inherit` is legal here and means the same as `auto`,
 * which the desktop translates before the frame goes out.
 */
export const SESSION_THINKING_LEVELS = [
  'auto',
  'inherit',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type SessionThinkingLevel = (typeof SESSION_THINKING_LEVELS)[number]

/** What `session_prompt` accepts while a turn is already running. */
export type StreamingBehavior = 'steer' | 'followUp' | 'aside'

/**
 * One conversation a content search matched, as `session_search` answers it.
 *
 * The row is a conversation, not a message, because that is what a reader does with it: they open
 * it. `workspaceId` is absent when no registered workspace names the transcript's own directory -
 * the row is then drawn without an action rather than as a button that cannot open anything.
 */
export interface SessionSearchHit {
  sessionId: string
  filePath: string
  title: string
  cwd: string
  workspaceId?: number
  updatedAt: number
  matchCount: number
  snippets: SessionSearchSnippet[]
}

/**
 * One matched line of a conversation.
 *
 * `text` is the line around the match with the match wrapped in U+0001 and U+0002 - the only markup
 * that crosses this boundary, and the reader's side turns it into a `<mark>`
 * (`home/conversation-search.ts`). `seq` is the message's position in the transcript, oldest first.
 */
export interface SessionSearchSnippet {
  seq: number
  role: string
  text: string
}

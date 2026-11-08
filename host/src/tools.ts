/**
 * The tools this host contributes to every session.
 *
 * They exist for the same reason: a capability that belongs to the desktop rather than to the
 * engine, which the model can therefore only reach through a tool this host declares itself. The
 * terminal is the one such tool:
 *
 * - `workspace_terminal` is the agent's way to read or type into the terminal the *user* has open in
 *   this workspace - the shell, the server, the REPL that the engine's own shell tool cannot see,
 *   because that runs a shell of its own. The tool is declared here, and its execution is delegated
 *   to the application over the wire (`terminal_request` → `session_terminal_response`,
 *   `src-tauri/src/services/runtime/host/terminal.rs`), and the application answers it out of its own
 *   memory rather than through a page.
 *
 * Two facts make the shape what it is:
 *
 * - **The tool is the injection.** A tool the model never hears about is a tool it never calls, so
 *   the description below is the whole of "the agent knows this exists". A plugin that wants the
 *   agent to use it for its own service ships a `skills/` entry saying *when* (spec §16); the tools
 *   themselves are this application's, available in every session.
 * - **The answer is the truth.** The request is answered by the application once the action
 *   happened, so the model is told what happened, or the refusal's own code and message.
 */

import type { SessionEvents } from './events.ts'
import { isRecord } from './plugins-manifest.ts'
import type { CustomTool } from './sdk.ts'

/**
 * How long one application request waits for the answer before its tool call fails.
 *
 * One request is settled within one budget, end to end. The same number as the application's own
 * delivery deadline (`src-tauri/src/services/runtime/host/terminal.rs`, `ANSWER_TIMEOUT_MS`); they
 * are kept equal on purpose - a pair of numbers that differ only in how forgiving they are is a pair
 * that drifts, and the delivery deadline must not outlive this wait, or the application would log a
 * delivery the model has already stopped waiting for.
 */
const ANSWER_TIMEOUT_MS = 20_000

/**
 * How many application requests may wait at once, across every session.
 *
 * Owner / bound / release (`rules.md#resource-bounds-and-release-points`): the table is this module's, its ceiling is this
 * constant (a request that finds it full is refused rather than queued, because the model can retry
 * and a queue would only delay the same refusal), and every entry is released by the answer, by its
 * own timeout, or by the emit failing.
 */
const MAX_PENDING_REQUESTS = 32

/**
 * The event pipe one session publishes through, as a tool reaches it.
 *
 * The pipe is built from the session the SDK returns, so it exists one line after the tool is
 * registered - and the tool cannot be called before that, because a tool call belongs to a turn and
 * a turn belongs to a prompt this host only serves once the session is live.
 */
export interface SessionPipe {
  events: SessionEvents | null
  ownerSessionFile: string | null
}

/**
 * One terminal as `list` reports it: the id every later call addresses, the shell's own name, and
 * the directory it was started in.
 *
 * `label` is what the reader's tab reads as (`PowerShell-2`), when the page has named it: the number
 * in it belongs to that conversation's strip, so it is the only way "the one the user called
 * PowerShell-2" can be found among ids this process invented.
 */
export interface TerminalSummary {
  id: string
  shell: string
  label?: string
  cwd: string
  ownerSessionId?: string
  workspaceKey?: string
}

/** One terminal request waiting for the application, and the deadline that ends it. */
interface PendingTerminal {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const pendingTerminals = new Map<string, PendingTerminal>()
let sequence = 0

/**
 * Asks the application about the terminals the user has open in one directory, and answers with
 * what the action produced.
 *
 * The frame is composed here rather than in `dispatch.ts` because the answer is addressed to a
 * *tool call*, not to a command: the request id is this module's, and the answer finds its way back
 * through [`settleTerminal`]. One request out, one answer in, and the table is this module's own
 * (owner: this module; bound: `MAX_PENDING_REQUESTS`; release: the answer, the deadline, or the emit
 * failing).
 *
 * The request names the conversation that asked (`ownerSessionFile`) because the terminals belong to
 * it: the conversation on screen at that moment is not the answer.
 */
export function requestTerminal(
  pipe: SessionPipe,
  cwd: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const events = pipe.events
  if (events === null) {
    return Promise.reject(new Error('This session is not publishing yet, so the terminal was not read.'))
  }
  if (pendingTerminals.size >= MAX_PENDING_REQUESTS) {
    return Promise.reject(
      new Error(
        `Too many application requests are already waiting (${MAX_PENDING_REQUESTS}); try again once one has been answered.`,
      ),
    )
  }
  const id = `terminal-${(sequence += 1)}`
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  const timer = setTimeout(() => {
    pendingTerminals.delete(id)
    reject(new Error('The application did not answer the request about that terminal.'))
  }, ANSWER_TIMEOUT_MS)
  // A request nobody answered must not hold the process open on its way out.
  timer.unref?.()
  pendingTerminals.set(id, { resolve, reject, timer })
  try {
    events.emit({
      type: 'terminal_request',
      id,
      cwd,
      ownerSessionFile: pipe.ownerSessionFile,
      ...params,
    })
  } catch (error) {
    pendingTerminals.delete(id)
    clearTimeout(timer)
    reject(error instanceof Error ? error : new Error(String(error)))
  }
  return promise
}

/**
 * Settles the request one answer names, and answers whether a request was waiting for it.
 *
 * An answer nobody is waiting for is not an error: the request may have timed out a moment before
 * it arrived, and the desktop is owed a success for having sent it.
 */
export function settleTerminal(answer: Record<string, unknown>): boolean {
  const requestId = typeof answer.requestId === 'string' ? answer.requestId : ''
  const waiting = requestId === '' ? undefined : pendingTerminals.get(requestId)
  if (waiting === undefined) {
    return false
  }
  pendingTerminals.delete(requestId)
  clearTimeout(waiting.timer)
  if (answer.ok === true) {
    waiting.resolve(answer.result)
    return true
  }
  const code = typeof answer.code === 'string' && answer.code.length > 0 ? answer.code : 'unknown'
  const message = typeof answer.message === 'string' && answer.message.length > 0 ? answer.message : ''
  waiting.reject(
    new Error(message.length > 0 ? message : `The application refused that request (${code}).`),
  )
  return true
}

/** What the model is told about `workspace_terminal`. */
const TERMINAL_TOOL_DESCRIPTION = [
  'Work in the terminals of the conversation on screen in OMP Desktop’s work panel. A conversation may have several terminals; the user’s own tabs (their shell, a server, a REPL) are among them.',
  'Use it when the user asks to open a terminal, to see what their terminal printed, or to run something in it. Use the engine’s own shell tool instead for your own commands that do not need a shell the user can see.',
  '`action: "create"` starts a terminal and shows it in the work panel (opening the panel if it is closed). Use it whenever the user says "open a terminal"; do not ask them to open it by hand first. If a previous create left a background terminal, that one is reused rather than a new shell started.',
  '`action: "list"` answers which terminals this conversation has (id, shell, directory) and creates nothing.',
  'Each tab of the work panel reads as `<shell>-<number>`, numbered inside its own conversation (the first tab a conversation opens is `PowerShell-1`, the next `-2`, and a number comes back when its tab is closed). `list` prints that name beside the id — `PowerShell-2 (terminal-7)` — so a terminal the user names that way is the id in the brackets: use it, and do not invent a number.',
  '`action: "read"` answers the tail of one terminal’s output as plain text (escape sequences removed).',
  '`action: "write"` types into one terminal; the line is submitted unless `submit` is false.',
  'Set `show: false` on create to keep the terminal in the background without opening the panel. Optional `cols` and `rows` set its character grid (2-1000 each).',
  'Created terminals belong to this conversation and workspace and are reclaimed when that owner closes.',
].join(' ')

/** The name the model calls for this capability. */
export const WORKSPACE_TERMINAL_TOOL = 'workspace_terminal'

/** The one terminal a `read`/`write` call addresses, as the schema guarantees it. */
function terminalIdOf(params: unknown): string {
  if (typeof params !== 'object' || params === null || !('terminal' in params)) {
    return ''
  }
  return typeof params.terminal === 'string' ? params.terminal : ''
}

/**
 * One field of an answer the application composed, or `undefined` when it is not there.
 *
 * The answer is this application's own, but it crossed a process boundary as JSON: the field is
 * read only after the shape is narrowed, so nothing here asserts what it did not check.
 */
function answeredField(result: unknown, field: string): unknown {
  if (!isRecord(result) || !(field in result)) {
    return undefined
  }
  return result[field]
}

/** Whether one entry of a `list` answer is a terminal this side can name. */
function isTerminalSummary(value: unknown): value is TerminalSummary {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value.id === 'string' &&
    typeof value.shell === 'string' &&
    (value.label === undefined || typeof value.label === 'string') &&
    typeof value.cwd === 'string' &&
    (value.ownerSessionId === undefined || typeof value.ownerSessionId === 'string') &&
    (value.workspaceKey === undefined || typeof value.workspaceKey === 'string')
  )
}

/** What the model is shown for one answered action, and what a tool call records beside it. */
function describeTerminalResult(action: string, result: unknown): { text: string; details: Record<string, unknown> } {
  const terminal = answeredField(result, 'terminal')
  if (action === 'list') {
    const raw = answeredField(result, 'terminals')
    const terminals = Array.isArray(raw) ? raw.filter(isTerminalSummary) : []
    if (terminals.length === 0) {
      return {
        text: 'This conversation has no terminal yet. Use action "create" to open one in the work panel.',
        details: { action, terminals: [] },
      }
    }
    const lines = terminals.map(
      (entry) => `- ${entry.label ?? entry.shell} (${entry.id}) in ${entry.cwd}`,
    )
    return {
      text: `Terminals in this conversation:\n${lines.join('\n')}`,
      details: { action, terminals },
    }
  }
  if (action === 'read') {
    const text = answeredField(result, 'text')
    const printed = typeof text === 'string' ? text : ''
    return {
      text: printed.length > 0 ? printed : `(${typeof terminal === 'string' ? terminal : 'That terminal'} has printed nothing yet.)`,
      details: { action, terminal, bytes: printed.length },
    }
  }
  if (action === 'create') {
    const summary = isTerminalSummary(answeredField(result, 'terminal'))
      ? answeredField(result, 'terminal')
      : result
    if (!isTerminalSummary(summary)) {
      return { text: 'Opened a terminal.', details: { action, terminal: summary } }
    }
    const reused = answeredField(result, 'reused') === true
    const name = `${summary.label ?? summary.shell} (${summary.id})`
    return {
      text: reused
        ? `Reused background terminal ${name} in ${summary.cwd} and showed it in the work panel.`
        : `Started ${name} in ${summary.cwd} and showed it in the work panel.`,
      details: { action, terminal: summary, reused },
    }
  }
  const bytes = answeredField(result, 'bytes')
  const written = typeof bytes === 'number' ? bytes : 0
  return {
    text: `Typed ${written} bytes into ${typeof terminal === 'string' ? terminal : 'the terminal'}.`,
    details: { action, terminal, bytes: written },
  }
}

/**
 * The `workspace_terminal` tool, built for one session.
 *
 * The workspace is captured when the session is created rather than read per call: the session's
 * own directory is the one its terminals were started in, and the application matches a terminal by
 * where it runs, not by an id the page invented.
 */
export function workspaceTerminalTool(pipe: SessionPipe, cwd: string): CustomTool {
  return {
    name: WORKSPACE_TERMINAL_TOOL,
    label: 'Workspace terminal',
    description: TERMINAL_TOOL_DESCRIPTION,
    loadMode: 'essential',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'write', 'create'],
          description: 'What to do with the user’s terminal.',
        },
        terminal: {
          type: 'string',
          description: 'The id `list` reported. Required for `read` and `write`.',
        },
        input: {
          type: 'string',
          description: 'The text to type. Required for `write`.',
        },
        submit: {
          type: 'boolean',
          description: 'Whether to press Enter after the text (default true).',
        },
        limit: {
          type: 'number',
          description: 'How many bytes of output to read back (default 16384, maximum 65536).',
        },
        cols: {
          type: 'integer',
          minimum: 2,
          maximum: 1000,
          description: 'Optional terminal width for create (2-1000).',
        },
        rows: {
          type: 'integer',
          minimum: 2,
          maximum: 1000,
          description: 'Optional terminal height for create (2-1000).',
        },
        show: {
          type: 'boolean',
          description: 'Show/open the terminal in the UI (default true).',
        },
        openUi: {
          type: 'boolean',
          description: 'Alias for show (default true).',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const action = answeredField(params, 'action')
      const request: Record<string, unknown> = { action }
      if (action === 'read' || action === 'write') {
        request.terminal = terminalIdOf(params)
      }
      if (action === 'write') {
        const input = answeredField(params, 'input')
        request.input = typeof input === 'string' ? input : ''
        const submit = answeredField(params, 'submit')
        if (typeof submit === 'boolean') {
          request.submit = submit
        }
      }
      if (action === 'read') {
        const limit = answeredField(params, 'limit')
        if (typeof limit === 'number') {
          request.limit = limit
        }
      }
      if (action === 'create') {
        const show = answeredField(params, 'show')
        const openUi = answeredField(params, 'openUi')
        if (typeof show === 'boolean') request.show = show
        else if (typeof openUi === 'boolean') request.openUi = openUi
        for (const dimension of ['cols', 'rows'] as const) {
          const value = answeredField(params, dimension)
          if (value !== undefined) {
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 2 || value > 1000) {
              throw new Error(`${dimension} must be an integer between 2 and 1000.`)
            }
            request[dimension] = value
          }
        }
      }
      const result = await requestTerminal(pipe, cwd, request)
      const described = describeTerminalResult(typeof action === 'string' ? action : '', result)
      return {
        content: [{ type: 'text', text: described.text }],
        details: described.details,
      }
    },
  }
}

/**
 * The browser lane's pending table: one `browser_request` out, one `session_browser_response` in.
 *
 * Separate from the terminal's table because the two actions have different budgets: a DevTools
 * round trip may take 30 s on the desktop, so a browser request waits longer than a pty read. The
 * table's owner, ceiling and release rules are the terminal's (`MAX_PENDING_REQUESTS`).
 */
interface PendingBrowser {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const pendingBrowsers = new Map<string, PendingBrowser>()
let browserSequence = 0

/** How long one browser request waits: the desktop's own answer budget. */
const BROWSER_ANSWER_TIMEOUT_MS = 65_000

/**
 * Ask the application to act on one browser page, and answer with what the action produced.
 *
 * The frame names the conversation (`ownerSessionFile`), its working directory (for the workspace
 * root a local preview resolves against), and the action's own fields. The application resolves the
 * page from the *routed session*, never from the frame's own word, so a request cannot name another
 * conversation's page.
 */
export function requestBrowser(
  pipe: SessionPipe,
  cwd: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const events = pipe.events
  if (events === null) {
    return Promise.reject(new Error('This session is not publishing yet, so the browser was not used.'))
  }
  if (pendingBrowsers.size >= MAX_PENDING_REQUESTS) {
    return Promise.reject(
      new Error(
        `Too many application requests are already waiting (${MAX_PENDING_REQUESTS}); try again once one has been answered.`,
      ),
    )
  }
  const id = `browser-${(browserSequence += 1)}`
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  const timer = setTimeout(() => {
    pendingBrowsers.delete(id)
    reject(new Error('The application did not answer the browser request.'))
  }, BROWSER_ANSWER_TIMEOUT_MS)
  timer.unref?.()
  pendingBrowsers.set(id, { resolve, reject, timer })
  try {
    events.emit({
      type: 'browser_request',
      id,
      cwd,
      ownerSessionFile: pipe.ownerSessionFile,
      ...params,
    })
  } catch (error) {
    pendingBrowsers.delete(id)
    clearTimeout(timer)
    reject(error instanceof Error ? error : new Error(String(error)))
  }
  return promise
}

/** Settle the browser request one answer names; answers whether one was waiting. */
export function settleBrowser(answer: Record<string, unknown>): boolean {
  const requestId = typeof answer.requestId === 'string' ? answer.requestId : ''
  const waiting = requestId === '' ? undefined : pendingBrowsers.get(requestId)
  if (waiting === undefined) {
    return false
  }
  pendingBrowsers.delete(requestId)
  clearTimeout(waiting.timer)
  if (answer.ok === true) {
    waiting.resolve(answer.result)
    return true
  }
  const code = typeof answer.code === 'string' && answer.code.length > 0 ? answer.code : 'unknown'
  const message = typeof answer.message === 'string' && answer.message.length > 0 ? answer.message : ''
  waiting.reject(new Error(message.length > 0 ? message : `The application refused that request (${code}).`))
  return true
}

/** What the model is told about `Browser`. */
const BROWSER_TOOL_DESCRIPTION = [
  'Read or drive the work-panel browser page of this conversation.',
  'If no page is connected, navigate first; the first page is opened with its tab.',
  'Snapshot first, then click or fill: a snapshot uid goes stale once the page changes.',
  'Actions: navigate, snapshot, screenshot, click, fill, evaluate, console, cdp.',
  'evaluate runs page JavaScript; cdp returns the unmodified protocol result.',
  'A workspace HTML file opens through BrowserPreview, not navigate.',
].join(' ')

/** The actions `Browser` offers. */
const BROWSER_ACTIONS = [
  'navigate',
  'snapshot',
  'screenshot',
  'click',
  'fill',
  'evaluate',
  'console',
  'cdp',
] as const

/** Read-only actions that stay available in Plan and Goal modes. */
const BROWSER_PLAN_SAFE = new Set<string>(['navigate', 'snapshot', 'screenshot', 'console'])

/** The name the model calls for the page-driving tool. */
export const BROWSER_TOOL = 'Browser'

/** The name the model calls for a local HTML preview. */
export const BROWSER_PREVIEW_TOOL = 'BrowserPreview'

/** One block of a browser answer: text, or the picture a screenshot produced. */
type BrowserContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/** One text block for a browser answer, plus an image when a screenshot produced one. */
function browserResult(
  action: string,
  result: unknown,
): { content: BrowserContent[]; details: Record<string, unknown> } {
  const record = isRecord(result) ? result : {}
  if (action === 'snapshot') {
    const tree = typeof record.tree === 'string' ? record.tree : '(empty)'
    return {
      content: [{ type: 'text', text: tree }],
      details: { action, url: record.url, title: record.title },
    }
  }
  if (action === 'screenshot') {
    const data = typeof record.data === 'string' ? record.data : ''
    const mimeType = typeof record.mimeType === 'string' ? record.mimeType : 'image/jpeg'
    const path = typeof record.path === 'string' ? record.path : undefined
    return {
      content: [
        { type: 'text', text: path ? `Captured screenshot (${mimeType}) saved at ${path}.` : `Captured screenshot (${mimeType}).` },
        ...(data ? [{ type: 'image' as const, data, mimeType }] : []),
      ],
      details: { action, mimeType, path },
    }
  }
  if (action === 'evaluate') {
    return {
      content: [{ type: 'text', text: JSON.stringify(record.value ?? null) }],
      details: { action },
    }
  }
  if (action === 'console') {
    const messages = Array.isArray(record.messages) ? record.messages : []
    const text = messages
      .map((message) => {
        if (!isRecord(message)) return ''
        return `[${String(message.type ?? 'log')}] ${String(message.text ?? '')}`
      })
      .filter(Boolean)
      .join('\n')
    return {
      content: [{ type: 'text', text: text.length > 0 ? text : '(no console messages)' }],
      details: { action, messages },
    }
  }
  if (action === 'cdp') {
    return {
      content: [{ type: 'text', text: JSON.stringify(record.result ?? null) }],
      details: { action },
    }
  }
  if (action === 'navigate') {
    const state = isRecord(record.state) ? record.state : null
    if (state && typeof state.loadError === 'string') {
      return {
        content: [{ type: 'text', text: `Could not open that address: ${state.loadError}` }],
        details: { action, state },
      }
    }
    const url = state && typeof state.url === 'string' ? state.url : ''
    return {
      content: [{ type: 'text', text: url ? `Navigated to ${url}.` : 'Opened the Browser tab.' }],
      details: { action, state },
    }
  }
  return {
    content: [{ type: 'text', text: `${action} completed.` }],
    details: { action, ...record },
  }
}

/**
 * The `Browser` tool: drive this conversation's page through the desktop's in-process DevTools.
 *
 * Every action goes through the application (`requestBrowser`); this file only shapes the request
 * and the answer. The tool never names a page: the desktop resolves the page of the session that
 * routed the call.
 */
export function browserTool(pipe: SessionPipe, cwd: string): CustomTool {
  return {
    name: BROWSER_TOOL,
    label: 'Browser',
    description: BROWSER_TOOL_DESCRIPTION,
    loadMode: 'essential',
    approval: (args) => {
      const action = isRecord(args) && typeof args.action === 'string' ? args.action : ''
      return BROWSER_PLAN_SAFE.has(action) ? 'read' : 'exec'
    },
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...BROWSER_ACTIONS],
          description: "Action on this session's connected Browser page.",
        },
        url: { type: 'string', description: 'http(s) URL for navigate.' },
        path: { type: 'string', description: 'Workspace HTML file for navigate.' },
        uid: { type: 'string', description: 'Snapshot uid for click/fill.' },
        text: { type: 'string', description: 'Text for fill.' },
        expression: { type: 'string', description: 'JavaScript for evaluate.' },
        method: { type: 'string', description: 'Allowlisted CDP method for cdp.' },
        params: { type: 'object', description: 'CDP parameters for cdp.' },
        fullPage: { type: 'boolean', description: 'Capture the full page.' },
        limit: { type: 'number', description: 'Max console messages.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const input = isRecord(params) ? params : {}
      const action = typeof input.action === 'string' ? input.action.trim() : ''
      if (!BROWSER_ACTIONS.includes(action as (typeof BROWSER_ACTIONS)[number])) {
        throw new Error(`unknown action "${action}"; use ${BROWSER_ACTIONS.join(', ')}`)
      }
      const request: Record<string, unknown> = { action }
      if (action === 'navigate') {
        if (typeof input.url === 'string' && input.url.trim()) request.url = input.url.trim()
        if (typeof input.path === 'string' && input.path.trim()) request.path = input.path.trim()
      }
      if (action === 'click' || action === 'fill') {
        request.uid = typeof input.uid === 'string' ? input.uid : ''
      }
      if (action === 'fill') request.text = typeof input.text === 'string' ? input.text : ''
      if (action === 'evaluate') request.expression = typeof input.expression === 'string' ? input.expression : ''
      if (action === 'cdp') {
        request.method = typeof input.method === 'string' ? input.method : ''
        if (isRecord(input.params)) request.params = input.params
      }
      if (action === 'screenshot' && input.fullPage === true) request.fullPage = true
      if (action === 'console' && typeof input.limit === 'number') request.limit = input.limit
      const result = await requestBrowser(pipe, cwd, request)
      const described = browserResult(action, result)
      return {
        content: described.content,
        details: described.details,
      }
    },
  }
}

/**
 * The `BrowserPreview` tool: open one workspace HTML file in a live-reloading Browser tab.
 *
 * The file is resolved by the desktop against the session's project and scratch roots; this side
 * only names the path the model asked for, and the desktop's answer is the refusal when it does not
 * resolve.
 */
export function browserPreviewTool(pipe: SessionPipe, cwd: string): CustomTool {
  return {
    name: BROWSER_PREVIEW_TOOL,
    label: 'Browser preview',
    description: [
      'Open a workspace HTML file in a new live-reloading Browser tab.',
      'The path must resolve to an existing file in the project or session scratch directory.',
    ].join(' '),
    loadMode: 'essential',
    approval: 'read',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or absolute HTML file path.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const path = isRecord(params) && typeof params.path === 'string' ? params.path.trim() : ''
      if (!path) throw new Error('BrowserPreview: `path` is required.')
      const result = await requestBrowser(pipe, cwd, { action: 'preview', path })
      const record = isRecord(result) ? result : {}
      const state = isRecord(record.state) ? record.state : null
      const url = state && typeof state.url === 'string' ? state.url : path
      return {
        content: [
          {
            type: 'text' as const,
            text: `Opened a new Browser tab for ${path}. Its page stays available in the background, and live reload updates it when the file or sibling assets change. (${url})`,
          },
        ],
        details: { action: 'preview', tabId: record.tabId, state },
      }
    },
  }
}

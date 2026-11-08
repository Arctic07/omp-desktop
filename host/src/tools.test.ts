/**
 * The lane the agent's application-bound tool rides on: one request out, one answer in, and the
 * table that pairs them.
 *
 * What is under test is the half that lives in this process - a request is refused before a frame is
 * composed when the session is not publishing, an answer settles exactly the request it names, and
 * an answer nobody is waiting for is not an error. The other half (the desktop reading and typing
 * into a pty) is tested where it lives (`src-tauri`).
 *
 * Run: `pnpm --filter omp-host test` (bun is the host's runtime, so bun runs these).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SessionEvents, type SessionEventWriter } from './events.ts'
import {
  browserPreviewTool,
  browserTool,
  requestBrowser,
  requestTerminal,
  settleBrowser,
  settleTerminal,
  workspaceTerminalTool,
  type SessionPipe,
} from './tools.ts'
import type { CustomTool } from './sdk.ts'

/**
 * One tool call, as these tests make it.
 *
 * The engine hands `execute` the call's context and a streaming callback; no tool here reads either,
 * and neither is fakeable without a whole session - so the two arguments this file does not care
 * about are left to the engine, and the call is typed as the two arguments it does.
 */
function execute(tool: CustomTool, params: Record<string, unknown>): Promise<{ content: readonly { type: string; text?: string }[] }> {
  const call = tool.execute as unknown as (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: readonly { type: string; text?: string }[] }>
  return call('call-1', params)
}

/** A pipe with no event channel: the state a session is in before `createAgentSession` returns. */
const silent: SessionPipe = { events: null, ownerSessionFile: null }

/** A session's outbound pipe that keeps what it published, so a frame's own fields can be read. */
function recording(): { pipe: SessionPipe; frames: Record<string, unknown>[]; flush: () => Promise<void> } {
  const frames: Record<string, unknown>[] = []
  const writer: SessionEventWriter = {
    congested: false,
    // The pipe hands the writer the line it wrote, which is what a reader parses back: these tests
    // read the frame's own fields, so they parse it the way the desktop does.
    sendLine: line => {
      frames.push(JSON.parse(line) as Record<string, unknown>)
    },
    flush: async () => {},
  }
  const events = new SessionEvents('s1', writer, () => {}, () => {})
  return { pipe: { events, ownerSessionFile: 'D:/agent/sessions/s1.jsonl' }, frames, flush: () => events.flush() }
}

test('a session that is not publishing yet is refused rather than left waiting', async () => {
  await assert.rejects(
    () => requestTerminal(silent, 'D:\\project', { action: 'list' }),
    /not publishing yet/,
  )
})

test('one answer settles the request it names, with what the action produced', async () => {
  const { pipe, frames, flush } = recording()
  const answer = requestTerminal(pipe, 'D:\\project', { action: 'list' })
  // The pipe queues and publishes on its own tick, exactly as it does for every other frame.
  await flush()

  assert.equal(frames.length, 1, 'the request is one frame')
  const request = frames[0]!
  assert.equal(request.type, 'terminal_request')
  assert.equal(request.cwd, 'D:\\project')
  assert.equal(request.action, 'list')
  const id = request.id
  assert.equal(typeof id, 'string')

  const settled = settleTerminal({
    requestId: id,
    ok: true,
    result: { terminals: [{ id: 'terminal-3', shell: 'PowerShell', cwd: 'D:\\project' }] },
  })
  assert.equal(settled, true, 'a request was waiting for it')
  assert.deepEqual(await answer, {
    terminals: [{ id: 'terminal-3', shell: 'PowerShell', cwd: 'D:\\project' }],
  })
  // The table released it: the same answer again settles nothing.
  assert.equal(settleTerminal({ requestId: id, ok: true, result: {} }), false)
})

test('create forwards its terminal dimensions', async () => {
  const { pipe, frames, flush } = recording()
  const answer = requestTerminal(pipe, 'D:\\project', { action: 'create', cols: 120, rows: 40 })
  await flush()

  assert.equal(frames[0]!.action, 'create')
  assert.equal(frames[0]!.cols, 120)
  assert.equal(frames[0]!.rows, 40)
  const id = frames[0]!.id
  assert.equal(settleTerminal({
    requestId: id,
    ok: true,
    result: {
      terminal: {
        id: 'terminal-4',
        shell: 'PowerShell',
        cwd: 'D:\\project',
        ownerSessionId: 'session-1',
        workspaceKey: 'D:\\project',
      },
    },
  }), true)
  assert.deepEqual(await answer, {
    terminal: {
      id: 'terminal-4',
      shell: 'PowerShell',
      cwd: 'D:\\project',
      ownerSessionId: 'session-1',
      workspaceKey: 'D:\\project',
    },
  })
})

test('create defaults to showing the terminal and accepts an explicit hidden request', async () => {
  for (const params of [{ action: 'create' }, { action: 'create', show: false }, { action: 'create', openUi: false }]) {
    const { pipe, frames, flush } = recording()
    const answer = requestTerminal(pipe, 'D:\\project', params)
    await flush()
    assert.equal(frames[0]!.action, 'create')
    if ('show' in params) assert.equal(frames[0]!.show, false)
    if ('openUi' in params) assert.equal(frames[0]!.openUi, false)
    const id = frames[0]!.id
    assert.equal(settleTerminal({ requestId: id, ok: true, result: { terminal: { id: 'terminal-5', shell: 'PowerShell', cwd: 'D:\\project' } } }), true)
    await answer
  }
})

test('a refusal rejects with the application’s own words', async () => {
  const { pipe, frames, flush } = recording()
  const answer = requestTerminal(pipe, 'D:\\project', { action: 'read', terminal: 'terminal-9' })
  await flush()
  const id = frames[0]!.id

  assert.equal(
    settleTerminal({
      requestId: id,
      ok: false,
      code: 'TERMINAL_NOT_FOUND',
      message: 'That terminal is not open.',
    }),
    true,
  )
  await assert.rejects(() => answer, /That terminal is not open\./)
})

test('an answer nobody is waiting for is not an error', () => {
  // A request that timed out a moment before its answer arrived: the desktop is owed a success for
  // having sent it, and the tool call it belonged to is already settled.
  assert.equal(settleTerminal({ requestId: 'terminal-404', ok: true, result: {} }), false)
  assert.equal(settleTerminal({ ok: true }), false)
})

test('a create answer that reused the open terminal says so rather than claiming a new shell', async () => {
  const { pipe, frames, flush } = recording()
  const answer = requestTerminal(pipe, 'D:\project', { action: 'create' })
  await flush()
  const id = frames[0]!.id
  assert.equal(
    settleTerminal({
      requestId: id,
      ok: true,
      result: {
        terminal: { id: 'terminal-7', shell: 'PowerShell', cwd: 'D:\project' },
        reused: true,
      },
    }),
    true,
  )
  assert.deepEqual(await answer, {
    terminal: { id: 'terminal-7', shell: 'PowerShell', cwd: 'D:\project' },
    reused: true,
  })
})

test('the list names each tab as the reader sees it, beside the id that addresses it', async () => {
  const { pipe, frames, flush } = recording()
  const tool = workspaceTerminalTool(pipe, 'D:\\project')
  const run = execute(tool, { action: 'list' })
  await flush()
  assert.equal(
    settleTerminal({
      requestId: frames[0]!.id,
      ok: true,
      result: {
        terminals: [
          { id: 'terminal-7', shell: 'PowerShell', label: 'PowerShell-2', cwd: 'D:\\project' },
          // A shell whose tab this page has not named yet: the shell's own name stands in.
          { id: 'terminal-8', shell: 'cmd', cwd: 'D:\\project' },
        ],
      },
    }),
    true,
  )
  const answered = await run
  const text = answered.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  assert.match(text, /^- PowerShell-2 \(terminal-7\) in D:\\project$/m)
  assert.match(text, /^- cmd \(terminal-8\) in D:\\project$/m)
})

test('a browser request is one frame, and its answer settles exactly that request', async () => {
  const { pipe, frames, flush } = recording()
  const answer = requestBrowser(pipe, 'D:\\project', { action: 'snapshot' })
  await flush()
  const frame = frames.find((entry) => entry.type === 'browser_request')
  assert.ok(frame, 'the request reached the wire')
  assert.equal(frame.action, 'snapshot')
  assert.equal(frame.cwd, 'D:\\project')
  assert.equal(frame.ownerSessionFile, 'D:/agent/sessions/s1.jsonl')
  assert.equal(settleBrowser({ requestId: frame.id, ok: true, result: { tree: '- e1 Generic' } }), true)
  assert.deepEqual(await answer, { tree: '- e1 Generic' })
  assert.equal(settleBrowser({ requestId: frame.id, ok: true }), false, 'one answer, one settlement')
})

test('a refused browser request carries the refusal to the tool', async () => {
  const { pipe, frames, flush } = recording()
  const answer = requestBrowser(pipe, 'D:\\project', { action: 'snapshot' })
  await flush()
  const frame = frames.find((entry) => entry.type === 'browser_request')
  assert.ok(frame)
  settleBrowser({ requestId: frame.id, ok: false, code: 'BROWSER_UNAVAILABLE', message: 'No page.' })
  await assert.rejects(() => answer, /No page\./)
})

test('the Browser tool sends the action and its fields', async () => {
  const { pipe, frames, flush } = recording()
  const tool = browserTool(pipe, 'D:\\project')
  const pending = execute(tool, { action: 'navigate', url: 'https://example.com' })
  await flush()
  const frame = frames.find((entry) => entry.type === 'browser_request')
  assert.ok(frame)
  assert.equal(frame.action, 'navigate')
  assert.equal(frame.url, 'https://example.com')
  settleBrowser({ requestId: frame.id, ok: true, result: { state: { url: 'https://example.com/' } } })
  const result = await pending
  assert.match(result.content[0]?.text ?? '', /Navigated to https:\/\/example\.com\//)
})

test('the BrowserPreview tool requires a path', async () => {
  const tool = browserPreviewTool(silent, 'D:\\project')
  await assert.rejects(() => execute(tool, { path: '  ' }), /path.*required/i)
})

test('BrowserPreview asks the desktop to resolve and open a workspace file', async () => {
  const { pipe, frames, flush } = recording()
  const tool = browserPreviewTool(pipe, 'D:\\project')
  const pending = execute(tool, { path: 'dist/index.html' })
  await flush()
  const frame = frames.find((entry) => entry.type === 'browser_request')
  assert.ok(frame)
  assert.equal(frame.action, 'preview')
  assert.equal(frame.path, 'dist/index.html')
  settleBrowser({
    requestId: frame.id,
    ok: true,
    result: { tabId: 'tab-1', state: { url: 'file:///D:/project/dist/index.html' } },
  })
  const result = await pending
  assert.match(result.content[0]?.text ?? '', /Opened a new Browser tab for dist\/index\.html/)
})

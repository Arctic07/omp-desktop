import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'

import {
  WriteGuard,
  guardToolCall,
  guardToolResult,
  guardTurnEnd,
  writeGuardExtension,
} from './write-guard.ts'

/**
 * The cross-conversation write guard.
 *
 * The cases below are the ones that decide whether the guard saves an edit or merely annoys a
 * model: a write from a view another conversation has already invalidated is refused; a write
 * after re-reading, a first write, and a session's own follow-up write are not.
 */

const CWD = path.resolve('/repo')

/** One `write` call naming `file`, as the engine hands it to an extension. */
function writeCall(toolCallId: string, file: string): ToolCallEvent {
  return { type: 'tool_call', toolName: 'write', toolCallId, input: { path: file } }
}

/** One `read` call naming `file`. */
function readCall(toolCallId: string, file: string): ToolCallEvent {
  return { type: 'tool_call', toolName: 'read', toolCallId, input: { path: file } }
}

/** One targeted `edit` call naming `file` (the engine checks its content tag itself). */
function editCall(toolCallId: string, file: string): ToolCallEvent {
  return { type: 'tool_call', toolName: 'edit', toolCallId, input: { path: file } }
}

/** A successful `write` result for `toolCallId`. */
function writeOk(toolCallId: string, file: string): ToolResultEvent {
  return {
    type: 'tool_result',
    toolName: 'write',
    toolCallId,
    input: { path: file },
    content: [],
    isError: false,
    details: undefined,
  }
}

/** A successful result for an `edit` or `apply_patch` call. */
function patchOk(toolCallId: string, file: string, toolName = 'edit'): ToolResultEvent {
  return { ...writeOk(toolCallId, file), toolName }
}

/** A failed `write` result for `toolCallId`. */
function writeFailed(toolCallId: string, file: string): ToolResultEvent {
  return { ...writeOk(toolCallId, file), isError: true }
}

/** Runs one guarded write, answering whether the guard blocked it. */
function writeBlocked(guard: WriteGuard, session: string, call: ToolCallEvent): boolean {
  const result = guardToolCall(guard, session, CWD, call)
  return result?.block === true
}

test('refuses a write from a view another conversation has already invalidated', () => {
  const guard = new WriteGuard()
  guardToolCall(guard, 'a', CWD, readCall('r1', 'src/app.ts'))
  guardToolCall(guard, 'b', CWD, writeCall('w1', 'src/app.ts'))
  guardToolResult(guard, 'b', writeOk('w1', 'src/app.ts'))

  const result = guardToolCall(guard, 'a', CWD, writeCall('w2', 'src/app.ts'))
  assert.equal(result?.block, true)
  assert.match(result?.reason ?? '', /src\/app\.ts/)
  assert.match(result?.reason ?? '', /another conversation/i)
})

test('allows the write once the stale session has read the file again', () => {
  const guard = new WriteGuard()
  guardToolCall(guard, 'a', CWD, readCall('r1', 'src/app.ts'))
  guardToolCall(guard, 'b', CWD, writeCall('w1', 'src/app.ts'))
  guardToolResult(guard, 'b', writeOk('w1', 'src/app.ts'))
  assert.equal(writeBlocked(guard, 'a', writeCall('w2', 'src/app.ts')), true)

  guardToolCall(guard, 'a', CWD, readCall('r2', 'src/app.ts'))
  assert.equal(writeBlocked(guard, 'a', writeCall('w3', 'src/app.ts')), false)
})

test('a ranged read clears stale-ness for the file it reads', () => {
  // Every way the read tool spells a window, including the compound ones.
  for (const selector of ['10', '10-20', '-60', 'raw', 'raw:2-4', '5-16,960-973', '1h5m42s']) {
    const guard = new WriteGuard()
    guardToolCall(guard, 'a', CWD, readCall('r1', 'src/app.ts'))
    guardToolCall(guard, 'b', CWD, writeCall('w1', 'src/app.ts'))
    guardToolResult(guard, 'b', writeOk('w1', 'src/app.ts'))
    assert.equal(writeBlocked(guard, 'a', writeCall('w2', 'src/app.ts')), true, selector)

    guardToolCall(guard, 'a', CWD, readCall('r2', `src/app.ts:${selector}`))
    // A targeted edit needs the current version, not the whole file; the selector names the file.
    assert.equal(
      guardToolCall(guard, 'a', CWD, editCall('e1', 'src/app.ts')),
      undefined,
      `a read of :${selector} is a read of the file`,
    )
  }
})

test('a ranged read of a drive path still names the file', () => {
  const guard = new WriteGuard()
  const drive = 'C:\\repo\\src\\app.ts'
  guardToolCall(guard, 'a', CWD, readCall('r1', drive))
  guardToolCall(guard, 'b', CWD, writeCall('w1', drive))
  guardToolResult(guard, 'b', writeOk('w1', drive))
  assert.equal(writeBlocked(guard, 'a', writeCall('w2', drive)), true)

  guardToolCall(guard, 'a', CWD, readCall('r2', `${drive}:10-20`))
  // The range read names the same file (a targeted edit is allowed); a whole-file overwrite would
  // still need the whole current file.
  assert.equal(guardToolCall(guard, 'a', CWD, editCall('e1', drive)), undefined)
  guardToolResult(guard, 'a', patchOk('e1', drive))
  guardToolCall(guard, 'a', CWD, readCall('r3', drive))
  assert.equal(writeBlocked(guard, 'a', writeCall('w3', drive)), false)
})

test('a whole-file write needs a whole view at the current version', () => {
  const guard = new WriteGuard()
  guardToolCall(guard, 'a', CWD, readCall('r1', 'src/app.ts'))
  guardToolCall(guard, 'b', CWD, writeCall('w1', 'src/app.ts'))
  guardToolResult(guard, 'b', writeOk('w1', 'src/app.ts'))

  // A range read proves the version, not the lines it did not show; overwriting every line from
  // memory would drop the other conversation's change.
  guardToolCall(guard, 'a', CWD, readCall('r2', 'src/app.ts:10-20'))
  const blocked = guardToolCall(guard, 'a', CWD, writeCall('w2', 'src/app.ts'))
  assert.equal(blocked?.block, true)
  assert.match(blocked?.reason ?? '', /whole/)

  // Reading it whole clears the refusal.
  guardToolCall(guard, 'a', CWD, readCall('r3', 'src/app.ts'))
  assert.equal(writeBlocked(guard, 'a', writeCall('w3', 'src/app.ts')), false)
})

test('a targeted edit is allowed after a range read', () => {
  const guard = new WriteGuard()
  guardToolCall(guard, 'a', CWD, readCall('r1', 'src/app.ts'))
  guardToolCall(guard, 'b', CWD, writeCall('w1', 'src/app.ts'))
  guardToolResult(guard, 'b', writeOk('w1', 'src/app.ts'))
  guardToolCall(guard, 'a', CWD, readCall('r2', 'src/app.ts:10-20'))

  // The engine's hashline check protects the parts the patch does not touch.
  assert.equal(guardToolCall(guard, 'a', CWD, editCall('e1', 'src/app.ts')), undefined)
})

test('`raw` is a whole view; a range combined with raw is still a window', () => {
  for (const [selector, whole] of [
    ['raw', true],
    ['raw:2-4', false],
    ['10-20:raw', false],
    ['-60', false],
  ] as const) {
    const guard = new WriteGuard()
    guardToolCall(guard, 'a', CWD, readCall('r1', 'src/app.ts'))
    guardToolCall(guard, 'b', CWD, writeCall('w1', 'src/app.ts'))
    guardToolResult(guard, 'b', writeOk('w1', 'src/app.ts'))
    guardToolCall(guard, 'a', CWD, readCall('r2', `src/app.ts:${selector}`))
    const blocked = writeBlocked(guard, 'a', writeCall('w2', 'src/app.ts'))
    assert.equal(!blocked, whole, `:${selector} is ${whole ? 'whole' : 'a window'}`)
  }
})

test('a write in flight blocks another conversation until it lands', () => {
  const guard = new WriteGuard()
  guardToolCall(guard, 'a', CWD, readCall('r1', 'src/app.ts'))
  guardToolCall(guard, 'b', CWD, writeCall('w1', 'src/app.ts'))
  assert.equal(guard.sizesForTest().inflight, 1)

  const blocked = guardToolCall(guard, 'a', CWD, writeCall('w2', 'src/app.ts'))
  assert.equal(blocked?.block, true)
  assert.match(blocked?.reason ?? '', /writing/)

  guardToolResult(guard, 'b', writeOk('w1', 'src/app.ts'))
  assert.equal(guard.sizesForTest().inflight, 0)
  guardToolCall(guard, 'a', CWD, readCall('r2', 'src/app.ts'))
  assert.equal(writeBlocked(guard, 'a', writeCall('w3', 'src/app.ts')), false)
})

test('forgetting a conversation releases the write it left in flight', () => {
  const guard = new WriteGuard()
  guardToolCall(guard, 'b', CWD, writeCall('w1', 'src/app.ts'))
  assert.equal(guard.sizesForTest().inflight, 1)

  guard.forget('b')
  assert.equal(guard.sizesForTest().inflight, 0)
})

test('keys a file through a junction to the same file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-guard-'))
  try {
    const real = path.join(root, 'real')
    fs.mkdirSync(real)
    const file = path.join(real, 'app.ts')
    fs.writeFileSync(file, 'initial')
    const alias = path.join(root, 'alias')
    try {
      fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return // no privilege for the link: the plain-resolution cases above still hold
    }
    const seen = path.join(alias, 'app.ts')
    const guard = new WriteGuard()
    guardToolCall(guard, 'a', root, readCall('r1', seen))
    // B has to read the file before a whole-file write now: an existing file it never saw is
    // refused (`unread`), which is the blind-overwrite rule.
    guardToolCall(guard, 'b', root, readCall('r2', file))
    guardToolCall(guard, 'b', root, writeCall('w1', file))
    fs.writeFileSync(file, 'changed')
    guardToolResult(guard, 'b', writeOk('w1', file))
    assert.equal(writeBlocked(guard, 'a', writeCall('w2', seen)), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** A temp directory and one file in it, for the cases that need real bytes. */
function realFile(contents = 'one\ntwo\nthree\n'): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-guard-'))
  const file = path.join(root, 'app.ts')
  fs.writeFileSync(file, contents)
  return { root, file }
}

test('a change made outside the tools is seen by the byte fingerprint', () => {
  const { root, file } = realFile()
  try {
    const guard = new WriteGuard()
    guardToolCall(guard, 'a', root, readCall('r1', file))
    // A command, an editor or a subagent writes the file; the guard was never told.
    fs.writeFileSync(file, 'changed outside\n')
    const blocked = guardToolCall(guard, 'a', root, writeCall('w1', file))
    assert.equal(blocked?.block, true)
    assert.match(blocked?.reason ?? '', /changed on disk/)

    // A whole re-read is the way out.
    guardToolCall(guard, 'a', root, readCall('r2', file))
    assert.equal(writeBlocked(guard, 'a', writeCall('w2', file)), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an existing file that was never read is not overwritten blind', () => {
  const { root, file } = realFile()
  try {
    const guard = new WriteGuard()
    const blocked = guardToolCall(guard, 'a', root, writeCall('w1', file))
    assert.equal(blocked?.block, true)
    assert.match(blocked?.reason ?? '', /has not read it/)

    guardToolCall(guard, 'a', root, readCall('r1', file))
    assert.equal(writeBlocked(guard, 'a', writeCall('w2', file)), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a same-content rewrite does not lock the file', () => {
  const { root, file } = realFile()
  try {
    const guard = new WriteGuard()
    guardToolCall(guard, 'a', root, readCall('r1', file))
    // B writes the very same bytes: a version bump, no content change, no reason to refuse A.
    guardToolCall(guard, 'b', root, readCall('r2', file))
    guardToolCall(guard, 'b', root, writeCall('w1', file))
    guardToolResult(guard, 'b', writeOk('w1', file))
    assert.equal(writeBlocked(guard, 'a', writeCall('w2', file)), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a call that never reports back releases its lock when the turn ends', () => {
  const { root, file } = realFile()
  try {
    const guard = new WriteGuard()
    guardToolCall(guard, 'a', root, readCall('r1', file))
    guardToolCall(guard, 'b', root, readCall('r2', file))
    guardToolCall(guard, 'b', root, writeCall('w1', file))
    assert.equal(guard.sizesForTest().inflight, 1)
    guardTurnEnd(guard, 'b')
    assert.equal(guard.sizesForTest().inflight, 0)
    // B's write never landed, so A's view is still the bytes on disk.
    assert.equal(writeBlocked(guard, 'a', writeCall('w2', file)), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('does not refuse a file the writing session never read', () => {
  const guard = new WriteGuard()
  guardToolCall(guard, 'b', CWD, writeCall('w1', 'src/app.ts'))
  guardToolResult(guard, 'b', writeOk('w1', 'src/app.ts'))

  assert.equal(writeBlocked(guard, 'a', writeCall('w2', 'src/app.ts')), false)
})

test('does not refuse a session its own follow-up write', () => {
  const guard = new WriteGuard()
  guardToolCall(guard, 'a', CWD, readCall('r1', 'src/app.ts'))
  guardToolCall(guard, 'a', CWD, writeCall('w1', 'src/app.ts'))
  guardToolResult(guard, 'a', writeOk('w1', 'src/app.ts'))

  assert.equal(writeBlocked(guard, 'a', writeCall('w2', 'src/app.ts')), false)
})

test('a failed write neither advances the version nor leaves a pending call behind', () => {
  const guard = new WriteGuard()
  guardToolCall(guard, 'b', CWD, readCall('r1', 'src/app.ts'))
  const start = guardToolCall(guard, 'b', CWD, writeCall('w1', 'src/app.ts'))
  assert.equal(start, undefined)
  guardToolResult(guard, 'b', writeFailed('w1', 'src/app.ts'))
  assert.equal(guard.sizesForTest().pending, 0)

  // `a` read before `b`'s failed write, so its view is still current.
  guardToolCall(guard, 'a', CWD, readCall('r2', 'src/app.ts'))
  assert.equal(writeBlocked(guard, 'a', writeCall('w2', 'src/app.ts')), false)
})

test('reads a hashline edit through the engine-derived path', () => {
  const guard = new WriteGuard()
  guardToolCall(guard, 'a', CWD, readCall('r1', 'src/app.ts'))
  const edit = (toolCallId: string): ToolCallEvent => ({
    type: 'tool_call',
    toolName: 'edit',
    toolCallId,
    // The engine derives these from the patch's `[PATH#TAG]` headers before extensions see it.
    input: { input: '[src/app.ts#1A2B]\nPUT 1.=1:\n+x', path: 'src/app.ts', paths: ['src/app.ts'] },
  })
  assert.equal(guardToolCall(guard, 'a', CWD, edit('e1')), undefined)
  guardToolResult(guard, 'a', patchOk('e1', 'src/app.ts'))

  guardToolCall(guard, 'b', CWD, writeCall('w1', 'src/app.ts'))
  guardToolResult(guard, 'b', writeOk('w1', 'src/app.ts'))
  assert.equal(guardToolCall(guard, 'a', CWD, edit('e2'))?.block, true)
})

test('reads an apply_patch edit through its file headers', () => {
  const guard = new WriteGuard()
  guardToolCall(guard, 'a', CWD, readCall('r1', 'src/app.ts'))
  const patch = (toolCallId: string): ToolCallEvent => ({
    type: 'tool_call',
    toolName: 'apply_patch',
    toolCallId,
    input: { input: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n*** End Patch' },
  })
  assert.equal(guardToolCall(guard, 'a', CWD, patch('p1')), undefined)
  guardToolResult(guard, 'a', patchOk('p1', 'src/app.ts', 'apply_patch'))

  guardToolCall(guard, 'b', CWD, writeCall('w1', 'src/app.ts'))
  guardToolResult(guard, 'b', writeOk('w1', 'src/app.ts'))
  assert.equal(guardToolCall(guard, 'a', CWD, patch('p2'))?.block, true)
})

test('ignores internal resources and keeps Windows drive letters as files', () => {
  const guard = new WriteGuard()
  guardToolCall(guard, 'a', CWD, readCall('r1', 'xd://lsp'))
  guardToolCall(guard, 'b', CWD, writeCall('w1', 'xd://lsp'))
  guardToolResult(guard, 'b', writeOk('w1', 'xd://lsp'))
  assert.equal(guard.sizesForTest().versions, 0)

  const drive = 'C:\\repo\\src\\app.ts'
  guardToolCall(guard, 'a', CWD, readCall('r2', drive))
  guardToolCall(guard, 'b', CWD, writeCall('w2', drive))
  guardToolResult(guard, 'b', writeOk('w2', drive))
  assert.equal(writeBlocked(guard, 'a', writeCall('w3', drive)), true)
})

test('forgetting a conversation drops its view but keeps the versions it wrote', () => {
  const guard = new WriteGuard()
  guardToolCall(guard, 'a', CWD, readCall('r1', 'src/app.ts'))
  guardToolCall(guard, 'b', CWD, writeCall('w1', 'src/app.ts'))
  guardToolResult(guard, 'b', writeOk('w1', 'src/app.ts'))

  guard.forget('b')
  assert.equal(guard.sizesForTest().sessions, 1)
  assert.equal(writeBlocked(guard, 'a', writeCall('w2', 'src/app.ts')), true)
})

test('bounds both tables', () => {
  const guard = new WriteGuard()
  for (let index = 0; index < 5_000; index += 1) {
    guardToolCall(guard, 'a', CWD, readCall(`r${index}`, `src/f${index}.ts`))
  }
  for (let index = 0; index < 5_000; index += 1) {
    guardToolCall(guard, 'a', CWD, writeCall(`w${index}`, `src/f${index}.ts`))
    guardToolResult(guard, 'a', writeOk(`w${index}`, `src/f${index}.ts`))
  }
  const sizes = guard.sizesForTest()
  assert.equal(sizes.versions, 4_096)
  assert.equal(sizes.sessions, 1)
  assert.equal(sizes.pending, 0)
})

test('the extension registers both handlers for the session it was built for', () => {
  const handlers: {
    toolCall?: (event: ToolCallEvent) => ToolCallEventResult | undefined
    toolResult?: (event: ToolResultEvent) => void
  } = {}
  const pi = {
    on: (event: string, handler: unknown) => {
      if (event === 'tool_call') handlers.toolCall = handler as typeof handlers.toolCall
      if (event === 'tool_result') handlers.toolResult = handler as typeof handlers.toolResult
    },
  } as unknown as ExtensionAPI

  writeGuardExtension('a', CWD, new WriteGuard())(pi)
  assert.ok(handlers.toolCall)
  assert.ok(handlers.toolResult)
})

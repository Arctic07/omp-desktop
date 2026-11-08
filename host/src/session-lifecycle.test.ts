import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import {
  disposeSessionsAtShutdown,
  removeSessionFiles,
  transcriptHoldsMessage,
} from './session-lifecycle.ts'
import { closeConversation, type FileSession, type SessionFilesPort } from './session-files.ts'
import { HEADER, MESSAGE, TITLE_SLOT, transcriptFixture } from './transcript-fixture.ts'

/**
 * Whether a transcript on disk holds a message, which is the question a removal asks before it takes
 * a file away — and whether the two paths that ask it (a close, the process shutdown) act on it.
 *
 * Only the bytes can answer: a rewound conversation reports no messages in the branch the engine
 * holds and still carries them in the file (`state/session-rows.ts::dropsFileOnRelease`). The file
 * and its lines come from `transcript-fixture.ts`, the shape every host spec writes.
 */

test('a transcript holding one message is kept', () => {
  const { file, root } = transcriptFixture('message', [TITLE_SLOT, HEADER, MESSAGE])
  assert.equal(transcriptHoldsMessage(file), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a transcript nothing was written to holds no message', () => {
  // The file a workspace's draft leaves behind: the slot and the header, and nothing else.
  const { file, root } = transcriptFixture('stub', [TITLE_SLOT, HEADER])
  assert.equal(transcriptHoldsMessage(file), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('an empty file holds no message', () => {
  const { file, root } = transcriptFixture('empty', [])
  assert.equal(transcriptHoldsMessage(file), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a message longer than one read chunk is still found', () => {
  // The reader carries a partial line across chunks; a line bigger than a whole chunk is what that
  // carry exists for, and a line the reader dropped would read as "nothing was written here".
  const long = 'x'.repeat(2 << 20)
  const { file, root } = transcriptFixture('long-message', [
    TITLE_SLOT,
    JSON.stringify({ type: 'message', id: 'e1', message: { role: 'user', content: long } }),
  ])
  assert.equal(transcriptHoldsMessage(file), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a transcript this process cannot read is kept', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-transcript-missing-'))
  assert.equal(transcriptHoldsMessage(path.join(root, 'gone.jsonl')), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a transcript holding only a custom message is kept', () => {
  // The engine's other conversation entry: a `/skill:` prompt is stored as `custom_message` and drawn
  // as a row by every reader, so it is not a draft (`history.ts::isConversationEntry`).
  const custom = JSON.stringify({
    type: 'custom_message',
    id: 'e1',
    customType: 'skill-prompt',
    display: true,
    content: '# Deploy',
  })
  const { file, root } = transcriptFixture('custom-message', [TITLE_SLOT, HEADER, custom])
  assert.equal(transcriptHoldsMessage(file), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('removing a transcript never takes the store it sits in', () => {
  // A path whose name is only the suffix derives the session directory itself as its artifact
  // directory; the removal trusts nothing it derived and leaves the store alone.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-transcript-store-'))
  const store = path.join(root, 'sessions')
  fs.mkdirSync(store)
  const neighbour = path.join(store, 'other.jsonl')
  fs.writeFileSync(neighbour, `${MESSAGE}\n`)
  const suffixOnly = path.join(store, '.jsonl')
  fs.writeFileSync(suffixOnly, `${MESSAGE}\n`)
  removeSessionFiles(suffixOnly, 'session-suffix', 'test')
  assert.equal(fs.existsSync(suffixOnly), false, 'the transcript itself goes')
  assert.equal(fs.existsSync(neighbour), true, 'the store keeps its other conversations')
  fs.rmSync(root, { recursive: true, force: true })
})

test('removing a transcript takes its own artifact directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-transcript-artifacts-'))
  const file = path.join(root, 'session.jsonl')
  const artifacts = path.join(root, 'session')
  fs.writeFileSync(file, `${MESSAGE}\n`)
  fs.mkdirSync(artifacts)
  fs.writeFileSync(path.join(artifacts, 'child.jsonl'), `${MESSAGE}\n`)
  assert.equal(removeSessionFiles(file, 'session-1', 'test'), true)
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(artifacts), false, 'the artifacts directory goes with it')
  fs.rmSync(root, { recursive: true, force: true })
})

test('an artifacts link is removed without touching what it points at', () => {
  // The removal trusts the path the engine laid out, and a link planted at that name is what a delete
  // must not follow: `rm` unlinks the link, so the tree it named is untouched (2026-11-03, security
  // review).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-transcript-link-'))
  const file = path.join(root, 'session.jsonl')
  fs.writeFileSync(file, `${MESSAGE}\n`)
  const elsewhere = path.join(root, 'elsewhere')
  fs.mkdirSync(elsewhere)
  fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'precious')
  fs.symlinkSync(elsewhere, path.join(root, 'session'), 'junction')
  assert.equal(removeSessionFiles(file, 'session-1', 'test'), true)
  assert.equal(fs.existsSync(path.join(root, 'session')), false, 'the link itself goes')
  assert.equal(fs.readFileSync(path.join(elsewhere, 'keep.txt'), 'utf8'), 'precious', 'its target does not')
  fs.rmSync(root, { recursive: true, force: true })
})

test('a dangling artifacts link is cleaned up, not left behind', () => {
  // The link outlives its target, so the entry has to be found by `lstat`: `exists` answers "nothing
  // there" for it, which used to leave the link in the store forever.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-transcript-dangling-'))
  const file = path.join(root, 'session.jsonl')
  const link = path.join(root, 'session')
  const target = path.join(root, 'gone')
  fs.writeFileSync(file, `${MESSAGE}\n`)
  fs.mkdirSync(target)
  fs.symlinkSync(target, link, 'junction')
  fs.rmSync(target, { recursive: true, force: true })
  assert.equal(fs.existsSync(link), false, 'the junction is dangling')
  assert.equal(removeSessionFiles(file, 'session-1', 'test'), true)
  assert.throws(() => fs.lstatSync(link), 'and the entry is gone')
  fs.rmSync(root, { recursive: true, force: true })
})

/** The routing id every case below closes under. */
const SESSION = 'session-1'

/** A live record whose teardown touches nothing: the file removal is what these cases read. */
function live(sessionFile: string, sessionId = SESSION): FileSession {
  const nothing = (): void => undefined
  return {
    sessionId,
    sessionFile,
    cwd: 'D:/project',
    agent: { dispose: async () => undefined, queuedMessageCount: 0, messages: [] } as never,
    manager: { seal: nothing, close: async () => undefined, releaseRetainedEntries: nothing } as never,
    goal: {} as never,
    subagents: { dispose: nothing } as never,
    ui: { cancelAll: nothing } as never,
    events: { dispose: nothing } as never,
    releaseNameWatch: nothing,
    releaseCommandWatch: nothing,
  }
}

/** A registry holding one record, in the workspace the teardown asks about. */
function port(taken: FileSession): SessionFilesPort {
  let held: FileSession | undefined = taken
  return {
    peek: () => held,
    take: () => {
      const found = held
      held = undefined
      return found
    },
    isWorking: () => false,
    usesWorkspace: () => true,
    paths: {} as never,
    sdk: {} as never,
  }
}

test('a close asked to drop the file keeps a transcript that holds messages', async () => {
  // The shape a rewind leaves: the desktop's record answers "draft, drop the file", and the file is
  // the reader's history. A close takes the reading itself rather than trusting the flag.
  const { file, root } = transcriptFixture('close-written', [
    TITLE_SLOT,
    HEADER,
    JSON.stringify({ type: 'message', id: 'e1', message: { role: 'user', content: 'hi' } }),
  ])
  const outcome = await closeConversation(port(live(file)), SESSION, true)
  assert.deepEqual(outcome, { closed: true })
  assert.equal(fs.existsSync(file), true, 'the transcript survives')
  fs.rmSync(root, { recursive: true, force: true })
})

test('a close asked to drop the file takes a transcript that holds nothing', async () => {
  const { file, root } = transcriptFixture('close-draft', [TITLE_SLOT, HEADER])
  const outcome = await closeConversation(port(live(file)), SESSION, true)
  assert.deepEqual(outcome, { closed: true })
  assert.equal(fs.existsSync(file), false, 'the draft is handed back')
  fs.rmSync(root, { recursive: true, force: true })
})

test('a shutdown drops the drafts and keeps a transcript that holds messages', async () => {
  // The same reading at the same point as a close: after the teardown drained the engine's tail, so a
  // conversation the reader rewound is not mistaken for a draft the process may sweep away.
  const written = transcriptFixture('shutdown-written', [TITLE_SLOT, HEADER, MESSAGE])
  const draft = transcriptFixture('shutdown-draft', [TITLE_SLOT, HEADER])
  const removed = await disposeSessionsAtShutdown(
    [live(written.file, 'session-written'), live(draft.file, 'session-draft')],
    'app_exit',
  )
  assert.equal(removed, 1, 'one file removed: the draft')
  assert.equal(fs.existsSync(written.file), true, 'the transcript that holds a message survives')
  assert.equal(fs.existsSync(draft.file), false, 'the draft is swept away')
  fs.rmSync(written.root, { recursive: true, force: true })
  fs.rmSync(draft.root, { recursive: true, force: true })
})

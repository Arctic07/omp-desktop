import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import type { HostPaths } from './env.ts'
import { ERROR_CODES, HostError } from './protocol/errors.ts'
import { deleteConversation, type SessionFilesPort } from './session-files.ts'
import { sessionIdFor } from './store.ts'
import { HEADER, MESSAGE, TITLE_SLOT } from './transcript-fixture.ts'

/**
 * The two addresses one `session_delete` takes: the transcript this desktop's own frames name, and
 * the routing id a plugin's `session.delete` names (`session.read` publishes ids, never paths).
 *
 * What is pinned here is the reach of the id form, which is the part a plugin depends on: it resolves
 * through the conversation index, so an id that index does not list - an agent transcript, an id
 * nobody ever had - is refused with the code a plugin author branches on (`session_not_found`), and
 * no path outside the session directory is reachable at all. The registry is a port with no live
 * record here; the teardown a live one gets belongs to `session-lifecycle.ts` and is tested there.
 */

/** One conversation in the store root, with a subagent transcript beside it. */
function store(): { root: string; paths: HostPaths; conversation: string; child: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-session-files-'))
  const sessionDir = path.join(root, 'sessions')
  fs.mkdirSync(sessionDir)
  const conversation = path.join(
    sessionDir,
    '2026-10-28T01-00-00-000Z_01a20000-0000-7000-8000-000000000001.jsonl',
  )
  fs.writeFileSync(conversation, `${[TITLE_SLOT, HEADER, MESSAGE].join('\n')}\n`, 'utf8')
  // The engine's layout for one session's subagents: a directory named after the transcript, beside
  // it. Not a conversation (`session-history.ts`), so not deletable by id either.
  const artifacts = conversation.slice(0, -'.jsonl'.length)
  fs.mkdirSync(artifacts)
  const child = path.join(artifacts, 'FrontendScout.jsonl')
  fs.writeFileSync(child, `${MESSAGE}\n`, 'utf8')
  return { root, paths: { sessionDir } as unknown as HostPaths, conversation, child }
}

/** The registry as these commands see it, holding nothing. */
function port(paths: HostPaths): SessionFilesPort {
  return {
    peek: () => undefined,
    take: () => undefined,
    isWorking: () => false,
    usesWorkspace: () => true,
    paths,
    sdk: {} as never,
  }
}

test('a delete named by id removes the conversation the index lists, artifacts included', async () => {
  const { root, paths, conversation } = store()
  try {
    const answer = await deleteConversation(port(paths), { sessionId: sessionIdFor(conversation) })
    assert.deepEqual(answer, { deleted: true })
    assert.equal(fs.existsSync(conversation), false, 'the transcript is gone')
    assert.equal(fs.existsSync(conversation.slice(0, -'.jsonl'.length)), false, 'its artifacts are gone')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an id the conversation index does not list is session_not_found', async () => {
  const { root, paths, child, conversation } = store()
  try {
    // The child transcript is a file with an id of its own - and it is not a conversation, so a
    // caller addressing by id cannot reach one.
    for (const unknown of [sessionIdFor(child), 's0000000000000000']) {
      await assert.rejects(
        deleteConversation(port(paths), { sessionId: unknown }),
        (error: unknown) => error instanceof HostError && error.code === ERROR_CODES.session_not_found,
      )
    }
    assert.equal(fs.existsSync(child), true, 'nothing was removed')
    assert.equal(fs.existsSync(conversation), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a delete named by file takes the transcript, and a second one answers deleted:false', async () => {
  const { root, paths, conversation } = store()
  try {
    assert.deepEqual(await deleteConversation(port(paths), { sessionFile: conversation }), {
      deleted: true,
    })
    // The caller asked for it to not exist, and it does not: the same request again is not a failure.
    assert.deepEqual(await deleteConversation(port(paths), { sessionFile: conversation }), {
      deleted: false,
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a delete naming neither address, or a path outside the store, is refused', async () => {
  const { root, paths, conversation } = store()
  const outside = path.join(root, 'elsewhere.jsonl')
  fs.writeFileSync(outside, `${MESSAGE}\n`, 'utf8')
  try {
    await assert.rejects(
      deleteConversation(port(paths), {}),
      (error: unknown) => error instanceof HostError && error.code === ERROR_CODES.invalid_session_path,
    )
    await assert.rejects(
      deleteConversation(port(paths), { sessionFile: outside }),
      (error: unknown) => error instanceof HostError && error.code === ERROR_CODES.invalid_session_path,
    )
    assert.equal(fs.existsSync(outside), true)
    assert.equal(fs.existsSync(conversation), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

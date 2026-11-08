import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { sessionIdFor } from './store.ts'
import type { HostPaths } from './env.ts'
import type {
  InternalResourceLike,
  InternalUrlHandlerLike,
  InternalUrlLike,
  SdkBundle,
} from './sdk.ts'
import {
  conversationFileById,
  conversationFiles,
  conversationRows,
  DesktopHistoryHandler,
  INDEX_LIMIT,
  sessionsById,
} from './session-history.ts'

/**
 * Cross-conversation `history://` reads.
 *
 * The engine resolves `history://<id>` against its agent registry and agent artifact trees, so a
 * top-level desktop conversation - identified by a digest of its session-file path - is invisible
 * there. These tests pin the host half: which files count as conversations, how an id maps back to
 * one, and that non-desktop ids still reach the engine's handler unchanged.
 */

function fixture(): { root: string; paths: HostPaths } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-session-history-'))
  const sessionDir = path.join(root, 'sessions')
  fs.mkdirSync(sessionDir)
  const header = (cwd: string, title: string) =>
    `${JSON.stringify({ type: 'session', version: 3, id: 'x', cwd, title })}\n`
  const message = (text: string) =>
    `${JSON.stringify({ type: 'message', message: { role: 'user', content: text } })}\n`
  // Flat store conversation.
  const flat = path.join(sessionDir, '2026-10-22T02-16-27-586Z_01a16165-3ec2-7000-b8e0-fe9ad00ec473.jsonl')
  fs.writeFileSync(flat, header('D:/project/omp-desktop', 'Flat conversation') + message('flat'), 'utf8')
  // Old per-cwd bucket conversation.
  const bucket = path.join(sessionDir, '--D--project--')
  fs.mkdirSync(bucket)
  const nested = path.join(bucket, '2026-09-01T00-00-00-000Z_01a0c958-441b-7000-9a54-cfec31c35626.jsonl')
  fs.writeFileSync(nested, header('D:/project/other', 'Bucket conversation') + message('bucket'), 'utf8')
  // A subagent transcript lives in the flat session's artifact directory, not the conversation list.
  const artifacts = path.join(sessionDir, '2026-10-22T02-16-27-586Z_01a16165-3ec2-7000-b8e0-fe9ad00ec473')
  fs.mkdirSync(artifacts)
  fs.writeFileSync(path.join(artifacts, 'FrontendScout.jsonl'), message('child'), 'utf8')
  return { root, paths: { sessionDir } as unknown as HostPaths }
}

function url(host: string): InternalUrlLike {
  return { rawHost: host, hostname: host, href: `history://${host}`, pathname: '' }
}

function fakeSdk(): SdkBundle {
  return {
    async loadSessionMessagesReadOnly() {
      return [{ role: 'user', content: 'hello' }]
    },
    formatSessionHistoryMarkdown(messages: unknown[], options?: { title?: string }) {
      return `# ${options?.title ?? 'history'}\n${messages.length} messages\n`
    },
  } as unknown as SdkBundle
}

test('conversation discovery keeps the store root and one bucket level, not artifacts', () => {
  const { root, paths } = fixture()
  try {
    const files = conversationFiles(paths).map(file => path.basename(file)).sort()
    assert.deepEqual(files, [
      '2026-09-01T00-00-00-000Z_01a0c958-441b-7000-9a54-cfec31c35626.jsonl',
      '2026-10-22T02-16-27-586Z_01a16165-3ec2-7000-b8e0-fe9ad00ec473.jsonl',
    ])
    const titles = conversationRows(paths).map(row => row.title).sort()
    assert.deepEqual(titles, ['Bucket conversation', 'Flat conversation'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a desktop id maps back to its file, child transcripts included', () => {
  const { root, paths } = fixture()
  try {
    const byId = sessionsById(paths)
    const flat = path.join(
      paths.sessionDir,
      '2026-10-22T02-16-27-586Z_01a16165-3ec2-7000-b8e0-fe9ad00ec473.jsonl',
    )
    assert.equal(byId.get(sessionIdFor(flat)), flat)
    assert.ok([...byId.values()].some(file => path.basename(file) === 'FrontendScout.jsonl'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the index-bounded id lookup resolves a conversation and not its child transcript', () => {
  const { root, paths } = fixture()
  try {
    // Both layouts of a stored conversation are reachable by id: the store root, and the engine's
    // per-cwd bucket one level down.
    for (const row of conversationRows(paths)) {
      assert.equal(conversationFileById(paths, row.id), row.file)
    }
    // A subagent transcript is a file with an id of its own, and it is not a conversation: a caller
    // that addresses by id must not reach one (`sessionsById` does, which is what history:// needs
    // and what a delete must not have).
    const child = path.join(
      paths.sessionDir,
      '2026-10-22T02-16-27-586Z_01a16165-3ec2-7000-b8e0-fe9ad00ec473',
      'FrontendScout.jsonl',
    )
    const childId = sessionIdFor(child)
    assert.equal(sessionsById(paths).get(childId), child)
    assert.equal(conversationFileById(paths, childId), undefined)
    assert.equal(conversationFileById(paths, 's0000000000000000'), undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the conversation index stops at its limit and says how many were left out', async () => {
  const { root, paths } = fixture()
  // One file per conversation: the id is a digest of the path, so two files cannot share one.
  for (let index = 0; index < INDEX_LIMIT + 5; index += 1) {
    const stamp = new Date(Date.UTC(2026, 0, 1) + index * 60_000)
      .toISOString()
      .replaceAll(':', '-')
      .replaceAll('.', '-')
    const file = path.join(
      paths.sessionDir,
      `${stamp}_${String(index).padStart(8, '0')}-0000-7000-8000-000000000000.jsonl`,
    )
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: 'session', version: 3, id: 'x', cwd: 'D:/x', title: `Conversation ${index}` })}\n`,
      'utf8',
    )
  }
  const total = conversationRows(paths).length
  const delegate: InternalUrlHandlerLike = {
    scheme: 'history',
    spec: { backing: 'virtual' },
    async resolve(resource) {
      return { url: resource.href, content: '# Agents\n', contentType: 'text/markdown' }
    },
  }
  try {
    const resource = await new DesktopHistoryHandler(delegate, paths, fakeSdk()).resolve({
      rawHost: '',
      hostname: '',
      href: 'history://',
      pathname: '',
    })
    // A read lands in a model's context, so the listing is bounded and the count is stated.
    const rows = resource.content.split('\n').filter((line) => /^\| s[0-9a-f]{16} \|/.test(line))
    assert.equal(rows.length, INDEX_LIMIT)
    assert.ok(total > INDEX_LIMIT, 'the fixture exceeded the bound')
    assert.match(
      resource.content,
      new RegExp(`Listing the ${INDEX_LIMIT} most recent of ${total} conversations`),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})


test('a desktop id resolves to a read-only transcript; other ids reach the engine', async () => {
  const { root, paths } = fixture()
  const calls: string[] = []
  const delegate: InternalUrlHandlerLike = {
    scheme: 'history',
    spec: { backing: 'virtual' },
    async resolve(resource) {
      calls.push(resource.href)
      return { url: resource.href, content: '# DeepWorker\n', contentType: 'text/markdown' }
    },
    async complete() {
      return [{ value: 'DeepWorker', description: 'idle · sub' }]
    },
  }
  try {
    const handler = new DesktopHistoryHandler(delegate, paths, fakeSdk())
    const flat = path.join(
      paths.sessionDir,
      '2026-10-22T02-16-27-586Z_01a16165-3ec2-7000-b8e0-fe9ad00ec473.jsonl',
    )
    const id = sessionIdFor(flat)
    const resolved = await handler.resolve(url(id))
    assert.match(resolved.content, /Flat conversation/)
    assert.equal(resolved.sourcePath, flat)
    assert.equal(await handler.locate(url(id)), flat, 'link renderers locate the same file')
    assert.deepEqual(calls, [], 'a desktop id never reaches the engine handler')

    const agent = await handler.resolve(url('DeepWorker'))
    assert.equal(agent.content, '# DeepWorker\n')
    assert.deepEqual(calls, ['history://DeepWorker'])

    await assert.rejects(handler.resolve(url('s0000000000000000')), /Unknown desktop conversation/)
    assert.deepEqual(calls, ['history://DeepWorker'], 'an unknown desktop id is not delegated')

    const completions = await handler.complete()
    assert.equal(completions[0]?.value, 'DeepWorker', 'engine completions stay first')
    assert.ok(completions.some(candidate => candidate.value === id), 'the desktop id is offered too')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('bare history appends the conversation index to the engine listing', async () => {
  const { root, paths } = fixture()
  const delegate: InternalUrlHandlerLike = {
    scheme: 'history',
    spec: { backing: 'virtual' },
    async resolve(resource) {
      return { url: resource.href, content: '# Agents\n\nNo agents registered.\n', contentType: 'text/markdown' }
    },
  }
  try {
    const handler = new DesktopHistoryHandler(delegate, paths, fakeSdk())
    const resource: InternalResourceLike = await handler.resolve({
      rawHost: '',
      hostname: '',
      href: 'history://',
      pathname: '',
    })
    assert.match(resource.content, /# Agents/)
    assert.match(resource.content, /## Desktop conversations/)
    assert.match(resource.content, /Flat conversation/)
    assert.match(resource.content, /Bucket conversation/)
    assert.doesNotMatch(resource.content, /FrontendScout/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

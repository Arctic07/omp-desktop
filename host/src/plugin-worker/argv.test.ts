import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { parsePluginWorkerArgv, PLUGIN_WORKER_FLAG } from './argv.ts'

/**
 * The worker launch line: exactly the four flags, exactly once each, with a root that is a real
 * absolute directory. These tests read only the parser; nothing is spawned.
 */

/** A temporary directory that looks like a plugin root, removed by the caller. */
function temporaryRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omp-worker-argv-'))
}

const IDENTITY = ['--install', 'demo@market', '--id', 'demo', '--scope', 'user']

test('a complete launch line parses to the four options', () => {
  const root = temporaryRoot()
  try {
    const parsed = parsePluginWorkerArgv([PLUGIN_WORKER_FLAG, '--root', root, ...IDENTITY])
    assert.equal(parsed.kind, 'worker')
    assert.deepEqual(parsed.kind === 'worker' ? parsed.options : null, {
      root: path.normalize(root),
      installId: 'demo@market',
      pluginId: 'demo',
      scope: 'user',
    })
    // The `--flag=value` spelling resolves to the same options.
    const equals = parsePluginWorkerArgv([`${PLUGIN_WORKER_FLAG}`, `--root=${root}`, '--install=demo@market', '--id=demo', '--scope=project'])
    assert.equal(equals.kind, 'worker')
    assert.equal(equals.kind === 'worker' ? equals.options.scope : null, 'project')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an ordinary host invocation is not worker mode', () => {
  assert.deepEqual(parsePluginWorkerArgv(['--data-root', 'C:\\data']), { kind: 'not_worker' })
  assert.deepEqual(parsePluginWorkerArgv([]), { kind: 'not_worker' })
})

test('a missing, duplicated, unknown or valueless flag is refused', () => {
  const root = temporaryRoot()
  try {
    const cases: Array<[string, string[]]> = [
      ['missing --scope', [PLUGIN_WORKER_FLAG, '--root', root, '--install', 'demo', '--id', 'demo']],
      ['duplicate --root', [PLUGIN_WORKER_FLAG, '--root', root, '--root', root, ...IDENTITY]],
      ['unknown flag', [PLUGIN_WORKER_FLAG, '--root', root, ...IDENTITY, '--nope', 'x']],
      ['selector with a value', [`${PLUGIN_WORKER_FLAG}=1`, '--root', root, ...IDENTITY]],
      ['valueless --id', [PLUGIN_WORKER_FLAG, '--root', root, '--install', 'demo', '--id', '--scope', 'user']],
      ['empty value', [PLUGIN_WORKER_FLAG, '--root', root, '--install=', '--id', 'demo', '--scope', 'user']],
    ]
    for (const [name, argv] of cases) {
      const parsed = parsePluginWorkerArgv(argv)
      assert.equal(parsed.kind, 'invalid', name)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a relative, missing or non-directory root is refused', () => {
  const root = temporaryRoot()
  try {
    const file = path.join(root, 'file.txt')
    fs.writeFileSync(file, 'x', 'utf8')
    for (const bad of ['relative/plugin', path.join(root, 'missing'), file]) {
      const parsed = parsePluginWorkerArgv([PLUGIN_WORKER_FLAG, '--root', bad, ...IDENTITY])
      assert.equal(parsed.kind, 'invalid', bad)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a scope outside user/project and an id over the bound are refused', () => {
  const root = temporaryRoot()
  try {
    const badScope = parsePluginWorkerArgv([PLUGIN_WORKER_FLAG, '--root', root, '--install', 'demo', '--id', 'demo', '--scope', 'global'])
    assert.equal(badScope.kind, 'invalid')
    const longId = parsePluginWorkerArgv([PLUGIN_WORKER_FLAG, '--root', root, '--install', 'd'.repeat(257), '--id', 'demo', '--scope', 'user'])
    assert.equal(longId.kind, 'invalid')
    const control = parsePluginWorkerArgv([PLUGIN_WORKER_FLAG, '--root', root, '--install', 'demo\nbad', '--id', 'demo', '--scope', 'user'])
    assert.equal(control.kind, 'invalid')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { WorkerStartupError, loadEntry, resolveEntry } from './entry.ts'

/**
 * The worker's own reading of `omp.desktop.main`: the manifest is re-read here, so the path the
 * process would evaluate is checked again rather than trusted from the row.
 */

/** A temporary package with one `package.json`, removed by the caller. */
function packageWith(manifest: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-worker-entry-'))
  fs.mkdirSync(path.join(root, 'desktop'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8')
  return root
}

/** The code one startup refusal carries. */
function refusal(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    assert.equal(error instanceof WorkerStartupError, true)
    return error instanceof WorkerStartupError ? error.code : ''
  }
  return 'no refusal'
}

test('a declared main resolves, and the package-relative spelling is returned unchanged', () => {
  const root = packageWith({ omp: { desktop: { main: 'desktop/main.js' } } })
  try {
    assert.equal(resolveEntry(root), 'desktop/main.js')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a missing or unreadable manifest, and a manifest with no main, are `not_found`', () => {
  const root = packageWith({ omp: { desktop: {} } })
  try {
    assert.equal(refusal(() => resolveEntry(root)), 'not_found')
    assert.equal(refusal(() => resolveEntry(path.join(root, 'missing'))), 'not_found')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an entry outside the package-relative shape is `invalid_request`', () => {
  for (const main of ['../main.js', 'node_modules/pkg/main.js', 'Node_Modules/pkg/main.js', 'desktop/main.ts', '/abs/main.js', 'desktop\\main.js', 42]) {
    const root = packageWith({ omp: { desktop: { main } } })
    try {
      assert.equal(refusal(() => resolveEntry(root)), 'invalid_request', String(main))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('loading requires an onLoad export and evaluates the file as a module', async () => {
  const root = packageWith({ type: 'module', omp: { desktop: { main: 'desktop/main.js' } } })
  const bare = packageWith({ type: 'module', omp: { desktop: { main: 'desktop/main.js' } } })
  try {
    fs.writeFileSync(path.join(root, 'desktop', 'main.js'), 'export async function onLoad() {}\n', 'utf8')
    const loaded = await loadEntry(root)
    assert.equal(loaded.entry, 'desktop/main.js')
    assert.equal(typeof loaded.module.onLoad, 'function')

    // A second root rather than rewriting the first: a module URL is cached, and rewriting it would
    // test the import cache instead of the export check.
    fs.writeFileSync(path.join(bare, 'desktop', 'main.js'), 'export const nothing = 1\n', 'utf8')
    await assert.rejects(loadEntry(bare), (error: unknown) => error instanceof WorkerStartupError && error.code === 'invalid_request')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(bare, { recursive: true, force: true })
  }
})

/**
 * The renderer-slot fixtures the `plugins` smoke plants (plan §7.1, `plugins.desktop.renderer`).
 *
 * Two packages, because the two answers that matter are different: one declares `renderer.extension`
 * with a module, an action whitelist and two callable methods, and one declares the same module
 * without the permission - where the whole desktop block has to be refused rather than half
 * projected. The module file is written but never imported: this stage is the host's projection, and
 * the page-side loader has its own tests (plan §7.4).
 *
 * Split out of `plugins.fixtures.ts` when that file reached the line limit (`rules.md#single-file-line-limit`); the
 * package writer and registry writer are the same ones every other stage uses.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { dataRoot } from '../client.ts'
import { PLUGIN_VERSION, writeInstalledRecord } from './plugins.fixtures.ts'

/** A third-party package that declares a slot module and both dispatch lists. */
export const RENDERER_ID = 'smoke-renderer@smoke-market'
export const RENDERER_ROOT = path.join(dataRoot, 'smoke-renderer-plugin')

/** The same module with no `renderer.extension`: the block must be refused whole. */
export const RENDERER_UNPERMITTED_ID = 'smoke-renderer-bare@smoke-market'
export const RENDERER_UNPERMITTED_ROOT = path.join(dataRoot, 'smoke-renderer-bare')

/** The action tokens and methods the permitted fixture declares, shared with the stage's checks. */
export const RENDERER_ACTIONS = ['plugin.call', 'composer.insertText', 'composer.readDraft'] as const
export const RENDERER_CALL_METHODS = ['insertSnippet', 'listSnippets'] as const

/** One install record, the shape `writeInstalledRecord` takes. */
function installRecord(root: string): Record<string, unknown> {
  return {
    scope: 'user',
    installPath: root,
    version: PLUGIN_VERSION,
    installedAt: new Date(0).toISOString(),
    lastUpdated: new Date(0).toISOString(),
    enabled: true,
  }
}

/** Writes one package directory with the desktop block under test and a minimal module file. */
function writeRendererPackage(root: string, permissions: string[]): void {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'desktop'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({
      name: path.basename(root),
      version: PLUGIN_VERSION,
      type: 'module',
      omp: {
        desktop: {
          schemaVersion: 1,
          permissions,
          renderer: 'desktop/renderer.mjs',
          rendererActions: [...RENDERER_ACTIONS],
          rendererCallMethods: [...RENDERER_CALL_METHODS],
        },
      },
    }, null, 2)}\n`,
    'utf8',
  )
  // Written but never evaluated by the smoke: the Rust boundary resolves and serves it (plan §D2).
  fs.writeFileSync(path.join(root, 'desktop', 'renderer.mjs'), 'export function onLoad() {}\n', 'utf8')
}

/** Plants both renderer fixtures as registry records. */
export function plantRendererFixtures(): void {
  writeRendererPackage(RENDERER_ROOT, ['renderer.extension'])
  writeInstalledRecord(RENDERER_ID, installRecord(RENDERER_ROOT))

  writeRendererPackage(RENDERER_UNPERMITTED_ROOT, [])
  writeInstalledRecord(RENDERER_UNPERMITTED_ID, installRecord(RENDERER_UNPERMITTED_ROOT))
}

/** Removes both fixtures and their registry records. */
export function removeRendererFixtures(): void {
  fs.rmSync(RENDERER_ROOT, { recursive: true, force: true })
  fs.rmSync(RENDERER_UNPERMITTED_ROOT, { recursive: true, force: true })
  writeInstalledRecord(RENDERER_ID, null)
  writeInstalledRecord(RENDERER_UNPERMITTED_ID, null)
}

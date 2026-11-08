/**
 * The plugin-process fixtures the `plugins` smoke plants (plan §6.5, `plugins.desktop.process`).
 *
 * Two packages, because the two answers that matter are different: one declares `plugin.process` and
 * `command.register` with a `main`, commands and activation events, and one is shaped like a built-in
 * (a `main`, no permissions at all). The host validates shapes only - Rust owns runnability and the
 * built-in exemption - so *both* must project a process block. An unknown activation event rides on
 * the first package: the row must keep the two this build implements and drop the rest.
 *
 * Split out of `plugins.fixtures.ts` when that file reached the line limit (`rules.md#single-file-line-limit`); the
 * package writer and registry writer are the same ones every other stage uses.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { dataRoot } from '../client.ts'
import { PLUGIN_VERSION, writeInstalledRecord } from './plugins.fixtures.ts'

/** A third-party package that declares a resident process and one command. */
export const PROCESS_ID = 'smoke-process@smoke-market'
export const PROCESS_ROOT = path.join(dataRoot, 'smoke-process-plugin')

/** The built-in shape: a `main` and a command, and no `plugin.process` to declare. */
export const PROCESS_UNPRIVILEGED_ID = 'smoke-process-builtin@smoke-market'
export const PROCESS_UNPRIVILEGED_ROOT = path.join(dataRoot, 'smoke-process-builtin')

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

/** Writes one package directory with the desktop block under test and a minimal entry file. */
function writeProcessPackage(root: string, desktop: Record<string, unknown>): void {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'desktop'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: path.basename(root), version: PLUGIN_VERSION, type: 'module', omp: { desktop } }, null, 2)}\n`,
    'utf8',
  )
  // Written but never evaluated by the smoke: this stage is the host's projection, and the worker has
  // its own end-to-end test.
  fs.writeFileSync(path.join(root, 'desktop', 'main.js'), 'export async function onLoad() {}\n', 'utf8')
}

/** Plants both process fixtures as registry records. */
export function plantProcessFixtures(): void {
  writeProcessPackage(PROCESS_ROOT, {
    schemaVersion: 1,
    permissions: ['plugin.process', 'command.register'],
    main: 'desktop/main.js',
    // The third event is one this build does not implement: it must be dropped from the projection,
    // not refuse the block (spec §3.2).
    activationEvents: ['onStartup', 'onCommand:smoke.hello', 'onLanguage:typescript'],
    contributes: {
      commands: [
        { id: 'smoke.hello', title: { en: 'Smoke Hello', zh: '冒烟问候' }, keywords: ['smoke', 'hello'] },
      ],
    },
  })
  writeInstalledRecord(PROCESS_ID, installRecord(PROCESS_ROOT))

  writeProcessPackage(PROCESS_UNPRIVILEGED_ROOT, {
    schemaVersion: 1,
    main: 'desktop/main.js',
    activationEvents: ['onStartup'],
    // A built-in plugin needs no permission name to carry a process (plan §6.1); the host must not
    // refuse a `main` for the missing name, because runnability is the Rust supervisor's answer.
    contributes: { commands: [{ id: 'smoke.builtin' }] },
  })
  writeInstalledRecord(PROCESS_UNPRIVILEGED_ID, installRecord(PROCESS_UNPRIVILEGED_ROOT))
}

/** Removes both fixtures and their registry records. */
export function removeProcessFixtures(): void {
  fs.rmSync(PROCESS_ROOT, { recursive: true, force: true })
  fs.rmSync(PROCESS_UNPRIVILEGED_ROOT, { recursive: true, force: true })
  writeInstalledRecord(PROCESS_ID, null)
  writeInstalledRecord(PROCESS_UNPRIVILEGED_ID, null)
}
